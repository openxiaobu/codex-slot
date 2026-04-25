import { loadState, updateState } from "./state";
import type { AccountSchedulerStats } from "./types";

/**
 * 读取全部账号的调度统计快照。
 *
 * 业务含义：
 * 1. 调度器一次调度只读取一次统计，避免评分过程中反复触碰 state 文件。
 * 2. 返回值是普通对象快照，调用方不得把它当作可自动持久化的引用。
 *
 * @returns 账号调度统计表；key 为账号 id。
 * @throws 当 state 文件读取或 JSON 解析失败时透传底层异常。
 */
export function loadSchedulerStatsSnapshot(): Record<string, AccountSchedulerStats> {
  return loadState().scheduler_stats;
}

/**
 * 记录指定账号完成一次成功代理请求。
 *
 * 业务含义：
 * 1. 该统计只服务于调度均匀分摊，不参与额度判断。
 * 2. 每次成功上游响应后递增成功次数并刷新最近成功时间。
 *
 * @param accountId 账号标识；必须是当前配置中的受管账号 id。
 * @returns 无返回值。
 * @throws 当 state 文件写入失败时透传底层异常。
 */
export function recordAccountScheduleSuccess(accountId: string): void {
  updateState((state) => {
    const current = state.scheduler_stats[accountId] ?? {
      success_count: 0,
      last_success_at: null
    };

    state.scheduler_stats[accountId] = {
      success_count: current.success_count + 1,
      last_success_at: new Date().toISOString()
    };
  });
}
