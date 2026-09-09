/** Reproducible local cold/warm measurements. No persistent user config is changed. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { cpus, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = { samples: 30, warmup: 3, runRoot: repository, check: false, maxRegression: 0.25 };
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const flag = args[index];
  if (flag === "--check") { options.check = true; continue; }
  if (flag === "--extended") { options.extended = true; continue; }
  const value = args[++index];
  if (value === undefined) throw new Error("Missing value for " + flag);
  if (flag === "--samples") options.samples = Number(value);
  else if (flag === "--warmup") options.warmup = Number(value);
  else if (flag === "--run-root") options.runRoot = resolve(value);
  else if (flag === "--output") options.output = resolve(value);
  else if (flag === "--baseline") options.baseline = resolve(value);
  else if (flag === "--case") options.case = value;
  else if (flag === "--launcher") options.launcher = resolve(value);
  else if (flag === "--max-regression") options.maxRegression = Number(value);
  else throw new Error("Unknown benchmark option: " + flag);
}
if (!Number.isInteger(options.samples) || options.samples < 3 || options.samples > 100) throw new Error("--samples must be 3..100");
if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 20) throw new Error("--warmup must be 0..20");
if (!Number.isFinite(options.maxRegression) || options.maxRegression < 0 || options.maxRegression > 1) throw new Error("--max-regression must be 0..1");

// Load the candidate's implementation AND its relative resources. --run-root
// must never silently mix an installed package with the checkout's dist files.
const moduleRoot = join(realpathSync(options.runRoot), "dist", "src");
const [{ RuntimeManager }, { PosixLoomService }, { OutputCollector }, { startRemoteHttpServer }] = await Promise.all(
  ["core/runtime.js", "core/service.js", "core/process.js", "http/server.js"].map((path) => import(pathToFileURL(join(moduleRoot, path)).href)),
);

const temporary = await mkdtemp(join(tmpdir(), "posixloom-benchmark-"));
const previousData = process.env.POSIXLOOM_DATA_ROOT;
const previousWorkspace = process.env.POSIXLOOM_WORKSPACE;
const previousRunRoot = process.env.POSIXLOOM_RUN_ROOT;
let runtime;
let http;
try {
  const data = join(temporary, "data"), workspace = join(temporary, "workspace");
  await mkdir(join(data, "config"), { recursive: true });
  await mkdir(workspace);
  await writeFile(join(data, "config", "config.json"), JSON.stringify({ updates: { enabled: false }, observability: { writeTraceFile: false, collectCommandNames: false } }));
  process.env.POSIXLOOM_DATA_ROOT = data;
  process.env.POSIXLOOM_WORKSPACE = workspace;
  process.env.POSIXLOOM_RUN_ROOT = options.runRoot;
  runtime = await RuntimeManager.create(options.runRoot);
  const nodeComponent = runtime.snapshot.manifest.components?.find((component) => component.id === "node");
  const candidateNode = nodeComponent ? join(runtime.snapshot.runtimeRoot, nodeComponent.entrypoint) : process.execPath;
  const normalizePath = (path) => process.platform === "win32" ? realpathSync(path).toLowerCase() : realpathSync(path);
  if (runtime.snapshot.manifest.mode === "release" && normalizePath(candidateNode) !== normalizePath(process.execPath)) {
    throw new Error("Run this benchmark with the candidate's Node so cold and warm cases use identical binaries: " + candidateNode);
  }
  const service = new PosixLoomService(runtime), sessionId = service.createSession();
  const command = { sessionId, kind: "argv", argv: ["node", "-p", "42"], statePolicy: "isolated" };
  const cli = join(options.runRoot, "dist", "src", "cli", "main.js");
  const checkCliOutput = (argv, stdout) => {
    if (argv[0] === "exec" && stdout !== "42\n" && stdout !== "42\r\n") throw new Error("Native CLI benchmark produced unexpected output");
    if (argv[0] === "shell" && stdout !== "benchmark") throw new Error("Shell CLI benchmark produced unexpected output");
    if (argv[0] === "runtime" && !JSON.parse(stdout).runtimeId) throw new Error("Runtime info benchmark produced invalid JSON");
    if (argv[0] === "explain" && JSON.parse(stdout).backend !== "native") throw new Error("Explain benchmark selected an unexpected backend");
  };
  const cold = (argv) => {
    const result = spawnSync(process.execPath, [cli, ...argv], { env: process.env, cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error("Cold benchmark failed (exit " + result.status + "): " + (result.error?.message ?? result.stderr));
    checkCliOutput(argv, result.stdout);
  };
  const checkCompletion = (value) => {
    if (value.command.kind !== "exited" || value.command.exitCode !== 0) throw new Error("Benchmark execution failed: " + JSON.stringify(value.command) + " " + (value.stderr?.toString() ?? ""));
    if (!["not-applicable", "committed"].includes(value.state.kind)) throw new Error("Benchmark command did not produce a valid completion: " + JSON.stringify(value.state));
  };
  const checkShell = (value, state) => {
    checkCompletion(value);
    if (value.stdout.toString() !== "benchmark" || value.backend !== "msys2" || value.state.kind !== state) throw new Error("Shell benchmark output or state differs from the expected successful path");
  };
  const cases = [
    ["cold.runtime-info", () => cold(["runtime", "info", "--json"])],
    ["cold.explain", () => cold(["explain", "--json", "exec", "--", "node", "-p", "42"])],
    ["cold.native", () => cold(["exec", "--", "node", "-p", "42"])],
    ["warm.initialize", async () => { const fresh = await RuntimeManager.create(options.runRoot); await fresh.close(); }],
    ["warm.explain", () => service.explain(command)],
    ["warm.native", async () => {
      const completion = await service.execute(command);
      checkCompletion(completion);
      if (completion.stdout.toString().trim() !== "42" || completion.backend !== "native") throw new Error("Native benchmark produced unexpected output or backend");
    }],
  ];
  const skipped = [];
  const launcher = options.launcher ?? (existsSync(join(options.runRoot, "posixloom.exe"))
    ? join(options.runRoot, "posixloom.exe") : runtime.snapshot.source === "development" ? runtime.findNativeHost() : undefined);
  if (options.launcher && !existsSync(options.launcher)) throw new Error("Launcher not found: " + options.launcher);
  const launched = (argv) => {
    const result = spawnSync(launcher, argv, { env: process.env, cwd: workspace, windowsHide: true, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    if (result.error || result.status !== 0) throw new Error("Launcher benchmark failed (exit " + result.status + "): " + (result.error?.message ?? result.stderr));
    checkCliOutput(argv, result.stdout);
  };
  if (launcher) {
    cases.push(["launcher.runtime-info", () => launched(["runtime", "info", "--json"])]);
    cases.push(["launcher.explain", () => launched(["explain", "--json", "exec", "--", "node", "-p", "42"])]);
    cases.push(["launcher.native", () => launched(["exec", "--", "node", "-p", "42"])]);
  } else {
    if (runtime.snapshot.manifest.mode === "release") throw new Error("Release benchmark requires the package's public launcher");
    skipped.push({ name: "launcher", reason: "Native Host unavailable; build it before checking launcher budgets" });
  }
  if (runtime.findBash()) {
    cases.push(["cold.shell", () => cold(["shell", "--isolated", "-c", "printf benchmark"])]);
    cases.push(["warm.shell", async () => checkShell(await service.execute({ sessionId, raw: "printf benchmark", statePolicy: "isolated" }), "not-applicable")]);
    cases.push(["warm.shell-cwd-env", async () => {
      const completion = await service.execute({ sessionId, raw: "printf benchmark", statePolicy: "cwd-env" });
      checkShell(completion, "committed");
    }]);
    if (launcher) cases.push(["launcher.shell", () => launched(["shell", "--isolated", "-c", "printf benchmark"])]);
  } else skipped.push({ name: "shell", reason: "Bash unavailable; no shell measurement performed" });
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  cases.push(["buffer.output-64mib", () => {
    const collector = new OutputCollector(8 * 1024 * 1024);
    for (let index = 0; index < 1024; index += 1) collector.push(chunk);
    if (!collector.finish().truncated || collector.totalBytes !== 64 * 1024 * 1024) throw new Error("Output collector benchmark failed");
  }]);

  // Extended cases measure actual process/Host/transport work, not only buffers.
  if (options.extended || options.case?.startsWith("load.")) {
    const outputScript = (bytes) => `const b=Buffer.alloc(65536,97);let n=${bytes / 65536};function pump(){while(n-->0){if(!process.stdout.write(b)){process.stdout.once('drain',pump);return;}}}pump();`;
    const outputCommand = (bytes) => ({ ...command, argv: ["node", "-e", outputScript(bytes)] });
    cases.push(["load.native-concurrent-8", async () => {
      const results = await Promise.all(Array.from({ length: 8 }, (_, index) => service.execute({ ...command, clientId: "benchmark-" + index })));
      results.forEach(checkCompletion);
      return { commands: 8 };
    }]);
    cases.push(["load.output-64mib", async () => {
      const started = performance.now();
      let bytes = 0, requestFirstByteMs;
      const completion = await service.execute(outputCommand(64 * 1024 * 1024), { onOutput: (event) => { bytes += event.data.length; requestFirstByteMs ??= performance.now() - started; } });
      checkCompletion(completion);
      if (bytes !== 64 * 1024 * 1024 || completion.stdoutBytes !== bytes || !completion.truncated) throw new Error("Process output measurement lost bytes");
      return { outputBytes: bytes, requestFirstByteMs, processFirstByteMs: completion.trace.timings?.firstByteMs };
    }]);
    http = await startRemoteHttpServer(runtime, { host: "127.0.0.1", port: 0 });
    const sessionResponse = await fetch(http.origin + "/api/v1/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    if (!sessionResponse.ok) throw new Error("HTTP benchmark could not create a session");
    const httpSession = (await sessionResponse.json()).sessionId;
    const httpOutput = async (maximum, slow) => {
      const started = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      let reader;
      try {
        const response = await fetch(`${http.origin}/api/v1/sessions/${httpSession}/execute`, {
          method: "POST", headers: { "content-type": "application/json", accept: "application/x-ndjson" }, signal: controller.signal,
          body: JSON.stringify({ input: { kind: "argv", argv: outputCommand(maximum).argv }, statePolicy: "isolated", stream: true }),
        });
        if (!response.ok || !response.body) throw new Error("HTTP output benchmark failed: " + response.status);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let pending = "", bytes = 0, completed = false, requestFirstByteMs;
        for (;;) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          if (pending.length > 32 * 1024 * 1024) throw new Error("HTTP benchmark frame exceeded its bound");
          let newline;
          while ((newline = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            if (!line) continue;
            const event = JSON.parse(line);
            if (event.type === "error") throw new Error(JSON.stringify(event.error));
            if (event.type === "output") { bytes += Buffer.from(event.dataBase64, "base64").length; requestFirstByteMs ??= performance.now() - started; }
            if (event.type === "completed") {
              checkCompletion(event.result);
              completed = true;
            }
          }
          if (done) break;
          if (slow) await new Promise((resolve) => setTimeout(resolve, 2));
        }
        if (!completed || pending.length || bytes !== maximum) throw new Error("HTTP output measurement was incomplete");
        return { outputBytes: bytes, requestFirstByteMs, readerDelayMs: slow ? 2 : 0 };
      } finally { clearTimeout(timeout); controller.abort(); await reader?.cancel().catch(() => undefined); }
    };
    cases.push(["load.http-output-64mib", () => httpOutput(64 * 1024 * 1024, false)]);
    cases.push(["load.http-delayed-reader-1mib", () => httpOutput(1024 * 1024, true)]);
  }

  const results = {};
  if (options.case && !cases.some(([name]) => name === options.case)) throw new Error("Unknown benchmark case: " + options.case);
  for (const [name, operation] of cases.filter(([name]) => !options.case || options.case === name)) {
    for (let index = 0; index < options.warmup; index += 1) await operation();
    const samples = [];
    const observations = [];
    let sampledRssMaxBytes = process.memoryUsage().rss;
    const sampleMemory = () => { sampledRssMaxBytes = Math.max(sampledRssMaxBytes, process.memoryUsage().rss); };
    const timer = setInterval(sampleMemory, 10);
    const cpu = process.cpuUsage();
    try {
      for (let index = 0; index < options.samples; index += 1) {
        const started = performance.now();
        const observation = await operation();
        const durationMs = performance.now() - started;
        samples.push(durationMs);
        sampleMemory();
        if (observation?.outputBytes) observations.push({ ...observation, mibPerSecond: observation.outputBytes / (1024 * 1024) / (durationMs / 1000) });
        else if (observation?.commands) observations.push({ ...observation, commandsPerSecond: observation.commands / (durationMs / 1000) });
      }
    } finally { clearInterval(timer); }
    const ordered = [...samples].sort((a, b) => a - b);
    results[name] = { count: samples.length, p50: ordered[Math.ceil(samples.length * 0.5) - 1], p95: ordered[Math.ceil(samples.length * 0.95) - 1], min: ordered[0], max: ordered.at(-1), samples, observations, sampledRssMaxBytes, cpuMicroseconds: process.cpuUsage(cpu) };
    console.error(name + ": p50=" + results[name].p50.toFixed(2) + "ms p95=" + results[name].p95.toFixed(2) + "ms");
  }
  const checksumPath = join(options.runRoot, "SHA256SUMS");
  const packageManifestSha256 = existsSync(checksumPath) ? createHash("sha256").update(await readFile(checksumPath)).digest("hex") : undefined;
  const environment = { platform: process.platform, arch: process.arch, node: process.version, nodeExecutable: process.execPath, candidateNode, moduleRoot, launcher, osRelease: release(), cpu: cpus()[0]?.model, runtimeMode: runtime.snapshot.manifest.mode, runtimeSource: runtime.snapshot.source, snapshotId: runtime.snapshot.snapshotId, packageManifestSha256 };
  const checks = [];
  if (options.check) {
    const budgets = JSON.parse(await readFile(join(repository, "benchmarks", "budgets.json"), "utf8"));
    const profile = budgets.profiles[environment.runtimeMode];
    if (!profile) throw new Error("No benchmark budget for runtime profile: " + environment.runtimeMode);
    for (const [name, limit] of Object.entries(profile)) {
      if (options.case && name !== options.case) continue;
      if (name.startsWith("load.") && !options.extended && !options.case?.startsWith("load.")) continue;
      const result = results[name];
      checks.push({ name, rule: "absolute-p95", actual: result?.p95 ?? null, limit, passed: Boolean(result && result.p95 <= limit) });
    }
  }
  if (options.baseline) {
    const baseline = JSON.parse(await readFile(options.baseline, "utf8"));
    if (baseline.schemaVersion !== 2) throw new Error("Baseline methodology differs; record a schemaVersion 2 baseline first");
    for (const key of ["platform", "arch", "cpu", "runtimeMode"]) {
      if (baseline.environment?.[key] !== environment[key]) throw new Error("Baseline environment differs: " + key);
    }
    if (baseline.environment.node.split(".")[0] !== environment.node.split(".")[0]) throw new Error("Baseline Node major version differs");
    for (const [name, result] of Object.entries(results)) {
      const previous = baseline.results?.[name];
      if (!previous || !Number.isFinite(previous.p50)) throw new Error("Baseline measurement missing: " + name);
      const limit = previous.p50 + Math.max(5, previous.p50 * options.maxRegression);
      checks.push({ name, rule: "baseline-p50", actual: result.p50, limit, passed: result.p50 <= limit });
    }
  }
  const methodology = { cold: "new Node process with direct CLI entry", launcher: "new public executable process including integrity validation", warm: "candidate modules in a reused Runtime/Service", warmup: options.warmup, diskCache: "uncontrolled; repeated process starts are not disk-cold measurements", resources: "sampled RSS and CPU of benchmark process only; excludes child processes; sampling can miss short peaks" };
  const report = { schemaVersion: 2, timestamp: new Date().toISOString(), environment, methodology, initializationTimings: runtime.info().initializationTimings, options, results, skipped, checks, passed: checks.every((check) => check.passed) };
  const json = JSON.stringify(report, null, 2) + "\n";
  if (options.output) { await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, json); console.error("Benchmark report: " + options.output); }
  else process.stdout.write(json);
  if (!report.passed) process.exitCode = 1;
} finally {
  await http?.close();
  await runtime?.close();
  if (previousData === undefined) delete process.env.POSIXLOOM_DATA_ROOT; else process.env.POSIXLOOM_DATA_ROOT = previousData;
  if (previousWorkspace === undefined) delete process.env.POSIXLOOM_WORKSPACE; else process.env.POSIXLOOM_WORKSPACE = previousWorkspace;
  if (previousRunRoot === undefined) delete process.env.POSIXLOOM_RUN_ROOT; else process.env.POSIXLOOM_RUN_ROOT = previousRunRoot;
  if (dirname(resolve(temporary)) !== resolve(tmpdir())) throw new Error("Refusing cleanup outside temporary directory");
  await rm(temporary, { recursive: true, force: true });
}
