import { loadConfig } from "./config";
import { collectAccountStatuses } from "./status";
import { getSchedulerStats } from "./state";
import type { AccountRuntimeStatus, ManagedAccount, SchedulerPick } from "./types";

const CRITICAL_WEEKLY_LEFT_PERCENT = 5;
const LOW_WEEKLY_LEFT_PERCENT = 15;
const WASTE_HORIZON_SECONDS = 5 * 60 * 60;
const WEEKLY_WASTE_HORIZON_SECONDS = 7 * 24 * 60 * 60;
const RECENT_USE_RECOVERY_SECONDS = 30 * 60;

function nextResetWeight(resetAt: number | null): number {
  if (!resetAt) {
    return Number.MAX_SAFE_INTEGER;
  }

  const diff = resetAt * 1000 - Date.now();
  return diff > 0 ? diff : Number.MAX_SAFE_INTEGER;
}

/**
 * 判断账号当前是否仅命中可忽略的短期本地熔断。
 *
 * 这类熔断通常由瞬时网络抖动、上游 5xx 或短暂 token 刷新失败触发，
 * 当系统只剩一个可调度账号时，不应因此立刻把它排除掉。
 *
 * @param status 账号运行时状态。
 * @returns `true` 表示仅存在可回退的短期本地熔断；否则返回 `false`。
 */
function isSoftLocalBlocked(status: AccountRuntimeStatus): boolean {
  if (!status.localBlockUntil || status.localBlockUntil * 1000 <= Date.now()) {
    return false;
  }

  return [
    "request_failed",
    "upstream_5xx",
    "temporary_5m_limit",
    "token_refresh_failed"
  ].includes(status.localBlockReason ?? "");
}

/**
 * 将百分比字段归一化为 0 到 1 的评分，缺失时按中性值处理。
 *
 * @param value 原始百分比。
 * @returns 归一化后的评分。
 */
function normalizePercent(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value / 100));
}

/**
 * 计算 5 小时窗口的余额浪费压力，越接近重置且剩余额度越多分数越高。
 *
 * @param status 账号运行时状态。
 * @returns 0 到 1 之间的浪费压力评分。
 */
function computeFiveHourWastePressure(status: AccountRuntimeStatus): number {
  const leftScore = normalizePercent(status.fiveHourLeftPercent);

  if (!status.fiveHourResetsAt) {
    return leftScore * 0.2;
  }

  const secondsUntilReset = status.fiveHourResetsAt - Math.floor(Date.now() / 1000);
  if (secondsUntilReset <= 0) {
    return 0;
  }

  const urgency = Math.max(0.1, Math.min(1, (WASTE_HORIZON_SECONDS - secondsUntilReset) / WASTE_HORIZON_SECONDS));
  return leftScore * urgency;
}

/**
 * 计算周窗口的余额浪费压力，周额度越接近重置且剩余越多分数越高。
 *
 * @param status 账号运行时状态。
 * @returns 0 到 1 之间的周窗口浪费压力评分。
 */
function computeWeeklyWastePressure(status: AccountRuntimeStatus): number {
  const leftScore = normalizePercent(status.weeklyLeftPercent);

  if (!status.weeklyResetsAt) {
    return leftScore * 0.1;
  }

  const secondsUntilReset = status.weeklyResetsAt - Math.floor(Date.now() / 1000);
  if (secondsUntilReset <= 0) {
    return 0;
  }

  const urgency = Math.max(
    0.05,
    Math.min(1, (WEEKLY_WASTE_HORIZON_SECONDS - secondsUntilReset) / WEEKLY_WASTE_HORIZON_SECONDS)
  );
  return leftScore * urgency;
}

/**
 * 计算 5 小时窗口调度时可借用的周额度承载系数，周余额越低越抑制短窗口冲动。
 *
 * @param status 账号运行时状态。
 * @returns 0 到 1 之间的周额度承载系数。
 */
function computeWeeklyCapacityFactor(status: AccountRuntimeStatus): number {
  const weeklyLeft = status.weeklyLeftPercent;

  if (weeklyLeft === null || weeklyLeft === undefined || Number.isNaN(weeklyLeft)) {
    return 0.7;
  }

  if (weeklyLeft <= CRITICAL_WEEKLY_LEFT_PERCENT) {
    return 0.05;
  }

  if (weeklyLeft < LOW_WEEKLY_LEFT_PERCENT) {
    return 0.2;
  }

  if (weeklyLeft < 30) {
    return 0.55;
  }

  return 1;
}

/**
 * 计算周额度健康度，低于保护线时非线性降权，避免个别账号过早打穿周窗口。
 *
 * @param status 账号运行时状态。
 * @returns 0 到 1 之间的周额度健康评分。
 */
function computeWeeklyHealthScore(status: AccountRuntimeStatus): number {
  const weeklyLeft = status.weeklyLeftPercent;

  if (weeklyLeft === null || weeklyLeft === undefined || Number.isNaN(weeklyLeft)) {
    return 0.5;
  }

  if (weeklyLeft <= CRITICAL_WEEKLY_LEFT_PERCENT) {
    return 0;
  }

  if (weeklyLeft < LOW_WEEKLY_LEFT_PERCENT) {
    return normalizePercent(weeklyLeft) * 0.35;
  }

  return normalizePercent(weeklyLeft);
}

/**
 * 计算账号使用分散度，成功次数更少且最近未使用的账号分数更高。
 *
 * @param status 账号运行时状态。
 * @param minSuccessCount 当前候选账号中的最小成功次数。
 * @param maxSuccessCount 当前候选账号中的最大成功次数。
 * @returns 0 到 1 之间的分散调度评分。
 */
function computeSpreadScore(
  status: AccountRuntimeStatus,
  minSuccessCount: number,
  maxSuccessCount: number
): number {
  const stats = getSchedulerStats(status.id);
  const countRange = Math.max(1, maxSuccessCount - minSuccessCount);
  const countScore = 1 - (stats.success_count - minSuccessCount) / countRange;

  if (!stats.last_success_at) {
    return Math.max(0, Math.min(1, countScore * 0.6 + 0.4));
  }

  const secondsSinceLastUse = (Date.now() - new Date(stats.last_success_at).getTime()) / 1000;
  const recencyScore = Math.max(0, Math.min(1, secondsSinceLastUse / RECENT_USE_RECOVERY_SECONDS));

  return Math.max(0, Math.min(1, countScore * 0.6 + recencyScore * 0.4));
}

/**
 * 计算候选账号的综合调度评分。
 *
 * 业务含义：
 * 1. 周窗口承担主防浪费压力，快重置且余额多的账号优先。
 * 2. 5 小时窗口在周额度健康时参与放大，低周余额会抑制短窗口冲动。
 * 3. 本地成功使用历史用于打散连续请求，降低单账号被持续命中的概率。
 *
 * @param status 账号运行时状态。
 * @param minSuccessCount 当前候选账号中的最小成功次数。
 * @param maxSuccessCount 当前候选账号中的最大成功次数。
 * @returns 综合评分，分数越高越优先。
 */
function computeScheduleScore(
  status: AccountRuntimeStatus,
  minSuccessCount: number,
  maxSuccessCount: number
): number {
  const weeklyWasteScore = computeWeeklyWastePressure(status);
  const fiveHourWasteScore = computeFiveHourWastePressure(status) * computeWeeklyCapacityFactor(status);
  const weeklyHealthScore = computeWeeklyHealthScore(status);
  const fiveHourLeftScore = normalizePercent(status.fiveHourLeftPercent);
  const spreadScore = computeSpreadScore(status, minSuccessCount, maxSuccessCount);

  return (
    weeklyWasteScore * 0.5 +
    fiveHourWasteScore * 0.25 +
    weeklyHealthScore * 0.1 +
    spreadScore * 0.1 +
    fiveHourLeftScore * 0.05
  );
}

/**
 * 对候选账号按防浪费、周额度保护与均匀使用策略排序。
 *
 * @param statuses 待排序的账号状态列表。
 * @returns 排序后的账号状态列表，优先返回更适合尝试的账号。
 */
function rankEligibleStatuses(statuses: AccountRuntimeStatus[]): AccountRuntimeStatus[] {
  const primaryPool = statuses.some(
    (item) =>
      item.weeklyLeftPercent === null ||
      item.weeklyLeftPercent === undefined ||
      item.weeklyLeftPercent > CRITICAL_WEEKLY_LEFT_PERCENT
  )
    ? statuses.filter(
        (item) =>
          item.weeklyLeftPercent === null ||
          item.weeklyLeftPercent === undefined ||
          item.weeklyLeftPercent > CRITICAL_WEEKLY_LEFT_PERCENT
      )
    : statuses;
  const deferredPool = statuses.filter((item) => !primaryPool.includes(item));
  const rankPool = (items: AccountRuntimeStatus[]) => {
    const successCounts = items.map((item) => getSchedulerStats(item.id).success_count);
    const minSuccessCount = Math.min(...successCounts, 0);
    const maxSuccessCount = Math.max(...successCounts, 0);

    return [...items].sort((left, right) => {
      const scoreDiff =
        computeScheduleScore(right, minSuccessCount, maxSuccessCount) -
        computeScheduleScore(left, minSuccessCount, maxSuccessCount);
      if (Math.abs(scoreDiff) > Number.EPSILON) {
        return scoreDiff;
      }

      const resetDiff = nextResetWeight(left.fiveHourResetsAt) - nextResetWeight(right.fiveHourResetsAt);
      if (resetDiff !== 0) {
        return resetDiff;
      }

      return (right.weeklyLeftPercent ?? -1) - (left.weeklyLeftPercent ?? -1);
    });
  };

  return [...rankPool(primaryPool), ...rankPool(deferredPool)];
}

/**
 * 选择当前最适合激活的账号。
 *
 * 业务规则：
 * 1. 仅在账号启用且存在凭据时参与调度。
 * 2. 优先选择当前 5 小时和周窗口都未受限的账号。
 * 3. 在多个可用账号间，优先选择 5 小时剩余额度更高的账号。
 *
 * @returns 调度结果；若没有可用账号则返回 `null`。
 */
export function pickBestAccount(): SchedulerPick | null {
  return listCandidateAccounts()[0] ?? null;
}

/**
 * 返回按优先级排序后的可用账号列表，供代理重试链路使用。
 *
 * @returns 候选账号列表，已按优先级从高到低排序。
 */
export function listCandidateAccounts(): SchedulerPick[] {
  const config = loadConfig();
  const statuses = collectAccountStatuses();
  const accountMap = new Map<string, ManagedAccount>(config.accounts.map((item) => [item.id, item]));
  const eligible = statuses.filter(
    (item) => item.enabled && item.exists && !item.isFiveHourLimited && !item.isWeeklyLimited
  );

  const available = rankEligibleStatuses(statuses.filter((item) => item.isAvailable));

  const ranked = available.length > 0 ? available : [];

  // 当所有未限额账号都只命中短期本地熔断时，仍允许继续兜底尝试，避免把网络抖动误判成“无可用账号”。
  if (ranked.length === 0 && eligible.length > 0 && eligible.every(isSoftLocalBlocked)) {
    ranked.push(...rankEligibleStatuses(eligible));
  }

  return ranked
    .map((winner) => {
      const account = accountMap.get(winner.id);
      if (!account) {
        return null;
      }

      return {
        account,
        status: winner,
        reason:
          winner.isAvailable
            ? "优先选择 5 小时窗口剩余额度最高且当前可用的账号"
            : "当前仅剩一个可调度账号，忽略短期本地熔断后继续兜底尝试"
      };
    })
    .filter((item): item is SchedulerPick => item !== null);
}
