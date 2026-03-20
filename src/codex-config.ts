import fs from "node:fs";
import path from "node:path";
import { expandHome, loadConfig } from "./config";
import {
  clearManagedCodexConfigState,
  getManagedCodexConfigState,
  setManagedCodexConfigState
} from "./state";
import { bi } from "./text";
import type { CslotConfig, ManagedCodexConfigState } from "./types";

const MODEL_PROVIDER_START_MARKER = "# >>> cslot model_provider >>>";
const MODEL_PROVIDER_END_MARKER = "# <<< cslot model_provider <<<";
const PROVIDER_BLOCK_START_MARKER = "# >>> cslot provider:cslot >>>";
const PROVIDER_BLOCK_END_MARKER = "# <<< cslot provider:cslot <<<";

/**
 * 返回默认的 `codex config.toml` 路径。
 *
 * @returns 默认 `config.toml` 绝对路径。
 */
export function getDefaultCodexConfigPath(): string {
  return path.join(process.env.HOME ?? "", ".codex", "config.toml");
}

/**
 * 原子方式写入目标文件，避免写入过程中留下半截配置。
 *
 * @param targetFile 目标文件绝对路径。
 * @param content 完整文件内容。
 * @returns 无返回值。
 * @throws 当目录创建、临时文件写入或重命名失败时抛出文件系统错误。
 */
function writeFileAtomic(targetFile: string, content: string): void {
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  const tmpFile = `${targetFile}.tmp-${process.pid}-${Date.now()}`;

  fs.writeFileSync(tmpFile, content, "utf8");
  fs.renameSync(tmpFile, targetFile);
}

/**
 * 根据当前文件内容推断换行符风格，尽量保持用户原文件格式不变。
 *
 * @param content 原始文件内容。
 * @returns 当前文件使用的换行符；未命中时默认返回 `\n`。
 */
function detectEol(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * 生成受 cslot 接管的 `model_provider` 配置块。
 *
 * @param eol 目标文件当前使用的换行符。
 * @returns 带标记的配置块文本。
 */
function buildManagedModelProviderBlock(eol: string): string {
  return [
    MODEL_PROVIDER_START_MARKER,
    'model_provider = "cslot"',
    MODEL_PROVIDER_END_MARKER
  ].join(eol);
}

/**
 * 生成受 cslot 接管的 provider 配置块。
 *
 * @param eol 目标文件当前使用的换行符。
 * @returns 带标记的 provider 配置块文本。
 */
function buildManagedProviderBlock(eol: string, config: CslotConfig): string {
  return [
    PROVIDER_BLOCK_START_MARKER,
    "[model_providers.cslot]",
    'name = "cslot"',
    `base_url = "http://${config.server.host}:${config.server.port}/v1"`,
    'wire_api = "responses"',
    `experimental_bearer_token = "${config.server.api_key}"`,
    PROVIDER_BLOCK_END_MARKER
  ].join(eol);
}

/**
 * 在文本中定位受 cslot 接管的块范围。
 *
 * @param content 原始文件内容。
 * @param startMarker 块起始标记。
 * @param endMarker 块结束标记。
 * @returns 命中时返回起止偏移；未命中返回 `null`。
 */
function findMarkedBlockRange(
  content: string,
  startMarker: string,
  endMarker: string
): { start: number; end: number } | null {
  const start = content.indexOf(startMarker);
  if (start < 0) {
    return null;
  }

  const endMarkerIndex = content.indexOf(endMarker, start);
  if (endMarkerIndex < 0) {
    return null;
  }

  let end = endMarkerIndex + endMarker.length;
  if (content.slice(end, end + 2) === "\r\n") {
    end += 2;
  } else if (content.slice(end, end + 1) === "\n") {
    end += 1;
  }

  return { start, end };
}

/**
 * 反复移除文本中所有带指定标记的受管块，避免异常退出后残留旧块导致后续写入出现重复或串位。
 *
 * @param content 当前 `config.toml` 内容。
 * @param startMarker 块起始标记。
 * @param endMarker 块结束标记。
 * @returns 清理后的文本内容。
 */
function stripMarkedBlocks(
  content: string,
  startMarker: string,
  endMarker: string
): string {
  let stripped = content;

  while (true) {
    const range = findMarkedBlockRange(stripped, startMarker, endMarker);
    if (!range) {
      return stripped;
    }

    stripped = stripped.slice(0, range.start) + stripped.slice(range.end);
  }
}

/**
 * 查找首个 `model_provider` 配置块，兼容已启用与注释掉的场景。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 命中时返回完整块及其偏移；未命中返回 `null`。
 */
function findModelProviderLine(
  content: string
): { start: number; end: number; value: string } | null {
  const lines = content.split(/\r?\n/);
  let offset = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineStart = offset;
    const lineEnd = offset + line.length;

    if (
      /^model_provider\s*=/.test(trimmed) ||
      /^#\s*model_provider\s*=/.test(trimmed)
    ) {
      let blockEnd = lineEnd;
      let nextOffset = lineEnd;

      if (content.slice(lineEnd, lineEnd + 2) === "\r\n") {
        blockEnd += 2;
        nextOffset += 2;
      } else if (content.slice(lineEnd, lineEnd + 1) === "\n") {
        blockEnd += 1;
        nextOffset += 1;
      }

      for (let j = i + 1; j < lines.length; j += 1) {
        const nextLine = lines[j];
        const nextLineEnd = nextOffset + nextLine.length;

        if (nextLine.trim() !== "") {
          break;
        }

        blockEnd = nextLineEnd;
        if (content.slice(nextLineEnd, nextLineEnd + 2) === "\r\n") {
          blockEnd += 2;
          nextOffset = nextLineEnd + 2;
        } else if (content.slice(nextLineEnd, nextLineEnd + 1) === "\n") {
          blockEnd += 1;
          nextOffset = nextLineEnd + 1;
        } else {
          nextOffset = nextLineEnd;
        }
      }

      return {
        start: lineStart,
        end: blockEnd,
        value: content.slice(lineStart, blockEnd)
      };
    }

    offset = lineEnd + (content.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1);
  }

  return null;
}

/**
 * 查找指定表块的文本范围。
 *
 * @param content 当前 `config.toml` 内容。
 * @param header 目标表头，例如 `[model_providers.cslot]`。
 * @returns 命中时返回完整表块范围；未命中返回 `null`。
 */
function findTableSectionRange(
  content: string,
  header: string
): { start: number; end: number; value: string } | null {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  let startLineIndex = -1;
  let startOffset = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineEnd = offset + line.length;

    if (line.trim() === header) {
      startLineIndex = i;
      startOffset = offset;
      break;
    }

    offset = lineEnd + (content.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1);
  }

  if (startLineIndex < 0 || startOffset < 0) {
    return null;
  }

  let endOffset = startOffset;
  offset = startOffset;

  for (let i = startLineIndex; i < lines.length; i += 1) {
    const line = lines[i];
    const lineEnd = offset + line.length;
    const trimmed = line.trim();

    if (i > startLineIndex && trimmed.startsWith("[") && !trimmed.startsWith("[[")) {
      break;
    }

    endOffset = lineEnd;
    if (content.slice(lineEnd, lineEnd + 2) === "\r\n") {
      endOffset += 2;
      offset = lineEnd + 2;
    } else if (content.slice(lineEnd, lineEnd + 1) === "\n") {
      endOffset += 1;
      offset = lineEnd + 1;
    } else {
      offset = lineEnd + 1;
    }
  }

  return {
    start: startOffset,
    end: endOffset,
    value: content.slice(startOffset, endOffset)
  };
}

/**
 * 查找 `[model_providers.cslot]` 表块的文本范围。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 命中时返回完整表块范围；未命中返回 `null`。
 */
function findProviderSectionRange(content: string): { start: number; end: number; value: string } | null {
  return findTableSectionRange(content, "[model_providers.cslot]");
}

/**
 * 查找指定表头所在的行起始偏移。
 *
 * @param content 当前 `config.toml` 内容。
 * @param header 目标表头。
 * @returns 命中时返回表头行起始偏移；未命中返回 `null`。
 */
function findTableHeaderOffset(content: string, header: string): number | null {
  const lines = content.split(/\r?\n/);
  let offset = 0;

  for (const line of lines) {
    const lineEnd = offset + line.length;

    if (line.trim() === header) {
      return offset;
    }

    offset = lineEnd + (content.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1);
  }

  return null;
}

/**
 * 查找指定偏移之前最近的表头，供恢复原有表块位置时作为后备锚点。
 *
 * @param content 当前 `config.toml` 内容。
 * @param offset 截止偏移。
 * @returns 最近的表头文本；未命中返回 `null`。
 */
function findPreviousTableHeaderBeforeOffset(content: string, offset: number): string | null {
  const lines = content.split(/\r?\n/);
  let currentOffset = 0;
  let previousHeader: string | null = null;

  for (const line of lines) {
    const lineEnd = currentOffset + line.length;
    const trimmed = line.trim();

    if (currentOffset >= offset) {
      break;
    }

    if (trimmed.startsWith("[") && !trimmed.startsWith("[[") && !trimmed.startsWith("#")) {
      previousHeader = trimmed;
    }

    currentOffset = lineEnd + (content.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1);
  }

  return previousHeader;
}

/**
 * 查找指定偏移之后的首个表头，供恢复原有表块位置时作为优先锚点。
 *
 * @param content 当前 `config.toml` 内容。
 * @param offset 起始偏移。
 * @returns 首个后续表头文本；未命中返回 `null`。
 */
function findNextTableHeaderAfterOffset(content: string, offset: number): string | null {
  const lines = content.split(/\r?\n/);
  let currentOffset = 0;

  for (const line of lines) {
    const lineEnd = currentOffset + line.length;
    const trimmed = line.trim();

    if (
      currentOffset >= offset &&
      trimmed.startsWith("[") &&
      !trimmed.startsWith("[[") &&
      !trimmed.startsWith("#")
    ) {
      return trimmed;
    }

    currentOffset = lineEnd + (content.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1);
  }

  return null;
}

/**
 * 清理文本中的所有 `model_provider` 配置块，确保每次接管都以单一稳定块重新写入。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 移除后的文本内容。
 */
function removeAllModelProviderLines(content: string): string {
  let nextContent = content;

  while (true) {
    const range = findModelProviderLine(nextContent);
    if (!range) {
      return nextContent;
    }

    nextContent = nextContent.slice(0, range.start) + nextContent.slice(range.end);
  }
}

/**
 * 清理文本中的所有 `[model_providers.cslot]` 表块，避免残留旧块影响下一段配置。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 移除后的文本内容。
 */
function removeAllProviderSections(content: string): string {
  let nextContent = content;

  while (true) {
    const range = findProviderSectionRange(nextContent);
    if (!range) {
      return nextContent;
    }

    nextContent = nextContent.slice(0, range.start) + nextContent.slice(range.end);
  }
}

/**
 * 移除所有 cslot 受管标记块，得到不包含历史残留接管片段的基线内容。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 清理后的基线内容。
 */
function stripAllManagedBlocks(content: string): string {
  const withoutProviderBlock = stripMarkedBlocks(
    content,
    PROVIDER_BLOCK_START_MARKER,
    PROVIDER_BLOCK_END_MARKER
  );

  return stripMarkedBlocks(
    withoutProviderBlock,
    MODEL_PROVIDER_START_MARKER,
    MODEL_PROVIDER_END_MARKER
  );
}

/**
 * 查找根级配置区的尾部插入点。
 *
 * 业务规则：
 * 1. 若文件中存在 table header，则插入到首个 table 之前，保证 `model_provider` 仍处于根级作用域。
 * 2. 若文件不存在任何 table，则允许直接追加到文件尾部。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 可用于插入根级配置块的偏移位置。
 */
function findRootSectionInsertOffset(content: string): number {
  const lines = content.split(/\r?\n/);
  let offset = 0;

  for (const line of lines) {
    const lineEnd = offset + line.length;
    const trimmed = line.trim();

    if (trimmed.startsWith("[") && !trimmed.startsWith("#")) {
      return offset;
    }

    offset = lineEnd + (content.slice(lineEnd, lineEnd + 2) === "\r\n" ? 2 : 1);
  }

  return content.length;
}

/**
 * 将根级配置块插回根级区域。
 *
 * 若能命中原始记录的后续表头，则优先插回该表头前；否则回退到首个表头前。
 *
 * @param content 当前 `config.toml` 内容。
 * @param block 待插入的根级配置块。
 * @param eol 目标换行符。
 * @param preferredNextTableHeader 原始记录的后续表头锚点。
 * @returns 插入后的完整文本。
 */
function insertRootBlock(
  content: string,
  block: string,
  eol: string,
  preferredNextTableHeader?: string | null
): string {
  const preferredOffset = preferredNextTableHeader
    ? findTableHeaderOffset(content, preferredNextTableHeader)
    : null;
  const insertOffset = preferredOffset ?? findRootSectionInsertOffset(content);

  return insertBlockBetween(
    content.slice(0, insertOffset),
    block,
    content.slice(insertOffset),
    eol
  );
}

/**
 * 将指定文本规范为单个块插入形式，避免在块两侧不断叠加多余空行。
 *
 * @param before 插入点前的文本。
 * @param block 待插入块。
 * @param after 插入点后的文本。
 * @param eol 目标换行符。
 * @returns 插入后的完整文本。
 */
function insertBlockBetween(before: string, block: string, after: string, eol: string): string {
  const normalizedBefore = before.endsWith(eol) || before.length === 0 ? before : `${before}${eol}`;
  const normalizedAfter = after.startsWith(eol) || after.length === 0 ? after : `${eol}${after}`;

  return `${normalizedBefore}${block}${normalizedAfter}`;
}

/**
 * 将配置块稳定追加到文件尾部，统一清理尾部多余空行，避免多次接管后空行不断累积。
 *
 * @param content 当前 `config.toml` 内容。
 * @param block 待追加配置块。
 * @param eol 目标换行符。
 * @returns 追加后的完整文本。
 */
function appendBlockToEnd(content: string, block: string, eol: string): string {
  let trimmed = content;

  while (trimmed.endsWith(eol)) {
    trimmed = trimmed.slice(0, -eol.length);
  }

  if (trimmed.length === 0) {
    return `${block}${eol}`;
  }

  return `${trimmed}${eol}${eol}${block}${eol}`;
}

/**
 * 将表块尽量插回原有相邻表头附近；若锚点已不存在，则退回文件尾部追加。
 *
 * @param content 当前 `config.toml` 内容。
 * @param block 待插入的表块。
 * @param eol 目标换行符。
 * @param preferredNextTableHeader 原始后续表头锚点，命中时优先插到该表之前。
 * @param preferredPreviousTableHeader 原始前驱表头锚点，当前者失效时插到该表之后。
 * @returns 插入后的完整文本。
 */
function insertTableBlock(
  content: string,
  block: string,
  eol: string,
  preferredNextTableHeader?: string | null,
  preferredPreviousTableHeader?: string | null
): string {
  if (preferredNextTableHeader) {
    const nextOffset = findTableHeaderOffset(content, preferredNextTableHeader);
    if (nextOffset !== null) {
      return insertBlockBetween(
        content.slice(0, nextOffset),
        block,
        content.slice(nextOffset),
        eol
      );
    }
  }

  if (preferredPreviousTableHeader) {
    const previousRange = findTableSectionRange(content, preferredPreviousTableHeader);
    if (previousRange) {
      return insertBlockBetween(
        content.slice(0, previousRange.end),
        block,
        content.slice(previousRange.end),
        eol
      );
    }
  }

  return appendBlockToEnd(content, block, eol);
}

/**
 * 解析当前目标文件对应的上一轮接管快照。
 *
 * @param targetFile 当前准备接管或恢复的 `config.toml` 路径。
 * @returns 命中同一目标文件时返回上一轮快照；否则返回 `null`。
 */
function resolveManagedStateForTarget(targetFile: string): ManagedCodexConfigState | null {
  const managedState = getManagedCodexConfigState();

  if (!managedState || managedState.target_file !== targetFile) {
    return null;
  }

  return managedState;
}

/**
 * 基于当前未受管的配置文本与上一轮快照，生成本轮接管所需的最小恢复快照。
 *
 * 业务规则：
 * 1. 优先记录当前文件里实际存在的原始 `model_provider` 与 `[model_providers.cslot]`。
 * 2. 若当前文件只剩残留受管块，允许继承上一轮快照中的原始片段。
 * 3. 仅保存 cslot 自己声明所有权的两块配置及其锚点，不保存整文件内容。
 *
 * @param targetFile 当前准备接管的 `config.toml` 路径。
 * @param strippedCurrent 已移除受管标记块后的配置文本。
 * @param previousManagedState 同一目标文件的上一轮快照；不存在时传 `null`。
 * @returns 本轮接管后用于 stop 恢复的快照。
 */
function buildManagedSnapshot(
  targetFile: string,
  strippedCurrent: string,
  previousManagedState: ManagedCodexConfigState | null
): ManagedCodexConfigState {
  const originalModelProviderLine = findModelProviderLine(strippedCurrent);
  const originalProviderSection = findProviderSectionRange(strippedCurrent);

  return {
    target_file: targetFile,
    original_model_provider_block:
      originalModelProviderLine?.value ??
      previousManagedState?.original_model_provider_block ??
      null,
    original_model_provider_next_table_header:
      (originalModelProviderLine
        ? findNextTableHeaderAfterOffset(strippedCurrent, originalModelProviderLine.end)
        : null) ??
      previousManagedState?.original_model_provider_next_table_header ??
      null,
    original_cslot_provider_block:
      originalProviderSection?.value ??
      previousManagedState?.original_cslot_provider_block ??
      null,
    original_cslot_provider_previous_table_header:
      (originalProviderSection
        ? findPreviousTableHeaderBeforeOffset(strippedCurrent, originalProviderSection.start)
        : null) ??
      previousManagedState?.original_cslot_provider_previous_table_header ??
      null,
    original_cslot_provider_next_table_header:
      (originalProviderSection
        ? findNextTableHeaderAfterOffset(strippedCurrent, originalProviderSection.end)
        : null) ??
      previousManagedState?.original_cslot_provider_next_table_header ??
      null
  };
}

/**
 * 将 cslot 需要的 provider 配置写入指定 `config.toml`，并保存恢复快照。
 *
 * @param targetPathOrDir 可选的 codex 配置目录或 `config.toml` 文件路径。
 * @param options 可选控制项；`silent=true` 时不输出终端提示。
 * @returns 实际写入的 `config.toml` 文件路径。
 * @throws 当目标文件无法读取、写入或恢复快照保存失败时抛出异常。
 */
export function applyManagedCodexConfig(
  targetPathOrDir?: string,
  options?: { silent?: boolean; config?: CslotConfig }
): string {
  const rawTarget = targetPathOrDir ? expandHome(targetPathOrDir) : getDefaultCodexConfigPath();
  const targetFile = rawTarget.endsWith(".toml") ? rawTarget : path.join(rawTarget, "config.toml");
  const current = fs.existsSync(targetFile) ? fs.readFileSync(targetFile, "utf8") : "";
  const previousManagedState = resolveManagedStateForTarget(targetFile);
  const strippedCurrent = stripAllManagedBlocks(current);
  const eol = detectEol(strippedCurrent);
  const snapshot = buildManagedSnapshot(targetFile, strippedCurrent, previousManagedState);
  const config = options?.config ?? loadConfig();
  const managedModelProviderBlock = buildManagedModelProviderBlock(eol);
  const managedProviderBlock = buildManagedProviderBlock(eol, config);
  const cleanedBaseContent = removeAllProviderSections(removeAllModelProviderLines(strippedCurrent));

  let nextContent = insertRootBlock(
    cleanedBaseContent,
    managedModelProviderBlock,
    eol,
    snapshot.original_model_provider_next_table_header
  );
  nextContent = appendBlockToEnd(nextContent, managedProviderBlock, eol);

  if (!nextContent.endsWith(eol)) {
    nextContent = `${nextContent}${eol}`;
  }

  writeFileAtomic(targetFile, nextContent);
  setManagedCodexConfigState(snapshot);

  if (!options?.silent) {
    console.log(bi(`已写入: ${targetFile}`, `Written to: ${targetFile}`));
    console.log(`base_url=http://${config.server.host}:${config.server.port}/v1`);
    console.log(`api_key=${config.server.api_key}`);
    console.log(bi("提示: start 会自动接管 codex provider，stop 会精确恢复接管前内容。", "Note: start will manage the Codex provider automatically, and stop will restore the exact previous content."));
  }

  return targetFile;
}

/**
 * 解除 cslot 对 `config.toml` 的接管，并恢复接管前的原始片段。
 *
 * @returns 实际恢复的 `config.toml` 文件路径；若当前没有接管快照则返回 `null`。
 * @throws 当目标文件读取或写入失败时抛出异常。
 */
export function deactivateManagedCodexConfig(): string | null {
  const managedState = getManagedCodexConfigState();
  if (!managedState) {
    return null;
  }

  const targetFile = managedState.target_file;
  if (!fs.existsSync(targetFile)) {
    clearManagedCodexConfigState();
    return null;
  }

  const current = fs.readFileSync(targetFile, "utf8");
  const eol = detectEol(current);
  let restored = stripAllManagedBlocks(current);
  const existingModelProviderLine = findModelProviderLine(restored);

  if (!existingModelProviderLine && managedState.original_model_provider_block) {
    restored = insertRootBlock(
      restored,
      managedState.original_model_provider_block,
      eol,
      managedState.original_model_provider_next_table_header
    );
  }

  const existingProviderSection = findProviderSectionRange(restored);
  if (!existingProviderSection && managedState.original_cslot_provider_block) {
    restored = insertTableBlock(
      restored,
      managedState.original_cslot_provider_block,
      eol,
      managedState.original_cslot_provider_next_table_header,
      managedState.original_cslot_provider_previous_table_header
    );
  }

  writeFileAtomic(targetFile, restored);
  clearManagedCodexConfigState();

  return targetFile;
}
