import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { encodeNativeFrame, NativeFrameDecoder } from "../src/core/process.js";

const nativeHost = join(process.cwd(), "native", "posixloom-host", "target", "debug", "posixloom.exe");

interface HostEvent {
  type: string;
  data?: string;
  code?: number;
  capabilities?: string[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  // A failed setup may never reach the later output await; keep that cleanup path handled.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

test("abandoned Shell namespace recovers only after the crashed Host's entire old Job is gone", {
  skip: process.platform !== "win32" || !existsSync(nativeHost),
  timeout: 15000,
}, async (context) => {
  // An independent key and ordinary Node processes exercise kernel ownership without
  // starting MSYS or modifying the mount namespace used by other integration files.
  const shellNamespace = randomBytes(32).toString("hex");
  const run = (code: string) => {
    const child = spawn(nativeHost, ["__exec-host", "--protocol-v1"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const frames: HostEvent[] = [];
    const decoder = new NativeFrameDecoder();
    const hello = deferred<void>(), output = deferred<string>();
    let stdout = "", stderr = "";
    let failure: Error | undefined;
    const fail = (error: Error): void => {
      failure ??= error;
      hello.reject(error);
      output.reject(error);
      child.kill();
    };
    child.stdin.on("error", fail);
    child.on("error", fail);
    child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4096); });
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        for (const value of decoder.push(chunk)) {
          const event = value as HostEvent;
          frames.push(event);
          if (event.type === "hello") {
            assert.ok(event.capabilities?.includes("shell-namespace-v1"), "Host must implement Shell namespace ownership");
            child.stdin.write(encodeNativeFrame({ protocolVersion: 1, type: "exec", program: process.execPath, args: ["-e", code], cwd: process.cwd(), env: process.env, timeoutMs: 10000, shellNamespace }));
            hello.resolve();
          } else if (event.type === "stdout") {
            stdout += Buffer.from(event.data ?? "", "base64").toString();
            if (stdout.includes("\n")) output.resolve(stdout.slice(0, stdout.indexOf("\n")));
          }
        }
      } catch (error) { fail(error as Error); }
    });
    const done = new Promise<{ code: number | null; stderr: string; failure?: Error }>((resolve) => {
      child.once("close", (exitCode) => {
        const error = failure ?? new Error(`Host closed before expected output: ${JSON.stringify({ code: exitCode, stderr, stdout, frames })}`);
        hello.reject(error);
        output.reject(error);
        resolve({ code: exitCode, stderr, failure });
      });
    });
    context.after(async () => { child.kill(); await done; });
    return { child, frames, hello: hello.promise, output: output.promise, done };
  };

  const holder = run("const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'}); console.log(JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000)");
  await holder.hello;
  const pids: number[] = JSON.parse(await holder.output);
  assert.equal(pids.length, 2);
  for (const pid of pids) { assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.doesNotThrow(() => process.kill(pid, 0)); }
  // Retain the original process objects so Windows cannot reuse either PID for
  // the waiter or an unrelated parallel test before the exit assertions run.
  const observer = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
    $ErrorActionPreference = 'Stop'
    $observedProcesses = @()
    try {
      foreach ($processId in @(${pids.join(",")})) {
        $observedProcess = [Diagnostics.Process]::GetProcessById($processId)
        [void]$observedProcess.Handle
        $observedProcesses += $observedProcess
      }
      [Console]::Out.WriteLine('HANDLES_READY')
      [Console]::Out.Flush()
      [void][Console]::In.ReadLine()
    } finally {
      foreach ($observedProcess in $observedProcesses) { $observedProcess.Dispose() }
    }
  `], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const handlesReady = deferred<void>();
  let observerStdout = "", observerStderr = "", observerReleased = false;
  let observerFailure: Error | undefined;
  observer.on("error", (error) => { observerFailure = error; handlesReady.reject(error); });
  observer.stdin.on("error", (error) => { observerFailure = error; handlesReady.reject(error); });
  observer.stdout.on("data", (chunk: Buffer) => {
    observerStdout += chunk.toString();
    if (observerStdout.includes("HANDLES_READY\n") || observerStdout.includes("HANDLES_READY\r\n")) handlesReady.resolve();
  });
  observer.stderr.on("data", (chunk: Buffer) => { observerStderr = (observerStderr + chunk.toString()).slice(-4096); });
  const observerDone = new Promise<void>((resolve) => observer.once("close", (code) => {
    if (!observerReleased || code !== 0) {
      observerFailure ??= new Error(`Process handle observer closed: ${JSON.stringify({ code, stdout: observerStdout, stderr: observerStderr })}`);
      handlesReady.reject(observerFailure);
    }
    resolve();
  }));
  context.after(async () => {
    observerReleased = true;
    const cleanupTimeout = setTimeout(() => observer.kill(), 2000);
    cleanupTimeout.unref();
    try {
      observer.stdin.end("\n");
      await observerDone;
    } finally { clearTimeout(cleanupTimeout); }
    assert.equal(observerFailure, undefined);
  });
  await handlesReady.promise;
  const waiter = run(`for (const pid of ${JSON.stringify(pids)}) { try { process.kill(pid,0); require('node:fs').writeSync(1,JSON.stringify({livePid:pid,self:process.pid})+'\\n'); process.exit(42); } catch (error) { if (error.code !== 'ESRCH') throw error; } } console.log('recovered')`);
  await waiter.hello;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(waiter.frames.some((event) => event.type === "started"), false, "second Host must wait while the first owns the namespace");
  assert.equal(holder.child.kill(), true);
  await holder.done;
  const recovered = await waiter.done;
  assert.equal(recovered.failure, undefined);
  assert.equal(recovered.code, 0, JSON.stringify({ ...recovered, frames: waiter.frames }));
  assert.ok(waiter.frames.some((event) => event.type === "exit" && event.code === 0), JSON.stringify({ oldPids: pids, frames: waiter.frames }));
  assert.equal(await waiter.output, "recovered");
  assert.equal(observerFailure, undefined);
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), "neither the old process nor its descendant may survive recovery");
});
