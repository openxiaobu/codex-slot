"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCodexSwHome = getCodexSwHome;
exports.getConfigPath = getConfigPath;
exports.getPidPath = getPidPath;
exports.getServiceLogPath = getServiceLogPath;
exports.expandHome = expandHome;
exports.loadConfig = loadConfig;
exports.saveConfig = saveConfig;
exports.getManagedHome = getManagedHome;
exports.upsertAccount = upsertAccount;
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const yaml_1 = __importDefault(require("yaml"));
const zod_1 = require("zod");
const managedAccountSchema = zod_1.z.object({
    id: zod_1.z.string().min(1),
    name: zod_1.z.string().min(1),
    codex_home: zod_1.z.string().min(1),
    email: zod_1.z.string().email().optional(),
    enabled: zod_1.z.boolean().default(true),
    imported_at: zod_1.z.string().optional()
});
const configSchema = zod_1.z.object({
    version: zod_1.z.number().int().default(1),
    server: zod_1.z
        .object({
        host: zod_1.z.string().default("127.0.0.1"),
        port: zod_1.z.number().int().default(4389),
        api_key: zod_1.z.string().default("codexl-defaultkey")
    })
        .default({
        host: "127.0.0.1",
        port: 4389,
        api_key: "codexl-defaultkey"
    }),
    upstream: zod_1.z
        .object({
        codex_base_url: zod_1.z.string().default("https://chatgpt.com/backend-api/codex"),
        auth_base_url: zod_1.z.string().default("https://auth.openai.com"),
        oauth_client_id: zod_1.z.string().default("app_EMoamEEZ73f0CkXaXp7hrann")
    })
        .default({
        codex_base_url: "https://chatgpt.com/backend-api/codex",
        auth_base_url: "https://auth.openai.com",
        oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
    }),
    accounts: zod_1.z.array(managedAccountSchema).default([])
});
/**
 * 返回 codexl 的根目录，并确保基础目录结构存在。
 *
 * @returns codexl 根目录绝对路径。
 * @throws 当目录无法创建时抛出文件系统错误。
 */
function getCodexSwHome() {
    const home = node_path_1.default.join(node_os_1.default.homedir(), ".codexl");
    const legacyHome = node_path_1.default.join(node_os_1.default.homedir(), ".codexsw");
    if (!node_fs_1.default.existsSync(home) && node_fs_1.default.existsSync(legacyHome)) {
        node_fs_1.default.cpSync(legacyHome, home, { recursive: true });
    }
    // 先创建 codexl 根目录，后续命令统一基于该目录读写状态。
    node_fs_1.default.mkdirSync(home, { recursive: true });
    node_fs_1.default.mkdirSync(node_path_1.default.join(home, "homes"), { recursive: true });
    node_fs_1.default.mkdirSync(node_path_1.default.join(home, "logs"), { recursive: true });
    return home;
}
/**
 * 返回 codexl 配置文件路径。
 *
 * @returns 配置文件绝对路径。
 */
function getConfigPath() {
    return node_path_1.default.join(getCodexSwHome(), "config.yaml");
}
/**
 * 返回后台服务 PID 文件路径。
 *
 * @returns PID 文件绝对路径。
 */
function getPidPath() {
    return node_path_1.default.join(getCodexSwHome(), "codexl.pid");
}
/**
 * 返回后台服务日志文件路径。
 *
 * @returns 日志文件绝对路径。
 */
function getServiceLogPath() {
    return node_path_1.default.join(getCodexSwHome(), "logs", "service.log");
}
/**
 * 将路径中的 `~` 展开为当前用户家目录。
 *
 * @param input 原始路径，允许以 `~` 开头。
 * @returns 展开后的绝对或原始路径。
 */
function expandHome(input) {
    if (input === "~") {
        return node_os_1.default.homedir();
    }
    if (input.startsWith("~/")) {
        return node_path_1.default.join(node_os_1.default.homedir(), input.slice(2));
    }
    return input;
}
/**
 * 读取 codexl 配置；若配置不存在则返回默认配置。
 *
 * @returns 经过 schema 校验后的配置对象。
 * @throws 当配置存在但内容非法时抛出错误。
 */
function loadConfig() {
    const configPath = getConfigPath();
    const legacyConfigPath = node_path_1.default.join(node_os_1.default.homedir(), ".codexsw", "config.yaml");
    if (!node_fs_1.default.existsSync(configPath)) {
        const defaultConfig = {
            version: 1,
            server: {
                host: "127.0.0.1",
                port: 4389,
                api_key: "codexl-defaultkey"
            },
            upstream: {
                codex_base_url: "https://chatgpt.com/backend-api/codex",
                auth_base_url: "https://auth.openai.com",
                oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
            },
            accounts: []
        };
        saveConfig(defaultConfig);
        return defaultConfig;
    }
    const raw = node_fs_1.default.readFileSync(configPath, "utf8");
    const parsed = raw.trim() ? yaml_1.default.parse(raw) : {};
    const normalized = configSchema.parse(parsed);
    let changed = JSON.stringify(parsed) !== JSON.stringify(normalized);
    if (normalized.accounts.length === 0 &&
        node_fs_1.default.existsSync(legacyConfigPath)) {
        const legacyRaw = node_fs_1.default.readFileSync(legacyConfigPath, "utf8");
        const legacyParsed = legacyRaw.trim() ? yaml_1.default.parse(legacyRaw) : {};
        const legacyConfig = configSchema.parse(legacyParsed);
        if (legacyConfig.accounts.length > 0) {
            normalized.accounts = legacyConfig.accounts;
            changed = true;
        }
    }
    // 兼容历史默认值，统一迁移到新的简短本地 key。
    if (normalized.server.api_key === "local-only-key" ||
        normalized.server.api_key === "codexsw-defaultkey") {
        normalized.server.api_key = "codexl-defaultkey";
        changed = true;
    }
    // 当旧配置缺少新字段时，将补全后的配置回写，便于用户直接编辑查看。
    if (changed) {
        saveConfig(normalized);
    }
    return normalized;
}
/**
 * 持久化 codexl 配置文件。
 *
 * @param config 待写入的配置对象。
 * @returns 无返回值。
 * @throws 当配置写入失败时抛出文件系统错误。
 */
function saveConfig(config) {
    const configPath = getConfigPath();
    const text = yaml_1.default.stringify(config);
    node_fs_1.default.writeFileSync(configPath, text, "utf8");
}
/**
 * 根据账号标识生成其独立的 HOME 目录。
 *
 * @param accountId 账号标识，仅用于本地目录名。
 * @returns 该账号对应的 HOME 目录绝对路径。
 */
function getManagedHome(accountId) {
    return node_path_1.default.join(getCodexSwHome(), "homes", accountId);
}
/**
 * 将账号追加到配置中；若已存在相同 id 则覆盖更新。
 *
 * @param account 待写入的账号配置。
 * @returns 更新后的完整配置对象。
 */
function upsertAccount(account) {
    const config = loadConfig();
    const index = config.accounts.findIndex((item) => item.id === account.id);
    if (index >= 0) {
        config.accounts[index] = account;
    }
    else {
        config.accounts.push(account);
    }
    saveConfig(config);
    return config;
}
