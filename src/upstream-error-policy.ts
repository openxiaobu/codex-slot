import { bi } from "./text";
import type { SchedulerPick } from "./types";

export interface BlockWindow {
  until: number | null;
  reason: string;
}

/**
 * 根据错误文本与当前账号状态，决定本地禁用时长。
 *
 * 业务规则：
 * 1. 周限制优先，直到周窗口重置时间。
 * 2. 5 小时额度限制次之，直到 5 小时窗口重置时间。
 * 3. 未能明确识别时，按 5 分钟临时熔断处理。
 *
 * @param picked 当前被选中的账号及状态。
 * @param errorText 上游返回的错误文本。
 * @returns 本地禁用窗口与原因。
 * @throws 无显式抛出。
 */
export function resolveBlockWindow(picked: SchedulerPick, errorText: string): BlockWindow {
  const lowerText = errorText.toLowerCase();

  if (
    lowerText.includes("weekly") ||
    lowerText.includes("7 day") ||
    lowerText.includes("7-day") ||
    picked.status.isWeeklyLimited
  ) {
    return {
      until: picked.status.weeklyResetsAt ?? Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60,
      reason: "weekly_limited"
    };
  }

  if (
    lowerText.includes("5 hour") ||
    lowerText.includes("5-hour") ||
    lowerText.includes("5h") ||
    lowerText.includes("usage limit") ||
    picked.status.isFiveHourLimited
  ) {
    return {
      until: picked.status.fiveHourResetsAt ?? Math.floor(Date.now() / 1000) + 5 * 60,
      reason: "5h_limited"
    };
  }

  return {
    until: Math.floor(Date.now() / 1000) + 5 * 60,
    reason: "temporary_5m_limit"
  };
}

/**
 * 提取错误对象中最接近底层网络层的错误码。
 *
 * @param error 捕获到的异常对象。
 * @returns 错误码；若无法识别则返回 `null`。
 * @throws 无显式抛出。
 */
export function extractErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") {
    return null;
  }

  const errnoError = error as NodeJS.ErrnoException & { cause?: unknown };
  if (typeof errnoError.code === "string" && errnoError.code.length > 0) {
    return errnoError.code;
  }

  return extractErrorCode(errnoError.cause);
}

/**
 * 判断一次请求失败是否属于本机到上游之间的网络不可达场景。
 *
 * @param error 捕获到的异常对象。
 * @returns `true` 表示网络层异常，不应写入账号熔断；否则返回 `false`。
 * @throws 无显式抛出。
 */
export function isNetworkUnavailableError(error: unknown): boolean {
  const errorCode = extractErrorCode(error);

  return [
    "ECONNREFUSED",
    "ECONNRESET",
    "EHOSTUNREACH",
    "ENETDOWN",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "ETIMEDOUT",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET"
  ].includes(errorCode ?? "");
}

/**
 * 将网络层异常转换为统一的响应体，避免误导成“当前没有可用账号”。
 *
 * @param accountId 当前尝试的账号标识。
 * @param error 捕获到的异常对象。
 * @returns 统一的网络异常响应体。
 * @throws 无显式抛出。
 */
export function buildNetworkUnavailablePayload(accountId: string, error: unknown): {
  error: { message: string; type: string };
} {
  const message = error instanceof Error ? error.message : String(error);

  return {
    error: {
      message: bi(`网络不可用，账号 ${accountId} 无法连接上游: ${message}`, `Network unavailable. Account ${accountId} cannot reach upstream: ${message}`),
      type: "network_unavailable"
    }
  };
}

/**
 * 判断错误响应文本是否表示上游额度限制。
 *
 * @param errorText 上游返回的错误文本。
 * @returns `true` 表示可按额度限制处理并切换账号。
 * @throws 无显式抛出。
 */
export function isUsageLimitErrorText(errorText: string): boolean {
  const lowerText = errorText.toLowerCase();
  return lowerText.includes("usage limit") || lowerText.includes("try again later");
}
