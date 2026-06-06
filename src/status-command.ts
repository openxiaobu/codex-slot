import readline from "node:readline";
import { hasCompleteCodexAuthState } from "./account-store";
import { listAccounts } from "./app/account-service";
import {
  getStatusSnapshot,
  persistAccountEnabledState,
  persistRelayEnabledState,
  refreshStatusSnapshot
} from "./app/status-service";
import { pickBestAccount } from "./scheduler";
import {
  getSelectedCodexAuthAccountId,
  getSelectedModelRoute,
  setSelectedCodexAuthAccountId,
  setSelectedModelRoute
} from "./state";
import { applyManagedCodexAuth, deactivateManagedCodexAuth } from "./codex-auth";
import {
  collectAccountStatuses,
  renderRelayStatusDetails,
  renderRelayStatusTable,
  renderStatusDetails,
  renderStatusTable,
  summarizeAccountStatuses
} from "./status";
import { bi } from "./text";
import type { AccountRuntimeStatus, ManagedAccount } from "./types";

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
 * 渲染轻量分隔线，用于账号主表与当前账号明细之间建立清晰层次。
 *
 * @param width 当前终端宽度。
 * @param styled 是否启用 ANSI 样式。
 * @returns 可直接打印的分隔线文本。
 * @throws 无显式抛出。
 */
function renderDivider(width: number, styled: boolean): string {
  const dividerWidth = Math.max(24, Math.min(width, 96));
  return paint("-".repeat(dividerWidth), ANSI.dim, styled);
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
 * 移除 ANSI 控制序列，避免布局计算把颜色码当成可见字符。
 *
 * @param value 可能包含 ANSI 样式的文本。
 * @returns 去除 ANSI 控制符后的文本。
 * @throws 无显式抛出。
 */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * 判断字符是否应按双列宽展示。
 *
 * @param codePoint Unicode code point；必须来自单个字符迭代结果。
 * @returns 中文、全角符号等宽字符返回 `true`，其他字符返回 `false`。
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
 * @param value 待计算的文本；允许包含 ANSI 样式。
 * @returns 文本实际占用的显示列数。
 * @throws 无显式抛出。
 */
function getDisplayWidth(value: string): number {
  let width = 0;

  for (const char of stripAnsi(value)) {
    const codePoint = char.codePointAt(0) ?? 0;
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }

  return width;
}

/**
 * 按显示宽度补齐右侧空格。
 *
 * @param value 原始文本；允许包含 ANSI 样式。
 * @param width 目标显示列宽。
 * @returns 右侧补齐后的文本。
 * @throws 无显式抛出。
 */
function padVisible(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - getDisplayWidth(value)))}`;
}

/**
 * 将左右两组文本行渲染为双栏布局。
 *
 * 业务含义：
 * 1. 宽屏状态页左侧展示账号列表，右侧展示当前账号与摘要。
 * 2. 左栏高度通常更高，右栏缺失行需要自动补空，避免右侧内容把左表挤乱。
 *
 * @param leftLines 左栏文本行。
 * @param rightLines 右栏文本行。
 * @param gap 两栏之间的空格数量。
 * @returns 合并后的双栏文本行。
 * @throws 无显式抛出。
 */
function renderColumns(leftLines: string[], rightLines: string[], gap: number): string[] {
  const leftWidth = Math.max(0, ...leftLines.map((line) => getDisplayWidth(line)));
  const rowCount = Math.max(leftLines.length, rightLines.length);
  const rows: string[] = [];

  for (let index = 0; index < rowCount; index += 1) {
    rows.push(`${padVisible(leftLines[index] ?? "", leftWidth)}${" ".repeat(gap)}${rightLines[index] ?? ""}`.trimEnd());
  }

  return rows;
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
 * 1. 优先定位到用户手动选择的 Codex App 登录态账号。
 * 2. 若没有手动选择，则回退到当前自动调度选中的账号。
 * 3. 若没有自动选中账号，则回退到首个可用账号。
 * 4. 若所有账号都不可用，则回退到首个已启用账号。
 *
 * @param accounts 已按展示顺序排好的账号列表。
 * @param statuses 当前账号运行时状态快照。
 * @param selectedAuthAccountId 用户手动选择的 Codex App 登录态账号 id。
 * @returns 初始光标所在的数组下标。
 * @throws 无显式抛出。
 */
function resolveInitialCursorIndex(
  accounts: Array<{ id: string; enabled: boolean }>,
  statuses: AccountRuntimeStatus[],
  selectedAuthAccountId: string | null
): number {
  if (selectedAuthAccountId) {
    const selectedAuthIndex = accounts.findIndex((account) => account.id === selectedAuthAccountId);
    if (selectedAuthIndex >= 0) {
      return selectedAuthIndex;
    }
  }

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

type InteractiveStatusItem =
  | {
      type: "account";
      id: string;
    }
  | {
      type: "relay";
      id: string;
    };

function buildInteractiveItems(
  accounts: Array<{ id: string }>,
  relaySlots: Array<{ id: string }>
): InteractiveStatusItem[] {
  return [
    ...accounts.map((account) => ({ type: "account" as const, id: account.id })),
    ...relaySlots.map((slot) => ({ type: "relay" as const, id: slot.id }))
  ];
}

/**
 * 将状态面板中选中的账号立即应用为 Codex App 主登录态。
 *
 * 业务含义：
 * 1. 该操作只切换主 `~/.codex/auth.json` 的来源账号，不改变代理调度顺序。
 * 2. 被选择账号可以是 disabled，因为 enabled 只控制代理请求调度。
 * 3. 登录态不完整时拒绝保存选择，避免下一次 `start` 静默失败或切错账号。
 *
 * @param account 用户在状态面板中选中的受管账号。
 * @returns 失败时返回错误文本；成功时返回 `null`。
 * @throws 无显式抛出；文件系统错误会转为返回文本。
 */
function applyCodexAuthSelection(account: ManagedAccount): string | null {
  try {
    if (!hasCompleteCodexAuthState(account.codex_home)) {
      return `账号 ${account.id} 缺少完整 auth.json`;
    }

    setSelectedCodexAuthAccountId(account.id);
    applyManagedCodexAuth(account.codex_home, { sourceAccountId: account.id });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
  const latestSnapshotForRelays = getStatusSnapshot();
  const relaySlotsFromConfig = latestSnapshotForRelays.relaySlots;
  if (accountsFromConfig.length === 0 && relaySlotsFromConfig.length === 0) {
    console.log(bi("当前没有已录入账号或中转槽位。", "No managed accounts or relay slots found."));
    stdin.setRawMode?.(false);
    return;
  }

  const accounts = [...accountsFromConfig].sort((left, right) => left.name.localeCompare(right.name));
  const relaySlots = [...relaySlotsFromConfig].sort((left, right) => left.name.localeCompare(right.name));
  let selectedAuthAccountId = getSelectedCodexAuthAccountId();
  const initialItems = buildInteractiveItems(accounts, relaySlots);
  const selectedModelRoute = getSelectedModelRoute();
  const initialAccountCursor = resolveInitialCursorIndex(
    accounts,
    initialStatuses ?? collectAccountStatuses(),
    selectedAuthAccountId
  );
  const selectedRelayIndex =
    selectedModelRoute.mode === "relay_slot"
      ? relaySlots.findIndex((slot) => slot.id === selectedModelRoute.relay_slot_id)
      : -1;
  let cursor =
    selectedRelayIndex >= 0
      ? accounts.length + selectedRelayIndex
      : Math.min(initialAccountCursor, Math.max(0, initialItems.length - 1));
  let accountChanged = false;
  let relayChanged = false;

  enterInteractiveScreen();

  return await new Promise<void>((resolve) => {
    let closed = false;
    let refreshing = false;
    let refreshStatusText: string | null = null;

    const render = () => {
      const screenWidth = process.stdout.columns ?? 80;
      const styled = shouldUseAnsiStyle();
      const latestSnapshot = getStatusSnapshot();
      const items = buildInteractiveItems(accounts, relaySlots);
      const currentSelection = items[cursor] ?? null;
      const statusSource = accountChanged ? latestSnapshot.statuses : (initialStatuses ?? latestSnapshot.statuses);
      const statusById = new Map(statusSource.map((item) => [item.id, item]));
      const autoSelectedId = pickBestAccount()?.account.id ?? null;
      const summary = summarizeAccountStatuses(statusSource);

      const displayStatuses = accounts
        .map((account) => {
          const status = statusById.get(account.id);
          if (!status) {
            return null;
          }

          const markers = `${account.id === autoSelectedId ? "*" : ""}${account.id === selectedAuthAccountId ? "@" : ""}`;

          return {
            ...status,
            name: markers ? `${status.name}${markers}` : status.name
          };
        })
        .filter((item): item is AccountRuntimeStatus => item !== null);
      const displayRelays = relaySlots.map((slot) => {
        const selected =
          latestSnapshot.modelRoute.mode === "relay_slot" &&
          latestSnapshot.modelRoute.relay_slot_id === slot.id;

        return {
          ...slot,
          name: selected ? `${slot.name}*` : slot.name
        };
      });
      const currentAccount =
        currentSelection?.type === "account"
          ? displayStatuses.find((item) => item.id === currentSelection.id) ?? null
          : null;
      const currentRelay =
        currentSelection?.type === "relay"
          ? displayRelays.find((item) => item.id === currentSelection.id) ?? null
          : null;
      const wideLayout = screenWidth >= 104;
      const leftWidth = wideLayout ? Math.max(68, Math.floor(screenWidth * 0.64)) : screenWidth;
      const rightWidth = wideLayout ? Math.max(28, screenWidth - leftWidth - 3) : screenWidth;
      const accountLines = [
        renderSectionHeader("accounts", leftWidth, styled),
        ...renderStatusTable(displayStatuses, {
          compact: true,
          maxWidth: leftWidth,
          styled,
          selectorColumn: {
            enabledById: Object.fromEntries(accounts.map((account) => [account.id, account.enabled])),
            cursorAccountId: currentSelection?.type === "account" ? currentSelection.id : null
          }
        }).split("\n")
      ];
      const relayLines = [
        renderSectionHeader("relays", leftWidth, styled),
        ...(displayRelays.length > 0
          ? renderRelayStatusTable(displayRelays, {
              compact: true,
              maxWidth: leftWidth,
              styled,
              selectorColumn: {
                enabledById: Object.fromEntries(relaySlots.map((slot) => [slot.id, slot.enabled])),
                cursorRelayId: currentSelection?.type === "relay" ? currentSelection.id : null
              }
            }).split("\n")
          : ["-"])
      ];
      const currentDetails =
        currentSelection?.type === "relay"
          ? renderRelayStatusDetails(currentRelay, { maxWidth: rightWidth, header: false }).split("\n")
          : renderStatusDetails(currentAccount, { maxWidth: rightWidth, header: false }).split("\n");
      const sideLines = [
        renderSectionHeader("current", rightWidth, styled),
        ...currentDetails,
        "",
        renderSectionHeader("summary", rightWidth, styled),
        renderSummaryLine(summary, rightWidth < 42, styled),
        `model_route=${latestSnapshot.modelRouteLabel}`,
        `scheduler=${latestSnapshot.selectedName ?? "none"}`,
        `codex_auth=${selectedAuthAccountId ?? "none"}`,
        `relay_slots=${latestSnapshot.relaySlots.length}`,
        ...(refreshStatusText ? [`refresh=${refreshStatusText}`] : []),
        "",
        renderSectionHeader("help", rightWidth, styled),
        "↑/↓ move    Space toggle    a app-auth    m model-route    c clear    r refresh    Enter/q exit"
      ];
      const leftLines = [
        ...accountLines,
        "",
        ...relayLines
      ];

      if (wideLayout) {
        renderInteractiveScreen(renderColumns(leftLines, sideLines, 3));
        return;
      }

      renderInteractiveScreen([
        ...leftLines,
        "",
        renderDivider(screenWidth, styled),
        ...sideLines
      ]);
    };

    const applyChanges = () => {
      if (!accountChanged && !relayChanged) {
        return;
      }

      if (accountChanged) {
        persistAccountEnabledState(accounts);
        accountChanged = false;
        initialStatuses = collectAccountStatuses();
      }

      if (relayChanged) {
        persistRelayEnabledState(relaySlots);
        relayChanged = false;
      }
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

    const onKeypress = async (_input: string, key: readline.Key) => {
      if (key.name === "up") {
        const nextCursor = Math.max(0, cursor - 1);
        if (nextCursor !== cursor) {
          cursor = nextCursor;
          render();
        }
        return;
      }

      if (key.name === "down") {
        const nextCursor = Math.min(buildInteractiveItems(accounts, relaySlots).length - 1, cursor + 1);
        if (nextCursor !== cursor) {
          cursor = nextCursor;
          render();
        }
        return;
      }

      if (key.name === "space") {
        const item = buildInteractiveItems(accounts, relaySlots)[cursor];
        if (item?.type === "account") {
          const account = accounts.find((candidate) => candidate.id === item.id);
          if (account) {
            account.enabled = !account.enabled;
            accountChanged = true;
          }
        } else if (item?.type === "relay") {
          const slot = relaySlots.find((candidate) => candidate.id === item.id);
          if (slot) {
            slot.enabled = !slot.enabled;
            relayChanged = true;
          }
        }
        applyChanges();
        render();
        return;
      }

      if (key.name === "a") {
        const item = buildInteractiveItems(accounts, relaySlots)[cursor];
        if (item?.type !== "account") {
          refreshStatusText = "app-auth requires account";
          render();
          return;
        }

        const account = accounts.find((candidate) => candidate.id === item.id);
        if (!account) {
          return;
        }

        const errorMessage = applyCodexAuthSelection(account);
        if (errorMessage) {
          refreshStatusText = errorMessage;
          render();
          return;
        }

        selectedAuthAccountId = account.id;
        refreshStatusText = `codex_auth=${account.id}`;
        render();
        return;
      }

      if (key.name === "m") {
        const item = buildInteractiveItems(accounts, relaySlots)[cursor];

        if (item?.type === "relay") {
          const slot = relaySlots.find((candidate) => candidate.id === item.id);
          if (!slot) {
            return;
          }

          if (!slot.enabled) {
            refreshStatusText = `relay_disabled=${slot.id}`;
            render();
            return;
          }

          setSelectedModelRoute({
            mode: "relay_slot",
            relay_slot_id: slot.id
          });
          refreshStatusText = `model_route=relay:${slot.id}`;
          render();
          return;
        }

        setSelectedModelRoute({
          mode: "auth_pool"
        });
        refreshStatusText = "model_route=auth_pool";
        render();
        return;
      }

      if (key.name === "c") {
        selectedAuthAccountId = null;
        setSelectedCodexAuthAccountId(null);
        deactivateManagedCodexAuth();
        refreshStatusText = "codex_auth=cleared";
        render();
        return;
      }

      if (key.name === "r") {
        if (refreshing) {
          return;
        }

        refreshing = true;
        applyChanges();
        refreshStatusText = "refreshing";
        render();

        try {
          const refreshed = await refreshStatusSnapshot();
          initialStatuses = refreshed.statuses;
          refreshStatusText = "done";
        } catch (error) {
          refreshStatusText = error instanceof Error ? error.message : String(error);
        } finally {
          refreshing = false;
        }

        if (!closed) {
          render();
        }
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
    name: `${item.name}${item.id === pickBestAccount()?.account.id ? "*" : ""}${item.id === snapshot.codexAuthAccountId ? "@" : ""}`
  }));

  console.log(renderStatusTable(displayStatuses));
  if (snapshot.relaySlots.length > 0) {
    const displayRelays = snapshot.relaySlots.map((slot) => ({
      ...slot,
      name:
        snapshot.modelRoute.mode === "relay_slot" &&
        snapshot.modelRoute.relay_slot_id === slot.id
          ? `${slot.name}*`
          : slot.name
    }));

    console.log("");
    console.log(renderRelayStatusTable(displayRelays));
  }
  console.log("");
  console.log(`available=${snapshot.summary.available} 5h_limited=${snapshot.summary.fiveHourLimited} weekly_limited=${snapshot.summary.weeklyLimited}`);
  console.log(`model_route=${snapshot.modelRouteLabel}`);
  console.log(`scheduler=${snapshot.selectedName ?? "none"}`);
  console.log(`codex_auth=${snapshot.codexAuthAccountId ?? "none"}`);
  console.log(`relay_slots=${snapshot.relaySlots.length}`);
}
