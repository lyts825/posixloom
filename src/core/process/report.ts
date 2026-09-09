import { closeSync, fstatSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import { PosixLoomError } from "../errors.js";
import { DEFAULT_MAX_REPORT_BYTES } from "./output.js";

/**
 * 读取并删除报告文件。报告是一次性产物（state-report 落盘后即被消费），
 * 无论读取成功与否都尽力清理，避免临时目录残留；文件不存在时返回
 * fallback（例如 reportFd 管道已收集到的内容）。IO 失败作为数据返回，
 * 由执行收口映射为 REPORT_IO_FAILED，不能让结果 Promise 悬空。
 */
export function reportTooLarge(bytes: number, maximum: number): PosixLoomError {
  return new PosixLoomError("REPORT_TOO_LARGE", "StateReport exceeds the configured byte limit", { bytes, maximum });
}

export function readAndRemoveReport(
  path: string | undefined,
  fallback = Buffer.alloc(0),
  maximum = DEFAULT_MAX_REPORT_BYTES,
  fallbackError?: unknown,
): { data: Buffer; error?: unknown } {
  let data = fallback;
  let failure = fallbackError;
  if (fallback.length > maximum) {
    data = Buffer.alloc(0);
    failure ??= reportTooLarge(fallback.length, maximum);
  }
  if (!path) return { data, error: failure };
  let descriptor: number | undefined;
  let missing = false;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile()) throw new PosixLoomError("REPORT_FILE_INVALID", "StateReport path must be a regular file", { path });
    if (metadata.size > maximum) throw reportTooLarge(metadata.size, maximum);
    descriptor = openSync(path, "r");
    const openedMetadata = fstatSync(descriptor);
    if (!openedMetadata.isFile()) throw new PosixLoomError("REPORT_FILE_INVALID", "StateReport path must open as a regular file", { path });
    if (openedMetadata.size > maximum) throw reportTooLarge(openedMetadata.size, maximum);
    const chunks: Buffer[] = [];
    const scratch = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1));
    let bytes = 0;
    while (true) {
      const read = readSync(descriptor, scratch, 0, scratch.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > maximum) throw reportTooLarge(bytes, maximum);
      chunks.push(Buffer.from(scratch.subarray(0, read)));
    }
    data = Buffer.concat(chunks, bytes);
    failure = undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") missing = true;
    else failure = error;
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  if (missing) return { data, error: failure };
  try {
    // 读没读到都要删，防止下次执行读到上一次的旧报告。
    rmSync(path, { force: true });
  } catch (error) {
    failure ??= error;
  }
  return { data, error: failure };
}
