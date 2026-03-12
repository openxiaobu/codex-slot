import Fastify from "fastify";
import type { IncomingHttpHeaders } from "node:http";
import { request } from "undici";
import { readAuthFile } from "./account-store";
import { loadConfig } from "./config";
import { collectAccountStatuses } from "./status";
import { listCandidateAccounts, pickBestAccount } from "./scheduler";
import { setAccountBlock } from "./state";
import { refreshAccountTokens, refreshAccountUsage } from "./usage-sync";
import type { SchedulerPick } from "./types";

function getBearerToken(headerValue?: string): string | null {
  if (!headerValue) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(headerValue);
  return match?.[1] ?? null;
}

/**
 * 根据错误文本与当前账号状态，决定本地禁用时长。
 *
 * 业务规则：
 * 1. 周限制优先，直到周窗口重置时间。
 * 2. 5 小时额度限制次之，直到 5 小时窗口重置时间。
 * 3. 未能明确识别时，按 5 分钟临时熔断处理。
 *
 * @param picked 当前被选中的账号及状态。
 * @param errorText 上游返回的错误文本。
 * @returns 本地禁用窗口与原因。
 */
function resolveBlockWindow(
  picked: SchedulerPick,
  errorText: string
): { until: number | null; reason: string } {
  const lowerText = errorText.toLowerCase();

  if (
    lowerText.includes("weekly") ||
    lowerText.includes("7 day") ||
    lowerText.includes("7-day") ||
    picked.status.isWeeklyLimited
  ) {
    return {
      until: picked.status.weeklyResetsAt ?? Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      reason: "weekly_limited"
    };
  }

  if (
    lowerText.includes("5 hour") ||
    lowerText.includes("5-hour") ||
    lowerText.includes("5h") ||
    lowerText.includes("usage limit") ||
    picked.status.isFiveHourLimited
  ) {
    return {
      until: picked.status.fiveHourResetsAt ?? Math.floor(Date.now() / 1000) + 5 * 60,
      reason: "5h_limited"
    };
  }

  return {
    until: Math.floor(Date.now() / 1000) + 5 * 60,
    reason: "temporary_5m_limit"
  };
}

/**
 * 为当前请求失败的账号设置临时熔断状态，避免短时间内被重复选中。
 *
 * @param accountId 账号标识。
 * @param reason 本地状态中记录的失败原因。
 * @param blockSeconds 熔断持续秒数。
 * @returns 无返回值。
 */
function markAccountFailure(accountId: string, reason: string, blockSeconds: number): void {
  // 请求链路中的短期失败通常是瞬时异常，记录一个较短的本地熔断窗口即可。
  setAccountBlock(accountId, Math.floor(Date.now() / 1000) + blockSeconds, reason);
}

/**
 * 提取错误对象中最接近底层网络层的错误码，便于区分网络不可达与上游业务异常。
 *
 * @param error 捕获到的异常对象。
 * @returns 错误码；若无法识别则返回 `null`。
 */
function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const errnoError = error as NodeJS.ErrnoException & { cause?: unknown };
  if (typeof errnoError.code === "string" && errnoError.code.length > 0) {
    return errnoError.code;
  }

  return extractErrorCode(errnoError.cause);
}

/**
 * 判断一次请求失败是否属于本机到上游之间的网络不可达场景。
 *
 * @param error 捕获到的异常对象。
 * @returns `true` 表示网络层异常，不应写入账号熔断；否则返回 `false`。
 */
function isNetworkUnavailableError(error: unknown): boolean {
  const errorCode = extractErrorCode(error);

  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(errorCode ?? "");
}

/**
 * 将网络层异常转换为统一的响应体，避免误导成“当前没有可用账号”。
 *
 * @param accountId 当前尝试的账号标识。
 * @param error 捕获到的异常对象。
 * @returns 统一的网络异常响应体。
 */
function buildNetworkUnavailablePayload(accountId: string, error: unknown): {
  error: { message: string; type: string };
} {
  const message = error instanceof Error ? error.message : String(error);

  return {
    error: {
      message: `网络不可用，账号 ${accountId} 无法连接上游: ${message}`,
      type: "network_unavailable"
    }
  };
}

/**
 * 构造发往上游的请求头，并移除仅属于本地代理链路的头信息。
 *
 * @param requestHeaders 客户端发到本地服务的原始请求头。
 * @param accessToken 当前候选账号可用的上游访问令牌。
 * @param accountIdHeader 可选的 ChatGPT 账号标识头。
 * @returns 可直接传给上游请求的请求头对象。
 */
function buildUpstreamHeaders(
  requestHeaders: IncomingHttpHeaders,
  accessToken: string,
  bodyLength: number,
  accountIdHeader?: string
): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(requestHeaders)) {
    const normalizedName = headerName.toLowerCase();

    if (
      headerValue == null ||
      normalizedName === "authorization" ||
      normalizedName === "host" ||
      normalizedName === "connection" ||
      normalizedName === "content-length"
    ) {
      continue;
    }

    headers[normalizedName] = Array.isArray(headerValue)
      ? headerValue.join(", ")
      : headerValue;
  }

  // 本地服务使用独立 api_key 鉴权，转发时必须替换为真实上游 access token。
  headers.authorization = `Bearer ${accessToken}`;

  // 未显式传入 Accept 时，补上兼容 SSE 与 JSON 的默认值。
  if (!headers.accept) {
    headers.accept = "text/event-stream, application/json";
  }

  // body 会在本地先读取成 Buffer 以支持失败后切换账号重试，因此这里重算长度。
  headers["content-length"] = String(bodyLength);
  headers["user-agent"] = "codex-slot/0.1.1";

  if (accountIdHeader) {
    headers["chatgpt-account-id"] = accountIdHeader;
  }

  return headers;
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
      reply.code(401);
      throw new Error("invalid local api key");
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
    reply: { raw: NodeJS.WritableStream & { writeHead: (statusCode: number, headers?: Record<string, string | string[] | number>) => void; end: (chunk?: unknown) => void; }; code: (statusCode: number) => void; send: (payload: unknown) => void; }
  ) => {
    const requestBody = await readRawRequestBody(requestBodyStream);
    const candidates = listCandidateAccounts();

    if (candidates.length === 0) {
      reply.code(503);
      reply.send({
        error: {
          message: "当前没有可用账号",
          type: "no_available_account"
        }
      });
      return;
    }

    let lastErrorPayload: unknown = {
      error: {
        message: "所有账号都请求失败",
        type: "all_accounts_failed"
      }
    };
    let lastStatusCode = 503;

    for (const picked of candidates) {
      const auth = readAuthFile(picked.account.codex_home);
      let accessToken = auth?.tokens?.access_token;
      const accountIdHeader = auth?.tokens?.account_id;

      if (!accessToken) {
        // 当前账号认证信息不完整时，先做短时熔断，再切到下一个账号。
        markAccountFailure(picked.account.id, "invalid_account_auth", 10 * 60);
        lastErrorPayload = {
          error: {
            message: `账号 ${picked.account.id} 缺少 access_token`,
            type: "invalid_account_auth"
          }
        };
        lastStatusCode = 503;
        continue;
      }

      const sendUpstream = async (upstreamAccessToken: string) =>
        await request(`${config.upstream.codex_base_url}/responses`, {
          method: "POST",
          headers: buildUpstreamHeaders(
            requestHeaders,
            upstreamAccessToken,
            requestBody.length,
            accountIdHeader
          ),
          body: requestBody
        });

      let upstream;

      try {
        upstream = await sendUpstream(accessToken);
      } catch (error) {
        lastStatusCode = 503;
        if (isNetworkUnavailableError(error)) {
          lastErrorPayload = buildNetworkUnavailablePayload(picked.account.id, error);
          continue;
        }

        // 非网络层异常仍视为当前账号请求链路异常，短时熔断后继续尝试下一个账号。
        markAccountFailure(picked.account.id, "request_failed", 60);
        lastErrorPayload = {
          error: {
            message: `账号 ${picked.account.id} 请求上游失败: ${error instanceof Error ? error.message : String(error)}`,
            type: "account_request_failed"
          }
        };
        continue;
      }

      if (upstream.statusCode === 401) {
        try {
          const refreshed = await refreshAccountTokens(picked.account.id);
          accessToken = refreshed.tokens?.access_token ?? accessToken;
          upstream = await sendUpstream(accessToken);
        } catch (error) {
          lastStatusCode = 503;
          if (isNetworkUnavailableError(error)) {
            lastErrorPayload = buildNetworkUnavailablePayload(picked.account.id, error);
            continue;
          }

          // token 刷新失败说明该账号短期内不可用，先熔断再切换。
          markAccountFailure(picked.account.id, "token_refresh_failed", 10 * 60);
          lastErrorPayload = {
            error: {
              message: `账号 ${picked.account.id} 刷新 token 失败: ${error instanceof Error ? error.message : String(error)}`,
              type: "account_token_refresh_failed"
            }
          };
          continue;
        }
      }

      if (upstream.statusCode === 429 || upstream.statusCode === 403) {
        const errorText = await upstream.body.text();
        const block = resolveBlockWindow(picked, errorText);
        setAccountBlock(picked.account.id, block.until, block.reason);
        lastStatusCode = upstream.statusCode;
        lastErrorPayload = {
          error: {
            message: `账号 ${picked.account.id} 受限: ${errorText}`,
            type: "account_rate_limited"
          }
        };
        continue;
      }

      if (upstream.statusCode >= 400) {
        const errorText = await upstream.body.text();
        const lowerText = errorText.toLowerCase();

        if (lowerText.includes("usage limit") || lowerText.includes("try again later")) {
          const block = resolveBlockWindow(picked, errorText);
          setAccountBlock(picked.account.id, block.until, block.reason);
          lastStatusCode = upstream.statusCode;
          lastErrorPayload = {
            error: {
              message: `账号 ${picked.account.id} 命中额度限制: ${errorText}`,
              type: "account_usage_limited"
            }
          };
          continue;
        }

        if (upstream.statusCode >= 500) {
          // 上游 5xx 先视为当前账号链路失败，短时熔断并切到下一个账号。
          markAccountFailure(picked.account.id, "upstream_5xx", 60);
          lastStatusCode = upstream.statusCode;
          lastErrorPayload = {
            error: {
              message: `账号 ${picked.account.id} 上游异常: ${errorText}`,
              type: "account_upstream_failed"
            }
          };
          continue;
        }

        reply.raw.writeHead(upstream.statusCode, {
          "content-type": "application/json"
        });
        reply.raw.end(errorText);
        return;
      }

      const headers: Record<string, string> = {};
      const contentType = upstream.headers["content-type"];
      const cacheControl = upstream.headers["cache-control"];

      if (typeof contentType === "string") {
        headers["content-type"] = contentType;
      }

      if (typeof cacheControl === "string") {
        headers["cache-control"] = cacheControl;
      }

      headers.connection = "keep-alive";
      reply.raw.writeHead(upstream.statusCode, headers);

      for await (const chunk of upstream.body) {
        reply.raw.write(chunk);
      }

      reply.raw.end();
      return;
    }

    reply.code(lastStatusCode);
    reply.send(lastErrorPayload);
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
