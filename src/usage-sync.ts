import { request } from "undici";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  findManagedAccount,
  readAuthFile,
  resolvePrimaryRegistryAccount,
  writeAuthFile
} from "./account-store";
import { getCslotHome, loadConfig } from "./config";
import { withFileLock } from "./file-lock";
import { reconcileQuotaBlockAfterUsageRefresh } from "./quota-status";
import {
  clearAccountBlock,
  getAccountBlock,
  clearUsageRefreshError,
  getUsageCache,
  setUsageCache,
  setUsageRefreshError
} from "./state";
import { bi } from "./text";
import type {
  CodexAuthFile,
  UsageRefreshError,
  UsageRefreshResult
} from "./types";

const USAGE_CACHE_TTL_MS = 60 * 1000;
const inflightUsageRefreshes = new Map<string, Promise<void>>();
const inflightTokenRefreshes = new Map<string, Promise<CodexAuthFile>>();

interface UsageWindow {
  used_percent?: number;
  reset_at?: number;
  reset_after_seconds?: number;
  limit_window_seconds?: number;
}

interface WhamUsageResponse {
  plan_type?: string | null;
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: UsageWindow;
    secondary_window?: UsageWindow;
  };
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number | null;
  };
}

const SHORT_LIVED_ACCOUNT_BLOCK_REASONS = new Set([
  "request_failed",
  "upstream_5xx",
  "temporary_5m_limit",
  "token_refresh_failed"
]);

function normalizeResetAt(value?: number, resetAfterSeconds?: number): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof resetAfterSeconds === "number" && Number.isFinite(resetAfterSeconds)) {
    return Math.floor(Date.now() / 1000) + resetAfterSeconds;
  }

  return null;
}

/**
 * 按 ChatGPT 返回的额度窗口数量映射 cslot 的短周期与周额度字段。
 *
 * @param rateLimit ChatGPT 返回的额度窗口；窗口可能缺失，且 primary/secondary 的位置不保证代表固定周期。
 * @returns cslot 使用的额度字段；单窗口记为周额度，双窗口沿用 primary 为短周期、secondary 为周额度的语义，不存在对应窗口时返回 `null`。
 * @throws 此方法不会主动抛出异常；无效或缺失的重置时间会被归一化为 `null`。
 */
export function mapUsageWindows(rateLimit?: WhamUsageResponse["rate_limit"]): Pick<UsageRefreshResult,
  "fiveHourUsedPercent" | "fiveHourResetAt" | "weeklyUsedPercent" | "weeklyResetAt"> {
  const primaryWindow = rateLimit?.primary_window;
  const secondaryWindow = rateLimit?.secondary_window;

  // 当前只有周额度时上游会把唯一窗口放在 primary，双窗口时才保留原来的主次语义。
  const fiveHourWindow = primaryWindow && secondaryWindow ? primaryWindow : undefined;
  const weeklyWindow = secondaryWindow ?? primaryWindow;

  return {
    fiveHourUsedPercent: fiveHourWindow?.used_percent ?? null,
    fiveHourResetAt: normalizeResetAt(fiveHourWindow?.reset_at, fiveHourWindow?.reset_after_seconds),
    weeklyUsedPercent: weeklyWindow?.used_percent ?? null,
    weeklyResetAt: normalizeResetAt(weeklyWindow?.reset_at, weeklyWindow?.reset_after_seconds)
  };
}

/**
 * 当账号已经成功完成鉴权或额度刷新时，清理与瞬时异常相关的本地熔断。
 *
 * 只会移除短期失败类熔断，不会误清理 5 小时或周额度限制。
 *
 * @param accountId 账号标识。
 * @returns 无返回值。
 */
function clearShortLivedAccountBlock(accountId: string): void {
  const block = getAccountBlock(accountId);

  if (!block || !SHORT_LIVED_ACCOUNT_BLOCK_REASONS.has(block.reason)) {
    return;
  }

  clearAccountBlock(accountId);
}

/**
 * 将额度刷新异常归类为可直接展示在 `status` 表格中的状态码。
 *
 * @param accountId 刷新失败的账号标识。
 * @param error 刷新流程抛出的原始异常。
 * @returns 归一化后的刷新失败状态。
 */
function classifyUsageRefreshError(accountId: string, error: unknown): UsageRefreshError {
  const message = error instanceof Error ? error.message : String(error);
  const workspaceInvalidPatterns = [
    "未找到账号",
    "缺少 access_token",
    "缺少 refresh_token",
    "Unexpected end of JSON input",
    "Unexpected token"
  ];
  const code = workspaceInvalidPatterns.some((pattern) => message.includes(pattern))
    ? "workspace_invalid"
    : "refresh_failed";

  return {
    accountId,
    code,
    message,
    updatedAt: new Date().toISOString()
  };
}

/**
 * 使用 refresh token 刷新指定账号的 access token，并回写到账号目录。
 *
 * @param accountId 账号标识。
 * @returns 最新认证信息。
 * @throws 当账号不存在、缺少 refresh_token 或刷新失败时抛出错误。
 */
export async function refreshAccountTokens(accountId: string): Promise<CodexAuthFile> {
  const existing = inflightTokenRefreshes.get(accountId);
  if (existing) {
    return await existing;
  }

  const refreshTask = refreshAccountTokensExclusive(accountId);
  inflightTokenRefreshes.set(accountId, refreshTask);

  try {
    return await refreshTask;
  } finally {
    if (inflightTokenRefreshes.get(accountId) === refreshTask) {
      inflightTokenRefreshes.delete(accountId);
    }
  }
}

/**
 * 在账号级跨进程锁内刷新 token，并复用等待期间由其他进程写入的新凭据。
 *
 * @param accountId 账号标识。
 * @returns 最新认证信息；若等待锁期间其他进程已经刷新则直接返回磁盘新值。
 * @throws 当账号不存在、缺少 refresh_token、锁等待或远端刷新失败时抛出错误。
 */
async function refreshAccountTokensExclusive(accountId: string): Promise<CodexAuthFile> {
  const config = loadConfig();
  const account = findManagedAccount(accountId);

  if (!account) {
    throw new Error(bi(`未找到账号 ${accountId}`, `Account not found: ${accountId}`));
  }

  const initialAuth = readAuthFile(account.codex_home);
  const initialLastRefresh = initialAuth?.last_refresh ?? null;
  const lockName = createHash("sha256").update(accountId).digest("hex");
  const lockPath = path.join(getCslotHome(), "locks", `token-${lockName}.lock`);

  return await withFileLock(lockPath, async () => {
    const latestAccount = findManagedAccount(accountId);
    if (!latestAccount) {
      throw new Error(bi(`未找到账号 ${accountId}`, `Account not found: ${accountId}`));
    }

    const auth = readAuthFile(latestAccount.codex_home);
    if (
      auth?.last_refresh &&
      auth.last_refresh !== initialLastRefresh &&
      auth.tokens?.access_token
    ) {
      return auth;
    }

    const refreshToken = auth?.tokens?.refresh_token;
    if (!refreshToken) {
      throw new Error(bi(`账号 ${accountId} 缺少 refresh_token`, `Account ${accountId} is missing refresh_token`));
    }

    const response = await request(`${config.upstream.auth_base_url}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: config.upstream.oauth_client_id
      }).toString()
    });

    if (response.statusCode >= 400) {
      await response.body.text();
      throw new Error(bi(`刷新 token 失败: HTTP ${response.statusCode}`, `Failed to refresh token: HTTP ${response.statusCode}`));
    }

    const payload = (await response.body.json()) as {
      access_token?: string;
      refresh_token?: string;
      id_token?: string;
    };

    const nextAuth: CodexAuthFile = {
      ...(auth ?? {}),
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        ...(auth?.tokens ?? {}),
        access_token: payload.access_token ?? auth?.tokens?.access_token,
        refresh_token: payload.refresh_token ?? auth?.tokens?.refresh_token,
        id_token: payload.id_token ?? auth?.tokens?.id_token,
        account_id: auth?.tokens?.account_id
      },
      last_refresh: new Date().toISOString()
    };

    writeAuthFile(latestAccount.codex_home, nextAuth);
    clearShortLivedAccountBlock(accountId);
    return nextAuth;
  }, {
    timeoutMs: 30_000
  });
}

/**
 * 查询单个账号的最新额度信息，并写入 cslot 自己的 usage 缓存。
 *
 * @param accountId 账号标识。
 * @returns 刷新后的额度摘要。
 * @throws 当账号不存在、未登录或远端请求失败时抛出错误。
 */
export async function refreshAccountUsage(accountId: string): Promise<UsageRefreshResult> {
  const account = findManagedAccount(accountId);

  if (!account) {
    throw new Error(bi(`未找到账号 ${accountId}`, `Account not found: ${accountId}`));
  }

  let payload: WhamUsageResponse | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const auth = readAuthFile(account.codex_home);
    const accessToken = auth?.tokens?.access_token;
    const accountIdHeader = auth?.tokens?.account_id;
    if (!accessToken) {
      throw new Error(bi(`账号 ${accountId} 缺少 access_token`, `Account ${accountId} is missing access_token`));
    }

    const response = await request("https://chatgpt.com/backend-api/wham/usage", {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        "user-agent": "codex-slot/0.1.1",
        ...(accountIdHeader ? { "chatgpt-account-id": accountIdHeader } : {})
      }
    });

    if (response.statusCode === 401) {
      await response.body.text();
      if (attempt === 0) {
        await refreshAccountTokens(accountId);
        continue;
      }
      throw new Error(bi("刷新额度失败: token 刷新后仍返回 HTTP 401", "Failed to refresh usage: HTTP 401 after token refresh"));
    }

    if (response.statusCode >= 400) {
      const errorText = (await response.body.text()).slice(0, 1000);
      throw new Error(bi(`刷新额度失败: HTTP ${response.statusCode} ${errorText}`, `Failed to refresh usage: HTTP ${response.statusCode} ${errorText}`));
    }

    payload = (await response.body.json()) as WhamUsageResponse;
    break;
  }

  if (!payload) {
    throw new Error(bi("刷新额度失败: 未返回有效响应", "Failed to refresh usage: no valid response"));
  }

  const primary = resolvePrimaryRegistryAccount(account.codex_home);
  const email = primary?.email ?? account.email ?? undefined;
  const plan = payload.plan_type ?? primary?.plan ?? "-";
  const usageWindows = mapUsageWindows(payload.rate_limit);
  const result: UsageRefreshResult = {
    accountId: account.id,
    email,
    plan,
    ...usageWindows,
    refreshedAt: new Date().toISOString()
  };

  setUsageCache(result);
  clearUsageRefreshError(accountId);
  clearShortLivedAccountBlock(accountId);
  reconcileQuotaBlockAfterUsageRefresh(accountId, result);
  return result;
}

/**
 * 判断指定账号的额度缓存是否已经过期。
 *
 * @param accountId 账号标识。
 * @returns `true` 表示不存在缓存或缓存已超过 TTL，需要重新刷新；`false` 表示缓存仍可直接复用。
 */
export function isUsageCacheStale(accountId: string): boolean {
  const usageCache = getUsageCache(accountId);

  if (!usageCache?.refreshedAt) {
    return true;
  }

  const refreshedAt = Date.parse(usageCache.refreshedAt);
  if (Number.isNaN(refreshedAt)) {
    return true;
  }

  return Date.now() - refreshedAt > USAGE_CACHE_TTL_MS;
}

/**
 * 在不阻塞主请求链路的前提下，按需异步刷新指定账号的额度缓存。
 *
 * @param accountId 账号标识。
 * @returns 无返回值；若缓存仍在 TTL 内或已有刷新任务进行中则直接跳过。
 */
export function refreshAccountUsageInBackgroundIfNeeded(accountId: string): void {
  if (!isUsageCacheStale(accountId) || inflightUsageRefreshes.has(accountId)) {
    return;
  }

  // 同一账号同一时刻只保留一个后台刷新任务，避免高并发下重复打远端 usage 接口。
  const refreshTask = (async () => {
    try {
      await refreshAccountUsage(accountId);
    } catch {
      // 后台刷新失败时保留旧缓存，由正式转发请求中的错误处理继续兜底。
    } finally {
      inflightUsageRefreshes.delete(accountId);
    }
  })();

  inflightUsageRefreshes.set(accountId, refreshTask);
}

/**
 * 批量刷新所有受管账号的额度信息。
 *
 * @returns 每个账号对应的刷新结果列表。
 */
export async function refreshAllAccountUsage(): Promise<UsageRefreshResult[]> {
  const config = loadConfig();
  const results: UsageRefreshResult[] = [];

  for (const account of config.accounts) {
    if (!account.enabled) {
      continue;
    }

    try {
      const result = await refreshAccountUsage(account.id);
      results.push(result);
    } catch (error) {
      setUsageRefreshError(classifyUsageRefreshError(account.id, error));
    }
  }

  return results;
}
