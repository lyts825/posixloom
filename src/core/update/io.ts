import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PosixLoomError } from "../errors.js";
import { isHistoryEntry, type UpdateState } from "./contracts.js";

/**
 * 把 feed 中的 archiveUrl 解析为可下载的绝对地址：
 * - 本身是 http(s)/file URL 或绝对路径：原样返回；
 * - 相对 http(s)/file 形式的 feedUrl：按 URL 语义拼接；
 * - 相对普通文件路径的 feedUrl：按文件系统路径拼接。
 * 下载内容最终仍受签名 feed 中的哈希与大小校验约束。
 */
export function resolveUpdateResource(base: string, target: string): string {
  if (/^https?:\/\//i.test(target) || /^file:/i.test(target) || isAbsolute(target)) return target;
  if (/^https?:\/\//i.test(base) || /^file:/i.test(base)) return new URL(target, base).toString();
  return resolve(dirname(base), target);
}

/**
 * 读取更新 feed 等小型资源并完整载入内存。
 * - http(s)：带超时与重定向跟随；先核对 content-length 上限，再在流式读取中逐块计数，
 *   防止声明头撒谎造成内存放大（UPDATE_RESOURCE_TOO_LARGE / UPDATE_HTTP_FAILED）；
 * - file URL 或本地路径：stat 与实际读取做双重大小检查。
 * @param maxBytes 字节上限（feed 固定 4MB）。
 */
export async function readResource(resource: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  if (!/^https?:\/\//i.test(resource)) {
    const path = resource.startsWith("file:") ? new URL(resource) : resource;
    const details = await stat(path);
    if (details.size > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes: details.size, maxBytes });
    const contents = await readFile(path);
    if (contents.length > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes: contents.length, maxBytes });
    return contents;
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(resource, { signal, redirect: "follow" });
  if (!response.ok) throw new PosixLoomError("UPDATE_HTTP_FAILED", `Update server returned HTTP ${response.status}`, { resource, status: response.status });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes: declared, maxBytes });
  if (!response.body) throw new PosixLoomError("UPDATE_HTTP_FAILED", "Update server returned an empty response body", { resource });
  const stream = Readable.fromWeb(response.body as any);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes, maxBytes });
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, bytes);
}

/**
 * 流式下载（http(s)）或复制（本地路径）归档到 target，边写盘边计算 SHA-256。
 * Transform 计量器在累计超过 maxBytes 时立即中断（UPDATE_ARCHIVE_TOO_LARGE），
 * 写入端使用 "wx" 独占创建，绝不覆盖既有文件。
 * @returns 归档的 SHA-256（hex）与实际字节数，供与签名 feed 比对。
 */
export async function downloadAndHash(resource: string, target: string, timeoutMs: number, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  await mkdir(dirname(target), { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new PosixLoomError("UPDATE_ARCHIVE_TOO_LARGE", "Runtime archive exceeds the configured size limit", { maxBytes }));
      else { hash.update(chunk); callback(null, chunk); }
    },
  });
  if (/^https?:\/\//i.test(resource)) {
    const response = await fetch(resource, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok || !response.body) throw new PosixLoomError("UPDATE_HTTP_FAILED", `Update server returned HTTP ${response.status}`, { resource, status: response.status });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new PosixLoomError("UPDATE_ARCHIVE_TOO_LARGE", "Runtime archive exceeds the configured size limit", { declared, maxBytes });
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(target, { flags: "wx" }));
  } else {
    const source = resource.startsWith("file:") ? new URL(resource) : resource;
    await pipeline(createReadStream(source), meter, createWriteStream(target, { flags: "wx" }));
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** 流式计算整个文件的 SHA-256（hex），用于 manifest 哈希比对。 */
export async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest("hex");
}

/**
 * 原子写文件：先写随机后缀的临时文件，再 rename 覆盖目标。
 * 读者要么看到旧内容、要么看到完整新内容，不会读到写了一半的 JSON；
 * 无论成败都清理临时文件（仅当无业务错误时才把清理失败抛出）。
 */
export async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${randomUUID()}`;
  let operationError: unknown;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { await rm(temporary, { force: true }); } catch (cleanupError) { if (!operationError) throw cleanupError; }
  }
}

/**
 * 读取并校验持久化状态 state.json；文件不存在时返回空历史状态。
 * 对 lastCheckedAt / active / history 逐字段验证，发现篡改或损坏立即抛
 * UPDATE_STATE_INVALID，而不是带着不可信的状态继续做更新决策。
 */
export async function readState(path: string): Promise<UpdateState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateState>;
    if (parsed.lastCheckedAt !== undefined && (typeof parsed.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(parsed.lastCheckedAt)))) throw new Error("lastCheckedAt is invalid");
    if (parsed.active !== undefined && !isHistoryEntry(parsed.active)) throw new Error("active entry is invalid");
    if (parsed.history !== undefined && (!Array.isArray(parsed.history) || parsed.history.some((entry) => !isHistoryEntry(entry)))) throw new Error("history entry is invalid");
    return {
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : undefined,
      active: parsed.active,
      history: parsed.history ?? [],
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { history: [] };
    throw new PosixLoomError("UPDATE_STATE_INVALID", `Unable to read update state: ${path}`, { path, cause: String(error) });
  }
}
