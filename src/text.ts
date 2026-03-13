/**
 * 生成统一的中英双语文案，避免在各处手写不一致的分隔形式。
 *
 * @param zh 简体中文文案。
 * @param en 英文文案。
 * @returns 统一格式的中英双语字符串。
 */
export function bi(zh: string, en: string): string {
  return `${zh} / ${en}`;
}

/**
 * 将时间格式化为与 locale 无关的本地时间文本，避免输出固定绑定某个语言区域。
 *
 * @param unixSeconds Unix 秒时间戳；为空时返回 `-`。
 * @returns 形如 `2026-03-13 16:46:23` 的本地时间字符串。
 */
export function formatLocalDateTime(unixSeconds: number | null): string {
  if (!unixSeconds) {
    return "-";
  }

  const date = new Date(unixSeconds * 1000);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  const second = `${date.getSeconds()}`.padStart(2, "0");

  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
