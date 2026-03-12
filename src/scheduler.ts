import { loadConfig } from "./config";
import { collectAccountStatuses } from "./status";
import type { AccountRuntimeStatus, ManagedAccount, SchedulerPick } from "./types";

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

  const available = statuses
    .filter((item) => item.isAvailable)
    .sort((left, right) => {
      const fiveHourDiff = (right.fiveHourLeftPercent ?? -1) - (left.fiveHourLeftPercent ?? -1);
      if (fiveHourDiff !== 0) {
        return fiveHourDiff;
      }

      const weeklyDiff = (right.weeklyLeftPercent ?? -1) - (left.weeklyLeftPercent ?? -1);
      if (weeklyDiff !== 0) {
        return weeklyDiff;
      }

      return nextResetWeight(left.fiveHourResetsAt) - nextResetWeight(right.fiveHourResetsAt);
    });

  const ranked = available.length > 0 ? available : [];

  // 当系统只剩一个具备真实凭据且未命中额度限制的账号时，允许忽略短期本地熔断继续兜底尝试。
  if (ranked.length === 0 && eligible.length === 1 && isSoftLocalBlocked(eligible[0])) {
    ranked.push(eligible[0]);
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
