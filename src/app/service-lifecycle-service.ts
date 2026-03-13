import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { request } from "undici";
import { applyManagedCodexConfig, deactivateManagedCodexConfig } from "../codex-config";
import { parsePort } from "../cli-helpers";
import { getPidPath, getServiceLogPath, loadConfig, rotateServerApiKey, saveConfig } from "../config";

const STARTUP_POLL_INTERVAL_MS = 100;
const STARTUP_TIMEOUT_MS = 5000;

/**
 * 休眠指定毫秒数，供启动轮询流程复用。
 *
 * @param delayMs 等待时长，单位毫秒。
 * @returns Promise，等待结束后返回。
 * @throws 无显式抛出。
 */
function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

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
 * 通过健康检查探测后台服务是否已经完成启动。
 *
 * @param host 本地监听地址。
 * @param port 期望监听的端口。
 * @returns Promise，健康检查通过时返回 `true`，否则返回 `false`。
 * @throws 无显式抛出。
 */
async function isManagedServiceHealthy(
  host: string,
  port: number
): Promise<boolean> {
  try {
    const response = await request(`http://${host}:${port}/health`, {
      method: "GET",
      headersTimeout: 500,
      bodyTimeout: 500
    });

    if (response.statusCode !== 200) {
      return false;
    }

    const payload = (await response.body.json()) as { ok?: boolean };
    return payload.ok === true;
  } catch {
    return false;
  }
}

/**
 * 等待后台服务真正进入可用状态，避免“配置已写入但服务未成功启动”的假成功状态。
 *
 * @param host 本地监听地址。
 * @param port 期望监听的端口。
 * @param pid 子进程 PID。
 * @param timeoutMs 等待超时时间，单位毫秒。
 * @returns Promise，健康检查通过时正常返回。
 * @throws 当子进程提前退出、超时或服务始终未就绪时抛出异常。
 */
async function waitForManagedServiceReady(
  host: string,
  port: number,
  pid: number,
  timeoutMs = STARTUP_TIMEOUT_MS
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      process.kill(pid, 0);
    } catch {
      throw new Error(`后台服务启动失败，进程已退出，PID=${pid}`);
    }

    // 只有健康检查通过，才认为本地代理已经可安全对外服务。
    if (await isManagedServiceHealthy(host, port)) {
      return;
    }

    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error(`后台服务启动超时，${host}:${port} 未在 ${timeoutMs}ms 内通过健康检查`);
}

/**
 * 在启动失败时终止残留子进程，并恢复启动前的本地配置与 Codex 接管状态。
 *
 * @param pid 可能已创建的子进程 PID。
 * @param previousConfig 启动前的原始配置快照。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function rollbackFailedStart(pid: number | null, previousConfig: ReturnType<typeof loadConfig>): void {
  if (pid && Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // 子进程可能已经自行退出，此处按幂等清理处理。
    }
  }

  fs.rmSync(getPidPath(), { force: true });
  saveConfig(previousConfig);
  deactivateManagedCodexConfig();
}

/**
 * 为后台服务挑选最终启动端口。
 *
 * 规则：
 * 1. 若用户显式指定 `--port`，则严格使用该端口，冲突时直接报错。
 * 2. 若未显式指定端口，则优先使用 4399。
 * 3. 若默认候选端口冲突，则从 4399 开始向上查找下一个可用端口。
 *
 * @param host 监听地址。
 * @param portOverride 用户显式指定的端口文本。
 * @returns Promise，成功时返回最终端口与是否发生自动切换。
 * @throws 当显式指定端口冲突或找不到可用端口时抛出异常。
 */
async function resolveStartPort(
  host: string,
  portOverride?: string
): Promise<{ port: number; autoSwitched: boolean }> {
  if (portOverride) {
    const port = parsePort(portOverride);
    if (!(await isPortAvailable(host, port))) {
      throw new Error(`端口已被占用: ${port}`);
    }

    return { port, autoSwitched: false };
  }

  const preferredPort = 4399;

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
  const previousConfig = structuredClone(config);
  const { port, autoSwitched } = await resolveStartPort(config.server.host, portOverride);
  const runningPid = getRunningPid();

  if (runningPid) {
    return {
      alreadyRunning: true,
      pid: runningPid,
      port: config.server.port,
      logPath: getServiceLogPath(),
      autoSwitched: false,
      apiKeyRotated: false
    };
  }

  if (config.server.port !== port) {
    config.server.port = port;
    saveConfig(config);
  }

  // 每次真正启动服务前都轮换一次本地 api_key，并让受管 config.toml 使用同一新值。
  const persistedConfig = rotateServerApiKey(config);
  applyManagedCodexConfig(undefined, { config: persistedConfig });

  const logPath = getServiceLogPath();
  const logFd = fs.openSync(logPath, "a");
  const serveEntrypoint = resolveServeEntrypoint();
  const child = spawn(serveEntrypoint.command, [...serveEntrypoint.args, "--port", String(port)], {
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  const childPid = child.pid ?? null;

  child.unref();
  if (!childPid) {
    fs.closeSync(logFd);
    rollbackFailedStart(null, previousConfig);
    throw new Error("后台服务启动失败，未获取到有效子进程 PID");
  }

  fs.writeFileSync(getPidPath(), `${childPid}\n`, "utf8");
  fs.closeSync(logFd);

  try {
    await waitForManagedServiceReady(config.server.host, port, childPid);
  } catch (error) {
    rollbackFailedStart(childPid, previousConfig);
    throw error;
  }

  return {
    alreadyRunning: false,
    pid: childPid,
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
