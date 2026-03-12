#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const config_1 = require("./config");
const server_1 = require("./server");
/**
 * 后台服务进程入口。
 *
 * @returns Promise，无返回值。
 * @throws 当端口参数非法或服务启动失败时抛出异常。
 */
async function main() {
    const config = (0, config_1.loadConfig)();
    const portArgIndex = process.argv.findIndex((item) => item === "--port");
    const port = portArgIndex >= 0 && process.argv[portArgIndex + 1]
        ? Number(process.argv[portArgIndex + 1])
        : config.server.port;
    await (0, server_1.startServer)(port);
}
void main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`codexl service 启动失败: ${message}`);
    process.exit(1);
});
