import readline from "node:readline";
import { listAccounts } from "./app/account-service";
import {
  getStatusSnapshot,
  persistAccountEnabledState,
  refreshStatusSnapshot
} from "./app/status-service";
import { pickBestAccount } from "./scheduler";
import {
  collectAccountStatuses,
  renderStatusDetails,
  renderStatusTable,
  summarizeAccountStatuses
} from "./status";
import { refreshAllAccountUsage } from "./usage-sync";
import { bi } from "./text";
import type { AccountRuntimeStatus } from "./types";

export interface StatusCommandOptions {
  interactive?: boolean;
}

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m"
} as const;

/**
 * 判断当前终端是否适合启用 ANSI 样式，避免在 dumb/no-color 环境输出控制字符。
 *
 * @returns 可安全启用样式时返回 `true`，否则返回 `false`。
 * @throws 无显式抛出。
 */
function shouldUseAnsiStyle(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
}

/**
 * 对文本应用 ANSI 样式；当样式关闭时原样返回。
 *
 * @param text 原始文本。
 * @param color ANSI 颜色码。
 * @param enabled 是否启用 ANSI 样式。
 * @returns 样式化后的文本或原文。
 * @throws 无显式抛出。
 */
function paint(text: string, color: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }

  return `${color}${text}${ANSI.reset}`;
}

/**
 * 渲染分区标题行，兼容窄终端与普通宽度终端。
 *
 * @param title 分区标题文本。
 * @param width 当前终端宽度。
 * @param styled 是否启用 ANSI 样式。
 * @returns 可直接打印的单行分区标题。
 * @throws 无显式抛出。
 */
function renderSectionHeader(title: string, width: number, styled: boolean): string {
  if (width < 44) {
    return paint(`[ ${title} ]`, ANSI.cyan, styled);
  }

  const plainLabel = ` ${title} `;
  const targetWidth = Math.max(plainLabel.length + 2, Math.min(width, 96));
  const side = Math.max(1, Math.floor((targetWidth - plainLabel.length) / 2));
  const line = `${"-".repeat(side)}${plainLabel}${"-".repeat(side)}`;

  return paint(line.slice(0, targetWidth), ANSI.cyan, styled);
}

/**
 * 渲染摘要区可读性更高的计数文本，并对关键指标做轻量着色。
 *
 * @param summary 状态摘要计数。
 * @param narrowScreen 是否窄屏布局。
 * @param styled 是否启用 ANSI 样式。
 * @returns 摘要展示文本。
 * @throws 无显式抛出。
 */
function renderSummaryLine(
  summary: { available: number; fiveHourLimited: number; weeklyLimited: number },
  narrowScreen: boolean,
  styled: boolean
): string {
  const available = paint(String(summary.available), ANSI.green, styled);
  const fiveHourLimited = paint(String(summary.fiveHourLimited), ANSI.yellow, styled);
  const weeklyLimited = paint(String(summary.weeklyLimited), ANSI.yellow, styled);

  if (narrowScreen) {
    return `ok=${available}  5h=${fiveHourLimited}  wk=${weeklyLimited}`;
  }

  return `available=${available}  5h_limited=${fiveHourLimited}  weekly_limited=${weeklyLimited}`;
}

/**
 * 进入交互式全屏缓冲区，并隐藏光标，确保后续重绘始终基于固定画布。
 *
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function enterInteractiveScreen(): void {
  process.stdout.write("\x1b[?1049h");
  process.stdout.write("\x1b[?25l");
}

/**
 * 退出交互式全屏缓冲区，并恢复光标显示。
 *
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function leaveInteractiveScreen(): void {
  process.stdout.write("\x1b[?25h");
  process.stdout.write("\x1b[?1049l");
}

/**
 * 在交互式全屏缓冲区中从左上角整块重绘内容。
 *
 * @param lines 待输出的文本行数组。
 * @returns 无返回值。
 * @throws 无显式抛出。
 */
function renderInteractiveScreen(lines: string[]): void {
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);
  process.stdout.write(lines.join("\n"));
  process.stdout.write("\n");
}

/**
 * 计算交互式状态面板的初始光标位置。
 *
 * 业务规则：
 * 1. 优先定位到当前自动调度选中的账号。
 * 2. 若没有自动选中账号，则回退到首个可用账号。
 * 3. 若所有账号都不可用，则回退到首个已启用账号。
 *
 * @param accounts 已按展示顺序排好的账号列表。
 * @param statuses 当前账号运行时状态快照。
 * @returns 初始光标所在的数组下标。
 * @throws 无显式抛出。
 */
function resolveInitialCursorIndex(
  accounts: Array<{ id: string; enabled: boolean }>,
  statuses: AccountRuntimeStatus[]
): number {
  const selected = pickBestAccount();
  if (selected) {
    const selectedIndex = accounts.findIndex((account) => account.id === selected.account.id);
    if (selectedIndex >= 0) {
      return selectedIndex;
    }
  }

  const statusById = new Map(statuses.map((item) => [item.id, item]));
  const availableIndex = accounts.findIndex((account) => statusById.get(account.id)?.isAvailable);
  if (availableIndex >= 0) {
    return availableIndex;
  }

  const enabledIndex = accounts.findIndex((account) => account.enabled);
  if (enabledIndex >= 0) {
    return enabledIndex;
  }

  return 0;
}

/**
 * 进入账号启用状态的交互式切换界面，并在用户确认退出后恢复终端状态。
 *
 * @param initialStatuses 进入交互前刚刷新的账号状态快照，用于首屏复用同一块展示区域。
 * @returns Promise，在用户按下 `Enter`、`q` 或 `Ctrl+C` 退出交互后完成。
 * @throws 当终端读写异常时透传底层错误。
 */
async function handleInteractiveToggle(initialStatuses?: AccountRuntimeStatus[]): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(
      bi(
        "当前环境不支持交互式操作，请直接编辑配置文件或使用 --no-interactive 选项。",
        "Interactive mode is unavailable in the current environment. Edit the config file directly or use --no-interactive."
      )
    );
    return;
  }

  const stdin = process.stdin as NodeJS.ReadStream & { setRawMode?: (mode: boolean) => void };
  readline.emitKeypressEvents(stdin);
  stdin.setRawMode?.(true);

  const accountsFromConfig = listAccounts();
  if (accountsFromConfig.length === 0) {
    console.log(bi("当前没有已录入账号。", "No managed accounts found."));
    stdin.setRawMode?.(false);
    return;
  }

  const accounts = [...accountsFromConfig].sort((left, right) => left.name.localeCompare(right.name));
  let cursor = resolveInitialCursorIndex(accounts, initialStatuses ?? collectAccountStatuses());
  let changed = false;

  enterInteractiveScreen();

  return await new Promise<void>((resolve) => {
    let closed = false;

    const render = () => {
      const screenWidth = process.stdout.columns ?? 80;
      const narrowScreen = screenWidth < 72;
      const styled = shouldUseAnsiStyle();
      const latestSnapshot = getStatusSnapshot();
      const statusSource = changed ? latestSnapshot.statuses : (initialStatuses ?? latestSnapshot.statuses);
      const statusById = new Map(statusSource.map((item) => [item.id, item]));
      const autoSelectedId = pickBestAccount()?.account.id ?? null;
      const summary = summarizeAccountStatuses(statusSource);

      const displayStatuses = accounts
        .map((account) => {
          const status = statusById.get(account.id);
          if (!status) {
            return null;
          }

          return {
            ...status,
            name: account.id === autoSelectedId ? `${status.name}*` : status.name
          };
        })
        .filter((item): item is AccountRuntimeStatus => item !== null);
      const currentItem = displayStatuses.find((item) => item.id === accounts[cursor]?.id) ?? null;

      renderInteractiveScreen([
        renderSectionHeader("accounts", screenWidth, styled),
        renderStatusTable(displayStatuses, {
          compact: true,
          maxWidth: screenWidth,
          selectorColumn: {
            enabledById: Object.fromEntries(accounts.map((account) => [account.id, account.enabled])),
            cursorAccountId: accounts[cursor]?.id ?? null
          }
        }),
        "",
        renderStatusDetails(currentItem, { maxWidth: screenWidth }),
        "",
        renderSectionHeader("summary", screenWidth, styled),
        renderSummaryLine(summary, narrowScreen, styled),
        `selected=${latestSnapshot.selectedName ?? "none"}`,
        "",
        renderSectionHeader("help", screenWidth, styled),
        bi(
          narrowScreen ? "Space 切换，Enter / q 退出。" : "Space 切换启用状态，Enter / q 退出。",
          narrowScreen ? "Space toggles, Enter or q exits." : "Space toggles enabled state, Enter or q exits."
        )
      ]);
    };

    const applyChanges = () => {
      if (!changed) {
        return;
      }

      persistAccountEnabledState(accounts);
      changed = false;
      initialStatuses = collectAccountStatuses();
    };

    const exitInteractive = () => {
      if (closed) {
        return;
      }
      closed = true;

      applyChanges();
      stdin.off("keypress", onKeypress);
      stdin.setRawMode?.(false);
      stdin.pause();
      leaveInteractiveScreen();

      console.log(bi("已退出账号启用状态编辑。", "Exited account toggle mode."));
      resolve();
    };

    const onKeypress = (_input: string, key: readline.Key) => {
      if (key.name === "up") {
        const nextCursor = Math.max(0, cursor - 1);
        if (nextCursor !== cursor) {
          cursor = nextCursor;
          render();
        }
        return;
      }

      if (key.name === "down") {
        const nextCursor = Math.min(accounts.length - 1, cursor + 1);
        if (nextCursor !== cursor) {
          cursor = nextCursor;
          render();
        }
        return;
      }

      if (key.name === "space") {
        accounts[cursor].enabled = !accounts[cursor].enabled;
        changed = true;
        applyChanges();
        render();
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        exitInteractive();
        return;
      }

      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        exitInteractive();
      }
    };

    render();
    stdin.on("keypress", onKeypress);
  });
}

/**
 * 刷新所有已录入账号的远端额度，并输出最新状态表格。
 *
 * @param options 状态命令配置；默认进入交互式启用开关界面。
 * @returns Promise，无返回值。
 * @throws 当额度刷新或终端交互失败时透传底层异常。
 */
export async function handleStatus(options?: StatusCommandOptions): Promise<void> {
  const snapshot = await refreshStatusSnapshot();
  const interactive = options?.interactive ?? true;

  if (interactive) {
    await handleInteractiveToggle(snapshot.statuses);
    return;
  }

  const displayStatuses = snapshot.statuses.map((item) => ({
    ...item,
    name: item.id === pickBestAccount()?.account.id ? `${item.name}*` : item.name
  }));

  console.log(renderStatusTable(displayStatuses));
  console.log("");
  console.log(`available=${snapshot.summary.available} 5h_limited=${snapshot.summary.fiveHourLimited} weekly_limited=${snapshot.summary.weeklyLimited}`);
  console.log(`selected=${snapshot.selectedName ?? "none"}`);
}
