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
 * 恢复文本中由 cslot 管理的配置块，得到接管前的原始内容基线。
 *
 * @param content 当前 `config.toml` 内容。
 * @param managedState 上一次接管时保存的原始片段快照。
 * @returns 恢复后的文本内容。
 */
function restoreManagedContent(content: string, managedState: ManagedCodexConfigState): string {
  let restored = content;
  const providerRange = findMarkedBlockRange(
    restored,
    PROVIDER_BLOCK_START_MARKER,
    PROVIDER_BLOCK_END_MARKER
  );

  if (providerRange) {
    restored =
      restored.slice(0, providerRange.start) +
      (managedState.original_cslot_provider_block ?? "") +
      restored.slice(providerRange.end);
  }

  const modelProviderRange = findMarkedBlockRange(
    restored,
    MODEL_PROVIDER_START_MARKER,
    MODEL_PROVIDER_END_MARKER
  );

  if (modelProviderRange) {
    restored =
      restored.slice(0, modelProviderRange.start) +
      (managedState.original_model_provider_block ?? "") +
      restored.slice(modelProviderRange.end);
  }

  return restored;
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
 * 查找 `[model_providers.cslot]` 表块的文本范围。
 *
 * @param content 当前 `config.toml` 内容。
 * @returns 命中时返回完整表块范围；未命中返回 `null`。
 */
function findProviderSectionRange(content: string): { start: number; end: number; value: string } | null {
  const lines = content.split(/\r?\n/);
  let offset = 0;
  let startLineIndex = -1;
  let startOffset = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineEnd = offset + line.length;

    if (line.trim() === "[model_providers.cslot]") {
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
  const previousManagedState = getManagedCodexConfigState();
  const baseContent =
    previousManagedState && previousManagedState.target_file === targetFile
      ? restoreManagedContent(current, previousManagedState)
      : current;
  const eol = detectEol(baseContent);

  const originalModelProviderLine = findModelProviderLine(baseContent);
  const originalProviderSection = findProviderSectionRange(baseContent);
  const snapshot: ManagedCodexConfigState = {
    target_file: targetFile,
    original_model_provider_block: originalModelProviderLine?.value ?? null,
    original_cslot_provider_block: originalProviderSection?.value ?? null
  };
  const config = options?.config ?? loadConfig();

  let nextContent = baseContent;
  const managedModelProviderBlock = buildManagedModelProviderBlock(eol);
  const managedProviderBlock = buildManagedProviderBlock(eol, config);

  // 先处理 provider 表块，再处理 model_provider 行，避免前面的插入导致后续偏移失效。
  if (originalProviderSection) {
    nextContent =
      nextContent.slice(0, originalProviderSection.start) +
      managedProviderBlock +
      nextContent.slice(originalProviderSection.end);
  } else if (nextContent.length > 0) {
    nextContent = insertBlockBetween(nextContent, managedProviderBlock, "", eol);
  } else {
    nextContent = `${managedProviderBlock}${eol}`;
  }

  const modelProviderLine = findModelProviderLine(nextContent);
  if (modelProviderLine) {
    nextContent =
      nextContent.slice(0, modelProviderLine.start) +
      managedModelProviderBlock +
      nextContent.slice(modelProviderLine.end);
  } else {
    const firstNonWhitespaceMatch = nextContent.match(/\S/);
    if (firstNonWhitespaceMatch && firstNonWhitespaceMatch.index !== undefined) {
      nextContent = insertBlockBetween(
        nextContent.slice(0, firstNonWhitespaceMatch.index),
        managedModelProviderBlock,
        nextContent.slice(firstNonWhitespaceMatch.index),
        eol
      );
    } else {
      nextContent = `${managedModelProviderBlock}${eol}`;
    }
  }

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
  const restored = restoreManagedContent(current, managedState);

  writeFileAtomic(targetFile, restored);
  clearManagedCodexConfigState();

  return targetFile;
}
