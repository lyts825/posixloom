import { isSafeRuntimeId } from "../config.js";

/** 当前支持的更新 feed 结构版本；版本不符的 feed 一律按非法处理，由发布端升版本号演进。 */
export const UPDATE_FEED_VERSION = 1;

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
export interface UpdateHistoryEntry {
  runtimeId: string;
  source: "bundled" | "data" | "development";
}

/** 持久化在 dataRoot/updates/state.json 的更新状态：检查间隔门控、当前生效选择与回滚历史。 */
export interface UpdateState {
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
export interface UpdateLock {
  release(): Promise<void>;
}

/** 校验单个历史条目的结构（runtimeId 安全字符集 + 来源枚举），用于读取持久化状态时的防篡改检查。 */
export function isHistoryEntry(value: unknown): value is UpdateHistoryEntry {
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
