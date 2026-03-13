import { loadConfig, saveConfig } from "../config";
import { pickBestAccount } from "../scheduler";
import {
  collectAccountStatuses,
  summarizeAccountStatuses
} from "../status";
import { refreshAllAccountUsage } from "../usage-sync";
import type { AccountRuntimeStatus } from "../types";

export interface StatusSnapshot {
  statuses: AccountRuntimeStatus[];
  selectedName: string | null;
  summary: {
    available: number;
    fiveHourLimited: number;
    weeklyLimited: number;
  };
}

/**
 * 刷新全部账号额度并返回最新状态快照。
 *
 * @returns Promise，成功时返回状态列表、摘要和当前选中账号名。
 * @throws 当额度刷新失败时透传底层异常。
 */
export async function refreshStatusSnapshot(): Promise<StatusSnapshot> {
  await refreshAllAccountUsage();
  return getStatusSnapshot();
}

/**
 * 读取当前状态快照但不主动刷新远端额度。
 *
 * @returns 当前状态列表、摘要和当前选中账号名。
 * @throws 当本地配置或状态读取失败时抛出异常。
 */
export function getStatusSnapshot(): StatusSnapshot {
  const statuses = collectAccountStatuses();
  const selected = pickBestAccount();

  return {
    statuses,
    selectedName: selected?.account.name ?? null,
    summary: summarizeAccountStatuses(statuses)
  };
}

/**
 * 将交互式界面中的启用状态修改写回配置文件。
 *
 * @param accounts 用户在交互界面中调整后的账号数组。
 * @returns 无返回值。
 * @throws 当配置写入失败时抛出异常。
 */
export function persistAccountEnabledState(
  accounts: Array<{ id: string; enabled: boolean }>
): void {
  const latest = loadConfig();

  for (const account of accounts) {
    const index = latest.accounts.findIndex((item) => item.id === account.id);
    if (index >= 0) {
      latest.accounts[index].enabled = account.enabled;
    }
  }

  saveConfig(latest);
}
