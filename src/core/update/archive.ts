import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PosixLoomError } from "../errors.js";
import { runProcess } from "../process.js";
import type { RuntimeManager } from "../runtime.js";

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
export async function extractRuntimeZip(runtime: RuntimeManager, archive: string, destination: string): Promise<void> {
  const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (!existsSync(powershell)) throw new PosixLoomError("UPDATE_EXTRACTOR_MISSING", "Windows PowerShell is required to extract Runtime update archives", { powershell });
  // 预扫描脚本：遍历并校验每个条目后，才执行 ExtractToDirectory 真正解压。
  const helper = fileURLToPath(new URL("../assets/extract-runtime.ps1", import.meta.url));
  // 归档/目标/上限经环境变量传递（避免命令行注入）；-NoProfile/-NonInteractive
  // 排除用户 PowerShell 配置的干扰；超时至少 60 秒且不小于进程默认超时。
  const result = await runProcess({
    program: powershell,
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper],
    cwd: runtime.config.dataRoot,
    env: {
      ...process.env,
      POSIXLOOM_UPDATE_ARCHIVE: archive,
      POSIXLOOM_UPDATE_DEST: destination,
      POSIXLOOM_UPDATE_EXPANDED_MAX: String(runtime.config.runtime.updates.maxDownloadBytes),
    } as Record<string, string>,
    timeoutMs: Math.max(60_000, runtime.config.runtime.process.defaultTimeoutMs),
    cancelGraceMs: runtime.config.runtime.process.cancelGraceMs,
    hostPath: runtime.findNativeHost(),
    maxOutputBytes: runtime.config.runtime.process.maxOutputBytes,
  });
  if (result.outcome.kind !== "exited" || result.outcome.exitCode !== 0) {
    throw new PosixLoomError("UPDATE_EXTRACTION_FAILED", "Unable to extract Runtime update archive", { outcome: result.outcome, stderr: result.stderr.toString("utf8") });
  }
}
