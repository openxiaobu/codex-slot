#!/usr/bin/env node
import fs from "node:fs";
import { getPidPath, loadConfig } from "./config";
import { writePrivateFileAtomic } from "./private-file";
import { startServer } from "./server";
import { bi } from "./text";

/**
 * 将当前服务进程 PID 持久化到本地状态文件，供 `cslot stop` 与健康检查流程复用。
 *
 * @returns 无返回值。
 * @throws 当 PID 文件写入失败时抛出文件系统错误。
 */
function writeCurrentPid(): void {
  writePrivateFileAtomic(getPidPath(), `${process.pid}\n`);
}

/**
 * 按幂等方式清理当前服务进程留下的 PID 文件，避免异常退出后残留脏状态。
 *
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function cleanupPidFile(): void {
  try {
    const pidPath = getPidPath();

    if (!fs.existsSync(pidPath)) {
      return;
    }

    const raw = fs.readFileSync(pidPath, "utf8").trim();

    if (Number(raw) === process.pid) {
      fs.rmSync(pidPath, { force: true });
    }
  } catch {
    // 退出清理阶段以幂等为主，不阻塞真实退出流程。
  }
}

/**
 * 注册服务进程退出时的 PID 清理逻辑，兼容正常停止与 launchd 重启场景。
 *
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function registerPidCleanupHandlers(): void {
  process.once("exit", cleanupPidFile);
  process.once("SIGINT", () => {
    cleanupPidFile();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanupPidFile();
    process.exit(0);
  });
}

/**
 * 注册进程级兜底异常处理，避免单次请求中的意外异常（如上游连接被网络代理
 * 中途掐断）导致整个 cslot 后台服务进程崩溃退出。
 *
 * 业务权衡：cslot 是本地长驻代理服务，单次请求失败应尽量只影响这一次请求，
 * 而不是让整个服务下线等待外部重启（尤其当所在环境无法使用 schtasks 等
 * 具备自动拉起能力的托管方式时，进程一旦退出可能长时间无人恢复）。
 *
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function registerProcessSafetyNet(): void {
  process.on("uncaughtException", (error: Error) => {
    console.error(bi(`cslot 捕获到未处理异常，已忽略并继续运行: ${error.stack ?? error.message}`, `cslot caught an uncaught exception, ignored and continuing: ${error.stack ?? error.message}`));
  });

  process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    console.error(bi(`cslot 捕获到未处理的 Promise 拒绝，已忽略并继续运行: ${message}`, `cslot caught an unhandled promise rejection, ignored and continuing: ${message}`));
  });
}

/**
 * 后台服务进程入口。
 *
 * @returns Promise，无返回值。
 * @throws 当端口参数非法或服务启动失败时抛出异常。
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const portArgIndex = process.argv.findIndex((item) => item === "--port");
  const port =
    portArgIndex >= 0 && process.argv[portArgIndex + 1]
      ? Number(process.argv[portArgIndex + 1])
      : config.server.port;

  writeCurrentPid();
  registerPidCleanupHandlers();
  registerProcessSafetyNet();

  await startServer(port);
}

void main().catch((error: unknown) => {
  cleanupPidFile();
  const message = error instanceof Error ? error.message : String(error);
  console.error(bi(`cslot service 启动失败: ${message}`, `cslot service failed to start: ${message}`));
  process.exit(1);
});
