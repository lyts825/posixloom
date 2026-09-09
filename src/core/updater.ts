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
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PosixLoomError } from "./errors.js";
import { isSafeRuntimeId } from "./config.js";
import { readJsonSafe, REQUIRED_RUNTIME_COMPONENTS, RuntimeManager, validateRuntimeManifest } from "./runtime.js";
import type { RuntimeManifest } from "./types.js";
import type { RuntimeRelease, RuntimeUpdateFeed, UpdateHistoryEntry, UpdateState, UpdateLock, UpdateCheckResult, UpdateApplyResult } from "./update/contracts.js";
import { compareRuntimeRelease, isRuntimeRelease, platformId, verifyUpdateFeed } from "./update/feed.js";
import { resolveUpdateResource, readResource, downloadAndHash, hashFile, atomicWrite, readState } from "./update/io.js";
import { safeRelativePath, pathIsInside, assertNoLinks } from "./update/paths.js";
import { acquireUpdateLock } from "./update/lock.js";
import { extractRuntimeZip } from "./update/archive.js";

export type { RuntimeRelease, RuntimeUpdateFeed, UpdateCheckResult, UpdateApplyResult } from "./update/contracts.js";
export { canonicalJson, compareSemver, compareRuntimeRelease, verifyUpdateFeed } from "./update/feed.js";
export { resolveUpdateResource } from "./update/io.js";

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
      await extractRuntimeZip(this.runtime, archive, staging);
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

    private acquireLock(path: string): Promise<UpdateLock> {
    return acquireUpdateLock(path);
  }
}
