import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const { JobEventCursor, activeJob, jobStatus, readSessionState, rememberSession, storageKey, taskParameters, textToBase64 } = await import(new URL("../src/gui/public/workbench.js", import.meta.url).href);

test("GUI resumes per-origin session selection and preserves previous sessions without secrets", () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null };
  const origin = "http://127.0.0.1:7331";
  let sessions = readSessionState(storage, origin);
  sessions = rememberSession(sessions, { sessionId: "development", state: { cwd: "/workspace", env: { SECRET: "never-store" } } });
  sessions = rememberSession(sessions, { sessionId: "testing", state: { cwd: "/workspace/tests" } });
  values.set(storageKey(origin), JSON.stringify(sessions));
  const restored = readSessionState(storage, origin);
  assert.deepEqual(restored.sessions.map((session: { sessionId: string }) => session.sessionId), ["development", "testing"]);
  assert.equal(restored.selected, "testing");
  assert.equal(JSON.stringify(restored).includes("never-store"), false);
  assert.equal(readSessionState(storage, "http://127.0.0.1:9999").sessions.length, 0);
  assert.notEqual(storageKey(origin), storageKey(origin, "token"));
  const switched = rememberSession(restored, { sessionId: "development", state: { cwd: "/workspace/src" } });
  assert.equal(switched.sessions.length, 2);
  assert.equal(switched.selected, "development");
});

test("GUI tolerates unavailable or corrupt session storage and bounds remembered sessions", () => {
  assert.deepEqual(readSessionState({ getItem: () => { throw new Error("disabled"); } }, "http://localhost:1"), { sessions: [], selected: null });
  assert.deepEqual(readSessionState({ getItem: () => "{" }, "http://localhost:1"), { sessions: [], selected: null });
  const invalid = readSessionState({ getItem: () => JSON.stringify({ sessions: [{ sessionId: 1 }, { sessionId: "valid", cwd: "/workspace" }], selected: "missing" }) }, "http://localhost:1");
  assert.equal(invalid.sessions.length, 1);
  assert.equal(invalid.selected, null);
  let value = { sessions: [], selected: null };
  for (let index = 0; index < 120; index += 1) value = rememberSession(value, { sessionId: String(index), cwd: "/workspace" });
  assert.equal(value.sessions.length, 100);
});

test("GUI event replay survives duplicate pages and split UTF-8 across steps and streams", () => {
  const cursor = new JobEventCursor();
  const output: Array<[string, string]> = [];
  const bytes: Uint8Array[] = [];
  const append = (text: string, stream: string): void => { if (text) output.push([text, stream]); };
  const emit = (sequence: number, stepId: string, stream: string, chunk: Buffer) => ({ type: "output", sequence, stepId, stream, dataBase64: chunk.toString("base64") });
  const chinese = Buffer.from("汉😀");
  const first = [
    { type: "started", sequence: 0 },
    emit(1, "a", "stdout", chinese.subarray(0, 2)),
    emit(2, "a", "stderr", Buffer.from("warning")),
  ];
  cursor.consume(first, append, (chunk: Uint8Array) => bytes.push(chunk));
  assert.equal(cursor.sequence, 2);
  cursor.consume(first, append, (chunk: Uint8Array) => bytes.push(chunk));
  cursor.consume([
    emit(3, "b", "stdout", Buffer.from("step b")),
    emit(4, "a", "stdout", chinese.subarray(2)),
    { type: "completed", sequence: 5 },
  ], append, (chunk: Uint8Array) => bytes.push(chunk));
  cursor.finish(append);
  assert.deepEqual(output, [["warning", "stderr"], ["step b", ""], ["汉😀", ""]]);
  assert.equal(cursor.sequence, 5);
  assert.equal(bytes.length, 4);
  assert.equal(cursor.decoders.size, 0);
});

test("GUI output cursor rejects malformed events without skipping their sequence", () => {
  const cursor = new JobEventCursor();
  const append = (): void => {};
  assert.throws(() => cursor.consume([{ sequence: 0, type: "output", stream: "unknown", dataBase64: "" }], append));
  assert.equal(cursor.sequence, -1);
  assert.throws(() => cursor.consume([{ sequence: 0, type: "output", stream: "stdout", dataBase64: "bad" }], append));
  assert.equal(cursor.sequence, -1);
  assert.throws(() => cursor.consume([{ sequence: "0" }], append));
  cursor.consume([{ sequence: 0, type: "output", stream: "stdout", dataBase64: textToBase64("recovered") }], append);
  assert.equal(cursor.sequence, 0);
});

test("GUI task parameters enforce required fields and enum values while preserving literal shell characters", () => {
  const task = { parameters: { target: { type: "string", required: true }, mode: { type: "enum", values: ["quick", "full"], default: "quick" }, optional: { type: "string" } } };
  assert.throws(() => taskParameters(task, { target: " " }), /target/);
  assert.throws(() => taskParameters(task, { target: "src", mode: "unknown" }), /mode/);
  const values = taskParameters(task, { target: "src; echo $(secret)", extra: "ignored" });
  assert.deepEqual({ ...values }, { target: "src; echo $(secret)", mode: "quick" });
  assert.equal(Object.getPrototypeOf(values), null);
  const unicode = "终端输入 😀\r\u0003";
  assert.equal(Buffer.from(textToBase64(unicode), "base64").toString("utf8"), unicode);
});

test("GUI renders lifecycle states consistently across active and archived jobs", () => {
  for (const status of ["queued", "running"]) assert.equal(activeJob({ status }), true);
  for (const status of ["completed", "failed", "cancelled", "interrupted"]) { assert.equal(activeJob({ status }), false); assert.notEqual(jobStatus(status), status); }
  assert.equal(activeJob(null), false);
});

test("GUI bindings submit once, reconcile sessions after restart, save checkpoints and retain history", async (context) => {
  // Exercise the actual app module with deterministic DOM/network boundaries.
  // Real terminal layout and browser rendering are validated separately in the GUI.
  class Element {
    children: Element[] = [];
    parent?: Element;
    private text = "";
    value = "";
    className = "";
    hidden = false;
    disabled = false;
    checked = false;
    open = false;
    title = "";
    type = "";
    scrollTop = 0;
    clientHeight = 100;
    clientWidth = 800;
    dataset: Record<string, string> = {};
    listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    classes = new Set<string>();
    classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
      toggle: (name: string, force?: boolean): boolean => { const add = force ?? !this.classes.has(name); if (add) this.classes.add(name); else this.classes.delete(name); return add; },
    };
    ownerDocument = { createElement: () => new Element(), createDocumentFragment: () => new Element(true) };
    constructor(readonly fragment = false) {}
    get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
    set textContent(value: string) { this.text = value; this.children = []; }
    get scrollHeight(): number { return this.textContent.length; }
    append(...nodes: Element[]): void { for (const node of nodes) { if (node.fragment) this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
    replaceChildren(...nodes: Element[]): void { this.text = ""; this.children = []; this.append(...nodes); }
    remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
    focus(): void {}
    setAttribute(): void {}
    showModal(): void { this.open = true; }
    close(): void { this.open = false; }
    getBoundingClientRect(): { top: number; bottom: number } { return { top: 0, bottom: 100 }; }
    querySelectorAll(selector: string): Element[] { return this.children.flatMap((child) => [...(selector === "[data-parameter]" && child.dataset.parameter ? [child] : []), ...child.querySelectorAll(selector)]); }
    addEventListener(type: string, action: (event: Record<string, unknown>) => void): void { this.listeners.set(type, [...this.listeners.get(type) || [], action]); }
    removeEventListener(type: string): void { this.listeners.delete(type); }
    fire(type: string, values: Record<string, unknown> = {}): void { for (const action of this.listeners.get(type) || []) action({ preventDefault() {}, ...values }); }
  }
  const html = await readFile(new URL("../src/gui/public/index.html", import.meta.url), "utf8");
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map((match) => [match[1], new Element()]));
  const node = (id: string): Element => { const value = nodes.get(id); assert.ok(value, id); return value; };
  node("cwdInput").value = "/workspace";
  const original = new Map<string, PropertyDescriptor | undefined>();
  const define = (name: string, value: unknown): void => { original.set(name, Object.getOwnPropertyDescriptor(globalThis, name)); Object.defineProperty(globalThis, name, { value, configurable: true, writable: true }); };
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const saved = new Map<string, string>();
  saved.set(storageKey("http://api.test"), JSON.stringify({ selected: "expired-2", sessions: [{ sessionId: "expired-1", cwd: "/workspace/old" }, { sessionId: "expired-2", cwd: "/workspace/other" }] }));
  define("document", { getElementById: (id: string) => nodes.get(id), querySelectorAll: () => [], createElement: () => new Element(), body: new Element() });
  define("window", { addEventListener() {} });
  define("location", { hash: "" });
  define("sessionStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) });
  define("requestAnimationFrame", (callback: () => void) => { frames.set(++frameId, callback); return frameId; });
  define("cancelAnimationFrame", (id: number) => frames.delete(id));
  context.after(() => { for (const [name, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); } });
  const requests: Array<{ path: string; method: string; body: Record<string, unknown>; headers: Headers }> = [];
  let sessionCount = 0;
  const liveSessions = new Map<string, string>();
  let releaseSubmit!: () => void;
  const submitGate = new Promise<void>((resolve) => { releaseSubmit = resolve; });
  let storedJob: Record<string, unknown> | undefined;
  define("fetch", async (input: string, options: RequestInit = {}) => {
    const url = new URL(input, "http://gui.test");
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(String(options.body)) as Record<string, unknown> : {};
    requests.push({ path: url.pathname, method, body, headers: new Headers(options.headers) });
    let payload: unknown;
    if (url.pathname === "/config.json") payload = { apiBaseUrl: "http://api.test" };
    else if (url.pathname === "/api/v1/capabilities") payload = { capabilities: [] };
    else if (url.pathname === "/api/v1/runtime") payload = { runtime: { runtimeSemver: "1.0", runtimeId: "rt", mode: "native", snapshotId: "snapshot", source: "local", policyProfile: "standard", nativeCommands: [], mounts: [] } };
    else if (url.pathname === "/api/v1/runtime/doctor") payload = { report: { ok: true, checks: [] } };
    else if (url.pathname === "/api/v1/sessions" && method === "GET") payload = { sessions: [...liveSessions].map(([sessionId, cwd]) => ({ sessionId, state: { cwd } })) };
    else if (url.pathname === "/api/v1/sessions" && method === "POST") {
      const sessionId = `session-${++sessionCount}`;
      liveSessions.set(sessionId, "/workspace");
      payload = { sessionId, state: { cwd: "/workspace" } };
    }
    else if (/^\/api\/v1\/sessions\/[^/]+$/.test(url.pathname)) {
      const sessionId = url.pathname.split("/").at(-1)!;
      if (!liveSessions.has(sessionId)) return Response.json({ error: { code: "SESSION_NOT_FOUND", message: "Session expired" } }, { status: 404 });
      payload = { sessionId, state: { cwd: liveSessions.get(sessionId) } };
    }
    else if (url.pathname.endsWith("/checkpoint")) payload = { checkpoint: { checkpointId: "checkpoint-1" } };
    else if (url.pathname === "/api/v1/checkpoints") payload = { checkpoints: [] };
    else if (url.pathname === "/api/v1/tasks") payload = { tasks: [] };
    else if (url.pathname === "/api/v1/jobs" && method === "POST") {
      await submitGate;
      storedJob = { jobId: "job-1", sessionId: body.sessionId, label: "test job", status: "failed", createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:01Z", steps: [{ id: "command", input: body.input, status: "failed", outcome: { kind: "exited", exitCode: 7 } }], artifacts: [{ artifactId: "output", name: "output.ndjson", size: 24 }], artifactErrors: [{ virtualPath: "/workspace/<missing>.json", error: { code: "ARTIFACT_NOT_FOUND", message: "Missing report " + "x".repeat(2000) } }] };
      payload = { job: storedJob };
    } else if (url.pathname === "/api/v1/jobs") payload = { jobs: storedJob && (url.searchParams.get("sessionId") === storedJob.sessionId || !url.searchParams.has("sessionId")) ? [storedJob] : [] };
    else if (url.pathname === "/api/v1/jobs/job-1") payload = { job: storedJob };
    else if (url.pathname === "/api/v1/jobs/job-1/events") payload = { events: Number(url.searchParams.get("after")) < 0 ? [{ type: "output", sequence: 0, stream: "stdout", dataBase64: textToBase64("persisted output") }] : [], nextSequence: 0, hasMore: false };
    else throw new Error(`Unexpected mock request ${method} ${url.pathname}`);
    return Response.json(payload);
  });
  const until = async (predicate: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 100 && !predicate(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.ok(predicate(), node("toast").textContent || "Timed out waiting for UI action");
  };
  await import(new URL("../src/gui/public/app.js", import.meta.url).href);
  await until(() => requests.some((request) => request.path === "/api/v1/tasks"));
  assert.deepEqual(node("sessionSelect").children.map((option) => option.value), ["session-1"]);
  assert.equal(saved.get(storageKey("http://api.test"))!.includes("expired-"), false);
  node("newSessionButton").fire("click");
  await until(() => node("sessionSelect").children.length === 2);
  assert.equal(requests.some((request) => request.method === "DELETE"), false);
  node("commandInput").value = "printf hello";
  node("runButton").fire("click");
  node("commandInput").fire("keydown", { key: "Enter", ctrlKey: true });
  await until(() => requests.some((request) => request.path === "/api/v1/jobs" && request.method === "POST"));
  assert.equal(requests.filter((request) => request.path === "/api/v1/jobs" && request.method === "POST").length, 1);
  assert.equal(node("runButton").disabled, true);
  assert.match(requests.find((request) => request.path === "/api/v1/jobs" && request.method === "POST")!.headers.get("idempotency-key")!, /^[0-9a-f-]{36}$/);
  releaseSubmit();
  await until(() => node("terminalOutput").textContent.includes("persisted output") && !node("runButton").disabled);
  assert.equal(node("jobStatus").textContent, "失败");
  assert.match(node("jobSteps").textContent, /失败 · exit 7/);
  assert.match(node("jobArtifacts").textContent, /output\.ndjson.*未归档：\/workspace\/<missing>\.json.*ARTIFACT_NOT_FOUND: Missing report/);
  assert.ok(node("jobArtifacts").textContent.length < 1200, "Archive error messages remain bounded and retain the original failed command outcome");
  node("commandInput").value = "changed";
  node("jobSteps").children[0].children[2].fire("click");
  assert.equal(node("commandInput").value, "printf hello");
  node("saveCheckpointButton").fire("click");
  await until(() => requests.some((request) => request.path.endsWith("/checkpoint")));
  assert.deepEqual(requests.find((request) => request.path.endsWith("/checkpoint"))!.body, { envKeys: [] });
  node("taskExampleButton").fire("click");
  node("saveTasksButton").fire("click");
  await until(() => requests.some((request) => request.path === "/api/v1/tasks" && request.method === "POST"));
  const manifest = requests.find((request) => request.path === "/api/v1/tasks" && request.method === "POST")!.body;
  assert.equal(manifest.schemaVersion, 1);
  assert.match(JSON.stringify(manifest), /\$\{target\}/);
  await until(() => !node("saveTasksButton").disabled && !node("saveCheckpointButton").disabled);
  // The server restarts with both remembered sessions gone and a new live session.
  liveSessions.clear();
  liveSessions.set("session-fresh", "/workspace/restored");
  node("allHistory").checked = true;
  node("authForm").fire("submit");
  await until(() => node("sessionSelect").value === "session-fresh" && node("jobList").textContent.includes("test job"));
  assert.deepEqual(node("sessionSelect").children.map((option) => option.value), ["session-fresh"]);
  assert.equal(node("cwdInput").value, "/workspace/restored");
  assert.equal(sessionCount, 2, "An existing live session is selected without creating another");
  assert.equal(saved.get(storageKey("http://api.test"))!.includes("session-2"), false);
  liveSessions.set("session-other", "/workspace/other");
  node("authForm").fire("submit");
  await until(() => node("sessionSelect").children.length === 2);
  assert.equal(node("sessionSelect").value, "session-fresh", "A live current session remains selected on reconnect");
});
