/**
 * sync-components.mjs —— PosixLoom 环境组件供应链同步脚本。
 *
 * 用途：从受信任的上游发布轨道（Node.js LTS、GitHub Releases）解析、下载、
 * 校验并物化 PosixLoom 所需的四个第三方环境组件（node / msys2 / mingit / ripgrep），
 * 产出完整的组件输出目录，并维护可复现的组件锁文件 components.lock.json。
 *
 * 运行方式（三选一的模式参数）：
 *   node scripts/sync-components.mjs --check   只查询上游是否有新版本（只读，输出 JSON 摘要）
 *   node scripts/sync-components.mjs --locked  按已提交的锁文件原样重建组件树（不访问发布索引）
 *   node scripts/sync-components.mjs --refresh 从上游解析最新版本并重写锁文件
 * 可选参数：--policy <策略文件路径>（默认 packaging/components.sources.json）、
 *           --lock <锁文件路径>（默认 packaging/components.lock.json）、
 *           --output <组件输出目录>（默认 artifacts/components/win32-x64）、
 *           --cache <归档缓存目录>（默认 artifacts/component-cache）。
 *
 * 供应链角色与设计意图：
 * - 可复现物化：CI / 其他开发者用 --locked 重建时，必须得到与锁文件记录完全一致的
 *   组件树（入口哈希、完整树哈希、文件数逐项比对）；任何不一致都会失败并拒绝换入，
 *   这保证了发布出的 Runtime 与锁文件审计的输入严格对应，杜绝“锁文件说 A、磁盘上是 B”。
 * - 只提交锁文件、不提交二进制：仓库中仅保存策略与锁元数据（归档 URL、SHA-256、
 *   字节数、入口/树哈希、许可证路径），二进制归档按需下载并缓存到本地 artifacts；
 *   既控制仓库体积，又让每一次物化的上游来源可追溯、可校验。
 * - 下载与解包全程设防：归档大小上限（1 GiB）、条目数上限、展开总大小上限（8 GiB）、
 *   条目路径穿越 / 磁盘盘符 / 大小写重复检测、解包后禁止符号链接与重解析点，
 *   防止恶意归档在解包或后续使用阶段越权。
 */
import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
// PosixLoom 唯一允许的四个第三方环境组件；核心代码（posixloom 宿主、shim 等）不属于环境组件供应链
const COMPONENT_IDS = ["node", "msys2", "mingit", "ripgrep"];
// 下载与解包的资源安全上限：单归档 1 GiB、条目数 20 万、解压后总大小 8 GiB
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 200_000;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024 * 1024;
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 打印用法说明（可附带错误原因）并以退出码 2 结束进程。
 * @param {string} [message] 可选的错误信息
 */
function usage(message) {
  if (message) console.error(`component sync: ${message}`);
  console.error("usage: node scripts/sync-components.mjs (--locked | --refresh | --check) [--policy path] [--lock path] [--output path] [--cache path]");
  process.exit(2);
}

/**
 * 解析命令行参数为选项对象。
 * 行为：--locked / --refresh / --check 为无值开关，其余选项必须跟一个不以 "--"
 * 开头的取值；三选一模式必须恰好指定一个，否则打印用法并退出。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）
 * @returns {{locked?: boolean, refresh?: boolean, check?: boolean, [key: string]: string|boolean}} 选项对象
 */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usage(`unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (["locked", "refresh", "check"].includes(name)) options[name] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith("--")) usage(`missing value for --${name}`);
      options[name] = value;
    }
  }
  // 模式参数互斥：--locked / --refresh / --check 只能选一个
  const modes = ["locked", "refresh", "check"].filter((name) => options[name]);
  if (modes.length !== 1) usage("select exactly one of --locked, --refresh or --check");
  return options;
}

/** 计算字节内容的 SHA-256 十六进制摘要（小写）。 */
function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * 以流式方式计算文件 SHA-256，避免大归档整体读入内存。
 * @param {string} path 目标文件路径
 * @returns {Promise<string>} 十六进制摘要（小写）
 */
async function hashFile(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest("hex");
}

/**
 * 判断 candidate 是否位于 root 内（含相等），比较按大小写不敏感（Windows 语义）。
 * 用于防止相对路径 / 锁文件中的路径逃出预期目录。
 * @param {string} root 根目录
 * @param {string} candidate 待检查路径
 * @returns {boolean} 是否在根目录内
 */
function pathInside(root, candidate) {
  const left = resolve(root).toLowerCase();
  const right = resolve(candidate).toLowerCase();
  return right === left || right.startsWith(`${left}${sep}`);
}

/**
 * 校验一个相对路径是否“安全”：非空字符串、无 NUL / 冒号（排除盘符与 ADS）、
 * 不是绝对路径、每一段都不是空串 / "." / ".."，从而拒绝路径穿越。
 * @param {unknown} value 待校验值
 * @returns {boolean} 是否安全
 */
function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.includes(":")
    && !isAbsolute(value)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && value.split(/[\\/]/).every((segment) => segment && segment !== "." && segment !== "..");
}

/**
 * 断言 --output / --cache 指向的目录是“受管理的窄路径”，防止误删重要目录
 * （例如仓库根、用户主目录、盘根、过浅的路径，或把仓库根包含在该目录内时
 * 换入/清理动作会波及仓库本身）。
 * @param {string} path 待检查的目录
 * @param {string} name 用于错误信息的目录名称
 */
function assertManagedTarget(path, name) {
  const target = resolve(path);
  const root = resolve(repositoryRoot);
  // 计算目标所在的“卷根”（如 D:\），用于计算路径深度
  const volume = resolve(target.slice(0, target.indexOf(sep) + 1));
  const depth = relative(volume, target).split(/[\\/]/).filter(Boolean).length;
  // 禁止：目标等于仓库根 / 用户主目录 / 卷根、路径深度不足 2 层、或目标把仓库根包含在内
  if (target === root || target === resolve(homedir()) || target === volume || depth < 2 || pathInside(target, root)) throw new Error(`${name} is an unsafe broad path: ${target}`);
}

/** 判断路径是否存在（吞掉所有错误，仅返回布尔值）。 */
async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

/**
 * 读取并解析 JSON 文件，要求顶层是 JSON 对象（而非数组或标量）。
 * @param {string} path 文件路径
 * @param {string} name 用于错误信息的文件名称
 * @returns {Promise<object>} 解析后的对象
 */
async function readJson(path, name) {
  let parsed;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch (error) { throw new Error(`cannot read ${name} ${path}: ${error}`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object`);
  return parsed;
}

/**
 * 原子写文件：先写临时文件（wx 标志保证不覆盖已存在内容）再 rename 到位。
 * 读取方要么看到旧内容、要么看到完整新内容，不会读到半截 JSON。
 * @param {string} path 目标文件路径
 * @param {string} contents 写入内容
 */
async function atomicWrite(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(temporary, contents, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } finally {
    // rename 成功后 temporary 已不存在；失败时这里负责清理残留
    await rm(temporary, { force: true });
  }
}

let cachedGitHubToken;

/**
 * 惰性获取 GitHub API 令牌：优先取 GITHUB_TOKEN / GH_TOKEN 环境变量，
 * 其次尝试调用 gh CLI 的 auth token 子命令；两者皆无则返回空串。
 * 结果只解析一次并缓存，避免对每次请求重复执行子进程。
 * @returns {string} 令牌（可能为空串）
 */
function githubToken() {
  if (cachedGitHubToken !== undefined) return cachedGitHubToken;
  cachedGitHubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";
  if (!cachedGitHubToken) {
    try { cachedGitHubToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim(); } catch { cachedGitHubToken = ""; }
  }
  return cachedGitHubToken;
}

/** 构造 GitHub API 请求头（Accept / User-Agent，有令牌时附带 Bearer 授权）。 */
function githubHeaders() {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "posixloom-component-sync" };
  const token = githubToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * 拉取 URL 文本内容，跟随重定向，60 秒超时。
 * @param {string} url 目标 URL
 * @param {object} [headers] 附加请求头
 * @returns {Promise<string>} 响应文本
 */
async function fetchText(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} while reading ${url}`);
  return response.text();
}

/**
 * 拉取并解析 JSON，解析失败时给出带 URL 的错误信息。
 * @param {string} url 目标 URL
 * @param {object} [headers] 附加请求头
 * @returns {Promise<unknown>} 解析后的 JSON 值
 */
async function fetchJson(url, headers = {}) {
  const text = await fetchText(url, headers);
  try { return JSON.parse(text); } catch (error) { throw new Error(`invalid JSON from ${url}: ${error}`); }
}

/**
 * 用 values 中的键值对替换模板字符串里的 {key} 占位符
 * （例如策略中的 archiveRoot 模板 {tag} / {version}）。
 * @param {string} template 含占位符的模板
 * @param {Record<string, string>} values 占位符取值
 * @returns {string} 展开后的字符串
 */
function expandTemplate(template, values) {
  return Object.entries(values).reduce((output, [key, value]) => output.replaceAll(`{${key}}`, value), template);
}

/**
 * 解析 Node.js 策略：在 nodejs.org 官方发布索引中查找指定大版本的最新 LTS 发行版，
 * 并从官方 SHASUMS256.txt 中提取 win-x64 zip 归档的官方 SHA-256。
 * 官方清单校验和是这里唯一的信任锚：上游清单说是什么哈希，我们就锁定什么哈希。
 * @param {object} policy 该组件的策略（需含正整数 major、archiveFormat、archiveRoot、entrypoint）
 * @returns {Promise<object>} 归一化的发布描述（版本、归档 URL、SHA-256、格式、根目录、入口）
 */
async function resolveNode(policy) {
  if (!Number.isInteger(policy.major) || policy.major < 1) throw new Error("node policy must declare a positive major version");
  const index = await fetchJson("https://nodejs.org/dist/index.json");
  if (!Array.isArray(index)) throw new Error("Node.js release index is not an array");
  // 找到属于目标大版本且标记为 LTS 的最新发布
  const release = index.find((entry) => typeof entry?.version === "string" && entry.version.startsWith(`v${policy.major}.`) && entry.lts);
  if (!release) throw new Error(`no active Node.js ${policy.major}.x LTS release found`);
  const tag = release.version;
  const version = tag.slice(1);
  const assetName = `node-${tag}-win-x64.zip`;
  const sumsUrl = `https://nodejs.org/dist/${tag}/SHASUMS256.txt`;
  const sums = await fetchText(sumsUrl);
  const line = sums.split(/\r?\n/).find((entry) => entry.endsWith(`  ${assetName}`));
  // 从 "sha256  文件名" 行中提取 64 位十六进制摘要
  const digest = line?.match(/^([a-f0-9]{64})\s{2}/i)?.[1]?.toLowerCase();
  if (!digest) throw new Error(`Node.js checksum list does not contain ${assetName}`);
  return {
    version,
    upstreamTag: tag,
    archiveUrl: `https://nodejs.org/dist/${tag}/${assetName}`,
    archiveSha256: digest,
    archiveFormat: policy.archiveFormat,
    archiveRoot: expandTemplate(policy.archiveRoot, { tag, version }),
    entrypoint: policy.entrypoint,
  };
}

/**
 * 解析 GitHub Release 策略：查找仓库最近的稳定（非 draft / prerelease）发布，
 * 其 tag 与资产名匹配策略正则，并要求 GitHub 直接提供资产 SHA-256 摘要
 * （GitHub Release 的 API 摘要同样充当信任锚；缺失则拒绝）。
 * @param {string} id 组件标识（用于错误信息）
 * @param {object} policy 该组件的策略
 * @returns {Promise<object>} 归一化的发布描述
 */
async function resolveGitHub(id, policy) {
  if (typeof policy.repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.repository)) throw new Error(`${id} policy has an invalid GitHub repository`);
  const releases = await fetchJson(`https://api.github.com/repos/${policy.repository}/releases?per_page=30`, githubHeaders());
  if (!Array.isArray(releases)) throw new Error(`GitHub releases response is invalid for ${id}`);
  const tagPattern = new RegExp(policy.releaseTagPattern);
  const assetPattern = new RegExp(policy.assetPattern);
  // 只接受稳定发布：排除草稿与预发布，且 tag 与资产名都要匹配策略正则
  const release = releases.find((entry) => !entry?.draft && !entry?.prerelease && typeof entry?.tag_name === "string" && tagPattern.test(entry.tag_name) && Array.isArray(entry.assets) && entry.assets.some((asset) => assetPattern.test(asset?.name ?? "")));
  if (!release) throw new Error(`no stable GitHub release matches the ${id} policy`);
  const asset = release.assets.find((entry) => assetPattern.test(entry.name));
  const digest = typeof asset.digest === "string" ? asset.digest.match(/^sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() : undefined;
  if (!digest) throw new Error(`GitHub did not provide a SHA-256 digest for ${id} asset ${asset.name}`);
  const tag = release.tag_name;
  // 按策略配置剥离 tag 前缀（例如 "ripgrep-14.1.0" -> "14.1.0"）
  const version = policy.stripVersionPrefix && tag.startsWith(policy.stripVersionPrefix) ? tag.slice(policy.stripVersionPrefix.length) : tag;
  return {
    version,
    upstreamTag: tag,
    archiveUrl: asset.browser_download_url,
    archiveSha256: digest,
    archiveBytes: asset.size,
    archiveFormat: policy.archiveFormat,
    archiveRoot: expandTemplate(policy.archiveRoot, { tag, version }),
    entrypoint: policy.entrypoint,
  };
}

/**
 * 按策略解析全部四个组件的上游发布描述。
 * 每个组件依据 provider 字段分发到 nodejs-lts 或 github-release 解析器；
 * 策略缺失组件或 provider 不受支持都会直接失败。
 * @param {object} policy 组件源策略
 * @returns {Promise<Record<string, object>>} 组件 id -> 发布描述
 */
async function resolveUpstream(policy) {
  const entries = await Promise.all(COMPONENT_IDS.map(async (id) => {
    const component = policy.components[id];
    if (!component || typeof component !== "object") throw new Error(`component policy is missing ${id}`);
    const resolved = component.provider === "nodejs-lts" ? await resolveNode(component) : component.provider === "github-release" ? await resolveGitHub(id, component) : undefined;
    if (!resolved) throw new Error(`unsupported component provider for ${id}: ${component.provider}`);
    return [id, resolved];
  }));
  return Object.fromEntries(entries);
}

/**
 * 从锁文件解析出全部四个组件的发布描述（--locked 模式的数据来源）。
 * 行为：先校验锁文件整体结构（schema v2、win32-x64、正整数 updateSequence），
 * 再逐组件做严格校验（版本、归档 URL、64 位 SHA-256、字节数上限、归档格式
 * 只允许 zip / tar.xz、archiveRoot 与 entrypoint 必须是安全相对路径），
 * 返回的描述与 resolveUpstream 输出同构，供物化流程统一消费。
 * 任何一项不合格都意味着锁文件被篡改或损坏，直接拒绝。
 * @param {object} lock 锁文件内容
 * @returns {Record<string, object>} 组件 id -> 发布描述
 */
function releasesFromLock(lock) {
  if (lock.lockVersion !== 2 || lock.platform !== "win32-x64" || !Number.isSafeInteger(lock.updateSequence) || lock.updateSequence < 1 || !lock.components || typeof lock.components !== "object") throw new Error("component lock must be schema v2 for win32-x64 with a positive updateSequence");
  return Object.fromEntries(COMPONENT_IDS.map((id) => {
    const entry = lock.components[id];
    // archiveRoot 允许取 "."（归档根即组件根），其余必须是安全相对路径
    const safeArchiveRoot = entry?.archiveRoot === "." || safeRelativePath(entry?.archiveRoot);
    if (!entry || typeof entry.version !== "string" || !entry.version || typeof entry.archiveUrl !== "string" || !entry.archiveUrl || !/^[a-f0-9]{64}$/i.test(entry.archiveSha256 ?? "") || !Number.isSafeInteger(entry.archiveBytes) || entry.archiveBytes < 1 || entry.archiveBytes > MAX_ARCHIVE_BYTES || !["zip", "tar.xz"].includes(entry.archiveFormat) || !safeArchiveRoot || !safeRelativePath(entry.entrypoint)) throw new Error(`component lock entry is invalid: ${id}`);
    return [id, {
      version: entry.version,
      upstreamTag: entry.upstreamTag,
      archiveUrl: entry.archiveUrl,
      archiveSha256: entry.archiveSha256.toLowerCase(),
      archiveBytes: entry.archiveBytes,
      archiveFormat: entry.archiveFormat,
      archiveRoot: entry.archiveRoot,
      entrypoint: entry.entrypoint,
    }];
  }));
}

/**
 * 下载（或复用缓存中的）组件归档，并进行大小与 SHA-256 双重校验。
 * 行为：
 * - 缓存命中条件：文件存在、是普通文件、大小不超上限、哈希与期望一致
 *   （有期望字节数时还需字节数一致）；否则删除后重新下载。
 * - 下载走流式管道，Transform 同时做字节计数（超过 1 GiB 立即中止）与哈希；
 *   content-length 声明超限也提前拒绝。
 * - 归档 URL 也支持 file: 或本地路径（便于离线 / 调试），同样经过哈希校验。
 * - 写入使用 wx 标志的临时文件，校验全部通过后才 rename 进入缓存。
 * @param {string} id 组件标识
 * @param {object} release 发布描述（含 archiveUrl / archiveSha256 / archiveBytes）
 * @param {string} cacheRoot 归档缓存目录
 * @returns {Promise<string>} 缓存中的归档路径
 */
async function downloadArchive(id, release, cacheRoot) {
  const urlName = (() => { try { return basename(new URL(release.archiveUrl).pathname); } catch { return basename(release.archiveUrl); } })();
  const safeVersion = release.version.replace(/[^A-Za-z0-9._-]/g, "-");
  const target = join(cacheRoot, `${id}-${safeVersion}-${urlName}`);
  await mkdir(cacheRoot, { recursive: true });
  if (await exists(target)) {
    // 缓存复用前逐项复核：文件类型、大小、SHA-256（以及声明的字节数）
    const details = await stat(target);
    if (details.isFile() && details.size <= MAX_ARCHIVE_BYTES && await hashFile(target) === release.archiveSha256 && (release.archiveBytes === undefined || details.size === release.archiveBytes)) return target;
    await rm(target, { force: true });
  }
  const temporary = `${target}.next-${randomUUID()}`;
  let bytes = 0;
  const hash = createHash("sha256");
  // 流式计量器：一边转发数据一边累计字节并计算哈希，超限即中断管道
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_ARCHIVE_BYTES) callback(new Error(`${id} archive exceeds the 1 GiB safety limit`));
      else { hash.update(chunk); callback(null, chunk); }
    },
  });
  try {
    if (/^https?:\/\//i.test(release.archiveUrl)) {
      // github.com 域名附带认证头以便访问私有 / 限流资源
      const response = await fetch(release.archiveUrl, { headers: release.archiveUrl.includes("github.com") ? githubHeaders() : {}, redirect: "follow", signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} while downloading ${release.archiveUrl}`);
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > MAX_ARCHIVE_BYTES) throw new Error(`${id} archive exceeds the 1 GiB safety limit`);
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(temporary, { flags: "wx" }));
    } else {
      // 非下载来源：file: URL 或本地路径，仍经过同一计量与哈希管道
      const source = release.archiveUrl.startsWith("file:") ? new URL(release.archiveUrl) : resolve(release.archiveUrl);
      await pipeline(createReadStream(source), meter, createWriteStream(temporary, { flags: "wx" }));
    }
    const actual = hash.digest("hex");
    // 哈希与字节数都必须与期望完全一致，任何一个不匹配都会失败并丢弃临时文件
    if (actual !== release.archiveSha256) throw new Error(`${id} archive SHA-256 mismatch (expected ${release.archiveSha256}, actual ${actual})`);
    if (release.archiveBytes !== undefined && bytes !== release.archiveBytes) throw new Error(`${id} archive size mismatch (expected ${release.archiveBytes}, actual ${bytes})`);
    await rename(temporary, target);
    return target;
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * 归一化归档条目名：反斜杠统一为正斜杠、去掉结尾分隔符与开头 "./" 前缀，
 * 使不同打包工具产出的等价路径可以统一比较。
 * @param {string} raw 原始条目名
 * @returns {string} 归一化条目名
 */
function normalizeArchiveEntry(raw) {
  let value = raw.replaceAll("\\", "/").replace(/\/$/, "");
  while (value.startsWith("./")) value = value.slice(2);
  return value;
}

/**
 * 解包组件归档到目标目录，解包前后执行多重安全校验。
 * 行为（顺序即防御纵深）：
 * 1. 先 tar -tf 只列条目（不解压）：条目数不超过 20 万；条目名归一化后
 *    禁止 NUL、盘符（冒号）、绝对路径、空段 / "." / ".."（路径穿越）；
 *    大小写不敏感去重，拒绝同名条目冲突（Windows 文件系统大小写不敏感，
 *    同名条目互相覆盖会导致内容不可预测）。
 * 2. tar -xOf 以流式检查解压后总大小不超过 8 GiB（见 assertExpandedSize），
 *    避免 zip 炸弹在真正落盘前就已耗尽磁盘。
 * 3. 实际解包使用 --no-same-owner --no-same-permissions，拒绝归档内
 *    所有权 / 权限位的重放，落盘内容不继承上游打包机的元数据。
 * 4. 解包后递归检查目录树不含符号链接或重解析点（见 assertNoLinks）。
 * @param {string} archive 归档文件路径
 * @param {string} destination 解包目标目录（须不存在）
 */
async function extractArchive(archive, destination) {
  // Windows 自带 tar.exe（System32）；其他平台直接用 PATH 中的 tar
  const tar = process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  const listed = await execFileAsync(tar, ["-tf", archive], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 120_000 });
  const seen = new Set();
  let count = 0;
  for (const raw of listed.stdout.split(/\r?\n/)) {
    const entry = normalizeArchiveEntry(raw);
    if (!entry) continue;
    count += 1;
    if (count > MAX_ARCHIVE_ENTRIES) throw new Error("component archive contains too many entries");
    if (entry.includes("\0") || entry.includes(":") || entry.startsWith("/") || entry.split("/").some((segment) => !segment || segment === "." || segment === "..")) throw new Error(`unsafe component archive entry: ${raw}`);
    // 大小写不敏感查重：防止两个条目在 Windows 上解压到同一目标互相覆盖
    const key = entry.toLowerCase();
    if (seen.has(key)) throw new Error(`duplicate component archive entry: ${raw}`);
    seen.add(key);
  }
  await assertExpandedSize(tar, archive);
  await mkdir(destination, { recursive: false });
  await execFileAsync(tar, ["-xf", archive, "--no-same-owner", "--no-same-permissions", "-C", destination], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true, timeout: 600_000 });
  await assertNoLinks(destination);
}

/**
 * 以流式统计归档解压后的总字节数（tar -xOf 把所有文件内容写到 stdout），
 * 超过 8 GiB 上限立即杀掉子进程并报错，避免解包阶段的磁盘耗尽攻击。
 * 同时捕获 stderr 前若干 KB 便于诊断，整体带 10 分钟超时。
 * @param {string} tar tar 可执行文件路径
 * @param {string} archive 归档文件路径
 */
async function assertExpandedSize(tar, archive) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(tar, ["-xOf", archive], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let bytes = 0;
    let stderr = "";
    let settled = false;
    // finish 只生效一次，保证 resolve/reject 与超时清理不重复触发
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) rejectPromise(error); else resolvePromise();
    };
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_EXPANDED_BYTES) {
        child.kill();
        finish(new Error("component archive expanded size exceeds the 8 GiB safety limit"));
      }
    });
    // stderr 只保留前 64 KiB，防止子进程错误输出本身耗尽内存
    child.stderr.on("data", (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString("utf8"); });
    child.once("error", finish);
    child.once("close", (code) => finish(code === 0 ? undefined : new Error(`cannot inspect expanded component archive (exit ${code}): ${stderr.trim()}`)));
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("component archive expanded-size inspection timed out"));
    }, 600_000);
    timeout.unref();
  });
}

/**
 * 递归断言目录树中不含符号链接 / 重解析点。
 * 组件树必须是纯普通文件与目录：链接既可让路径逃逸到组件根之外，
 * 也会破坏树哈希的可复现性与下游对“文件即文件”的假设。
 * @param {string} root 待检查的目录（或文件）路径
 */
async function assertNoLinks(root) {
  const details = await lstat(root);
  if (details.isSymbolicLink()) throw new Error(`component tree contains a symbolic link or reparse point: ${root}`);
  if (!details.isDirectory()) return;
  for (const entry of await readdir(root)) await assertNoLinks(join(root, entry));
}

/**
 * 计算目录的“树哈希”：递归收集所有普通文件，按 POSIX 风格相对路径
 * 字典序排序后，将 "路径\0文件SHA-256\n" 逐条喂入一个 SHA-256 摘要。
 * 返回值连同文件数一起构成组件树的完整指纹：
 * - 与“入口哈希”配合，锁文件可以断言整个组件树的每一个字节；
 * - 路径排序 + 反斜杠归一化保证跨机器 / 跨次运行结果一致（可复现）；
 * - 任何文件增删改（哪怕只改一个字节或改文件名）都会改变树哈希。
 * @param {string} root 组件根目录
 * @returns {Promise<{hash: string, fileCount: number}>} 树哈希与文件数
 */
async function treeHash(root) {
  const files = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`component tree contains a non-regular entry: ${path}`);
    }
  };
  await visit(root);
  // 排序键使用 / 分隔的相对路径，消除平台分隔符与遍历顺序差异
  files.sort((left, right) => {
    const leftRelative = relative(root, left).replaceAll("\\", "/");
    const rightRelative = relative(root, right).replaceAll("\\", "/");
    return leftRelative < rightRelative ? -1 : leftRelative > rightRelative ? 1 : 0;
  });
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${relative(root, file).replaceAll("\\", "/")}\0${await hashFile(file)}\n`, "utf8");
  return { hash: digest.digest("hex"), fileCount: files.length };
}

/**
 * 按策略中声明的相对路径把组件内的许可证文件（或目录）复制到统一的
 * licenses 输出区，并统计复制的文件数。
 * 防御：许可证路径必须是安全相对路径、必须落在组件根之内、目标必须落在
 * licenses 输出根之内（双重防逃逸）、源不得是符号链接；目录复制使用
 * force:false + errorOnExist，保证不会静默覆盖已有许可证。
 * @param {string} componentRoot 组件根目录
 * @param {string} licenseRoot 该组件的许可证输出目录
 * @param {string} relativePath 策略声明的许可证相对路径
 * @returns {Promise<number>} 本次复制的文件数（路径不存在时为 0）
 */
async function copyLicensePath(componentRoot, licenseRoot, relativePath) {
  if (!safeRelativePath(relativePath)) throw new Error(`unsafe component license path: ${relativePath}`);
  const source = resolve(componentRoot, relativePath);
  if (!pathInside(componentRoot, source) || !await exists(source)) return 0;
  const target = resolve(licenseRoot, relativePath);
  if (!pathInside(licenseRoot, target)) throw new Error(`component license path escapes destination: ${relativePath}`);
  const details = await lstat(source);
  if (details.isSymbolicLink()) throw new Error(`component license is a link: ${source}`);
  await mkdir(dirname(target), { recursive: true });
  if (details.isDirectory()) await cp(source, target, { recursive: true, force: false, errorOnExist: true });
  else await copyFile(source, target);
  const copied = details.isDirectory() ? await treeHash(target) : { fileCount: 1 };
  return copied.fileCount;
}

/**
 * 物化全部四个组件到输出目录的“下一版本”暂存目录。
 * 流程（每个组件）：
 * - 下载（或命中缓存）归档并校验 -> 解包到系统临时目录 -> 定位 archiveRoot
 *   （须存在且在解包目录之内）-> 拷贝到输出暂存区 -> 复核无链接 ->
 *   校验入口（entrypoint 必须是安全相对路径、位于组件根内、是普通文件） ->
 *   计算入口哈希与树哈希。
 * 可复现物化的关键：若传入了期望锁（--locked 模式），逐组件比对入口哈希、
 * 树哈希与文件数，任何偏差立即失败——锁定组件必须能按锁文件原样重建，
 * 树的任何变更都被拒绝。
 * 之后：收集策略声明的许可证（至少一个，否则失败）、生成第三方组件清单
 * THIRD_PARTY_COMPONENTS.json、输出标记 .posixloom-components-output.json
 * （swapOutput 用它识别受管理目录）以及 resolved-components.json
 * （描述各组件在输出目录中的最终位置）。
 * 失败时清理暂存目录，绝不留下半成品输出。
 * @param {object} policy 组件源策略
 * @param {Record<string, object>} releases 组件发布描述（来自上游解析或锁文件）
 * @param {object} [expectedLock] 期望的已提交锁文件（仅 --locked 模式传入）
 * @param {string} outputRoot 最终输出目录
 * @param {string} cacheRoot 归档缓存目录
 * @returns {Promise<{next: string, records: object}>} 暂存目录路径与锁记录
 */
async function materialize(policy, releases, expectedLock, outputRoot, cacheRoot) {
  const parent = dirname(outputRoot);
  // 暂存目录带随机后缀，与现有输出目录隔离；全部成功后才由 swapOutput 原子换入
  const next = join(parent, `.components-next-${randomUUID()}`);
  // 解包在系统临时目录进行，输出目录中不会出现归档中间产物
  const extractionRoot = await mkdtemp(join(tmpdir(), "posixloom-components-"));
  await mkdir(parent, { recursive: true });
  await mkdir(next, { recursive: false });
  const records = {};
  try {
    for (const id of COMPONENT_IDS) {
      const release = releases[id];
      const archive = await downloadArchive(id, release, cacheRoot);
      const extracted = join(extractionRoot, id);
      await extractArchive(archive, extracted);
      // archiveRoot 为 "." 表示归档根即组件根，否则取归档内的子目录
      const sourceRoot = release.archiveRoot === "." ? extracted : resolve(extracted, release.archiveRoot);
      if (!pathInside(extracted, sourceRoot) || !await exists(sourceRoot) || !(await lstat(sourceRoot)).isDirectory()) throw new Error(`${id} archive root is missing or invalid: ${release.archiveRoot}`);
      const componentRoot = join(next, id);
      await cp(sourceRoot, componentRoot, { recursive: true, force: false, errorOnExist: true });
      await assertNoLinks(componentRoot);
      // 入口（node.exe / bash.exe / git.exe / rg.exe）必须真实存在且是普通文件
      const entrypoint = resolve(componentRoot, release.entrypoint);
      if (!safeRelativePath(release.entrypoint) || !pathInside(componentRoot, entrypoint) || !await exists(entrypoint) || !(await lstat(entrypoint)).isFile()) throw new Error(`${id} entrypoint is missing: ${release.entrypoint}`);
      const entrypointSha256 = await hashFile(entrypoint);
      const tree = await treeHash(componentRoot);
      // --locked：与已提交锁逐项比对，树的任何变更都拒绝（可复现物化的核心断言）
      const expected = expectedLock?.components?.[id];
      if (expected && (expected.entrypointSha256 !== entrypointSha256 || expected.rootTreeSha256 !== tree.hash || expected.fileCount !== tree.fileCount)) throw new Error(`${id} extracted component does not match the committed tree lock`);
      const componentLicenseRoot = join(next, "licenses", id);
      let licenseCount = 0;
      for (const licensePath of policy.components[id].licensePaths ?? []) licenseCount += await copyLicensePath(componentRoot, componentLicenseRoot, licensePath);
      if (licenseCount < 1) throw new Error(`${id} did not provide any configured license files`);
      records[id] = {
        version: release.version,
        upstreamTag: release.upstreamTag,
        archiveUrl: release.archiveUrl,
        archiveSha256: release.archiveSha256,
        archiveBytes: (await stat(archive)).size,
        archiveFormat: release.archiveFormat,
        archiveRoot: release.archiveRoot,
        entrypoint: release.entrypoint,
        entrypointSha256,
        rootTreeSha256: tree.hash,
        fileCount: tree.fileCount,
        licensePaths: policy.components[id].licensePaths,
        // ripgrep 以单文件形式分发：额外记录入口 SHA-256 供发布流程直接校验
        ...(id === "ripgrep" ? { sha256: entrypointSha256 } : {}),
      };
      console.log(`${id}: ${release.version} (${tree.fileCount} files)`);
    }
    // 第三方组件清单：记录每个组件的版本、来源 URL 与归档 SHA-256，随产物一并分发
    const notice = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      components: Object.fromEntries(COMPONENT_IDS.map((id) => [id, { version: records[id].version, source: records[id].archiveUrl, archiveSha256: records[id].archiveSha256 }])),
    };
    await writeFile(join(next, "licenses", "THIRD_PARTY_COMPONENTS.json"), `${JSON.stringify(notice, null, 2)}\n`, "utf8");
    // 输出标记：swapOutput 依赖它确认旧输出确由本脚本管理，避免误删无关目录
    await writeFile(join(next, ".posixloom-components-output.json"), `${JSON.stringify({ schemaVersion: 1, platform: "win32-x64" }, null, 2)}\n`, "utf8");
    // 组件位置描述：把每个组件根 / 入口的最终路径交给后续打包流程
    const descriptor = {
      schemaVersion: 1,
      platform: "win32-x64",
      nodeRoot: join(outputRoot, "node"),
      msysRoot: join(outputRoot, "msys2"),
      minGitRoot: join(outputRoot, "mingit"),
      ripgrepExe: join(outputRoot, "ripgrep", "rg.exe"),
      licensesRoot: join(outputRoot, "licenses"),
    };
    await writeFile(join(next, "resolved-components.json"), `${JSON.stringify(descriptor, null, 2)}\n`, "utf8");
    return { next, records };
  } catch (error) {
    // 物化失败：删除暂存目录，绝不污染现有输出
    await rm(next, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(extractionRoot, { recursive: true, force: true });
  }
}

/**
 * 把物化完成的暂存目录原子换入为正式输出目录。
 * 行为：现有输出目录只有在携带 .posixloom-components-output.json 标记时才允许替换
 * （防止误删用户自定义目录）；先 rename 为备份，再换入新目录，随后执行
 * afterSwap 回调（--refresh 模式在此原子写新锁文件，保证输出与锁一起生效）。
 * 若换入或回调失败，删除半成品并回滚备份，恢复原有输出。
 * @param {string} next 物化完成的暂存目录
 * @param {string} outputRoot 最终输出目录
 * @param {() => Promise<void>} afterSwap 换入成功后的回调
 */
async function swapOutput(next, outputRoot, afterSwap) {
  const backup = `${outputRoot}.previous-${randomUUID()}`;
  const hadOutput = await exists(outputRoot);
  if (hadOutput) {
    const marker = join(outputRoot, ".posixloom-components-output.json");
    if (!await exists(marker)) throw new Error(`refusing to replace an unmanaged component output directory: ${outputRoot}`);
    await rename(outputRoot, backup);
  }
  try {
    await rename(next, outputRoot);
    await afterSwap();
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    // 失败回滚：移除半成品输出并恢复备份目录
    await rm(outputRoot, { recursive: true, force: true });
    if (hadOutput) await rename(backup, outputRoot);
    throw error;
  }
}

// ---- 主流程 ----
// 默认路径：策略 packaging/components.sources.json、锁 packaging/components.lock.json、
// 输出 artifacts/components/win32-x64、缓存 artifacts/component-cache
const options = parseArgs(process.argv.slice(2));
const policyPath = resolve(options.policy ?? join(repositoryRoot, "packaging", "components.sources.json"));
const lockPath = resolve(options.lock ?? join(repositoryRoot, "packaging", "components.lock.json"));
const outputRoot = resolve(options.output ?? join(repositoryRoot, "artifacts", "components", "win32-x64"));
const cacheRoot = resolve(options.cache ?? join(repositoryRoot, "artifacts", "component-cache"));
// 输出 / 缓存目录必须是受管理的窄路径，防止清理动作波及仓库或主目录
assertManagedTarget(outputRoot, "component output");
assertManagedTarget(cacheRoot, "component cache");
const policyBytes = await readFile(policyPath);
const policy = JSON.parse(policyBytes.toString("utf8"));
if (policy.policyVersion !== 1 || policy.platform !== "win32-x64" || !policy.components) throw new Error("component source policy must be schema v1 for win32-x64");
const existingLock = await exists(lockPath) ? await readJson(lockPath, "component lock") : undefined;
// --locked 要求锁文件记录的策略哈希与当前策略字节完全一致：策略改动后必须先 --refresh
if (options.locked && existingLock?.policySha256 !== sha256(policyBytes)) throw new Error("component lock does not match the current source policy");

if (options.check) {
  // --check：只读查询上游，按归档 SHA-256 判断是否有组件可更新，输出 JSON 摘要
  const upstream = await resolveUpstream(policy);
  const updates = COMPONENT_IDS.flatMap((id) => {
    const current = existingLock?.components?.[id];
    return current?.archiveSha256 === upstream[id].archiveSha256 ? [] : [{ id, currentVersion: current?.version, availableVersion: upstream[id].version }];
  });
  console.log(JSON.stringify({ status: updates.length ? "updates-available" : "up-to-date", updates }, null, 2));
  process.exit(0);
}

// --locked 必须有锁文件可依；--refresh 走上游解析，否则按锁文件重建
if (options.locked && !existingLock) throw new Error(`component lock is missing: ${lockPath}`);
const releases = options.refresh ? await resolveUpstream(policy) : releasesFromLock(existingLock);
const materialized = await materialize(policy, releases, options.locked ? existingLock : undefined, outputRoot, cacheRoot);
// 判断来源是否变化：策略字节、或任一组件归档 SHA-256 与现有锁不同
const policySha256 = sha256(policyBytes);
const sourceChanged = !existingLock || existingLock.policySha256 !== policySha256 || COMPONENT_IDS.some((id) => existingLock.components?.[id]?.archiveSha256 !== materialized.records[id].archiveSha256);
// updateSequence 单调递增：同核心版本的纯环境重建也能被更新器按序号排序。
const updateSequence = sourceChanged ? Math.max(Math.floor(Date.now() / 1000), (existingLock?.updateSequence ?? 0) + 1) : existingLock.updateSequence;
const nextLock = {
  lockVersion: 2,
  platform: "win32-x64",
  updateSequence,
  generatedAt: sourceChanged ? new Date().toISOString() : existingLock.generatedAt,
  policySha256,
  components: materialized.records,
};
// 输出目录换入成功后才写锁文件（仅 --refresh 模式），保证二者一致地对外可见
await swapOutput(materialized.next, outputRoot, async () => {
  if (options.refresh) await atomicWrite(lockPath, `${JSON.stringify(nextLock, null, 2)}\n`);
});
console.log(`materialized components: ${outputRoot}`);
console.log(`component lock: ${lockPath} (update sequence ${updateSequence})`);
