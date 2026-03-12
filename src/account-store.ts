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
 * 从 `id_token` 中解析邮箱。
 *
 * @param auth 认证文件对象。
 * @returns 邮箱地址；缺失或解析失败时返回 `undefined`。
 */
function resolveEmailFromAuth(auth: CodexAuthFile | null): string | undefined {
  const idToken = auth?.tokens?.id_token;

  if (!idToken) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as { email?: string };

    return payload.email;
  } catch {
    return undefined;
  }
}

/**
 * 将来源 HOME 下的官方 `.codex` 登录态复制到目标 HOME。
 *
 * 只复制认证和账号元数据所需文件，不复制历史日志、缓存等无关内容。
 *
 * @param sourceHome 来源 HOME 目录。
 * @param targetHome 目标 HOME 目录。
 * @returns 无返回值。
 * @throws 当来源目录缺少关键认证文件时抛出错误。
 */
export function cloneCodexAuthState(sourceHome: string, targetHome: string): void {
  const sourceCodexDir = getCodexDataDir(sourceHome);
  const targetCodexDir = getCodexDataDir(targetHome);
  const sourceAuthPath = path.join(sourceCodexDir, "auth.json");
  const sourceAccountsDir = path.join(sourceCodexDir, "accounts");
  const sourceRegistryPath = path.join(sourceAccountsDir, "registry.json");

  if (!fs.existsSync(sourceAuthPath)) {
    throw new Error(`来源目录缺少 auth.json: ${sourceAuthPath}`);
  }

  if (!fs.existsSync(sourceRegistryPath)) {
    throw new Error(`来源目录缺少 registry.json: ${sourceRegistryPath}`);
  }

  fs.mkdirSync(targetCodexDir, { recursive: true });
  fs.mkdirSync(path.join(targetCodexDir, "accounts"), { recursive: true });

  fs.copyFileSync(sourceAuthPath, path.join(targetCodexDir, "auth.json"));
  fs.copyFileSync(sourceRegistryPath, path.join(targetCodexDir, "accounts", "registry.json"));

  for (const entry of fs.readdirSync(sourceAccountsDir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith(".auth.json")) {
      continue;
    }

    fs.copyFileSync(
      path.join(sourceAccountsDir, entry.name),
      path.join(targetCodexDir, "accounts", entry.name)
    );
  }
}

/**
 * 检查某个 HOME 下的官方登录态是否完整。
 *
 * 完整标准：
 * 1. 存在 `.codex/auth.json`
 * 2. `auth.json` 中存在 `access_token`
 * 3. `auth.json` 中存在 `refresh_token`
 * 4. `auth.json` 中存在 `account_id`
 *
 * @param codexHome 待检查的 HOME 目录。
 * @returns 为 `true` 表示登录态完整，可用于调度；否则为 `false`。
 */
export function hasCompleteCodexAuthState(codexHome: string): boolean {
  const auth = readAuthFile(codexHome);

  return Boolean(
    auth?.tokens?.access_token &&
      auth?.tokens?.refresh_token &&
      auth?.tokens?.account_id
  );
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
  const auth = readAuthFile(home);
  const account: ManagedAccount = {
    id: accountId,
    name: accountId,
    codex_home: home,
    email: primary?.email ?? resolveEmailFromAuth(auth),
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
