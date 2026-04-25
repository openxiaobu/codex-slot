import fs from "node:fs";
import path from "node:path";
import { getCslotHome } from "./config";
import type {
  AccountBlockState,
  CslotState,
  ManagedCodexAuthState,
  ManagedCodexConfigState,
  UsageRefreshError,
  UsageRefreshResult
} from "./types";

function getStatePath(): string {
  return path.join(getCslotHome(), "state.json");
}

/**
 * 读取 cslot 的本地运行状态；文件不存在时返回默认空状态。
 *
 * @returns 当前持久化状态。
 */
export function loadState(): CslotState {
  const statePath = getStatePath();

  if (!fs.existsSync(statePath)) {
    return {
      account_blocks: {},
      usage_cache: {},
      usage_refresh_errors: {},
      scheduler_stats: {},
      managed_codex_auth: null,
      managed_codex_config: null
    };
  }

  const raw = fs.readFileSync(statePath, "utf8");
  const parsed = raw.trim()
    ? (JSON.parse(raw) as CslotState)
    : {
        account_blocks: {},
        usage_cache: {},
        usage_refresh_errors: {},
        scheduler_stats: {},
        managed_codex_auth: null,
        managed_codex_config: null
      };

  return {
    account_blocks: parsed.account_blocks ?? {},
    usage_cache: parsed.usage_cache ?? {},
    usage_refresh_errors: parsed.usage_refresh_errors ?? {},
    scheduler_stats: parsed.scheduler_stats ?? {},
    managed_codex_auth: parsed.managed_codex_auth ?? null,
    managed_codex_config: parsed.managed_codex_config ?? null
  };
}

/**
 * 持久化 cslot 的本地运行状态。
 *
 * @param state 待写入状态对象。
 * @returns 无返回值。
 */
export function saveState(state: CslotState): void {
  const statePath = getStatePath();
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/**
 * 为指定账号设置本地禁用窗口，用于临时熔断或周限制冷却。
 *
 * @param accountId 账号标识。
 * @param until 禁用截止时间，Unix 秒时间戳；为 `null` 时表示仅记录原因。
 * @param reason 禁用原因。
 * @returns 无返回值。
 */
export function setAccountBlock(accountId: string, until: number | null, reason: string): void {
  const state = loadState();
  state.account_blocks[accountId] = {
    until,
    reason,
    updated_at: new Date().toISOString()
  };
  saveState(state);
}

/**
 * 清理已过期的账号禁用记录，并返回最新状态。
 *
 * @returns 清理后的状态对象。
 */
export function pruneExpiredBlocks(): CslotState {
  const state = loadState();
  const now = Math.floor(Date.now() / 1000);
  let changed = false;

  for (const [accountId, block] of Object.entries(state.account_blocks)) {
    if (block.until !== null && block.until <= now) {
      delete state.account_blocks[accountId];
      changed = true;
    }
  }

  if (changed) {
    saveState(state);
  }

  return state;
}

/**
 * 读取指定账号当前的本地禁用状态；若已过期会自动清理。
 *
 * @param accountId 账号标识。
 * @returns 账号禁用状态；不存在或已过期时返回 `null`。
 */
export function getAccountBlock(accountId: string): AccountBlockState | null {
  const state = pruneExpiredBlocks();
  return state.account_blocks[accountId] ?? null;
}

/**
 * 更新指定账号的最新额度缓存，仅写入 cslot 自己的状态文件。
 *
 * @param usage 最新额度结果。
 * @returns 无返回值。
 */
export function setUsageCache(usage: import("./types").UsageRefreshResult): void {
  const state = loadState();
  state.usage_cache[usage.accountId] = usage;
  saveState(state);
}

/**
 * 读取指定账号最近一次成功刷新的额度缓存。
 *
 * @param accountId 账号标识。
 * @returns 最新额度缓存；不存在时返回 `null`。
 */
export function getUsageCache(accountId: string): UsageRefreshResult | null {
  const state = loadState();
  return state.usage_cache[accountId] ?? null;
}

/**
 * 记录指定账号最近一次额度刷新失败的状态，供 `status` 命令渲染为账号状态而不是直接打印异常。
 *
 * @param usageError 刷新失败信息，包含账号、状态码与原始错误摘要。
 * @returns 无返回值。
 */
export function setUsageRefreshError(usageError: UsageRefreshError): void {
  const state = loadState();
  state.usage_refresh_errors[usageError.accountId] = usageError;
  saveState(state);
}

/**
 * 清理指定账号最近一次记录的额度刷新失败状态，避免后续成功刷新后继续展示旧错误。
 *
 * @param accountId 账号标识。
 * @returns 无返回值。
 */
export function clearUsageRefreshError(accountId: string): void {
  const state = loadState();

  if (!(accountId in state.usage_refresh_errors)) {
    return;
  }

  delete state.usage_refresh_errors[accountId];
  saveState(state);
}

/**
 * 读取指定账号最近一次记录的额度刷新失败状态。
 *
 * @param accountId 账号标识。
 * @returns 刷新失败信息；若不存在则返回 `null`。
 */
export function getUsageRefreshError(accountId: string): UsageRefreshError | null {
  const state = loadState();
  return state.usage_refresh_errors[accountId] ?? null;
}

/**
 * 读取指定账号的调度使用统计，用于在多账号可用时做均匀分摊。
 *
 * @param accountId 账号标识。
 * @returns 调度统计；不存在时返回默认零值。
 */
export function getSchedulerStats(accountId: string): import("./types").AccountSchedulerStats {
  const state = loadState();
  return state.scheduler_stats[accountId] ?? {
    success_count: 0,
    last_success_at: null
  };
}

/**
 * 记录指定账号完成一次成功代理请求，供后续调度降低连续命中同一账号的概率。
 *
 * @param accountId 账号标识。
 * @returns 无返回值。
 */
export function recordAccountScheduleSuccess(accountId: string): void {
  const state = loadState();
  const current = state.scheduler_stats[accountId] ?? {
    success_count: 0,
    last_success_at: null
  };

  state.scheduler_stats[accountId] = {
    success_count: current.success_count + 1,
    last_success_at: new Date().toISOString()
  };
  saveState(state);
}

/**
 * 读取当前记录的 Codex `config.toml` 接管快照。
 *
 * @returns 最近一次接管时保存的快照；不存在时返回 `null`。
 */
export function getManagedCodexConfigState(): ManagedCodexConfigState | null {
  const state = loadState();
  return state.managed_codex_config ?? null;
}

/**
 * 读取当前记录的 Codex 主 HOME 登录态接管快照。
 *
 * @returns 最近一次接管时保存的登录态快照；不存在时返回 `null`。
 */
export function getManagedCodexAuthState(): ManagedCodexAuthState | null {
  const state = loadState();
  return state.managed_codex_auth ?? null;
}

/**
 * 保存 Codex `config.toml` 接管快照，用于后续停止服务时精确恢复。
 *
 * @param managedState 接管前保存的原始片段快照。
 * @returns 无返回值。
 */
export function setManagedCodexConfigState(managedState: ManagedCodexConfigState): void {
  const state = loadState();
  state.managed_codex_config = managedState;
  saveState(state);
}

/**
 * 保存 Codex 主 HOME 登录态接管快照，用于 stop 时恢复原始登录态文件。
 *
 * @param managedState 接管前保存的原始登录态快照。
 * @returns 无返回值。
 */
export function setManagedCodexAuthState(managedState: ManagedCodexAuthState): void {
  const state = loadState();
  state.managed_codex_auth = managedState;
  saveState(state);
}

/**
 * 清理 Codex `config.toml` 接管快照。
 *
 * @returns 无返回值。
 */
export function clearManagedCodexConfigState(): void {
  const state = loadState();
  state.managed_codex_config = null;
  saveState(state);
}

/**
 * 清理 Codex 主 HOME 登录态接管快照。
 *
 * @returns 无返回值。
 */
export function clearManagedCodexAuthState(): void {
  const state = loadState();
  state.managed_codex_auth = null;
  saveState(state);
}
