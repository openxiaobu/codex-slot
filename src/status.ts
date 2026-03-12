import { loadConfig } from "./config";
import {
  hasCompleteCodexAuthState,
  resolvePrimaryRegistryAccount
} from "./account-store";
import { getAccountBlock, getUsageCache } from "./state";
import type { AccountRuntimeStatus } from "./types";

function computeLeftPercent(usedPercent: number | null | undefined): number | null {
  if (usedPercent === null || usedPercent === undefined || Number.isNaN(usedPercent)) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function isLimited(usedPercent: number | null, resetsAt: number | null): boolean {
  if (usedPercent === null || usedPercent < 100) {
    return false;
  }

  if (!resetsAt) {
    return true;
  }

  return resetsAt * 1000 > Date.now();
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function formatReset(unixSeconds: number | null): string {
  if (!unixSeconds) {
    return "-";
  }

  return new Date(unixSeconds * 1000).toLocaleString("zh-CN", {
    hour12: false
  });
}

function formatLimitStatus(label: string, resetAt: number | null): string {
  const remaining = formatRemainingDuration(resetAt);

  if (!remaining) {
    return label;
  }

  return `${label}(${remaining})`;
}

function normalizeBlockReason(reason: string | undefined): string {
  if (!reason) {
    return "blocked";
  }

  if (reason === "five_hour_limited") {
    return "5h_limited";
  }

  return reason;
}

/**
 * 将剩余秒数格式化为紧凑的人类可读文本，便于在状态列中展示熔断剩余时间。
 *
 * @param unixSeconds 熔断截止时间，Unix 秒时间戳。
 * @returns 格式化后的剩余时长；当时间为空或已过期时返回 `null`。
 */
function formatRemainingDuration(unixSeconds: number | null): string | null {
  if (!unixSeconds) {
    return null;
  }

  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  if (diffSeconds <= 0) {
    return null;
  }

  const hours = Math.floor(diffSeconds / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }

  return `${seconds}s`;
}

/**
 * 将本地熔断原因与剩余时间格式化为更直观的状态文本。
 *
 * @param reason 熔断原因。
 * @param until 熔断截止时间，Unix 秒时间戳。
 * @returns 适合在终端表格中展示的状态文本。
 */
function formatBlockedStatus(reason: string | undefined, until: number | null | undefined): string {
  const label = normalizeBlockReason(reason);
  const remaining = formatRemainingDuration(until ?? null);

  if (!remaining) {
    return label;
  }

  return `${label}(${remaining})`;
}

/**
 * 汇总所有受管账号的运行状态，供状态展示与调度复用。
 *
 * @returns 所有账号的运行时状态列表。
 */
export function collectAccountStatuses(): AccountRuntimeStatus[] {
  const config = loadConfig();

  return config.accounts.map((account) => {
    const exists = hasCompleteCodexAuthState(account.codex_home);
    const primary = exists ? resolvePrimaryRegistryAccount(account.codex_home) : null;
    const usageCache = getUsageCache(account.id);
    const activeEmail = usageCache?.email ?? primary?.email ?? account.email;
    const fiveHourUsed = usageCache?.fiveHourUsedPercent ?? null;
    const fiveHourReset = usageCache?.fiveHourResetAt ?? null;
    const weeklyUsed = usageCache?.weeklyUsedPercent ?? null;
    const weeklyReset = usageCache?.weeklyResetAt ?? null;
    const fiveHourLeftPercent = computeLeftPercent(fiveHourUsed);
    const weeklyLeftPercent = computeLeftPercent(weeklyUsed);
    const isFiveHourLimited = isLimited(fiveHourUsed, fiveHourReset);
    const isWeeklyLimited = isLimited(weeklyUsed, weeklyReset);
    const localBlock = getAccountBlock(account.id);
    const localBlocked = localBlock?.until != null ? localBlock.until * 1000 > Date.now() : false;

    return {
      id: account.id,
      name: account.name,
      email: activeEmail,
      enabled: account.enabled,
      exists,
      plan: usageCache?.plan ?? primary?.plan ?? "-",
      fiveHourLeftPercent,
      fiveHourResetsAt: fiveHourReset,
      weeklyLeftPercent,
      weeklyResetsAt: weeklyReset,
      isFiveHourLimited,
      isWeeklyLimited,
      localBlockReason: localBlock?.reason,
      localBlockUntil: localBlock?.until ?? null,
      isAvailable:
        account.enabled &&
        exists &&
        !isFiveHourLimited &&
        !isWeeklyLimited &&
        !localBlocked,
      sourcePath: account.codex_home
    };
  });
}

/**
 * 将账号状态渲染为适合终端输出的表格文本。
 *
 * @param statuses 待展示的账号状态列表。
 * @returns 可直接打印到终端的表格字符串。
 */
export function renderStatusTable(statuses: AccountRuntimeStatus[]): string {
  const rows = [
    ["NAME", "EMAIL", "PLAN", "5H_LEFT", "5H_RESET", "WEEK_LEFT", "WEEK_RESET", "STATUS"]
  ];

  for (const item of statuses) {
    let status = "missing";

    if (item.exists) {
      if (!item.enabled) {
        status = "disabled";
      } else if (item.localBlockUntil && item.localBlockUntil * 1000 > Date.now()) {
        status = formatBlockedStatus(item.localBlockReason, item.localBlockUntil);
      } else if (item.isWeeklyLimited) {
        status = formatLimitStatus("weekly_limited", item.weeklyResetsAt);
      } else if (item.isFiveHourLimited) {
        status = formatLimitStatus("5h_limited", item.fiveHourResetsAt);
      } else if (item.isAvailable) {
        status = "available";
      } else {
        status = "unknown";
      }
    }

    rows.push([
      item.name,
      item.email ?? "-",
      item.plan,
      formatPercent(item.fiveHourLeftPercent),
      formatReset(item.fiveHourResetsAt),
      formatPercent(item.weeklyLeftPercent),
      formatReset(item.weeklyResetsAt),
      status
    ]);
  }

  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length))
  );

  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  "))
    .join("\n");
}
