import fs from "node:fs";
import path from "node:path";
import { bi } from "./text";

/**
 * 读取当前 CLI 的发布版本号，优先与 npm 包元数据保持一致。
 *
 * @returns 当前包版本号；当 `package.json` 不可读或字段缺失时返回 `0.0.0`。
 * @throws 无显式抛出；内部异常会被吞掉并回退到默认版本号。
 */
export function getCliVersion(): string {
  try {
    const packageJsonPath = path.resolve(__dirname, "../package.json");
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

/**
 * 校验并解析端口参数，避免将非法值写入配置或用于启动服务。
 *
 * @param rawPort 命令行传入的端口文本。
 * @returns 合法的监听端口。
 * @throws 当端口为空、非数字或超出合法范围时抛出异常。
 */
export function parsePort(rawPort: string): number {
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(bi(`非法端口: ${rawPort}`, `Invalid port: ${rawPort}`));
  }

  return port;
}
