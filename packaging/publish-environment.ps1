<#
.SYNOPSIS
  签名发布的顶层编排：组件同步 -> 构建 -> 组装发布包 -> 验证 -> 生成 Ed25519 签名 Feed。

.DESCRIPTION
  环境组件供应链与签名事务式更新的完整发布入口：
  1. 调用 scripts/sync-components.mjs 按锁文件物化（或刷新）第三方环境组件；
  2. 构建 TypeScript CLI 与 Rust Native Host（release、锁定依赖）；
  3. 调用 packaging/build-runtime.ps1 -Mode release 组装发布包，
     全部组件目录从 resolved-components.json 显式注入；
  4. 调用 packaging/verify-runtime.ps1 验证包完整性并执行兼容性语料；
  5. 调用 packaging/verify-defender.ps1 扫描包目录与两个归档，失败则禁止签名；
  6. 调用 scripts/create-update-feed.mjs 用 Ed25519 私钥签名，产出更新 Feed。

  设计意图：
  - 签名发布使客户端只能安装经过验证的完整 Runtime：环境组件（node/msys2/
    mingit/ripgrep）与核心代码总是作为一个兼容性测试过的整体升级，
    绝不就地替换运行中的组件（RuntimeSnapshot 不可变性）。
  - 同 core semver 的环境重建通过单调递增的 updateSequence 区分；
    它同时作为 SourceDateEpoch，使相同输入得到可复现的时间戳与归档。
  - 私钥与第三方二进制不入库，仓库只保存策略、锁文件与代码。

.PARAMETER RefreshComponents
  以 --refresh 运行组件同步：核对上游资产摘要并写出新的 v2 锁。
.PARAMETER SkipComponentSync
  跳过组件同步，复用已物化的组件目录（与 -RefreshComponents 互斥）。
.PARAMETER ComponentOutput
  组件物化目录（内含 resolved-components.json 描述符）。
.PARAMETER ComponentLock
  组件锁文件路径。
.PARAMETER Output
  发布包目录（传给 build-runtime.ps1 的 -Output）。
.PARAMETER RuntimeSemver
  本次发布的语义化版本，用于派生 RuntimeId。
.PARAMETER FeedOutput
  签名 Feed 输出路径。
.PARAMETER ArchiveUrl
  Runtime 归档的发布地址；缺省使用归档文件名（相对地址）。
.PARAMETER KeyId
  Ed25519 签名密钥标识（必填）。
.PARAMETER PrivateKey
  Ed25519 私钥文件路径（必填）。
.PARAMETER SkipCorpus
  跳过兼容性语料，仅做静态包验证；Defender 门禁仍会执行。
#>
[CmdletBinding()]
param(
  # 以 --refresh 同步组件（核对上游并写新锁）；默认 --locked 复现已提交锁文件
  [switch]$RefreshComponents,
  # 跳过组件同步，复用已物化的组件目录
  [switch]$SkipComponentSync,
  # 组件物化目录（内含 resolved-components.json 描述符）
  [string]$ComponentOutput = (Join-Path (Get-Location) 'artifacts\components\win32-x64'),
  # 组件锁文件路径
  [string]$ComponentLock = (Join-Path (Get-Location) 'packaging\components.lock.json'),
  # 发布包输出目录
  [string]$Output = (Join-Path (Get-Location) 'artifacts\posixloom-portable-win-x64'),
  # 本次发布的语义化版本
  [string]$RuntimeSemver = '0.1.0',
  # 签名 Feed 输出路径
  [string]$FeedOutput = (Join-Path (Get-Location) 'artifacts\environment-feed.json'),
  # Runtime 归档的发布地址；缺省为归档文件名
  [string]$ArchiveUrl,
  # Ed25519 签名密钥标识
  [Parameter(Mandatory = $true)][string]$KeyId,
  # Ed25519 私钥文件路径
  [Parameter(Mandatory = $true)][string]$PrivateKey,
  # 跳过兼容性语料，仅做静态包验证
  [switch]$SkipCorpus
)

# ---- 全局初始化：解析仓库根与全部路径参数为绝对路径 ----
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ComponentOutput = [IO.Path]::GetFullPath($ComponentOutput)
$ComponentLock = [IO.Path]::GetFullPath($ComponentLock)
$Output = [IO.Path]::GetFullPath($Output)
$FeedOutput = [IO.Path]::GetFullPath($FeedOutput)
$PrivateKey = [IO.Path]::GetFullPath($PrivateKey)

# 执行一个外部步骤（node/npm/cargo/子脚本）并检查退出码，
# 非 0 立即抛出带上下文的错误，让流水线尽早失败而非带病继续。
function Invoke-Checked([scriptblock]$Operation, [string]$Failure) {
  & $Operation
  if ($LASTEXITCODE -ne 0) { throw "$Failure (exit code $LASTEXITCODE)" }
}

# ---- 前置参数校验：semver/KeyId 格式、私钥存在、互斥开关 ----
if ($RuntimeSemver -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw "Invalid RuntimeSemver: $RuntimeSemver" }
if ($KeyId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "Invalid KeyId: $KeyId" }
if (!(Test-Path -LiteralPath $PrivateKey -PathType Leaf)) { throw "Ed25519 private key not found: $PrivateKey" }
if ($RefreshComponents -and $SkipComponentSync) { throw 'RefreshComponents and SkipComponentSync cannot be used together' }

# ---- 同步组件（可跳过）----
# 默认 --locked：严格按已提交锁文件复现组件，不查询上游发布索引；
# -RefreshComponents 走 --refresh：核对上游资产摘要并写出新的 v2 锁。
if (!$SkipComponentSync) {
  $syncMode = if ($RefreshComponents) { '--refresh' } else { '--locked' }
  Invoke-Checked { & node (Join-Path $root 'scripts\sync-components.mjs') $syncMode '--lock' $ComponentLock '--output' $ComponentOutput } 'Component synchronization failed'
}

# ---- 读取组件描述与锁，派生 RuntimeId ----
# 要求 v2 锁且 updateSequence 为正；RuntimeId 形如 runtime-<semver>-env-<序号>，
# 同 semver 的环境重建依赖序号单调递增以保证更新可被发现。
$descriptorPath = Join-Path $ComponentOutput 'resolved-components.json'
if (!(Test-Path -LiteralPath $descriptorPath -PathType Leaf)) { throw "Resolved component descriptor missing: $descriptorPath" }
$descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath $ComponentLock -Raw | ConvertFrom-Json
$updateSequence = [Int64]$lock.updateSequence
if ($lock.lockVersion -ne 2 -or $updateSequence -le 0) { throw 'Environment publishing requires a schema-v2 component lock with a positive updateSequence' }
$runtimeId = "runtime-$RuntimeSemver-env-$updateSequence"
if ($runtimeId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "Generated RuntimeId is invalid: $runtimeId" }

# ---- 构建核心产物 ----
# TypeScript CLI 与 Rust Native Host 均以锁定依赖的 release 配置构建。
Invoke-Checked { & npm run build --silent } 'TypeScript build failed'
Invoke-Checked { & cargo build --release --locked --manifest-path (Join-Path $root 'native\posixloom-host\Cargo.toml') } 'Native Host release build failed'

# ---- 组装发布包 ----
# 全部组件目录从 descriptor 显式注入，不下载也不猜测 PATH；
# updateSequence 同时作为 SourceDateEpoch，使同输入得到可复现时间戳与归档。
Invoke-Checked {
  & (Join-Path $root 'packaging\build-runtime.ps1') `
    -Mode release `
    -RuntimeId $runtimeId `
    -RuntimeSemver $RuntimeSemver `
    -UpdateSequence $updateSequence `
    -NodeRoot ([string]$descriptor.nodeRoot) `
    -MsysRoot ([string]$descriptor.msysRoot) `
    -MinGitRoot ([string]$descriptor.minGitRoot) `
    -RipgrepExe ([string]$descriptor.ripgrepExe) `
    -LicensesRoot ([string]$descriptor.licensesRoot) `
    -ComponentLock $ComponentLock `
    -Output $Output `
    -SourceDateEpoch $updateSequence
} 'Release package assembly failed'

# ---- 验证发布包 ----
# 默认执行真实兼容性语料；-SkipCorpus 时仅做静态完整性验证。
if ($SkipCorpus) {
  Invoke-Checked { & (Join-Path $root 'packaging\verify-runtime.ps1') -PackageRoot $Output } 'Release package verification failed'
} else {
  Invoke-Checked { & (Join-Path $root 'packaging\verify-runtime.ps1') -PackageRoot $Output -RunCorpus } 'Release package verification failed'
}

# ---- 生成签名更新 Feed ----
# create-update-feed.mjs 会校验 Runtime 根目录与归档的组件/树哈希后再签名；
# ArchiveUrl 缺省为归档文件名（相对地址），由分发端决定最终落地 URL。
$runtimeArchive = Join-Path (Split-Path -Parent $Output) "$runtimeId.runtime.zip"
if (!(Test-Path -LiteralPath $runtimeArchive -PathType Leaf)) { throw "Runtime update archive missing: $runtimeArchive" }
# Antivirus verification is mandatory before signing. Never change protection or add exclusions.
Invoke-Checked {
  & (Join-Path $root 'packaging\verify-defender.ps1') -PackageRoot $Output -ArchivePaths @("$Output.zip", $runtimeArchive) -ReportPath "$Output.defender.json"
} 'Release Defender scan failed'
if ([string]::IsNullOrWhiteSpace($ArchiveUrl)) { $ArchiveUrl = [IO.Path]::GetFileName($runtimeArchive) }
Invoke-Checked {
  & node (Join-Path $root 'scripts\create-update-feed.mjs') `
    '--runtime-root' (Join-Path $Output "runtime\versions\$runtimeId") `
    '--archive' $runtimeArchive `
    '--archive-url' $ArchiveUrl `
    '--output' $FeedOutput `
    '--key-id' $KeyId `
    '--private-key' $PrivateKey
} 'Signed environment feed generation failed'

# 输出发布产物摘要，供人工/CI 核对。
Write-Host "Published local environment snapshot: $runtimeId"
Write-Host "Package: $Output"
Write-Host "Runtime archive: $runtimeArchive"
Write-Host "Signed feed: $FeedOutput"
