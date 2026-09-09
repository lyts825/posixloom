import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { PosixLoomError } from "../errors.js";

/**
 * 判断是否为「安全的相对路径」：非空、不含 NUL 与盘符冒号、非绝对路径、不以分隔符开头，
 * 且按 / 与 \ 切分后不含空段、"." 与 ".."。用于 archiveRoot 等取值校验，
 * 与解压脚本内的同类检查共同阻断路径穿越（Zip Slip）。
 */
export function safeRelativePath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\0")
    && !value.includes(":")
    && !isAbsolute(value)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** 判断 candidate 是否位于 root 之内（含恰好等于 root）；Windows 下按大小写不敏感比较。 */
export function pathIsInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const insensitive = process.platform === "win32";
  const left = insensitive ? rootPath.toLowerCase() : rootPath;
  const right = insensitive ? candidatePath.toLowerCase() : candidatePath;
  return right === left || right.startsWith(`${left}${sep}`);
}

/**
 * 递归扫描目录，遇到符号链接即抛 UPDATE_ARCHIVE_LINK。
 * 符号链接可以指向归档之外（甚至网络位置），使后续整树哈希校验失效，故更新内容一律禁止。
 */
export async function assertNoLinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new PosixLoomError("UPDATE_ARCHIVE_LINK", "Runtime update archives cannot contain symbolic links", { path });
    if (entry.isDirectory()) await assertNoLinks(path);
  }
}
