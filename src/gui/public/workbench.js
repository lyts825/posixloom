/** Browser-independent state and output replay for the persistent task workbench. */
import { bytesFromBase64 } from "./console-output.js";

export const activeJob = (job) => job?.status === "queued" || job?.status === "running";
export const jobStatus = (status) => ({ queued: "排队中", running: "运行中", completed: "已完成", failed: "失败", cancelled: "已取消", interrupted: "服务重启中断", skipped: "已跳过", pending: "待执行" })[status] || status || "—";

export function storageKey(apiBaseUrl, kind = "sessions") {
  return `posixloom:${new URL(apiBaseUrl).origin}:${kind}`;
}

export function readSessionState(storage, apiBaseUrl) {
  try {
    const value = JSON.parse(storage.getItem(storageKey(apiBaseUrl)) || "{}");
    const sessions = Array.isArray(value.sessions) ? value.sessions.filter((item) => item && typeof item.sessionId === "string" && typeof item.cwd === "string").slice(-100) : [];
    return { sessions, selected: sessions.some((item) => item.sessionId === value.selected) ? value.selected : null };
  } catch { return { sessions: [], selected: null }; }
}

export function rememberSession(previous, session) {
  const entry = { sessionId: session.sessionId, cwd: session.state?.cwd || session.cwd || "/workspace" };
  return { sessions: [...previous.sessions.filter((item) => item.sessionId !== entry.sessionId), entry].slice(-100), selected: entry.sessionId };
}

export function taskParameters(task, entries) {
  const result = Object.create(null);
  for (const [name, definition] of Object.entries(task.parameters || {})) {
    const value = entries[name] ?? definition.default ?? "";
    if (definition.required && !String(value).trim()) throw new Error(`请填写参数 ${name}`);
    if (definition.type === "enum" && value !== "" && !definition.values?.includes(value)) throw new Error(`参数 ${name} 不在允许的选项中`);
    if (value !== "" || definition.required || definition.default !== undefined) result[name] = String(value);
  }
  return result;
}

export function textToBase64(value) {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Cursor advances only after the consumer accepts an event; replaying a page is safe. */
export class JobEventCursor {
  constructor() { this.sequence = -1; this.decoders = new Map(); }
  consume(events, append, writeBytes = () => {}) {
    if (!Array.isArray(events)) throw new Error("任务输出响应无效");
    for (const event of events) {
      if (!Number.isSafeInteger(event?.sequence) || event.sequence < 0) throw new Error("任务输出序号无效");
      if (event.sequence <= this.sequence) continue;
      if (event.type === "output") {
        if (!["stdout", "stderr"].includes(event.stream)) throw new Error("任务输出通道无效");
        const bytes = bytesFromBase64(event.dataBase64);
        const key = `${event.stepId || ""}:${event.stream}`;
        let decoder = this.decoders.get(key);
        if (!decoder) { decoder = new TextDecoder(); this.decoders.set(key, decoder); }
        const text = decoder.decode(bytes, { stream: true });
        append(text, event.stream === "stderr" ? "stderr" : "");
        writeBytes(bytes);
      }
      this.sequence = event.sequence;
    }
  }
  finish(append) {
    for (const [key, decoder] of this.decoders) append(decoder.decode(), key.endsWith(":stderr") ? "stderr" : "");
    this.decoders.clear();
  }
}
