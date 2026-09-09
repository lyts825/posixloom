import assert from "node:assert/strict";
import { spawn, type SpawnOptionsWithoutStdio } from "node:child_process";
import { NativeFrameDecoder, encodeNativeFrame } from "../../src/core/process.js";

/** Exercise the real transport from byte zero, including exact argv and clean shutdown. */
export async function assertControlChild(executable: string, args: string[], options: SpawnOptionsWithoutStdio): Promise<void> {
  const child = spawn(executable, args, { ...options, stdio: "pipe", windowsHide: true });
  const decoder = new NativeFrameDecoder();
  const expected = 'space 你好 "quote" ; $literal \\tail\\';
  let stderr = "";
  let phase = "hello";
  let failure: unknown;
  let receivedOutput = Buffer.alloc(0);
  const send = (request: Record<string, unknown>) => child.stdin.write(encodeNativeFrame({ protocolVersion: 1, ...request }));
  child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
  child.stdin.on("error", (error) => { failure ??= error; });
  const timer = setTimeout(() => {
    failure ??= new Error(`Control child timed out in ${phase}: ${stderr}`);
    child.stdin.end();
    child.kill();
  }, 20_000);
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.stdout.on("data", (data: Buffer) => {
        try {
          for (const value of decoder.push(data)) {
            const frame = value as any;
            assert.equal(frame.protocolVersion, 1);
            if (phase === "hello") {
              assert.equal(frame.type, "hello");
              assert.equal(frame.capabilities.includes("stream-output-v1"), true);
              phase = "session";
              send({ type: "session.create", id: "create" });
            } else if (phase === "session") {
              assert.equal(frame.type, "result", JSON.stringify(frame));
              assert.equal(frame.id, "create");
              assert.equal(typeof frame.result.sessionId, "string");
              phase = "execute";
              send({ type: "execute", id: "execute", sessionId: frame.result.sessionId, stream: true, statePolicy: "isolated", input: { kind: "argv", argv: ["node", "-p", "process.argv.at(1)", expected] } });
            } else if (phase === "execute") {
              assert.equal(frame.id, "execute");
              if (frame.type === "event") {
                if (frame.event === "output" && frame.stream === "stdout") receivedOutput = Buffer.concat([receivedOutput, Buffer.from(frame.dataBase64, "base64")]);
                continue;
              }
              assert.equal(frame.type, "result", JSON.stringify(frame));
              assert.deepEqual(frame.result.command, { kind: "exited", exitCode: 0 });
              assert.equal(Buffer.from(frame.result.stdoutBase64, "base64").toString().trimEnd(), expected);
              assert.equal(receivedOutput.toString().trimEnd(), expected);
              phase = "shutdown";
              send({ type: "shutdown", id: "shutdown" });
            } else {
              assert.equal(phase, "shutdown");
              assert.equal(frame.type, "result", JSON.stringify(frame));
              assert.equal(frame.id, "shutdown");
              assert.equal(frame.result.shuttingDown, true);
              phase = "done";
              child.stdin.end();
            }
          }
        } catch (error) {
          failure ??= error;
          child.stdin.end();
        }
      });
      child.once("close", (code) => {
        try {
          if (failure) throw failure;
          decoder.finish();
          assert.equal(code, 0, stderr);
          assert.equal(phase, "done", `Closed during ${phase}: ${stderr}`);
          resolve();
        } catch (error) { reject(error); }
      });
    });
  } finally {
    clearTimeout(timer);
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
}
