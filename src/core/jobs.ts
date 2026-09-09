/** Durable, bounded background jobs. HTTP request lifetimes never own these executions. */
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { PosixLoomError, asPosixLoomError } from "./errors.js";
import { isRecord, parseExecutionRequest } from "./execution-request.js";
import { isHostPathInside, normalizeVirtual, physicalCheck } from "./path.js";
import { PolicyGate } from "./policy.js";
import { InteractiveProcessController, validateTerminalSize } from "./process.js";
import type { PosixLoomService } from "./service.js";
import type { CommandOutcome, ExecutionPreview, StatePolicy, TerminalSize } from "./types.js";

export interface JobStep {
  id: string;
  input: { kind: "argv"; argv: string[] } | { kind: "text"; raw: string };
  cwd?: string;
  envDelta?: Record<string, string | null>;
  statePolicy?: StatePolicy;
  timeoutMs?: number;
}
export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export interface JobError { code: string; message: string }
export interface JobStepRecord extends JobStep {
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "skipped" | "interrupted";
  startedAt?: string;
  completedAt?: string;
  outcome?: CommandOutcome;
  state?: Record<string, unknown>;
  error?: JobError;
  planId?: string;
  commandId?: string;
  /** Deliberately excludes argv, executable paths, environment values and path decisions. */
  preview?: Pick<ExecutionPreview, "snapshotId" | "mode" | "backend" | "commandKind" | "timeoutMs" | "statePolicy" | "policyProfile" | "checks">;
  stdoutBytes?: number;
  stderrBytes?: number;
}
export interface JobArtifact {
  artifactId: string;
  name: string;
  size: number;
  sha256: string;
  virtualPath?: string;
  mediaType: string;
}
export interface JobRecord {
  jobId: string;
  sessionId: string;
  label: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  steps: JobStepRecord[];
  artifacts: JobArtifact[];
  artifactPaths: string[];
  /** Per-file capture failures after a failed command; original step failure is preserved. */
  artifactErrors?: Array<{ virtualPath: string; error: JobError }>;
  terminal?: TerminalSize;
  error?: JobError;
  truncated: boolean;
  logBytes: number;
  nextSequence: number;
}
export interface SubmitJobOptions {
  sessionId: string;
  label?: string;
  steps: JobStep[];
  /** Explicit absolute virtual file paths, never host paths or globs. */
  artifacts?: string[];
  terminal?: TerminalSize;
  clientId?: string;
}
export interface JobManagerOptions {
  directory?: string;
  maxJobs?: number;
  maxActiveJobs?: number;
  maxLogBytes?: number;
  maxArtifactBytes?: number;
  maxTotalBytes?: number;
  retentionMs?: number;
}
export type JobEvent = {
  sequence: number;
  time: string;
  type: "started" | "step" | "output" | "completed";
  stepId?: string;
  stream?: "stdout" | "stderr";
  dataBase64?: string;
  status?: string;
  outcome?: CommandOutcome;
  error?: JobError;
};
interface StoredJob {
  record: JobRecord;
  metadataBytes: number;
  /** Space reserved for final status, error and step outcomes. */
  reserve: number;
  diskBytes: number;
  abort?: AbortController;
  interactive?: InteractiveProcessController;
  done?: Promise<JobRecord>;
  logHash: ReturnType<typeof createHash>;
  /** Sparse byte offsets keep reconnect reads independent of prior log volume. */
  logOffsets: Map<number, number>;
}
const DEFAULTS = { maxJobs: 256, maxActiveJobs: 32, maxLogBytes: 64 * 1024 * 1024, maxArtifactBytes: 64 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, retentionMs: 7 * 24 * 60 * 60 * 1000 };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 128 * 1024;
const activeStores = new Set<string>();
const terminal = (status: JobStatus) => status !== "queued" && status !== "running";
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const now = () => new Date().toISOString();
function fail(code: string, message: string): never { throw new PosixLoomError(code, message); }
function jobError(error: unknown): JobError {
  const parsed = asPosixLoomError(error, "JOB_FAILED");
  return { code: parsed.code.slice(0, 128), message: parsed.message.slice(0, 1024) };
}
function safeInteger(value: number, minimum: number, maximum: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail("JOB_REQUEST_INVALID", `${field} must be an integer between ${minimum} and ${maximum}`);
}
/** Reject every symbolic link/junction in a path, including ancestor directories. */
function noLinks(path: string): void {
  let current = resolve(path);
  while (true) {
    if (lstatSync(current).isSymbolicLink()) fail("JOB_PATH_DENIED", "Job files cannot use symbolic links or junctions");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function secureFile(path: string, flags = constants.O_RDONLY): number {
  noLinks(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) fail("JOB_PATH_DENIED", "Job files must be regular files without hard links");
  const fd = openSync(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = fstatSync(fd);
    noLinks(path);
    const after = lstatSync(path);
    if (!actual.isFile() || actual.nlink !== 1 || before.dev !== actual.dev || before.ino !== actual.ino || after.dev !== actual.dev || after.ino !== actual.ino) fail("JOB_PATH_DENIED", "Job file changed while opening");
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
/** Bounded NDJSON scan; incomplete trailing records are ignored for crash recovery. */
function* lines(path: string, length: number, start = 0): Generator<{ line: string; end: number }> {
  const fd = secureFile(path);
  try {
    let offset = start, remainder = Buffer.alloc(0), consumed = start;
    const chunk = Buffer.alloc(64 * 1024);
    while (offset < length) {
      const bytes = readSync(fd, chunk, 0, Math.min(chunk.length, length - offset), offset);
      if (!bytes) break;
      offset += bytes;
      remainder = Buffer.concat([remainder, chunk.subarray(0, bytes)]);
      let index: number;
      while ((index = remainder.indexOf(10)) !== -1) {
        if (index > MAX_LINE_BYTES) fail("JOB_STORE_CORRUPT", "Job log record exceeds its size limit");
        const line = remainder.subarray(0, index).toString("utf8");
        consumed += index + 1;
        remainder = remainder.subarray(index + 1);
        yield { line, end: consumed };
      }
      if (remainder.length > MAX_LINE_BYTES) fail("JOB_STORE_CORRUPT", "Job log record exceeds its size limit");
    }
  } finally { closeSync(fd); }
}

export class JobManager {
  readonly directory: string;
  readonly options: typeof DEFAULTS;
  private readonly jobs = new Map<string, StoredJob>();
  private readonly lockToken = randomUUID();
  private readonly storeKey: string;
  private totalBytes = 0;
  private closed = false;
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private readonly policy: PolicyGate;

  private constructor(private readonly service: PosixLoomService, options: JobManagerOptions) {
    const configured = (service.runtime.config.runtime as typeof service.runtime.config.runtime & { jobs?: JobManagerOptions }).jobs;
    this.options = { ...DEFAULTS, ...configured };
    for (const key of Object.keys(DEFAULTS) as Array<keyof typeof DEFAULTS>) {
      if (options[key] !== undefined) this.options[key] = options[key]!;
      const value = this.options[key];
      if (!Number.isSafeInteger(value) || value <= 0) fail("JOB_OPTIONS_INVALID", `${key} must be a positive safe integer`);
    }
    const workspace = resolve(service.runtime.config.runtime.runtime.workspace);
    const workspaceId = createHash("sha256").update(process.platform === "win32" ? workspace.toLowerCase() : workspace).digest("hex");
    this.directory = resolve(options.directory ?? join(service.runtime.config.dataRoot, "jobs", workspaceId));
    this.storeKey = process.platform === "win32" ? this.directory.toLowerCase() : this.directory;
    const policy = service.runtime.config.runtime.policy;
    this.policy = new PolicyGate(policy.defaultProfile, policy.profiles[policy.defaultProfile], service.runtime.mountTable, service.runtime.snapshot);
  }

  static async create(service: PosixLoomService, options: JobManagerOptions = {}): Promise<JobManager> {
    const manager = new JobManager(service, options);
    manager.acquireLock();
    try {
      manager.restore();
      manager.prune();
      if (manager.totalBytes > manager.options.maxTotalBytes) fail("JOB_STORAGE_FULL", "Existing job storage exceeds the configured quota");
      manager.timer = setInterval(() => {
        try { manager.prune(); } catch { /* A failed prune is retried by the next explicit operation. */ }
      }, Math.min(manager.options.retentionMs, 60_000));
      manager.timer.unref();
      return manager;
    } catch (error) { manager.releaseLock(); throw error; }
  }

  private acquireLock(): void {
    if (activeStores.has(this.storeKey)) fail("JOB_STORE_LOCKED", "This job store already has an active manager");
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    noLinks(this.directory);
    const path = join(this.directory, ".lock");
    if (existsSync(path)) {
      const fd = secureFile(path);
      let lock: { pid?: unknown };
      try {
        if (fstatSync(fd).size > 1024) fail("JOB_STORE_LOCKED", "Job store lock is invalid");
        lock = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!Number.isSafeInteger(lock.pid) || (lock.pid as number) <= 0) fail("JOB_STORE_LOCKED", "Job store lock is invalid");
      try { process.kill(lock.pid as number, 0); fail("JOB_STORE_LOCKED", "Another process owns this job store"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      unlinkSync(path);
    }
    try { writeFileSync(path, JSON.stringify({ pid: process.pid, token: this.lockToken }), { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") fail("JOB_STORE_LOCKED", "Another process owns this job store"); throw error; }
    activeStores.add(this.storeKey);
  }

  private releaseLock(): void {
    try {
      const path = join(this.directory, ".lock");
      if (existsSync(path) && JSON.parse(readFileSync(path, "utf8")).token === this.lockToken) unlinkSync(path);
    } finally { activeStores.delete(this.storeKey); }
  }
  private jobDirectory(id: string): string {
    if (!UUID.test(id)) fail("JOB_NOT_FOUND", "Unknown job");
    const target = resolve(this.directory, id);
    if (dirname(target) !== this.directory) fail("JOB_PATH_DENIED", "Job directory is outside its store");
    return target;
  }
  private require(id: string): StoredJob {
    const job = this.jobs.get(id);
    if (!job) fail("JOB_NOT_FOUND", `Unknown job: ${id}`);
    return job;
  }
  private ensureOpen(): void { if (this.closed) fail("JOB_MANAGER_CLOSED", "Job manager is closed"); }

  private restore(): void {
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!UUID.test(entry.name)) continue;
      const directory = this.jobDirectory(entry.name);
      noLinks(directory);
      if (!entry.isDirectory()) fail("JOB_STORE_CORRUPT", "Job storage contains a non-directory job");
      const metadata = join(directory, "record.json");
      if (!existsSync(metadata)) { this.removeDirectory(directory); continue; }
      const fd = secureFile(metadata);
      let record: JobRecord, metadataBytes: number;
      try {
        metadataBytes = fstatSync(fd).size;
        if (metadataBytes > MAX_METADATA_BYTES) fail("JOB_STORE_CORRUPT", "Job metadata exceeds its size limit");
        record = JSON.parse(readFileSync(fd, "utf8"));
      } finally { closeSync(fd); }
      if (!isRecord(record) || record.jobId !== entry.name || !Array.isArray(record.steps) || record.steps.length > 128 || !Array.isArray(record.artifacts)
        || !["queued", "running", "completed", "failed", "cancelled", "interrupted"].includes(record.status)
        || !Number.isFinite(Date.parse(record.updatedAt))) fail("JOB_STORE_CORRUPT", "Invalid saved job record");
      const output = join(directory, "output.ndjson");
      if (!existsSync(output)) writeFileSync(output, "", { flag: "wx", mode: 0o600 });
      const logSize = statSync(output).size;
      if (logSize > this.options.maxLogBytes) fail("JOB_STORAGE_FULL", "Existing job log exceeds the configured log quota");
      let validBytes = 0, sequence = 0;
      const hash = createHash("sha256");
      const offsets = new Map<number, number>();
      for (const item of lines(output, logSize)) {
        let event: JobEvent;
        try { event = JSON.parse(item.line); } catch { break; }
        if (event.sequence !== sequence) break;
        if (sequence % 64 === 0) offsets.set(sequence, validBytes);
        hash.update(`${item.line}\n`);
        sequence++;
        validBytes = item.end;
      }
      if (validBytes !== logSize) { const logFd = secureFile(output, constants.O_RDWR); try { ftruncateSync(logFd, validBytes); } finally { closeSync(logFd); } }
      record.nextSequence = sequence;
      record.logBytes = validBytes;
      let diskBytes = metadataBytes + validBytes;
      const artifactDirectory = join(directory, "artifacts");
      mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
      noLinks(artifactDirectory);
      const expected = new Set<string>();
      for (const artifact of record.artifacts) {
        if (artifact.artifactId === "output") continue;
        if (!UUID.test(artifact.artifactId)) fail("JOB_STORE_CORRUPT", "Invalid saved artifact identifier");
        const file = join(artifactDirectory, `${artifact.artifactId}.bin`);
        const artifactFd = secureFile(file);
        try {
          const size = fstatSync(artifactFd).size;
          if (size !== artifact.size || size > this.options.maxArtifactBytes) fail("JOB_STORE_CORRUPT", "Saved artifact size is invalid");
          diskBytes += size;
        } finally { closeSync(artifactFd); }
        expected.add(`${artifact.artifactId}.bin`);
      }
      for (const file of readdirSync(artifactDirectory)) {
        if (!expected.has(file)) { const target = join(artifactDirectory, file); noLinks(target); if (!lstatSync(target).isFile()) fail("JOB_STORE_CORRUPT", "Invalid artifact storage entry"); unlinkSync(target); }
      }
      for (const file of readdirSync(directory)) {
        if (file === "record.json" || file === "output.ndjson" || file === "artifacts") continue;
        const target = join(directory, file);
        noLinks(target);
        if (!file.endsWith(".tmp") || !lstatSync(target).isFile()) fail("JOB_STORE_CORRUPT", "Unknown file in job storage");
        unlinkSync(target);
      }
      const job: StoredJob = { record, metadataBytes, reserve: 0, diskBytes, logHash: hash, logOffsets: offsets };
      this.jobs.set(record.jobId, job);
      this.totalBytes += diskBytes;
      if (!terminal(record.status)) {
        record.status = "interrupted";
        record.completedAt = record.updatedAt = now();
        record.error = { code: "JOB_INTERRUPTED", message: "The service stopped before this job finished; the command was not replayed" };
        for (const step of record.steps) { if (step.status === "running") step.status = "interrupted"; else if (step.status === "pending") step.status = "skipped"; }
      }
      this.outputArtifact(job);
      this.persist(job);
    }
  }

  private persist(job: StoredJob): void {
    const bytes = Buffer.from(JSON.stringify(job.record));
    if (bytes.length > MAX_METADATA_BYTES) fail("JOB_STORAGE_FULL", "Job metadata exceeds its limit");
    const delta = bytes.length - job.metadataBytes;
    const reservationUsed = Math.min(job.reserve, Math.max(0, delta));
    if (this.totalBytes + delta - reservationUsed > this.options.maxTotalBytes) fail("JOB_STORAGE_FULL", "Job storage quota was reached");
    const directory = this.jobDirectory(job.record.jobId);
    noLinks(directory);
    const temporary = join(directory, `${randomUUID()}.tmp`);
    try { writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 }); renameSync(temporary, join(directory, "record.json")); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
    job.reserve -= reservationUsed;
    job.metadataBytes = bytes.length;
    job.diskBytes += delta;
    this.totalBytes += delta - reservationUsed;
  }

  private append(job: StoredJob, event: Omit<JobEvent, "sequence" | "time">, final = false): void {
    const item: JobEvent = { ...event, sequence: job.record.nextSequence, time: now() };
    const bytes = Buffer.from(`${JSON.stringify(item)}\n`);
    const tail = final ? 0 : Math.min(2048, Math.floor(this.options.maxLogBytes / 4));
    if (job.record.logBytes + bytes.length > this.options.maxLogBytes - tail) {
      job.record.truncated = true;
      fail("JOB_LOG_QUOTA", "Job output reached the configured log quota");
    }
    const reservationUsed = final ? Math.min(job.reserve, bytes.length) : 0;
    if (this.totalBytes + bytes.length - reservationUsed > this.options.maxTotalBytes) {
      job.record.truncated = true;
      fail("JOB_STORAGE_FULL", "Job output reached the total storage quota");
    }
    const fd = secureFile(join(this.jobDirectory(job.record.jobId), "output.ndjson"), constants.O_WRONLY | constants.O_APPEND);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } finally { closeSync(fd); }
    job.logHash.update(bytes);
    if (job.record.nextSequence % 64 === 0) job.logOffsets.set(job.record.nextSequence, job.record.logBytes);
    job.record.nextSequence++;
    job.record.logBytes += bytes.length;
    job.diskBytes += bytes.length;
    job.reserve -= reservationUsed;
    this.totalBytes += bytes.length - reservationUsed;
  }

  private validateArtifactPath(path: string, existing: boolean): string {
    if (typeof path !== "string" || path.length > 32768 || !path.startsWith("/") || path.includes(":") || path.includes("\0") || normalizeVirtual(path) !== path) fail("JOB_ARTIFACT_PATH_INVALID", "Artifacts require normalized absolute virtual file paths");
    const mount = this.service.runtime.mountTable.findMount(path);
    if (!mount) fail("JOB_ARTIFACT_PATH_INVALID", "Artifact path must belong to a configured mount");
    const host = this.service.runtime.mountTable.toHost(path);
    if (!isHostPathInside(mount.hostPath, host) || path === mount.virtualPath) fail("JOB_ARTIFACT_PATH_INVALID", "Artifact path must name a file inside a mount");
    // assertCwd applies virtual policy roots as well as physical roots.
    this.policy.assertCwd(path, host);
    physicalCheck(host, [mount.hostPath], existing ? "read" : "create");
    if (existing) { noLinks(host); if (!lstatSync(host).isFile()) fail("JOB_ARTIFACT_PATH_INVALID", "Artifacts must be regular files"); }
    else {
      let ancestor = host;
      while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
      noLinks(ancestor);
    }
    return host;
  }

  async submit(options: SubmitJobOptions): Promise<JobRecord> {
    this.ensureOpen();
    if (!isRecord(options) || typeof options.sessionId !== "string" || !Array.isArray(options.steps) || !options.steps.length || options.steps.length > 128) fail("JOB_REQUEST_INVALID", "A job requires a session and between 1 and 128 steps");
    if (options.label !== undefined && (typeof options.label !== "string" || options.label.includes("\0") || Buffer.byteLength(options.label) > 1024)) fail("JOB_REQUEST_INVALID", "Job label must be a NUL-free string of at most 1024 bytes");
    const ids = new Set<string>();
    const steps = options.steps.map((step): JobStepRecord => {
      if (!isRecord(step) || typeof step.id !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(step.id) || ids.has(step.id)) fail("JOB_REQUEST_INVALID", "Step ids must be unique identifiers of at most 128 characters");
      ids.add(step.id);
      const parsed = parseExecutionRequest(step, { code: "JOB_REQUEST_INVALID" });
      return { id: step.id, input: parsed.input, cwd: parsed.cwd, envDelta: parsed.envDelta, statePolicy: parsed.statePolicy, timeoutMs: parsed.timeoutMs, status: "pending" };
    });
    if (options.terminal) { validateTerminalSize(options.terminal); if (steps.length !== 1) fail("JOB_REQUEST_INVALID", "Terminal jobs require exactly one step"); }
    if (options.artifacts !== undefined && (!Array.isArray(options.artifacts) || options.artifacts.length > 64)) fail("JOB_REQUEST_INVALID", "A job accepts at most 64 explicit artifact paths");
    const artifacts = [...new Set(options.artifacts ?? [])];
    for (const path of artifacts) this.validateArtifactPath(path, false);
    this.service.sessionSnapshot(options.sessionId);
    this.prune();
    if ([...this.jobs.values()].filter((job) => job.abort).length >= this.options.maxActiveJobs) fail("JOB_LIMIT_REACHED", "The active job limit has been reached");
    while (this.jobs.size >= this.options.maxJobs) {
      const oldest = [...this.jobs.values()].filter((job) => terminal(job.record.status) && !job.abort).sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt))[0];
      if (!oldest) fail("JOB_LIMIT_REACHED", "All retained job slots are active");
      this.remove(oldest);
    }
    const created = now();
    const record: JobRecord = { jobId: randomUUID(), sessionId: options.sessionId, label: options.label ?? "Untitled job", status: "queued", createdAt: created, updatedAt: created, steps, artifacts: [], artifactPaths: artifacts, terminal: options.terminal ? { ...options.terminal } : undefined, truncated: false, logBytes: 0, nextSequence: 0 };
    const metadataBytes = Buffer.byteLength(JSON.stringify(record));
    const reserve = 4096 + steps.length * 2048 + artifacts.reduce((bytes, path) => bytes + Buffer.byteLength(path) + 4096, 0);
    if (metadataBytes + reserve > MAX_METADATA_BYTES || this.totalBytes + metadataBytes + reserve > this.options.maxTotalBytes) fail("JOB_STORAGE_FULL", "Insufficient space to retain this job and its final result");
    const job: StoredJob = { record, metadataBytes: 0, reserve, diskBytes: 0, abort: new AbortController(), interactive: options.terminal ? new InteractiveProcessController() : undefined, logHash: createHash("sha256"), logOffsets: new Map() };
    const directory = this.jobDirectory(record.jobId);
    mkdirSync(join(directory, "artifacts"), { recursive: true, mode: 0o700 });
    this.totalBytes += reserve;
    try {
      writeFileSync(join(directory, "output.ndjson"), "", { flag: "wx", mode: 0o600 });
      // Initial metadata is accounted separately from the final-result reservation.
      job.reserve = 0;
      this.persist(job);
      job.reserve = reserve;
      this.jobs.set(record.jobId, job);
    } catch (error) { this.totalBytes -= reserve + job.diskBytes; this.removeDirectory(directory); throw error; }
    const submitted = clone(record);
    // withLease enters synchronously, keeping the session alive before submit resolves.
    job.done = this.service.sessions.withLease(record.sessionId, async () => {
      await new Promise<void>((done) => setImmediate(done));
      return this.run(job, options.clientId);
    });
    // Execution errors become persisted job results; no detached rejection is permitted.
    void job.done.catch(() => undefined);
    return submitted;
  }

  private async run(job: StoredJob, clientId?: string): Promise<JobRecord> {
    const record = job.record;
    let executionFailed = false;
    try {
      if (job.abort!.signal.aborted) record.status = "cancelled";
      else {
        record.status = "running";
        record.updatedAt = now();
        this.append(job, { type: "started", status: "running" });
        this.persist(job);
        for (const step of record.steps) {
          if (job.abort!.signal.aborted) { record.status = record.error ? "failed" : "cancelled"; break; }
          step.status = "running";
          step.startedAt = record.updatedAt = now();
          this.append(job, { type: "step", stepId: step.id, status: "running" });
          this.persist(job);
          try {
            const completion = await this.service.execute({ ...step.input, sessionId: record.sessionId, clientId, cwd: step.cwd, envDelta: step.envDelta, statePolicy: step.statePolicy, timeoutMs: step.timeoutMs, terminal: record.terminal, interactive: job.interactive, signal: job.abort!.signal }, {
              onStarted: (preview) => {
                step.planId = preview.planId;
                step.commandId = preview.commandId;
                step.preview = { snapshotId: preview.snapshotId, mode: preview.mode, backend: preview.backend, commandKind: preview.commandKind, timeoutMs: preview.timeoutMs, statePolicy: preview.statePolicy, policyProfile: preview.policyProfile, checks: { ...preview.checks } };
                this.persist(job);
              },
              onOutput: (event) => {
                if (record.error) return;
                try {
                  for (let offset = 0; offset < event.data.length; offset += 64 * 1024) this.append(job, { type: "output", stepId: step.id, stream: event.stream, dataBase64: event.data.subarray(offset, offset + 64 * 1024).toString("base64") });
                }
                catch (error) { record.error = jobError(error); record.truncated = true; job.abort!.abort(); }
              },
            });
            step.outcome = completion.command;
            step.state = JSON.parse(JSON.stringify(completion.state, (_key, value: unknown) => typeof value === "bigint" ? value.toString() : value));
            step.planId = completion.planId;
            step.stdoutBytes = completion.stdoutBytes;
            step.stderrBytes = completion.stderrBytes;
            // Process-level bounded in-memory output does not truncate the separate log observer.
            if (record.error) { step.error = record.error; step.status = "failed"; }
            else if (completion.command.kind === "cancelled") step.status = "cancelled";
            else if (completion.command.kind === "exited" && completion.command.exitCode === 0 && completion.state.kind !== "rejected" && completion.state.kind !== "protocol-failed") step.status = "completed";
            else step.status = "failed";
            step.completedAt = record.updatedAt = now();
            this.append(job, { type: "step", stepId: step.id, status: step.status, outcome: step.outcome }, true);
            this.persist(job);
            if (step.status !== "completed") {
              if (step.status === "cancelled") record.status = "cancelled";
              else executionFailed = true;
              break;
            }
          } catch (error) {
            step.error = record.error = jobError(error);
            step.status = "failed";
            step.completedAt = now();
            executionFailed = true;
            break;
          }
        }
        if (record.status === "running" && job.abort!.signal.aborted) record.status = record.error && record.error.code !== "JOB_CANCELLED" ? "failed" : "cancelled";
        if (record.status === "running") {
          for (const path of record.artifactPaths) {
            if (job.abort!.signal.aborted) { record.status = "cancelled"; break; }
            try { await this.captureArtifact(job, path); }
            catch (error) {
              if (!executionFailed || job.abort!.signal.aborted) throw error;
              record.artifactErrors ??= [];
              record.artifactErrors.push({ virtualPath: path.slice(0, 1024), error: jobError(error) });
            }
          }
          if (record.status === "running") record.status = job.abort!.signal.aborted ? "cancelled" : executionFailed ? "failed" : "completed";
        }
      }
    } catch (error) { record.error = jobError(error); record.status = record.error.code === "JOB_CANCELLED" ? "cancelled" : "failed"; }
    finally {
      for (const step of record.steps) {
        if (step.status === "pending") step.status = "skipped";
        else if (step.status === "running") { step.status = record.status === "cancelled" ? "cancelled" : "failed"; step.error = record.error; step.completedAt = now(); }
      }
      record.completedAt = record.updatedAt = now();
      try { this.append(job, { type: "completed", status: record.status, error: record.error }, true); }
      catch (error) { record.error ??= jobError(error); record.truncated = true; record.status = "failed"; }
      this.outputArtifact(job);
      try { this.persist(job); }
      catch (error) { record.error = jobError(error); record.status = "failed"; }
      this.totalBytes -= job.reserve;
      job.reserve = 0;
      job.interactive?.terminate();
      job.abort = undefined;
    }
    return clone(record);
  }

  private outputArtifact(job: StoredJob): void {
    job.record.artifacts = job.record.artifacts.filter((item) => item.artifactId !== "output");
    job.record.artifacts.push({ artifactId: "output", name: "output.ndjson", size: job.record.logBytes, sha256: job.logHash.copy().digest("hex"), mediaType: "application/x-ndjson" });
  }

  private async captureArtifact(job: StoredJob, path: string): Promise<void> {
    const host = this.validateArtifactPath(path, true);
    const sourceFd = secureFile(host);
    const before = fstatSync(sourceFd);
    const actualPath = realpathSync.native(host);
    const artifactId = randomUUID();
    const destination = join(this.jobDirectory(job.record.jobId), "artifacts", `${artifactId}.bin`);
    let reserved = false, captured = false;
    try {
      if (before.size > this.options.maxArtifactBytes) fail("JOB_ARTIFACT_QUOTA", "Artifact exceeds the per-file size limit");
      if (this.totalBytes + before.size > this.options.maxTotalBytes) fail("JOB_STORAGE_FULL", "Artifact exceeds the total storage quota");
      this.totalBytes += before.size;
      reserved = true;
      const destinationHandle = await open(destination, "wx", 0o600);
      try {
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (offset < before.size) {
          if (job.abort?.signal.aborted) fail("JOB_CANCELLED", "Artifact capture was cancelled");
          const bytes = readSync(sourceFd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
          if (!bytes) fail("JOB_ARTIFACT_CHANGED", "Artifact was shortened while being captured");
          hash.update(buffer.subarray(0, bytes));
          let written = 0;
          while (written < bytes) written += (await destinationHandle.write(buffer, written, bytes - written, offset + written)).bytesWritten;
          offset += bytes;
        }
        const after = fstatSync(sourceFd);
        this.validateArtifactPath(path, true);
        const current = lstatSync(host);
        if (current.dev !== before.dev || current.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || realpathSync.native(host) !== actualPath) fail("JOB_ARTIFACT_CHANGED", "Artifact changed while being captured");
        job.record.artifacts.push({ artifactId, name: basename(host), virtualPath: path, size: offset, sha256: hash.digest("hex"), mediaType: "application/octet-stream" });
        job.diskBytes += offset;
        captured = true;
      } finally { await destinationHandle.close(); }
    } finally {
      closeSync(sourceFd);
      if (!captured) { if (reserved) this.totalBytes -= before.size; if (existsSync(destination)) unlinkSync(destination); }
    }
  }

  list(sessionId?: string): JobRecord[] {
    this.ensureOpen();
    this.prune();
    return [...this.jobs.values()].map((job) => job.record).filter((record) => sessionId === undefined || record.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(clone);
  }
  get(id: string): JobRecord { this.ensureOpen(); return clone(this.require(id).record); }
  async events(id: string, after = -1, limit = 256): Promise<{ events: JobEvent[]; nextSequence: number; hasMore: boolean }> {
    this.ensureOpen();
    safeInteger(after, -1, Number.MAX_SAFE_INTEGER, "after");
    safeInteger(limit, 1, 1024, "limit");
    const job = this.require(id);
    const events: JobEvent[] = [];
    let bytes = 0, nextSequence = after;
    const available = job.record.nextSequence;
    if (after >= available - 1) return { events, nextSequence, hasMore: false };
    const start = job.logOffsets.get(Math.floor((after + 1) / 64) * 64) ?? 0;
    for (const item of lines(join(this.jobDirectory(id), "output.ndjson"), job.record.logBytes, start)) {
      const event = JSON.parse(item.line) as JobEvent;
      if (event.sequence <= after) continue;
      if (events.length >= limit || (events.length > 0 && bytes + Buffer.byteLength(item.line) > MAX_PAGE_BYTES)) break;
      events.push(event);
      bytes += Buffer.byteLength(item.line);
      nextSequence = event.sequence;
    }
    return { events, nextSequence, hasMore: nextSequence + 1 < available };
  }
  async wait(id: string): Promise<JobRecord> { this.ensureOpen(); const job = this.require(id); return clone(job.done ? await job.done : job.record); }
  async cancel(id: string): Promise<JobRecord> {
    this.ensureOpen();
    const job = this.require(id);
    job.abort?.abort();
    return clone(job.done ? await job.done : job.record);
  }
  private controller(id: string): InteractiveProcessController {
    this.ensureOpen();
    const job = this.require(id);
    if (terminal(job.record.status)) fail("JOB_NOT_RUNNING", "The terminal job has finished");
    if (!job.interactive) fail("TERMINAL_MODE_REQUIRED", "This job has no interactive terminal");
    return job.interactive;
  }
  async input(id: string, data: Buffer): Promise<void> { return this.controller(id).write(data); }
  async resize(id: string, columns: number, rows: number): Promise<void> { return this.controller(id).resize(columns, rows); }
  async eof(id: string): Promise<void> { return this.controller(id).end(); }

  async readArtifact(id: string, artifactId: string, offset = 0, limit = MAX_PAGE_BYTES): Promise<JobArtifact & { data: Buffer; offset: number; nextOffset: number; eof: boolean }> {
    this.ensureOpen();
    safeInteger(offset, 0, Number.MAX_SAFE_INTEGER, "offset");
    safeInteger(limit, 1, MAX_PAGE_BYTES, "limit");
    const job = this.require(id);
    const artifact = job.record.artifacts.find((item) => item.artifactId === artifactId);
    if (!artifact) fail("JOB_ARTIFACT_NOT_FOUND", "Unknown job artifact");
    const path = artifactId === "output" ? join(this.jobDirectory(id), "output.ndjson") : join(this.jobDirectory(id), "artifacts", `${artifactId}.bin`);
    const fd = secureFile(path);
    try {
      if (fstatSync(fd).size !== artifact.size) fail("JOB_ARTIFACT_CHANGED", "Stored artifact size has changed");
      const data = Buffer.alloc(Math.min(limit, Math.max(0, artifact.size - offset)));
      let count = 0;
      while (count < data.length) { const bytes = readSync(fd, data, count, data.length - count, offset + count); if (!bytes) break; count += bytes; }
      return { ...clone(artifact), data: data.subarray(0, count), offset, nextOffset: offset + count, eof: offset + count >= artifact.size };
    } finally { closeSync(fd); }
  }

  private removeDirectory(directory: string): void {
    const target = resolve(directory);
    if (dirname(target) !== this.directory || !UUID.test(basename(target)) || relative(this.directory, target).startsWith("..")) fail("JOB_PATH_DENIED", "Refusing to remove a path outside job storage");
    noLinks(target);
    rmSync(target, { recursive: true, force: true });
  }
  private remove(job: StoredJob): void {
    this.removeDirectory(this.jobDirectory(job.record.jobId));
    this.jobs.delete(job.record.jobId);
    this.totalBytes -= job.diskBytes + job.reserve;
  }
  private prune(): void {
    for (const job of this.jobs.values()) if (terminal(job.record.status) && !job.abort && Date.now() - Date.parse(job.record.updatedAt) >= this.options.retentionMs) this.remove(job);
    while (this.jobs.size > this.options.maxJobs) {
      const oldest = [...this.jobs.values()].filter((job) => terminal(job.record.status) && !job.abort).sort((a, b) => a.record.updatedAt.localeCompare(b.record.updatedAt))[0];
      if (!oldest) break;
      this.remove(oldest);
    }
  }
  async delete(id: string): Promise<void> { this.ensureOpen(); const job = this.require(id); if (!terminal(job.record.status) || job.abort) fail("JOB_BUSY", "Cancel and wait for a job before deleting it"); this.remove(job); }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearInterval(this.timer);
    this.closing = (async () => {
      for (const job of this.jobs.values()) job.abort?.abort();
      try { await Promise.allSettled([...this.jobs.values()].map((job) => job.done)); }
      finally { this.releaseLock(); }
    })();
    return this.closing;
  }
}
