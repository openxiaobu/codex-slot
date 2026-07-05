import { execFileSync } from "node:child_process";

/**
 * 判断指定 PID 的进程是否仍在运行。
 *
 * Windows 上 `process.kill(pid, 0)` 在进程存在但当前用户无权限发信号时会抛出 `EPERM`，
 * 此时仍应视为进程存活，避免误删 PID 文件或重复启动。
 *
 * @param pid 待检查的进程 PID。
 * @returns 进程存活时返回 `true`，否则返回 `false`。
 * @throws 无显式抛出。
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (typeof error === "object" && error && "code" in error) {
      const code = String(error.code);

      if (code === "EPERM") {
        return true;
      }

      if (code === "ESRCH") {
        return false;
      }
    }

    return false;
  }
}

/**
 * 终止指定 PID 的进程；Windows 下优先使用 `taskkill /T` 结束整棵进程树。
 *
 * @param pid 待终止的进程 PID。
 * @returns 无返回值。
 * @throws 当终止命令失败且进程仍可能存活时抛出异常。
 */
export function terminateProcess(pid: number): void {
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: ["ignore", "ignore", "pipe"]
      });
      return;
    } catch (error) {
      const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null;

      // 128: process not found; treat as already stopped.
      if (status === 128) {
        return;
      }

      if (isProcessRunning(pid)) {
        const stderr =
          typeof error === "object" && error && "stderr" in error && Buffer.isBuffer(error.stderr)
            ? error.stderr.toString("utf8").trim()
            : "";
        const message = stderr || (error instanceof Error ? error.message : String(error));
        throw new Error(`taskkill /PID ${pid} /T /F 失败: ${message}`);
      }

      return;
    }
  }

  process.kill(pid, "SIGTERM");
}
