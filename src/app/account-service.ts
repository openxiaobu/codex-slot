import fs from "node:fs";
import { cloneCodexAuthState, registerManagedAccount, removeManagedAccount } from "../account-store";
import { expandHome, getManagedHome, getUserHomeDir, loadConfig, saveConfig } from "../config";
import { loginManagedAccount } from "../login";
import { updateState } from "../state";
import { bi } from "../text";
import type { ManagedAccount } from "../types";

/**
 * 导入指定 HOME 下的官方 Codex 登录态到受管槽位。
 *
 * @param slotName 本地槽位名。
 * @param codexHome 可选源 HOME；未传时默认当前用户 HOME。
 * @returns 导入后的受管账号配置与源路径信息。
 * @throws 当源目录缺少必要认证文件或写入失败时抛出异常。
 */
export function importAccount(
  slotName: string,
  codexHome?: string
): { account: ManagedAccount; sourceHome: string } {
  const sourceHome = codexHome ? expandHome(codexHome) : getUserHomeDir();
  const managedHome = getManagedHome(slotName);

  cloneCodexAuthState(sourceHome, managedHome);

  return {
    account: registerManagedAccount(slotName, managedHome),
    sourceHome
  };
}

/**
 * 通过隔离 HOME 调起官方 `codex login` 完成单账号登录。
 *
 * @param slotName 本地槽位名。
 * @returns Promise，成功时返回登录后的账号 HOME 目录。
 * @throws 当登录失败或登录态不完整时抛出异常。
 */
export async function loginAccount(slotName: string): Promise<string> {
  return await loginManagedAccount(slotName);
}

/**
 * 删除指定受管槽位。
 *
 * @param slotName 本地槽位名。
 * @returns 被删除的账号配置；不存在时返回 `null`。
 * @throws 无显式抛出。
 */
export function removeAccount(slotName: string): ManagedAccount | null {
  return removeManagedAccount(slotName);
}

/**
 * 列出当前所有受管账号配置。
 *
 * @returns 当前配置中的账号列表。
 * @throws 当配置读取失败时抛出异常。
 */
export function listAccounts(): ManagedAccount[] {
  return loadConfig().accounts;
}

/**
 * 重命名受管槽位，并同步迁移与账号标识绑定的本地状态。
 *
 * 业务规则：
 * 1. 若账号 HOME 使用默认槽位目录，则一并重命名目录路径。
 * 2. 若账号 HOME 是自定义路径，则仅更新账号标识，不强改目录。
 * 3. `state.json` 中与账号标识绑定的 usage/block 缓存会同步迁移。
 *
 * @param oldName 原槽位名。
 * @param newName 新槽位名。
 * @returns 重命名后的账号配置。
 * @throws 当旧槽位不存在、新槽位已存在或目录迁移失败时抛出异常。
 */
export function renameAccount(oldName: string, newName: string): ManagedAccount {
  const config = loadConfig();
  const index = config.accounts.findIndex((item) => item.id === oldName);

  if (index < 0) {
    throw new Error(bi(`未找到账号 ${oldName}`, `Account not found: ${oldName}`));
  }

  if (config.accounts.some((item) => item.id === newName)) {
    throw new Error(bi(`账号 ${newName} 已存在`, `Account already exists: ${newName}`));
  }

  const currentAccount = config.accounts[index];
  const defaultOldHome = getManagedHome(oldName);
  const defaultNewHome = getManagedHome(newName);
  let nextHome = currentAccount.codex_home;

  if (currentAccount.codex_home === defaultOldHome) {
    if (fs.existsSync(defaultNewHome)) {
      throw new Error(bi(`目标槽位目录已存在: ${defaultNewHome}`, `Target slot directory already exists: ${defaultNewHome}`));
    }

    // 只有默认槽位目录才一起迁移，避免误移动用户手工指定的 HOME。
    if (fs.existsSync(defaultOldHome)) {
      fs.renameSync(defaultOldHome, defaultNewHome);
    }
    nextHome = defaultNewHome;
  }

  const renamedAccount: ManagedAccount = {
    ...currentAccount,
    id: newName,
    name: newName,
    codex_home: nextHome
  };

  config.accounts[index] = renamedAccount;
  saveConfig(config);

  updateState((state) => {
    if (state.account_blocks[oldName]) {
      state.account_blocks[newName] = state.account_blocks[oldName];
      delete state.account_blocks[oldName];
    }
    if (state.usage_cache[oldName]) {
      state.usage_cache[newName] = {
        ...state.usage_cache[oldName],
        accountId: newName
      };
      delete state.usage_cache[oldName];
    }
    if (state.scheduler_stats[oldName]) {
      state.scheduler_stats[newName] = state.scheduler_stats[oldName];
      delete state.scheduler_stats[oldName];
    }
  });

  return renamedAccount;
}
