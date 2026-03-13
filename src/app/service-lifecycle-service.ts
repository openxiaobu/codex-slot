import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { applyManagedCodexConfig, deactivateManagedCodexConfig } from "../codex-config";
import { parsePort } from "../cli-helpers";
import { getPidPath, getServiceLogPath, loadConfig, rotateServerApiKey, saveConfig } from "../config";

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
 * 检查指定地址与端口当前是否可绑定，用于启动前规避端口冲突。
 *
 * @param host 监听地址。
 * @param port 待检查端口。
 * @returns Promise，可绑定时返回 `true`，被占用或校验失败时返回 `false`。
 * @throws 无显式抛出。
 */
function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();

    server.once("error", () => {
      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

/**
 * 为后台服务挑选最终启动端口。
 *
 * 规则：
 * 1. 若用户显式指定 `--port`，则严格使用该端口，冲突时直接报错。
 * 2. 若未显式指定端口，则优先使用 4399。
 * 3. 若默认候选端口冲突，则从候选端口开始向上查找下一个可用端口。
 *
 * @param host 监听地址。
 * @param currentPort 当前配置中的端口。
 * @param portOverride 用户显式指定的端口文本。
 * @returns Promise，成功时返回最终端口与是否发生自动切换。
 * @throws 当显式指定端口冲突或找不到可用端口时抛出异常。
 */
async function resolveStartPort(
  host: string,
  currentPort: number,
  portOverride?: string
): Promise<{ port: number; autoSwitched: boolean }> {
  if (portOverride) {
    const port = parsePort(portOverride);
    if (!(await isPortAvailable(host, port))) {
      throw new Error(`端口已被占用: ${port}`);
    }

    return { port, autoSwitched: false };
  }

  const preferredPort = currentPort === 4389 ? 4399 : currentPort;

  for (let candidate = preferredPort; candidate < preferredPort + 50; candidate += 1) {
    if (await isPortAvailable(host, candidate)) {
      return {
        port: candidate,
        autoSwitched: candidate !== preferredPort
      };
    }
  }

  throw new Error(`未找到可用端口，起始端口: ${preferredPort}`);
}

/**
 * 启动后台服务，并在需要时将端口写回本地配置。
 *
 * @param portOverride 可选端口文本；传入时会先校验并落盘到配置。
 * @returns 启动结果，包含是否已在运行、最终端口、PID 和日志路径。
 * @throws 当端口非法、接管配置失败或子进程启动失败时抛出异常。
 */
export async function startManagedService(portOverride?: string): Promise<{
  alreadyRunning: boolean;
  pid: number;
  port: number;
  logPath: string;
  autoSwitched: boolean;
  apiKeyRotated: boolean;
}> {
  const config = loadConfig();
  const { port, autoSwitched } = await resolveStartPort(
    config.server.host,
    config.server.port,
    portOverride
  );
  const hasExplicitPortOverride = typeof portOverride === "string" && portOverride.length > 0;

  const runningPid = getRunningPid();
  if (runningPid && hasExplicitPortOverride && config.server.port !== port) {
    config.server.port = port;
    saveConfig(config);
  }

  if (runningPid) {
    return {
      alreadyRunning: true,
      pid: runningPid,
      port,
      logPath: getServiceLogPath(),
      autoSwitched: false,
      apiKeyRotated: false
    };
  }

  if (hasExplicitPortOverride && config.server.port !== port) {
    config.server.port = port;
    saveConfig(config);
  }

  // 每次真正启动服务前都轮换一次本地 api_key，并让受管 config.toml 使用同一新值。
  const persistedConfig = rotateServerApiKey(config);
  const runtimeConfig = {
    ...persistedConfig,
    server: {
      ...persistedConfig.server,
      port
    }
  };
  applyManagedCodexConfig(undefined, { config: runtimeConfig });

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
    logPath,
    autoSwitched,
    apiKeyRotated: true
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
