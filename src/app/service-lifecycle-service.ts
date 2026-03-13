import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { applyManagedCodexConfig, deactivateManagedCodexConfig } from "../codex-config";
import { parsePort } from "../cli-helpers";
import { getPidPath, getServiceLogPath, loadConfig, saveConfig } from "../config";

/**
 * 判断后台服务当前是否在运行。
 *
 * @returns 运行中的 PID；未运行时返回 `null`。
 * @throws 无显式抛出。
 */
export function getRunningPid(): number | null {
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
 * 解析后台服务启动入口，兼容源码运行与构建产物运行两种场景。
 *
 * @returns 可直接传给 `spawn` 的命令与参数前缀。
 * @throws 无显式抛出。
 */
function resolveServeEntrypoint(): { command: string; args: string[] } {
  const serveBasePath = path.resolve(__dirname, "..", "serve");

  if (path.extname(__filename) === ".ts") {
    return {
      command: process.platform === "win32" ? "npx.cmd" : "npx",
      args: ["tsx", `${serveBasePath}.ts`]
    };
  }

  return {
    command: process.execPath,
    args: [`${serveBasePath}.js`]
  };
}

/**
 * 启动后台服务，并在需要时将端口写回本地配置。
 *
 * @param portOverride 可选端口文本；传入时会先校验并落盘到配置。
 * @returns 启动结果，包含是否已在运行、最终端口、PID 和日志路径。
 * @throws 当端口非法、接管配置失败或子进程启动失败时抛出异常。
 */
export function startManagedService(portOverride?: string): {
  alreadyRunning: boolean;
  pid: number;
  port: number;
  logPath: string;
} {
  const config = loadConfig();
  const port = portOverride ? parsePort(portOverride) : config.server.port;

  if (portOverride) {
    config.server.port = port;
    saveConfig(config);
  }

  const runningPid = getRunningPid();
  if (runningPid) {
    return {
      alreadyRunning: true,
      pid: runningPid,
      port,
      logPath: getServiceLogPath()
    };
  }

  applyManagedCodexConfig();

  const logPath = getServiceLogPath();
  const logFd = fs.openSync(logPath, "a");
  const serveEntrypoint = resolveServeEntrypoint();
  const child = spawn(serveEntrypoint.command, [...serveEntrypoint.args, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });

  child.unref();
  fs.writeFileSync(getPidPath(), `${child.pid}\n`, "utf8");

  return {
    alreadyRunning: false,
    pid: child.pid ?? 0,
    port,
    logPath
  };
}

/**
 * 停止后台服务，并恢复被接管的 Codex 配置。
 *
 * @returns 停止结果；若服务未运行则仅执行配置恢复。
 * @throws 当进程终止失败时透传底层异常。
 */
export function stopManagedService(): { stoppedPid: number | null } {
  const pid = getRunningPid();

  if (!pid) {
    deactivateManagedCodexConfig();
    return { stoppedPid: null };
  }

  process.kill(pid, "SIGTERM");
  fs.rmSync(getPidPath(), { force: true });
  deactivateManagedCodexConfig();

  return { stoppedPid: pid };
}
