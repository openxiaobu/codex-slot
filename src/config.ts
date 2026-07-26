import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { withFileLockSync } from "./file-lock";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writePrivateFileAtomic
} from "./private-file";
import type { CslotConfig, ManagedAccount } from "./types";

const managedAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  codex_home: z.string().min(1),
  email: z.string().email().optional(),
  enabled: z.boolean().default(true),
  imported_at: z.string().optional()
});

const relaySlotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  base_url: z.string().url(),
  api_key: z.string().min(1),
  enabled: z.boolean().default(true),
  imported_at: z.string().optional()
});

const configSchema = z.object({
  version: z.number().int().default(1),
  server: z
    .object({
      host: z.string().default("127.0.0.1"),
      port: z.number().int().default(4399),
      body_limit_mb: z.number().positive().default(512)
    })
    .default({
      host: "127.0.0.1",
      port: 4399,
      body_limit_mb: 512
    }),
  upstream: z
    .object({
      codex_base_url: z.string().default("https://chatgpt.com/backend-api/codex"),
      chatgpt_base_url: z.string().default("https://chatgpt.com/backend-api"),
      auth_base_url: z.string().default("https://auth.openai.com"),
      oauth_client_id: z.string().default("app_EMoamEEZ73f0CkXaXp7hrann")
    })
    .default({
      codex_base_url: "https://chatgpt.com/backend-api/codex",
      chatgpt_base_url: "https://chatgpt.com/backend-api",
      auth_base_url: "https://auth.openai.com",
      oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
    }),
  accounts: z.array(managedAccountSchema).default([]),
  relay_slots: z.array(relaySlotSchema).default([])
});

/**
 * 解析当前进程应使用的用户 HOME 目录，兼容 Windows 缺少 `HOME` 的场景。
 *
 * 业务背景：部分 shell / 启动脚本会把 `HOME` 写成带尾随空格的值
 * （例如 `C:\Users\aihelp `）。Windows 上这种路径无法创建目录，会直接导致
 * `mkdir '...\.cslot'` 以 `EPERM` 失败，服务表现为“启动超时”。
 *
 * @returns 当前用户 HOME 目录；优先复用显式环境变量，兜底使用 `os.homedir()`。
 */
export function getUserHomeDir(): string {
  const raw = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return raw.trim();
}

/**
 * 返回 cslot 的根目录，并确保基础目录结构存在。
 *
 * @returns cslot 根目录绝对路径。
 * @throws 当目录无法创建时抛出文件系统错误。
 */
export function getCslotHome(): string {
  const home = path.join(getUserHomeDir(), ".cslot");

  // 先创建 cslot 根目录，后续命令统一基于该目录读写状态。
  ensurePrivateDirectory(home);
  ensurePrivateDirectory(path.join(home, "homes"));
  ensurePrivateDirectory(path.join(home, "logs"));
  ensurePrivateDirectory(path.join(home, "locks"));

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
  const homeDir = getUserHomeDir();

  if (input === "~") {
    return homeDir;
  }

  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }

  return input;
}

/**
 * 构造一份完整的默认 cslot 配置。
 *
 * @returns 当前版本默认配置；调用方可安全原地修改。
 * @throws 无显式抛出。
 */
function createDefaultConfig(): CslotConfig {
  return {
    version: 1,
    server: {
      host: "127.0.0.1",
      port: 4399,
      body_limit_mb: 512
    },
    upstream: {
      codex_base_url: "https://chatgpt.com/backend-api/codex",
      chatgpt_base_url: "https://chatgpt.com/backend-api",
      auth_base_url: "https://auth.openai.com",
      oauth_client_id: "app_EMoamEEZ73f0CkXaXp7hrann"
    },
    accounts: [],
    relay_slots: []
  };
}

/**
 * 读取并归一化配置文件，不主动获取配置锁或回写迁移结果。
 *
 * @param configPath 配置文件绝对路径。
 * @returns 归一化配置及是否需要回写；文件不存在时返回默认配置并标记需要回写。
 * @throws 当配置内容不是合法 YAML 或不满足 schema 时抛出解析错误。
 */
function loadConfigUnlocked(configPath: string): {
  config: CslotConfig;
  changed: boolean;
} {
  if (!fs.existsSync(configPath)) {
    return {
      config: createDefaultConfig(),
      changed: true
    };
  }

  ensurePrivateFile(configPath);
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = raw.trim() ? YAML.parse(raw) : {};
  const normalized = configSchema.parse(parsed);

  return {
    config: normalized,
    changed: JSON.stringify(parsed) !== JSON.stringify(normalized)
  };
}

/**
 * 在调用方已经持有配置锁时原子保存配置。
 *
 * @param configPath 配置文件绝对路径。
 * @param config 待校验并写入的完整配置。
 * @returns 经过 schema 归一化后的配置对象。
 * @throws 当 schema 校验或原子写入失败时抛出异常。
 */
function saveConfigUnlocked(configPath: string, config: CslotConfig): CslotConfig {
  const normalized = configSchema.parse(config);
  writePrivateFileAtomic(configPath, YAML.stringify(normalized));
  return normalized;
}

/**
 * 读取 cslot 配置；若配置不存在则返回默认配置。
 *
 * @returns 经过 schema 校验后的配置对象。
 * @throws 当配置存在但内容非法时抛出错误。
 */
export function loadConfig(): CslotConfig {
  const configPath = getConfigPath();
  const initial = loadConfigUnlocked(configPath);

  if (!initial.changed) {
    return initial.config;
  }

  const lockPath = path.join(getCslotHome(), "locks", "config.lock");

  return withFileLockSync(lockPath, () => {
    const latest = loadConfigUnlocked(configPath);

    // 当旧配置缺少新字段时，将补全后的配置回写，便于用户直接编辑查看。
    return latest.changed
      ? saveConfigUnlocked(configPath, latest.config)
      : latest.config;
  });
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
  const lockPath = path.join(getCslotHome(), "locks", "config.lock");

  withFileLockSync(lockPath, () => {
    saveConfigUnlocked(configPath, config);
  });
}

/**
 * 在跨进程锁内读取最新配置、执行修改并原子保存。
 *
 * @param mutator 配置修改函数；只能修改传入的最新配置对象。
 * @returns 修改后经过 schema 校验并持久化的完整配置。
 * @throws 当锁等待、配置读取、修改或写入失败时透传异常。
 */
export function updateConfig(mutator: (config: CslotConfig) => void): CslotConfig {
  const configPath = getConfigPath();
  const lockPath = path.join(getCslotHome(), "locks", "config.lock");

  return withFileLockSync(lockPath, () => {
    const latest = loadConfigUnlocked(configPath).config;
    mutator(latest);
    return saveConfigUnlocked(configPath, latest);
  });
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
  return updateConfig((config) => {
    const index = config.accounts.findIndex((item) => item.id === account.id);

    if (index >= 0) {
      config.accounts[index] = account;
    } else {
      config.accounts.push(account);
    }
  });
}
