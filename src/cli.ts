#!/usr/bin/env node
import { Command } from "commander";
import {
  handleAccountImport,
  handleAccountLogin,
  handleAccountRemoveCommand,
  handleAccountRename
} from "./account-commands";
import { getCliVersion } from "./cli-helpers";
import { getCslotHome, loadConfig } from "./config";
import { handleStart, handleStop } from "./service-control";
import { handleStatus, type StatusCommandOptions } from "./status-command";
import { bi } from "./text";

/**
 * 为 CLI 程序注册根级帮助信息与统一示例。
 *
 * @param program Commander 程序实例。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function configureRootProgram(program: Command): void {
  program
    .name("codex-slot")
    .description(bi("本地 Codex 多账号切换与状态管理工具", "Local Codex multi-account switcher"))
    .helpOption("-h, --help", bi("显示帮助", "Show help"))
    .version(getCliVersion());

  program.addHelpText(
    "after",
    [
      "",
      `${bi("示例", "Examples")}:`,
      "  cslot import work ~/workspace-home",
      "  cslot rename work work-main",
      "  cslot start --port 4399",
      "  cslot status --no-interactive",
      "",
      `${bi("说明", "Notes")}:`,
      `  ${bi(
        "`import current ~` 里的 current 只是示例槽位名，不是内置账号。",
        "`current` in `import current ~` is only an example slot name, not a built-in account."
      )}`
    ].join("\n")
  );
}

/**
 * 注册账号相关子命令。
 *
 * @param program Commander 程序实例。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function registerAccountCommands(program: Command): void {
  program
    .command("add")
    .description(bi("登录并新增一个账号或工作空间", "Login and add a managed slot"))
    .argument("<name>", bi("账号标识（本地槽位名）", "Local slot name"))
    .action(async (name: string) => {
      await handleAccountLogin(name);
    });

  program
    .command("del")
    .description(bi("删除一个已录入账号", "Remove a managed slot"))
    .argument("[name]", bi("账号标识（本地槽位名），留空时列出全部", "Local slot name"))
    .action(handleAccountRemoveCommand);

  program
    .command("import")
    .description(
      bi(
        "导入当前或指定 HOME 下的官方 codex 登录态",
        "Import official Codex auth state from the current or specified HOME"
      )
    )
    .argument("<name>", bi("账号标识（本地槽位名，例如 work/current）", "Local slot name, for example work/current"))
    .argument("[codexHome]", bi("已有 HOME 目录，默认当前用户 HOME", "Source HOME, defaults to the current user HOME"))
    .addHelpText(
      "after",
      [
        "",
        `${bi("说明", "Note")}:`,
        `  ${bi(
          "name 是你自定义的槽位名；`current` 不是系统保留字。",
          "`name` is your custom slot name; `current` is not a reserved keyword."
        )}`
      ].join("\n")
    )
    .action(handleAccountImport);

  program
    .command("rename")
    .description(bi("重命名一个已录入账号", "Rename a managed slot"))
    .argument("<oldName>", bi("原槽位名", "Old slot name"))
    .argument("<newName>", bi("新槽位名", "New slot name"))
    .action(handleAccountRename);
}

/**
 * 注册配置与状态相关子命令。
 *
 * @param program Commander 程序实例。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function registerRuntimeCommands(program: Command): void {
  program
    .command("status")
    .description(bi("刷新并查看所有已录入账号或工作空间的最新额度", "Refresh usage for all managed slots"))
    .option("--no-interactive", bi("仅输出状态表，不进入交互式切换", "Print only"))
    .action(async (options: StatusCommandOptions) => {
      await handleStatus(options);
    });

  program
    .command("start")
    .description(bi("后台启动本地代理服务", "Start the local proxy in background"))
    .option("--port <port>", bi("监听端口；会同步写入本地配置", "Listen port and save it to local config"))
    .addHelpText(
      "after",
      [
        "",
        `${bi("说明", "Notes")}:`,
        `  ${bi(
          "start 会自动接管 `~/.codex/config.toml`，并在指定端口时自动写入该端口；stop 会恢复接管前内容。",
          "`start` will manage `~/.codex/config.toml` automatically, write the specified port when provided, and `stop` will restore the previous content."
        )}`,
      ].join("\n")
    )
    .action(async (options: { port?: string }) => {
      await handleStart(options.port);
    });

  program
    .command("stop")
    .description(bi("停止后台代理服务并恢复 codex 配置", "Stop the proxy and restore Codex config"))
    .action(handleStop);
}

/**
 * CLI 主入口，负责初始化环境、注册命令并交给 Commander 分发执行。
 *
 * @returns Promise，无返回值。
 * @throws 当命令执行失败时向上抛出异常。
 */
async function main(): Promise<void> {
  const program = new Command();
  program.addHelpCommand(false);

  getCslotHome();
  loadConfig();

  configureRootProgram(program);
  registerAccountCommands(program);
  registerRuntimeCommands(program);

  await program.parseAsync(process.argv);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(bi(`codex-slot 执行失败: ${message}`, `codex-slot failed: ${message}`));
  process.exit(1);
});
