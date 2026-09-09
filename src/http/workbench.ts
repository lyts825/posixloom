import { PosixLoomError } from "../core/errors.js";
import { parseExecutionRequest } from "../core/execution-request.js";
import { JobManager, type JobStep } from "../core/jobs.js";
import { ProjectTaskStore } from "../core/tasks.js";
import { SessionCheckpointStore } from "../core/checkpoints.js";
import { diagnosticReport } from "../core/diagnostics.js";
import type { PosixLoomService } from "../core/service.js";

export const WORKBENCH_CAPABILITIES = ["jobs-v1", "job-output-resume", "artifacts-v1", "project-tasks-v1", "session-checkpoints", "session-fork", "terminal-jobs", "diagnostic-export"];

export function isWorkbenchRoute(path: string): boolean {
  return /^\/api\/v1\/(?:jobs|tasks|checkpoints|diagnostics)(?:\/|$)/.test(path)
    || /^\/api\/v1\/sessions\/[^/]+\/(?:checkpoint|fork)$/.test(path);
}

const invalid = (message: string): never => { throw new PosixLoomError("HTTP_WORKBENCH_INVALID", message); };
function segment(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { return invalid("Invalid path encoding"); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded)) return invalid("Invalid resource identifier");
  return decoded;
}
function integer(value: string | null, fallback: number, minimum: number, maximum: number): number {
  const result = value === null ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) return invalid(`Expected an integer between ${minimum} and ${maximum}`);
  return result;
}
function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 64 || value.some((item) => typeof item !== "string" || item.length > 32768 || item.includes("\0"))) return invalid("Expected at most 64 paths");
  return value as string[];
}

/** Optional resources are opened lazily so legacy execution remains lightweight. */
export class WorkbenchHttp {
  private jobsPromise?: Promise<JobManager>;
  private stopped = false;
  readonly tasks: ProjectTaskStore;
  readonly checkpoints: SessionCheckpointStore;
  constructor(readonly service: PosixLoomService) {
    this.tasks = new ProjectTaskStore(service);
    this.checkpoints = new SessionCheckpointStore(service);
  }
  private jobs(): Promise<JobManager> {
    if (this.stopped) throw new PosixLoomError("SERVER_BUSY", "Job service is shutting down");
    this.jobsPromise ??= JobManager.create(this.service).catch((error) => { this.jobsPromise = undefined; throw error; });
    return this.jobsPromise;
  }
  async close(): Promise<void> {
    this.stopped = true;
    if (this.jobsPromise) await (await this.jobsPromise).close();
  }
  async handle(method: string, url: URL, body: Record<string, unknown>, clientId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    if (this.stopped) throw new PosixLoomError("SERVER_BUSY", "Job service is shutting down");
    const path = url.pathname;
    const ok = (result: Record<string, unknown>, status = 200) => ({ status, body: result });
    if (path === "/api/v1/diagnostics" && method === "GET") {
      const id = url.searchParams.get("jobId");
      return ok({ report: diagnosticReport(this.service, id ? (await this.jobs()).get(segment(id)) : undefined) });
    }
    if (path === "/api/v1/tasks") {
      if (method === "GET") return ok({ tasks: await this.tasks.list() });
      if (method === "POST") return ok({ ...await this.tasks.saveManifest(body) });
    }
    const task = path.match(/^\/api\/v1\/tasks\/([^/]+)$/);
    if (task && method === "DELETE") { await this.tasks.delete(segment(task[1])); return ok({ deleted: true }); }
    if (path === "/api/v1/checkpoints" && method === "GET") return ok({ checkpoints: await this.checkpoints.list() });
    const checkpoint = path.match(/^\/api\/v1\/checkpoints\/([^/]+)(\/restore)?$/);
    if (checkpoint) {
      const id = segment(checkpoint[1]);
      if (checkpoint[2] && method === "POST") {
        const sessionId = await this.checkpoints.restore(id);
        return ok({ sessionId, state: this.service.sessionSnapshot(sessionId) }, 201);
      }
      if (!checkpoint[2] && method === "DELETE") { await this.checkpoints.delete(id); return ok({ deleted: true }); }
    }
    const session = path.match(/^\/api\/v1\/sessions\/([^/]+)\/(checkpoint|fork)$/);
    if (session && method === "POST") {
      const id = segment(session[1]);
      if (session[2] === "fork") {
        const sessionId = await this.checkpoints.fork(id);
        return ok({ sessionId, state: this.service.sessionSnapshot(sessionId) }, 201);
      }
      if (body.name !== undefined && typeof body.name !== "string") return invalid("Checkpoint name must be a string");
      return ok({ checkpoint: await this.checkpoints.save(id, { name: body.name as string | undefined, envKeys: stringList(body.envKeys) }) }, 201);
    }
    if (path === "/api/v1/jobs") {
      const jobs = await this.jobs();
      if (method === "GET") return ok({ jobs: jobs.list(url.searchParams.get("sessionId") ?? undefined) });
      if (method === "POST") {
        if (typeof body.sessionId !== "string") return invalid("sessionId is required");
        this.service.sessionSnapshot(body.sessionId);
        if (body.label !== undefined && (typeof body.label !== "string" || body.label.length > 256)) return invalid("Job label must be at most 256 characters");
        let steps: JobStep[];
        let artifacts = stringList(body.artifacts);
        let label = body.label as string | undefined;
        let terminal;
        if (body.taskId !== undefined) {
          if (typeof body.taskId !== "string" || body.input !== undefined || body.terminal !== undefined) return invalid("Task jobs require a taskId and cannot also specify input or terminal");
          if (body.parameters !== undefined && (!body.parameters || typeof body.parameters !== "object" || Array.isArray(body.parameters))) return invalid("Task parameters must be an object");
          const resolved = await this.tasks.resolve(body.taskId, body.parameters as Record<string, string> | undefined);
          steps = resolved.steps;
          artifacts = artifacts ?? resolved.artifacts;
          label ??= resolved.label;
        } else {
          const parsed = parseExecutionRequest(body, { code: "HTTP_WORKBENCH_INVALID" });
          const { input, cwd, envDelta, statePolicy, timeoutMs } = parsed;
          steps = [{ id: "command", input, cwd, envDelta, statePolicy, timeoutMs }];
          terminal = parsed.terminal;
        }
        return ok({ job: await jobs.submit({ sessionId: body.sessionId, label, steps, artifacts, terminal, clientId }) }, 202);
      }
    }
    const job = path.match(/^\/api\/v1\/jobs\/([^/]+)(?:\/(events|cancel|input|resize|eof|artifacts)(?:\/([^/]+))?)?$/);
    if (job) {
      const id = segment(job[1]);
      const action = job[2];
      const jobs = await this.jobs();
      if (!action && method === "GET") return ok({ job: jobs.get(id) });
      if (!action && method === "DELETE") { await jobs.delete(id); return ok({ deleted: true }); }
      if (action === "events" && method === "GET") return ok(await jobs.events(id, integer(url.searchParams.get("after"), -1, -1, Number.MAX_SAFE_INTEGER), integer(url.searchParams.get("limit"), 256, 1, 1024)));
      if (action === "cancel" && method === "POST") { await jobs.cancel(id); return ok({ job: jobs.get(id) }); }
      if (action === "input" && method === "POST") {
        if (typeof body.dataBase64 !== "string" || body.dataBase64.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.dataBase64)) return invalid("Terminal input must be canonical Base64 up to 64 KiB");
        await jobs.input(id, Buffer.from(body.dataBase64, "base64")); return ok({ delivered: true });
      }
      if (action === "resize" && method === "POST") { await jobs.resize(id, body.columns as number, body.rows as number); return ok({ resized: true }); }
      if (action === "eof" && method === "POST") { await jobs.eof(id); return ok({ delivered: true }); }
      if (action === "artifacts" && job[3] && method === "GET") {
        const chunk = await jobs.readArtifact(id, segment(job[3]), integer(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER), integer(url.searchParams.get("limit"), 262144, 1, 1024 * 1024));
        const { data, ...metadata } = chunk;
        return ok({ ...metadata, dataBase64: data.toString("base64") });
      }
    }
    throw new PosixLoomError("HTTP_METHOD_NOT_ALLOWED", "Method is not supported for this workbench resource");
  }
}
