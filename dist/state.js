"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadState = loadState;
exports.saveState = saveState;
exports.setAccountBlock = setAccountBlock;
exports.pruneExpiredBlocks = pruneExpiredBlocks;
exports.getAccountBlock = getAccountBlock;
exports.setUsageCache = setUsageCache;
exports.getUsageCache = getUsageCache;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
function getStatePath() {
    return node_path_1.default.join((0, config_1.getCodexSwHome)(), "state.json");
}
/**
 * 读取 codexl 的本地运行状态；文件不存在时返回默认空状态。
 *
 * @returns 当前持久化状态。
 */
function loadState() {
    const statePath = getStatePath();
    if (!node_fs_1.default.existsSync(statePath)) {
        return {
            account_blocks: {},
            usage_cache: {}
        };
    }
    const raw = node_fs_1.default.readFileSync(statePath, "utf8");
    const parsed = raw.trim()
        ? JSON.parse(raw)
        : {
            account_blocks: {},
            usage_cache: {}
        };
    return {
        account_blocks: parsed.account_blocks ?? {},
        usage_cache: parsed.usage_cache ?? {}
    };
}
/**
 * 持久化 codexl 的本地运行状态。
 *
 * @param state 待写入状态对象。
 * @returns 无返回值。
 */
function saveState(state) {
    const statePath = getStatePath();
    node_fs_1.default.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}
/**
 * 为指定账号设置本地禁用窗口，用于临时熔断或周限制冷却。
 *
 * @param accountId 账号标识。
 * @param until 禁用截止时间，Unix 秒时间戳；为 `null` 时表示仅记录原因。
 * @param reason 禁用原因。
 * @returns 无返回值。
 */
function setAccountBlock(accountId, until, reason) {
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
function pruneExpiredBlocks() {
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
function getAccountBlock(accountId) {
    const state = pruneExpiredBlocks();
    return state.account_blocks[accountId] ?? null;
}
/**
 * 更新指定账号的最新额度缓存，仅写入 codexl 自己的状态文件。
 *
 * @param usage 最新额度结果。
 * @returns 无返回值。
 */
function setUsageCache(usage) {
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
function getUsageCache(accountId) {
    const state = loadState();
    return state.usage_cache[accountId] ?? null;
}
