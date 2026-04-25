import Fastify from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { loadConfig } from "./config";
import { proxyResponsesWithRetry } from "./proxy-retry-service";
import { collectAccountStatuses } from "./status";
import { pickBestAccount } from "./scheduler";
import { bi } from "./text";
import { refreshAccountUsage } from "./usage-sync";

interface ProxyReply {
  raw: NodeJS.WritableStream & {
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

function getBearerToken(headerValue?: string): string | null {
  if (!headerValue) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match?.[1] ?? null;
}

/**
 * 读取代理请求的原始 body 字节，供多账号重试时重复发送同一份载荷。
 *
 * @param stream 客户端发到代理路由的原始可读流。
 * @returns 完整请求体的 Buffer；空请求体时返回空 Buffer。
 * @throws 当读取流失败时抛出底层 I/O 错误。
 */
async function readRawRequestBody(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    // 统一转成 Buffer，避免不同 chunk 类型在后续重发时出现编码歧义。
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
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

  app.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health") {
      return;
    }

    const bearer = getBearerToken(request.headers.authorization);
    if (bearer !== config.server.api_key) {
      return reply.code(401).send({
        error: {
          message: bi("本地 API Key 无效", "Invalid local API key"),
          type: "invalid_local_api_key"
        }
      });
    }
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

  const proxyHandler = async (
    requestBodyStream: NodeJS.ReadableStream,
    requestHeaders: IncomingHttpHeaders,
    reply: ProxyReply
  ) => {
    const requestBody = await readRawRequestBody(requestBodyStream);
    const result = await proxyResponsesWithRetry(requestHeaders, requestBody);

    if (result.type === "send") {
      reply.code(result.statusCode);
      for (const [headerName, headerValue] of Object.entries(result.headers ?? {})) {
        reply.header(headerName, headerValue);
      }
      reply.send(result.payload);
      return;
    }

    reply.hijack();
    reply.raw.writeHead(result.statusCode, result.headers);

    for await (const chunk of result.body) {
      reply.raw.write(chunk);
    }

    reply.raw.end();
  };

  await app.register(async (proxyApp) => {
    // 代理路由需要原样透传 body，不能在本地先做 JSON 解析与大小限制拦截。
    proxyApp.removeAllContentTypeParsers();
    proxyApp.addContentTypeParser("*", (request, payload, done) => {
      done(null, payload);
    });

    proxyApp.post("/v1/responses", { bodyLimit: Number.MAX_SAFE_INTEGER }, async (request, reply) => {
      await proxyHandler(request.body as NodeJS.ReadableStream, request.headers, reply);
    });

    proxyApp.post("/backend-api/codex/responses", { bodyLimit: Number.MAX_SAFE_INTEGER }, async (request, reply) => {
      await proxyHandler(request.body as NodeJS.ReadableStream, request.headers, reply);
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
