import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * 将目录权限收紧为仅当前用户可访问。
 *
 * @param directory 需要创建或迁移权限的目录绝对路径。
 * @returns 无返回值。
 * @throws 当目录创建或 POSIX 权限修改失败时抛出文件系统错误。
 */
export function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });

  if (process.platform !== "win32") {
    fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  }
}

/**
 * 将已存在文件的权限收紧为仅当前用户可读写。
 *
 * @param targetFile 需要迁移权限的文件绝对路径；文件不存在时不做处理。
 * @returns 无返回值。
 * @throws 当 POSIX 权限修改失败时抛出文件系统错误。
 */
export function ensurePrivateFile(targetFile: string): void {
  if (!fs.existsSync(targetFile) || process.platform === "win32") {
    return;
  }

  fs.chmodSync(targetFile, PRIVATE_FILE_MODE);
}

/**
 * 使用同目录临时文件原子替换目标文件，并固定为仅当前用户可读写。
 *
 * @param targetFile 目标文件绝对路径。
 * @param content 需要完整写入的字符串或二进制内容。
 * @returns 无返回值。
 * @throws 当目录创建、临时文件写入、同步或重命名失败时抛出文件系统错误。
 */
export function writePrivateFileAtomic(
  targetFile: string,
  content: string | NodeJS.ArrayBufferView
): void {
  ensurePrivateDirectory(path.dirname(targetFile));
  const tempFile = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  let fileDescriptor: number | null = null;

  try {
    fileDescriptor = fs.openSync(
      tempFile,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      PRIVATE_FILE_MODE
    );
    fs.writeFileSync(fileDescriptor, content);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(tempFile, targetFile);
    ensurePrivateFile(targetFile);
  } catch (error) {
    if (fileDescriptor !== null) {
      fs.closeSync(fileDescriptor);
    }
    fs.rmSync(tempFile, { force: true });
    throw error;
  }
}

/**
 * 将来源文件以原子方式复制到目标位置，并收紧目标权限。
 *
 * @param sourceFile 来源文件绝对路径。
 * @param targetFile 目标文件绝对路径。
 * @returns 无返回值。
 * @throws 当来源读取或目标原子写入失败时抛出文件系统错误。
 */
export function copyPrivateFileAtomic(sourceFile: string, targetFile: string): void {
  writePrivateFileAtomic(targetFile, fs.readFileSync(sourceFile));
}
