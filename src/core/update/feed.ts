import { createPublicKey, verify } from "node:crypto";
import { PosixLoomError } from "../errors.js";
import { isSafeRuntimeId } from "../config.js";
import { UPDATE_FEED_VERSION, type RuntimeRelease, type RuntimeUpdateFeed } from "./contracts.js";
import { safeRelativePath } from "./paths.js";

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
export function platformId(): string {
  return `${process.platform}-${process.arch}`;
}
interface SemverParts {
  core: [string, string, string];
  prerelease?: string[];
}

/** 解析完整 semver 主版本三元组与 prerelease 标识；无效或带尾随垃圾时返回 undefined。 */
function semverParts(value: string): SemverParts | undefined {
  const match = value.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    core: [match[1], match[2], match[3]],
    prerelease: match[4]?.split("."),
  };
}

/** 比较任意长度的非负十进制整数，避免 Number 精度丢失让两个版本被误判相等。 */
function compareNumericIdentifier(left: string, right: string): number {
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  if (a.length !== b.length) return a.length - b.length;
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * 单个 release 条目的 schema 校验：id 安全性、semver 格式、updateSequence 非负安全整数、
 * platform 格式、archiveUrl 非空且无 NUL、哈希为 64 位十六进制、字节数为正整数、
 * 格式仅 zip、archiveRoot 为安全相对路径或 "."、publishedAt 可被 Date.parse 解析。
 * 任一项不满足即视为整份 feed 非法，在下载前就拦截。
 */
export function isRuntimeRelease(value: unknown): value is RuntimeRelease {
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
 * 规则：主三元组按任意精度十进制数比较；无 prerelease 者高于有 prerelease 者；
 * prerelease 逐段比较，数字段低于非数字段，较短的相同前缀版本优先级更低。
 */
export function compareSemver(left: string, right: string): number {
  const a = semverParts(left);
  const b = semverParts(right);
  // 内部 feed 已经过 schema 校验；对导出 API 的无效输入仍给出稳定的最低排序，
  // 而不是让部分匹配或 NaN 悄悄污染 Array.sort。
  if (!a || !b) {
    if (!a && !b) return left === right ? 0 : left < right ? -1 : 1;
    return a ? 1 : -1;
  }
  for (let index = 0; index < 3; index += 1) {
    const core = compareNumericIdentifier(a.core[index], b.core[index]);
    if (core !== 0) return core;
  }
  if (a.prerelease === undefined && b.prerelease === undefined) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  const count = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < count; index += 1) {
    const leftIdentifier = a.prerelease[index];
    const rightIdentifier = b.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) return compareNumericIdentifier(leftIdentifier, rightIdentifier);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
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
