import { loadConfig } from "./config";
import {
  hasCompleteCodexAuthState,
  resolvePrimaryRegistryAccount
} from "./account-store";
import { getAccountBlock, getUsageCache, getUsageRefreshError } from "./state";
import { formatLocalDateTime } from "./text";
import type { AccountRuntimeStatus } from "./types";

interface StatusTableRenderOptions {
  selectorColumn?: {
    enabledById: Record<string, boolean>;
    cursorAccountId: string | null;
  };
  compact?: boolean;
  maxWidth?: number;
}

export interface AccountStatusSummary {
  available: number;
  fiveHourLimited: number;
  weeklyLimited: number;
}

function computeLeftPercent(usedPercent: number | null | undefined): number | null {
  if (usedPercent === null || usedPercent === undefined || Number.isNaN(usedPercent)) {
    return null;
  }

  return Math.max(0, Math.min(100, 100 - usedPercent));
}

function isLimited(usedPercent: number | null, resetsAt: number | null): boolean {
  if (usedPercent === null || usedPercent < 100) {
    return false;
  }

  if (!resetsAt) {
    return true;
  }

  return resetsAt * 1000 > Date.now();
}

function formatPercent(value: number | null): string {
  return value === null ? "-" : `${value}%`;
}

function formatReset(unixSeconds: number | null): string {
  return formatLocalDateTime(unixSeconds);
}

/**
 * 按给定最大宽度截断单元格文本，优先保证表格整体不换行。
 *
 * @param value 原始文本。
 * @param maxWidth 最大宽度。
 * @returns 截断后的文本；宽度过小时退化为最短可读形式。
 */
function truncateCell(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 2) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, maxWidth - 1)}…`;
}

/**
 * 生成固定标签宽度的详情行，超出终端宽度时自动截断值部分。
 *
 * @param label 字段标签。
 * @param value 字段值。
 * @param maxWidth 当前可用最大宽度。
 * @returns 单行详情文本。
 */
function formatDetailLine(label: string, value: string, maxWidth: number): string {
  const prefix = `${label.padEnd(6)} `;
  const safeWidth = Number.isFinite(maxWidth) ? maxWidth : prefix.length + value.length;
  const valueWidth = Math.max(8, safeWidth - prefix.length);

  return `${prefix}${truncateCell(value, valueWidth)}`;
}

/**
 * 将状态对象归一化为单个紧凑状态标签，供表格与详情面板复用。
 *
 * @param item 单个账号状态。
 * @returns 适合在终端展示的状态标签。
 */
function resolveStatusLabel(item: AccountRuntimeStatus): string {
  if (item.refreshErrorCode) {
    return item.refreshErrorCode;
  }

  if (!item.exists) {
    return "missing";
  }

  if (!item.enabled) {
    return "disabled";
  }

  if (item.localBlockUntil && item.localBlockUntil * 1000 > Date.now()) {
    return formatBlockedStatus(item.localBlockReason, item.localBlockUntil);
  }

  if (item.isWeeklyLimited) {
    return formatLimitStatus("weekly_limited", item.weeklyResetsAt);
  }

  if (item.isFiveHourLimited) {
    return formatLimitStatus("5h_limited", item.fiveHourResetsAt);
  }

  if (item.isAvailable) {
    return "available";
  }

  return "unknown";
}

function formatLimitStatus(label: string, resetAt: number | null): string {
  const remaining = formatRemainingDuration(resetAt);

  if (!remaining) {
    return label;
  }

  return `${label}(${remaining})`;
}

function normalizeBlockReason(reason: string | undefined): string {
  if (!reason) {
    return "blocked";
  }

  if (reason === "five_hour_limited") {
    return "5h_limited";
  }

  return reason;
}

/**
 * 将账号工作空间读取异常统一归类为状态码，避免状态汇总阶段直接抛出异常中断整个命令。
 *
 * @param error 工作空间读取过程中抛出的异常。
 * @returns 归一化后的状态码与错误摘要。
 */
function classifyWorkspaceStatusError(
  error: unknown
): { code: string; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: "workspace_invalid",
    message
  };
}

/**
 * 读取账号工作空间的本地登录态摘要；若目录损坏或 JSON 非法，则降级为工作空间不可用状态。
 *
 * @param codexHome 账号隔离 HOME 目录。
 * @returns 是否存在完整登录态、主账号信息以及可选的工作空间错误状态。
 */
function readWorkspaceSnapshot(
  codexHome: string
): {
  exists: boolean;
  primary: ReturnType<typeof resolvePrimaryRegistryAccount>;
  workspaceErrorCode: string | null;
  workspaceErrorMessage: string | null;
} {
  try {
    const exists = hasCompleteCodexAuthState(codexHome);
    const primary = exists ? resolvePrimaryRegistryAccount(codexHome) : null;

    return {
      exists,
      primary,
      workspaceErrorCode: null,
      workspaceErrorMessage: null
    };
  } catch (error) {
    const workspaceError = classifyWorkspaceStatusError(error);

    return {
      exists: false,
      primary: null,
      workspaceErrorCode: workspaceError.code,
      workspaceErrorMessage: workspaceError.message
    };
  }
}

/**
 * 将剩余秒数格式化为紧凑的人类可读文本，便于在状态列中展示熔断剩余时间。
 *
 * @param unixSeconds 熔断截止时间，Unix 秒时间戳。
 * @returns 格式化后的剩余时长；当时间为空或已过期时返回 `null`。
 */
function formatRemainingDuration(unixSeconds: number | null): string | null {
  if (!unixSeconds) {
    return null;
  }

  const diffSeconds = unixSeconds - Math.floor(Date.now() / 1000);
  if (diffSeconds <= 0) {
    return null;
  }

  const hours = Math.floor(diffSeconds / 3600);
  const minutes = Math.floor((diffSeconds % 3600) / 60);
  const seconds = diffSeconds % 60;

  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }

  return `${seconds}s`;
}

/**
 * 将本地熔断原因与剩余时间格式化为更直观的状态文本。
 *
 * @param reason 熔断原因。
 * @param until 熔断截止时间，Unix 秒时间戳。
 * @returns 适合在终端表格中展示的状态文本。
 */
function formatBlockedStatus(reason: string | undefined, until: number | null | undefined): string {
  const label = normalizeBlockReason(reason);
  const remaining = formatRemainingDuration(until ?? null);

  if (!remaining) {
    return label;
  }

  return `${label}(${remaining})`;
}

/**
 * 汇总所有受管账号的运行状态，供状态展示与调度复用。
 *
 * @returns 所有账号的运行时状态列表。
 */
export function collectAccountStatuses(): AccountRuntimeStatus[] {
  const config = loadConfig();

  return config.accounts.map((account) => {
    const workspace = readWorkspaceSnapshot(account.codex_home);
    const usageCache = getUsageCache(account.id);
    const refreshError = getUsageRefreshError(account.id);
    const activeEmail = usageCache?.email ?? workspace.primary?.email ?? account.email;
    const fiveHourUsed = usageCache?.fiveHourUsedPercent ?? null;
    const fiveHourReset = usageCache?.fiveHourResetAt ?? null;
    const weeklyUsed = usageCache?.weeklyUsedPercent ?? null;
    const weeklyReset = usageCache?.weeklyResetAt ?? null;
    const fiveHourLeftPercent = computeLeftPercent(fiveHourUsed);
    const weeklyLeftPercent = computeLeftPercent(weeklyUsed);
    const isFiveHourLimited = isLimited(fiveHourUsed, fiveHourReset);
    const isWeeklyLimited = isLimited(weeklyUsed, weeklyReset);
    const localBlock = getAccountBlock(account.id);
    const localBlocked = localBlock?.until != null ? localBlock.until * 1000 > Date.now() : false;
    const refreshErrorCode = workspace.workspaceErrorCode ?? refreshError?.code ?? null;
    const refreshErrorMessage =
      workspace.workspaceErrorMessage ?? refreshError?.message ?? null;

    return {
      id: account.id,
      name: account.name,
      email: activeEmail,
      enabled: account.enabled,
      exists: workspace.exists,
      plan: usageCache?.plan ?? workspace.primary?.plan ?? "-",
      fiveHourLeftPercent,
      fiveHourResetsAt: fiveHourReset,
      weeklyLeftPercent,
      weeklyResetsAt: weeklyReset,
      isFiveHourLimited,
      isWeeklyLimited,
      localBlockReason: localBlock?.reason,
      localBlockUntil: localBlock?.until ?? null,
      refreshErrorCode,
      refreshErrorMessage,
      isAvailable:
        account.enabled &&
        workspace.exists &&
        !refreshErrorCode &&
        !isFiveHourLimited &&
        !isWeeklyLimited &&
        !localBlocked,
      sourcePath: account.codex_home
    };
  });
}

/**
 * 根据账号运行时状态汇总可用数与额度受限数，供 CLI 统一展示摘要。
 *
 * @param statuses 账号运行时状态列表。
 * @returns 汇总后的数量统计。
 */
export function summarizeAccountStatuses(statuses: AccountRuntimeStatus[]): AccountStatusSummary {
  return {
    available: statuses.filter((item) => item.isAvailable).length,
    fiveHourLimited: statuses.filter(
      (item) => item.isFiveHourLimited && !item.isWeeklyLimited
    ).length,
    weeklyLimited: statuses.filter((item) => item.isWeeklyLimited).length
  };
}

/**
 * 将账号状态渲染为适合终端输出的表格文本。
 *
 * @param statuses 待展示的账号状态列表。
 * @param options 渲染选项；交互模式下可传入选择列配置，将勾选状态与当前光标合并到表格首列。
 * @returns 可直接打印到终端的表格字符串。
 */
export function renderStatusTable(
  statuses: AccountRuntimeStatus[],
  options?: StatusTableRenderOptions
): string {
  const selectorColumn = options?.selectorColumn;
  const compact = options?.compact ?? false;
  const maxWidth = options?.maxWidth ?? Number.POSITIVE_INFINITY;
  const compactHeader = maxWidth < 68;
  const compactSlotWidth = maxWidth < 56 ? 8 : 12;
  const compactPlanWidth = maxWidth < 56 ? 4 : 6;
  const compactStatusWidth = maxWidth < 56 ? 12 : 18;
  const rows = [
    compact
      ? [
          ...(selectorColumn ? [" "] : []),
          compactHeader ? "ID" : "SLOT",
          compactHeader ? "P" : "PLAN",
          "5H",
          compactHeader ? "WK" : "WEEK",
          compactHeader ? "ST" : "STATUS"
        ]
      : [
          ...(selectorColumn ? [" "] : []),
          "NAME",
          "EMAIL",
          "PLAN",
          "5H_LEFT",
          "5H_RESET",
          "WEEK_LEFT",
          "WEEK_RESET",
          "STATUS"
        ]
  ];

  for (const item of statuses) {
    const status = resolveStatusLabel(item);

    const selectorCell = selectorColumn
      ? `${selectorColumn.cursorAccountId === item.id ? ">" : " "}[${
          selectorColumn.enabledById[item.id] ? "x" : " "
        }]`
      : null;

    rows.push(
      compact
        ? [
            ...(selectorCell ? [selectorCell] : []),
            truncateCell(item.name, compactSlotWidth),
            truncateCell(item.plan, compactPlanWidth),
            formatPercent(item.fiveHourLeftPercent),
            formatPercent(item.weeklyLeftPercent),
            truncateCell(status, compactStatusWidth)
          ]
        : [
            ...(selectorCell ? [selectorCell] : []),
            item.name,
            item.email ?? "-",
            item.plan,
            formatPercent(item.fiveHourLeftPercent),
            formatReset(item.fiveHourResetsAt),
            formatPercent(item.weeklyLeftPercent),
            formatReset(item.weeklyResetsAt),
            status
          ]
    );
  }

  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => row[columnIndex].length))
  );

  return rows
    .map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  "))
    .join("\n");
}

/**
 * 将当前选中账号渲染为紧凑详情区，补充主表中省略的邮箱、重置时间与错误摘要。
 *
 * @param item 当前选中的账号状态；为空时返回占位提示。
 * @param options 详情区渲染选项。
 * @returns 适合直接打印的详情区文本。
 */
export function renderStatusDetails(
  item: AccountRuntimeStatus | null,
  options?: { maxWidth?: number }
): string {
  if (!item) {
    return ["[ current ]", "slot   -"].join("\n");
  }

  const maxWidth = options?.maxWidth ?? Number.POSITIVE_INFINITY;
  const narrow = maxWidth < 72;
  const lines = [
    "[ current ]",
    formatDetailLine("slot", `${item.name}  plan=${item.plan}`, maxWidth),
    formatDetailLine("email", item.email ?? "-", maxWidth),
    formatDetailLine("status", resolveStatusLabel(item), maxWidth),
    narrow
      ? formatDetailLine(
          "5h",
          `${formatPercent(item.fiveHourLeftPercent)}  reset=${formatReset(item.fiveHourResetsAt)}`,
          maxWidth
        )
      : formatDetailLine(
          "5h",
          `${formatPercent(item.fiveHourLeftPercent)}  reset=${formatReset(item.fiveHourResetsAt)}`,
          maxWidth
        ),
    narrow
      ? formatDetailLine(
          "week",
          `${formatPercent(item.weeklyLeftPercent)}  reset=${formatReset(item.weeklyResetsAt)}`,
          maxWidth
        )
      : formatDetailLine(
          "week",
          `${formatPercent(item.weeklyLeftPercent)}  reset=${formatReset(item.weeklyResetsAt)}`,
          maxWidth
        )
  ];

  if (item.refreshErrorMessage) {
    lines.push(
      formatDetailLine(
        "error",
        item.refreshErrorMessage,
        narrow ? Math.max(28, maxWidth) : Math.min(maxWidth, 96)
      )
    );
  }

  return lines.join("\n");
}
