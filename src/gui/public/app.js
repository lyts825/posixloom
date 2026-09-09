import { bytesFromBase64, consumeNdjson, createTerminalView } from "./console-output.js";

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

const terminal = createTerminalView({ output: elements.terminalOutput, scroll: elements.terminalScroll, notice: elements.terminalNotice, latest: elements.latestOutputButton });
terminal.clear();
terminal.append("PosixLoom 控制台已就绪。", "terminal-muted");

const state = {
  apiBaseUrl: "",
  capabilities: [],
  connected: false,
  controller: null,
  executing: false,
  mode: "text",
  pluginFilter: "all",
  plugins: [],
  sessionId: null,
  token: sessionStorage.getItem("posixloom-token") || "",
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
  elements.routeChip.hidden = true;
  elements.executionTime.textContent = "就绪";
}

function appendTerminal(text, className = "") {
  terminal.append(text, className);
}

function setExecuting(executing) {
  state.executing = executing;
  elements.runButton.disabled = executing;
  elements.explainButton.disabled = executing;
  elements.cancelButton.hidden = !executing;
  elements.newSessionButton.disabled = executing;
}

async function ensureSession(replace = false) {
  if (state.sessionId && !replace) return state.sessionId;
  const previous = state.sessionId;
  if (previous && replace) void api(`/api/v1/sessions/${encodeURIComponent(previous)}`, { method: "DELETE" }).catch(() => undefined);
  const payload = await api("/api/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ cwd: elements.cwdInput.value || "/workspace" }),
  });
  state.sessionId = payload.sessionId;
  elements.sessionLabel.textContent = payload.sessionId;
  elements.sessionLabel.title = payload.sessionId;
  elements.cwdInput.value = payload.state.cwd;
  return payload.sessionId;
}

async function refreshSession() {
  if (!state.sessionId) return;
  try {
    const payload = await api(`/api/v1/sessions/${encodeURIComponent(state.sessionId)}`);
    elements.cwdInput.value = payload.state.cwd;
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) await ensureSession(true);
  }
}

async function runCommand() {
  if (state.executing) return;
  let body;
  try {
    body = commandRequest(true);
    await ensureSession();
  } catch (error) {
    toast(errorText(error), "error");
    return;
  }
  clearTerminal();
  setExecuting(true);
  const started = performance.now();
  const controller = new AbortController();
  state.controller = controller;
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  try {
    const headers = new Headers({ accept: "application/x-ndjson", "content-type": "application/json" });
    if (state.token) headers.set("authorization", `Bearer ${state.token}`);
    const response = await fetch(`${state.apiBaseUrl}/api/v1/sessions/${encodeURIComponent(state.sessionId)}/execute`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch { /* response is not JSON */ }
      const remote = payload.error || {};
      if (response.status === 401) requestToken("令牌无效或已失效，请重新输入。");
      throw new ApiError(remote.code || `HTTP_${response.status}`, remote.message || response.statusText, response.status, remote.details || {});
    }
    if (!response.body) throw new ApiError("STREAM_UNAVAILABLE", "浏览器没有提供响应流。");
    setConnection("online", "已连接");
    let finalEvent;
    const consume = (event) => {
      if (!event || typeof event !== "object" || finalEvent) throw new ApiError("STREAM_INVALID", "执行流包含无效或重复的事件。");
      if (event.type === "started") {
        elements.routeChip.textContent = `${event.preview.commandKind} → ${event.preview.backend}`;
        elements.routeChip.hidden = false;
        appendTerminal(`$ ${elements.commandInput.value}\n`, "system");
      } else if (event.type === "output") {
        if (event.stream !== "stdout" && event.stream !== "stderr") throw new ApiError("STREAM_INVALID", "执行流包含未知的输出通道。");
        const decoder = event.stream === "stderr" ? stderrDecoder : stdoutDecoder;
        const text = decoder.decode(bytesFromBase64(event.dataBase64), { stream: true });
        appendTerminal(text, event.stream === "stderr" ? "stderr" : "");
      } else if (event.type === "completed") finalEvent = event;
      else if (event.type === "error") throw new ApiError(event.error.code, event.error.message, 0, event.error.details);
      else throw new ApiError("STREAM_INVALID", "执行流包含未知的事件。");
    };
    await consumeNdjson(response.body, consume);
    appendTerminal(stdoutDecoder.decode(), "");
    appendTerminal(stderrDecoder.decode(), "stderr");
    if (!finalEvent) throw new ApiError("STREAM_TRUNCATED", "执行流在完成事件之前结束。");
    const result = finalEvent.result;
    const outcome = result.command.kind === "exited" ? `exit ${result.command.exitCode}` : result.command.kind;
    appendTerminal(`\n[${outcome} · ${result.backend}${result.truncated ? " · output truncated" : ""}]\n`, result.command.kind === "exited" && result.command.exitCode === 0 ? "success" : "stderr");
    elements.executionTime.textContent = `${Math.round(performance.now() - started)} ms`;
    await refreshSession();
  } catch (error) {
    // Decoder/protocol failures must close the HTTP stream and cancel its process tree too.
    controller.abort();
    if (error?.name === "AbortError") {
      appendTerminal("\n[已请求停止执行]\n", "stderr");
      elements.executionTime.textContent = "已停止";
    } else {
      appendTerminal(`\n[${errorText(error)}]\n`, "stderr");
      elements.executionTime.textContent = "失败";
      toast(errorText(error), "error");
    }
  } finally {
    terminal.flush();
    state.controller = null;
    setExecuting(false);
  }
}

async function explainCommand() {
  try {
    const body = commandRequest(false);
    await ensureSession();
    const payload = await api(`/api/v1/sessions/${encodeURIComponent(state.sessionId)}/explain`, { method: "POST", body: JSON.stringify(body) });
    const plan = payload.preview;
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

async function connect() {
  setConnection("", "正在连接");
  try {
    const capabilities = await api("/api/v1/capabilities");
    state.capabilities = capabilities.capabilities || [];
    if (elements.authDialog.open) elements.authDialog.close();
    elements.authError.textContent = "";
    await Promise.all([ensureSession(), loadRuntime()]);
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
  elements.cancelButton.addEventListener("click", () => state.controller?.abort());
  elements.clearButton.addEventListener("click", clearTerminal);
  elements.newSessionButton.addEventListener("click", () => void ensureSession(true).then(() => toast("已创建新会话")).catch((error) => toast(errorText(error), "error")));
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
    if (token) sessionStorage.setItem("posixloom-token", token);
    else sessionStorage.removeItem("posixloom-token");
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
    if (["console", "runtime", "plugins"].includes(view)) navigate(view);
  });
}

async function main() {
  bindEvents();
  const configuration = await fetch("/config.json", { cache: "no-store" }).then((response) => response.json());
  state.apiBaseUrl = configuration.apiBaseUrl.replace(/\/$/, "");
  elements.apiAddress.textContent = state.apiBaseUrl;
  elements.apiAddress.title = state.apiBaseUrl;
  const initialView = location.hash.slice(1);
  navigate(["console", "runtime", "plugins"].includes(initialView) ? initialView : "console");
  await connect();
}

void main().catch((error) => {
  setConnection("offline", "初始化失败");
  toast(errorText(error), "error");
});
