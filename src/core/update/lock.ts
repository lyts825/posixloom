import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { PosixLoomError } from "../errors.js";
import type { UpdateLock } from "./contracts.js";

/**
 * 获取更新互斥锁：以 open "wx" 独占创建锁文件，创建本身即原子的抢锁动作。
 * - 锁已存在且 mtime 距今不足 30 分钟：视为有并发更新在运行，UPDATE_ALREADY_RUNNING；
 * - 超过 30 分钟视为陈旧锁（持锁进程大概率已死）：先 rename 移走旧锁再重建，
 *   rename 撞车（ENOENT）或重建时锁又被抢走，都说明存在并发恢复者，
 *   同样报 UPDATE_ALREADY_RUNNING，最后清理 rename 出的旧文件。
 */
export async function acquireUpdateLock(path: string): Promise<UpdateLock> {
  await mkdir(dirname(path), { recursive: true });
  try {
    return await createUpdateLock(path);
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const age = Date.now() - (await stat(path)).mtimeMs;
    if (age < 30 * 60 * 1000) throw new PosixLoomError("UPDATE_ALREADY_RUNNING", "Another Runtime update is already running", { path });
    const stalePath = `${path}.stale-${randomUUID()}`;
    try {
      await rename(path, stalePath);
    } catch (renameError: any) {
      if (renameError?.code === "ENOENT") throw new PosixLoomError("UPDATE_ALREADY_RUNNING", "Runtime update lock changed while stale-lock recovery was in progress", { path });
      throw renameError;
    }
    try {
      return await createUpdateLock(path);
    } catch (retryError: any) {
      if (retryError?.code === "EEXIST") throw new PosixLoomError("UPDATE_ALREADY_RUNNING", "Another Runtime update acquired the recovered lock", { path });
      throw retryError;
    } finally {
      await rm(stalePath, { force: true });
    }
  }
}

/**
 * 创建锁文件并返回句柄；锁内容为 pid / 创建时间 / 随机 token 三行。
 *
 * 心跳：每 60 秒 utimes 刷新 mtime（unref 避免挂住进程退出），供 acquireLock
 * 区分「活跃锁」与「陈旧锁」。
 * 释放：仅当锁内第三行 token 未变才删除锁文件--若锁已被陈旧恢复流程接管
 * （内容已变）则不动它，避免误删他人的锁；锁文件已不存在则静默返回。
 */
async function createUpdateLock(path: string): Promise<UpdateLock> {
  const handle = await open(path, "wx");
  const token = randomUUID();
  try {
    await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${token}\n`);
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  // 心跳：定期刷新 mtime 表明持锁进程仍存活；unref 使定时器不阻止进程退出。
  const heartbeat = setInterval(() => { void handle.utimes(new Date(), new Date()).catch(() => undefined); }, 60_000);
  heartbeat.unref();
  return {
    release: async () => {
      clearInterval(heartbeat);
      await handle.close();
      let current: string;
      try { current = await readFile(path, "utf8"); } catch (error: any) {
        if (error?.code === "ENOENT") return;
        throw error;
      }
      if (current.split(/\r?\n/)[2] === token) await rm(path, { force: true });
    },
  };
}
