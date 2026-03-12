"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectAccountStatuses = collectAccountStatuses;
exports.renderStatusTable = renderStatusTable;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
const account_store_1 = require("./account-store");
const state_1 = require("./state");
function computeLeftPercent(usedPercent) {
    if (usedPercent === null || usedPercent === undefined || Number.isNaN(usedPercent)) {
        return null;
    }
    return Math.max(0, Math.min(100, 100 - usedPercent));
}
function isLimited(usedPercent, resetsAt) {
    if (usedPercent === null || usedPercent < 100) {
        return false;
    }
    if (!resetsAt) {
        return true;
    }
    return resetsAt * 1000 > Date.now();
}
function formatPercent(value) {
    return value === null ? "-" : `${value}%`;
}
function formatReset(unixSeconds) {
    if (!unixSeconds) {
        return "-";
    }
    return new Date(unixSeconds * 1000).toLocaleString("zh-CN", {
        hour12: false
    });
}
/**
 * 汇总所有受管账号的运行状态，供状态展示与调度复用。
 *
 * @returns 所有账号的运行时状态列表。
 */
function collectAccountStatuses() {
    const config = (0, config_1.loadConfig)();
    return config.accounts.map((account) => {
        const codexDir = (0, account_store_1.getCodexDataDir)(account.codex_home);
        const registryPath = node_path_1.default.join(codexDir, "accounts", "registry.json");
        const exists = node_fs_1.default.existsSync(registryPath);
        const primary = exists ? (0, account_store_1.resolvePrimaryRegistryAccount)(account.codex_home) : null;
        const usageCache = (0, state_1.getUsageCache)(account.id);
        const activeEmail = usageCache?.email ?? primary?.email ?? account.email;
        const fiveHourUsed = usageCache?.fiveHourUsedPercent ?? null;
        const fiveHourReset = usageCache?.fiveHourResetAt ?? null;
        const weeklyUsed = usageCache?.weeklyUsedPercent ?? null;
        const weeklyReset = usageCache?.weeklyResetAt ?? null;
        const fiveHourLeftPercent = computeLeftPercent(fiveHourUsed);
        const weeklyLeftPercent = computeLeftPercent(weeklyUsed);
        const isFiveHourLimited = isLimited(fiveHourUsed, fiveHourReset);
        const isWeeklyLimited = isLimited(weeklyUsed, weeklyReset);
        const localBlock = (0, state_1.getAccountBlock)(account.id);
        const localBlocked = localBlock?.until != null ? localBlock.until * 1000 > Date.now() : false;
        return {
            id: account.id,
            name: account.name,
            email: activeEmail,
            enabled: account.enabled,
            exists,
            plan: usageCache?.plan ?? primary?.plan ?? "-",
            fiveHourLeftPercent,
            fiveHourResetsAt: fiveHourReset,
            weeklyLeftPercent,
            weeklyResetsAt: weeklyReset,
            isFiveHourLimited,
            isWeeklyLimited,
            localBlockReason: localBlock?.reason,
            localBlockUntil: localBlock?.until ?? null,
            isAvailable: account.enabled &&
                exists &&
                !isFiveHourLimited &&
                !isWeeklyLimited &&
                !localBlocked,
            sourcePath: codexDir
        };
    });
}
/**
 * 将账号状态渲染为适合终端输出的表格文本。
 *
 * @param statuses 待展示的账号状态列表。
 * @returns 可直接打印到终端的表格字符串。
 */
function renderStatusTable(statuses) {
    const rows = [
        ["NAME", "EMAIL", "PLAN", "5H_LEFT", "5H_RESET", "WEEK_LEFT", "WEEK_RESET", "STATUS"]
    ];
    for (const item of statuses) {
        let status = "missing";
        if (item.exists) {
            if (!item.enabled) {
                status = "disabled";
            }
            else if (item.localBlockUntil && item.localBlockUntil * 1000 > Date.now()) {
                status = item.localBlockReason ?? "blocked";
            }
            else if (item.isWeeklyLimited) {
                status = "weekly_limited";
            }
            else if (item.isFiveHourLimited) {
                status = "cooldown";
            }
            else if (item.isAvailable) {
                status = "available";
            }
            else {
                status = "unknown";
            }
        }
        rows.push([
            item.name,
            item.email ?? "-",
            item.plan,
            formatPercent(item.fiveHourLeftPercent),
            formatReset(item.fiveHourResetsAt),
            formatPercent(item.weeklyLeftPercent),
            formatReset(item.weeklyResetsAt),
            status
        ]);
    }
    const widths = rows[0].map((_, columnIndex) => Math.max(...rows.map((row) => row[columnIndex].length)));
    return rows
        .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  "))
        .join("\n");
}
