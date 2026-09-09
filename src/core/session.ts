/**
 * 会话状态存储（SessionStateStore）。
 *
 * 职责：
 * - 维护 sessionId -> { state, lane } 的内存映射；
 * - 提供状态快照（snapshot，深拷贝）与乐观锁提交（commit，CAS 语义）；
 * - 提供每会话串行队列（inStateLane），串行化同一会话内的命令执行。
 *
 * 设计意图：
 * - 最小会话状态：SessionState 只保存 cwd 与 exportedEnv。
 *   cd/export/unset 等内建命令的全部可持久副作用就只有这两项；状态面越小，
 *   校验、合并与恢复就越可靠，也不会把进程级的临时噪音（未导出变量、函数定义
 *   等）沉淀成长期状态。
 * - 乐观锁提交：StatePatch 携带 baseStateVersion，与当前版本不一致即拒绝提交，
 *   防止晚到的旧 StateReport 覆盖新状态（具体校验见 env.ts 的 validateStatePatch）。
 * - 串行队列：cwd-env 策略下同一会话的命令必须逐个排队执行，从根上消除并发
 *   命令之间的状态版本竞争；isolated 会话没有共享状态，无需排队。
 */
import { randomUUID } from "node:crypto";
import { PosixLoomError } from "./errors.js";
import { applyEnvDelta, initialSessionEnv, normalizeEnv, validateStatePatch } from "./env.js";
import type { SessionState, StatePatch, StatePolicy } from "./types.js";

/**
 * 会话内部记录。
 * state：该会话当前状态（version / cwd / exportedEnv）。
 * lane：该会话串行队列的"尾部" Promise；每次 inStateLane 都把新任务链接到
 * 这个尾部之后，从而实现同会话操作按到达顺序先进先出地串行执行。
 */
interface SessionRecord {
  state: SessionState;
  lane: Promise<unknown>;
  lastAccessedAt: number;
  activeOperations: number;
}

export interface SessionStateStoreOptions {
  /** Maximum number of live sessions retained by this process. */
  maxSessions?: number;
  /** Inactive sessions older than this many milliseconds are reclaimed lazily. */
  idleTimeoutMs?: number;
  /** Injectable monotonic-enough clock used by deterministic tests. */
  now?: () => number;
}

export interface SessionStateEntry {
  sessionId: string;
  state: SessionState;
}

/**
 * 会话状态存储：sessionId -> SessionRecord 的内存映射。
 * 对外只提供快照（拷贝）与 CAS 提交两类读写入口，内部状态不会被调用方
 * 直接引用或意外修改。本类不做跨进程持久化；会话生命周期与服务进程一致。
 */
export class SessionStateStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly now: () => number;

  constructor(options: SessionStateStoreOptions = {}) {
    this.maxSessions = options.maxSessions ?? 1024;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
    if (!Number.isSafeInteger(this.maxSessions) || this.maxSessions <= 0) {
      throw new PosixLoomError("SESSION_OPTIONS_INVALID", "maxSessions must be a positive integer", { maxSessions: this.maxSessions });
    }
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) {
      throw new PosixLoomError("SESSION_OPTIONS_INVALID", "idleTimeoutMs must be a positive integer", { idleTimeoutMs: this.idleTimeoutMs });
    }
  }

  private cloneState(state: SessionState): SessionState {
    return { version: state.version, cwd: state.cwd, exportedEnv: { ...state.exportedEnv } };
  }

  private pruneExpired(now = this.now()): void {
    for (const [sessionId, record] of this.sessions) {
      if (record.activeOperations === 0 && now - record.lastAccessedAt >= this.idleTimeoutMs) this.sessions.delete(sessionId);
    }
  }

  private requireRecord(sessionId: string): SessionRecord {
    const now = this.now();
    this.pruneExpired(now);
    const record = this.sessions.get(sessionId);
    if (!record) throw new PosixLoomError("SESSION_NOT_FOUND", `Unknown session: ${sessionId}`);
    record.lastAccessedAt = now;
    return record;
  }

  /**
   * 创建新会话并返回其 sessionId（UUID，与宿主路径、进程标识完全解耦）。
   * @param cwd 初始工作目录（虚拟路径），默认 "/workspace"
   * @param exportedEnv 初始导出环境变量；默认为 initialSessionEnv() 给出的
   *   宿主环境可移植子集（过滤 PATH 等后端控制键）
   * @returns 新会话的 sessionId
   */
  create(cwd = "/workspace", exportedEnv?: Record<string, string>): string {
    // Explicit restored/forked state obeys the same environment ownership rules
    // as a state commit and starts at version zero.
    if (exportedEnv !== undefined) {
      for (const value of Object.values(exportedEnv)) {
        if (typeof value !== "string" || value.includes("\0")) throw new PosixLoomError("STATE_PATCH_REJECTED", "Session environment requires NUL-free string values");
      }
      exportedEnv = normalizeEnv(exportedEnv);
      validateStatePatch({ baseStateVersion: 0n, setEnv: exportedEnv, removeEnv: [] }, { version: 0n, cwd, exportedEnv: {} }, "cwd-env");
    } else exportedEnv = initialSessionEnv();
    const now = this.now();
    this.pruneExpired(now);
    if (this.sessions.size >= this.maxSessions) {
      let oldest: { sessionId: string; lastAccessedAt: number } | undefined;
      for (const [sessionId, record] of this.sessions) {
        if (record.activeOperations !== 0) continue;
        if (!oldest || record.lastAccessedAt < oldest.lastAccessedAt) oldest = { sessionId, lastAccessedAt: record.lastAccessedAt };
      }
      if (!oldest) {
        throw new PosixLoomError("SESSION_LIMIT_REACHED", "All session slots are currently active", { maximum: this.maxSessions });
      }
      this.sessions.delete(oldest.sessionId);
    }
    const id = randomUUID();
    // exportedEnv 做一层浅拷贝与调用方对象解耦；版本号从 0n 起步；
    // lane 初始化为已完成的 Promise，使第一个 inStateLane 任务入队时无需等待
    this.sessions.set(id, {
      state: { version: 0n, cwd, exportedEnv: { ...exportedEnv } },
      lane: Promise.resolve(),
      lastAccessedAt: now,
      activeOperations: 0,
    });
    return id;
  }

  /** Return snapshots of all live sessions without extending their idle lifetime. */
  list(): SessionStateEntry[] {
    this.pruneExpired();
    return [...this.sessions].map(([sessionId, record]) => ({ sessionId, state: this.cloneState(record.state) }));
  }

  /**
   * 关闭并移除一个会话记录。
   * @param sessionId 目标会话
   * @throws PosixLoomError("SESSION_NOT_FOUND") 会话不存在时抛出
   */
  close(sessionId: string): void {
    this.pruneExpired();
    if ((this.sessions.get(sessionId)?.activeOperations ?? 0) > 0) {
      throw new PosixLoomError("SESSION_BUSY", "Cannot close a session with running or queued operations", { sessionId });
    }
    if (!this.sessions.delete(sessionId)) throw new PosixLoomError("SESSION_NOT_FOUND", `Unknown session: ${sessionId}`);
  }

  /** Protect both isolated work and queued requests from eviction or explicit close. */
  async withLease<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const record = this.requireRecord(sessionId);
    record.activeOperations += 1;
    try { return await operation(); }
    finally { record.activeOperations -= 1; record.lastAccessedAt = this.now(); }
  }

  /**
   * 返回会话当前状态的拷贝快照。
   * exportedEnv 做一层浅拷贝，保证调用方修改快照不会污染存储内部状态；
   * 快照中的 version（bigint 原始类型）可直接作为下一次 StatePatch 的
   * baseStateVersion，参与乐观锁比对。
   * @param sessionId 目标会话
   * @returns 状态快照（与内部状态无共享引用）
   * @throws PosixLoomError("SESSION_NOT_FOUND") 会话不存在时抛出
   */
  snapshot(sessionId: string): SessionState {
    const record = this.requireRecord(sessionId);
    return this.cloneState(record.state);
  }

  /**
   * 校验并提交状态补丁（CAS 提交）。流程：
   *  1. validateStatePatch 先做乐观锁校验（patch.baseStateVersion 必须等于
   *     当前 version，否则抛 STATE_CONFLICT）与环境键分级校验
   *     （runtime-immutable / backend-controlled / runtime-derived 键不可提交、
   *     PATH 不可删除且新值必须是合法虚拟路径）；校验失败时状态保持不变；
   *  2. isolated 策略：会话状态不可变，校验通过后有意丢弃补丁，直接返回
   *     当前快照，使上游拿到的返回结构与其他策略保持一致；
   *  3. cwd-env 策略：版本号 +1，cwd 缺省沿用旧值，setEnv 与 removeEnv
   *     合并为单个 env 增量后一次性应用。
   * @param sessionId 目标会话
   * @param patch 状态补丁（含乐观锁基线 baseStateVersion）
   * @param policy 会话状态策略（isolated / cwd-env）
   * @returns 提交后的状态快照（isolated 下为未变更的快照）
   * @throws PosixLoomError("SESSION_NOT_FOUND" / "STATE_CONFLICT" / "STATE_PATCH_REJECTED")
   */
  commit(sessionId: string, patch: StatePatch, policy: StatePolicy): SessionState {
    const record = this.requireRecord(sessionId);
    validateStatePatch(patch, record.state, policy);
    // isolated：不做任何状态变更，补丁被有意丢弃，仅回当前快照
    if (policy === "isolated") return this.snapshot(sessionId);
    // removeEnv 折叠成 { key: null } 与 setEnv 合并，交由 applyEnvDelta 统一处理增删
    const next: SessionState = {
      version: record.state.version + 1n,
      cwd: patch.cwd ?? record.state.cwd,
      exportedEnv: applyEnvDelta(record.state.exportedEnv, {
        ...patch.setEnv,
        ...Object.fromEntries(patch.removeEnv.map((key) => [key, null])),
      }),
    };
    record.state = next;
    return this.snapshot(sessionId);
  }

  /**
   * 在会话的串行队列（Promise 链）中执行 operation：同一会话的多个调用按
   * 到达顺序逐个运行，不同会话之间互不阻塞。
   *
   * 为什么需要串行队列：cwd-env 策略下，同一会话的并发命令会各自基于某个
   * 基线版本产出 StateReport；若不排队，后启动的命令会基于过期版本号提交，
   * 大量触发 STATE_CONFLICT。串行化让"读取基线 -> 执行 -> 提交补丁"在会话内
   * 成为原子区，消除状态竞争。isolated 会话无共享状态，调用方直接执行即可，
   * 无需经过本方法。
   *
   * 实现要点：先把 record.lane 替换为一个新的占位 Promise（由本次调用的
   * release 兑现），再 await 上一个尾部、执行 operation；finally 中无条件
   * release，保证 operation 抛错时队列也不会被永久卡死。
   * @param sessionId 目标会话
   * @param operation 需要串行执行的异步操作
   * @returns operation 的返回值（operation 的异常也原样向上抛出）
   * @throws PosixLoomError("SESSION_NOT_FOUND") 会话不存在时抛出
   */
  async inStateLane<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const record = this.requireRecord(sessionId);
    record.activeOperations += 1;
    // 记下当前队列尾部：本次 operation 必须排在它之后
    const previous = record.lane;
    let release!: () => void;
    // 用新 Promise 顶替队列尾部，后续调用将排在本次之后
    record.lane = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      // 无论成功失败都放行下一个等待者，避免队列死锁
      record.activeOperations -= 1;
      record.lastAccessedAt = this.now();
      release();
    }
  }
}
