import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { CodexSwConfig, ManagedAccount } from "./types";

const managedAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  codex_home: z.string().min(1),
  email: z.string().email().optional(),
  enabled: z.boolean().default(true),
  imported_at: z.string().optional()
});

const configSchema = z.object({
  version: z.number().int().default(1),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(4389),
      api_key: z.string().default("cslot-defaultkey"),
      body_limit_mb: z.number().positive().default(512)
    })
    .default({
      host: "127.0.0.1",
      port: 4389,
      api_key: "cslot-defaultkey",
      body_limit_mb: 512
    }),
  upstream: z
    .object({
      codex_base_url: z.string().default("https://chatgpt.com/backend-api/codex"),
      auth_base_url: z.string().default("https://auth.openai.com"),
      oauth_client_id: z.string().default("app_EMoamEEZ73f0CkXaXp7hrann")
    })
    .default({
      codex_base_url: "https://chatgpt.com/backend-api/codex",
      auth_base_url: "https://auth.openai.com",
      oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
    }),
  accounts: z.array(managedAccountSchema).default([])
});

/**
 * 返回 cslot 的根目录，并确保基础目录结构存在。
 *
 * @returns cslot 根目录绝对路径。
 * @throws 当目录无法创建时抛出文件系统错误。
 */
export function getCodexSwHome(): string {
  const home = path.join(os.homedir(), ".cslot");
  const legacyHome = path.join(os.homedir(), ".codexsw");

  if (!fs.existsSync(home) && fs.existsSync(legacyHome)) {
    fs.cpSync(legacyHome, home, { recursive: true });
  }

  // 先创建 cslot 根目录，后续命令统一基于该目录读写状态。
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(home, "homes"), { recursive: true });
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });

  return home;
}

/**
 * 返回 cslot 配置文件路径。
 *
 * @returns 配置文件绝对路径。
 */
export function getConfigPath(): string {
  return path.join(getCodexSwHome(), "config.yaml");
}

/**
 * 返回后台服务 PID 文件路径。
 *
 * @returns PID 文件绝对路径。
 */
export function getPidPath(): string {
  return path.join(getCodexSwHome(), "cslot.pid");
}

/**
 * 返回后台服务日志文件路径。
 *
 * @returns 日志文件绝对路径。
 */
export function getServiceLogPath(): string {
  return path.join(getCodexSwHome(), "logs", "service.log");
}

/**
 * 将路径中的 `~` 展开为当前用户家目录。
 *
 * @param input 原始路径，允许以 `~` 开头。
 * @returns 展开后的绝对或原始路径。
 */
export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

/**
 * 读取 cslot 配置；若配置不存在则返回默认配置。
 *
 * @returns 经过 schema 校验后的配置对象。
 * @throws 当配置存在但内容非法时抛出错误。
 */
export function loadConfig(): CodexSwConfig {
  const configPath = getConfigPath();
  const legacyConfigPath = path.join(os.homedir(), ".codexsw", "config.yaml");

  if (!fs.existsSync(configPath)) {
    const defaultConfig: CodexSwConfig = {
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4389,
        api_key: "cslot-defaultkey",
        body_limit_mb: 512
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

  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = raw.trim() ? YAML.parse(raw) : {};
  const normalized = configSchema.parse(parsed);
  let changed = JSON.stringify(parsed) !== JSON.stringify(normalized);

  if (
    normalized.accounts.length === 0 &&
    fs.existsSync(legacyConfigPath)
  ) {
    const legacyRaw = fs.readFileSync(legacyConfigPath, "utf8");
    const legacyParsed = legacyRaw.trim() ? YAML.parse(legacyRaw) : {};
    const legacyConfig = configSchema.parse(legacyParsed);

    if (legacyConfig.accounts.length > 0) {
      normalized.accounts = legacyConfig.accounts;
      changed = true;
    }
  }

  // 兼容历史默认值，统一迁移到新的简短本地 key。
  if (
    normalized.server.api_key === "local-only-key" ||
    normalized.server.api_key === "codexsw-defaultkey"
  ) {
    normalized.server.api_key = "cslot-defaultkey";
    changed = true;
  }

  // 当旧配置缺少新字段时，将补全后的配置回写，便于用户直接编辑查看。
  if (changed) {
    saveConfig(normalized);
  }

  return normalized;
}

/**
 * 持久化 cslot 配置文件。
 *
 * @param config 待写入的配置对象。
 * @returns 无返回值。
 * @throws 当配置写入失败时抛出文件系统错误。
 */
export function saveConfig(config: CodexSwConfig): void {
  const configPath = getConfigPath();
  const text = YAML.stringify(config);
  fs.writeFileSync(configPath, text, "utf8");
}

/**
 * 根据账号标识生成其独立的 HOME 目录。
 *
 * @param accountId 账号标识，仅用于本地目录名。
 * @returns 该账号对应的 HOME 目录绝对路径。
 */
export function getManagedHome(accountId: string): string {
  return path.join(getCodexSwHome(), "homes", accountId);
}

/**
 * 将账号追加到配置中；若已存在相同 id 则覆盖更新。
 *
 * @param account 待写入的账号配置。
 * @returns 更新后的完整配置对象。
 */
export function upsertAccount(account: ManagedAccount): CodexSwConfig {
  const config = loadConfig();
  const index = config.accounts.findIndex((item) => item.id === account.id);

  if (index >= 0) {
    config.accounts[index] = account;
  } else {
    config.accounts.push(account);
  }

  saveConfig(config);
  return config;
}
