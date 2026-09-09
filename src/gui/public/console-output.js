/** Bounded display history and framed HTTP decoding, shared by the GUI and module tests. */
const encoder = new TextEncoder();
export const TERMINAL_MAX_BYTES = 1024 * 1024;
export const TERMINAL_MAX_NODES = 256;
export const TERMINAL_MAX_LINES = 2000;
// A completed event includes two Base64 output receipts (8 MiB each by default).
export const STREAM_MAX_FRAME_BYTES = 32 * 1024 * 1024;

export class ConsoleStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConsoleStreamError";
    this.code = code;
  }
}

export class TerminalBuffer {
  constructor({ maxBytes = TERMINAL_MAX_BYTES, maxNodes = TERMINAL_MAX_NODES, maxLines = TERMINAL_MAX_LINES } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || !Number.isSafeInteger(maxNodes) || maxNodes < 1 || !Number.isSafeInteger(maxLines) || maxLines < 1) throw new RangeError("Invalid terminal limits");
    this.maxBytes = maxBytes;
    this.maxNodes = maxNodes;
    this.maxLines = maxLines;
    this.nextId = 0;
    this.clear();
  }

  clear() {
    this.entries = [];
    this.bytes = 0;
    this.droppedBytes = 0;
    this.lines = 0;
  }

  append(text, className = "") {
    // Split at Unicode boundaries; each rendered node stays small even for one huge line.
    const chunkUnits = Math.max(1, Math.min(4096, this.maxLines, Math.floor(this.maxBytes / 3)));
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + chunkUnits, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
      if (end === start) end = start + 2;
      const chunk = text.slice(start, end);
      const bytes = encoder.encode(chunk).length;
      let lines = 0;
      for (let index = 0; index < chunk.length; index += 1) if (chunk.charCodeAt(index) === 10) lines += 1;
      const tail = this.entries.at(-1);
      if (tail && tail.className === className && tail.text.length + chunk.length <= chunkUnits && tail.bytes + bytes <= this.maxBytes) {
        tail.text += chunk;
        tail.bytes += bytes;
        tail.lines += lines;
      } else {
        this.entries.push({ id: this.nextId++, text: chunk, className, bytes, lines });
      }
      this.bytes += bytes;
      this.lines += lines;
      while (this.bytes > this.maxBytes || this.entries.length > this.maxNodes || this.lines > this.maxLines) {
        const removed = this.entries.shift();
        this.bytes -= removed.bytes;
        this.lines -= removed.lines;
        this.droppedBytes += removed.bytes;
      }
      start = end;
    }
  }
}

export function createTerminalView({ output, scroll, notice, latest, schedule = requestAnimationFrame, unschedule = cancelAnimationFrame, ...limits }) {
  const buffer = new TerminalBuffer(limits);
  const nodes = new Map();
  let frame;
  let following = true;
  const atBottom = () => scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= 32;
  const updateLatest = () => { latest.hidden = following; };
  const onScroll = () => { following = atBottom(); updateLatest(); };
  const flush = () => {
    if (frame !== undefined) unschedule(frame);
    frame = undefined;
    // Consult the current viewport: the user may have scrolled since append().
    following = following && atBottom();
    const ids = new Set(buffer.entries.map((entry) => entry.id));
    const pruning = [...nodes.keys()].some((id) => !ids.has(id));
    let anchor;
    let anchorTop;
    if (!following && pruning) {
      const top = scroll.getBoundingClientRect().top;
      anchor = [...nodes].find(([id, node]) => ids.has(id) && node.getBoundingClientRect().bottom > top)?.[1];
      if (anchor) anchorTop = anchor.getBoundingClientRect().top;
    }
    for (const [id, node] of nodes) {
      if (!ids.has(id)) { node.remove(); nodes.delete(id); }
    }
    const fragment = output.ownerDocument.createDocumentFragment();
    for (const entry of buffer.entries) {
      let node = nodes.get(entry.id);
      if (!node) {
        node = output.ownerDocument.createElement("span");
        node.className = entry.className;
        nodes.set(entry.id, node);
        fragment.append(node);
      }
      if (node.textContent !== entry.text) node.textContent = entry.text;
    }
    output.append(fragment);
    notice.hidden = buffer.droppedBytes === 0;
    notice.textContent = buffer.droppedBytes ? `较早输出已省略（${Math.ceil(buffer.droppedBytes / 1024)} KiB），仅保留最近输出。` : "";
    if (following) scroll.scrollTop = scroll.scrollHeight;
    else if (pruning) scroll.scrollTop = anchor ? Math.max(0, scroll.scrollTop + anchor.getBoundingClientRect().top - anchorTop) : 0;
    updateLatest();
  };
  const jumpToLatest = () => {
    following = true;
    scroll.scrollTop = scroll.scrollHeight;
    updateLatest();
  };
  scroll.addEventListener("scroll", onScroll, { passive: true });
  latest.addEventListener("click", jumpToLatest);
  return {
    buffer,
    append(text, className = "") {
      if (!text) return;
      buffer.append(text, className);
      if (frame === undefined) frame = schedule(flush);
    },
    flush,
    clear() {
      if (frame !== undefined) unschedule(frame);
      frame = undefined;
      buffer.clear();
      nodes.clear();
      output.replaceChildren();
      notice.hidden = true;
      notice.textContent = "";
      following = true;
      scroll.scrollTop = 0;
      updateLatest();
    },
    dispose() {
      if (frame !== undefined) unschedule(frame);
      scroll.removeEventListener("scroll", onScroll);
      latest.removeEventListener("click", jumpToLatest);
    },
  };
}

/** Accumulate bytes with geometric growth; incomplete lines never grow past the frame limit. */
export class NdjsonDecoder {
  constructor(maxFrameBytes = STREAM_MAX_FRAME_BYTES) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) throw new RangeError("Invalid stream frame limit");
    this.maximum = maxFrameBytes;
    this.pending = new Uint8Array(Math.min(64 * 1024, maxFrameBytes));
    this.length = 0;
    this.decoder = new TextDecoder("utf-8", { fatal: true });
  }

  append(bytes) {
    const required = this.length + bytes.length;
    if (required > this.maximum) throw new ConsoleStreamError("STREAM_FRAME_TOO_LARGE", "执行流单条消息超过浏览器容量限制。");
    if (required > this.pending.length) {
      const grown = new Uint8Array(Math.min(this.maximum, Math.max(required, this.pending.length * 2)));
      grown.set(this.pending.subarray(0, this.length));
      this.pending = grown;
    }
    this.pending.set(bytes, this.length);
    this.length = required;
  }

  take() {
    const text = this.decoder.decode(this.pending.subarray(0, this.length));
    this.length = 0;
    return text.trim() ? JSON.parse(text) : undefined;
  }

  *push(bytes) {
    let start = 0;
    for (;;) {
      const newline = bytes.indexOf(10, start);
      if (newline < 0) { this.append(bytes.subarray(start)); return; }
      this.append(bytes.subarray(start, newline));
      const event = this.take();
      if (event !== undefined) yield event;
      start = newline + 1;
    }
  }

  finish() { return this.length ? this.take() : undefined; }
}

export async function consumeNdjson(body, consume, { maxFrameBytes = STREAM_MAX_FRAME_BYTES, yieldControl = () => new Promise((resolve) => setTimeout(resolve, 0)) } = {}) {
  const reader = body.getReader();
  const decoder = new NdjsonDecoder(maxFrameBytes);
  let complete = false;
  let events = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const event of decoder.push(value)) {
        consume(event);
        // A large network read must still yield to painting and the Stop button.
        if (++events % 64 === 0) await yieldControl();
      }
    }
    const last = decoder.finish();
    if (last !== undefined) consume(last);
    complete = true;
  } finally {
    // Do not wait indefinitely for a broken remote producer to acknowledge cancellation.
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function bytesFromBase64(value) {
  if (typeof value !== "string" || value.length > 2 * 1024 * 1024 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new ConsoleStreamError("STREAM_OUTPUT_INVALID", "执行流包含无效或过大的输出块。");
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
