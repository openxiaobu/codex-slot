import { request } from "undici";
import {
  findManagedAccount,
  readAuthFile,
  resolvePrimaryRegistryAccount,
  writeAuthFile
} from "./account-store";
import { loadConfig } from "./config";
import { setUsageCache } from "./state";
import type {
  CodexAuthFile,
  UsageRefreshResult
} from "./types";

interface WhamUsageResponse {
  plan_type?: string | null;
  rate_limit?: {
    limit_reached?: boolean;
    primary_window?: {
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
      limit_window_seconds?: number;
    };
    secondary_window?: {
      used_percent?: number;
      reset_at?: number;
      reset_after_seconds?: number;
      limit_window_seconds?: number;
    };
  };
  credits?: {
    has_credits?: boolean;
    unlimited?: boolean;
    balance?: number | null;
  };
}

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
 * 使用 refresh token 刷新指定账号的 access token，并回写到账号目录。
 *
 * @param accountId 账号标识。
 * @returns 最新认证信息。
 * @throws 当账号不存在、缺少 refresh_token 或刷新失败时抛出错误。
 */
export async function refreshAccountTokens(accountId: string): Promise<CodexAuthFile> {
  const config = loadConfig();
  const account = findManagedAccount(accountId);

  if (!account) {
    throw new Error(`未找到账号 ${accountId}`);
  }

  const auth = readAuthFile(account.codex_home);
  const refreshToken = auth?.tokens?.refresh_token;

  if (!refreshToken) {
    throw new Error(`账号 ${accountId} 缺少 refresh_token`);
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
    const errorText = await response.body.text();
    throw new Error(`刷新 token 失败: HTTP ${response.statusCode} ${errorText}`);
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

  writeAuthFile(account.codex_home, nextAuth);
  return nextAuth;
}

/**
 * 查询单个账号的最新额度信息，并写入 codexl 自己的 usage 缓存。
 *
 * @param accountId 账号标识。
 * @returns 刷新后的额度摘要。
 * @throws 当账号不存在、未登录或远端请求失败时抛出错误。
 */
export async function refreshAccountUsage(accountId: string): Promise<UsageRefreshResult> {
  const account = findManagedAccount(accountId);

  if (!account) {
    throw new Error(`未找到账号 ${accountId}`);
  }

  const auth = readAuthFile(account.codex_home);
  const accessToken = auth?.tokens?.access_token;
  const accountIdHeader = auth?.tokens?.account_id;

  if (!accessToken) {
    throw new Error(`账号 ${accountId} 缺少 access_token`);
  }

  const response = await request("https://chatgpt.com/backend-api/wham/usage", {
    method: "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "codexl/0.1.0",
      ...(accountIdHeader ? { "chatgpt-account-id": accountIdHeader } : {})
    }
  });

  if (response.statusCode === 401) {
    await refreshAccountTokens(accountId);
    return await refreshAccountUsage(accountId);
  }

  if (response.statusCode >= 400) {
    const errorText = await response.body.text();
    throw new Error(`刷新额度失败: HTTP ${response.statusCode} ${errorText}`);
  }

  const payload = (await response.body.json()) as WhamUsageResponse;
  const primary = resolvePrimaryRegistryAccount(account.codex_home);
  const email = primary?.email ?? account.email ?? undefined;
  const plan = payload.plan_type ?? primary?.plan ?? "-";
  const result: UsageRefreshResult = {
    accountId: account.id,
    email,
    plan,
    fiveHourUsedPercent: payload.rate_limit?.primary_window?.used_percent ?? null,
    fiveHourResetAt: normalizeResetAt(
      payload.rate_limit?.primary_window?.reset_at,
      payload.rate_limit?.primary_window?.reset_after_seconds
    ),
    weeklyUsedPercent: payload.rate_limit?.secondary_window?.used_percent ?? null,
    weeklyResetAt: normalizeResetAt(
      payload.rate_limit?.secondary_window?.reset_at,
      payload.rate_limit?.secondary_window?.reset_after_seconds
    )
  };

  setUsageCache(result);
  return result;
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
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[refresh] ${account.id} 失败: ${message}`);
    }
  }

  return results;
}
