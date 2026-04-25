import type { IncomingHttpHeaders } from "node:http";
import { readAuthFile } from "./account-store";
import { loadConfig } from "./config";
import { listCandidateAccounts } from "./scheduler";
import { recordAccountScheduleSuccess } from "./state-repository";
import { setAccountBlock } from "./state";
import { bi } from "./text";
import { sendCodexResponsesRequest } from "./upstream-client";
import {
  buildNetworkUnavailablePayload,
  isNetworkUnavailableError,
  isUsageLimitErrorText,
  resolveBlockWindow
} from "./upstream-error-policy";
import { refreshAccountTokens } from "./usage-sync";
import type { CodexAuthFile, CslotConfig, SchedulerPick } from "./types";

interface UpstreamProxyResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Buffer | Uint8Array | string> & {
    text: () => Promise<string>;
  };
}

interface ProxyRetryDependencies {
  loadConfig: () => CslotConfig;
  listCandidateAccounts: () => SchedulerPick[];
  readAuthFile: (codexHome: string) => CodexAuthFile | null;
  sendCodexResponsesRequest: typeof sendCodexResponsesRequest;
  refreshAccountTokens: typeof refreshAccountTokens;
  setAccountBlock: typeof setAccountBlock;
  recordAccountScheduleSuccess: typeof recordAccountScheduleSuccess;
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
 * 对单个候选账号发送上游请求。
 *
 * @param picked 当前候选账号。
 * @param accessToken 可用 access token。
 * @param requestHeaders 原始请求头。
 * @param requestBody 原始请求体。
 * @returns 上游响应。
 * @throws 当网络层或 undici 请求失败时透传底层异常。
 */
async function sendWithAccount(
  dependencies: ProxyRetryDependencies,
  picked: SchedulerPick,
  accessToken: string,
  requestHeaders: IncomingHttpHeaders,
  requestBody: Buffer
): Promise<UpstreamProxyResponse> {
  const config = dependencies.loadConfig();
  const auth = dependencies.readAuthFile(picked.account.codex_home);

  return await dependencies.sendCodexResponsesRequest({
    codexBaseUrl: config.upstream.codex_base_url,
    requestHeaders,
    accessToken,
    accountIdHeader: auth?.tokens?.account_id,
    body: requestBody
  });
}

/**
 * 创建代理重试服务。
 *
 * 业务含义：
 * 1. 默认依赖绑定真实配置、账号、状态和上游请求。
 * 2. 测试或未来扩展可注入替代依赖，避免业务重试逻辑硬绑 I/O 实现。
 *
 * @param overrides 可选依赖覆盖项。
 * @returns 代理重试服务实例。
 * @throws 无显式抛出。
 */
export function createProxyRetryService(overrides?: Partial<ProxyRetryDependencies>): {
  proxyResponsesWithRetry: (
    requestHeaders: IncomingHttpHeaders,
    requestBody: Buffer
  ) => Promise<ProxyRetryResult>;
} {
  const dependencies: ProxyRetryDependencies = {
    loadConfig,
    listCandidateAccounts,
    readAuthFile,
    sendCodexResponsesRequest,
    refreshAccountTokens,
    setAccountBlock,
    recordAccountScheduleSuccess,
    ...overrides
  };

  return {
    async proxyResponsesWithRetry(
      requestHeaders: IncomingHttpHeaders,
      requestBody: Buffer
    ): Promise<ProxyRetryResult> {
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
          upstream = await sendWithAccount(dependencies, picked, accessToken, requestHeaders, requestBody);
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
          try {
            const refreshed = await dependencies.refreshAccountTokens(picked.account.id);
            accessToken = refreshed.tokens?.access_token ?? accessToken;
            upstream = await sendWithAccount(dependencies, picked, accessToken, requestHeaders, requestBody);
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

export const { proxyResponsesWithRetry } = createProxyRetryService();
