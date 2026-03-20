import fs from "node:fs";
import path from "node:path";
import { cloneCodexAuthState, getCodexDataDir } from "./account-store";
import {
  clearManagedCodexAuthState,
  getManagedCodexAuthState,
  setManagedCodexAuthState
} from "./state";
import type { ManagedCodexAuthState } from "./types";

/**
 * 返回默认的 Codex HOME 目录。
 *
 * @returns 当前进程 HOME；未设置时返回空字符串。
 */
export function getDefaultCodexHome(): string {
  return process.env.HOME ?? "";
}

/**
 * 读取目标 HOME 下 `.codex/accounts` 目录中的所有 `.auth.json` 文件内容。
 *
 * @param codexHome 目标 HOME 目录。
 * @returns 文件名到原始文本的映射；目录不存在时返回空对象。
 */
function snapshotAccountAuthFiles(codexHome: string): Record<string, string> {
  const accountsDir = path.join(getCodexDataDir(codexHome), "accounts");
  if (!fs.existsSync(accountsDir)) {
    return {};
  }

  const snapshots: Record<string, string> = {};
  for (const entry of fs.readdirSync(accountsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".auth.json")) {
      continue;
    }

    snapshots[entry.name] = fs.readFileSync(path.join(accountsDir, entry.name), "utf8");
  }

  return snapshots;
}

/**
 * 基于当前目标 HOME 生成登录态恢复快照。
 *
 * @param targetHome 需要接管的主 HOME 目录。
 * @param sourceAccountId 可选的来源账号标识，仅用于状态记录。
 * @returns 用于 stop 恢复的快照。
 */
function buildManagedAuthSnapshot(
  targetHome: string,
  sourceAccountId?: string | null
): ManagedCodexAuthState {
  const codexDir = getCodexDataDir(targetHome);
  const authPath = path.join(codexDir, "auth.json");
  const registryPath = path.join(codexDir, "accounts", "registry.json");

  return {
    target_home: targetHome,
    source_account_id: sourceAccountId ?? null,
    original_auth_file: fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : null,
    original_registry_file: fs.existsSync(registryPath) ? fs.readFileSync(registryPath, "utf8") : null,
    original_account_auth_files: snapshotAccountAuthFiles(targetHome)
  };
}

/**
 * 将指定文件恢复为快照内容；快照为空时删除目标文件。
 *
 * @param targetFile 目标文件路径。
 * @param content 原始文件内容；为 `null` 时表示恢复为不存在。
 * @returns 无返回值。
 */
function restoreSnapshotFile(targetFile: string, content: string | null): void {
  if (content === null) {
    fs.rmSync(targetFile, { force: true });
    return;
  }

  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, content, "utf8");
}

/**
 * 将主 HOME 中多余的 `.auth.json` 文件删除，再恢复快照中记录的文件集合。
 *
 * @param targetHome 目标 HOME 目录。
 * @param snapshot 登录态快照。
 * @returns 无返回值。
 */
function restoreAccountAuthFiles(targetHome: string, snapshot: ManagedCodexAuthState): void {
  const accountsDir = path.join(getCodexDataDir(targetHome), "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  for (const entry of fs.readdirSync(accountsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".auth.json")) {
      continue;
    }

    if (!(entry.name in snapshot.original_account_auth_files)) {
      fs.rmSync(path.join(accountsDir, entry.name), { force: true });
    }
  }

  for (const [fileName, content] of Object.entries(snapshot.original_account_auth_files)) {
    restoreSnapshotFile(path.join(accountsDir, fileName), content);
  }
}

/**
 * 将主 `~/.codex` 登录态切换到指定受管账号，供 `codex_apps` 等依赖主登录态的能力复用。
 *
 * @param sourceHome 来源账号 HOME。
 * @param options 可选控制项；可指定目标 HOME 与来源账号标识。
 * @returns 实际接管的目标 HOME 路径。
 */
export function applyManagedCodexAuth(
  sourceHome: string,
  options?: { targetHome?: string; sourceAccountId?: string | null }
): string {
  const targetHome = options?.targetHome ?? getDefaultCodexHome();
  const previousState = getManagedCodexAuthState();
  const snapshot =
    previousState && previousState.target_home === targetHome
      ? previousState
      : buildManagedAuthSnapshot(targetHome, options?.sourceAccountId);

  cloneCodexAuthState(sourceHome, targetHome);

  setManagedCodexAuthState({
    ...snapshot,
    source_account_id: options?.sourceAccountId ?? snapshot.source_account_id ?? null
  });

  return targetHome;
}

/**
 * 恢复主 `~/.codex` 登录态到 cslot 接管前的原始状态。
 *
 * @returns 恢复的目标 HOME 路径；若没有接管快照则返回 `null`。
 */
export function deactivateManagedCodexAuth(): string | null {
  const snapshot = getManagedCodexAuthState();
  if (!snapshot) {
    return null;
  }

  const targetHome = snapshot.target_home;
  const codexDir = getCodexDataDir(targetHome);
  restoreSnapshotFile(path.join(codexDir, "auth.json"), snapshot.original_auth_file);
  restoreSnapshotFile(
    path.join(codexDir, "accounts", "registry.json"),
    snapshot.original_registry_file
  );
  restoreAccountAuthFiles(targetHome, snapshot);
  clearManagedCodexAuthState();

  return targetHome;
}
