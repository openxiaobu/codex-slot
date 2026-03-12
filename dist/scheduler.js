"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pickBestAccount = pickBestAccount;
exports.listCandidateAccounts = listCandidateAccounts;
const config_1 = require("./config");
const status_1 = require("./status");
function nextResetWeight(resetAt) {
    if (!resetAt) {
        return Number.MAX_SAFE_INTEGER;
    }
    const diff = resetAt * 1000 - Date.now();
    return diff > 0 ? diff : Number.MAX_SAFE_INTEGER;
}
/**
 * 选择当前最适合激活的账号。
 *
 * 业务规则：
 * 1. 仅在账号启用且存在凭据时参与调度。
 * 2. 优先选择当前 5 小时和周窗口都未受限的账号。
 * 3. 在多个可用账号间，优先选择 5 小时剩余额度更高的账号。
 *
 * @returns 调度结果；若没有可用账号则返回 `null`。
 */
function pickBestAccount() {
    return listCandidateAccounts()[0] ?? null;
}
/**
 * 返回按优先级排序后的可用账号列表，供代理重试链路使用。
 *
 * @returns 候选账号列表，已按优先级从高到低排序。
 */
function listCandidateAccounts() {
    const config = (0, config_1.loadConfig)();
    const statuses = (0, status_1.collectAccountStatuses)();
    const accountMap = new Map(config.accounts.map((item) => [item.id, item]));
    const available = statuses
        .filter((item) => item.isAvailable)
        .sort((left, right) => {
        const fiveHourDiff = (right.fiveHourLeftPercent ?? -1) - (left.fiveHourLeftPercent ?? -1);
        if (fiveHourDiff !== 0) {
            return fiveHourDiff;
        }
        const weeklyDiff = (right.weeklyLeftPercent ?? -1) - (left.weeklyLeftPercent ?? -1);
        if (weeklyDiff !== 0) {
            return weeklyDiff;
        }
        return nextResetWeight(left.fiveHourResetsAt) - nextResetWeight(right.fiveHourResetsAt);
    });
    return available
        .map((winner) => {
        const account = accountMap.get(winner.id);
        if (!account) {
            return null;
        }
        return {
            account,
            status: winner,
            reason: "优先选择 5 小时窗口剩余额度最高且当前可用的账号"
        };
    })
        .filter((item) => item !== null);
}
