/**
 * 运行时自动更新模块（签名事务式更新）。
 *
 * 职责：
 * - 拉取并验证 Ed25519 签名的更新 feed（verifyUpdateFeed）；
 * - 按本机平台选择可用的候选版本（RuntimeUpdater.check）；
 * - 下载、校验、解压、安装 Runtime 归档并事务式切换当前指针（update / install）；
 * - 回滚到上一个 Runtime 选择（rollback）。
 *
 * 设计意图：
 * - 签名不可关闭：更新内容是可执行文件与 shell 环境，本质是「远程代码交付」。
 *   因此当当前 Runtime 来自非 development 源、或 manifest 处于 release 模式时，
 *   禁用签名验证会被直接拒绝（UPDATE_SIGNATURE_REQUIRED），防止配置失误把
 *   未认证的更新包安装进系统。
 * - 以完整 Runtime 归档为更新单位：归档整体受 SHA-256 约束，归档内 manifest 与
 *   签名 feed 逐字段核对身份；更新是「整树替换」而非增量打补丁，不存在未被签名
 *   覆盖的中间状态，任何一份落盘内容都能独立验证。
 * - 事务式指针提交：安装全程不修改任何既有文件，仅在最后一步原子写
 *   dataRoot/runtime/current 指针并更新 updates/state.json；state 写入失败时恢复
 *   旧指针（补偿式事务），旧版本目录始终保留，失败与回滚都有退路。
 * - staging 解压后先验证再移入：归档解压到随机命名的暂存目录，通过哈希、大小、
 *   manifest 身份、整树校验、无符号链接、基础组件齐全等全部检查后，才 rename 进
 *   versions/<id> 正式目录——未验证内容永远不会出现在正式目录中。
 * - 回滚设计：state.history 保留最近的选择记录（上限 20 条），rollback() 在校验
 *   回滚目标依然有效后重新提交指针；data 源指向 versions 目录，
 *   bundled/development 源则删除 dataRoot 指针、回退到发行包内置选择。
 *
 * 每个校验环节（URL 解析、大小、SHA-256、manifest 身份、整树哈希、基础组件、
 * 无符号链接等）都使用独立的 UPDATE_* 错误码，便于精确定位失败点。
 */
import { createHash, createPublicKey, randomUUID, verify } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { PosixLoomError } from "./errors.js";
import { isSafeRuntimeId } from "./config.js";
import { runProcess } from "./process.js";
import { readJsonSafe, REQUIRED_RUNTIME_COMPONENTS, RuntimeManager, validateRuntimeManifest } from "./runtime.js";
import type { RuntimeManifest } from "./types.js";

/** 当前支持的更新 feed 结构版本；版本不符的 feed 一律按非法处理，由发布端升版本号演进。 */
const UPDATE_FEED_VERSION = 1;

/**
 * 更新 feed 中的单个 Runtime 发布条目（位于 signed 载荷内，受签名保护）。
 * 所有字段的取值都经 isRuntimeRelease 严格校验，畸形条目在进入下载/安装流程前即被拒绝。
 */
export interface RuntimeRelease {
  /** Runtime 标识；必须是安全字符集（isSafeRuntimeId），最终作为 versions/ 下的子目录名。 */
  runtimeId: string;
  /** 语义化版本号（如 1.2.3 / 1.2.3-rc.1），是候选排序的主序。 */
  runtimeSemver: string;
  /** 同一 semver 内的发布序号（补丁重发时递增），作为排序次序；缺省按 0 参与比较。 */
  updateSequence?: number;
  /** 目标平台标识（如 win32-x64）；检查时与本机 platformId() 精确匹配。 */
  platform: string;
  /** 归档下载地址：绝对 http(s)/file URL、绝对路径，或相对 feedUrl 的引用（见 resolveUpdateResource）。 */
  archiveUrl: string;
  /** 归档 SHA-256（64 位十六进制）；下载后独立比对，是归档完整性的最终裁判。 */
  archiveSha256: string;
  /** 归档字节数（可选）；声明时与实际下载大小严格比对，与哈希形成双重防篡改/防截断。 */
  archiveBytes?: number;
  /** 归档格式；当前仅支持 zip。 */
  archiveFormat?: "zip";
  /** 归档内 Runtime 的根目录（可选）；必须是安全相对路径，防止定位越出解压目录。 */
  archiveRoot?: string;
  /** manifest.json 的 SHA-256（可选）；用于识别「同 id 但内容不同」的版本目录冲突。 */
  manifestSha256?: string;
  /** 发布时间（可选，ISO 8601 字符串），仅作元信息。 */
  publishedAt?: string;
}

/**
 * 更新 feed 顶层结构：signed 是被签名的载荷（canonicalJson 规范化后作为签名输入），
 * signatures 是 Ed25519 签名列表，任一受信 key 的签名通过即视为 feed 可信。
 */
export interface RuntimeUpdateFeed {
  /** feed 结构版本，必须等于 UPDATE_FEED_VERSION。 */
  feedVersion: number;
  /** 受签名保护的载荷本体。 */
  signed: {
    /** 更新通道（如 stable/beta）；必须与本地配置一致，防止错通道内容被安装。 */
    channel: string;
    /** feed 生成时间（ISO 字符串），用于诊断 feed 新鲜度。 */
    generatedAt: string;
    /** 本通道提供的 Runtime 发布列表。 */
    runtimes: RuntimeRelease[];
  };
  /** 签名列表；keyId 必须命中受信公钥表才会参与验证（支持多签名与密钥轮换）。 */
  signatures: Array<{
    keyId: string;
    algorithm: "ed25519";
    value: string;
  }>;
}

/** 历史记录条目：某次生效选择的 Runtime id 及其来源（bundled=随发行包、data=下载安装、development=开发目录）。 */
interface UpdateHistoryEntry {
  runtimeId: string;
  source: "bundled" | "data" | "development";
}

/** 持久化在 dataRoot/updates/state.json 的更新状态：检查间隔门控、当前生效选择与回滚历史。 */
interface UpdateState {
  /** 上次检查更新的时间（ISO 字符串），用于 checkIntervalMs 门控。 */
  lastCheckedAt?: string;
  /** 当前生效的历史条目（应与 dataRoot/runtime/current 指针一致）。 */
  active?: UpdateHistoryEntry;
  /** 按时间倒序的回滚历史，上限 20 条。 */
  history: UpdateHistoryEntry[];
  /** 上次检查/安装的错误摘要，供诊断。 */
  lastError?: string;
}

/** install/rollback 期间持有的排它锁句柄；release() 经 token 校验后才删除锁文件。 */
interface UpdateLock {
  release(): Promise<void>;
}

/** 校验单个历史条目的结构（runtimeId 安全字符集 + 来源枚举），用于读取持久化状态时的防篡改检查。 */
function isHistoryEntry(value: unknown): value is UpdateHistoryEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<UpdateHistoryEntry>;
  return typeof entry.runtimeId === "string"
    && isSafeRuntimeId(entry.runtimeId)
    && (entry.source === "bundled" || entry.source === "data" || entry.source === "development");
}

/** check() 的结果：未启用 / 未配置 / 间隔未到 / 已是最新（均无 release），或发现可用更新（携带 release）。 */
export type UpdateCheckResult =
  | { status: "disabled" | "not-configured" | "interval-not-elapsed" | "up-to-date"; release?: undefined }
  | { status: "available"; release: RuntimeRelease };

/** update() 的结果：未触发安装时透传 check 的状态；安装成功则携带旧 id 且需重启进程加载新 Runtime。 */
export type UpdateApplyResult =
  | { status: "up-to-date" | "disabled" | "not-configured" | "interval-not-elapsed"; runtimeId: string }
  | { status: "installed"; runtimeId: string; previousRuntimeId: string; restartRequired: true };

/** 递归规范化：数组保持顺序，对象按键名字典序重排并递归处理子值；输出结构等价但字节确定的形态。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

/**
 * 规范化 JSON 序列化（键名递归排序）。
 * 签名覆盖的是 feed.signed 对象，必须先规范化再序列化，才能保证「签名时」与
 * 「验证时」对同一对象得到逐字节相同的输入--否则对象属性顺序的细微差异
 * 会让本有效的签名无谓失败。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** 本机平台标识（如 win32-x64），与 feed 中 release.platform 精确匹配。 */
function platformId(): string {
  return `${process.platform}-${process.arch}`;
}

/**
 * 判断是否为「安全的相对路径」：非空、不含 NUL 与盘符冒号、非绝对路径、不以分隔符开头，
 * 且按 / 与 \ 切分后不含空段、"." 与 ".."。用于 archiveRoot 等取值校验，
 * 与解压脚本内的同类检查共同阻断路径穿越（Zip Slip）。
 */
function safeRelativePath(value: string): boolean {
  return Boolean(value)
    && !value.includes("\0")
    && !value.includes(":")
    && !isAbsolute(value)
    && !value.startsWith("/")
    && !value.startsWith("\\")
    && value.split(/[\\/]/).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

/** 判断 candidate 是否位于 root 之内（含恰好等于 root）；Windows 下按大小写不敏感比较。 */
function pathIsInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const insensitive = process.platform === "win32";
  const left = insensitive ? rootPath.toLowerCase() : rootPath;
  const right = insensitive ? candidatePath.toLowerCase() : candidatePath;
  return right === left || right.startsWith(`${left}${sep}`);
}

/**
 * 递归扫描目录，遇到符号链接即抛 UPDATE_ARCHIVE_LINK。
 * 符号链接可以指向归档之外（甚至网络位置），使后续整树哈希校验失效，故更新内容一律禁止。
 */
async function assertNoLinks(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    const details = await lstat(path);
    if (details.isSymbolicLink()) throw new PosixLoomError("UPDATE_ARCHIVE_LINK", "Runtime update archives cannot contain symbolic links", { path });
    if (entry.isDirectory()) await assertNoLinks(path);
  }
}

/** 解析 semver 的主版本三元组与可选 prerelease；无法解析时按 0.0.0 处理并把原串留作 prerelease（排序时视为最低）。 */
function semverParts(value: string): { core: number[]; prerelease?: string } {
  const match = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return { core: [0, 0, 0], prerelease: value };
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4] };
}

/**
 * 单个 release 条目的 schema 校验：id 安全性、semver 格式、updateSequence 非负安全整数、
 * platform 格式、archiveUrl 非空且无 NUL、哈希为 64 位十六进制、字节数为正整数、
 * 格式仅 zip、archiveRoot 为安全相对路径或 "."、publishedAt 可被 Date.parse 解析。
 * 任一项不满足即视为整份 feed 非法，在下载前就拦截。
 */
function isRuntimeRelease(value: unknown): value is RuntimeRelease {
  if (!value || typeof value !== "object") return false;
  const release = value as Partial<RuntimeRelease>;
  return typeof release.runtimeId === "string"
    && isSafeRuntimeId(release.runtimeId)
    && typeof release.runtimeSemver === "string"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release.runtimeSemver)
    && (release.updateSequence === undefined || (Number.isSafeInteger(release.updateSequence) && release.updateSequence >= 0))
    && typeof release.platform === "string"
    && /^[a-z0-9]+-[A-Za-z0-9._-]+$/.test(release.platform)
    && typeof release.archiveUrl === "string"
    && release.archiveUrl.length > 0
    && !release.archiveUrl.includes("\0")
    && typeof release.archiveSha256 === "string"
    && /^[a-f0-9]{64}$/i.test(release.archiveSha256)
    && (release.archiveBytes === undefined || (Number.isSafeInteger(release.archiveBytes) && release.archiveBytes > 0))
    && (release.archiveFormat === undefined || release.archiveFormat === "zip")
    && (release.archiveRoot === undefined || (typeof release.archiveRoot === "string" && (release.archiveRoot === "." || safeRelativePath(release.archiveRoot))))
    && (release.manifestSha256 === undefined || (typeof release.manifestSha256 === "string" && /^[a-f0-9]{64}$/i.test(release.manifestSha256)))
    && (release.publishedAt === undefined || (typeof release.publishedAt === "string" && Number.isFinite(Date.parse(release.publishedAt))));
}

/**
 * 比较两个语义化版本。
 * @returns left < right 返回负数；相等返回 0；left > right 返回正数。
 * 规则：主三元组按数值比较；无 prerelease 者高于有 prerelease 者（1.0.0 > 1.0.0-rc.1）；
 * prerelease 之间按英文区域、数值感知的字符串比较。
 */
export function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.core[index] !== b.core[index]) return a.core[index] - b.core[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease.localeCompare(b.prerelease, "en", { numeric: true });
}

/**
 * 比较两个 Runtime 发布的排序键：semver 为主序，updateSequence 为次序
 * （同 semver 重发补丁的场景），缺省的 updateSequence 按 0 参与比较。
 * @returns 返回值语义与 compareSemver 相同（负/零/正）。
 */
export function compareRuntimeRelease(left: Pick<RuntimeRelease, "runtimeSemver" | "updateSequence">, right: Pick<RuntimeRelease, "runtimeSemver" | "updateSequence">): number {
  const semver = compareSemver(left.runtimeSemver, right.runtimeSemver);
  if (semver !== 0) return semver;
  return (left.updateSequence ?? 0) - (right.updateSequence ?? 0);
}

/**
 * 把 feed 中的 archiveUrl 解析为可下载的绝对地址：
 * - 本身是 http(s)/file URL 或绝对路径：原样返回；
 * - 相对 http(s)/file 形式的 feedUrl：按 URL 语义拼接；
 * - 相对普通文件路径的 feedUrl：按文件系统路径拼接。
 * 下载内容最终仍受签名 feed 中的哈希与大小校验约束。
 */
export function resolveUpdateResource(base: string, target: string): string {
  if (/^https?:\/\//i.test(target) || /^file:/i.test(target) || isAbsolute(target)) return target;
  if (/^https?:\/\//i.test(base) || /^file:/i.test(base)) return new URL(target, base).toString();
  return resolve(dirname(base), target);
}

/**
 * 读取更新 feed 等小型资源并完整载入内存。
 * - http(s)：带超时与重定向跟随；先核对 content-length 上限，再在流式读取中逐块计数，
 *   防止声明头撒谎造成内存放大（UPDATE_RESOURCE_TOO_LARGE / UPDATE_HTTP_FAILED）；
 * - file URL 或本地路径：stat 与实际读取做双重大小检查。
 * @param maxBytes 字节上限（feed 固定 4MB）。
 */
async function readResource(resource: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  if (!/^https?:\/\//i.test(resource)) {
    const path = resource.startsWith("file:") ? new URL(resource) : resource;
    const details = await stat(path);
    if (details.size > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes: details.size, maxBytes });
    const contents = await readFile(path);
    if (contents.length > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes: contents.length, maxBytes });
    return contents;
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetch(resource, { signal, redirect: "follow" });
  if (!response.ok) throw new PosixLoomError("UPDATE_HTTP_FAILED", `Update server returned HTTP ${response.status}`, { resource, status: response.status });
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes: declared, maxBytes });
  if (!response.body) throw new PosixLoomError("UPDATE_HTTP_FAILED", "Update server returned an empty response body", { resource });
  const stream = Readable.fromWeb(response.body as any);
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) throw new PosixLoomError("UPDATE_RESOURCE_TOO_LARGE", "Update resource exceeds the configured size limit", { resource, bytes, maxBytes });
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks, bytes);
}

/**
 * 流式下载（http(s)）或复制（本地路径）归档到 target，边写盘边计算 SHA-256。
 * Transform 计量器在累计超过 maxBytes 时立即中断（UPDATE_ARCHIVE_TOO_LARGE），
 * 写入端使用 "wx" 独占创建，绝不覆盖既有文件。
 * @returns 归档的 SHA-256（hex）与实际字节数，供与签名 feed 比对。
 */
async function downloadAndHash(resource: string, target: string, timeoutMs: number, maxBytes: number): Promise<{ sha256: string; bytes: number }> {
  await mkdir(dirname(target), { recursive: true });
  const hash = createHash("sha256");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > maxBytes) callback(new PosixLoomError("UPDATE_ARCHIVE_TOO_LARGE", "Runtime archive exceeds the configured size limit", { maxBytes }));
      else { hash.update(chunk); callback(null, chunk); }
    },
  });
  if (/^https?:\/\//i.test(resource)) {
    const response = await fetch(resource, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    if (!response.ok || !response.body) throw new PosixLoomError("UPDATE_HTTP_FAILED", `Update server returned HTTP ${response.status}`, { resource, status: response.status });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new PosixLoomError("UPDATE_ARCHIVE_TOO_LARGE", "Runtime archive exceeds the configured size limit", { declared, maxBytes });
    await pipeline(Readable.fromWeb(response.body as any), meter, createWriteStream(target, { flags: "wx" }));
  } else {
    const source = resource.startsWith("file:") ? new URL(resource) : resource;
    await pipeline(createReadStream(source), meter, createWriteStream(target, { flags: "wx" }));
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** 流式计算整个文件的 SHA-256（hex），用于 manifest 哈希比对。 */
async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), new Transform({ transform(chunk: Buffer, _encoding, callback) { hash.update(chunk); callback(); } }));
  return hash.digest("hex");
}

/**
 * 原子写文件：先写随机后缀的临时文件，再 rename 覆盖目标。
 * 读者要么看到旧内容、要么看到完整新内容，不会读到写了一半的 JSON；
 * 无论成败都清理临时文件（仅当无业务错误时才把清理失败抛出）。
 */
async function atomicWrite(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.next-${randomUUID()}`;
  let operationError: unknown;
  try {
    await writeFile(temporary, contents, "utf8");
    await rename(temporary, path);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { await rm(temporary, { force: true }); } catch (cleanupError) { if (!operationError) throw cleanupError; }
  }
}

/**
 * 读取并校验持久化状态 state.json；文件不存在时返回空历史状态。
 * 对 lastCheckedAt / active / history 逐字段验证，发现篡改或损坏立即抛
 * UPDATE_STATE_INVALID，而不是带着不可信的状态继续做更新决策。
 */
async function readState(path: string): Promise<UpdateState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<UpdateState>;
    if (parsed.lastCheckedAt !== undefined && (typeof parsed.lastCheckedAt !== "string" || !Number.isFinite(Date.parse(parsed.lastCheckedAt)))) throw new Error("lastCheckedAt is invalid");
    if (parsed.active !== undefined && !isHistoryEntry(parsed.active)) throw new Error("active entry is invalid");
    if (parsed.history !== undefined && (!Array.isArray(parsed.history) || parsed.history.some((entry) => !isHistoryEntry(entry)))) throw new Error("history entry is invalid");
    return {
      lastCheckedAt: typeof parsed.lastCheckedAt === "string" ? parsed.lastCheckedAt : undefined,
      active: parsed.active,
      history: parsed.history ?? [],
      lastError: typeof parsed.lastError === "string" ? parsed.lastError : undefined,
    };
  } catch (error: any) {
    if (error?.code === "ENOENT") return { history: [] };
    throw new PosixLoomError("UPDATE_STATE_INVALID", `Unable to read update state: ${path}`, { path, cause: String(error) });
  }
}

/**
 * 验证更新 feed：结构校验 -> 逐条 release 校验 -> (platform, runtimeId) 去重 ->
 * channel 匹配 -> Ed25519 签名验证。
 *
 * @param channel 期望的更新通道；不匹配抛 UPDATE_CHANNEL_MISMATCH，防止错通道内容被安装。
 * @param requireSignature 是否执行签名验证；「release Runtime 必须签名」的强制策略
 *        由调用方（check）负责拦截，本函数只按参数执行。
 * @param trustedKeys 受信公钥表（keyId -> 公钥文本）。任一受信 key 的签名通过即可，
 *        便于密钥轮换期新旧 key 并存。
 * @throws UPDATE_FEED_INVALID feed 结构非法、release 条目非法，或存在重复的
 *         (platform, runtimeId)（重复条目会让「该取哪个」变得不确定，必须拒绝）。
 * @throws UPDATE_CHANNEL_MISMATCH 通道不匹配。
 * @throws UPDATE_SIGNATURE_INVALID 没有任何来自受信 key 的有效签名。
 *
 * 签名验证细节：对 feed.signed 做 canonicalJson 后取 UTF-8 字节作为输入，
 * crypto.verify(null, 数据, 公钥, base64 签名) 即 Ed25519 纯签名（无摘要）模式；
 * 单个签名在公钥构造或验证异常时仅计为无效，继续尝试其余签名。
 */
export function verifyUpdateFeed(feed: RuntimeUpdateFeed, channel: string, requireSignature: boolean, trustedKeys: Record<string, string>): void {
  if (!feed || typeof feed !== "object" || feed.feedVersion !== UPDATE_FEED_VERSION || !feed.signed || typeof feed.signed !== "object" || typeof feed.signed.channel !== "string" || !feed.signed.channel || typeof feed.signed.generatedAt !== "string" || !Number.isFinite(Date.parse(feed.signed.generatedAt)) || !Array.isArray(feed.signed.runtimes) || !Array.isArray(feed.signatures)) {
    throw new PosixLoomError("UPDATE_FEED_INVALID", "Update feed schema is invalid");
  }
  if (feed.signed.runtimes.some((release) => !isRuntimeRelease(release))) throw new PosixLoomError("UPDATE_FEED_INVALID", "Update feed contains an invalid Runtime release");
  const releaseKeys = new Set<string>();
  for (const release of feed.signed.runtimes) {
    const key = `${release.platform}\0${release.runtimeId}`;
    if (releaseKeys.has(key)) throw new PosixLoomError("UPDATE_FEED_INVALID", "Update feed contains duplicate Runtime release identities", { platform: release.platform, runtimeId: release.runtimeId });
    releaseKeys.add(key);
  }
  if (feed.signed.channel !== channel) throw new PosixLoomError("UPDATE_CHANNEL_MISMATCH", "Update feed channel does not match configuration", { expected: channel, actual: feed.signed.channel });
  if (!requireSignature) return;
  const signedBytes = Buffer.from(canonicalJson(feed.signed), "utf8");
  const valid = feed.signatures.some((signature) => {
    if (!signature || typeof signature !== "object" || signature.algorithm !== "ed25519" || typeof signature.keyId !== "string" || typeof signature.value !== "string" || !trustedKeys[signature.keyId]) return false;
    try {
      return verify(null, signedBytes, createPublicKey(trustedKeys[signature.keyId]), Buffer.from(signature.value, "base64"));
    } catch {
      return false;
    }
  });
  if (!valid) throw new PosixLoomError("UPDATE_SIGNATURE_INVALID", "Update feed has no valid signature from a trusted key");
}

/**
 * 运行时更新器：编排「检查 -> 下载 -> 验证 -> 安装 -> 提交/回滚」全流程，
 * 状态持久化在 <dataRoot>/updates/state.json。
 *
 * 相关目录布局：
 * - <dataRoot>/updates/state.json -- 更新状态（上次检查时间、当前选择、回滚历史）；
 * - <dataRoot>/updates/update.lock -- install/rollback 共用的互斥锁；
 * - <dataRoot>/updates/<id>-<uuid>.zip -- 下载的归档（用后即删）；
 * - <dataRoot>/runtime/staging/<id>-<uuid>/ -- 解压与验证的暂存目录（用后即删）；
 * - <dataRoot>/runtime/versions/<id>/ -- 通过全部校验的正式版本目录（保留供回滚）；
 * - <dataRoot>/runtime/current -- 当前选择的 Runtime id 指针（事务提交点）。
 */
export class RuntimeUpdater {
  private readonly updateRoot: string;
  private readonly statePath: string;

  /** @param runtime 宿主 RuntimeManager，提供运行配置、当前快照与原生宿主路径。 */
  constructor(private readonly runtime: RuntimeManager) {
    this.updateRoot = join(runtime.config.dataRoot, "updates");
    this.statePath = join(this.updateRoot, "state.json");
  }

  /**
   * 检查更新（不安装）。
   *
   * 步骤：
   * 1. 门控：未启用 -> disabled；未配置 feedUrl -> not-configured；
   *    当前 Runtime 来自非 development 源、或处于 release 模式时禁用签名验证
   *    属于策略违规，直接抛 UPDATE_SIGNATURE_REQUIRED；
   * 2. 间隔门控：距上次检查不足 checkIntervalMs（默认 24h）返回
   *    interval-not-elapsed，options.force 可跳过；
   * 3. 读取 feed（http/file，4MB 上限）并经 verifyUpdateFeed 全量验证（含签名）；
   * 4. 按本机平台过滤候选、降序排序，取第一个 semver+updateSequence 严格大于
   *    当前的候选；恢复模式下改取任意 id 不同的候选（用于修复损坏的当前版本）；
   * 5. 原子写 state：成功记录 lastCheckedAt，失败记录 lastError 后原样抛出。
   *
   * @param options.force 跳过检查间隔门控，立即检查。
   * @returns 有可用更新时携带 release；否则返回对应的非安装状态。
   * @throws UPDATE_SIGNATURE_REQUIRED / UPDATE_FEED_INVALID / UPDATE_CHANNEL_MISMATCH /
   *         UPDATE_SIGNATURE_INVALID / UPDATE_RESOURCE_TOO_LARGE / UPDATE_HTTP_FAILED /
   *         UPDATE_STATE_INVALID 等来自各环节的 PosixLoomError。
   */
  async check(options: { force?: boolean } = {}): Promise<UpdateCheckResult> {
    const config = this.runtime.config.runtime.updates;
    if (!config.enabled) return { status: "disabled" };
    if (!config.feedUrl) return { status: "not-configured" };
    // 签名不可关闭：release 模式（或非 development 源）下关闭签名验证直接拒绝。
    if ((this.runtime.snapshot.source !== "development" || this.runtime.snapshot.manifest.mode === "release") && !config.requireSignature) {
      throw new PosixLoomError("UPDATE_SIGNATURE_REQUIRED", "Release Runtime updates cannot disable feed signature verification");
    }
    const state = await readState(this.statePath);
    // 间隔门控：距上次检查不足 checkIntervalMs 则跳过本次拉取（force 可强制）。
    if (!options.force && state.lastCheckedAt && Date.now() - Date.parse(state.lastCheckedAt) < config.checkIntervalMs) {
      return { status: "interval-not-elapsed" };
    }
    try {
      const bytes = await readResource(config.feedUrl, config.requestTimeoutMs, 4 * 1024 * 1024);
      let feed: RuntimeUpdateFeed;
      try {
        feed = JSON.parse(bytes.toString("utf8")) as RuntimeUpdateFeed;
      } catch (error) {
        throw new PosixLoomError("UPDATE_FEED_INVALID", "Update feed is not valid JSON", { cause: String(error) });
      }
      verifyUpdateFeed(feed, config.channel, config.requireSignature, config.trustedKeys);
      // 按本机平台过滤候选并降序排序（semver 主序、updateSequence 次序），
      // 使随后的 find 拿到的就是最新可用候选。
      const candidates = feed.signed.runtimes
        .filter((release) => isRuntimeRelease(release))
        .filter((release) => release.platform === platformId())
        .sort((left, right) => compareRuntimeRelease(right, left));
      const currentSemver = typeof this.runtime.snapshot.manifest.runtimeSemver === "string" ? this.runtime.snapshot.manifest.runtimeSemver : "0.0.0";
      const currentUpdateSequence = Number.isSafeInteger(this.runtime.snapshot.manifest.updateSequence) ? this.runtime.snapshot.manifest.updateSequence : 0;
      // 正常模式：取第一个严格大于当前版本的候选（semver+updateSequence 双比较）；
      // 恢复模式：当前 data 源 Runtime 已损坏，任何 id 不同的候选都可接受，
      // 借更新通道修复本地损坏的版本。
      const release = candidates.find((candidate) => this.runtime.recoveryRequired
        ? this.runtime.snapshot.source !== "data" || candidate.runtimeId !== this.runtime.snapshot.runtimeId
        : compareRuntimeRelease(candidate, { runtimeSemver: currentSemver, updateSequence: currentUpdateSequence }) > 0);
      await atomicWrite(this.statePath, `${JSON.stringify({ ...state, lastCheckedAt: new Date().toISOString(), lastError: undefined }, null, 2)}\n`);
      return release ? { status: "available", release } : { status: "up-to-date" };
    } catch (error) {
      // 失败路径：把错误摘要记入 lastError 后原样抛出；若连状态都写不进去，
      // 把该记录错误附加到 details.stateRecordError 便于诊断。
      try {
        await atomicWrite(this.statePath, `${JSON.stringify({ ...state, lastError: String(error) }, null, 2)}\n`);
      } catch (recordError) {
        if (error instanceof PosixLoomError) error.details.stateRecordError = String(recordError);
      }
      throw error;
    }
  }

  /**
   * 检查并安装可用更新（check + install 的组合入口）。
   *
   * check 未发现可用更新时直接透传其状态；进入安装后若失败，会清除 lastCheckedAt
   * （让下次 update 重新走完整检查）并记录 lastError，然后原样抛出。
   *
   * @param options.force 跳过检查间隔门控。
   * @returns 安装成功时 status 为 "installed" 且 restartRequired 恒为 true--
   *          新 Runtime 需重启进程才会被加载。
   */
  async update(options: { force?: boolean } = {}): Promise<UpdateApplyResult> {
    const checked = await this.check(options);
    if (checked.status !== "available") return { status: checked.status, runtimeId: this.runtime.snapshot.runtimeId };
    try {
      return await this.install(checked.release);
    } catch (error) {
      try {
        const state = await readState(this.statePath);
        await atomicWrite(this.statePath, `${JSON.stringify({ ...state, lastCheckedAt: undefined, lastError: String(error) }, null, 2)}\n`);
      } catch (recordError) {
        if (error instanceof PosixLoomError) error.details.stateRecordError = String(recordError);
      }
      throw error;
    }
  }

  /**
   * 安装单个 release（私有核心流程，全程持有 update.lock 互斥）。
   * 任何一步失败都不触碰既有 Runtime 目录与 current 指针；
   * staging、归档与锁在 finally 中统一回收，清理错误聚合进 cleanupErrors。
   *
   * 阶段流水线（每步防什么见行内注释）：
   * 加锁 -> 入参复核 -> 下载并哈希 -> 哈希/大小比对 -> 解压 staging -> 防链接 ->
   * archiveRoot 定位 -> manifest 身份校验 -> manifest 哈希与整树校验 ->
   * 基础组件检查 -> 移入 versions -> 事务提交指针。
   *
   * @returns 恒为 {status:"installed", restartRequired:true}：指针已切换，需重启生效。
   * @throws UPDATE_RUNTIME_ID_INVALID / UPDATE_ARCHIVE_FORMAT_UNSUPPORTED /
   *         UPDATE_HTTP_FAILED / UPDATE_ARCHIVE_TOO_LARGE / UPDATE_ARCHIVE_HASH_MISMATCH /
   *         UPDATE_ARCHIVE_SIZE_MISMATCH / UPDATE_ARCHIVE_LINK / UPDATE_ARCHIVE_ROOT_INVALID /
   *         UPDATE_MANIFEST_MISSING / UPDATE_MANIFEST_IDENTITY_MISMATCH /
   *         UPDATE_MANIFEST_HASH_MISMATCH / UPDATE_RUNTIME_VALIDATION_FAILED /
   *         UPDATE_COMPONENTS_MISSING / UPDATE_DESTINATION_CONFLICT /
   *         UPDATE_EXTRACTION_FAILED / UPDATE_ALREADY_RUNNING 及提交阶段的错误。
   */
  private async install(release: RuntimeRelease): Promise<UpdateApplyResult> {
    // 先取互斥锁，再登记当前选择（回滚目标）与本次使用的暂存/归档路径（随机后缀防冲突）。
    const lockPath = join(this.updateRoot, "update.lock");
    const lock = await this.acquireLock(lockPath);
    const previous: UpdateHistoryEntry = { runtimeId: this.runtime.snapshot.runtimeId, source: this.runtime.snapshot.source };
    const staging = join(this.runtime.config.dataRoot, "runtime", "staging", `${release.runtimeId}-${randomUUID()}`);
    const archive = join(this.updateRoot, `${release.runtimeId}-${randomUUID()}.zip`);
    let operationError: unknown;
    try {
      // 阶段 1 入参复核：runtimeId 将成为 versions/ 子目录名，再次确保安全字符集。
      if (!isSafeRuntimeId(release.runtimeId)) throw new PosixLoomError("UPDATE_RUNTIME_ID_INVALID", "Update Runtime id is invalid", { runtimeId: release.runtimeId });
      // 阶段 2 下载：归档格式仅支持 zip；下载地址相对 feedUrl 解析，
      // 流式落盘并同步计算 SHA-256（requestTimeoutMs 超时、maxDownloadBytes 上限、"wx" 独占创建）。
      if (release.archiveFormat && release.archiveFormat !== "zip") throw new PosixLoomError("UPDATE_ARCHIVE_FORMAT_UNSUPPORTED", "Only ZIP Runtime update archives are supported", { archiveFormat: release.archiveFormat });
      const resource = resolveUpdateResource(this.runtime.config.runtime.updates.feedUrl ?? "", release.archiveUrl);
      const downloaded = await downloadAndHash(resource, archive, this.runtime.config.runtime.updates.requestTimeoutMs, this.runtime.config.runtime.updates.maxDownloadBytes);
      // 阶段 3 完整性比对：SHA-256 必须与签名 feed 声明一致（哈希是归档可信的最终裁判）；
      // feed 声明 archiveBytes 时字节数也必须一致，与哈希形成双重防篡改/防截断。
      if (downloaded.sha256.toLowerCase() !== release.archiveSha256.toLowerCase()) {
        throw new PosixLoomError("UPDATE_ARCHIVE_HASH_MISMATCH", "Downloaded Runtime archive hash does not match the signed feed", { expected: release.archiveSha256, actual: downloaded.sha256 });
      }
      if (release.archiveBytes !== undefined && downloaded.bytes !== release.archiveBytes) {
        throw new PosixLoomError("UPDATE_ARCHIVE_SIZE_MISMATCH", "Downloaded Runtime archive size does not match the signed feed", { expected: release.archiveBytes, actual: downloaded.bytes });
      }
      // 阶段 4 解压：解压到全新的 staging 目录（先建目录，ExtractToDirectory 需要目标存在）；
      // 内嵌脚本自带 Zip Slip、重复条目、条目数与展开大小防护，见 extractZip。
      await mkdir(staging, { recursive: false });
      await this.extractZip(archive, staging);
      await assertNoLinks(staging);
      // 阶段 5 候选定位：符号链接一律禁止（可指向归档外，绕过整树校验）；
      // archiveRoot 必须是安全相对路径且不得越出 staging 目录。
      const archiveRoot = release.archiveRoot ?? ".";
      if (!safeRelativePath(archiveRoot) && archiveRoot !== ".") throw new PosixLoomError("UPDATE_ARCHIVE_ROOT_INVALID", "archiveRoot must be a safe relative path", { archiveRoot });
      const candidate = resolve(staging, archiveRoot);
      if (!pathIsInside(staging, candidate)) throw new PosixLoomError("UPDATE_ARCHIVE_ROOT_INVALID", "archiveRoot escapes the staging directory", { archiveRoot });
      // 阶段 6 manifest 身份：runtimeId/semver/updateSequence 与 mode=release 必须
      // 与签名 feed 完全一致，防止「张冠李戴」的归档冒充目标版本。
      const manifestPath = join(candidate, "manifest.json");
      const manifest = readJsonSafe<RuntimeManifest>(manifestPath);
      if (!manifest) throw new PosixLoomError("UPDATE_MANIFEST_MISSING", "Runtime update has no manifest.json");
      if (manifest.runtimeId !== release.runtimeId || manifest.runtimeSemver !== release.runtimeSemver || (manifest.updateSequence ?? 0) !== (release.updateSequence ?? 0) || manifest.mode !== "release") {
        throw new PosixLoomError("UPDATE_MANIFEST_IDENTITY_MISMATCH", "Runtime update manifest does not match the signed feed", { release, manifestRuntimeId: manifest.runtimeId, manifestRuntimeSemver: manifest.runtimeSemver, mode: manifest.mode });
      }
      // 阶段 7 manifest 哈希与整树校验：feed 声明 manifestSha256 时必须逐位一致
      // （用于识别「同 id 但内容不同」的版本）；validateRuntimeManifest 对候选目录
      // 全量校验（文件存在、哈希一致等），任何 FAIL 即拒绝安装。
      const candidateManifestHash = await hashFile(manifestPath);
      if (release.manifestSha256 && candidateManifestHash.toLowerCase() !== release.manifestSha256.toLowerCase()) {
        throw new PosixLoomError("UPDATE_MANIFEST_HASH_MISMATCH", "Runtime update manifest hash does not match the signed feed");
      }
      const checks = validateRuntimeManifest(manifest, candidate);
      const failures = checks.filter((check) => check.level === "FAIL");
      if (failures.length) throw new PosixLoomError("UPDATE_RUNTIME_VALIDATION_FAILED", "Downloaded Runtime failed validation", { failures });
      // 阶段 8 基础组件：必须包含全部 REQUIRED_RUNTIME_COMPONENTS，
      // 保证更新后的环境仍能自举（缺基础命令会让 shell 环境不可用）。
      const required = new Set((manifest.required ?? []).map((entry) => typeof entry === "string" ? entry : entry.id));
      const missingBasics = REQUIRED_RUNTIME_COMPONENTS.filter((id) => !required.has(id));
      if (missingBasics.length) throw new PosixLoomError("UPDATE_COMPONENTS_MISSING", "Runtime update does not contain all basic environment components", { missingBasics });
      // 阶段 9 移入正式目录：目标不存在则 rename（同卷原子生效）；已存在则仅在
      // 「身份一致 + 校验通过 + manifest 哈希相同」时复用，否则视为冲突，绝不覆盖既有目录。
      const destination = join(this.runtime.config.dataRoot, "runtime", "versions", release.runtimeId);
      if (!existsSync(destination)) await rename(candidate, destination);
      else {
        const existingManifestPath = join(destination, "manifest.json");
        const existing = readJsonSafe<RuntimeManifest>(existingManifestPath);
        const existingFailures = existing ? validateRuntimeManifest(existing, destination).filter((check) => check.level === "FAIL") : [{ id: "manifest", level: "FAIL", message: "missing" }];
        const existingManifestHash = existing ? await hashFile(existingManifestPath) : undefined;
        if (!existing || existing.runtimeId !== release.runtimeId || existing.runtimeSemver !== release.runtimeSemver || (existing.updateSequence ?? 0) !== (release.updateSequence ?? 0) || existing.mode !== "release" || existingFailures.length || existingManifestHash !== candidateManifestHash) {
          throw new PosixLoomError("UPDATE_DESTINATION_CONFLICT", "A different or invalid Runtime directory already exists for the target id", {
            destination,
            candidateManifestHash,
            existingManifestHash,
          });
        }
      }
      // 阶段 10 事务提交：把更新前的选择压入历史（去掉与本次重复的旧记录、上限 20 条），
      // commitSelection 原子切换 current 指针并写 state.json（失败自动恢复旧指针）。
      const state = await readState(this.statePath);
      const history = [previous, ...state.history.filter((entry) => entry.runtimeId !== previous.runtimeId || entry.source !== previous.source)].slice(0, 20);
      await this.commitSelection(release.runtimeId, { ...state, active: { runtimeId: release.runtimeId, source: "data" }, history, lastError: undefined });
      return { status: "installed", runtimeId: release.runtimeId, previousRuntimeId: previous.runtimeId, restartRequired: true };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // 无论成败都回收 staging、归档与锁；清理失败聚合进 cleanupErrors，
      // 不掩盖原始错误（无原始错误时才以 UPDATE_CLEANUP_FAILED 抛出）。
      const cleanupErrors: string[] = [];
      for (const cleanup of [
        () => rm(staging, { recursive: true, force: true }),
        () => rm(archive, { force: true }),
        () => lock.release(),
      ]) {
        try { await cleanup(); } catch (error) { cleanupErrors.push(String(error)); }
      }
      if (cleanupErrors.length > 0) {
        if (operationError instanceof PosixLoomError) operationError.details.cleanupErrors = cleanupErrors;
        else if (!operationError) throw new PosixLoomError("UPDATE_CLEANUP_FAILED", "Runtime update completed but cleanup failed", { cleanupErrors });
      }
    }
  }

  /**
   * 回滚到上一个 Runtime 选择（同样需要 update.lock，且需重启生效）。
   *
   * 从 state.history 弹出最近一项并按来源分别校验：
   * - data：versions/<id> 目录必须存在，manifest 合法且 mode 为 release；
   * - bundled/development：以 runRoot/runtime/current 指针为基准，指针 id 必须与
   *   目标一致，且 runRoot 下对应版本的 manifest 校验通过、mode 与来源匹配。
   * 校验通过后经 commitSelection 重新提交指针；bundled/development 源通过删除
   * dataRoot 指针（runtimeId 传 undefined）回退到发行包内置选择。
   *
   * @returns 回滚目标的 runtimeId 与 restartRequired: true。
   * @throws UPDATE_ALREADY_RUNNING 有并发更新；UPDATE_ROLLBACK_UNAVAILABLE 无历史可回；
   *         UPDATE_ROLLBACK_INVALID 回滚目标缺失或非法。
   */
  async rollback(): Promise<{ runtimeId: string; restartRequired: true }> {
    const lockPath = join(this.updateRoot, "update.lock");
    const lock = await this.acquireLock(lockPath);
    let operationError: unknown;
    try {
      const state = await readState(this.statePath);
      const previous = state.history.shift();
      if (!previous) throw new PosixLoomError("UPDATE_ROLLBACK_UNAVAILABLE", "No previous Runtime is available for rollback");
      // data 源：回滚目标必须仍在 versions/ 目录且校验通过（防止回滚到已被删除/篡改的版本）。
      if (previous.source === "data") {
        const root = join(this.runtime.config.dataRoot, "runtime", "versions", previous.runtimeId);
        const manifest = readJsonSafe<RuntimeManifest>(join(root, "manifest.json"));
        const failures = manifest ? validateRuntimeManifest(manifest, root).filter((check) => check.level === "FAIL") : [{ id: "manifest", level: "FAIL", message: "missing" }];
        if (!manifest || manifest.runtimeId !== previous.runtimeId || manifest.mode !== "release" || failures.length) throw new PosixLoomError("UPDATE_ROLLBACK_INVALID", "Previous Runtime is missing or invalid", { runtimeId: previous.runtimeId, failures });
      } else {
        // bundled/development 源：以发行包自带的 current 指针为基准校验，
        // 指针 id 必须与目标一致，manifest 的 mode 也须与来源匹配。
        const pointer = join(this.runtime.config.runRoot, "runtime", "current");
        let bundledId: string;
        try { bundledId = (await readFile(pointer, "utf8")).trim(); } catch (error) {
          throw new PosixLoomError("UPDATE_ROLLBACK_INVALID", "Bundled Runtime pointer is missing or unreadable", { pointer, cause: String(error) });
        }
        const expectedMode = previous.source === "development" ? "development" : "release";
        const root = join(this.runtime.config.runRoot, "runtime", "versions", previous.runtimeId);
        const manifest = readJsonSafe<RuntimeManifest>(join(root, "manifest.json"));
        const failures = manifest ? validateRuntimeManifest(manifest, root).filter((check) => check.level === "FAIL") : [{ id: "manifest", level: "FAIL", message: "missing" }];
        if (bundledId !== previous.runtimeId || !isSafeRuntimeId(bundledId) || !manifest || manifest.runtimeId !== previous.runtimeId || manifest.mode !== expectedMode || failures.length) {
          throw new PosixLoomError("UPDATE_ROLLBACK_INVALID", "Bundled/development rollback target is missing or invalid", { runtimeId: previous.runtimeId, source: previous.source, bundledId, failures });
        }
      }
      // 当前选择压回历史栈（支持连续回滚）；bundled/development 源传 undefined，
      // 表示删除 dataRoot 指针、回退到发行包内置选择。
      const current: UpdateHistoryEntry = { runtimeId: this.runtime.snapshot.runtimeId, source: this.runtime.snapshot.source };
      await this.commitSelection(previous.source === "data" ? previous.runtimeId : undefined, { ...state, active: previous, history: [current, ...state.history] });
      return { runtimeId: previous.runtimeId, restartRequired: true };
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      // 回滚同样在 finally 释放锁；清理失败聚合进 cleanupErrors，不掩盖原始错误。
      const cleanupErrors: string[] = [];
      try { await lock.release(); } catch (error) { cleanupErrors.push(String(error)); }
      if (cleanupErrors.length > 0) {
        if (operationError instanceof PosixLoomError) operationError.details.cleanupErrors = cleanupErrors;
        else if (!operationError) throw new PosixLoomError("UPDATE_CLEANUP_FAILED", "Runtime rollback completed but cleanup failed", { cleanupErrors });
      }
    }
  }

  /**
   * 事务提交：先切换 dataRoot/runtime/current 指针（runtimeId 为 undefined 时删除指针，
   * 即回退到 bundled 默认选择），再原子写 state.json。
   *
   * 补偿式回滚：state 写入失败时，把指针恢复为提交前内容；指针恢复也失败才升级为
   * UPDATE_TRANSACTION_ROLLBACK_FAILED（系统处于不一致状态，需人工介入），
   * 否则抛 UPDATE_STATE_COMMIT_FAILED（指针已复原，仅状态文件落后）。
   *
   * @param runtimeId 新选中的 Runtime id；undefined 表示清除 dataRoot 指针。
   * @param state 即将持久化的完整更新状态。
   */
  private async commitSelection(runtimeId: string | undefined, state: UpdateState): Promise<void> {
    const pointer = join(this.runtime.config.dataRoot, "runtime", "current");
    let previousPointer: string | undefined;
    try {
      previousPointer = await readFile(pointer, "utf8");
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    // 先切换指针再写状态；状态写入失败时按提交前内容恢复指针（见下方补偿逻辑）。
    if (runtimeId === undefined) await rm(pointer, { force: true });
    else await atomicWrite(pointer, runtimeId);
    try {
      await atomicWrite(this.statePath, `${JSON.stringify(state, null, 2)}\n`);
    } catch (error) {
      try {
        if (previousPointer === undefined) await rm(pointer, { force: true });
        else await atomicWrite(pointer, previousPointer);
      } catch (rollbackError) {
        throw new PosixLoomError("UPDATE_TRANSACTION_ROLLBACK_FAILED", "Update state commit failed and the Runtime pointer could not be restored", {
          cause: String(error),
          rollbackCause: String(rollbackError),
          pointer,
        });
      }
      throw new PosixLoomError("UPDATE_STATE_COMMIT_FAILED", "Update state commit failed; the Runtime pointer was restored", { cause: String(error) });
    }
  }

  /**
   * 使用 Windows PowerShell 解压归档（便携发行不引入第三方解压依赖）。
   *
   * 先确认 powershell.exe 存在（UPDATE_EXTRACTOR_MISSING），再运行内嵌脚本：
   * 在真正解压前先遍历 zip 条目目录逐条校验--条目总数不超过 200000、禁止空名/
   * 绝对路径/盘符（Zip Slip）、按段切分不得出现空段/"."/".."、禁止大小写不敏感的
   * 重复条目、展开总字节数不超过 POSIXLOOM_UPDATE_EXPANDED_MAX；预扫描全部通过后才调用
   * ExtractToDirectory 真正解压，把恶意归档挡在写盘之前。
   *
   * 进程未正常退出或退出码非 0 即 UPDATE_EXTRACTION_FAILED（附进程结局与 stderr）。
   */
  private async extractZip(archive: string, destination: string): Promise<void> {
    const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!existsSync(powershell)) throw new PosixLoomError("UPDATE_EXTRACTOR_MISSING", "Windows PowerShell is required to extract Runtime update archives", { powershell });
    // 预扫描脚本：遍历并校验每个条目后，才执行 ExtractToDirectory 真正解压。
    const extractionScript = [
      "$ErrorActionPreference = 'Stop'",
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "$archive = [IO.Path]::GetFullPath($env:POSIXLOOM_UPDATE_ARCHIVE)",
      "$destination = [IO.Path]::GetFullPath($env:POSIXLOOM_UPDATE_DEST)",
      "$prefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar",
      "$maximum = [Int64]$env:POSIXLOOM_UPDATE_EXPANDED_MAX",
      "$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)",
      "$count = 0",
      "$expanded = [Int64]0",
      "$zip = [IO.Compression.ZipFile]::OpenRead($archive)",
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
      "    if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw \"Runtime archive entry escapes staging: $($entry.FullName)\" }",
      "    $expanded += [Int64]$entry.Length",
      "    if ($expanded -gt $maximum) { throw 'Runtime archive expanded size exceeds the configured limit' }",
      "  }",
      "} finally { $zip.Dispose() }",
      "[IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)",
    ].join("; ");
    // 归档/目标/上限经环境变量传递（避免命令行注入）；-NoProfile/-NonInteractive
    // 排除用户 PowerShell 配置的干扰；超时至少 60 秒且不小于进程默认超时。
    const result = await runProcess({
      program: powershell,
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", extractionScript],
      cwd: this.runtime.config.dataRoot,
      env: {
        ...process.env,
        POSIXLOOM_UPDATE_ARCHIVE: archive,
        POSIXLOOM_UPDATE_DEST: destination,
        POSIXLOOM_UPDATE_EXPANDED_MAX: String(this.runtime.config.runtime.updates.maxDownloadBytes),
      } as Record<string, string>,
      timeoutMs: Math.max(60_000, this.runtime.config.runtime.process.defaultTimeoutMs),
      cancelGraceMs: this.runtime.config.runtime.process.cancelGraceMs,
      hostPath: this.runtime.findNativeHost(),
      maxOutputBytes: this.runtime.config.runtime.process.maxOutputBytes,
    });
    if (result.outcome.kind !== "exited" || result.outcome.exitCode !== 0) {
      throw new PosixLoomError("UPDATE_EXTRACTION_FAILED", "Unable to extract Runtime update archive", { outcome: result.outcome, stderr: result.stderr.toString("utf8") });
    }
  }

  /**
   * 获取更新互斥锁：以 open "wx" 独占创建锁文件，创建本身即原子的抢锁动作。
   * - 锁已存在且 mtime 距今不足 30 分钟：视为有并发更新在运行，UPDATE_ALREADY_RUNNING；
   * - 超过 30 分钟视为陈旧锁（持锁进程大概率已死）：先 rename 移走旧锁再重建，
   *   rename 撞车（ENOENT）或重建时锁又被抢走，都说明存在并发恢复者，
   *   同样报 UPDATE_ALREADY_RUNNING，最后清理 rename 出的旧文件。
   */
  private async acquireLock(path: string): Promise<UpdateLock> {
    await mkdir(dirname(path), { recursive: true });
    try {
      return await this.createLock(path);
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age < 30 * 60 * 1000) throw new PosixLoomError("UPDATE_ALREADY_RUNNING", "Another Runtime update is already running", { path });
      const stalePath = `${path}.stale-${randomUUID()}`;
      try {
        await rename(path, stalePath);
      } catch (renameError: any) {
        if (renameError?.code === "ENOENT") throw new PosixLoomError("UPDATE_ALREADY_RUNNING", "Runtime update lock changed while stale-lock recovery was in progress", { path });
        throw renameError;
      }
      try {
        return await this.createLock(path);
      } catch (retryError: any) {
        if (retryError?.code === "EEXIST") throw new PosixLoomError("UPDATE_ALREADY_RUNNING", "Another Runtime update acquired the recovered lock", { path });
        throw retryError;
      } finally {
        await rm(stalePath, { force: true });
      }
    }
  }

  /**
   * 创建锁文件并返回句柄；锁内容为 pid / 创建时间 / 随机 token 三行。
   *
   * 心跳：每 60 秒 utimes 刷新 mtime（unref 避免挂住进程退出），供 acquireLock
   * 区分「活跃锁」与「陈旧锁」。
   * 释放：仅当锁内第三行 token 未变才删除锁文件--若锁已被陈旧恢复流程接管
   * （内容已变）则不动它，避免误删他人的锁；锁文件已不存在则静默返回。
   */
  private async createLock(path: string): Promise<UpdateLock> {
    const handle = await open(path, "wx");
    const token = randomUUID();
    try {
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n${token}\n`);
    } catch (error) {
      await handle.close();
      await rm(path, { force: true });
      throw error;
    }
    // 心跳：定期刷新 mtime 表明持锁进程仍存活；unref 使定时器不阻止进程退出。
    const heartbeat = setInterval(() => { void handle.utimes(new Date(), new Date()).catch(() => undefined); }, 60_000);
    heartbeat.unref();
    return {
      release: async () => {
        clearInterval(heartbeat);
        await handle.close();
        let current: string;
        try { current = await readFile(path, "utf8"); } catch (error: any) {
          if (error?.code === "ENOENT") return;
          throw error;
        }
        if (current.split(/\r?\n/)[2] === token) await rm(path, { force: true });
      },
    };
  }
}
