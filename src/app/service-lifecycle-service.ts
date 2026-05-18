import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { request } from "undici";
import { listAccounts } from "./account-service";
import { hasCompleteCodexAuthState } from "../account-store";
import { getSelectedCodexAuthAccountId } from "../state";
import { applyManagedCodexConfig, deactivateManagedCodexConfig } from "../codex-config";
import { applyManagedCodexAuth, deactivateManagedCodexAuth } from "../codex-auth";
import { parsePort } from "../cli-helpers";
import { getPidPath, getServiceLogPath, getUserHomeDir, loadConfig, saveConfig } from "../config";
import type { ManagedAccount } from "../types";

const STARTUP_POLL_INTERVAL_MS = 100;
const STARTUP_TIMEOUT_MS = 5000;
const LAUNCH_AGENT_LABEL_PREFIX = "com.openxiaobu.cslot";

export type ServiceManagerKind = "launchd" | "systemd-user" | "detached";

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
 * 基于当前 HOME 目录生成稳定的 launchd label，避免测试隔离 HOME 与真实 HOME 互相冲突。
 *
 * @returns 当前 HOME 对应的 launchd label。
 * @throws 无显式抛出。
 */
function getLaunchAgentLabel(): string {
  const home = getUserHomeDir();
  let hash = 2166136261;

  for (const character of home) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }

  return `${LAUNCH_AGENT_LABEL_PREFIX}.${(hash >>> 0).toString(16)}`;
}

/**
 * 返回当前 HOME 对应的 LaunchAgents plist 路径，并确保父目录存在。
 *
 * @returns launchd plist 绝对路径。
 * @throws 当目录创建失败时抛出文件系统错误。
 */
function getLaunchAgentPlistPath(): string {
  const launchAgentsDir = path.join(getUserHomeDir(), "Library", "LaunchAgents");
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  return path.join(launchAgentsDir, `${getLaunchAgentLabel()}.plist`);
}

/**
 * 对 XML 文本做最小转义，避免命令参数与日志路径写入 plist 时破坏结构。
 *
 * @param value 待写入 plist 的原始文本。
 * @returns 完成 XML 转义后的文本。
 * @throws 无显式抛出。
 */
function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * 生成 launchd plist 内容，使 cslot 服务具备开机自启与异常退出自动拉起能力。
 *
 * @param command 启动服务使用的绝对命令路径。
 * @param args 命令参数列表。
 * @param logPath 标准输出与错误输出写入的日志路径。
 * @returns 可直接写入磁盘的 plist 文本。
 * @throws 无显式抛出。
 */
export function buildLaunchAgentPlist(command: string, args: string[], logPath: string): string {
  const programArguments = [command, ...args].map((item) => `      <string>${escapeXml(item)}</string>`).join("\n");
  const home = escapeXml(getUserHomeDir());
  const label = escapeXml(getLaunchAgentLabel());
  const escapedLogPath = escapeXml(logPath);

  return [
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
    "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">",
    "<plist version=\"1.0\">",
    "<dict>",
    "  <key>Label</key>",
    `  <string>${label}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    programArguments,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    "    <key>HOME</key>",
    `    <string>${home}</string>`,
    "  </dict>",
    "  <key>StandardOutPath</key>",
    `  <string>${escapedLogPath}</string>`,
    "  <key>StandardErrorPath</key>",
    `  <string>${escapedLogPath}</string>`,
    "</dict>",
    "</plist>",
    ""
  ].join("\n");
}

/**
 * 判断当前环境是否应启用 launchd 托管。
 *
 * @returns macOS 且未显式禁用 launchd 时返回 `true`，否则返回 `false`。
 * @throws 无显式抛出。
 */
function shouldUseLaunchd(): boolean {
  return process.platform === "darwin" && process.env.CSLOT_DISABLE_LAUNCHD !== "1";
}

/**
 * 判断当前 Linux 环境是否应使用 systemd user service 托管。
 *
 * @returns Linux 且未显式禁用 systemd 托管时返回 `true`，否则返回 `false`。
 * @throws 无显式抛出。
 */
function shouldUseSystemdUser(): boolean {
  return process.platform === "linux" && process.env.CSLOT_DISABLE_SYSTEMD !== "1";
}

/**
 * 解析当前平台应使用的后台服务托管方式。
 *
 * @returns 当前平台对应的服务管理器类型。
 * @throws 当 Linux 期望使用 systemd 但本机缺少 `systemctl` 时抛出异常。
 */
export function resolveServiceManagerKind(): ServiceManagerKind {
  if (shouldUseLaunchd()) {
    return "launchd";
  }

  if (shouldUseSystemdUser()) {
    try {
      execFileSync("systemctl", ["--user", "--version"], {
        stdio: ["ignore", "ignore", "ignore"]
      });
    } catch {
      throw new Error("当前 Linux 环境缺少 systemd --user，无法提供自动拉起与开机自启。请安装 systemd user service，或显式设置 CSLOT_DISABLE_SYSTEMD=1 回退到 detached 模式。");
    }

    return "systemd-user";
  }

  return "detached";
}

/**
 * 返回当前用户的 launchd domain，供 `launchctl bootstrap/bootout` 复用。
 *
 * @returns 类似 `gui/501` 的 domain 字符串。
 * @throws 当当前进程无法获取 uid 时抛出异常。
 */
function getLaunchctlDomain(): string {
  if (typeof process.getuid !== "function") {
    throw new Error("当前平台不支持 launchctl user domain");
  }

  return `gui/${process.getuid()}`;
}

/**
 * 返回 systemd user service 的 unit 名称，按 HOME 做稳定区分，避免测试与真实环境互串。
 *
 * @returns 当前 HOME 对应的 systemd unit 文件名。
 * @throws 无显式抛出。
 */
function getSystemdUserUnitName(): string {
  return `${getLaunchAgentLabel().replaceAll(".", "-")}.service`;
}

/**
 * 返回 systemd user service unit 文件路径，并确保目录存在。
 *
 * @returns systemd user unit 绝对路径。
 * @throws 当目录创建失败时抛出文件系统错误。
 */
function getSystemdUserUnitPath(): string {
  const unitDir = path.join(getUserHomeDir(), ".config", "systemd", "user");
  fs.mkdirSync(unitDir, { recursive: true });
  return path.join(unitDir, getSystemdUserUnitName());
}

/**
 * 对 systemd Environment 值做最小转义，避免空格或双引号破坏 unit 文件语义。
 *
 * @param value Environment 原始值。
 * @returns 已转义的值文本。
 * @throws 无显式抛出。
 */
function escapeSystemdEnvironmentValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

/**
 * 对 systemd ExecStart 参数做 shell 风格转义，确保路径和参数可被 systemd 正确拆分。
 *
 * @param value ExecStart 单个参数文本。
 * @returns 安全可写入 unit 的参数文本。
 * @throws 无显式抛出。
 */
function quoteSystemdExecArgument(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/**
 * 生成 systemd --user service unit，使 cslot 在 Linux 下具备用户级开机自启与异常退出自动重启能力。
 *
 * @param command 启动服务使用的绝对命令路径。
 * @param args 命令参数列表。
 * @param logPath 服务日志路径。
 * @returns 可直接写入 systemd user unit 的文本。
 * @throws 无显式抛出。
 */
export function buildSystemdUserUnit(command: string, args: string[], logPath: string): string {
  const execStart = [command, ...args].map(quoteSystemdExecArgument).join(" ");
  const home = escapeSystemdEnvironmentValue(getUserHomeDir());
  const safeLogPath = logPath.replaceAll("\\", "\\\\").replaceAll("%", "%%");

  return [
    "[Unit]",
    "Description=cslot managed local proxy",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    `Environment=HOME="${home}"`,
    `ExecStart=${execStart}`,
    "Restart=always",
    "RestartSec=1",
    `StandardOutput=append:${safeLogPath}`,
    `StandardError=append:${safeLogPath}`,
    "",
    "[Install]",
    "WantedBy=default.target",
    ""
  ].join("\n");
}

/**
 * 执行一次 systemctl --user 命令，并在允许的退出码范围内按幂等成功处理。
 *
 * @param args systemctl 参数列表。
 * @param allowedStatuses 允许按成功处理的退出码集合。
 * @returns 标准输出文本。
 * @throws 当命令失败且退出码不在允许列表中时抛出异常。
 */
function runSystemctlUser(args: string[], allowedStatuses: number[] = []): string {
  try {
    return execFileSync("systemctl", ["--user", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;

    if (status !== null && allowedStatuses.includes(status)) {
      return "";
    }

    const stderr =
      typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`systemctl --user ${args.join(" ")} 失败: ${message}`);
  }
}

/**
 * 启动或重载 systemd --user 托管的 cslot 服务。
 *
 * @param port 最终启动端口。
 * @param logPath 服务日志路径。
 * @returns 当前 systemd 托管实例的 PID。
 * @throws 当 unit 写入、systemctl 调用或服务就绪检查失败时抛出异常。
 */
async function startManagedServiceWithSystemdUser(port: number, logPath: string): Promise<number> {
  const serveEntrypoint = resolveServeEntrypoint();
  const unitPath = getSystemdUserUnitPath();
  const unitName = getSystemdUserUnitName();
  const unit = buildSystemdUserUnit(serveEntrypoint.command, [...serveEntrypoint.args, "--port", String(port)], logPath);

  fs.writeFileSync(unitPath, unit, "utf8");
  runSystemctlUser(["daemon-reload"]);
  runSystemctlUser(["enable", "--now", unitName]);

  return await waitForManagedServicePid();
}

/**
 * 停止并卸载 systemd --user 托管的 cslot 服务，同时清理本地 unit 工件。
 *
 * @returns 停止前记录到的 PID；若当时没有可见运行 PID 则返回 `null`。
 * @throws 当 systemctl 卸载或清理失败时抛出异常。
 */
function stopManagedServiceWithSystemdUser(): number | null {
  const pid = getRunningPid();
  const unitName = getSystemdUserUnitName();
  const unitPath = getSystemdUserUnitPath();

  runSystemctlUser(["disable", "--now", unitName], [1, 5]);
  fs.rmSync(unitPath, { force: true });
  runSystemctlUser(["daemon-reload"]);
  runSystemctlUser(["reset-failed", unitName], [1, 5]);
  fs.rmSync(getPidPath(), { force: true });

  return pid;
}

/**
 * 执行一次 launchctl 命令，并在允许的失败码内按幂等处理。
 *
 * @param args launchctl 参数列表。
 * @param allowedStatuses 允许视为成功的退出码集合。
 * @returns 标准输出文本。
 * @throws 当命令执行失败且退出码不在允许集合中时抛出异常。
 */
function runLaunchctl(args: string[], allowedStatuses: number[] = []): string {
  try {
    return execFileSync("launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;

    if (status !== null && allowedStatuses.includes(status)) {
      return "";
    }

    const stderr =
      typeof error === "object" && error && "stderr" in error && typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    const message = stderr || (error instanceof Error ? error.message : String(error));
    throw new Error(`launchctl ${args.join(" ")} 失败: ${message}`);
  }
}

/**
 * 等待服务进程把自己的 PID 写入本地状态文件，兼容 launchd 拉起的非子进程模型。
 *
 * @param timeoutMs 等待超时时间，单位毫秒。
 * @returns Promise，成功时返回当前运行中的 PID。
 * @throws 当超时后仍未拿到有效 PID 时抛出异常。
 */
async function waitForManagedServicePid(timeoutMs = STARTUP_TIMEOUT_MS): Promise<number> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const pid = getRunningPid();

    if (pid) {
      return pid;
    }

    await sleep(STARTUP_POLL_INTERVAL_MS);
  }

  throw new Error(`后台服务启动超时，未在 ${timeoutMs}ms 内写入有效 PID`);
}

/**
 * 启动或重载 launchd 托管的 cslot 服务。
 *
 * @param port 最终启动端口。
 * @param logPath 服务日志路径。
 * @returns 当前 launchd 托管实例的 PID。
 * @throws 当 plist 写入、launchctl 调用或服务就绪检查失败时抛出异常。
 */
async function startManagedServiceWithLaunchd(port: number, logPath: string): Promise<number> {
  const serveEntrypoint = resolveServeEntrypoint();
  const plistPath = getLaunchAgentPlistPath();
  const domain = getLaunchctlDomain();
  const label = getLaunchAgentLabel();
  const plist = buildLaunchAgentPlist(serveEntrypoint.command, [...serveEntrypoint.args, "--port", String(port)], logPath);

  fs.writeFileSync(plistPath, plist, "utf8");

  // 先卸载旧 job，再用最新配置重载，避免端口或命令参数更新后仍复用旧定义。
  runLaunchctl(["bootout", domain, plistPath], [3, 5, 36, 64, 113]);
  runLaunchctl(["bootstrap", domain, plistPath]);
  runLaunchctl(["enable", `${domain}/${label}`], [3, 5, 64, 113]);
  runLaunchctl(["kickstart", "-k", `${domain}/${label}`]);

  const pid = await waitForManagedServicePid();
  return pid;
}

/**
 * 停止并卸载 launchd 托管的 cslot 服务，同时清理本地 plist 工件。
 *
 * @returns 停止前记录到的 PID；若当时没有可见运行 PID 则返回 `null`。
 * @throws 当 launchctl 卸载失败时抛出异常。
 */
function stopManagedServiceWithLaunchd(): number | null {
  const pid = getRunningPid();
  const plistPath = getLaunchAgentPlistPath();
  const domain = getLaunchctlDomain();

  runLaunchctl(["bootout", domain, plistPath], [3, 5, 36, 64, 113]);
  fs.rmSync(plistPath, { force: true });
  fs.rmSync(getPidPath(), { force: true });

  return pid;
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
  try {
    const manager = resolveServiceManagerKind();

    if (manager === "launchd") {
      stopManagedServiceWithLaunchd();
    } else if (manager === "systemd-user") {
      stopManagedServiceWithSystemdUser();
    }
  } catch {
    // 回滚阶段以尽力清理为主，不覆盖原始启动异常。
  }
  saveConfig(previousConfig);
  deactivateManagedCodexConfig();
  deactivateManagedCodexAuth();
}

/**
 * 选择一个可用于接管主 `~/.codex` 登录态的账号。
 *
 * 业务规则：
 * 1. 优先使用状态面板中手动选择的 Codex App 登录态账号。
 * 2. 手动选择存在但账号缺失或登录态不完整时直接报错，避免静默切到其他账号。
 * 3. 未手动选择时，回退到首个启用且本地工作空间仍存在的账号。
 * 4. 若仍无可用账号，则返回 `null`，此时仅接管 provider 配置，不强行覆盖主登录态。
 *
 * @returns 选中的受管账号；若不存在可接管账号则返回 `null`。
 * @throws 当手动选择的账号不存在或登录态不完整时抛出错误。
 */
function resolveManagedAuthAccount(): ManagedAccount | null {
  const accounts = listAccounts();
  const selectedAuthAccountId = getSelectedCodexAuthAccountId();

  if (selectedAuthAccountId) {
    const selected = accounts.find((account) => account.id === selectedAuthAccountId);
    if (!selected) {
      throw new Error(`手动选择的 Codex App 登录态账号不存在: ${selectedAuthAccountId}`);
    }

    if (!fs.existsSync(selected.codex_home) || !hasCompleteCodexAuthState(selected.codex_home)) {
      throw new Error(`手动选择的 Codex App 登录态账号缺少完整 auth.json: ${selectedAuthAccountId}`);
    }

    return selected;
  }

  return (
    accounts.find(
      (account) =>
        account.enabled &&
        fs.existsSync(account.codex_home) &&
        hasCompleteCodexAuthState(account.codex_home)
    ) ?? null
  );
}

/**
 * 将主 `~/.codex` 登录态切换到当前受管账号，供 `codex_apps` 等依赖主登录态的链路复用。
 *
 * @returns 实际接管的账号；若没有合适账号则返回 `null`。
 * @throws 当目标账号目录缺少完整登录态时抛出异常。
 */
function applyManagedAuthIfPossible(): ManagedAccount | null {
  const account = resolveManagedAuthAccount();
  if (!account) {
    return null;
  }

  applyManagedCodexAuth(account.codex_home, { sourceAccountId: account.id });
  return account;
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
  manager: ServiceManagerKind;
}> {
  const config = loadConfig();
  const previousConfig = structuredClone(config);
  const { port, autoSwitched } = await resolveStartPort(config.server.host, portOverride);
  const manager = resolveServiceManagerKind();
  const runningPid = getRunningPid();

  if (runningPid) {
    return {
      alreadyRunning: true,
      pid: runningPid,
      port: config.server.port,
      logPath: getServiceLogPath(),
      autoSwitched: false,
      manager
    };
  }

  if (config.server.port !== port) {
    config.server.port = port;
    saveConfig(config);
  }

  applyManagedCodexConfig(undefined, { config });
  applyManagedAuthIfPossible();

  const logPath = getServiceLogPath();
  let childPid: number | null = null;

  if (manager === "launchd") {
    try {
      childPid = await startManagedServiceWithLaunchd(port, logPath);
    } catch (error) {
      rollbackFailedStart(null, previousConfig);
      throw error;
    }
  } else if (manager === "systemd-user") {
    try {
      childPid = await startManagedServiceWithSystemdUser(port, logPath);
    } catch (error) {
      rollbackFailedStart(null, previousConfig);
      throw error;
    }
  } else {
    const logFd = fs.openSync(logPath, "a");
    const serveEntrypoint = resolveServeEntrypoint();
    const child = spawn(serveEntrypoint.command, [...serveEntrypoint.args, "--port", String(port)], {
      detached: true,
      stdio: ["ignore", logFd, logFd]
    });

    childPid = child.pid ?? null;
    child.unref();
    fs.closeSync(logFd);

    if (!childPid) {
      rollbackFailedStart(null, previousConfig);
      throw new Error("后台服务启动失败，未获取到有效子进程 PID");
    }
  }

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
    manager
  };
}

/**
 * 停止后台服务，并恢复被接管的 Codex 配置。
 *
 * @returns 停止结果；若服务未运行则仅执行配置恢复。
 * @throws 当进程终止失败时透传底层异常。
 */
export function stopManagedService(): { stoppedPid: number | null } {
  const manager = resolveServiceManagerKind();
  const hasLaunchAgent = manager === "launchd" && fs.existsSync(getLaunchAgentPlistPath());
  const hasSystemdUnit = manager === "systemd-user" && fs.existsSync(getSystemdUserUnitPath());
  const pid = getRunningPid();

  if (!pid && !hasLaunchAgent && !hasSystemdUnit) {
    deactivateManagedCodexConfig();
    deactivateManagedCodexAuth();
    return { stoppedPid: null };
  }

  if (hasLaunchAgent) {
    stopManagedServiceWithLaunchd();
  } else if (hasSystemdUnit) {
    stopManagedServiceWithSystemdUser();
  } else if (pid) {
    process.kill(pid, "SIGTERM");
    fs.rmSync(getPidPath(), { force: true });
  }

  deactivateManagedCodexConfig();
  deactivateManagedCodexAuth();

  return { stoppedPid: pid };
}
