/**
 * create-update-feed.mjs -- 为完整 Runtime 归档生成签名更新 feed。
 *
 * 用途：把一个已构建好的 Runtime 发布条目（归档 URL、SHA-256、大小、
 * manifest 哈希等）追加进更新 feed，并用 Ed25519 私钥对 feed 的规范化
 * JSON 载荷整体签名。客户端更新器据此发现并原子安装新 Runtime。
 *
 * 运行方式：
 *   node scripts/create-update-feed.mjs --runtime-root <Runtime 目录>
 *       --archive <Runtime zip 归档> --archive-url <归档下载地址>
 *       --output <feed.json 输出路径> --key-id <密钥标识>
 *       --private-key <Ed25519 私钥 PEM> [--channel stable]
 *
 * 发布流程中的角色与设计意图：
 * - 只签名与 RuntimeRoot 完全匹配的归档：签名前会校验 RuntimeRoot 的
 *   manifest 结构、组件入口哈希 / 树哈希、许可证与 SBOM，再安全解包
 *   待发布归档，要求其 manifest 与文件树哈希和 RuntimeRoot 逐一相符。
 *   这样一个“无关的 / 被部分替换的”归档绝无可能被误发布（防止发布
 *   流程中的偷换与错配）。
 * - feed 为什么需要签名：feed 是客户端唯一的更新来源，若可被篡改则
 *   整个更新通道沦陷。签名（配合 canonicalJson 规范化）让客户端能以
 *   固定公钥验证 feed 完整性；追加历史必须先通过当前私钥验签，
 *   schema 合法但未签名 / 被改写过的历史一律拒绝再签。
 * - canonicalJson（键排序）：同一份数据无论对象属性书写顺序如何，
 *   规范化后字节完全一致，保证签名与验签两侧对同一 payload 计算。
 * - 输出采用“写临时文件再 rename”的原子写，避免读者看到半截 feed。
 */
import { createHash, createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// 每个 Runtime 都必须包含的基础组件（环境组件 + 核心宿主 + 生成的 shim）
const REQUIRED_COMPONENTS = ["node", "msys2", "mingit", "ripgrep", "posixloom", "shims"];
// 各基础组件在 Runtime 内的“规范布局”：root 与 entrypoint 的相对路径固定，
// 防止发布时组件被摆放错位置而不被察觉
const RELEASE_COMPONENT_LAYOUTS = {
  node: { root: "node", entrypoint: "node/node.exe" },
  msys2: { root: "msys", entrypoint: "msys/usr/bin/bash.exe" },
  mingit: { root: "native/mingit", entrypoint: "native/mingit/cmd/git.exe" },
  ripgrep: { root: "native/rg", entrypoint: "native/rg/rg.exe" },
  posixloom: { root: "native/posixloom-host", entrypoint: "native/posixloom-host/posixloom.exe" },
  shims: { root: "shims", entrypoint: "shims/node" },
};

/**
 * 打印用法说明（可附带错误原因）并以退出码 2 结束进程。
 * @param {string} [message] 可选的错误信息
 */
function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("usage: node scripts/create-update-feed.mjs --runtime-root <dir> --archive <zip> --archive-url <url> --output <feed.json> --key-id <id> --private-key <pem> [--channel stable]");
  process.exit(2);
}

/**
 * 解析命令行参数为选项对象。
 * 行为：只接受白名单内的选项，拒绝未知选项与重复选项；每个选项必须
 * 携带一个不以 "--" 开头的取值。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）
 * @returns {Record<string, string>} 选项名（不含 "--" 前缀）到取值的映射
 */
function args(argv) {
  const result = {};
  const allowed = new Set(["runtime-root", "archive", "archive-url", "output", "key-id", "private-key", "channel"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) usage(`unexpected argument: ${value}`);
    const key = value.slice(2);
    if (!allowed.has(key)) usage(`unknown option: --${key}`);
    if (key in result) usage(`duplicate option: --${key}`);
    const optionValue = argv[++index];
    if (optionValue === undefined || optionValue.startsWith("--")) usage(`missing value for --${key}`);
    result[key] = optionValue;
  }
  return result;
}

/**
 * 递归规范化任意 JSON 值：数组按序逐项规范化，对象的属性按键名字典序
 * 排序（子对象同样递归处理），原始类型原样返回。
 * 为什么排序：JSON.stringify 输出取决于属性插入顺序，同一逻辑数据可能
 * 有多种字节表示；排序后签名 / 验签双方面对的是唯一的规范字节序列。
 * @param {unknown} value 任意 JSON 值
 * @returns {unknown} 规范化后的值
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonicalize(entry)]));
  return value;
}

/** 规范化 JSON 序列化：先 canonicalize（键排序），再紧凑字符串化，作为签名输入字节。 */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/**
 * 读取整个文件并计算 SHA-256 十六进制摘要（小写）。
 * @param {string} path 目标文件路径
 * @returns {Promise<string>} 十六进制摘要
 */
async function hashFile(path) {
  const hash = createHash("sha256");
  const contents = await readFile(path);
  hash.update(contents);
  return hash.digest("hex");
}

/**
 * 校验相对路径是否安全：非空、无 NUL / 冒号（排除盘符）、不是绝对路径
 * （含 Windows 盘符形式）、每一段非空且不为 "." / ".."，从而拒绝路径穿越。
 * @param {unknown} value 待校验值
 * @returns {boolean} 是否安全
 */
function safeRelativePath(value) {
  return typeof value === "string" && value.length > 0
    && !value.includes("\0") && !value.includes(":")
    && !/^(?:[A-Za-z]:[\\/]|[\\/])/.test(value)
    && value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/**
 * 判断 candidate 是否位于 root 内（含相等），比较大小写不敏感
 * （Windows 语义），同时接受 "\" 与 "/" 作为根目录分隔符。
 * @param {string} root 根目录
 * @param {string} candidate 待检查路径
 * @returns {boolean} 是否在根目录内
 */
function pathInside(root, candidate) {
  const normalizedRoot = resolve(root).toLowerCase();
  const normalizedCandidate = resolve(candidate).toLowerCase();
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}\\`) || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/**
 * 计算目录树哈希：递归收集普通文件（遇到符号链接直接报错），按 POSIX
 * 风格相对路径字典序排序后，把 "路径\0文件SHA-256\n" 逐条喂入 SHA-256。
 * 与 sync-components.mjs 中的树哈希算法一致，因此 feed 的树哈希可与
 * 锁文件 / 构建产物直接比对；任何文件的增删改名或内容变化都会改变结果。
 * @param {string} root 待哈希的目录
 * @returns {Promise<{hash: string, fileCount: number}>} 树哈希与文件数
 */
async function treeHash(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const details = await lstat(path);
      // Runtime 中不允许符号链接：签名物料必须是真实文件树
      if (details.isSymbolicLink()) throw new Error(`Runtime component contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
    }
  }
  await visit(root);
  // 用 "/" 分隔的相对路径作为排序键，消除平台差异，保证可复现
  files.sort((left, right) => {
    const a = left.slice(resolve(root).length + 1).replaceAll("\\", "/");
    const b = right.slice(resolve(root).length + 1).replaceAll("\\", "/");
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const digest = createHash("sha256");
  for (const file of files) {
    const relative = file.slice(resolve(root).length + 1).replaceAll("\\", "/");
    digest.update(`${relative}\0${await hashFile(file)}\n`, "utf8");
  }
  return { hash: digest.digest("hex"), fileCount: files.length };
}

/**
 * 深度校验 RuntimeRoot 的内容与其 manifest 声明完全一致（签名前置防线）。
 * 校验内容：
 * - RuntimeRoot 必须是真实目录（非符号链接）。
 * - manifest.components：id 唯一、版本非空、root / entrypoint 为安全相对路径，
 *   且基础组件必须采用 RELEASE_COMPONENT_LAYOUTS 规定的规范布局；
 *   组件根与入口都必须在 RuntimeRoot 之内（防逃逸）、是真实目录 / 文件；
 *   入口 SHA-256 与树哈希 / 文件数逐项重新计算比对。
 * - 必需组件齐全（REQUIRED_COMPONENTS），shims/node、shims/git、shims/rg
 *   三个生成 shim 必须是真实文件。
 * - licenses：必须非空，每个路径安全、在根内、是真实文件。
 * - SBOM：路径安全、是真实文件、内容为 SPDX-2.3。
 * - sourceLock（若声明）：路径安全、真实文件，且其 SHA-256 与声明一致，
 *   把发布产物与其组件锁文件绑定起来。
 * 任何校验失败都调用 usage 以退出码 2 终止。
 * @param {string} runtimeRoot Runtime 根目录
 * @param {object} manifest 已解析的 manifest.json 内容
 */
async function validateRuntimeContents(runtimeRoot, manifest) {
  const runtimeDetails = await lstat(runtimeRoot);
  if (!runtimeDetails.isDirectory() || runtimeDetails.isSymbolicLink()) usage("RuntimeRoot must be a real directory, not a link");
  const components = Array.isArray(manifest.components) ? manifest.components : [];
  const ids = new Set();
  for (const component of components) {
    // 结构校验：id / 版本 / 相对路径合法且 id 不重复
    if (!component || typeof component.id !== "string" || ids.has(component.id) || typeof component.version !== "string" || !component.version || !safeRelativePath(component.root) || !safeRelativePath(component.entrypoint)) {
      usage("runtime manifest contains an invalid or duplicate component");
    }
    // 基础组件的布局必须与规范布局逐字一致（分隔符统一为 "/" 后比较）
    const expectedLayout = RELEASE_COMPONENT_LAYOUTS[component.id];
    if (expectedLayout && (component.root.replaceAll("\\", "/") !== expectedLayout.root || component.entrypoint.replaceAll("\\", "/") !== expectedLayout.entrypoint)) {
      usage(`runtime component does not use its canonical layout: ${component.id}`);
    }
    ids.add(component.id);
    const componentRoot = resolve(runtimeRoot, component.root);
    const entrypoint = resolve(runtimeRoot, component.entrypoint);
    // 路径约束：组件根在 RuntimeRoot 内、入口在组件根内，且都不得是链接
    if (!pathInside(runtimeRoot, componentRoot) || !pathInside(componentRoot, entrypoint)) usage(`component path escapes RuntimeRoot: ${component.id}`);
    const componentInfo = await lstat(componentRoot);
    const entrypointInfo = await lstat(entrypoint);
    if (!componentInfo.isDirectory() || componentInfo.isSymbolicLink()) usage(`component root is not a real directory: ${component.id}`);
    // 入口哈希重算比对：manifest 声明的 sha256 必须与磁盘实际内容一致
    if (!entrypointInfo.isFile() || entrypointInfo.isSymbolicLink() || !/^[a-f0-9]{64}$/i.test(component.sha256 ?? "") || await hashFile(entrypoint) !== component.sha256.toLowerCase()) {
      usage(`component entrypoint hash is invalid: ${component.id}`);
    }
    if (!/^[a-f0-9]{64}$/i.test(component.treeSha256 ?? "") || !Number.isSafeInteger(component.fileCount) || component.fileCount < 1) usage(`component tree metadata is invalid: ${component.id}`);
    // 树哈希重算比对：整个组件树的每个字节都被 manifest 断言
    const tree = await treeHash(componentRoot);
    if (tree.hash !== component.treeSha256.toLowerCase() || tree.fileCount !== component.fileCount) usage(`component tree hash is invalid: ${component.id}`);
  }
  // 必需基础组件必须全部声明
  if (REQUIRED_COMPONENTS.some((id) => !ids.has(id))) usage("runtime manifest is missing a required basic component");
  // 三个生成 shim（node/git/rg）必须存在且是真实文件
  for (const shim of ["shims/node", "shims/git", "shims/rg"]) {
    const shimPath = resolve(runtimeRoot, shim);
    const details = await lstat(shimPath);
    if (!details.isFile() || details.isSymbolicLink()) usage(`Runtime generated shim is invalid: ${shim}`);
  }
  // 许可证声明非空，且每个许可证都是根内的真实文件
  if (!Array.isArray(manifest.licenses) || manifest.licenses.length === 0) usage("runtime manifest must declare license files");
  for (const license of manifest.licenses) {
    if (!safeRelativePath(license) || !pathInside(runtimeRoot, resolve(runtimeRoot, license))) usage(`runtime license is invalid: ${license}`);
    const details = await lstat(resolve(runtimeRoot, license));
    if (!details.isFile() || details.isSymbolicLink()) usage(`runtime license is invalid: ${license}`);
  }
  // SBOM 必须是根内的真实文件且为 SPDX 2.3
  if (!safeRelativePath(manifest.sbom) || !pathInside(runtimeRoot, resolve(runtimeRoot, manifest.sbom))) usage("runtime SBOM path is invalid");
  const sbomDetails = await lstat(resolve(runtimeRoot, manifest.sbom));
  if (!sbomDetails.isFile() || sbomDetails.isSymbolicLink()) usage("runtime SBOM must be a real file, not a link");
  const sbom = JSON.parse(await readFile(resolve(runtimeRoot, manifest.sbom), "utf8"));
  if (sbom.spdxVersion !== "SPDX-2.3") usage("runtime SBOM is not SPDX 2.3");
  // 可选的组件源锁必须存在且其哈希与声明一致
  if (manifest.sourceLock !== undefined) {
    if (!safeRelativePath(manifest.sourceLock) || !pathInside(runtimeRoot, resolve(runtimeRoot, manifest.sourceLock))) usage("runtime component source lock path is invalid");
    const sourceLockDetails = await lstat(resolve(runtimeRoot, manifest.sourceLock));
    if (!sourceLockDetails.isFile() || sourceLockDetails.isSymbolicLink() || !/^[a-f0-9]{64}$/i.test(manifest.sourceLockSha256 ?? "") || await hashFile(resolve(runtimeRoot, manifest.sourceLock)) !== manifest.sourceLockSha256.toLowerCase()) usage("runtime component source lock hash is invalid");
  }
}

/**
 * 校验 feed 中一条 Runtime 发布条目的结构合法性：
 * runtimeId / runtimeSemver 格式、updateSequence（可选，非负安全整数）、
 * 平台固定 win32-x64、archiveUrl 无 NUL、archiveSha256 为 64 位十六进制、
 * archiveBytes 正整数、归档固定为 zip 且根为 "."、manifestSha256 为
 * 64 位十六进制、publishedAt 为可解析的时间戳。
 * @param {unknown} release 待校验的发布条目
 * @returns {boolean} 是否合法
 */
function validRuntimeRelease(release) {
  return release && typeof release === "object"
    && typeof release.runtimeId === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(release.runtimeId)
    && typeof release.runtimeSemver === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.runtimeSemver)
    && (release.updateSequence === undefined || (Number.isSafeInteger(release.updateSequence) && release.updateSequence >= 0))
    && release.platform === "win32-x64"
    && typeof release.archiveUrl === "string" && release.archiveUrl.length > 0 && !release.archiveUrl.includes("\0")
    && typeof release.archiveSha256 === "string" && /^[a-f0-9]{64}$/i.test(release.archiveSha256)
    && Number.isSafeInteger(release.archiveBytes) && release.archiveBytes > 0
    && release.archiveFormat === "zip"
    && release.archiveRoot === "."
    && typeof release.manifestSha256 === "string" && /^[a-f0-9]{64}$/i.test(release.manifestSha256)
    && typeof release.publishedAt === "string" && Number.isFinite(Date.parse(release.publishedAt));
}

/**
 * 安全解包并核查待发布归档，确保它与 --runtime-root 的内容完全一致
 * （“只签名与完整 Runtime 匹配的归档”这一承诺的实现）。
 * 行为：用 PowerShell 的 ZipFile API 在专用临时目录中执行——
 * 解包前先扫描全部条目：条目数不超过 20 万；条目名拒绝空白 / 绝对路径 /
 * 含冒号（盘符）；按大小写不敏感查重（Windows 解包会互相覆盖）；用
 * GetFullPath + 前缀检查防止条目逃逸出解包根；累计展开大小不超过 8 GiB
 * （防 zip 炸弹）；并要求根下恰好有一个不超过 16 MiB 的 manifest.json。
 * 解包完成后：归档内 manifest.json 的 SHA-256 必须等于 RuntimeRoot 的
 * manifest.json 哈希；归档完整文件树的树哈希 / 文件数必须等于 RuntimeRoot
 * 的树哈希 / 文件数。任何不符都报错，绝不签名。
 * @param {string} archive 待发布的 zip 归档路径
 * @param {string} expectedManifestHash RuntimeRoot manifest.json 的 SHA-256
 * @param {{hash: string, fileCount: number}} expectedTree RuntimeRoot 的树哈希与文件数
 */
async function verifyArchiveContents(archive, expectedManifestHash, expectedTree) {
  // 在系统临时目录中隔离解包，结束后统一清理
  const inspectionRoot = await mkdtemp(join(tmpdir(), "posixloom-feed-"));
  try {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const extractedRoot = join(inspectionRoot, "runtime");
    await execFileAsync(powershell, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
      [
        "$ErrorActionPreference = 'Stop'",
        "Add-Type -AssemblyName System.IO.Compression.FileSystem",
        "$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)",
        "$manifestEntry = $null",
        "$count = 0",
        "$expanded = [Int64]0",
        "$destination = [IO.Path]::GetFullPath($env:POSIXLOOM_FEED_EXTRACTED)",
        "$prefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
        "$zip = [IO.Compression.ZipFile]::OpenRead($env:POSIXLOOM_FEED_ARCHIVE)",
        "try {",
        "  foreach ($entry in $zip.Entries) {",
        "    $count += 1",
        "    if ($count -gt 200000) { throw 'Runtime archive contains too many entries' }",
        "    $name = $entry.FullName.Replace('/', '\\')",
        "    if ([string]::IsNullOrWhiteSpace($name) -or [IO.Path]::IsPathRooted($name) -or $name.Contains(':')) { throw \"Unsafe Runtime archive entry: $($entry.FullName)\" }",
        "    $normalized = $name.TrimEnd('\\')",
        "    $segments = @($normalized -split '\\\\')",
        "    if ([string]::IsNullOrWhiteSpace($normalized) -or ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })) { throw \"Unsafe Runtime archive entry: $($entry.FullName)\" }",
        "    if (!$seen.Add($normalized)) { throw \"Duplicate Runtime archive entry: $($entry.FullName)\" }",
        "    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination, $name))",
        "    if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw \"Runtime archive entry escapes inspection root: $($entry.FullName)\" }",
        "    $expanded += [Int64]$entry.Length",
        "    if ($expanded -gt 8589934592) { throw 'Runtime archive expanded size exceeds 8 GiB' }",
        "    if ($normalized -eq 'manifest.json') { $manifestEntry = $entry }",
        "  }",
        "  if ($null -eq $manifestEntry -or [string]::IsNullOrEmpty($manifestEntry.Name) -or $manifestEntry.Length -gt 16777216) { throw 'Runtime archive must contain one root manifest.json no larger than 16 MiB' }",
        "  [IO.Compression.ZipFileExtensions]::ExtractToDirectory($zip, $destination)",
        "} finally { $zip.Dispose() }",
      ].join("; "),
    ], { env: { ...process.env, POSIXLOOM_FEED_ARCHIVE: archive, POSIXLOOM_FEED_EXTRACTED: extractedRoot }, windowsHide: true, timeout: 600_000 });
    // 归档内的 manifest.json 必须与 RuntimeRoot 的一字不差
    if (await hashFile(join(extractedRoot, "manifest.json")) !== expectedManifestHash) throw new Error("archive manifest does not match --runtime-root manifest.json");
    // 归档完整文件树必须与 RuntimeRoot 的树哈希 / 文件数一致
    const actualTree = await treeHash(extractedRoot);
    if (actualTree.hash !== expectedTree.hash || actualTree.fileCount !== expectedTree.fileCount) throw new Error("archive contents do not match --runtime-root");
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true });
  }
}

// ---- 主流程 ----
// 1) 参数解析与路径安全：必填选项齐全；输出与私钥不得位于 RuntimeRoot 内，
//    输出路径不得覆盖归档或私钥文件（防止签名流程自毁输入）
const options = args(process.argv.slice(2));
for (const required of ["runtime-root", "archive", "archive-url", "output", "key-id", "private-key"]) {
  if (!options[required]) usage(`missing --${required}`);
}
const runtimeRoot = resolve(options["runtime-root"]);
const archive = resolve(options.archive);
const output = resolve(options.output);
const privateKeyPath = resolve(options["private-key"]);
const samePath = (left, right) => process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
if (pathInside(runtimeRoot, output)) usage("--output cannot be inside RuntimeRoot");
if (pathInside(runtimeRoot, privateKeyPath)) usage("--private-key cannot be inside RuntimeRoot");
if ([archive, privateKeyPath].some((path) => samePath(path, output))) usage("--output cannot overwrite an input file");
// 2) manifest 结构校验：schema v1、release 模式、runtimeId / 语义化版本格式、
//    updateSequence 非负安全整数、sourceLockSha256 必须声明、required 列表
//    去重且包含全部必需组件
let manifest;
try { manifest = JSON.parse(await readFile(join(runtimeRoot, "manifest.json"), "utf8")); } catch (error) { usage(`cannot read Runtime manifest: ${error}`); }
if (manifest.manifestVersion !== 1 || manifest.mode !== "release" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(manifest.runtimeId ?? "") || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.runtimeSemver ?? "")) {
  usage("runtime manifest must be a schema-v1 release manifest with a safe identity");
}
if (manifest.updateSequence !== undefined && (!Number.isSafeInteger(manifest.updateSequence) || manifest.updateSequence < 0)) usage("runtime manifest updateSequence must be a non-negative safe integer");
if (!/^[a-f0-9]{64}$/i.test(manifest.sourceLockSha256 ?? "")) usage("runtime manifest must declare the component source lock SHA-256");
const componentIds = new Set(Array.isArray(manifest.components) ? manifest.components.map((component) => component?.id) : []);
const requiredIds = new Set(Array.isArray(manifest.required) ? manifest.required.map((entry) => typeof entry === "string" ? entry : entry?.id) : []);
if (!Array.isArray(manifest.required) || requiredIds.size !== manifest.required.length || [...requiredIds].some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))) usage("runtime manifest required component list is invalid or duplicated");
if (REQUIRED_COMPONENTS.some((id) => !componentIds.has(id) || !requiredIds.has(id))) usage("runtime manifest is missing a required basic component");
// 3) 深度内容校验：入口 / 树哈希、shim、许可证、SBOM、源锁逐一重算比对
try { await validateRuntimeContents(runtimeRoot, manifest); } catch (error) { usage(`runtime contents validation failed: ${error}`); }
// 4) 输入文件校验：归档必须是真实非空文件且不是符号链接；key-id / channel
//    格式受限（避免注入异常字符进入 feed 元数据）
let archiveInfo;
try { archiveInfo = await lstat(archive); } catch (error) { usage(`cannot read --archive: ${error}`); }
if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size <= 0) usage("--archive must be a non-empty real file, not a link");
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(options["key-id"])) usage("--key-id is invalid");
if (options.channel !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.channel)) usage("--channel is invalid");
// 5) 私钥加载与算法检查：必须是 Ed25519 私钥（与客户端验签算法一致）
let privateKey;
try {
  privateKey = createPrivateKey(await readFile(privateKeyPath, "utf8"));
} catch (error) { usage(`cannot read private key: ${error}`); }
if (privateKey.asymmetricKeyType !== "ed25519") usage("--private-key must contain an Ed25519 private key");
// 6) 归档一致性核查：归档 manifest 与完整文件树必须与 RuntimeRoot 一致
const manifestHash = await hashFile(join(runtimeRoot, "manifest.json"));
let runtimeTree;
try { runtimeTree = await treeHash(runtimeRoot); } catch (error) { usage(String(error?.message ?? error)); }
try { await verifyArchiveContents(archive, manifestHash, runtimeTree); } catch (error) { usage(String(error?.message ?? error)); }
// 7) 组装发布条目：来源全部是已验证的事实（manifest 哈希、归档哈希与
//    实际字节数），publishedAt 记录签名时刻
const release = {
  runtimeId: manifest.runtimeId,
  runtimeSemver: manifest.runtimeSemver,
  ...(manifest.updateSequence === undefined ? {} : { updateSequence: manifest.updateSequence }),
  platform: "win32-x64",
  archiveUrl: options["archive-url"],
  archiveSha256: await hashFile(archive),
  archiveBytes: archiveInfo.size,
  archiveFormat: "zip",
  archiveRoot: ".",
  manifestSha256: manifestHash,
  publishedAt: new Date().toISOString(),
};
// 8) 读取既有 feed（不存在则新建空 feed），并做结构校验
let existing = { feedVersion: 1, signed: { channel: options.channel ?? "stable", generatedAt: new Date().toISOString(), runtimes: [] }, signatures: [] };
let existingOutput = false;
try {
  const outputInfo = await lstat(output);
  if (!outputInfo.isFile() || outputInfo.isSymbolicLink()) usage("existing --output must be a real file, not a link");
  existing = JSON.parse(await readFile(output, "utf8"));
  existingOutput = true;
} catch (error) {
  // 文件不存在（ENOENT）视为新建 feed；其他错误（权限、损坏等）直接失败
  if (error?.code !== "ENOENT") usage(`cannot read existing --output: ${error}`);
}
// 既有 feed 必须结构完整且每条发布记录都合法
if (existing.feedVersion !== 1 || !existing.signed || typeof existing.signed !== "object" || typeof existing.signed.channel !== "string" || typeof existing.signed.generatedAt !== "string" || !Number.isFinite(Date.parse(existing.signed.generatedAt)) || !Array.isArray(existing.signed.runtimes) || !Array.isArray(existing.signatures) || existing.signed.runtimes.some((entry) => !validRuntimeRelease(entry))) {
  usage("existing output feed is invalid");
}
// platform + runtimeId 组成唯一身份，既有 feed 内不得重复
const identities = new Set();
for (const entry of existing.signed.runtimes) {
  const identity = `${entry.platform}\0${entry.runtimeId}`;
  if (identities.has(identity)) usage("existing output feed contains duplicate Runtime identities");
  identities.add(identity);
}
// 9) 追加历史的信任检查：既有 feed 必须已由当前私钥对应的公钥正确签名。
//    这防止“schema 合法但来源不明 / 被篡改”的历史被静默重签，也防止
//    用另一把密钥的 feed 冒名续写。
if (existingOutput) {
  const signedBytes = Buffer.from(canonicalJson(existing.signed), "utf8");
  const publicKey = createPublicKey(privateKey);
  const trusted = existing.signatures.some((entry) => {
    if (!entry || entry.keyId !== options["key-id"] || entry.algorithm !== "ed25519" || typeof entry.value !== "string") return false;
    try { return verify(null, signedBytes, publicKey, Buffer.from(entry.value, "base64")); } catch { return false; }
  });
  if (!trusted) usage("existing output feed is not signed by the supplied release key");
}
// 渠道必须与既有 feed 一致；未指定时沿用既有渠道（默认 stable）
if (options.channel && existing.signed.channel && options.channel !== existing.signed.channel) usage("--channel does not match the existing output feed");
const channel = options.channel ?? existing.signed?.channel ?? "stable";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(channel)) usage("feed channel is invalid");
// 10) 组装新 feed：替换同身份（platform + runtimeId）的旧条目后追加新条目，
//     对规范化后的 signed 载荷做 Ed25519 签名，最后原子写盘
const runtimes = (existing.signed?.runtimes ?? []).filter((entry) => !(entry.platform === release.platform && entry.runtimeId === release.runtimeId));
const signed = { channel, generatedAt: new Date().toISOString(), runtimes: [...runtimes, release] };
// 签名对象是 canonicalJson(signed)：键排序后的唯一字节序列，与客户端验签算法一致
const signature = sign(null, Buffer.from(canonicalJson(signed), "utf8"), privateKey).toString("base64");
const feed = { feedVersion: 1, signed, signatures: [{ keyId: options["key-id"], algorithm: "ed25519", value: signature }] };
await mkdir(dirname(output), { recursive: true });
// 原子写：wx 创建临时文件 -> rename 到位；失败时清理临时文件且不掩盖主错误
const temporaryOutput = `${output}.next-${process.pid}-${randomUUID()}`;
let writeError;
try {
  await writeFile(temporaryOutput, `${JSON.stringify(feed, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryOutput, output);
} catch (error) {
  writeError = error;
  throw error;
} finally {
  try { await rm(temporaryOutput, { force: true }); } catch (cleanupError) { if (!writeError) throw cleanupError; }
}
console.log(`wrote ${output}`);
