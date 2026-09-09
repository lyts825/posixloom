import { bytesFromBase64, createTerminalView } from "./console-output.js";
import { activeJob, jobStatus, storageKey, readSessionState, rememberSession, taskParameters, textToBase64, JobEventCursor } from "./workbench.js";

const byId = (id) => document.getElementById(id);

const elements = {
  apiAddress: byId("apiAddress"),
  authDialog: byId("authDialog"),
  authError: byId("authError"),
  authForm: byId("authForm"),
  cancelButton: byId("cancelButton"),
  clearButton: byId("clearButton"),
  commandInput: byId("commandInput"),
  connectionButton: byId("connectionButton"),
  connectionLabel: byId("connectionLabel"),
  cwdInput: byId("cwdInput"),
  doctorChecks: byId("doctorChecks"),
  executionTime: byId("executionTime"),
  explainButton: byId("explainButton"),
  healthSummary: byId("healthSummary"),
  mobileNavButton: byId("mobileNavButton"),
  mountTable: byId("mountTable"),
  newSessionButton: byId("newSessionButton"),
  pluginBadge: byId("pluginBadge"),
  pluginCount: byId("pluginCount"),
  pluginEmpty: byId("pluginEmpty"),
  pluginGrid: byId("pluginGrid"),
  pluginSearch: byId("pluginSearch"),
  refreshRuntimeButton: byId("refreshRuntimeButton"),
  routeChip: byId("routeChip"),
  runButton: byId("runButton"),
  runtimeMetrics: byId("runtimeMetrics"),
  sessionLabel: byId("sessionLabel"),
  sidebar: byId("sidebar"),
  statusDot: byId("statusDot"),
  terminalOutput: byId("terminalOutput"),
  terminalScroll: byId("terminalScroll"),
  terminalNotice: byId("terminalNotice"),
  latestOutputButton: byId("latestOutputButton"),
  toast: byId("toast"),
  tokenInput: byId("tokenInput"),
};
for (const id of ["sessionSelect", "checkpointName", "checkpointEnvKeys", "checkpointList", "saveCheckpointButton", "forkSessionButton", "interactiveMode", "artifactPaths", "timeoutInput", "interactiveTerminal", "terminalInputForm", "terminalInput", "terminalEofButton", "terminalInterruptButton", "outputModeButton", "jobDetails", "jobTitle", "jobStatus", "jobCaption", "jobSteps", "jobArtifacts", "jobList", "allHistory", "refreshHistoryButton", "taskSelect", "taskDescription", "taskParameters", "taskStepsPreview", "taskRunForm", "runTaskButton", "refreshTasksButton", "taskManifest", "taskManifestError", "taskExampleButton", "saveTasksButton", "tasksLocation", "diagnosticsButton", "jobDiagnosticsButton"]) elements[id] = byId(id);

const terminal = createTerminalView({ output: elements.terminalOutput, scroll: elements.terminalScroll, notice: elements.terminalNotice, latest: elements.latestOutputButton });
terminal.clear();
terminal.append("PosixLoom 控制台已就绪。", "terminal-muted");

const state = {
  apiBaseUrl: "",
  capabilities: [],
  connected: false,
  executing: false,
  submitting: false,
  mode: "text",
  pluginFilter: "all",
  plugins: [],
  sessionId: null,
  token: "",
  sessions: [],
  jobs: [],
  tasks: [],
  selectedJob: null,
  followVersion: 0,
  sessionVersion: 0,
  pollTimer: null,
  interactive: null,
  terminalVisible: false,
};

class ApiError extends Error {
  constructor(code, message, status = 0, details = {}) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function errorText(error) {
  if (error instanceof Error && typeof error.code === "string") return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

let toastTimer;
function toast(message, kind = "info") {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", kind === "error");
  elements.toast.classList.add("visible");
  toastTimer = setTimeout(() => elements.toast.classList.remove("visible"), 3200);
}

function setConnection(status, label) {
  state.connected = status === "online";
  elements.statusDot.className = `status-dot ${status}`;
  elements.connectionLabel.textContent = label;
}

function requestToken(message = "请输入远程服务的访问令牌。") {
  setConnection("offline", "需要授权");
  elements.authError.textContent = message;
  elements.tokenInput.value = state.token;
  if (!elements.authDialog.open) elements.authDialog.showModal();
  requestAnimationFrame(() => elements.tokenInput.focus());
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  headers.set("accept", "application/json");
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (options.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  let response;
  try {
    response = await fetch(`${state.apiBaseUrl}${path}`, { ...options, headers });
  } catch (error) {
    setConnection("offline", "连接失败");
    throw new ApiError("NETWORK_ERROR", `无法连接 ${state.apiBaseUrl}: ${errorText(error)}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok) {
    const remote = payload.error || {};
    const error = new ApiError(remote.code || `HTTP_${response.status}`, remote.message || response.statusText, response.status, remote.details || {});
    if (response.status === 401) requestToken("令牌无效或已失效，请重新输入。");
    throw error;
  }
  setConnection("online", "已连接");
  return payload;
}

function navigate(view) {
  document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  document.querySelectorAll(".view").forEach((item) => item.classList.toggle("active", item.id === `view-${view}`));
  elements.sidebar.classList.remove("open");
  elements.mobileNavButton.setAttribute("aria-expanded", "false");
  location.hash = view;
  if (view === "plugins" && state.capabilities.includes("plugins")) void loadPlugins();
  if (view === "tasks") void loadTasks();
  if (view === "console") requestAnimationFrame(() => fitTerminal());
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
  elements.commandInput.placeholder = mode === "text"
    ? "输入命令，例如 git status --short"
    : '["git", "status", "--short"]';
}

function commandRequest(stream = false) {
  const raw = elements.commandInput.value;
  if (!raw.trim()) throw new ApiError("COMMAND_EMPTY", "请先输入命令。");
  let input;
  if (state.mode === "text") input = { kind: "text", raw };
  else {
    let argv;
    try {
      argv = JSON.parse(raw);
    } catch {
      throw new ApiError("ARGV_JSON_INVALID", "argv 模式需要 JSON 字符串数组。");
    }
    if (!Array.isArray(argv) || argv.length === 0 || argv.some((argument) => typeof argument !== "string")) {
      throw new ApiError("ARGV_JSON_INVALID", "argv 必须是至少含一个元素的字符串数组。");
    }
    input = { kind: "argv", argv };
  }
  return { input, cwd: elements.cwdInput.value || undefined, stream };
}

function clearTerminal() {
  terminal.clear();
  state.interactive?.terminal.clear();
  elements.routeChip.hidden = true;
  elements.executionTime.textContent = "就绪";
}

function appendTerminal(text, className = "") {
  terminal.append(text, className);
}

function setExecuting(executing) {
  state.executing = executing;
  elements.runButton.disabled = executing || state.submitting;
  elements.explainButton.disabled = executing || state.submitting;
  elements.cancelButton.hidden = !executing;
  elements.terminalInput.disabled = !executing;
  elements.terminalEofButton.disabled = !executing;
  elements.terminalInterruptButton.disabled = !executing;
}

async function ensureSession(replace = false) {
  if (state.sessionId && !replace) return state.sessionId;
  const version = ++state.sessionVersion;
  const payload = await api("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ cwd: elements.cwdInput.value || "/workspace" }),
  });
  if (version !== state.sessionVersion) { adoptSession(payload, false); return payload.sessionId; }
  adoptSession(payload);
  if (replace) resetSelectedJob();
  await loadJobs();
  return payload.sessionId;
}

async function refreshSession() {
  if (!state.sessionId) return;
  const id = state.sessionId;
  try {
    const payload = await api(`/api/v1/sessions/${encodeURIComponent(id)}`);
    if (id === state.sessionId) adoptSession({ ...payload, sessionId: id });
  } catch (error) {
    if (id === state.sessionId && error instanceof ApiError && error.status === 404) await ensureSession(true);
  }
}

function persistSessions() {
  try { sessionStorage.setItem(storageKey(state.apiBaseUrl), JSON.stringify({ sessions: state.sessions, selected: state.sessionId })); } catch { /* Private storage may be unavailable. */ }
}

function adoptSession(payload, select = true) {
  const remembered = rememberSession({ sessions: state.sessions }, payload);
  state.sessions = remembered.sessions;
  if (select || !state.sessionId) state.sessionId = remembered.selected;
  elements.sessionLabel.textContent = state.sessionId;
  elements.sessionLabel.title = state.sessionId;
  if (select) elements.cwdInput.value = payload.state?.cwd || payload.cwd || "/workspace";
  elements.sessionSelect.replaceChildren();
  for (const item of state.sessions) {
    const option = createElement("option", "", `${item.cwd} · ${item.sessionId.slice(0, 12)}`);
    option.value = item.sessionId;
    option.title = item.sessionId;
    elements.sessionSelect.append(option);
  }
  elements.sessionSelect.value = state.sessionId;
  persistSessions();
}

function resetSelectedJob() {
  state.followVersion += 1;
  clearTimeout(state.pollTimer);
  state.selectedJob = null;
  state.interactive?.terminal.dispose();
  state.interactive?.observer?.disconnect();
  state.interactive?.clearResize();
  state.interactive = null;
  elements.interactiveTerminal.replaceChildren();
  elements.interactiveTerminal.hidden = true;
  elements.terminalScroll.hidden = false;
  elements.terminalInputForm.hidden = true;
  elements.outputModeButton.hidden = true;
  elements.jobDetails.hidden = true;
  setExecuting(false);
  clearTerminal();
}

async function selectSession(id) {
  const version = ++state.sessionVersion;
  try {
    const payload = await api(`/api/v1/sessions/${encodeURIComponent(id)}`);
    if (version !== state.sessionVersion) return;
    resetSelectedJob();
    adoptSession({ ...payload, sessionId: id });
    await loadJobs();
    const latest = state.jobs.find((job) => job.sessionId === id);
    if (latest) await selectJob(latest.jobId);
  } catch (error) {
    if (version !== state.sessionVersion) return;
    elements.sessionSelect.value = state.sessionId || "";
    if (error.status === 404) toast("此会话已失效，可从快照恢复或创建新会话。", "error");
    else toast(errorText(error), "error");
  }
}

function terminalRequest(jobId, action, body = {}) {
  return api(`/api/v1/jobs/${encodeURIComponent(jobId)}/${action}`, { method: "POST", body: JSON.stringify(body) });
}

function fitTerminal() {
  const interactive = state.interactive;
  if (!interactive || !state.terminalVisible || !elements.interactiveTerminal.clientWidth) return;
  interactive.fit.fit();
}

function showTerminal(visible) {
  state.terminalVisible = visible;
  elements.interactiveTerminal.hidden = !visible;
  elements.terminalScroll.hidden = visible;
  elements.outputModeButton.textContent = visible ? "查看日志" : "查看终端";
  requestAnimationFrame(() => { fitTerminal(); if (visible) state.interactive?.terminal.focus(); });
}

function openInteractive(job) {
  if (!globalThis.Terminal || !globalThis.FitAddon) {
    toast("终端组件未加载，请刷新页面。日志仍可查看。", "error");
    return;
  }
  const screen = new globalThis.Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, fontFamily: '"Cascadia Code", Consolas, monospace', scrollback: 2000, theme: { background: "#0c0f14", foreground: "#edf1f6", cursor: "#56e39f" }, allowProposedApi: false });
  const fit = new globalThis.FitAddon.FitAddon();
  screen.loadAddon(fit);
  elements.interactiveTerminal.hidden = false;
  screen.open(elements.interactiveTerminal);
  let inputQueue = Promise.resolve();
  screen.onData((text) => {
    if (!activeJob(state.selectedJob) || state.selectedJob.jobId !== job.jobId) return;
    inputQueue = inputQueue.then(() => terminalRequest(job.jobId, "input", { dataBase64: textToBase64(text) })).catch((error) => toast(errorText(error), "error"));
  });
  let resizeTimer;
  screen.onResize(({ cols, rows }) => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (activeJob(state.selectedJob) && state.selectedJob.jobId === job.jobId) void terminalRequest(job.jobId, "resize", { columns: cols, rows }).catch((error) => toast(errorText(error), "error"));
    }, 150);
  });
  const observer = new ResizeObserver(() => fitTerminal());
  observer.observe(elements.interactiveTerminal);
  state.interactive = { terminal: screen, fit, observer, clearResize: () => clearTimeout(resizeTimer) };
  elements.terminalInputForm.hidden = false;
  elements.outputModeButton.hidden = false;
  showTerminal(true);
}

async function runCommand() {
  if (state.executing || state.submitting) return;
  state.submitting = true;
  setExecuting(state.executing);
  try {
    const { stream: _stream, ...body } = commandRequest();
    const timeout = elements.timeoutInput.value.trim();
    if (timeout && (!Number.isSafeInteger(Number(timeout)) || Number(timeout) < 1)) throw new Error("超时需要填写正整数毫秒。");
    const artifacts = elements.artifactPaths.value.split(/\r?\n/).map((path) => path.trim()).filter(Boolean);
    const sessionId = await ensureSession();
    const version = state.sessionVersion;
    elements.runButton.disabled = true;
    const payload = await api("/api/v1/jobs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ ...body, sessionId, ...(timeout ? { timeoutMs: Number(timeout) } : {}), ...(artifacts.length ? { artifacts } : {}), ...(elements.interactiveMode.checked ? { terminal: { columns: 100, rows: 24 } } : {}) }) });
    if (version === state.sessionVersion) await selectJob(payload.job?.jobId || payload.jobId);
    else { setExecuting(activeJob(state.selectedJob)); toast("任务已在原会话启动，可在全部会话历史中查看。"); }
    await loadJobs();
  } catch (error) {
    toast(errorText(error), "error");
  } finally {
    state.submitting = false;
    setExecuting(activeJob(state.selectedJob));
  }
}

function stepRequest(step) { return step.request || step; }
function jobInput(job) { return stepRequest(job.steps?.[0] || {}).input; }
function inputLabel(input) { return input?.kind === "text" ? input.raw : input?.argv?.join(" ") || ""; }

function renderJob(job) {
  const unchanged = state.selectedJob?.jobId === job.jobId && job.updatedAt !== undefined && state.selectedJob.updatedAt === job.updatedAt && state.selectedJob.status === job.status;
  state.selectedJob = job;
  setExecuting(activeJob(job));
  if (unchanged) return;
  elements.jobDetails.hidden = false;
  elements.jobTitle.textContent = job.label || job.taskId || "命令执行";
  elements.jobTitle.title = elements.jobTitle.textContent;
  elements.jobStatus.textContent = jobStatus(job.status);
  elements.jobStatus.dataset.status = job.status;
  elements.jobCaption.textContent = `${job.jobId} · 会话 ${job.sessionId} · ${new Date(job.createdAt).toLocaleString()}${job.truncated ? " · 日志达到归档容量上限，后续输出未保存" : ""}${job.error ? ` · ${job.error.message || job.error}` : ""}`;
  elements.executionTime.textContent = jobStatus(job.status);
  elements.jobSteps.replaceChildren();
  for (const [index, step] of (job.steps || []).entries()) {
    const row = createElement("div", "step-row");
    const command = inputLabel(stepRequest(step).input);
    const title = createElement("span", "step-copy", `${index + 1}. ${step.label || step.name || step.id || step.stepId || command || "命令"}`);
    title.title = command;
    const outcome = step.outcome?.command || step.outcome;
    row.append(title, createElement("span", "subtle", `${jobStatus(step.status)}${outcome?.exitCode !== undefined ? ` · exit ${outcome.exitCode}` : ""}`));
    if (stepRequest(step).input) {
      const load = createElement("button", "text-button", "载入命令");
      load.type = "button";
      load.addEventListener("click", () => loadHistoryCommand(step));
      row.append(load);
    }
    elements.jobSteps.append(row);
  }
  elements.jobArtifacts.replaceChildren();
  for (const artifact of job.artifacts || []) {
    const download = createElement("button", "artifact-button", `${artifact.name} · ${formatBytes(artifact.size)}`);
    download.type = "button";
    download.title = `下载 ${artifact.name}${artifact.sha256 ? `\nSHA256: ${artifact.sha256}` : ""}`;
    download.addEventListener("click", () => {
      download.disabled = true;
      void downloadArtifact(job.jobId, artifact).catch((error) => toast(errorText(error), "error")).finally(() => { download.disabled = false; });
    });
    elements.jobArtifacts.append(download);
  }
  const artifactErrors = Array.isArray(job.artifactErrors) ? job.artifactErrors : [];
  for (const failure of artifactErrors.slice(0, 64)) {
    const notice = createElement("div", "artifact-error");
    const path = String(failure.virtualPath || "未知文件").slice(0, 512);
    const code = String(failure.error?.code || "ARTIFACT_FAILED").slice(0, 128);
    const message = String(failure.error?.message || "无法归档文件").slice(0, 1024);
    notice.append(createElement("strong", "", `未归档：${path}`), createElement("span", "", `${code}: ${message}`));
    elements.jobArtifacts.append(notice);
  }
  if (artifactErrors.length > 64) elements.jobArtifacts.append(createElement("p", "subtle", `另有 ${artifactErrors.length - 64} 项归档错误未显示。`));
}

async function selectJob(id) {
  resetSelectedJob();
  const version = state.followVersion;
  const payload = await api(`/api/v1/jobs/${encodeURIComponent(id)}`);
  if (version !== state.followVersion) return;
  const job = payload.job;
  renderJob(job);
  const hasTerminal = Boolean(job.terminal || job.steps?.some((step) => stepRequest(step).terminal));
  if (hasTerminal) openInteractive(job);
  const cursor = new JobEventCursor();
  let failures = 0;
  async function consumePage(events) {
    const screen = state.interactive?.terminal;
    let pendingBytes = 0;
    let painted = Promise.resolve();
    for (const event of events) {
      if (version !== state.followVersion) return;
      cursor.consume([event], appendTerminal, (bytes) => {
        if (!screen) return;
        pendingBytes += bytes.length;
        painted = new Promise((resolve) => screen.write(bytes, resolve));
      });
      // Keep xterm's asynchronous parser queue bounded during long archived replays.
      if (pendingBytes >= 256 * 1024) { await painted; pendingBytes = 0; }
    }
    await painted;
  }
  async function poll() {
    if (version !== state.followVersion) return;
    try {
      const page = await api(`/api/v1/jobs/${encodeURIComponent(id)}/events?after=${cursor.sequence}&limit=256`);
      if (version !== state.followVersion) return;
      await consumePage(page.events);
      if (version !== state.followVersion) return;
      terminal.flush();
      if (page.hasMore) { state.pollTimer = setTimeout(() => void poll(), 0); return; }
      const current = (await api(`/api/v1/jobs/${encodeURIComponent(id)}`)).job;
      if (version !== state.followVersion) return;
      renderJob(current);
      failures = 0;
      if (activeJob(current)) state.pollTimer = setTimeout(() => void poll(), state.interactive ? 90 : 750);
      else {
        // Completion and its last output can occur between the event page and job query.
        const tail = await api(`/api/v1/jobs/${encodeURIComponent(id)}/events?after=${cursor.sequence}&limit=256`);
        if (version !== state.followVersion) return;
        await consumePage(tail.events);
        if (version !== state.followVersion) return;
        if (tail.hasMore) { state.pollTimer = setTimeout(() => void poll(), 0); return; }
        cursor.finish(appendTerminal);
        terminal.flush();
        await loadJobs();
        if (current.sessionId === state.sessionId) await refreshSession();
      }
    } catch (error) {
      if (version !== state.followVersion) return;
      failures += 1;
      elements.executionTime.textContent = error.status === 401 ? "等待授权" : "连接中断 · 正在续接";
      if (failures === 1) toast(errorText(error), "error");
      if (error.status !== 404) state.pollTimer = setTimeout(() => void poll(), Math.min(1000 * 2 ** Math.min(failures, 4), 15000));
      else setExecuting(false);
    }
  }
  void poll();
}

function loadHistoryCommand(step) {
  const request = stepRequest(step);
  const input = request.input;
  if (!input) return;
  setMode(input.kind);
  elements.commandInput.value = input.kind === "text" ? input.raw : JSON.stringify(input.argv, null, 2);
  if (request.cwd) elements.cwdInput.value = request.cwd;
  elements.interactiveMode.checked = Boolean(request.terminal);
  elements.timeoutInput.value = request.timeoutMs || "";
  elements.artifactPaths.value = "";
  navigate("console");
  elements.commandInput.focus();
  toast("已载入历史命令，可编辑后执行。");
}

async function loadJobs() {
  const sessionId = state.sessionId;
  const all = elements.allHistory.checked;
  const payload = await api(`/api/v1/jobs${all || !sessionId ? "" : `?sessionId=${encodeURIComponent(sessionId)}`}`);
  if (sessionId !== state.sessionId || all !== elements.allHistory.checked) return;
  state.jobs = [...(payload.jobs || [])].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  elements.jobList.replaceChildren();
  if (!state.jobs.length) elements.jobList.append(createElement("p", "list-empty", "此会话还没有任务。"));
  for (const job of state.jobs) {
    const row = createElement("div", `job-row${state.selectedJob?.jobId === job.jobId ? " selected" : ""}`);
    const copy = createElement("button", "job-open");
    copy.type = "button";
    copy.append(createElement("strong", "", job.label || inputLabel(jobInput(job)) || job.taskId || job.jobId), createElement("small", "", `${new Date(job.createdAt).toLocaleString()} · ${job.sessionId.slice(0, 12)}`));
    copy.title = "打开执行详情并续读输出";
    copy.addEventListener("click", () => void selectJob(job.jobId).catch((error) => toast(errorText(error), "error")));
    const status = createElement("span", "job-status", jobStatus(job.status));
    status.dataset.status = job.status;
    row.append(copy, status);
    if (jobInput(job)) {
      const load = createElement("button", "text-button", "载入");
      load.type = "button";
      load.addEventListener("click", () => loadHistoryCommand(job.steps[0]));
      row.append(load);
    }
    elements.jobList.append(row);
  }
}

function formatBytes(size = 0) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`; }
function downloadBlob(blob, name) {
  const link = createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function downloadArtifact(jobId, artifact) {
  const chunks = [];
  let offset = 0;
  for (;;) {
    const part = await api(`/api/v1/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifact.artifactId)}?offset=${offset}&limit=262144`);
    const bytes = bytesFromBase64(part.dataBase64);
    chunks.push(bytes);
    offset += bytes.length;
    if (part.eof) break;
    if (!bytes.length) throw new Error("产物下载没有前进，请重试。");
  }
  downloadBlob(new Blob(chunks, { type: "application/octet-stream" }), artifact.name);
  toast(`已下载 ${artifact.name}`);
}

async function explainCommand() {
  try {
    const body = commandRequest(false);
    await ensureSession();
    const payload = await api(`/api/v1/sessions/${encodeURIComponent(state.sessionId)}/explain`, { method: "POST", body: JSON.stringify(body) });
    const plan = payload.preview;
    if (state.interactive) showTerminal(false);
    clearTerminal();
    elements.routeChip.textContent = `${plan.commandKind} → ${plan.backend}`;
    elements.routeChip.hidden = false;
    appendTerminal(`[执行计划]\n`, "system");
    appendTerminal(`plan      ${plan.planId}\n`);
    appendTerminal(`route     ${plan.commandKind} → ${plan.backend}\n`);
    appendTerminal(`reason    ${plan.reason}\n`);
    appendTerminal(`program   ${plan.executable}\n`);
    appendTerminal(`argv      ${JSON.stringify(plan.argv)}\n`);
    appendTerminal(`cwd       ${plan.cwdVirtual} → ${plan.cwdHost}\n`);
    appendTerminal(`policy    ${plan.policyProfile} / ${plan.statePolicy}\n`);
    appendTerminal(`timeout   ${plan.timeoutMs} ms\n`);
    for (const limitation of plan.limitations || []) appendTerminal(`note      ${limitation}\n`, "terminal-muted");
    elements.executionTime.textContent = "仅预览";
  } catch (error) {
    toast(errorText(error), "error");
  }
}

async function loadCheckpoints() {
  const payload = await api("/api/v1/checkpoints");
  elements.checkpointList.replaceChildren();
  if (!payload.checkpoints?.length) elements.checkpointList.append(createElement("p", "list-empty", "尚未保存会话快照。"));
  for (const checkpoint of payload.checkpoints || []) {
    const row = createElement("div", "checkpoint-row");
    const copy = createElement("div", "checkpoint-copy");
    copy.append(createElement("strong", "", checkpoint.name || checkpoint.checkpointId.slice(0, 12)), createElement("small", "subtle", `${checkpoint.cwd} · ${new Date(checkpoint.createdAt).toLocaleString()} · ${(checkpoint.envKeys || []).length} 个环境变量`));
    const restore = createElement("button", "button secondary", "恢复为新会话");
    restore.type = "button";
    restore.addEventListener("click", async () => {
      restore.disabled = true;
      const version = ++state.sessionVersion;
      try {
        const session = await api(`/api/v1/checkpoints/${encodeURIComponent(checkpoint.checkpointId)}/restore`, { method: "POST", body: "{}" });
        if (version !== state.sessionVersion) { adoptSession(session, false); toast("快照已恢复，可从会话列表切换。"); return; }
        resetSelectedJob();
        adoptSession(session);
        await loadJobs();
        toast("快照已恢复为新会话。");
      } catch (error) { toast(errorText(error), "error"); }
      finally { restore.disabled = false; }
    });
    const remove = createElement("button", "text-button", "删除");
    remove.type = "button";
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api(`/api/v1/checkpoints/${encodeURIComponent(checkpoint.checkpointId)}`, { method: "DELETE" });
        await loadCheckpoints();
        toast("快照已删除。");
      } catch (error) { toast(errorText(error), "error"); remove.disabled = false; }
    });
    row.append(copy, restore, remove);
    elements.checkpointList.append(row);
  }
}

async function saveCheckpoint() {
  elements.saveCheckpointButton.disabled = true;
  try {
    await ensureSession();
    const envKeys = [...new Set(elements.checkpointEnvKeys.value.split(/[,\s]+/).filter(Boolean))];
    const name = elements.checkpointName.value.trim();
    await api(`/api/v1/sessions/${encodeURIComponent(state.sessionId)}/checkpoint`, { method: "POST", body: JSON.stringify({ ...(name ? { name } : {}), envKeys }) });
    await loadCheckpoints();
    toast("会话快照已保存，可在服务重启后恢复。");
  } catch (error) { toast(errorText(error), "error"); }
  finally { elements.saveCheckpointButton.disabled = false; }
}

async function forkSession() {
  elements.forkSessionButton.disabled = true;
  try {
    const sessionId = await ensureSession();
    const version = ++state.sessionVersion;
    const session = await api(`/api/v1/sessions/${encodeURIComponent(sessionId)}/fork`, { method: "POST", body: "{}" });
    if (version !== state.sessionVersion) { adoptSession(session, false); toast("已创建分叉，可从会话列表切换。"); return; }
    resetSelectedJob();
    adoptSession(session);
    await loadJobs();
    toast("已从当前目录和环境创建独立会话。");
  } catch (error) { toast(errorText(error), "error"); }
  finally { elements.forkSessionButton.disabled = false; }
}

let manifestDirty = false;
const exampleManifest = {
  schemaVersion: 1,
  tasks: [{
    id: "inspect",
    title: "检查项目文件",
    parameters: { target: { type: "string", default: "src", required: true } },
    steps: [{ id: "files", input: { kind: "argv", argv: ["rg", "--files", "${target}"] }, cwd: "/workspace", statePolicy: "isolated", timeoutMs: 60000 }],
    artifacts: [],
  }],
};

async function loadTasks(replaceEditor = false) {
  try {
    const payload = await api("/api/v1/tasks");
    state.tasks = payload.tasks || payload.manifest?.tasks || [];
    const selected = elements.taskSelect.value;
    elements.taskSelect.replaceChildren();
    const placeholder = createElement("option", "", state.tasks.length ? "选择项目任务" : "还没有任务，可载入右侧示例");
    placeholder.value = "";
    elements.taskSelect.append(placeholder);
    for (const task of state.tasks) {
      const option = createElement("option", "", task.title || task.id);
      option.value = task.id;
      elements.taskSelect.append(option);
    }
    if (state.tasks.some((task) => task.id === selected)) elements.taskSelect.value = selected;
    else if (state.tasks.length === 1) elements.taskSelect.value = state.tasks[0].id;
    renderTaskParameters();
    if (replaceEditor || !manifestDirty) {
      elements.taskManifest.value = JSON.stringify(payload.manifest || { schemaVersion: 1, tasks: state.tasks }, null, 2);
      manifestDirty = false;
    }
    elements.tasksLocation.textContent = payload.path || payload.manifestPath || "";
  } catch (error) { toast(errorText(error), "error"); }
}

function renderTaskParameters() {
  const task = state.tasks.find((candidate) => candidate.id === elements.taskSelect.value);
  elements.taskParameters.replaceChildren();
  elements.taskStepsPreview.replaceChildren();
  elements.runTaskButton.disabled = !task;
  elements.taskDescription.textContent = task?.description || "选择任务后填写参数，步骤将依次执行，失败时停止。";
  if (!task) return;
  for (const [name, definition] of Object.entries(task.parameters || {})) {
    const label = createElement("label", "form-field", `${name}${definition.required ? " *" : ""}`);
    const field = createElement(definition.type === "enum" ? "select" : "input");
    field.dataset.parameter = name;
    field.name = name;
    field.required = Boolean(definition.required);
    if (definition.type === "enum") {
      if (!definition.required && definition.default === undefined) field.append(createElement("option", "", ""));
      for (const value of definition.values || []) { const option = createElement("option", "", value); option.value = value; field.append(option); }
    }
    field.value = definition.default ?? "";
    label.append(field);
    if (definition.description) label.append(createElement("small", "subtle", definition.description));
    elements.taskParameters.append(label);
  }
  for (const [index, step] of (task.steps || []).entries()) {
    const row = createElement("div", "step-row");
    row.append(createElement("strong", "", `${index + 1}. ${step.title || step.id}`), createElement("code", "subtle", inputLabel(step.input)));
    elements.taskStepsPreview.append(row);
  }
}

async function runTask(event) {
  event.preventDefault();
  if (state.submitting) return;
  const task = state.tasks.find((candidate) => candidate.id === elements.taskSelect.value);
  if (!task) return;
  state.submitting = true;
  setExecuting(state.executing);
  elements.runTaskButton.disabled = true;
  try {
    const values = Object.create(null);
    elements.taskParameters.querySelectorAll("[data-parameter]").forEach((field) => { values[field.dataset.parameter] = field.value; });
    const parameters = taskParameters(task, values);
    const sessionId = await ensureSession();
    const version = state.sessionVersion;
    const payload = await api("/api/v1/jobs", { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: JSON.stringify({ sessionId, taskId: task.id, parameters }) });
    if (version === state.sessionVersion) { navigate("console"); await selectJob(payload.job?.jobId || payload.jobId); }
    else toast("任务已在原会话启动，可在全部会话历史中查看。");
    await loadJobs();
  } catch (error) { toast(errorText(error), "error"); }
  finally { state.submitting = false; setExecuting(activeJob(state.selectedJob)); elements.runTaskButton.disabled = false; }
}

async function saveTasks() {
  elements.saveTasksButton.disabled = true;
  elements.taskManifestError.textContent = "";
  try {
    let manifest;
    try { manifest = JSON.parse(elements.taskManifest.value); }
    catch { throw new Error("任务清单不是有效 JSON，请检查引号、逗号与括号。"); }
    if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.tasks)) throw new Error("任务清单需要 schemaVersion: 1 和 tasks 数组。");
    await api("/api/v1/tasks", { method: "POST", body: JSON.stringify(manifest) });
    await loadTasks(true);
    toast("项目任务清单已保存。");
  } catch (error) { elements.taskManifestError.textContent = errorText(error); }
  finally { elements.saveTasksButton.disabled = false; }
}

async function exportDiagnostics(jobId) {
  try {
    const report = await api(`/api/v1/diagnostics${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`);
    downloadBlob(new Blob([JSON.stringify(report, null, 2), "\n"], { type: "application/json" }), `posixloom-diagnostics${jobId ? `-${jobId}` : ""}.json`);
    toast("已导出脱敏排障报告。");
  } catch (error) { toast(errorText(error), "error"); }
}

function metricCard(icon, label, value, detail) {
  const card = createElement("article", "metric-card");
  card.append(createElement("div", "metric-icon", icon));
  card.append(createElement("small", "", label));
  const strong = createElement("strong", "", value || "—");
  strong.title = value || "";
  card.append(strong, createElement("span", "", detail || ""));
  return card;
}

async function loadRuntime() {
  elements.refreshRuntimeButton.disabled = true;
  try {
    const [runtimePayload, doctorPayload] = await Promise.all([api("/api/v1/runtime"), api("/api/v1/runtime/doctor")]);
    const runtime = runtimePayload.runtime;
    const report = doctorPayload.report;
    elements.runtimeMetrics.replaceChildren(
      metricCard("RT", "Runtime", runtime.runtimeSemver, `${runtime.runtimeId} · ${runtime.mode}`),
      metricCard("SN", "Snapshot", runtime.snapshotId.slice(0, 12), runtime.source),
      metricCard("PL", "Policy", runtime.policyProfile, runtime.recoveryRequired ? "需要恢复" : "完整性就绪"),
      metricCard("BE", "Backends", runtime.bash ? "Native + Bash" : "Native", `${runtime.nativeCommands.length} native commands`),
    );
    elements.mountTable.replaceChildren();
    for (const mount of runtime.mounts) {
      const row = document.createElement("tr");
      row.append(createElement("td", "", mount.virtualPath), createElement("td", "", mount.hostPath));
      elements.mountTable.append(row);
    }
    elements.healthSummary.textContent = report.ok ? "全部通过" : "需要处理";
    elements.healthSummary.classList.toggle("fail", !report.ok);
    elements.doctorChecks.replaceChildren();
    for (const check of report.checks) {
      const item = createElement("div", "check-item");
      const level = String(check.level || "OK").toLocaleLowerCase();
      item.append(createElement("span", `check-dot ${level === "ok" ? "" : level}`));
      const copy = createElement("div");
      copy.append(createElement("strong", "", check.id), createElement("span", "", check.message));
      item.append(copy);
      elements.doctorChecks.append(item);
    }
  } catch (error) {
    toast(errorText(error), "error");
  } finally {
    elements.refreshRuntimeButton.disabled = false;
  }
}

function commandLabel(command) {
  if (command.input.kind === "text") return command.input.raw;
  return command.input.argv.join(" ");
}

function usePluginCommand(command) {
  setMode(command.input.kind);
  elements.commandInput.value = command.input.kind === "text" ? command.input.raw : JSON.stringify(command.input.argv, null, 2);
  if (command.cwd) elements.cwdInput.value = command.cwd;
  navigate("console");
  elements.commandInput.focus();
  toast(`已载入“${command.title}”，确认后再执行。`);
}

function renderPlugins() {
  const visible = state.plugins.filter((item) => {
    if (state.pluginFilter === "installed") return Boolean(item.installedVersion);
    if (state.pluginFilter === "updates") return item.updateAvailable;
    return true;
  });
  elements.pluginGrid.replaceChildren();
  elements.pluginEmpty.hidden = visible.length > 0;
  elements.pluginCount.textContent = `${visible.length} 个插件`;
  const installedCount = state.plugins.filter((item) => item.installedVersion).length;
  elements.pluginBadge.textContent = String(installedCount);
  elements.pluginBadge.hidden = installedCount === 0;
  for (const item of visible) {
    const manifest = item.manifest;
    const installed = Boolean(item.installedVersion);
    const card = createElement("article", "plugin-card");
    const top = createElement("div", "plugin-top");
    top.append(createElement("div", "plugin-symbol", manifest.name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toLocaleUpperCase()));
    if (installed) top.append(createElement("span", `installed-mark ${item.updateAvailable ? "update" : ""}`, item.updateAvailable ? "可更新" : "已安装"));
    card.append(top, createElement("h2", "", manifest.name), createElement("div", "plugin-byline", `${manifest.author} · ${manifest.category}`));
    card.append(createElement("p", "plugin-description", manifest.description));
    const tags = createElement("div", "tag-row");
    for (const tag of manifest.tags.slice(0, 4)) tags.append(createElement("span", "tag", tag));
    card.append(tags);
    const commands = createElement("div", "command-list");
    for (const command of manifest.commands.slice(0, 3)) {
      const row = createElement("div", "command-row");
      const label = createElement("span", "", commandLabel(command));
      label.title = command.description;
      const use = createElement("button", "use-button", "载入");
      use.type = "button";
      use.disabled = !installed;
      use.title = installed ? command.description : "安装后可载入";
      use.addEventListener("click", () => usePluginCommand(command));
      row.append(label, use);
      commands.append(row);
    }
    card.append(commands);
    const footer = createElement("div", "plugin-footer");
    footer.append(createElement("span", "plugin-version", `v${manifest.version} · ${manifest.commands.length} commands`));
    const action = createElement("button", `button ${installed && !item.updateAvailable ? "secondary" : "primary"}`, installed ? (item.updateAvailable ? "更新" : "卸载") : "安装");
    action.type = "button";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try {
        if (installed && !item.updateAvailable) {
          await api(`/api/v1/plugins/${encodeURIComponent(manifest.id)}`, { method: "DELETE" });
          toast(`已卸载 ${manifest.name}`);
        } else {
          await api(`/api/v1/plugins/${encodeURIComponent(manifest.id)}`, { method: "POST" });
          toast(`${item.updateAvailable ? "已更新" : "已安装"} ${manifest.name}`);
        }
        await loadPlugins(true);
      } catch (error) {
        toast(errorText(error), "error");
        action.disabled = false;
      }
    });
    footer.append(action);
    card.append(footer);
    elements.pluginGrid.append(card);
  }
}

let pluginRequest = 0;
async function loadPlugins(force = false) {
  if (!state.capabilities.includes("plugins")) {
    elements.pluginGrid.replaceChildren();
    elements.pluginEmpty.hidden = false;
    elements.pluginEmpty.querySelector("strong").textContent = "插件市场未启用";
    elements.pluginEmpty.querySelector("span").textContent = "以插件端口启动 HTTP 服务后即可使用。";
    elements.pluginCount.textContent = "不可用";
    return;
  }
  if (state.plugins.length && !force && !elements.pluginSearch.value.trim()) { renderPlugins(); return; }
  const current = ++pluginRequest;
  try {
    const query = elements.pluginSearch.value.trim();
    const payload = await api(`/api/v1/plugins/catalog${query ? `?q=${encodeURIComponent(query)}` : ""}`);
    if (current !== pluginRequest) return;
    state.plugins = payload.plugins;
    renderPlugins();
  } catch (error) {
    if (current !== pluginRequest) return;
    elements.pluginCount.textContent = "载入失败";
    toast(errorText(error), "error");
  }
}

async function synchronizeSessions() {
  const version = ++state.sessionVersion;
  const payload = await api("/api/v1/sessions");
  if (version !== state.sessionVersion) return false;
  const sessions = (payload.sessions || []).filter((session) => typeof session.sessionId === "string" && typeof session.state?.cwd === "string");
  const selected = sessions.find((session) => session.sessionId === state.sessionId) || sessions[0];
  state.sessions = sessions.slice(-100).map((session) => ({ sessionId: session.sessionId, cwd: session.state.cwd }));
  if (selected?.sessionId !== state.sessionId) resetSelectedJob();
  if (selected) adoptSession(selected);
  else {
    state.sessionId = null;
    elements.sessionSelect.replaceChildren();
    elements.sessionLabel.textContent = "正在创建";
    persistSessions();
    const created = await ensureSession();
    if (state.sessionId !== created) return false;
  }
  return true;
}

async function connect() {
  const sessionVersion = state.sessionVersion;
  setConnection("", "正在连接");
  try {
    const capabilities = await api("/api/v1/capabilities");
    state.capabilities = capabilities.capabilities || [];
    if (elements.authDialog.open) elements.authDialog.close();
    elements.authError.textContent = "";
    if (sessionVersion !== state.sessionVersion) return;
    if (!await synchronizeSessions()) return;
    const version = state.sessionVersion;
    await Promise.all([loadRuntime(), loadJobs(), loadCheckpoints(), loadTasks()]);
    if (version !== state.sessionVersion) return;
    const latest = state.jobs.find((job) => job.sessionId === state.sessionId);
    if (latest) await selectJob(latest.jobId);
    if (state.capabilities.includes("plugins")) await loadPlugins(true);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      setConnection("offline", "连接失败");
      toast(errorText(error), "error");
    }
  }
}

function bindEvents() {
  document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
    state.pluginFilter = button.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    renderPlugins();
  }));
  elements.runButton.addEventListener("click", () => void runCommand());
  elements.explainButton.addEventListener("click", () => void explainCommand());
  elements.cancelButton.addEventListener("click", () => {
    if (!state.selectedJob) return;
    elements.cancelButton.disabled = true;
    void terminalRequest(state.selectedJob.jobId, "cancel").then(() => toast("已请求停止任务。")).catch((error) => toast(errorText(error), "error")).finally(() => { elements.cancelButton.disabled = false; });
  });
  elements.clearButton.addEventListener("click", clearTerminal);
  elements.newSessionButton.addEventListener("click", () => void ensureSession(true).then(() => toast("已创建新会话")).catch((error) => toast(errorText(error), "error")));
  elements.sessionSelect.addEventListener("change", () => void selectSession(elements.sessionSelect.value));
  elements.saveCheckpointButton.addEventListener("click", () => void saveCheckpoint());
  elements.forkSessionButton.addEventListener("click", () => void forkSession());
  elements.refreshHistoryButton.addEventListener("click", () => void loadJobs().catch((error) => toast(errorText(error), "error")));
  elements.allHistory.addEventListener("change", () => void loadJobs().catch((error) => toast(errorText(error), "error")));
  elements.refreshTasksButton.addEventListener("click", () => void loadTasks());
  elements.taskSelect.addEventListener("change", renderTaskParameters);
  elements.taskRunForm.addEventListener("submit", (event) => void runTask(event));
  elements.taskManifest.addEventListener("input", () => { manifestDirty = true; });
  elements.taskExampleButton.addEventListener("click", () => { elements.taskManifest.value = JSON.stringify(exampleManifest, null, 2); manifestDirty = true; elements.taskManifestError.textContent = ""; });
  elements.saveTasksButton.addEventListener("click", () => void saveTasks());
  elements.diagnosticsButton.addEventListener("click", () => void exportDiagnostics());
  elements.jobDiagnosticsButton.addEventListener("click", () => void exportDiagnostics(state.selectedJob?.jobId));
  elements.outputModeButton.addEventListener("click", () => showTerminal(!state.terminalVisible));
  elements.terminalInputForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!activeJob(state.selectedJob)) return;
    const text = elements.terminalInput.value;
    void terminalRequest(state.selectedJob.jobId, "input", { dataBase64: textToBase64(`${text}\r`) }).then(() => { elements.terminalInput.value = ""; }).catch((error) => toast(errorText(error), "error"));
  });
  elements.terminalEofButton.addEventListener("click", () => {
    if (activeJob(state.selectedJob)) void terminalRequest(state.selectedJob.jobId, "eof").catch((error) => toast(errorText(error), "error"));
  });
  elements.terminalInterruptButton.addEventListener("click", () => {
    if (activeJob(state.selectedJob)) void terminalRequest(state.selectedJob.jobId, "input", { dataBase64: "Aw==" }).catch((error) => toast(errorText(error), "error"));
  });
  elements.refreshRuntimeButton.addEventListener("click", () => void loadRuntime());
  elements.commandInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void runCommand(); }
  });
  elements.connectionButton.addEventListener("click", () => requestToken("可更新当前标签页使用的访问令牌。"));
  elements.mobileNavButton.addEventListener("click", () => {
    const open = elements.sidebar.classList.toggle("open");
    elements.mobileNavButton.setAttribute("aria-expanded", String(open));
  });
  elements.authForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const token = elements.tokenInput.value;
    if (token && new TextEncoder().encode(token).length < 16) {
      elements.authError.textContent = "令牌至少需要 16 字节。";
      return;
    }
    state.token = token;
    try {
      if (token) sessionStorage.setItem(storageKey(state.apiBaseUrl, "token"), token);
      else sessionStorage.removeItem(storageKey(state.apiBaseUrl, "token"));
    } catch { /* Keep credentials in memory when browser storage is disabled. */ }
    elements.authDialog.close();
    void connect();
  });
  let searchTimer;
  elements.pluginSearch.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadPlugins(true), 220);
  });
  window.addEventListener("hashchange", () => {
    const view = location.hash.slice(1);
    if (["console", "tasks", "runtime", "plugins"].includes(view)) navigate(view);
  });
}

async function main() {
  bindEvents();
  const configuration = await fetch("/config.json", { cache: "no-store" }).then((response) => response.json());
  state.apiBaseUrl = configuration.apiBaseUrl.replace(/\/$/, "");
  const saved = readSessionState(sessionStorage, state.apiBaseUrl);
  state.sessions = saved.sessions;
  state.sessionId = saved.selected;
  try { state.token = sessionStorage.getItem(storageKey(state.apiBaseUrl, "token")) || ""; } catch { /* Memory-only authentication remains available. */ }
  elements.apiAddress.textContent = state.apiBaseUrl;
  elements.apiAddress.title = state.apiBaseUrl;
  const initialView = location.hash.slice(1);
  navigate(["console", "tasks", "runtime", "plugins"].includes(initialView) ? initialView : "console");
  await connect();
}

void main().catch((error) => {
  setConnection("offline", "初始化失败");
  toast(errorText(error), "error");
});
