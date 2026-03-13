import { startManagedService, stopManagedService } from "./app/service-lifecycle-service";
import { loadConfig } from "./config";
import { bi } from "./text";

/**
 * 后台启动 cslot 服务并写入 PID 文件。
 *
 * @param portOverride 可选的端口文本；传入时会先校验并落盘到本地配置。
 * @returns Promise，无返回值。
 * @throws 当服务已在运行、端口非法或子进程启动失败时抛出异常。
 */
export async function handleStart(portOverride?: string): Promise<void> {
  const config = loadConfig();
  const result = startManagedService(portOverride);

  if (result.alreadyRunning) {
    console.log(bi(`服务已在运行，PID=${result.pid}`, `Service is already running. PID=${result.pid}`));
    if (portOverride) {
      console.log(bi(`已将新端口写入配置: ${result.port}`, `The new port has been saved to config: ${result.port}`));
      console.log(
        bi(
          "请先执行 cslot stop，再执行 cslot start 使新端口生效。",
          "Run cslot stop first, then cslot start to apply the new port."
        )
      );
    }
    return;
  }

  console.log(bi(`服务已启动: http://${config.server.host}:${result.port}`, `Service started: http://${config.server.host}:${result.port}`));
  console.log(`PID: ${result.pid}`);
  console.log(bi(`日志: ${result.logPath}`, `Log: ${result.logPath}`));
}

/**
 * 停止后台运行的 cslot 服务，并恢复被接管的 Codex 配置。
 *
 * @returns 无返回值。
 * @throws 当进程终止失败时透传底层异常。
 */
export function handleStop(): void {
  const result = stopManagedService();

  if (!result.stoppedPid) {
    console.log(bi("服务未运行", "Service is not running."));
    return;
  }

  console.log(bi(`服务已停止，PID=${result.stoppedPid}`, `Service stopped. PID=${result.stoppedPid}`));
}
