"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCodexDataDir = getCodexDataDir;
exports.readRegistry = readRegistry;
exports.readAuthFile = readAuthFile;
exports.writeAuthFile = writeAuthFile;
exports.resolvePrimaryRegistryAccount = resolvePrimaryRegistryAccount;
exports.registerManagedAccount = registerManagedAccount;
exports.removeManagedAccount = removeManagedAccount;
exports.findManagedAccount = findManagedAccount;
const node_fs_1 = __importDefault(require("node:fs"));
const node_path_1 = __importDefault(require("node:path"));
const config_1 = require("./config");
/**
 * 读取指定账号 HOME 下的 `.codex` 目录。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns `.codex` 目录绝对路径。
 */
function getCodexDataDir(codexHome) {
    return node_path_1.default.join((0, config_1.expandHome)(codexHome), ".codex");
}
/**
 * 读取某账号对应的 `registry.json`。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns 解析后的 registry；不存在时返回 `null`。
 */
function readRegistry(codexHome) {
    const registryPath = node_path_1.default.join(getCodexDataDir(codexHome), "accounts", "registry.json");
    if (!node_fs_1.default.existsSync(registryPath)) {
        return null;
    }
    return JSON.parse(node_fs_1.default.readFileSync(registryPath, "utf8"));
}
/**
 * 读取账号目录下当前激活凭据文件。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns 解析后的 auth.json；不存在时返回 `null`。
 */
function readAuthFile(codexHome) {
    const authPath = node_path_1.default.join(getCodexDataDir(codexHome), "auth.json");
    if (!node_fs_1.default.existsSync(authPath)) {
        return null;
    }
    return JSON.parse(node_fs_1.default.readFileSync(authPath, "utf8"));
}
/**
 * 将最新认证信息回写到指定账号的 `auth.json`。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @param auth 最新认证信息。
 * @returns 无返回值。
 */
function writeAuthFile(codexHome, auth) {
    const authPath = node_path_1.default.join(getCodexDataDir(codexHome), "auth.json");
    node_fs_1.default.mkdirSync(node_path_1.default.dirname(authPath), { recursive: true });
    node_fs_1.default.writeFileSync(authPath, `${JSON.stringify(auth, null, 2)}\n`, "utf8");
}
/**
 * 根据当前账号目录中的 registry 推断主账号信息。
 *
 * @param codexHome 账号独立 HOME 目录。
 * @returns 当前活跃账号元数据；无可用账号时返回 `null`。
 */
function resolvePrimaryRegistryAccount(codexHome) {
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
function registerManagedAccount(accountId, codexHome) {
    const home = codexHome ? (0, config_1.expandHome)(codexHome) : (0, config_1.getManagedHome)(accountId);
    // 预先创建账号隔离目录，方便后续直接执行 codex login。
    node_fs_1.default.mkdirSync(home, { recursive: true });
    const primary = resolvePrimaryRegistryAccount(home);
    const account = {
        id: accountId,
        name: accountId,
        codex_home: home,
        email: primary?.email,
        enabled: true,
        imported_at: new Date().toISOString()
    };
    (0, config_1.upsertAccount)(account);
    return account;
}
/**
 * 从配置中删除指定账号；默认仅删除配置项，不主动删除本地 HOME 目录。
 *
 * @param accountId 本地账号标识。
 * @returns 被删除的账号配置；未命中时返回 `null`。
 */
function removeManagedAccount(accountId) {
    const config = (0, config_1.loadConfig)();
    const index = config.accounts.findIndex((item) => item.id === accountId);
    if (index < 0) {
        return null;
    }
    const [removed] = config.accounts.splice(index, 1);
    (0, config_1.saveConfig)(config);
    return removed ?? null;
}
/**
 * 根据账号标识读取配置中的账号项。
 *
 * @param accountId 本地账号标识。
 * @returns 命中的账号配置；未命中时返回 `null`。
 */
function findManagedAccount(accountId) {
    const config = (0, config_1.loadConfig)();
    return config.accounts.find((item) => item.id === accountId) ?? null;
}
