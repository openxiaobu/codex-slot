"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loginManagedAccount = loginManagedAccount;
const node_child_process_1 = require("node:child_process");
const account_store_1 = require("./account-store");
const config_1 = require("./config");
/**
 * 使用独立 HOME 目录拉起官方 `codex login`，完成单账号录入。
 *
 * @param accountId 本地账号标识。
 * @returns Promise，成功时返回导入后的 HOME 目录。
 * @throws 当 `codex login` 执行失败时抛出错误。
 */
async function loginManagedAccount(accountId) {
    const managedHome = (0, config_1.getManagedHome)(accountId);
    (0, account_store_1.registerManagedAccount)(accountId, managedHome);
    return await new Promise((resolve, reject) => {
        const child = (0, node_child_process_1.spawn)("codex", ["login"], {
            env: {
                ...process.env,
                HOME: managedHome
            },
            stdio: "inherit"
        });
        child.on("exit", (code) => {
            if (code === 0) {
                (0, account_store_1.registerManagedAccount)(accountId, managedHome);
                resolve(managedHome);
                return;
            }
            reject(new Error(`codex login 失败，退出码: ${code ?? "unknown"}`));
        });
        child.on("error", (error) => {
            reject(error);
        });
    });
}
