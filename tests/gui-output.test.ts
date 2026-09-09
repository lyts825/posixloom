import assert from "node:assert/strict";
import test from "node:test";

// The same dependency-free ES module is served to the browser by the GUI.
const { TerminalBuffer, NdjsonDecoder, consumeNdjson, bytesFromBase64, createTerminalView } = await import(new URL("../src/gui/public/console-output.js", import.meta.url).href);
const encoder = new TextEncoder();

test("GUI display remains bounded through 64 MiB before painting and preserves the latest text", () => {
  const buffer = new TerminalBuffer();
  const chunk = "x".repeat(64 * 1024);
  for (let index = 0; index < 1024; index += 1) buffer.append(chunk, index % 2 ? "stderr" : "");
  buffer.append("\n最后一行 😀\n", "success");
  assert.ok(buffer.bytes <= 1024 * 1024);
  assert.ok(buffer.entries.length <= 256);
  const retained = buffer.entries.map((entry: { text: string }) => entry.text).join("");
  assert.ok(retained.endsWith("\n最后一行 😀\n"));
  assert.equal(buffer.bytes, encoder.encode(retained).length);
  assert.equal(buffer.bytes + buffer.droppedBytes, 64 * 1024 * 1024 + encoder.encode("\n最后一行 😀\n").length);
});

test("GUI display enforces node and UTF-8 byte limits independently without splitting characters", () => {
  const buffer = new TerminalBuffer({ maxBytes: 31, maxNodes: 3 });
  for (let index = 0; index < 100; index += 1) buffer.append("汉😀", index % 2 ? "stderr" : "");
  const retained = buffer.entries.map((entry: { text: string }) => entry.text).join("");
  assert.equal(retained, "汉😀".repeat(3));
  assert.equal(buffer.bytes, 21);
  assert.equal(buffer.droppedBytes, 679);
  buffer.clear();
  assert.equal(buffer.entries.length, 0);
  assert.equal(buffer.bytes + buffer.droppedBytes, 0);
  const tiny = new TerminalBuffer({ maxBytes: 4 });
  tiny.append("汉字😀");
  assert.equal(tiny.entries.map((entry: { text: string }) => entry.text).join(""), "😀");
  const shortLines = new TerminalBuffer();
  shortLines.append("short\n".repeat(100_000));
  assert.ok(shortLines.lines <= 2000);
  assert.ok(shortLines.bytes < shortLines.maxBytes);
  assert.ok(shortLines.entries.map((entry: { text: string }) => entry.text).join("").endsWith("short\n"));
});

test("GUI NDJSON decoder handles one-byte Unicode fragments, multiple lines and final newline omission", () => {
  const decoder = new NdjsonDecoder(100);
  const expected = [{ text: "汉😀" }, { text: "tail" }];
  const values = [];
  for (const byte of encoder.encode(`${JSON.stringify(expected[0])}\r\n\n${JSON.stringify(expected[1])}`)) values.push(...decoder.push(Uint8Array.of(byte)));
  values.push(decoder.finish());
  assert.deepEqual(values, expected);
  const many = new NdjsonDecoder(16);
  assert.equal([...many.push(encoder.encode("{\"n\":1}\n".repeat(1000)))].length, 1000);
});

test("GUI NDJSON decoder rejects an unbounded line before allocating beyond its byte limit", () => {
  const decoder = new NdjsonDecoder(128);
  for (let index = 0; index < 128; index += 1) [...decoder.push(Uint8Array.of(32))];
  assert.equal(decoder.length, 128);
  assert.throws(() => [...decoder.push(Uint8Array.of(32))], { code: "STREAM_FRAME_TOO_LARGE" });
  assert.ok(decoder.pending.length <= 128);
  assert.throws(() => [...new NdjsonDecoder().push(Uint8Array.of(0xff, 10))], TypeError);
});

test("GUI stream cancels its reader on malformed, overlarge and handler-rejected events", async () => {
  for (const scenario of ["json", "limit", "handler"] as const) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(encoder.encode(scenario === "json" ? "!\n" : scenario === "limit" ? "x".repeat(129) : "{}\n")); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(consumeNdjson(body, () => { if (scenario === "handler") throw new Error("rejected event"); }, { maxFrameBytes: 128 }));
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test("GUI stream yields during batched input and releases successfully completed readers", async () => {
  let cancelled = false;
  let yielded = 0;
  let events = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(encoder.encode("{}\n".repeat(130))); controller.close(); },
    cancel() { cancelled = true; },
  });
  await consumeNdjson(body, () => { events += 1; }, { yieldControl: async () => { yielded += 1; } });
  assert.equal(events, 130);
  assert.equal(yielded, 2);
  assert.equal(cancelled, false);
  assert.equal(body.locked, false);
  assert.deepEqual(bytesFromBase64("AP+A"), Uint8Array.of(0, 255, 128));
  assert.equal(bytesFromBase64(Buffer.alloc(1024 * 1024).toString("base64")).length, 1024 * 1024);
  assert.throws(() => bytesFromBase64("invalid"), { code: "STREAM_OUTPUT_INVALID" });
});

// Minimal DOM geometry makes frame scheduling/scroll decisions deterministic; the live GUI
// is also checked in a browser, where wrapping and actual pixel geometry are available.
class DisplayNode {
  children: DisplayNode[] = [];
  parent?: DisplayNode;
  textContent = "";
  className = "";
  hidden = false;
  scrollTop = 0;
  clientHeight = 50;
  ownerDocument: { createElement: () => DisplayNode; createDocumentFragment: () => DisplayNode };
  listeners = new Map<string, () => void>();
  constructor(readonly fragment = false) {
    this.ownerDocument = { createElement: () => new DisplayNode(), createDocumentFragment: () => new DisplayNode(true) };
  }
  get scrollHeight(): number { return this.children.reduce((sum, child) => sum + child.textContent.length * 10, 0); }
  append(node: DisplayNode): void {
    if (node.fragment) { for (const child of [...node.children]) this.append(child); return; }
    node.parent = this;
    this.children.push(node);
  }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  replaceChildren(): void { this.children = []; }
  addEventListener(type: string, action: () => void): void { this.listeners.set(type, action); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  getBoundingClientRect(): { top: number; bottom: number } {
    const prior = this.parent?.children.slice(0, this.parent.children.indexOf(this)) ?? [];
    const top = prior.reduce((sum, child) => sum + child.textContent.length * 10, 0) - (this.parent?.scrollTop ?? 0);
    return { top, bottom: top + this.textContent.length * 10 };
  }
}

test("GUI renderer batches output, leaves history scroll alone and cancels pending work on clear", () => {
  const output = new DisplayNode(), notice = new DisplayNode(), latest = new DisplayNode();
  const scheduled = new Map<number, () => void>();
  let nextId = 0;
  const view = createTerminalView({ output, scroll: output, notice, latest, maxNodes: 3, schedule: (action: () => void) => { scheduled.set(++nextId, action); return nextId; }, unschedule: (id: number) => scheduled.delete(id) });
  for (let index = 0; index < 100; index += 1) view.append("line\n");
  assert.equal(output.children.length, 0);
  assert.equal(scheduled.size, 1);
  view.flush();
  assert.equal(output.children.length, 1);
  assert.equal(output.scrollTop, output.scrollHeight);
  output.scrollTop = 100;
  output.listeners.get("scroll")!();
  view.append("more\n", "stderr");
  view.flush();
  assert.equal(output.scrollTop, 100);
  assert.equal(latest.hidden, false);
  latest.listeners.get("click")!();
  assert.equal(output.scrollTop, output.scrollHeight);
  view.append("pending");
  view.clear();
  assert.equal(scheduled.size, 0);
  assert.equal(output.children.length, 0);
  assert.equal(notice.hidden, true);
  assert.equal(latest.hidden, true);
  view.dispose();
  assert.equal(output.listeners.size + latest.listeners.size, 0);
});
