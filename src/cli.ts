#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { Command } from "commander";
import { registerManagedAccount, removeManagedAccount } from "./account-store";
import {
  expandHome,
  getCodexSwHome,
  getPidPath,
  getServiceLogPath,
  loadConfig,
  saveConfig
} from "./config";
import { loginManagedAccount } from "./login";
import { startServer } from "./server";
import { collectAccountStatuses, renderStatusTable } from "./status";
import { refreshAllAccountUsage } from "./usage-sync";

/**
 * 刷新所有已录入账号的远端额度，并输出最新状态表格。
 *
 * @returns Promise，无返回值。
 */
async function handleStatus(): Promise<void> {
  await refreshAllAccountUsage();

  const statuses = collectAccountStatuses();
  console.log(renderStatusTable(statuses));

  const available = statuses.filter((item) => item.isAvailable).length;
  const cooldown = statuses.filter((item) => item.isFiveHourLimited && !item.isWeeklyLimited).length;
  const weeklyLimited = statuses.filter((item) => item.isWeeklyLimited).length;

  console.log("");
  console.log(`available=${available} cooldown=${cooldown} weekly_limited=${weeklyLimited}`);
}

/**
 * 将已有的 Codex HOME 目录纳入 codexl 管理。
 *
 * @param accountId 本地账号标识。
 * @param codexHome 现有 HOME 目录；若未传则默认使用当前用户 HOME。
 * @returns 无返回值。
 */
function handleAccountImport(accountId: string, codexHome?: string): void {
  const home = codexHome ? expandHome(codexHome) : process.env.HOME ?? "";
  const account = registerManagedAccount(accountId, home);
  console.log(`账号已导入: ${account.id}`);
  console.log(`来源 HOME: ${account.codex_home}`);
}

/**
 * 执行隔离登录流程，将账号录入到 codexl 管理目录。
 *
 * @param accountId 本地账号标识。
 * @returns Promise，无返回值。
 */
async function handleAccountLogin(accountId: string): Promise<void> {
  const home = await loginManagedAccount(accountId);
  console.log(`登录完成，账号目录: ${home}`);
}

/**
 * 删除配置中的账号项。
 *
 * @param accountId 本地账号标识。
 * @returns 无返回值。
 * @throws 当账号不存在时抛出错误。
 */
function handleAccountRemove(accountId: string): void {
  const removed = removeManagedAccount(accountId);

  if (!removed) {
    throw new Error(`未找到账号 ${accountId}`);
  }

  console.log(`已删除账号配置: ${removed.id}`);
}

/**
 * 判断后台服务当前是否在运行。
 *
 * @returns 运行中的 PID；未运行时返回 `null`。
 */
function getRunningPid(): number | null {
  const pidPath = getPidPath();

  if (!fs.existsSync(pidPath)) {
    return null;
  }

  const raw = fs.readFileSync(pidPath, "utf8").trim();
  const pid = Number(raw);

  if (!Number.isInteger(pid) || pid <= 0) {
    fs.rmSync(pidPath, { force: true });
    return null;
  }

  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.rmSync(pidPath, { force: true });
    return null;
  }
}

/**
 * 后台启动 codexl 服务并写入 PID 文件。
 *
 * @returns Promise，无返回值。
 * @throws 当服务已在运行或子进程启动失败时抛出异常。
 */
async function handleStart(portOverride?: string): Promise<void> {
  const config = loadConfig();
  const port = portOverride ? Number(portOverride) : config.server.port;

  if (portOverride) {
    config.server.port = port;
    saveConfig(config);
  }

  const runningPid = getRunningPid();

  if (runningPid) {
    console.log(`服务已在运行，PID=${runningPid}`);
    if (portOverride) {
      console.log(`已将新端口写入配置: ${port}`);
      console.log("请先执行 codexl stop，再执行 codexl start 使新端口生效。");
    }
    return;
  }
  const logPath = getServiceLogPath();
  const logFd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, [__filename.replace(/cli\.js$/, "serve.js"), "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });

  child.unref();
  fs.writeFileSync(getPidPath(), `${child.pid}\n`, "utf8");

  console.log(`服务已启动: http://${config.server.host}:${port}`);
  console.log(`PID: ${child.pid}`);
  console.log(`日志: ${logPath}`);
}

/**
 * 停止后台运行的 codexl 服务。
 *
 * @returns 无返回值。
 */
function handleStop(): void {
  const pid = getRunningPid();

  if (!pid) {
    console.log("服务未运行");
    return;
  }

  process.kill(pid, "SIGTERM");
  fs.rmSync(getPidPath(), { force: true });
  console.log(`服务已停止，PID=${pid}`);
}

/**
 * 输出当前 `codex` 需要的 provider 配置与本地 key 信息。
 *
 * @returns 无返回值。
 */
function handleGetConfig(): void {
  const config = loadConfig();

  console.log(`base_url=${`http://${config.server.host}:${config.server.port}/v1`}`);
  console.log(`api_key=${config.server.api_key}`);
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 将 codexl provider 配置写入指定的 codex config.toml。
 *
 * @param targetPathOrDir 可选的 codex 配置目录或 config.toml 文件路径。
 * @returns 无返回值。
 */
function handleConfig(targetPathOrDir?: string): void {
  const config = loadConfig();
  const rawTarget = targetPathOrDir ? expandHome(targetPathOrDir) : path.join(process.env.HOME ?? "", ".codex", "config.toml");
  const targetFile = rawTarget.endsWith(".toml") ? rawTarget : path.join(rawTarget, "config.toml");
  const startMarker = "# >>> codexl managed start >>>";
  const endMarker = "# <<< codexl managed end <<<";
  const block = [
    startMarker,
    "[model_providers.codexl]",
    'name = "codexl"',
    `base_url = "http://${config.server.host}:${config.server.port}/v1"`,
    `http_headers = { Authorization = "Bearer ${config.server.api_key}" }`,
    'wire_api = "responses"',
    endMarker
  ].join("\n");

  let original = "";
  if (fs.existsSync(targetFile)) {
    original = fs.readFileSync(targetFile, "utf8");
  } else {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  }

  const managedBlockPattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n?`,
    "g"
  );
  const lines = original.replace(managedBlockPattern, "").split(/\r?\n/);
  let insertAfterIndex = -1;
  let hasGlobalModelProvider = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();

    if (/^#\s*model_provider\s*=/.test(trimmed)) {
      lines[i] = 'model_provider = "codexl"';
      hasGlobalModelProvider = true;
      continue;
    }

    if (trimmed.startsWith("#")) {
      continue;
    }

    if (/^model_provider\s*=/.test(trimmed)) {
      lines[i] = 'model_provider = "codexl"';
      hasGlobalModelProvider = true;
      continue;
    }

    if (trimmed === "[model_providers.codexl]") {
      let j = i;

      while (j < lines.length) {
        const current = lines[j];
        const currentTrimmed = current.trim();

        if (j > i && currentTrimmed.startsWith("[") && !currentTrimmed.startsWith("[[")) {
          break;
        }

        insertAfterIndex = j;
        j += 1;
      }

      lines.splice(i, j - i);
      insertAfterIndex = i - 1;
      i = j - 1;
    }
  }

  const blockLines = block.split("\n");
  if (insertAfterIndex >= 0) {
    lines.splice(insertAfterIndex + 1, 0, "", ...blockLines);
  } else {
    if (!hasGlobalModelProvider) {
      const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== "");

      if (firstNonEmptyIndex >= 0) {
        lines.splice(firstNonEmptyIndex, 0, 'model_provider = "codexl"', "");
      } else {
        lines.push('model_provider = "codexl"', "");
      }
    }

    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(...blockLines);
  }

  const nextContent = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;

  fs.writeFileSync(targetFile, nextContent, "utf8");

  console.log(`已写入: ${targetFile}`);
  console.log(`base_url=http://${config.server.host}:${config.server.port}/v1`);
  console.log(`api_key=${config.server.api_key}`);
  console.log('提示: 已写入 codexl provider；如果原来存在 model_provider，则已切换为 codexl；model 保持不变。');
}

/**
 * CLI 主入口，负责命令注册与执行。
 *
 * @returns Promise，无返回值。
 * @throws 当命令执行失败时向上抛出异常。
 */
async function main(): Promise<void> {
  const program = new Command();
  getCodexSwHome();
  loadConfig();

  program
    .name("codexsw")
    .name("codexl")
    .description("本地 Codex 多账号切换与状态管理工具")
    .version("0.1.0");

  program
    .command("add")
    .description("登录并新增一个账号或工作空间")
    .argument("<accountId>", "账号标识")
    .action(async (accountId: string) => {
      await handleAccountLogin(accountId);
    });
  program
    .command("del")
    .description("删除一个已录入账号")
    .argument("<accountId>", "账号标识")
    .action(handleAccountRemove);
  program
    .command("import")
    .description("导入当前或指定 HOME 下的官方 codex 登录态")
    .argument("<accountId>", "账号标识")
    .argument("[codexHome]", "已有 HOME 目录，默认当前用户 HOME")
    .action(handleAccountImport);
  program
    .command("status")
    .description("刷新并查看所有已录入账号或工作空间的最新额度")
    .action(async () => {
      await handleStatus();
    });
  program
    .command("start")
    .description("后台启动本地代理服务")
    .option("--port <port>", "监听端口")
    .action(async (options: { port: string }) => {
      await handleStart(options.port);
    });
  program.command("stop").description("停止后台代理服务").action(handleStop);
  program.command("get").description("输出当前 base_url 和 api_key").action(handleGetConfig);
  program
    .command("config")
    .description("自动写入 codex 的 config.toml，默认 ~/.codex/config.toml")
    .argument("[codexPath]", "codex 配置目录或 config.toml 文件路径")
    .action(handleConfig);

  await program.parseAsync(process.argv);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codexl 执行失败: ${message}`);
  process.exit(1);
});
