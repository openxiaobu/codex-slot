import Fastify from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { loadConfig } from "./config";
import { proxyChatGptBackendWithRetry } from "./backend-proxy-service";
import { proxyModelWithRoute } from "./model-proxy-dispatcher";
import { collectAccountStatuses } from "./status";
import { pickBestAccount } from "./scheduler";
import { refreshAccountUsage } from "./usage-sync";

interface ProxyReply {
  raw: NodeJS.WritableStream & {
    destroyed?: boolean;
    destroy?: (error?: Error) => void;
    write: (chunk: unknown) => boolean;
    writeHead: (statusCode: number, headers?: Record<string, string | string[] | number>) => void;
    end: (chunk?: unknown) => void;
  };
  code: (statusCode: number) => {
    send: (payload: unknown) => void;
    header: (key: string, value: string) => unknown;
  };
  send: (payload: unknown) => void;
  header: (key: string, value: string) => unknown;
  hijack: () => void;
}

/**
 * 读取代理请求的原始 body 字节，供多账号重试时重复发送同一份载荷。
 *
 * @param stream 客户端发到代理路由的原始可读流；无 body 时允许为空。
 * @returns 完整请求体的 Buffer；空请求体时返回空 Buffer。
 * @throws 当读取流失败时抛出底层 I/O 错误。
 */
async function readRawRequestBody(stream?: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  if (!stream) {
    return Buffer.alloc(0);
  }

  for await (const chunk of stream) {
    // 统一转成 Buffer，避免不同 chunk 类型在后续重发时出现编码歧义。
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

/**
 * 将上游响应体安全地透传给已 hijack 的本地响应。
 *
 * 业务含义：
 * 1. 一旦开始写出上游 header，就不能再把异常抛回 Fastify 默认错误处理器。
 * 2. 上游流中途断开或客户端提前关闭时，只终止当前连接，避免整个 cslot 进程崩溃。
 *
 * @param reply 当前请求对应的 Fastify reply。
 * @param result 已成功拿到响应头的上游代理结果。
 * @returns Promise，流复制结束或被安全终止后返回。
 * @throws 无显式抛出；异常会被当前方法内部吞掉并转成连接销毁。
 */
async function streamProxyResponse(
  reply: ProxyReply,
  result: {
    statusCode: number;
    headers: Record<string, string>;
    body: AsyncIterable<Buffer | Uint8Array | string>;
  }
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(result.statusCode, result.headers);

  try {
    for await (const chunk of result.body) {
      reply.raw.write(chunk);
    }

    reply.raw.end();
  } catch (error) {
    console.error("cslot proxy stream aborted", error);

    // 响应已开始输出，此时只能销毁当前连接，不能再交给 Fastify 二次写 header。
    if (!reply.raw.destroyed) {
      reply.raw.destroy?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * 启动一个极轻量本地服务，供后续接入代理或脚本化查询使用。
 *
 * 当前阶段服务用途：
 * 1. 暴露健康检查。
 * 2. 暴露账号状态与当前推荐账号。
 * 3. 为后续真正的 OpenAI-compatible proxy 预留入口。
 *
 * @param port 本地监听端口。
 * @returns Fastify 实例，便于调用方在测试或脚本中复用。
 * @throws 当端口占用或服务启动失败时抛出异常。
 */
export async function startServer(port: number): Promise<void> {
  const config = loadConfig();
  const app = Fastify({
    logger: false,
    bodyLimit: Math.floor(config.server.body_limit_mb * 1024 * 1024)
  });

  app.get("/health", async () => {
    return { ok: true };
  });

  app.post("/refresh", async () => {
    const results = await refreshAccountUsageForBestEffort();
    return { refreshed: results };
  });

  app.get("/accounts", async () => {
    return {
      accounts: collectAccountStatuses(),
      selected: pickBestAccount()
    };
  });

  const codexProxyHandler = async (
    request: {
      method: string;
      url: string;
      headers: IncomingHttpHeaders;
      body?: NodeJS.ReadableStream;
    },
    reply: ProxyReply
  ) => {
    const requestBody = await readRawRequestBody(request.body);
    const result = await proxyModelWithRoute({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: requestBody
    });

    if (result.type === "send") {
      reply.code(result.statusCode);
      for (const [headerName, headerValue] of Object.entries(result.headers ?? {})) {
        reply.header(headerName, headerValue);
      }
      reply.send(result.payload);
      return;
    }

    await streamProxyResponse(reply, result);
  };

  const backendProxyHandler = async (
    request: {
      method: string;
      url: string;
      headers: IncomingHttpHeaders;
      body?: NodeJS.ReadableStream;
    },
    reply: ProxyReply
  ) => {
    const requestBody = request.body ? await readRawRequestBody(request.body) : undefined;
    const result = await proxyChatGptBackendWithRetry({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: requestBody
    });

    if (result.type === "send") {
      reply.code(result.statusCode);
      for (const [headerName, headerValue] of Object.entries(result.headers ?? {})) {
        reply.header(headerName, headerValue);
      }
      reply.send(result.payload);
      return;
    }

    await streamProxyResponse(reply, result);
  };

  await app.register(async (proxyApp) => {
    // 代理路由需要原样透传 body，不能在本地先做 JSON 解析与大小限制拦截。
    proxyApp.removeAllContentTypeParsers();
    proxyApp.addContentTypeParser("*", (request, payload, done) => {
      done(null, payload);
    });

    proxyApp.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      url: "/v1/*",
      bodyLimit: Number.MAX_SAFE_INTEGER,
      handler: async (request, reply) => {
        const body = request.body as NodeJS.ReadableStream | undefined;

        await codexProxyHandler(
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body
          },
          reply
        );
      }
    });

    proxyApp.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      url: "/backend-api/codex/*",
      bodyLimit: Number.MAX_SAFE_INTEGER,
      handler: async (request, reply) => {
        const body = request.body as NodeJS.ReadableStream | undefined;

        await codexProxyHandler(
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body
          },
          reply
        );
      }
    });

    proxyApp.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      url: "/backend-api/*",
      bodyLimit: Number.MAX_SAFE_INTEGER,
      handler: async (request, reply) => {
        const body = request.body as NodeJS.ReadableStream | undefined;

        await backendProxyHandler(
          {
            method: request.method,
            url: request.url,
            headers: request.headers,
            body
          },
          reply
        );
      }
    });
  });

  await app.listen({
    host: config.server.host,
    port: Number.isFinite(port) ? port : config.server.port
  });
}

async function refreshAccountUsageForBestEffort() {
  const statuses = collectAccountStatuses();
  const refreshed = [];

  for (const status of statuses) {
    try {
      const item = await refreshAccountUsage(status.id);
      refreshed.push(item);
    } catch (error) {
      refreshed.push({
        accountId: status.id,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return refreshed;
}
