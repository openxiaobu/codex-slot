#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { Command } from "commander";
import {
  cloneCodexAuthState,
  registerManagedAccount,
  removeManagedAccount
} from "./account-store";
import {
  expandHome,
  getCodexSwHome,
  getManagedHome,
  getPidPath,
  getServiceLogPath,
  loadConfig,
  saveConfig
} from "./config";
import { loginManagedAccount } from "./login";
import { startServer } from "./server";
import {
} from "./state";
import { collectAccountStatuses, renderStatusTable } from "./status";
import { refreshAllAccountUsage } from "./usage-sync";

/**
 * 读取当前 CLI 的发布版本号，优先与 npm 包元数据保持一致。
 *
 * @returns string，当前包版本号；当 package.json 不可读或字段缺失时返回 `0.0.0`。
 * @throws 无显式抛出；内部异常会被吞掉并回退到默认版本号。
 */
function getCliVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, "../package.json");

    // 直接读取发布包内的 package.json，避免 CLI 版本号与 npm 发布版本脱节。
    const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8");
    const packageJson = JSON.parse(packageJsonContent) as { version?: unknown };

    if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
      return packageJson.version;
    }
  } catch {
    // 读取失败时使用保底版本，避免 `-V` 命令直接异常退出。
  }

  return "0.0.0";
}

interface StatusCommandOptions {
  interactive?: boolean;
}

/**
 * 刷新所有已录入账号的远端额度，并输出最新状态表格。
 *
 * @returns Promise，无返回值。
 */
async function handleStatus(options?: StatusCommandOptions): Promise<void> {
  await refreshAllAccountUsage();

  const statuses = collectAccountStatuses();
  console.log(renderStatusTable(statuses));

  const available = statuses.filter((item) => item.isAvailable).length;
  const fiveHourLimited = statuses.filter(
    (item) => item.isFiveHourLimited && !item.isWeeklyLimited
  ).length;
  const weeklyLimited = statuses.filter((item) => item.isWeeklyLimited).length;

  console.log("");
  console.log(`available=${available} 5h_limited=${fiveHourLimited} weekly_limited=${weeklyLimited}`);

  const interactive = options?.interactive ?? true;

  if (interactive) {
    await handleInteractiveToggle();
  }
}

async function handleInteractiveToggle(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("当前环境不支持交互式操作，请直接编辑配置文件或使用 --no-interactive 选项。");
    return;
  }

  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);
  stdin.resume();

  const config = loadConfig();
  if (config.accounts.length === 0) {
    console.log("当前没有已录入账号。");
    stdin.setRawMode?.(false);
    return;
  }

  // 按名称排序，方便浏览。
  const accounts = [...config.accounts].sort((a, b) => a.name.localeCompare(b.name));
  let cursor = 0;
  let changed = false;
  let renderedLines = 0;

  const render = () => {
    const lines: string[] = [];
    lines.push("空格切换选中账号启用状态，Enter / q 退出：");

    for (let i = 0; i < accounts.length; i += 1) {
      const account = accounts[i];
      const prefix = i === cursor ? ">" : " ";
      const checkbox = account.enabled ? "[x]" : "[ ]";
      lines.push(`${prefix} ${checkbox} ${account.name}  (${account.codex_home})`);
    }

    // 首次渲染时先换一行，避免粘在上一行输出后面。
    if (renderedLines === 0) {
      process.stdout.write("\n");
    } else {
      // 将光标移动到上一轮渲染块的起始行。
      process.stdout.write(`\x1b[${renderedLines}A`);
    }

    renderedLines = lines.length;
    process.stdout.write(lines.join("\n"));
    process.stdout.write("\n");
  };

  const applyChanges = () => {
    if (!changed) return;

    const latest = loadConfig();
    for (const account of accounts) {
      const index = latest.accounts.findIndex((item) => item.id === account.id);
      if (index >= 0) {
        latest.accounts[index] = account;
      }
    }
    saveConfig(latest);
    changed = false;
  };

  render();

  const onKeypress = (_str: string, key: readline.Key) => {
    if (key.name === "up") {
      cursor = (cursor - 1 + accounts.length) % accounts.length;
      render();
      return;
    }

    if (key.name === "down") {
      cursor = (cursor + 1) % accounts.length;
      render();
      return;
    }

    if (key.name === "space") {
      accounts[cursor].enabled = !accounts[cursor].enabled;
      changed = true;
      applyChanges();
      render();
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      if (changed) {
        applyChanges();
      }
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(false);
      console.log("\n已退出账号启用状态编辑。");
      return;
    }

    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      if (changed) {
        applyChanges();
      }
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(false);
      console.log("\n已退出账号启用状态编辑。");
      return;
    }
  };

  stdin.on("keypress", onKeypress);
}

/**
 * 将已有的 Codex HOME 目录中的登录态复制到 codexl 自己的隔离目录并纳入管理。
 *
 * @param accountId 本地账号标识。
 * @param codexHome 现有 HOME 目录；若未传则默认使用当前用户 HOME。
 * @returns 无返回值。
 */
function handleAccountImport(accountId: string, codexHome?: string): void {
  const sourceHome = codexHome ? expandHome(codexHome) : process.env.HOME ?? "";
  const managedHome = getManagedHome(accountId);

  cloneCodexAuthState(sourceHome, managedHome);

  const account = registerManagedAccount(accountId, managedHome);
  console.log(`账号已导入: ${account.id}`);
  console.log(`来源 HOME: ${sourceHome}`);
  console.log(`已复制到: ${account.codex_home}`);
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

  applyManagedCodexConfig();

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
    deactivateManagedCodexConfig();
    return;
  }

  process.kill(pid, "SIGTERM");
  fs.rmSync(getPidPath(), { force: true });
  deactivateManagedCodexConfig();
  console.log(`服务已停止，PID=${pid}`);
}

/**
 * 对正则元字符做转义，供动态构造匹配模式使用。
 *
 * @param input 原始字符串。
 * @returns 经过转义后的安全正则片段。
 */
function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeFileAtomic(targetFile: string, content: string): void {
  ensureParentDir(targetFile);
  const tmpFile = `${targetFile}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, targetFile);
}

/**
 * 返回默认的 `codex config.toml` 路径。
 *
 * @returns 默认 `config.toml` 绝对路径。
 */
function getDefaultCodexConfigPath(): string {
  return path.join(process.env.HOME ?? "", ".codex", "config.toml");
}

/**
 * 生成 codexl provider 配置块。
 *
 * @returns 可直接写入 `config.toml` 的配置块内容。
 */
function buildManagedConfigBlock(): string {
  const config = loadConfig();

  return [
    "[model_providers.codexl]",
    'name = "codexl"',
    `base_url = "http://${config.server.host}:${config.server.port}/v1"`,
    `http_headers = { Authorization = "Bearer ${config.server.api_key}" }`,
    'wire_api = "responses"'
  ].join("\n");
}

/**
 * 将 codexl provider 配置写入指定的 codex config.toml。
 *
 * @param targetPathOrDir 可选的 codex 配置目录或 config.toml 文件路径。
 * @returns 实际写入的 `config.toml` 文件路径。
 */
function applyManagedCodexConfig(
  targetPathOrDir?: string,
  options?: { silent?: boolean }
): string {
  const rawTarget = targetPathOrDir ? expandHome(targetPathOrDir) : getDefaultCodexConfigPath();
  const targetFile = rawTarget.endsWith(".toml") ? rawTarget : path.join(rawTarget, "config.toml");
  const block = buildManagedConfigBlock();

  let original = "";
  if (fs.existsSync(targetFile)) {
    original = fs.readFileSync(targetFile, "utf8");
  }

  // 更稳定的策略：仅按 provider 名称和 model_provider 改动，不引入额外的 marker。
  const lines = original.length > 0 ? original.split(/\r?\n/) : [];
  let replacedModelProvider = false;
  const modelProviderLine = 'model_provider = "codexl"';

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    // 优先替换被注释掉的默认行（只替换第一处，减少对用户文件的干扰）。
    if (!replacedModelProvider && /^#\s*model_provider\s*=/.test(trimmed)) {
      lines[i] = modelProviderLine;
      replacedModelProvider = true;
      continue;
    }

    // 替换真实生效的 model_provider 行。
    if (/^model_provider\s*=/.test(trimmed) && !trimmed.startsWith("#")) {
      lines[i] = modelProviderLine;
      replacedModelProvider = true;
      continue;
    }
  }

  if (!replacedModelProvider) {
    const firstNonEmptyIndex = lines.findIndex((line) => line.trim() !== "");
    if (firstNonEmptyIndex >= 0) {
      lines.splice(firstNonEmptyIndex, 0, modelProviderLine, "");
    } else {
      lines.push(modelProviderLine, "");
    }
  }

  // 替换或追加 [model_providers.codexl] 这一段配置。
  const blockLines = block.split("\n");
  let insertAfterIndex = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (trimmed === "[model_providers.codexl]") {
      let j = i;

      while (j < lines.length) {
        const currentTrimmed = lines[j].trim();

        if (j > i && currentTrimmed.startsWith("[") && !currentTrimmed.startsWith("[[")) {
          break;
        }

        insertAfterIndex = j;
        j += 1;
      }

      // 删除旧的 codexl provider 表块，准备写入新的。
      lines.splice(i, j - i);
      insertAfterIndex = i - 1;
      i = j - 1;
    }
  }

  if (insertAfterIndex >= 0) {
    lines.splice(insertAfterIndex + 1, 0, "", ...blockLines);
  } else {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
      lines.push("");
    }
    lines.push(...blockLines);
  }

  const nextContent = `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
  writeFileAtomic(targetFile, nextContent);

  if (!options?.silent) {
    const config = loadConfig();
    console.log(`已写入: ${targetFile}`);
    console.log(`base_url=http://${config.server.host}:${config.server.port}/v1`);
    console.log(`api_key=${config.server.api_key}`);
    console.log("提示: start 会自动接管 codex provider，stop 会自动恢复。");
  }

  return targetFile;
}

/**
 * 关闭 codexl 作为当前默认 provider 的接管状态。
 *
 * @returns 无返回值。
 */
function deactivateManagedCodexConfig(): void {
  const targetFile = getDefaultCodexConfigPath();

  if (!fs.existsSync(targetFile)) {
    return;
  }

  const original = fs.readFileSync(targetFile, "utf8");
  const nextContent = original.replace(
    /^(\s*)model_provider\s*=\s*"codexl"\s*$/m,
    '$1# model_provider = "codexl"'
  );

  if (nextContent !== original) {
    fs.writeFileSync(targetFile, nextContent, "utf8");
    console.log(`已更新: ${targetFile}`);
  }
}

/**
 * CLI 主入口，负责命令注册与执行。
 *
 * @returns Promise，无返回值。
 * @throws 当命令执行失败时向上抛出异常。
 */
async function main(): Promise<void> {
  const program = new Command();
  // 禁用内置 help 子命令，仅保留 --help / -h 形式。
  program.addHelpCommand(false);
  getCodexSwHome();
  loadConfig();

  program
    .name("codexl")
    .description("本地 Codex 多账号切换与状态管理工具")
    .version(getCliVersion());

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
    .option("--no-interactive", "仅输出状态表，不进入交互式切换")
    .action(async (options: StatusCommandOptions) => {
      await handleStatus(options);
    });
  program
    .command("start")
    .description("后台启动本地代理服务")
    .option("--port <port>", "监听端口")
    .action(async (options: { port: string }) => {
      await handleStart(options.port);
    });
  program.command("stop").description("停止后台代理服务").action(handleStop);

  await program.parseAsync(process.argv);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codexl 执行失败: ${message}`);
  process.exit(1);
});
