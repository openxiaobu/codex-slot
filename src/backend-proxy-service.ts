import type { IncomingHttpHeaders } from "node:http";
import { readAuthFile } from "./account-store";
import { loadConfig } from "./config";
import { listCandidateAccounts } from "./scheduler";
import { recordAccountScheduleSuccess } from "./state-repository";
import { setAccountBlock } from "./state";
import { bi } from "./text";
import { sendChatGptBackendRequest } from "./upstream-client";
import {
  buildNetworkUnavailablePayload,
  isNetworkUnavailableError
} from "./upstream-error-policy";
import { refreshAccountTokens } from "./usage-sync";
import type { CodexAuthFile, CslotConfig, SchedulerPick } from "./types";

interface BackendProxyRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body?: Buffer;
}

interface UpstreamBackendResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string> & {
    text: () => Promise<string>;
  };
}

interface BackendProxyDependencies {
  loadConfig: () => CslotConfig;
  listCandidateAccounts: () => SchedulerPick[];
  readAuthFile: (codexHome: string) => CodexAuthFile | null;
  sendChatGptBackendRequest: typeof sendChatGptBackendRequest;
  refreshAccountTokens: typeof refreshAccountTokens;
  setAccountBlock: typeof setAccountBlock;
  recordAccountScheduleSuccess: typeof recordAccountScheduleSuccess;
}

export type BackendProxyResult =
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
 * 解析本地 ChatGPT backend 代理请求，并转换成上游 backend path。
 *
 * 业务含义：
 * 1. 本地代理只承载 `/backend-api/*` 这一类 ChatGPT backend 请求。
 * 2. backend path 与 query 保留原样透传给上游，具体上游鉴权由 cslot 内部接管。
 *
 * @param request 原始本地代理请求。
 * @returns 可发往上游的 backend path；不属于 backend 代理范围时返回错误结果。
 * @throws 当 URL 解析失败时返回错误结果，不向上游发请求。
 */
function resolveBackendPath(request: BackendProxyRequest): {
  pathWithQuery?: string;
  error?: BackendProxyResult;
} {
  const parsedUrl = new URL(request.url, "http://127.0.0.1");
  const backendPrefix = "/backend-api";

  if (!parsedUrl.pathname.startsWith(`${backendPrefix}/`)) {
    return {
      error: buildSendResult(404, {
        error: {
          message: bi("不支持的 ChatGPT backend 代理路径", "Unsupported ChatGPT backend proxy path"),
          type: "unsupported_backend_proxy_path"
        }
      })
    };
  }

  const backendPath = parsedUrl.pathname.slice(backendPrefix.length);

  return {
    pathWithQuery: `${backendPath}${parsedUrl.search}`
  };
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
): BackendProxyResult {
  return {
    type: "send",
    statusCode,
    payload,
    headers
  };
}

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
  dependencies: BackendProxyDependencies,
  accountId: string,
  reason: string,
  blockSeconds: number
): void {
  dependencies.setAccountBlock(accountId, Math.floor(Date.now() / 1000) + blockSeconds, reason);
}

/**
 * 使用指定候选账号向 ChatGPT backend 发送请求。
 *
 * @param dependencies 代理服务依赖集合。
 * @param picked 当前候选账号。
 * @param accessToken 可用 access token。
 * @param pathWithQuery 已解析的 backend path 与 query。
 * @param request 原始本地代理请求。
 * @returns 上游响应。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
async function sendWithAccount(
  dependencies: BackendProxyDependencies,
  picked: SchedulerPick,
  accessToken: string,
  pathWithQuery: string,
  request: BackendProxyRequest
): Promise<UpstreamBackendResponse> {
  const config = dependencies.loadConfig();
  const auth = dependencies.readAuthFile(picked.account.codex_home);

  return await dependencies.sendChatGptBackendRequest({
    chatGptBaseUrl: config.upstream.chatgpt_base_url,
    method: request.method.toUpperCase(),
    pathWithQuery,
    requestHeaders: request.headers,
    accessToken,
    accountIdHeader: auth?.tokens?.account_id,
    body: request.body
  });
}

/**
 * 创建 ChatGPT backend 代理服务。
 *
 * 业务含义：
 * 1. 该服务复用 cslot 的账号调度与 token 刷新能力。
 * 2. `/backend-api/*` 请求全量透传给 ChatGPT backend，但官方 token 始终只在 cslot 内部使用。
 * 3. 非模型 backend 请求不套用 responses 的额度熔断语义，只对缺凭据、网络异常与 5xx 做账号级兜底。
 *
 * @param overrides 可选依赖覆盖项。
 * @returns ChatGPT backend 代理服务实例。
 * @throws 无显式抛出。
 */
export function createBackendProxyService(overrides?: Partial<BackendProxyDependencies>): {
  proxyChatGptBackendWithRetry: (request: BackendProxyRequest) => Promise<BackendProxyResult>;
} {
  const dependencies: BackendProxyDependencies = {
    loadConfig,
    listCandidateAccounts,
    readAuthFile,
    sendChatGptBackendRequest,
    refreshAccountTokens,
    setAccountBlock,
    recordAccountScheduleSuccess,
    ...overrides
  };

  return {
    async proxyChatGptBackendWithRetry(request: BackendProxyRequest): Promise<BackendProxyResult> {
      const route = resolveBackendPath(request);

      if (route.error) {
        return route.error;
      }

      const candidates = dependencies.listCandidateAccounts();

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
          upstream = await sendWithAccount(dependencies, picked, accessToken, route.pathWithQuery!, request);
        } catch (error) {
          if (isNetworkUnavailableError(error)) {
            lastErrorPayload = buildNetworkUnavailablePayload(picked.account.id, error);
            continue;
          }

          markAccountFailure(dependencies, picked.account.id, "request_failed", 60);
          lastErrorPayload = {
            error: {
              message: `账号 ${picked.account.id} 请求 ChatGPT backend 失败: ${error instanceof Error ? error.message : String(error)}`,
              type: "account_backend_request_failed"
            }
          };
          continue;
        }

        if (upstream.statusCode === 401) {
          try {
            const refreshed = await dependencies.refreshAccountTokens(picked.account.id);
            accessToken = refreshed.tokens?.access_token ?? accessToken;
            upstream = await sendWithAccount(dependencies, picked, accessToken, route.pathWithQuery!, request);
          } catch (error) {
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

        const responseHeaders = pickResponseHeaders(upstream.headers);

        if (upstream.statusCode >= 500) {
          const errorText = await upstream.body.text();
          markAccountFailure(dependencies, picked.account.id, "upstream_5xx", 60);
          lastStatusCode = upstream.statusCode;
          lastErrorPayload = {
            error: {
              message: `账号 ${picked.account.id} ChatGPT backend 异常: ${errorText}`,
              type: "account_backend_upstream_failed"
            }
          };
          continue;
        }

        dependencies.recordAccountScheduleSuccess(picked.account.id);

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
    }
  };
}

export const { proxyChatGptBackendWithRetry } = createBackendProxyService();
