#!/usr/bin/env node
import fs from "node:fs";
import { getPidPath, loadConfig } from "./config";
import { startServer } from "./server";
import { bi } from "./text";

/**
 * 将当前服务进程 PID 持久化到本地状态文件，供 `cslot stop` 与健康检查流程复用。
 *
 * @returns 无返回值。
 * @throws 当 PID 文件写入失败时抛出文件系统错误。
 */
function writeCurrentPid(): void {
  fs.writeFileSync(getPidPath(), `${process.pid}\n`, "utf8");
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

  await startServer(port);
}

void main().catch((error: unknown) => {
  cleanupPidFile();
  const message = error instanceof Error ? error.message : String(error);
  console.error(bi(`cslot service 启动失败: ${message}`, `cslot service failed to start: ${message}`));
  process.exit(1);
});
