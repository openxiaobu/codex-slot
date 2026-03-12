#!/usr/bin/env node
import { loadConfig } from "./config";
import { startServer } from "./server";

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

  await startServer(port);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`codexl service 启动失败: ${message}`);
  process.exit(1);
});
