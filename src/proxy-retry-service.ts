import type { IncomingHttpHeaders } from "node:http";
import { readAuthFile } from "./account-store";
import { loadConfig } from "./config";
import { listCandidateAccounts } from "./scheduler";
import { recordAccountScheduleSuccess } from "./state-repository";
import {
  getCachedCodexClientVersion,
  setAccountBlock,
  setCachedCodexClientVersion
} from "./state";
import { bi } from "./text";
import { sendCodexRequest } from "./upstream-client";
import {
  buildNetworkUnavailablePayload,
  isNetworkUnavailableError,
  isUsageLimitErrorText,
  resolveBlockWindow
} from "./upstream-error-policy";
import { refreshAccountTokens } from "./usage-sync";
import type {
  CodexAuthFile,
  CodexClientVersionCacheSource,
  CslotConfig,
  SchedulerPick
} from "./types";

const FALLBACK_CODEX_CLIENT_VERSION = "0.142.5";

interface UpstreamProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string> & {
    text: () => Promise<string>;
  };
}

interface CodexProxyRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

interface ProxyRetryDependencies {
  loadConfig: () => CslotConfig;
  listCandidateAccounts: () => SchedulerPick[];
  readAuthFile: (codexHome: string) => CodexAuthFile | null;
  sendCodexRequest: typeof sendCodexRequest;
  refreshAccountTokens: typeof refreshAccountTokens;
  setAccountBlock: typeof setAccountBlock;
  recordAccountScheduleSuccess: typeof recordAccountScheduleSuccess;
  getCachedCodexClientVersion: typeof getCachedCodexClientVersion;
  setCachedCodexClientVersion: typeof setCachedCodexClientVersion;
}

export type ProxyRetryResult =
  | {
      type: "proxy";
      statusCode: number;
      headers: Record<string, string>;
      body: AsyncIterable<Buffer | Uint8Array | string>;
    }
  | {
      type: "send";
      statusCode: number;
      headers?: Record<string, string>;
      payload: unknown;
    };

/**
 * 为当前请求失败的账号设置临时熔断状态，避免短时间内被重复选中。
 *
 * @param dependencies 代理服务依赖集合。
 * @param accountId 账号标识。
 * @param reason 本地状态中记录的失败原因。
 * @param blockSeconds 熔断持续秒数。
 * @returns 无返回值。
 * @throws 当状态写入失败时透传底层异常。
 */
function markAccountFailure(
  dependencies: ProxyRetryDependencies,
  accountId: string,
  reason: string,
  blockSeconds: number
): void {
  dependencies.setAccountBlock(accountId, Math.floor(Date.now() / 1000) + blockSeconds, reason);
}

/**
 * 提取上游响应中允许透传给客户端的响应头。
 *
 * @param headers 上游响应头对象。
 * @returns 可透传响应头。
 * @throws 无显式抛出。
 */
function pickResponseHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const picked: Record<string, string> = {};
  const contentType = headers["content-type"];
  const cacheControl = headers["cache-control"];

  if (typeof contentType === "string") {
    picked["content-type"] = contentType;
  }

  if (typeof cacheControl === "string") {
    picked["cache-control"] = cacheControl;
  }

  return picked;
}

/**
 * 构造统一错误响应结果。
 *
 * @param statusCode HTTP 状态码。
 * @param payload 响应体。
 * @param headers 可选响应头。
 * @returns 代理服务可直接写回的 send 结果。
 * @throws 无显式抛出。
 */
function buildSendResult(
  statusCode: number,
  payload: unknown,
  headers?: Record<string, string>
): ProxyRetryResult {
  return {
    type: "send",
    statusCode,
    payload,
    headers
  };
}

/**
 * 解析 models 响应中的模型标识。
 *
 * @param model Codex models 接口返回的单个模型对象，允许缺少非关键字段。
 * @returns 可暴露给 OpenAI-compatible 客户端的模型 id；缺失时返回 `null`。
 * @throws 无显式抛出。
 */
function resolveModelId(model: unknown): string | null {
  if (!model || typeof model !== "object") {
    return null;
  }

  const candidate = model as { slug?: unknown; id?: unknown };
  if (typeof candidate.slug === "string" && candidate.slug) {
    return candidate.slug;
  }

  if (typeof candidate.id === "string" && candidate.id) {
    return candidate.id;
  }

  return null;
}

/**
 * 将 Codex 私有 models 响应转换成 OpenAI-compatible models 列表。
 *
 * @param payload Codex 上游响应文本，期望结构为 `{ models: [...] }`。
 * @returns Hermes 等客户端可识别的 `{ object, data }` 响应体。
 * @throws 当响应不是合法 JSON 或 `models` 不是数组时抛出错误。
 */
function buildOpenAiCompatibleModelsPayload(payload: string): {
  object: "list";
  data: Array<{ id: string; object: "model"; created: number; owned_by: string }>;
} {
  const parsed = JSON.parse(payload) as { models?: unknown };
  if (!Array.isArray(parsed.models)) {
    throw new Error("Codex models response does not contain models array");
  }

  return {
    object: "list",
    data: parsed.models
      .filter((model): model is Record<string, unknown> => {
        if (!model || typeof model !== "object") {
          return false;
        }

        return (model as { visibility?: unknown }).visibility !== "hide";
      })
      .map((model) => {
        const id = resolveModelId(model);
        if (!id) {
          return null;
        }

        return {
          id,
          object: "model" as const,
          created: 0,
          owned_by: "openai"
        };
      })
      .filter((model): model is { id: string; object: "model"; created: number; owned_by: string } => model !== null)
  };
}

/**
 * 删除请求头中的指定字段，并保持其他字段原样透传。
 *
 * @param headers 客户端发到本地代理的原始请求头。
 * @param headerName 需要删除的请求头名称，按大小写不敏感匹配。
 * @returns 删除目标字段后的浅拷贝请求头。
 * @throws 无显式抛出。
 */
function omitRequestHeader(
  headers: IncomingHttpHeaders,
  headerName: string
): IncomingHttpHeaders {
  const nextHeaders: IncomingHttpHeaders = {};
  const normalizedTarget = headerName.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalizedTarget) {
      continue;
    }

    nextHeaders[key] = value;
  }

  return nextHeaders;
}

/**
 * 解析本地 Codex-compatible 代理请求，并转换成上游 codex path。
 *
 * 业务含义：
 * 1. 对外暴露的 `/v1/*` 请求需要统一映射到上游 `codex_base_url` 的同名子路径，避免继续按接口逐个补洞。
 * 2. 为兼容历史入口，也保留 `/backend-api/codex/*` 映射到同一上游 path 的能力。
 *
 * @param request 原始本地代理请求。
 * @returns 可发往上游的 codex path；不属于代理范围时返回错误结果。
 * @throws 当 URL 解析失败时返回错误结果，不向上游发请求。
 */
function resolveCodexPath(request: CodexProxyRequest, dependencies: ProxyRetryDependencies): {
  pathWithQuery?: string;
  clientVersionToCache?: {
    version: string;
    source: CodexClientVersionCacheSource;
  };
  adaptModelsForOpenAiClient?: boolean;
  error?: ProxyRetryResult;
} {
  const parsedUrl = new URL(request.url, "http://127.0.0.1");
  const openAiPrefix = "/v1";
  const legacyBackendPrefix = "/backend-api/codex";

  if (parsedUrl.pathname.startsWith(`${openAiPrefix}/`)) {
    if (
      request.method.toUpperCase() === "GET" &&
      parsedUrl.pathname === "/v1/models" &&
      !parsedUrl.searchParams.has("client_version")
    ) {
      const cachedVersion = dependencies.getCachedCodexClientVersion();
      const version = cachedVersion ?? FALLBACK_CODEX_CLIENT_VERSION;
      parsedUrl.searchParams.set("client_version", version);

      return {
        pathWithQuery: `${parsedUrl.pathname.slice(openAiPrefix.length)}${parsedUrl.search}`,
        clientVersionToCache: cachedVersion
          ? undefined
          : {
              version,
              source: "fallback"
            },
        adaptModelsForOpenAiClient: true
      };
    }

    const clientVersion = parsedUrl.searchParams.get("client_version");

    return {
      pathWithQuery: `${parsedUrl.pathname.slice(openAiPrefix.length)}${parsedUrl.search}`,
      clientVersionToCache:
        parsedUrl.pathname === "/v1/models" && clientVersion
          ? {
              version: clientVersion,
              source: "request"
            }
          : undefined
    };
  }

  if (parsedUrl.pathname.startsWith(`${legacyBackendPrefix}/`)) {
    return {
      pathWithQuery: `${parsedUrl.pathname.slice(legacyBackendPrefix.length)}${parsedUrl.search}`
    };
  }

  return {
    error: buildSendResult(404, {
      error: {
        message: bi("不支持的 Codex 代理路径", "Unsupported Codex proxy path"),
        type: "unsupported_codex_proxy_path"
      }
    })
  };
}

/**
 * 对单个候选账号发送通用的 codex 上游请求。
 *
 * @param dependencies 代理服务依赖集合。
 * @param picked 当前候选账号。
 * @param accessToken 可用 access token。
 * @param pathWithQuery 已解析的 codex path 与 query。
 * @param request 原始本地代理请求。
 * @returns 上游响应。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
async function sendWithAccount(
  dependencies: ProxyRetryDependencies,
  picked: SchedulerPick,
  accessToken: string,
  pathWithQuery: string,
  request: CodexProxyRequest
): Promise<UpstreamProxyResponse> {
  const config = dependencies.loadConfig();
  const auth = dependencies.readAuthFile(picked.account.codex_home);

  return await dependencies.sendCodexRequest({
    codexBaseUrl: config.upstream.codex_base_url,
    method: request.method.toUpperCase(),
    pathWithQuery,
    requestHeaders: request.headers,
    accessToken,
    accountIdHeader: auth?.tokens?.account_id,
    body: request.body
  });
}

/**
 * 创建代理重试服务。
 *
 * 业务含义：
 * 1. 默认依赖绑定真实配置、账号、状态和上游请求。
 * 2. `/v1/*` 与历史 `/backend-api/codex/*` 都复用同一套账号调度、401 刷新与异常兜底语义。
 *
 * @param overrides 可选依赖覆盖项。
 * @returns 代理重试服务实例。
 * @throws 无显式抛出。
 */
export function createProxyRetryService(overrides?: Partial<ProxyRetryDependencies>): {
  proxyCodexWithRetry: (request: CodexProxyRequest) => Promise<ProxyRetryResult>;
  proxyResponsesWithRetry: (
    requestHeaders: IncomingHttpHeaders,
    requestBody: Buffer
  ) => Promise<ProxyRetryResult>;
} {
  const dependencies: ProxyRetryDependencies = {
    loadConfig,
    listCandidateAccounts,
    readAuthFile,
    sendCodexRequest,
    refreshAccountTokens,
    setAccountBlock,
    recordAccountScheduleSuccess,
    getCachedCodexClientVersion,
    setCachedCodexClientVersion,
    ...overrides
  };

  const proxyCodexWithRetry = async (request: CodexProxyRequest): Promise<ProxyRetryResult> => {
      const route = resolveCodexPath(request, dependencies);

      if (route.error) {
        return route.error;
      }

      const candidates = dependencies.listCandidateAccounts();
      const upstreamRequest = route.adaptModelsForOpenAiClient
        ? {
            ...request,
            headers: omitRequestHeader(request.headers, "accept-encoding")
          }
        : request;

      if (candidates.length === 0) {
        return buildSendResult(503, {
          error: {
            message: bi("当前没有可用账号", "No available account"),
            type: "no_available_account"
          }
        });
      }

      let lastErrorPayload: unknown = {
        error: {
          message: bi("所有账号都请求失败", "All accounts failed"),
          type: "all_accounts_failed"
        }
      };
      let lastStatusCode = 503;

      for (const picked of candidates) {
        const auth = dependencies.readAuthFile(picked.account.codex_home);
        let accessToken = auth?.tokens?.access_token;

        if (!accessToken) {
          markAccountFailure(dependencies, picked.account.id, "invalid_account_auth", 10 * 60);
          lastStatusCode = 503;
          lastErrorPayload = {
            error: {
              message: bi(`账号 ${picked.account.id} 缺少 access_token`, `Account ${picked.account.id} is missing access_token`),
              type: "invalid_account_auth"
            }
          };
          continue;
        }

        let upstream;

        try {
          upstream = await sendWithAccount(dependencies, picked, accessToken, route.pathWithQuery!, upstreamRequest);
        } catch (error) {
          lastStatusCode = 503;
          if (isNetworkUnavailableError(error)) {
            lastErrorPayload = buildNetworkUnavailablePayload(picked.account.id, error);
            continue;
          }

          markAccountFailure(dependencies, picked.account.id, "request_failed", 60);
          lastErrorPayload = {
            error: {
              message: `账号 ${picked.account.id} 请求上游失败: ${error instanceof Error ? error.message : String(error)}`,
              type: "account_request_failed"
            }
          };
          continue;
        }

        if (upstream.statusCode === 401) {
          await upstream.body.text();
          try {
            const refreshed = await dependencies.refreshAccountTokens(picked.account.id);
            accessToken = refreshed.tokens?.access_token ?? accessToken;
            upstream = await sendWithAccount(dependencies, picked, accessToken, route.pathWithQuery!, upstreamRequest);
          } catch (error) {
            lastStatusCode = 503;
            if (isNetworkUnavailableError(error)) {
              lastErrorPayload = buildNetworkUnavailablePayload(picked.account.id, error);
              continue;
            }

            markAccountFailure(dependencies, picked.account.id, "token_refresh_failed", 10 * 60);
            lastErrorPayload = {
              error: {
                message: `账号 ${picked.account.id} 刷新 token 失败: ${error instanceof Error ? error.message : String(error)}`,
                type: "account_token_refresh_failed"
              }
            };
            continue;
          }
        }

        if (upstream.statusCode === 401) {
          await upstream.body.text();
          markAccountFailure(dependencies, picked.account.id, "invalid_account_auth", 10 * 60);
          lastStatusCode = 401;
          lastErrorPayload = {
            error: {
              message: bi(
                `账号 ${picked.account.id} 刷新 token 后仍未通过上游鉴权`,
                `Account ${picked.account.id} is still unauthorized after token refresh`
              ),
              type: "invalid_account_auth"
            }
          };
          continue;
        }

        const responseHeaders = pickResponseHeaders(upstream.headers);

        if (upstream.statusCode === 429 || upstream.statusCode === 403) {
          const errorText = await upstream.body.text();
          const block = resolveBlockWindow(picked, errorText);
          dependencies.setAccountBlock(picked.account.id, block.until, block.reason);
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

          if (isUsageLimitErrorText(errorText)) {
            const block = resolveBlockWindow(picked, errorText);
            dependencies.setAccountBlock(picked.account.id, block.until, block.reason);
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
            markAccountFailure(dependencies, picked.account.id, "upstream_5xx", 60);
            lastStatusCode = upstream.statusCode;
            lastErrorPayload = {
              error: {
                message: `账号 ${picked.account.id} 上游异常: ${errorText}`,
                type: "account_upstream_failed"
              }
            };
            continue;
          }

          return buildSendResult(upstream.statusCode, errorText, {
            "content-type": responseHeaders["content-type"] ?? "application/json",
            ...responseHeaders
          });
        }

        dependencies.recordAccountScheduleSuccess(picked.account.id);

        if (route.clientVersionToCache) {
          dependencies.setCachedCodexClientVersion(
            route.clientVersionToCache.version,
            route.clientVersionToCache.source
          );
        }

        if (route.adaptModelsForOpenAiClient) {
          try {
            return buildSendResult(
              upstream.statusCode,
              buildOpenAiCompatibleModelsPayload(await upstream.body.text()),
              {
                "content-type": "application/json",
                "cache-control": responseHeaders["cache-control"] ?? "no-store"
              }
            );
          } catch (error) {
            return buildSendResult(502, {
              error: {
                message: `Codex models 响应格式无法转换: ${error instanceof Error ? error.message : String(error)}`,
                type: "codex_models_adapter_failed"
              }
            });
          }
        }

        return {
          type: "proxy",
          statusCode: upstream.statusCode,
          headers: {
            ...responseHeaders,
            connection: "keep-alive"
          },
          body: upstream.body
        };
      }

      return buildSendResult(lastStatusCode, lastErrorPayload);
  };

  const proxyResponsesWithRetry = async (
    requestHeaders: IncomingHttpHeaders,
    requestBody: Buffer
  ): Promise<ProxyRetryResult> =>
    await proxyCodexWithRetry({
      method: "POST",
      url: "/v1/responses",
      headers: requestHeaders,
      body: requestBody
    });

  return {
    proxyCodexWithRetry,
    proxyResponsesWithRetry
  };
}

export const { proxyCodexWithRetry, proxyResponsesWithRetry } = createProxyRetryService();
