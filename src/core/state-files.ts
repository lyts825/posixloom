/** Bounded JSON storage shared by task manifests and session checkpoints. */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { PosixLoomError } from "./errors.js";

const lanes = new Map<string, Promise<unknown>>();

export async function inFileLane<T>(key: string, operation: () => Promise<T>): Promise<T> {
  key = resolve(key);
  if (process.platform === "win32") key = key.toLowerCase();
  const previous = lanes.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  lanes.set(key, current);
  try { return await current; }
  finally { if (lanes.get(key) === current) lanes.delete(key); }
}

export async function plainDirectory(path: string, create = false): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new PosixLoomError("STATE_STORAGE_UNSAFE", "State storage must be a plain directory");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return false;
    throw error;
  }
}

export async function readBoundedJson(path: string, maximum: number): Promise<unknown | undefined> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new PosixLoomError("STATE_STORAGE_UNSAFE", "State storage must be a regular file without links");
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      const current = await lstat(path);
      if (!opened.isFile() || opened.nlink !== 1 || current.isSymbolicLink() || opened.dev !== info.dev || opened.ino !== info.ino || opened.dev !== current.dev || opened.ino !== current.ino) throw new PosixLoomError("STATE_STORAGE_UNSAFE", "State file changed while opening");
      if (!opened.isFile() || opened.size > maximum) throw new PosixLoomError("STATE_FILE_TOO_LARGE", "State file exceeds its size limit");
      const buffer = Buffer.alloc(maximum + 1);
      let used = 0;
      while (used < buffer.length) {
        const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
        if (!bytesRead) break;
        used += bytesRead;
      }
      if (used > maximum) throw new PosixLoomError("STATE_FILE_TOO_LARGE", "State file exceeds its size limit");
      try { return JSON.parse(buffer.subarray(0, used).toString("utf8")); }
      catch { throw new PosixLoomError("STATE_FILE_INVALID", "State file contains invalid JSON"); }
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeAtomicJson(path: string, value: unknown, maximum: number): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > maximum) throw new PosixLoomError("STATE_FILE_TOO_LARGE", "State file exceeds its size limit");
  await plainDirectory(dirname(path), true);
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
