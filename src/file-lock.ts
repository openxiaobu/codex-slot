import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from "./private-file";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_STALE_AFTER_MS = 120_000;
const DEFAULT_RETRY_DELAY_MS = 20;

interface FileLockOptions {
  timeoutMs?: number;
  staleAfterMs?: number;
  retryDelayMs?: number;
}

interface LockOwner {
  token: string;
  pid: number;
  createdAt: number;
}

/**
 * 判断锁文件记录的进程是否仍然存在。
 *
 * @param pid 锁持有者进程号；非正整数视为不存在。
 * @returns 进程仍存在或当前进程无权探测时返回 `true`，确认不存在时返回 `false`。
 * @throws 无显式抛出。
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 尝试回收已经失去持有进程的锁文件。
 *
 * @param lockPath 锁文件绝对路径。
 * @param staleAfterMs 无法解析持有者时允许回收的最小文件年龄。
 * @returns 已删除失效锁时返回 `true`，锁仍有效或已被其他进程替换时返回 `false`。
 * @throws 无显式抛出；竞争删除和瞬时读取错误按未回收处理。
 */
function removeStaleLock(lockPath: string, staleAfterMs: number): boolean {
  try {
    const initialContent = fs.readFileSync(lockPath, "utf8");
    const stat = fs.statSync(lockPath);
    let owner: LockOwner | null = null;

    try {
      owner = JSON.parse(initialContent) as LockOwner;
    } catch {
      owner = null;
    }

    const isStale = owner
      ? !isProcessAlive(owner.pid)
      : Date.now() - stat.mtimeMs >= staleAfterMs;

    if (!isStale || fs.readFileSync(lockPath, "utf8") !== initialContent) {
      return false;
    }

    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 尝试一次独占创建锁文件。
 *
 * @param lockPath 锁文件绝对路径。
 * @param staleAfterMs 失效锁回收阈值。
 * @returns 成功时返回本次持有者 token；锁被占用时返回 `null`。
 * @throws 当锁目录或非竞争类文件操作失败时抛出文件系统错误。
 */
function tryAcquireLock(lockPath: string, staleAfterMs: number): string | null {
  ensurePrivateDirectory(path.dirname(lockPath));
  const owner: LockOwner = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: Date.now()
  };
  let fileDescriptor: number | null = null;

  try {
    fileDescriptor = fs.openSync(
      lockPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      PRIVATE_FILE_MODE
    );
    fs.writeFileSync(fileDescriptor, `${JSON.stringify(owner)}\n`, "utf8");
    fs.closeSync(fileDescriptor);
    return owner.token;
  } catch (error) {
    if (fileDescriptor !== null) {
      fs.closeSync(fileDescriptor);
      fs.rmSync(lockPath, { force: true });
    }

    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }

    removeStaleLock(lockPath, staleAfterMs);
    return null;
  }
}

/**
 * 释放当前持有者创建的锁文件，避免误删已经被其他进程接管的新锁。
 *
 * @param lockPath 锁文件绝对路径。
 * @param token 当前持有者 token。
 * @returns 无返回值。
 * @throws 无显式抛出；退出清理阶段的竞争或文件系统异常按幂等释放处理。
 */
function releaseLock(lockPath: string, token: string): void {
  try {
    const owner = JSON.parse(fs.readFileSync(lockPath, "utf8")) as LockOwner;
    if (owner.token === token) {
      fs.rmSync(lockPath, { force: true });
    }
  } catch {
    // 锁可能已被异常清理，释放阶段保持幂等。
  }
}

/**
 * 同步等待一小段时间，供同步状态读改写在锁竞争时让出 CPU。
 *
 * @param delayMs 等待毫秒数；小于等于零时立即返回。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function sleepSync(delayMs: number): void {
  if (delayMs <= 0) {
    return;
  }

  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

/**
 * 在跨进程独占锁内执行同步文件操作。
 *
 * @param lockPath 锁文件绝对路径。
 * @param action 获得锁后执行的同步操作。
 * @param options 可选超时、失效锁阈值与重试间隔。
 * @returns action 的返回值。
 * @throws 当等待超时、锁文件操作失败或 action 抛错时透传异常。
 */
export function withFileLockSync<T>(
  lockPath: string,
  action: () => T,
  options?: FileLockOptions
): T {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let token: string | null = null;

  while (!token) {
    token = tryAcquireLock(lockPath, staleAfterMs);
    if (token) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待文件锁超时: ${lockPath}`);
    }
    sleepSync(retryDelayMs);
  }

  try {
    return action();
  } finally {
    releaseLock(lockPath, token);
  }
}

/**
 * 在跨进程独占锁内执行异步文件或网络操作。
 *
 * @param lockPath 锁文件绝对路径。
 * @param action 获得锁后执行的异步操作。
 * @param options 可选超时、失效锁阈值与重试间隔。
 * @returns Promise，解析为 action 的返回值。
 * @throws 当等待超时、锁文件操作失败或 action 拒绝时透传异常。
 */
export async function withFileLock<T>(
  lockPath: string,
  action: () => Promise<T>,
  options?: FileLockOptions
): Promise<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const retryDelayMs = options?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let token: string | null = null;

  while (!token) {
    token = tryAcquireLock(lockPath, staleAfterMs);
    if (token) {
      break;
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待文件锁超时: ${lockPath}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }

  try {
    return await action();
  } finally {
    releaseLock(lockPath, token);
  }
}
