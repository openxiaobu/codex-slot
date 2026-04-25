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

const STATE_SCHEMA_VERSION = 1;

function getStatePath(): string {
  return path.join(getCslotHome(), "state.json");
}

/**
 * 构造当前版本的默认本地状态对象。
 *
 * 业务含义：
 * 1. 所有缺失或空 state 文件统一走这里补齐字段。
 * 2. 新增状态字段时只需要在默认状态与归一化逻辑中集中维护。
 *
 * @returns 当前 schema 版本的默认状态。
 * @throws 无显式抛出。
 */
function createDefaultState(): CslotState {
  return {
    state_version: STATE_SCHEMA_VERSION,
    account_blocks: {},
    usage_cache: {},
    usage_refresh_errors: {},
    scheduler_stats: {},
    managed_codex_auth: null,
    managed_codex_config: null
  };
}

/**
 * 将历史版本或字段缺失的 state 归一化为当前 schema。
 *
 * @param parsed 从 state 文件解析出的原始对象。
 * @returns 补齐默认字段后的当前版本状态。
 * @throws 无显式抛出。
 */
function normalizeState(parsed: Partial<CslotState> | null | undefined): CslotState {
  const defaults = createDefaultState();

  return {
    state_version: STATE_SCHEMA_VERSION,
    account_blocks: parsed?.account_blocks ?? defaults.account_blocks,
    usage_cache: parsed?.usage_cache ?? defaults.usage_cache,
    usage_refresh_errors: parsed?.usage_refresh_errors ?? defaults.usage_refresh_errors,
    scheduler_stats: parsed?.scheduler_stats ?? defaults.scheduler_stats,
    managed_codex_auth: parsed?.managed_codex_auth ?? defaults.managed_codex_auth,
    managed_codex_config: parsed?.managed_codex_config ?? defaults.managed_codex_config
  };
}

/**
 * 读取 cslot 的本地运行状态；文件不存在时返回默认空状态。
 *
 * @returns 当前持久化状态。
 */
export function loadState(): CslotState {
  const statePath = getStatePath();

  if (!fs.existsSync(statePath)) {
    return createDefaultState();
  }

  const raw = fs.readFileSync(statePath, "utf8");
  return normalizeState(raw.trim() ? (JSON.parse(raw) as Partial<CslotState>) : null);
}

/**
 * 持久化 cslot 的本地运行状态。
 *
 * @param state 待写入状态对象。
 * @returns 无返回值。
 */
export function saveState(state: CslotState): void {
  const statePath = getStatePath();
  const normalizedState = normalizeState(state);
  const tempPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;

  fs.writeFileSync(tempPath, `${JSON.stringify(normalizedState, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, statePath);
}

/**
 * 在单一边界内读取、修改并保存本地状态。
 *
 * 业务含义：
 * 1. 所有状态写入都统一经过当前函数，避免各模块散落 load/mutate/save 流程。
 * 2. 保存阶段复用原子替换写入，降低半写入状态文件风险。
 *
 * @param mutator 状态修改函数；接收当前状态对象并可原地修改。
 * @returns 修改后已保存的状态对象。
 * @throws 当读取、修改或写入失败时透传底层异常。
 */
export function updateState(mutator: (state: CslotState) => void): CslotState {
  const state = loadState();
  mutator(state);
  saveState(state);
  return state;
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
  updateState((state) => {
    state.account_blocks[accountId] = {
      until,
      reason,
      updated_at: new Date().toISOString()
    };
  });
}

/**
 * 清理指定账号当前记录的本地禁用状态。
 *
 * @param accountId 账号标识。
 * @returns 无返回值。
 */
export function clearAccountBlock(accountId: string): void {
  updateState((state) => {
    delete state.account_blocks[accountId];
  });
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
    updateState((latest) => {
      for (const accountId of Object.keys(state.account_blocks)) {
        latest.account_blocks[accountId] = state.account_blocks[accountId];
      }
      for (const accountId of Object.keys(latest.account_blocks)) {
        if (!(accountId in state.account_blocks)) {
          delete latest.account_blocks[accountId];
        }
      }
    });
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
  updateState((state) => {
    state.usage_cache[usage.accountId] = usage;
  });
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
  updateState((state) => {
    state.usage_refresh_errors[usageError.accountId] = usageError;
  });
}

/**
 * 清理指定账号最近一次记录的额度刷新失败状态，避免后续成功刷新后继续展示旧错误。
 *
 * @param accountId 账号标识。
 * @returns 无返回值。
 */
export function clearUsageRefreshError(accountId: string): void {
  updateState((state) => {
    delete state.usage_refresh_errors[accountId];
  });
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
  updateState((state) => {
    state.managed_codex_config = managedState;
  });
}

/**
 * 保存 Codex 主 HOME 登录态接管快照，用于 stop 时恢复原始登录态文件。
 *
 * @param managedState 接管前保存的原始登录态快照。
 * @returns 无返回值。
 */
export function setManagedCodexAuthState(managedState: ManagedCodexAuthState): void {
  updateState((state) => {
    state.managed_codex_auth = managedState;
  });
}

/**
 * 清理 Codex `config.toml` 接管快照。
 *
 * @returns 无返回值。
 */
export function clearManagedCodexConfigState(): void {
  updateState((state) => {
    state.managed_codex_config = null;
  });
}

/**
 * 清理 Codex 主 HOME 登录态接管快照。
 *
 * @returns 无返回值。
 */
export function clearManagedCodexAuthState(): void {
  updateState((state) => {
    state.managed_codex_auth = null;
  });
}
