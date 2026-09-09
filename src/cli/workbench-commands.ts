import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PosixLoomError } from "../core/errors.js";
import { JobManager } from "../core/jobs.js";
import { ProjectTaskStore } from "../core/tasks.js";
import { PosixLoomService } from "../core/service.js";
import { diagnosticReport } from "../core/diagnostics.js";
import type { RuntimeManager } from "../core/runtime.js";

function json(value: unknown): string { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2); }
const usage = () => new PosixLoomError("CLI_WORKBENCH_INVALID", "Use task list|show|run <id> [--param name=value] [--json]; job list|show|events|cancel|delete|submit [id] [--request file] [--api-url url]; checkpoint list|save|restore|fork|delete [id] [--env-key name] [--api-url url]; diagnostics [--job id] [--api-url url] [--output file]");

/** Project tasks run locally; jobs and checkpoints address a persistent HTTP service. */
export async function workbenchCommand(runtime: RuntimeManager, args: string[]): Promise<void> {
  const [group] = args;
  const positional: string[] = [];
  const params: Record<string, string> = Object.create(null);
  const envKeys: string[] = [];
  let apiUrl: string | undefined;
  let token = process.env.POSIXLOOM_HTTP_TOKEN;
  let requestFile: string | undefined;
  let output: string | undefined;
  let name: string | undefined;
  let sessionId: string | undefined;
  let jobId: string | undefined;
  let after = -1;
  let asJson = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") { asJson = true; continue; }
    if (!arg.startsWith("--")) { positional.push(arg); continue; }
    const value = args[++index];
    if (!value || value.startsWith("--")) throw usage();
    if (arg === "--api-url") apiUrl = value;
    else if (arg === "--token") token = value;
    else if (arg === "--request") requestFile = value;
    else if (arg === "--output") output = value;
    else if (arg === "--session") sessionId = value;
    else if (arg === "--job") jobId = value;
    else if (arg === "--name") name = value;
    else if (arg === "--env-key") envKeys.push(value);
    else if (arg === "--after") {
      after = Number(value);
      if (!Number.isSafeInteger(after) || after < -1) throw usage();
    } else if (arg === "--param") {
      const equal = value.indexOf("=");
      if (equal < 1) throw usage();
      params[value.slice(0, equal)] = value.slice(equal + 1);
    } else throw usage();
  }
  const [action, id] = positional;
  const service = new PosixLoomService(runtime);
  const emit = async (value: unknown): Promise<void> => {
    const text = json(value) + "\n";
    if (output) await writeFile(output, text, { encoding: "utf8", flag: "wx" });
    else process.stdout.write(text);
  };
  if (group === "task") {
    if (positional.length > (action === "list" ? 1 : 2)) throw usage();
    const tasks = new ProjectTaskStore(service);
    if (action === "list") { await emit({ tasks: await tasks.list() }); return; }
    if (!id) throw usage();
    if (action === "show") {
      const definition = (await tasks.list()).find((task) => task.id === id);
      if (!definition) throw new PosixLoomError("TASK_NOT_FOUND", "Unknown project task");
      await emit(definition); return;
    }
    if (action !== "run") throw usage();
    const resolved = await tasks.resolve(id, params);
    const jobs = await JobManager.create(service);
    const createdSession = service.createSession();
    let activeId: string | undefined;
    let cursor = -1;
    let polling = false;
    const poll = async (): Promise<void> => {
      if (polling || !activeId || asJson) return;
      polling = true;
      try {
        let more = true;
        while (more) {
          const page = await jobs.events(activeId, cursor, 256);
          for (const event of page.events) {
            if (event.type === "output") {
              const stream = event.stream === "stderr" ? process.stderr : process.stdout;
              stream.write(Buffer.from(event.dataBase64 as string, "base64"));
            }
          }
          cursor = page.nextSequence; more = page.hasMore;
        }
      } finally { polling = false; }
    };
    const cancel = (): void => { if (activeId) void jobs.cancel(activeId).catch(() => undefined); };
    process.once("SIGINT", cancel);
    let timer: NodeJS.Timeout | undefined;
    try {
      const job = await jobs.submit({ sessionId: createdSession, ...resolved });
      activeId = job.jobId;
      timer = setInterval(() => { void poll().catch(() => undefined); }, 100);
      const result = await jobs.wait(job.jobId);
      clearInterval(timer);
      // Join an in-progress read before the final drain.
      while (polling) await new Promise((resolve) => setTimeout(resolve, 10));
      await poll();
      if (asJson) await emit({ job: result });
      else process.stderr.write(`\nJob ${result.jobId}: ${result.status}\n`);
      if (result.status !== "completed") process.exitCode = result.status === "cancelled" ? 130 : 1;
    } finally {
      if (timer) clearInterval(timer);
      process.off("SIGINT", cancel);
      await jobs.close();
    }
    return;
  }
  if (group === "diagnostics" && !apiUrl && !jobId) { await emit(diagnosticReport(service)); return; }
  let origin: URL;
  try { origin = new URL(apiUrl ?? "http://127.0.0.1:7331"); } catch { throw usage(); }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw usage();
  const api = async (path: string, method = "GET", body?: unknown): Promise<any> => {
    const response = await fetch(new URL(`/api/v1${path}`, origin.origin), {
      method, signal: AbortSignal.timeout(30000),
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(path === "/jobs" && method === "POST" ? { "idempotency-key": randomUUID() } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new PosixLoomError(result.error?.code ?? "HTTP_REQUEST_FAILED", result.error?.message ?? `HTTP ${response.status}`);
    return result;
  };
  if (group === "diagnostics") { await emit((await api(`/diagnostics${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`)).report); return; }
  if (group === "job") {
    if (action === "list") { await emit(await api(`/jobs${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`)); return; }
    if (action === "submit") {
      if (!requestFile) throw usage();
      const bytes = await readFile(requestFile);
      if (bytes.length > 1024 * 1024) throw new PosixLoomError("CLI_WORKBENCH_INVALID", "Job request exceeds 1 MiB");
      const body = JSON.parse(bytes.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw usage();
      body.sessionId ??= sessionId ?? (await api("/sessions", "POST", {})).sessionId;
      await emit(await api("/jobs", "POST", body)); return;
    }
    if (!id) throw usage();
    const path = `/jobs/${encodeURIComponent(id)}`;
    if (action === "show") await emit(await api(path));
    else if (action === "events") await emit(await api(`${path}/events?after=${after}`));
    else if (action === "cancel") await emit(await api(`${path}/cancel`, "POST", {}));
    else if (action === "delete") await emit(await api(path, "DELETE"));
    else throw usage();
    return;
  }
  if (group === "checkpoint") {
    if (action === "list") { await emit(await api("/checkpoints")); return; }
    if (!id) throw usage();
    if (action === "save") await emit(await api(`/sessions/${encodeURIComponent(id)}/checkpoint`, "POST", { name, envKeys }));
    else if (action === "fork") await emit(await api(`/sessions/${encodeURIComponent(id)}/fork`, "POST", {}));
    else if (action === "restore") await emit(await api(`/checkpoints/${encodeURIComponent(id)}/restore`, "POST", {}));
    else if (action === "delete") await emit(await api(`/checkpoints/${encodeURIComponent(id)}`, "DELETE"));
    else throw usage();
    return;
  }
  throw usage();
}
