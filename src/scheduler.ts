import { loadConfig } from "./config";
import { rankAccountStatuses, isSoftLocalBlocked } from "./scheduler-strategy";
import { collectAccountStatuses } from "./status";
import { loadSchedulerStatsSnapshot } from "./state-repository";
import type {
  AccountRuntimeStatus,
  AccountSchedulerStats,
  ManagedAccount,
  SchedulerPick
} from "./types";

interface SchedulerContext {
  accounts: ManagedAccount[];
  statuses: AccountRuntimeStatus[];
  schedulerStats: Record<string, AccountSchedulerStats>;
  nowMs: number;
}

/**
 * 构建一次账号调度所需的完整上下文快照。
 *
 * 业务含义：
 * 1. 调度过程中所有配置、状态与统计都来自同一次快照，避免评分时反复读取文件。
 * 2. 该函数是调度应用层边界，负责把外部存储数据转成纯策略可消费的输入。
 *
 * @returns 调度上下文，包含账号配置、运行状态、使用统计与统一时间基准。
 * @throws 当配置、状态或调度统计读取失败时透传底层异常。
 */
function buildSchedulerContext(): SchedulerContext {
  const config = loadConfig();

  return {
    accounts: config.accounts,
    statuses: collectAccountStatuses(),
    schedulerStats: loadSchedulerStatsSnapshot(),
    nowMs: Date.now()
  };
}

/**
 * 过滤当前可直接参与调度的账号状态。
 *
 * 业务含义：
 * 1. 只保留已启用、登录态完整、未触发刷新错误、未限额、未本地熔断的账号。
 * 2. 具体排序不在这里处理，排序交给纯调度策略。
 *
 * @param statuses 当前账号运行状态快照。
 * @returns 可直接调度的账号状态列表。
 * @throws 无显式抛出。
 */
function resolveAvailableStatuses(statuses: AccountRuntimeStatus[]): AccountRuntimeStatus[] {
  return statuses.filter((item) => item.isAvailable);
}

/**
 * 过滤软熔断兜底候选账号。
 *
 * 业务含义：
 * 1. 当所有未限额账号都只剩短期软熔断时，允许这些账号进入兜底调度。
 * 2. 硬限额、禁用、登录态缺失仍不会进入兜底池。
 *
 * @param statuses 当前账号运行状态快照。
 * @returns 可用于软熔断兜底的账号状态列表；不满足兜底条件时返回空列表。
 * @throws 无显式抛出。
 */
function resolveSoftFallbackStatuses(statuses: AccountRuntimeStatus[]): AccountRuntimeStatus[] {
  const eligible = statuses.filter(
    (item) => item.enabled && item.exists && !item.isFiveHourLimited && !item.isWeeklyLimited
  );

  if (eligible.length === 0 || !eligible.every(isSoftLocalBlocked)) {
    return [];
  }

  return eligible;
}

/**
 * 将纯调度决策映射为包含账号配置的调度结果。
 *
 * 业务含义：
 * 1. 调度策略只认识运行状态，不直接依赖配置存储。
 * 2. 应用层在这里补齐账号 HOME、名称等后续代理链路需要的配置字段。
 *
 * @param decisions 纯策略返回的调度决策列表。
 * @param accountMap 账号配置索引；key 为账号 id。
 * @param fallback 是否来自软熔断兜底调度。
 * @returns 可供代理或 CLI 使用的账号候选列表。
 * @throws 无显式抛出。
 */
function mapDecisionsToPicks(
  decisions: ReturnType<typeof rankAccountStatuses>,
  accountMap: Map<string, ManagedAccount>,
  fallback: boolean
): SchedulerPick[] {
  return decisions
    .map((decision) => {
      const account = accountMap.get(decision.status.id);
      if (!account) {
        return null;
      }

      const pick: SchedulerPick = {
        account,
        status: decision.status,
        reason: fallback
          ? `当前仅剩软熔断账号，兜底尝试；${decision.reason}`
          : decision.reason,
        score: decision.score,
        breakdown: decision.breakdown
      };

      return pick;
    })
    .filter((item): item is SchedulerPick => item !== null);
}

/**
 * 选择当前最适合激活的账号。
 *
 * 业务规则：
 * 1. 仅在账号启用且存在完整凭据时参与调度。
 * 2. 优先避免周窗口额度浪费，再在周额度健康时消耗 5 小时窗口余额。
 * 3. 同等条件下根据本地成功使用统计做均匀分摊。
 *
 * @returns 调度结果；若没有可用账号则返回 `null`。
 * @throws 当配置、状态或调度统计读取失败时透传底层异常。
 */
export function pickBestAccount(): SchedulerPick | null {
  return listCandidateAccounts()[0] ?? null;
}

/**
 * 返回按优先级排序后的可用账号列表，供代理重试链路使用。
 *
 * @returns 候选账号列表，已按优先级从高到低排序。
 * @throws 当配置、状态或调度统计读取失败时透传底层异常。
 */
export function listCandidateAccounts(): SchedulerPick[] {
  const context = buildSchedulerContext();
  const accountMap = new Map<string, ManagedAccount>(context.accounts.map((item) => [item.id, item]));
  const availableStatuses = resolveAvailableStatuses(context.statuses);

  if (availableStatuses.length > 0) {
    return mapDecisionsToPicks(
      rankAccountStatuses(availableStatuses, context.schedulerStats, context.nowMs),
      accountMap,
      false
    );
  }

  const fallbackStatuses = resolveSoftFallbackStatuses(context.statuses);
  return mapDecisionsToPicks(
    rankAccountStatuses(fallbackStatuses, context.schedulerStats, context.nowMs),
    accountMap,
    true
  );
}
