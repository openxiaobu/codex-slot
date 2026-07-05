import type { AccountBlockState, UsageRefreshResult } from "./types";
import { clearAccountBlock, getAccountBlock, setAccountBlock } from "./state";

export const FIVE_HOUR_QUOTA_BLOCK_REASONS = new Set(["5h_limited", "five_hour_limited"]);
export const WEEKLY_QUOTA_BLOCK_REASONS = new Set(["weekly_limited"]);

/**
 * 根据上游 usage 的已用百分比与重置时间，判断该窗口是否仍处于满额限制期。
 */
export function isUsageWindowLimited(
  usedPercent: number | null | undefined,
  resetsAt: number | null | undefined,
  nowMs: number = Date.now()
): boolean {
  if (usedPercent === null || usedPercent === undefined || usedPercent < 100) {
    return false;
  }

  if (!resetsAt) {
    return true;
  }

  return resetsAt * 1000 > nowMs;
}

export function computeLeftPercent(usedPercent: number | null | undefined): number | null {
  if (usedPercent === null || usedPercent === undefined || Number.isNaN(usedPercent)) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - usedPercent));
}

export function isActiveQuotaBlock(
  block: AccountBlockState | null | undefined,
  kind: "fiveHour" | "weekly",
  nowMs: number = Date.now()
): boolean {
  if (!block?.until || block.until * 1000 <= nowMs) {
    return false;
  }

  const reasons = kind === "fiveHour" ? FIVE_HOUR_QUOTA_BLOCK_REASONS : WEEKLY_QUOTA_BLOCK_REASONS;
  return reasons.has(block.reason);
}

export function isQuotaBlockReason(reason: string | undefined): boolean {
  if (!reason) {
    return false;
  }

  return FIVE_HOUR_QUOTA_BLOCK_REASONS.has(reason) || WEEKLY_QUOTA_BLOCK_REASONS.has(reason);
}

export interface EffectiveQuotaStatus {
  fiveHourLeftPercent: number | null;
  weeklyLeftPercent: number | null;
  isFiveHourLimited: boolean;
  isWeeklyLimited: boolean;
  localBlocked: boolean;
}

/**
 * 合并上游 usage 缓存与本地额度熔断，得到展示与调度共用的有效额度状态。
 *
 * 规则：
 * 1. 周限制优先于 5 小时限制。
 * 2. API 满额或本地额度熔断任一成立，即视为对应窗口受限。
 * 3. 受限时剩余列固定展示 0%，避免「100% 剩余 + 熔断倒计时」的矛盾读数。
 */
export function resolveEffectiveQuotaStatus(
  fiveHourUsed: number | null | undefined,
  fiveHourReset: number | null | undefined,
  weeklyUsed: number | null | undefined,
  weeklyReset: number | null | undefined,
  localBlock: AccountBlockState | null | undefined,
  nowMs: number = Date.now()
): EffectiveQuotaStatus {
  const apiFiveHourLimited = isUsageWindowLimited(fiveHourUsed, fiveHourReset, nowMs);
  const apiWeeklyLimited = isUsageWindowLimited(weeklyUsed, weeklyReset, nowMs);
  const localFiveHourBlocked = isActiveQuotaBlock(localBlock, "fiveHour", nowMs);
  const localWeeklyBlocked = isActiveQuotaBlock(localBlock, "weekly", nowMs);
  const localBlocked = localBlock?.until != null ? localBlock.until * 1000 > nowMs : false;

  const isWeeklyLimited = apiWeeklyLimited || localWeeklyBlocked;
  const isFiveHourLimited = !isWeeklyLimited && (apiFiveHourLimited || localFiveHourBlocked);

  let fiveHourLeftPercent = computeLeftPercent(fiveHourUsed);
  let weeklyLeftPercent = computeLeftPercent(weeklyUsed);

  if (isFiveHourLimited) {
    fiveHourLeftPercent = 0;
  }

  if (isWeeklyLimited) {
    weeklyLeftPercent = 0;
  }

  return {
    fiveHourLeftPercent,
    weeklyLeftPercent,
    isFiveHourLimited,
    isWeeklyLimited,
    localBlocked
  };
}

/**
 * 额度刷新成功后，用最新上游数据校正本地额度熔断，避免 API 已恢复但 block 仍残留。
 */
export function reconcileQuotaBlockAfterUsageRefresh(
  accountId: string,
  usage: UsageRefreshResult,
  nowMs: number = Date.now()
): void {
  const block = getAccountBlock(accountId);
  const apiWeeklyLimited = isUsageWindowLimited(usage.weeklyUsedPercent, usage.weeklyResetAt, nowMs);
  const apiFiveHourLimited = isUsageWindowLimited(usage.fiveHourUsedPercent, usage.fiveHourResetAt, nowMs);

  if (apiWeeklyLimited && usage.weeklyResetAt) {
    setAccountBlock(accountId, usage.weeklyResetAt, "weekly_limited");
    return;
  }

  if (apiFiveHourLimited && usage.fiveHourResetAt) {
    setAccountBlock(accountId, usage.fiveHourResetAt, "5h_limited");
    return;
  }

  if (block && isQuotaBlockReason(block.reason)) {
    clearAccountBlock(accountId);
  }
}
