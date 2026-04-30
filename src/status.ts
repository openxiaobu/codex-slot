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
  styled?: boolean;
}

export interface AccountStatusSummary {
  available: number;
  fiveHourLimited: number;
  weeklyLimited: number;
}

const TABLE_ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m"
} as const;

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
 * 移除 ANSI 控制序列，获得真实可见文本。
 *
 * 业务含义：
 * 1. 交互界面会对状态列做轻量着色。
 * 2. 表格宽度计算必须忽略颜色控制符，否则列宽会被错误拉大。
 *
 * @param value 可能包含 ANSI 样式的文本。
 * @returns 去除 ANSI 控制序列后的可见文本。
 * @throws 无显式抛出。
 */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 按需给文本添加 ANSI 样式。
 *
 * @param value 原始文本。
 * @param color ANSI 颜色或样式控制符。
 * @param styled 是否启用样式。
 * @returns 启用样式时返回带 ANSI 控制符的文本，否则返回原文。
 * @throws 无显式抛出。
 */
function styleCell(value: string, color: string, styled: boolean): string {
  if (!styled) {
    return value;
  }

  return `${color}${value}${TABLE_ANSI.reset}`;
}

/**
 * 判断字符是否应按双列宽展示。
 *
 * 业务含义：
 * 1. 终端中中文、全角符号与多数 CJK 字符通常占两个显示列。
 * 2. 表格列宽若只按字符串长度计算，会导致包含中文括号的账号名错位或过早截断。
 *
 * @param codePoint Unicode code point；必须来自单个字符迭代结果。
 * @returns `true` 表示该字符应按双列宽计算；其他字符返回 `false`。
 * @throws 无显式抛出。
 */
function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    )
  );
}

/**
 * 计算文本在常见等宽终端中的显示列宽。
 *
 * 业务含义：
 * 1. 状态表需要根据终端列数分配可用空间。
 * 2. 账号名可能包含中文日期括号，必须按显示宽度而不是 UTF-16 长度计算。
 *
 * @param value 待展示文本；允许为空字符串。
 * @returns 文本占用的终端显示列数。
 * @throws 无显式抛出。
 */
function getDisplayWidth(value: string): number {
  const visibleValue = stripAnsi(value);
  let width = 0;

  for (const char of visibleValue) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }

  return width;
}

/**
 * 按终端显示列宽截断文本。
 *
 * 业务含义：
 * 1. 优先保证表格整体不换行。
 * 2. 截断时保留省略号，让用户能看出内容未完全展示。
 *
 * @param value 原始文本。
 * @param maxWidth 最大显示列宽；小于等于 0 时返回空字符串。
 * @returns 截断后的文本；宽度过小时退化为最短可读形式。
 * @throws 无显式抛出。
 */
function truncateCell(value: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  if (getDisplayWidth(value) <= maxWidth) {
    return value;
  }

  if (maxWidth <= 2) {
    let output = "";
    let width = 0;

    for (const char of value) {
      const charWidth = getDisplayWidth(char);
      if (width + charWidth > maxWidth) {
        break;
      }

      output += char;
      width += charWidth;
    }

    return output;
  }

  const ellipsis = "…";
  const targetWidth = maxWidth - getDisplayWidth(ellipsis);
  let output = "";
  let width = 0;

  for (const char of value) {
    const charWidth = getDisplayWidth(char);
    if (width + charWidth > targetWidth) {
      break;
    }

    output += char;
    width += charWidth;
  }

  return `${output}${ellipsis}`;
}

/**
 * 按终端显示列宽补齐单元格。
 *
 * @param value 已完成截断的单元格文本。
 * @param width 目标显示列宽。
 * @returns 右侧补空格后的单元格文本。
 * @throws 无显式抛出。
 */
function padCell(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - getDisplayWidth(value)))}`;
}

/**
 * 根据账号状态给状态标签选择终端样式。
 *
 * 业务含义：
 * 1. `available` 是调度可用状态，使用绿色强调。
 * 2. 额度限制和短时熔断需要提醒但不一定是错误，使用黄色。
 * 3. 工作空间损坏、账号缺失等不可用异常使用红色。
 * 4. 禁用账号使用弱化样式，减少对可用账号的视觉干扰。
 *
 * @param status 已归一化的状态标签。
 * @param item 单个账号状态。
 * @param styled 是否启用 ANSI 样式。
 * @returns 应用于表格状态列的文本。
 * @throws 无显式抛出。
 */
function styleStatusCell(status: string, item: AccountRuntimeStatus, styled: boolean): string {
  if (!styled) {
    return status;
  }

  if (item.isAvailable) {
    return styleCell(status, TABLE_ANSI.green, styled);
  }

  if (!item.enabled) {
    return styleCell(status, TABLE_ANSI.dim, styled);
  }

  if (item.refreshErrorCode || !item.exists) {
    return styleCell(status, TABLE_ANSI.red, styled);
  }

  if (item.isFiveHourLimited || item.isWeeklyLimited || item.localBlockUntil) {
    return styleCell(status, TABLE_ANSI.yellow, styled);
  }

  return status;
}

/**
 * 对当前自动选中账号的名称做轻量强调。
 *
 * @param name 账号展示名称。
 * @param styled 是否启用 ANSI 样式。
 * @returns 表格名称列展示文本。
 * @throws 无显式抛出。
 */
function styleNameCell(name: string, styled: boolean): string {
  if (!styled || !name.endsWith("*")) {
    return name;
  }

  return styleCell(name, TABLE_ANSI.cyan, styled);
}

/**
 * 计算紧凑状态表中账号名称列可使用的显示宽度。
 *
 * 业务含义：
 * 1. 窄终端下保留最小可读名称。
 * 2. 终端变宽时优先把新增空间分配给账号名称，避免固定 12 列导致名字仍被截断。
 *
 * @param statuses 待展示账号状态。
 * @param hasSelector 是否展示选择/启用状态列。
 * @param maxWidth 当前终端最大显示列宽；无穷大表示不限制。
 * @param headerWidth 当前账号列标题宽度。
 * @param planWidth plan 列宽。
 * @param statusWidth 状态列宽。
 * @returns 账号名称列的目标显示宽度。
 * @throws 无显式抛出。
 */
function resolveCompactSlotWidth(
  statuses: AccountRuntimeStatus[],
  hasSelector: boolean,
  maxWidth: number,
  headerWidth: number,
  planWidth: number,
  statusWidth: number
): number {
  const longestNameWidth = Math.max(headerWidth, ...statuses.map((item) => getDisplayWidth(item.name)));

  if (!Number.isFinite(maxWidth)) {
    return longestNameWidth;
  }

  const fixedColumnWidths = [
    ...(hasSelector ? [4] : []),
    planWidth,
    3,
    4,
    statusWidth
  ];
  const separatorWidth = 2 * fixedColumnWidths.length;
  const availableWidth = Math.floor(maxWidth) - fixedColumnWidths.reduce((sum, width) => sum + width, 0) - separatorWidth;
  const minWidth = maxWidth < 56 ? 8 : 12;

  return Math.max(Math.min(longestNameWidth, availableWidth), Math.min(minWidth, Math.max(4, availableWidth)));
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
  const styled = options?.styled ?? false;
  const compactHeader = maxWidth < 68;
  const compactPlanWidth = maxWidth < 56 ? 4 : 6;
  const compactStatusWidth = maxWidth < 56 ? 12 : 18;
  const compactSlotHeader = compactHeader ? "ID" : "SLOT";
  const compactSlotWidth = resolveCompactSlotWidth(
    statuses,
    Boolean(selectorColumn),
    maxWidth,
    getDisplayWidth(compactSlotHeader),
    compactPlanWidth,
    compactStatusWidth
  );
  const rows = [
    compact
      ? [
          ...(selectorColumn ? [" "] : []),
          compactSlotHeader,
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
            styleNameCell(truncateCell(item.name, compactSlotWidth), styled),
            truncateCell(item.plan, compactPlanWidth),
            formatPercent(item.fiveHourLeftPercent),
            formatPercent(item.weeklyLeftPercent),
            styleStatusCell(truncateCell(status, compactStatusWidth), item, styled)
          ]
        : [
            ...(selectorCell ? [selectorCell] : []),
            styleNameCell(item.name, styled),
            item.email ?? "-",
            item.plan,
            formatPercent(item.fiveHourLeftPercent),
            formatReset(item.fiveHourResetsAt),
            formatPercent(item.weeklyLeftPercent),
            formatReset(item.weeklyResetsAt),
            styleStatusCell(status, item, styled)
          ]
    );
  }

  const widths = rows[0].map((_, columnIndex) =>
    Math.max(...rows.map((row) => getDisplayWidth(row[columnIndex])))
  );

  return rows
    .map((row) => row.map((cell, index) => padCell(cell, widths[index])).join("  "))
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
  options?: { maxWidth?: number; header?: boolean }
): string {
  const includeHeader = options?.header ?? true;

  if (!item) {
    return [includeHeader ? "[ current ]" : "slot   -", includeHeader ? "slot   -" : ""]
      .filter((line) => line.length > 0)
      .join("\n");
  }

  const maxWidth = options?.maxWidth ?? Number.POSITIVE_INFINITY;
  const narrow = maxWidth < 72;
  const lines = [
    ...(includeHeader ? ["[ current ]"] : []),
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
