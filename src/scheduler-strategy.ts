import type {
  AccountRuntimeStatus,
  AccountSchedulerStats,
  ScheduleDecision,
  ScheduleScoreBreakdown
} from "./types";

const CRITICAL_WEEKLY_LEFT_PERCENT = 5;
const LOW_WEEKLY_LEFT_PERCENT = 15;
const FIVE_HOUR_WASTE_HORIZON_SECONDS = 5 * 60 * 60;
const WEEKLY_WASTE_HORIZON_SECONDS = 7 * 24 * 60 * 60;
const RECENT_USE_RECOVERY_SECONDS = 30 * 60;

/**
 * 判断账号当前是否仅命中可忽略的短期本地熔断。
 *
 * 业务含义：
 * 1. 这类熔断通常来自瞬时请求失败、上游 5xx 或 token 短暂刷新失败。
 * 2. 当所有候选账号都只剩这类熔断时，调度器允许兜底尝试，避免把网络抖动误判成无账号可用。
 *
 * @param status 账号运行时状态；必须来自当前调度快照，不能混用历史状态。
 * @returns `true` 表示账号只存在可兜底忽略的短期熔断；否则返回 `false`。
 * @throws 无显式抛出。
 */
export function isSoftLocalBlocked(status: AccountRuntimeStatus): boolean {
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
 * 将账号额度百分比归一化成评分字段。
 *
 * 业务含义：
 * 1. 百分比越高代表剩余额度越多。
 * 2. 缺失值按中性值处理，避免因为远端 usage 暂时不可取就把账号完全打死。
 *
 * @param value 原始百分比；允许为空、缺失或非数字。
 * @returns 0 到 1 之间的评分；缺失或非法值返回 0.5。
 * @throws 无显式抛出。
 */
function normalizePercent(value: number | null | undefined): number {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, value / 100));
}

/**
 * 计算指定重置窗口的浪费紧迫度。
 *
 * 业务含义：
 * 1. 越接近重置，当前剩余额度越容易浪费。
 * 2. 超过观察窗口的重置时间只保留最低紧迫度，避免远期窗口主导当前调度。
 *
 * @param resetAt 重置时间，Unix 秒时间戳；缺失时代表无法确定重置时间。
 * @param horizonSeconds 观察窗口秒数；必须大于 0。
 * @param nowMs 当前时间毫秒数；调用方应在一次调度内传入同一个时间，保证评分一致。
 * @returns 0 到 1 之间的紧迫度；已过期或无效时间返回 0。
 * @throws 无显式抛出。
 */
function computeResetUrgency(resetAt: number | null, horizonSeconds: number, nowMs: number): number {
  if (!resetAt || horizonSeconds <= 0) {
    return 0;
  }

  const secondsUntilReset = resetAt - Math.floor(nowMs / 1000);
  if (secondsUntilReset <= 0) {
    return 0;
  }

  return Math.max(0.05, Math.min(1, (horizonSeconds - secondsUntilReset) / horizonSeconds));
}

/**
 * 计算 5 小时窗口的额度浪费压力。
 *
 * 业务含义：
 * 1. 5 小时剩余额度越多，且越接近重置，越应该尽快消费。
 * 2. 缺失重置时间时仅保留低权重余额信号，避免短窗口误导周窗口调度。
 *
 * @param status 账号运行时状态；必须包含当前 5 小时剩余额度与重置时间。
 * @param nowMs 当前时间毫秒数；用于统一本次调度的时间基准。
 * @returns 0 到 1 之间的 5 小时浪费压力评分。
 * @throws 无显式抛出。
 */
function computeFiveHourWastePressure(status: AccountRuntimeStatus, nowMs: number): number {
  const leftScore = normalizePercent(status.fiveHourLeftPercent);

  if (!status.fiveHourResetsAt) {
    return leftScore * 0.2;
  }

  return leftScore * computeResetUrgency(status.fiveHourResetsAt, FIVE_HOUR_WASTE_HORIZON_SECONDS, nowMs);
}

/**
 * 计算周窗口的额度浪费压力。
 *
 * 业务含义：
 * 1. 周窗口是更大的不可累积额度窗口，快重置且剩余额度多时应优先使用。
 * 2. 缺失周重置时间时仅保留低权重余额信号，避免未知数据压过明确窗口。
 *
 * @param status 账号运行时状态；必须包含当前周剩余额度与重置时间。
 * @param nowMs 当前时间毫秒数；用于统一本次调度的时间基准。
 * @returns 0 到 1 之间的周窗口浪费压力评分。
 * @throws 无显式抛出。
 */
function computeWeeklyWastePressure(status: AccountRuntimeStatus, nowMs: number): number {
  const leftScore = normalizePercent(status.weeklyLeftPercent);

  if (!status.weeklyResetsAt) {
    return leftScore * 0.1;
  }

  return leftScore * computeResetUrgency(status.weeklyResetsAt, WEEKLY_WASTE_HORIZON_SECONDS, nowMs);
}

/**
 * 计算 5 小时窗口调度时可借用的周额度承载系数。
 *
 * 业务含义：
 * 1. 周额度越少，越不应该为了短窗口快重置继续打该账号。
 * 2. 低于关键线时只保留极低短窗口权重，除非没有更健康的账号。
 *
 * @param status 账号运行时状态；必须包含当前周剩余额度。
 * @returns 0 到 1 之间的周额度承载系数。
 * @throws 无显式抛出。
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
 * 计算周额度健康度。
 *
 * 业务含义：
 * 1. 该分数不是“周额度多就绝对优先”，而是用于保护低周余额账号。
 * 2. 低于保护线时非线性降权，避免个别账号提前打穿周窗口。
 *
 * @param status 账号运行时状态；必须包含当前周剩余额度。
 * @returns 0 到 1 之间的周额度健康评分。
 * @throws 无显式抛出。
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
 * 计算账号使用分散度。
 *
 * 业务含义：
 * 1. 成功次数更少的账号应获得更高分，保证长期均匀。
 * 2. 最近刚使用的账号短时间内降权，减少连续命中同一账号。
 *
 * @param stats 当前账号的调度统计；缺失时按从未使用处理。
 * @param minSuccessCount 当前候选池中的最小成功次数。
 * @param maxSuccessCount 当前候选池中的最大成功次数。
 * @param nowMs 当前时间毫秒数；用于统一本次调度的时间基准。
 * @returns 0 到 1 之间的分散调度评分。
 * @throws 无显式抛出。
 */
function computeSpreadScore(
  stats: AccountSchedulerStats | undefined,
  minSuccessCount: number,
  maxSuccessCount: number,
  nowMs: number
): number {
  const current = stats ?? {
    success_count: 0,
    last_success_at: null
  };
  const countRange = Math.max(1, maxSuccessCount - minSuccessCount);
  const countScore = 1 - (current.success_count - minSuccessCount) / countRange;

  if (!current.last_success_at) {
    return Math.max(0, Math.min(1, countScore * 0.6 + 0.4));
  }

  const secondsSinceLastUse = (nowMs - new Date(current.last_success_at).getTime()) / 1000;
  const recencyScore = Math.max(0, Math.min(1, secondsSinceLastUse / RECENT_USE_RECOVERY_SECONDS));

  return Math.max(0, Math.min(1, countScore * 0.6 + recencyScore * 0.4));
}

/**
 * 计算单个账号的调度评分与可解释分解。
 *
 * 业务含义：
 * 1. 周窗口浪费压力是主权重。
 * 2. 5 小时窗口必须经过周额度承载系数修正。
 * 3. 周健康度、使用分散度与 5 小时余额只做辅助平衡。
 *
 * @param status 账号运行时状态；必须来自当前候选池。
 * @param stats 当前账号调度统计；缺失时按从未使用处理。
 * @param minSuccessCount 当前候选池中的最小成功次数。
 * @param maxSuccessCount 当前候选池中的最大成功次数。
 * @param nowMs 当前时间毫秒数；用于统一本次调度的时间基准。
 * @returns 调度评分与分项 breakdown。
 * @throws 无显式抛出。
 */
function computeScheduleScore(
  status: AccountRuntimeStatus,
  stats: AccountSchedulerStats | undefined,
  minSuccessCount: number,
  maxSuccessCount: number,
  nowMs: number
): { score: number; breakdown: ScheduleScoreBreakdown } {
  const weeklyWaste = computeWeeklyWastePressure(status, nowMs);
  const fiveHourWaste = computeFiveHourWastePressure(status, nowMs) * computeWeeklyCapacityFactor(status);
  const weeklyHealth = computeWeeklyHealthScore(status);
  const spread = computeSpreadScore(stats, minSuccessCount, maxSuccessCount, nowMs);
  const fiveHourLeft = normalizePercent(status.fiveHourLeftPercent);
  const breakdown = {
    weeklyWaste,
    fiveHourWaste,
    weeklyHealth,
    spread,
    fiveHourLeft
  };

  return {
    score:
      weeklyWaste * 0.6 +
      fiveHourWaste * 0.2 +
      weeklyHealth * 0.1 +
      spread * 0.07 +
      fiveHourLeft * 0.03,
    breakdown
  };
}

/**
 * 根据评分分解生成可读的调度原因。
 *
 * @param breakdown 调度评分分解；必须来自同一次评分。
 * @returns 当前账号最主要的调度原因。
 * @throws 无显式抛出。
 */
function resolveScheduleReason(breakdown: ScheduleScoreBreakdown): string {
  const entries = Object.entries(breakdown) as Array<[keyof ScheduleScoreBreakdown, number]>;
  const [primary] = entries.sort((left, right) => right[1] - left[1]);

  if (!primary) {
    return "综合评分最高";
  }

  return {
    weeklyWaste: "周额度快重置且剩余额度可用，优先避免周窗口浪费",
    fiveHourWaste: "周额度仍可承载，优先消耗快重置的 5 小时余额",
    weeklyHealth: "周额度更健康，避免低周余额账号提前打穿",
    spread: "近期使用更少，优先做多账号均匀分摊",
    fiveHourLeft: "5 小时剩余额度更高，作为兜底排序优势"
  }[primary[0]];
}

/**
 * 计算单个候选池中的调度决策列表。
 *
 * @param statuses 候选账号状态列表；调用方应已完成可用性过滤。
 * @param statsByAccountId 账号调度统计表；key 为账号 id。
 * @param nowMs 当前时间毫秒数；用于统一本次调度的时间基准。
 * @returns 按优先级从高到低排序后的调度决策。
 * @throws 无显式抛出。
 */
function rankPool(
  statuses: AccountRuntimeStatus[],
  statsByAccountId: Record<string, AccountSchedulerStats>,
  nowMs: number
): ScheduleDecision[] {
  const successCounts = statuses.map((item) => statsByAccountId[item.id]?.success_count ?? 0);
  const minSuccessCount = Math.min(...successCounts, 0);
  const maxSuccessCount = Math.max(...successCounts, 0);

  return statuses
    .map((status) => {
      const scored = computeScheduleScore(
        status,
        statsByAccountId[status.id],
        minSuccessCount,
        maxSuccessCount,
        nowMs
      );

      return {
        status,
        score: scored.score,
        breakdown: scored.breakdown,
        reason: resolveScheduleReason(scored.breakdown)
      };
    })
    .sort((left, right) => {
      const scoreDiff = right.score - left.score;
      if (Math.abs(scoreDiff) > Number.EPSILON) {
        return scoreDiff;
      }

      const leftResetWeight = left.status.fiveHourResetsAt ?? Number.MAX_SAFE_INTEGER;
      const rightResetWeight = right.status.fiveHourResetsAt ?? Number.MAX_SAFE_INTEGER;
      if (leftResetWeight !== rightResetWeight) {
        return leftResetWeight - rightResetWeight;
      }

      return (right.status.weeklyLeftPercent ?? -1) - (left.status.weeklyLeftPercent ?? -1);
    });
}

/**
 * 按防浪费、周额度保护与均匀使用策略排序候选账号。
 *
 * 业务含义：
 * 1. 先保护周额度低于关键线的账号；除非所有账号都低，否则后置。
 * 2. 主池内按周窗口浪费、受周额度约束的 5 小时浪费、健康度和使用分散度综合评分。
 * 3. 返回完整决策对象，便于 CLI、server 或测试解释“为什么选这个号”。
 *
 * @param statuses 候选账号状态列表；调用方应已完成启用、登录态、限额与熔断过滤。
 * @param statsByAccountId 账号调度统计表；key 为账号 id。
 * @param nowMs 当前时间毫秒数；默认使用当前系统时间。
 * @returns 按优先级从高到低排序后的调度决策。
 * @throws 无显式抛出。
 */
export function rankAccountStatuses(
  statuses: AccountRuntimeStatus[],
  statsByAccountId: Record<string, AccountSchedulerStats>,
  nowMs = Date.now()
): ScheduleDecision[] {
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

  return [
    ...rankPool(primaryPool, statsByAccountId, nowMs),
    ...rankPool(deferredPool, statsByAccountId, nowMs)
  ];
}
