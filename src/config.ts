import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import type { CslotConfig, ManagedAccount } from "./types";

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
      port: z.number().int().default(4399),
      api_key: z.string().default("cslot-defaultkey"),
      body_limit_mb: z.number().positive().default(512)
    })
    .default({
      host: "127.0.0.1",
      port: 4399,
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
 * 生成新的本地服务 API Key。
 *
 * 该 key 仅用于本地代理服务与受管 `~/.codex/config.toml` 之间的鉴权，
 * 不会影响上游官方 access token。
 *
 * @returns 随机生成的本地 API Key。
 */
export function generateServerApiKey(): string {
  return `cslot-${crypto.randomBytes(18).toString("hex")}`;
}

/**
 * 返回 cslot 的根目录，并确保基础目录结构存在。
 *
 * @returns cslot 根目录绝对路径。
 * @throws 当目录无法创建时抛出文件系统错误。
 */
export function getCslotHome(): string {
  const home = path.join(os.homedir(), ".cslot");

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
  return path.join(getCslotHome(), "config.yaml");
}

/**
 * 返回后台服务 PID 文件路径。
 *
 * @returns PID 文件绝对路径。
 */
export function getPidPath(): string {
  return path.join(getCslotHome(), "cslot.pid");
}

/**
 * 返回后台服务日志文件路径。
 *
 * @returns 日志文件绝对路径。
 */
export function getServiceLogPath(): string {
  return path.join(getCslotHome(), "logs", "service.log");
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
export function loadConfig(): CslotConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    const defaultApiKey = generateServerApiKey();
    const defaultConfig: CslotConfig = {
      version: 1,
      server: {
        host: "127.0.0.1",
        port: 4399,
        api_key: defaultApiKey,
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
    (!parsed || typeof parsed !== "object" || !("server" in parsed)) ||
    !(parsed.server && typeof parsed.server === "object" && "api_key" in parsed.server)
  ) {
    normalized.server.api_key = generateServerApiKey();
    changed = true;
  }

  // 兼容历史默认值，统一迁移到新的随机本地 key。
  if (
    normalized.server.api_key === "local-only-key" ||
    normalized.server.api_key === "cslot-defaultkey"
  ) {
    normalized.server.api_key = generateServerApiKey();
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
export function saveConfig(config: CslotConfig): void {
  const configPath = getConfigPath();
  const text = YAML.stringify(config);
  fs.writeFileSync(configPath, text, "utf8");
}

/**
 * 刷新本地代理服务 API Key，并将结果写回配置文件。
 *
 * 业务语义：
 * 1. 每次真正启动本地代理前都重新生成一个新的本地 key。
 * 2. 该 key 会同时驱动本地服务鉴权与 `~/.codex/config.toml` 中的 provider 头。
 * 3. 若调用方已经持有最新配置对象，可直接传入，避免重复读取磁盘。
 *
 * @param config 可选的当前配置对象；未传入时会自动从磁盘读取。
 * @returns 已写回磁盘的最新配置对象，其中 `server.api_key` 一定是新值。
 * @throws 当配置读写失败时抛出文件系统错误。
 */
export function rotateServerApiKey(config?: CslotConfig): CslotConfig {
  const nextConfig = config ?? loadConfig();

  // 每次启动前轮换本地鉴权 key，避免长期复用同一个静态口令。
  nextConfig.server.api_key = generateServerApiKey();
  saveConfig(nextConfig);

  return nextConfig;
}

/**
 * 根据账号标识生成其独立的 HOME 目录。
 *
 * @param accountId 账号标识，仅用于本地目录名。
 * @returns 该账号对应的 HOME 目录绝对路径。
 */
export function getManagedHome(accountId: string): string {
  return path.join(getCslotHome(), "homes", accountId);
}

/**
 * 将账号追加到配置中；若已存在相同 id 则覆盖更新。
 *
 * @param account 待写入的账号配置。
 * @returns 更新后的完整配置对象。
 */
export function upsertAccount(account: ManagedAccount): CslotConfig {
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
