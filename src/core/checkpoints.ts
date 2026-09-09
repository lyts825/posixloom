import { createHash, randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { canonicalEnvKey, envMutationClass, initialSessionEnv, normalizeEnv, validateStatePatch } from "./env.js";
import { PosixLoomError } from "./errors.js";
import { isRecord } from "./execution-request.js";
import { normalizeVirtual } from "./path.js";
import { inFileLane, plainDirectory, readBoundedJson, writeAtomicJson } from "./state-files.js";
import type { PosixLoomService } from "./service.js";

export const CHECKPOINT_LIMITS = Object.freeze({ maxCheckpoints: 128, maxFileBytes: 128 * 1024, maxEnvKeys: 256, maxValueBytes: 32768 });
/** Public metadata deliberately excludes the selected environment values. */
export interface SessionCheckpoint {
  schemaVersion: 1;
  checkpointId: string;
  name: string;
  createdAt: string;
  cwd: string;
  envKeys: string[];
  runtimeId: string;
  snapshotId: string;
}
export type Checkpoint = SessionCheckpoint;
interface StoredCheckpoint extends SessionCheckpoint { workspaceId: string; exportedEnv: Record<string, string> }
export interface SaveCheckpointOptions { name?: string; envKeys?: string[] }

const checkpointIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function invalid(message: string): never { throw new PosixLoomError("CHECKPOINT_INVALID", message); }
function safeText(value: unknown, max: number): value is string { return typeof value === "string" && !value.includes("\0") && Buffer.byteLength(value) <= max; }
function environment(value: unknown): Record<string, string> {
  if (!isRecord(value) || Object.keys(value).length > CHECKPOINT_LIMITS.maxEnvKeys) return invalid("Checkpoint environment has too many keys or is not an object");
  for (const [key, item] of Object.entries(value)) {
    canonicalEnvKey(key);
    if (!safeText(item, CHECKPOINT_LIMITS.maxValueBytes)) return invalid("Checkpoint environment values must be bounded NUL-free strings");
  }
  const normalized = normalizeEnv(value as Record<string, string>);
  validateStatePatch({ baseStateVersion: 0n, setEnv: normalized, removeEnv: [] }, { version: 0n, cwd: "/workspace", exportedEnv: {} }, "cwd-env");
  if (Buffer.byteLength(JSON.stringify(normalized)) > CHECKPOINT_LIMITS.maxFileBytes / 2) return invalid("Checkpoint environment exceeds 64 KiB");
  return normalized;
}
function mutableEnvironment(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && (envMutationClass(key) === "user-mutable" || key.toUpperCase() === "PATH")));
}
function metadata(value: StoredCheckpoint): SessionCheckpoint {
  return { schemaVersion: 1, checkpointId: value.checkpointId, name: value.name, createdAt: value.createdAt, cwd: value.cwd, envKeys: [...value.envKeys], runtimeId: value.runtimeId, snapshotId: value.snapshotId };
}

/** Checkpoints restore cwd and selected environment, never files or running processes. */
export class SessionCheckpointStore {
  readonly directory: string;
  private readonly root: string;
  private readonly workspaceId: string;
  constructor(private readonly service: PosixLoomService) {
    const workspace = resolve(service.runtime.config.runtime.runtime.workspace);
    this.workspaceId = createHash("sha256").update(process.platform === "win32" ? workspace.toLowerCase() : workspace).digest("hex");
    this.root = join(service.runtime.config.dataRoot, "checkpoints");
    this.directory = join(this.root, this.workspaceId);
  }
  private async prepare(create = false): Promise<boolean> {
    if (!await plainDirectory(this.root, create)) return false;
    return plainDirectory(this.directory, create);
  }
  private filename(checkpointId: string): string {
    if (!checkpointIdPattern.test(checkpointId)) return invalid("Invalid checkpoint id");
    return join(this.directory, `${checkpointId}.json`);
  }
  private validate(value: unknown, checkpointId: string): StoredCheckpoint {
    if (!isRecord(value) || value.schemaVersion !== 1 || value.checkpointId !== checkpointId || value.workspaceId !== this.workspaceId) return invalid("Checkpoint identity or schema is invalid");
    if (Object.keys(value).some((key) => !["schemaVersion", "checkpointId", "name", "createdAt", "cwd", "envKeys", "runtimeId", "snapshotId", "workspaceId", "exportedEnv"].includes(key))) return invalid("Unknown checkpoint field");
    if (!safeText(value.name, 256) || !safeText(value.createdAt, 64) || !Number.isFinite(Date.parse(value.createdAt)) || !safeText(value.runtimeId, 256) || !safeText(value.snapshotId, 256)) return invalid("Checkpoint metadata is invalid");
    if (!safeText(value.cwd, 32768) || !value.cwd.startsWith("/") || normalizeVirtual(value.cwd) !== value.cwd) return invalid("Checkpoint cwd must be a normalized absolute virtual path");
    const exportedEnv = environment(value.exportedEnv);
    if (!Array.isArray(value.envKeys) || value.envKeys.some((key) => typeof key !== "string") || JSON.stringify(value.envKeys) !== JSON.stringify(Object.keys(exportedEnv).sort())) return invalid("Checkpoint environment metadata does not match stored values");
    return { schemaVersion: 1, checkpointId, workspaceId: this.workspaceId, name: value.name, createdAt: value.createdAt, cwd: value.cwd, runtimeId: value.runtimeId, snapshotId: value.snapshotId, envKeys: Object.keys(exportedEnv).sort(), exportedEnv };
  }
  private async read(checkpointId: string): Promise<StoredCheckpoint> {
    const path = this.filename(checkpointId);
    if (!await this.prepare()) throw new PosixLoomError("CHECKPOINT_NOT_FOUND", "Unknown session checkpoint");
    const value = await readBoundedJson(path, CHECKPOINT_LIMITS.maxFileBytes);
    if (value === undefined) throw new PosixLoomError("CHECKPOINT_NOT_FOUND", "Unknown session checkpoint");
    return this.validate(value, checkpointId);
  }
  async list(): Promise<SessionCheckpoint[]> {
    if (!await this.prepare()) return [];
    const files = (await readdir(this.directory)).filter((name) => name.endsWith(".json") && checkpointIdPattern.test(name.slice(0, -5)));
    if (files.length > CHECKPOINT_LIMITS.maxCheckpoints) throw new PosixLoomError("CHECKPOINT_LIMIT_REACHED", "Checkpoint storage exceeds its entry limit");
    const entries: SessionCheckpoint[] = [];
    for (const name of files) entries.push(metadata(await this.read(name.slice(0, -5))));
    return entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
  async save(sessionId: string, options: SaveCheckpointOptions = {}): Promise<SessionCheckpoint> {
    if (!isRecord(options) || Object.keys(options).some((key) => key !== "name" && key !== "envKeys")) return invalid("Invalid checkpoint save options");
    if (options.name !== undefined && !safeText(options.name, 256)) return invalid("Checkpoint name must be a NUL-free string of at most 256 bytes");
    if (options.envKeys !== undefined && (!Array.isArray(options.envKeys) || options.envKeys.length > CHECKPOINT_LIMITS.maxEnvKeys || options.envKeys.some((key) => typeof key !== "string"))) return invalid("envKeys must be a bounded list of environment names");
    const envKeys = (options.envKeys ?? []).map((key) => canonicalEnvKey(key));
    if (new Set(envKeys).size !== envKeys.length) return invalid("Checkpoint environment keys must be unique ignoring case");
    for (const key of envKeys) if (envMutationClass(key) !== "user-mutable" && key !== "PATH") return invalid(`Environment key cannot be saved: ${key}`);
    const snapshot = await this.service.sessions.inStateLane(sessionId, async () => this.service.sessionSnapshot(sessionId));
    const normalized = normalizeEnv(snapshot.exportedEnv);
    const selected: Record<string, string> = Object.create(null);
    for (const key of envKeys) {
      if (!Object.hasOwn(normalized, key)) return invalid(`Selected environment key is absent: ${key}`);
      selected[key] = normalized[key];
    }
    const exportedEnv = environment(selected);
    const checkpointId = randomUUID();
    const value: StoredCheckpoint = { schemaVersion: 1, checkpointId, workspaceId: this.workspaceId, name: options.name || `Session ${sessionId.slice(0, 8)}`, createdAt: new Date().toISOString(), cwd: snapshot.cwd, envKeys: Object.keys(exportedEnv).sort(), exportedEnv, runtimeId: this.service.runtime.snapshot.runtimeId, snapshotId: this.service.runtime.snapshot.snapshotId };
    this.validate(value, checkpointId);
    return inFileLane(this.directory, async () => {
      await this.prepare(true);
      if ((await this.list()).length >= CHECKPOINT_LIMITS.maxCheckpoints) throw new PosixLoomError("CHECKPOINT_LIMIT_REACHED", "Delete a checkpoint before saving another");
      await writeAtomicJson(this.filename(checkpointId), value, CHECKPOINT_LIMITS.maxFileBytes);
      return metadata(value);
    });
  }
  async restore(checkpointId: string): Promise<string> {
    const checkpoint = await this.read(checkpointId);
    const exportedEnv = { ...normalizeEnv(mutableEnvironment(initialSessionEnv())), ...checkpoint.exportedEnv };
    // createSession revalidates cwd against current mounts, policy and filesystem.
    return this.service.createSession(checkpoint.cwd, exportedEnv);
  }
  async fork(sessionId: string): Promise<string> {
    return this.service.sessions.inStateLane(sessionId, async () => {
      const state = this.service.sessionSnapshot(sessionId);
      const exportedEnv = normalizeEnv(mutableEnvironment(state.exportedEnv));
      validateStatePatch({ baseStateVersion: 0n, setEnv: exportedEnv, removeEnv: [] }, { version: 0n, cwd: state.cwd, exportedEnv: {} }, "cwd-env");
      return this.service.createSession(state.cwd, exportedEnv);
    });
  }
  async delete(checkpointId: string): Promise<void> {
    const path = this.filename(checkpointId);
    await inFileLane(this.directory, async () => {
      if (!await this.prepare()) throw new PosixLoomError("CHECKPOINT_NOT_FOUND", "Unknown session checkpoint");
      try { await rm(path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new PosixLoomError("CHECKPOINT_NOT_FOUND", "Unknown session checkpoint"); throw error; }
    });
  }
}
