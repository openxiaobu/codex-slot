import fs from "node:fs";
import path from "node:path";
import {
  expandHome,
  getManagedHome,
  loadConfig,
  saveConfig,
  upsertAccount
} from "./config";
import type {
  CodexAuthFile,
  CodexRegistry,
  CodexRegistryAccount,
  ManagedAccount
} from "./types";

/**
 * 读取指定账号 HOME 下的 `.codex` 目录。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns `.codex` 目录绝对路径。
 */
export function getCodexDataDir(codexHome: string): string {
  return path.join(expandHome(codexHome), ".codex");
}

/**
 * 读取某账号对应的 `registry.json`。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns 解析后的 registry；不存在时返回 `null`。
 */
export function readRegistry(codexHome: string): CodexRegistry | null {
  const registryPath = path.join(getCodexDataDir(codexHome), "accounts", "registry.json");

  if (!fs.existsSync(registryPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(registryPath, "utf8")) as CodexRegistry;
}

/**
 * 读取账号目录下当前激活凭据文件。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns 解析后的 auth.json；不存在时返回 `null`。
 */
export function readAuthFile(codexHome: string): CodexAuthFile | null {
  const authPath = path.join(getCodexDataDir(codexHome), "auth.json");

  if (!fs.existsSync(authPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(authPath, "utf8")) as CodexAuthFile;
}

/**
 * 将最新认证信息回写到指定账号的 `auth.json`。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @param auth 最新认证信息。
 * @returns 无返回值。
 */
export function writeAuthFile(codexHome: string, auth: CodexAuthFile): void {
  const authPath = path.join(getCodexDataDir(codexHome), "auth.json");
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}

/**
 * 根据当前账号目录中的 registry 推断主账号信息。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns 当前活跃账号元数据；无可用账号时返回 `null`。
 */
export function resolvePrimaryRegistryAccount(codexHome: string): CodexRegistryAccount | null {
  const registry = readRegistry(codexHome);

  if (!registry || registry.accounts.length === 0) {
    return null;
  }

  if (registry.active_email) {
    const active = registry.accounts.find((item) => item.email === registry.active_email);
    if (active) {
      return active;
    }
  }

  return registry.accounts[0] ?? null;
}

/**
 * 将账号注册到 codexl 配置中，并为其准备独立 HOME 目录。
 *
 * @param accountId 本地账号标识。
 * @param codexHome 可选的自定义 HOME 目录；未提供时使用默认路径。
 * @returns 写入后的账号配置。
 */
export function registerManagedAccount(accountId: string, codexHome?: string): ManagedAccount {
  const home = codexHome ? expandHome(codexHome) : getManagedHome(accountId);

  // 预先创建账号隔离目录，方便后续直接执行 codex login。
  fs.mkdirSync(home, { recursive: true });

  const primary = resolvePrimaryRegistryAccount(home);
  const account: ManagedAccount = {
    id: accountId,
    name: accountId,
    codex_home: home,
    email: primary?.email,
    enabled: true,
    imported_at: new Date().toISOString()
  };

  upsertAccount(account);
  return account;
}

/**
 * 从配置中删除指定账号；默认仅删除配置项，不主动删除本地 HOME 目录。
 *
 * @param accountId 本地账号标识。
 * @returns 被删除的账号配置；未命中时返回 `null`。
 */
export function removeManagedAccount(accountId: string): ManagedAccount | null {
  const config = loadConfig();
  const index = config.accounts.findIndex((item) => item.id === accountId);

  if (index < 0) {
    return null;
  }

  const [removed] = config.accounts.splice(index, 1);
  saveConfig(config);
  return removed ?? null;
}

/**
 * 根据账号标识读取配置中的账号项。
 *
 * @param accountId 本地账号标识。
 * @returns 命中的账号配置；未命中时返回 `null`。
 */
export function findManagedAccount(accountId: string): ManagedAccount | null {
  const config = loadConfig();
  return config.accounts.find((item) => item.id === accountId) ?? null;
}
