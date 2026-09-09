import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

test("packed SDK typechecks and executes from a separate offline consumer", (context) => {
  const root = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), "posixloom-sdk-consumer-"));
  context.after(() => rmSync(fixture, { recursive: true, force: true }));
  const consumer = join(fixture, "外部 consumer");
  mkdirSync(consumer);
  const npmCli = process.env.npm_execpath ?? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  assert.equal(existsSync(npmCli), true, `npm CLI missing at ${npmCli}`);
  const env = { ...process.env, npm_config_cache: join(fixture, "npm-cache"), POSIXLOOM_DATA_ROOT: join(fixture, "runtime-data"), POSIXLOOM_UPDATE_FEED_URL: "" };
  const run = (args: string[], cwd: string) => {
    const result = spawnSync(process.execPath, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 30_000 });
    assert.equal(result.status, 0, `${args[0]}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    return result.stdout;
  };
  const [packed] = JSON.parse(run([npmCli, "pack", "--json", "--ignore-scripts", "--pack-destination", fixture], root));
  const files = packed.files.map((file: { path: string }) => file.path);
  assert.equal(files.includes("dist/src/index.d.ts"), true);
  assert.equal(files.includes("dist/src/core/assets/state-report.sh"), true);
  assert.equal(files.some((file: string) => /^(tests|dist\/tests|data|artifacts|native)\//.test(file)), false);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "external-sdk-smoke", private: true, type: "module" }));
  run([npmCli, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", join(fixture, packed.filename)], consumer);
  writeFileSync(join(consumer, "consume.mts"), `
import assert from "node:assert/strict";
import { RuntimeManager, PosixLoomService, type ExecuteOptions, type CommandCompletion } from "posixloom-runtime";
const runtime = await RuntimeManager.create(process.argv[2]);
try {
  const service = new PosixLoomService(runtime);
  const options: ExecuteOptions = { sessionId: service.createSession(), kind: "argv", argv: ["node", "-p", "process.argv.at(1)", "SDK 你好 exact argv"], statePolicy: "isolated" };
  const completion: CommandCompletion = await service.execute(options);
  assert.deepEqual(completion.command, { kind: "exited", exitCode: 0 });
  assert.equal(completion.stdout.toString().trimEnd(), "SDK 你好 exact argv");
  assert.equal(typeof service.sessions.snapshot(options.sessionId).version, "bigint");
  console.log("SDK_CONSUMER_OK");
} finally { await runtime.close(); }
`);
  writeFileSync(join(consumer, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
      types: ["node"], typeRoots: [join(root, "node_modules", "@types")], outDir: "out",
    },
    include: ["consume.mts"],
  }));
  run([join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"], consumer);
  assert.match(run([join(consumer, "out", "consume.mjs"), root], consumer), /SDK_CONSUMER_OK/);
  const example = join(consumer, "node_modules", "posixloom-runtime", "examples", "embedded.mjs");
  assert.equal(readFileSync(example, "utf8").includes('from "posixloom-runtime"'), true);
  assert.equal(run([example, root], consumer).trimEnd(), "hello from PosixLoom");
});
