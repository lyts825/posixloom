<#
.SYNOPSIS
  组装 PosixLoom 便携式 Runtime 包（Windows x64）。

.DESCRIPTION
  发布组件显式注入、Runtime manifest 哈希和环境组件供应链的打包入口。脚本将
  仓库构建产物（dist/、config/、package.json、
  Native Host posixloom.exe）与显式注入的第三方环境组件（Node、MSYS2、MinGit、ripgrep、
  许可证）组装为自包含包目录，并产出：
    - runtime\versions\<RuntimeId>\ 不可变 Runtime 快照（组件 + manifest.json +
      SBOM.spdx.json + components.lock.json 副本 + shims）；
    - SHA256SUMS：包内全部不可变文件的逐文件哈希清单；
    - <RuntimeId>.runtime.zip：供更新事务下载的 Runtime 归档；
    - <Output>.zip：完整分发包归档。

  设计意图：
  - release 模式必须显式接收全部组件输入；组装过程不在线下载、也不从构建机
    PATH 猜测来源，从而保证发布物可复现、可审计，并明确区分「随包组件」与
    「开发回退」。上游下载由独立的 scripts/sync-components.mjs 在组装前完成。
  - manifest 记录每个组件的版本、entrypoint SHA-256、组件树 SHA-256 与文件数，
    供 Launcher 与更新器校验，防止文件被替换或遗漏。
  - 组件锁锁定上游版本与全部哈希；锁文件复制进 Runtime 并由 manifest 的
    sourceLockSha256 覆盖，构成供应链证据链。
  - development 模式固定 RuntimeId=runtime-dev，允许缺少第三方组件（外部回退），
    仅供本机开发测试，不得作为发布物。

.PARAMETER Mode
  打包模式：development（允许组件回退）或 release（全部组件必需）。
.PARAMETER RequireComponents
  在 development 模式下也强制要求全部组件显式注入。
.PARAMETER NodeRoot
  Node 发行版根目录（须含 node.exe）；release 模式必填。
.PARAMETER MsysRoot
  MSYS2 根目录（须含 usr\bin\bash.exe）；release 模式必填。
.PARAMETER MinGitRoot
  MinGit 根目录（须含 cmd\git.exe）；release 模式必填。
.PARAMETER RipgrepExe
  ripgrep 可执行文件（rg.exe）路径；release 模式必填。
.PARAMETER LicensesRoot
  第三方许可证目录；release 模式必填。
.PARAMETER ComponentLock
  组件锁文件（components.lock.json，lockVersion 1 或 2）；release 模式必填。
.PARAMETER Output
  包输出目录；位于仓库内时必须是 artifacts/ 的子目录。
.PARAMETER RuntimeId
  Runtime 标识；development 固定为 runtime-dev，release 须使用带版本的标识。
.PARAMETER RuntimeSemver
  Runtime 语义化版本号。
.PARAMETER UpdateSequence
  单调递增更新序号：同 core semver 的环境重建靠它排序。
.PARAMETER SourceDateEpoch
  可复现构建时间戳（Unix 秒）；缺省使用当前 UTC 时间。
.PARAMETER SkipArchive
  跳过 zip 归档生成，仅组装目录。

.NOTES
  流水线位置：sync-components.mjs（物化组件）→ 本脚本（组装）→
  verify-runtime.ps1（验证）→ create-update-feed.mjs（签名 Feed）；
  顶层编排见 publish-environment.ps1。
#>
[CmdletBinding()]
param(
  # 打包模式：development 允许组件回退；release 要求全部组件显式注入
  [ValidateSet('development', 'release')]
  [string]$Mode = 'development',
  # 在 development 模式下也强制要求全部第三方组件显式提供
  [switch]$RequireComponents,
  # Node 发行版根目录（须含 node.exe）
  [string]$NodeRoot,
  # MSYS2 根目录（须含 usr\bin\bash.exe）
  [string]$MsysRoot,
  # MinGit 根目录（须含 cmd\git.exe）
  [string]$MinGitRoot,
  # ripgrep 可执行文件路径（rg.exe）
  [string]$RipgrepExe,
  # 第三方许可证目录
  [string]$LicensesRoot,
  # 组件锁文件路径（components.lock.json）
  [string]$ComponentLock,
  # 包输出目录；仓库内路径必须位于 artifacts/ 之下
  [string]$Output = (Join-Path (Get-Location) 'artifacts\posixloom-portable-win-x64'),
  # Runtime 标识；development 固定为 runtime-dev
  [string]$RuntimeId = 'runtime-dev',
  # Runtime 语义化版本号
  [string]$RuntimeSemver = '0.1.0-dev',
  # 单调递增的更新序号（须为 JS 安全整数）
  [Int64]$UpdateSequence = 0,
  # 可复现构建时间戳（Unix 秒）
  [string]$SourceDateEpoch,
  # 跳过 zip 归档生成，仅组装目录
  [switch]$SkipArchive
)

# ---- 全局初始化 ----
# 出错立即终止；$mustHaveComponents 决定组件输入是否强制（release 模式恒为强制）。
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Output = [IO.Path]::GetFullPath($Output)
$mustHaveComponents = $RequireComponents.IsPresent -or $Mode -eq 'release'
$hostExe = Join-Path $root 'native\posixloom-host\target\release\posixloom.exe'

# 校验包输出路径的安全性：拒绝驱动器根、仓库根及其祖先、仓库内 artifacts/
# 之外的路径，并沿路径逐级检查 reparse point（符号链接/junction），
# 防止打包过程穿越链接或把产物写进源码树。
function Assert-SafeOutputPath([string]$Path, [string]$RepositoryRoot) {
  $full = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $volume = [IO.Path]::GetPathRoot($full).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $repository = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $artifacts = (Join-Path $repository 'artifacts').TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if (!$full -or $full.Equals($volume, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing unsafe package output path: $Path" }
  if ($repository.Equals($full, [StringComparison]::OrdinalIgnoreCase) -or $repository.StartsWith($full + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Package output cannot be the repository root or one of its ancestors: $Path"
  }
  if ($full.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -and !$full.StartsWith($artifacts + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Repository-local package output must be a child of the artifacts directory: $Path"
  }
  $cursor = $full
  while ($cursor -and !$cursor.Equals($volume, [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Package output path cannot traverse a reparse point: $($item.FullName)" }
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent) { break }
    $cursor = $parent.FullName.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  }
}

# 校验输入路径与打包目标互不重叠（任一方包含另一方即抛错），
# 避免组装或归档时把输出复制回输入、就地修改组件来源。
function Assert-DisjointPaths([string]$Target, [string]$InputPath, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($InputPath)) { return }
  $targetFull = [IO.Path]::GetFullPath($Target).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $inputFull = [IO.Path]::GetFullPath($InputPath).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $separator = [IO.Path]::DirectorySeparatorChar
  if ($targetFull.Equals($inputFull, [StringComparison]::OrdinalIgnoreCase) -or $targetFull.StartsWith($inputFull + $separator, [StringComparison]::OrdinalIgnoreCase) -or $inputFull.StartsWith($targetFull + $separator, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name overlaps a package output target: $InputPath"
  }
}

# ---- 输出路径与标识前置校验 ----
# RuntimeId/RuntimeSemver 格式、模式与 ID 绑定关系、updateSequence 的
# JS 安全整数范围都在此校验，尽早失败以免留下无效半成品。
Assert-SafeOutputPath $Output $root
if ($RuntimeId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "Invalid RuntimeId: $RuntimeId" }
if ($RuntimeSemver -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw "Invalid RuntimeSemver: $RuntimeSemver" }
if ($Mode -eq 'development' -and $RuntimeId -ne 'runtime-dev') { throw 'Development packages must use RuntimeId runtime-dev' }
if ($Mode -eq 'release' -and $RuntimeId -eq 'runtime-dev') { throw 'Release packages must use a versioned RuntimeId other than runtime-dev' }
if ($UpdateSequence -lt 0 -or $UpdateSequence -gt 9007199254740991) { throw 'UpdateSequence must be a non-negative JavaScript-safe integer' }

# 计算单个文件的 SHA-256，返回小写十六进制字符串（manifest 与 SHA256SUMS 使用）。
function Get-Sha256Hex([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')).ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

# 断言目录树内不含任何 reparse point（符号链接/junction 等），
# 确保组件来源不被链接重定向，包内容完全可控。
function Assert-NoReparsePoints([string]$Path, [string]$Name) {
  $items = @((Get-Item -LiteralPath $Path -Force)) + @(Get-ChildItem -LiteralPath $Path -Force -Recurse)
  $link = $items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } | Select-Object -First 1
  if ($link) { throw "$Name cannot contain a reparse point: $($link.FullName)" }
}

# 解析目录型组件输入：为空时按 $mustHaveComponents 决定报错（release 必需）
# 或返回 null（开发包允许缺省）；存在则解析为绝对路径并检查 reparse point。
function Require-Directory([string]$Path, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    if ($mustHaveComponents) { throw "$Name is required for a release package" }
    return $null
  }
  if (!(Test-Path -LiteralPath $Path -PathType Container)) { throw "$Name directory not found: $Path" }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  Assert-NoReparsePoints $resolved $Name
  return $resolved
}

# 解析文件型组件输入（rg.exe、组件锁等）：为空时按 $mustHaveComponents 决定
# 报错或返回 null；存在则解析为绝对路径并拒绝 reparse point。
function Require-File([string]$Path, [string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Path)) {
    if ($mustHaveComponents) { throw "$Name is required for a release package" }
    return $null
  }
  if (!(Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Name file not found: $Path" }
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if ((((Get-Item -LiteralPath $resolved -Force).Attributes) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Name cannot be a reparse point: $resolved" }
  return $resolved
}

# 将来源目录的「内容」（而非目录本身）复制进目标目录，保留子目录结构。
function Copy-DirectoryContents([string]$Source, [string]$Destination) {
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $Destination -Recurse -Force
  }
}

# 探测工具的 --version 首行输出；执行失败或文件不存在时返回回退字符串。
# 仅用于无组件锁的开发包记录版本；release 路径的版本一律取自锁文件。
function Get-ToolVersion([string]$Executable, [string]$Fallback) {
  if (!(Test-Path -LiteralPath $Executable -PathType Leaf)) { return $Fallback }
  try {
    $line = & $Executable --version 2>&1 | Select-Object -First 1
    if ($line) { return ([string]$line).Trim() }
  } catch { }
  return $Fallback
}

# 计算目录树的确定性哈希：收集全部文件的相对路径（统一用 '/' 分隔），
# 按字节序（Ordinal，规避系统排序规则差异）排序后，逐文件拼接
# 「相对路径\0文件SHA-256\n」，最后对拼接结果整体做一次 SHA-256。
# 返回 hash 与 fileCount，两者都写入 manifest 作为完整性证据。
function Get-TreeHashOrdinal([string]$Directory) {
  $separator = [IO.Path]::DirectorySeparatorChar
  $rootFull = [IO.Path]::GetFullPath($Directory).TrimEnd($separator) + $separator
  $builder = New-Object System.Text.StringBuilder
  $fileMap = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
  $relativePaths = New-Object 'System.Collections.Generic.List[string]'
  foreach ($file in @(Get-ChildItem -LiteralPath $Directory -File -Force -Recurse)) {
    $relative = $file.FullName.Substring($rootFull.Length).Replace($separator, '/')
    [void]$fileMap.Add($relative, $file.FullName)
    [void]$relativePaths.Add($relative)
  }
  $relativePaths.Sort([System.StringComparer]::Ordinal)
  foreach ($relative in $relativePaths) {
    $fileHash = Get-Sha256Hex $fileMap[$relative]
    [void]$builder.Append($relative)
    [void]$builder.Append("`0")
    [void]$builder.Append($fileHash)
    [void]$builder.Append("`n")
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($builder.ToString())
    $digest = $sha.ComputeHash($bytes)
  } finally {
    $sha.Dispose()
  }
  return [ordered]@{
    hash = ([BitConverter]::ToString($digest).Replace('-', '')).ToLowerInvariant()
    fileCount = $relativePaths.Count
  }
}

# 目录树哈希的对外入口（当前实现即字节序版本，保留独立入口便于后续更换策略）。
function Get-TreeHash([string]$Directory) {
  return Get-TreeHashOrdinal $Directory
}

# 从组件锁对象中取出指定组件的条目；锁中缺少该组件视为配置错误，立即抛错。
function Get-LockEntry([object]$Lock, [string]$Id) {
  if (!$Lock -or !$Lock.components) { return $null }
  $property = $Lock.components.PSObject.Properties[$Id]
  if (!$property) { throw "Component lock is missing entry: $Id" }
  return $property.Value
}

# 校验目录型组件与锁记录完全一致：入口相对路径、源目录树哈希、入口文件哈希
# 三者必须逐一匹配，返回锁定的版本号。任一不一致即说明来源被篡改或过期，
# 组装立即中止（供应链完整性闸门）。
function Assert-LockedDirectory([object]$Lock, [string]$Id, [string]$SourceRoot, [string]$EntryRelative) {
  if (!$Lock) { return $null }
  $entry = Get-LockEntry $Lock $Id
  if ([string]::IsNullOrWhiteSpace([string]$entry.version)) { throw "Component lock version is missing: $Id" }
  $lockedEntrypoint = ([string]$entry.entrypoint).Replace('\', '/')
  $expectedEntrypoint = $EntryRelative.Replace('\', '/')
  if ($lockedEntrypoint -ne $expectedEntrypoint) { throw "Component lock entrypoint mismatch: $Id (expected $expectedEntrypoint, actual $lockedEntrypoint)" }
  if ([string]$entry.rootTreeSha256 -notmatch '^[0-9a-fA-F]{64}$' -or [string]$entry.entrypointSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Component lock hashes are invalid: $Id" }
  $tree = Get-TreeHash $SourceRoot
  if (!$entry.rootTreeSha256 -or $tree.hash -ne ([string]$entry.rootTreeSha256).ToLowerInvariant()) {
    throw "Component source tree hash mismatch: $Id (expected $($entry.rootTreeSha256), actual $($tree.hash))"
  }
  $entryPath = Join-Path $SourceRoot $EntryRelative
  if (!(Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw "Locked component entrypoint missing: $Id -> $entryPath" }
  $entryHash = Get-Sha256Hex $entryPath
  if (!$entry.entrypointSha256 -or $entryHash -ne ([string]$entry.entrypointSha256).ToLowerInvariant()) {
    throw "Component entrypoint hash mismatch: $Id (expected $($entry.entrypointSha256), actual $entryHash)"
  }
  return [string]$entry.version
}

# 校验单文件组件（ripgrep）与锁记录一致：入口相对路径与文件 SHA-256 匹配，
# 返回锁定的版本号。
function Assert-LockedFile([object]$Lock, [string]$Id, [string]$SourceFile, [string]$EntryRelative) {
  if (!$Lock) { return $null }
  $entry = Get-LockEntry $Lock $Id
  if ([string]::IsNullOrWhiteSpace([string]$entry.version)) { throw "Component lock version is missing: $Id" }
  $lockedEntrypoint = ([string]$entry.entrypoint).Replace('\', '/')
  $expectedEntrypoint = $EntryRelative.Replace('\', '/')
  if ($lockedEntrypoint -ne $expectedEntrypoint) { throw "Component lock entrypoint mismatch: $Id (expected $expectedEntrypoint, actual $lockedEntrypoint)" }
  if ([string]$entry.sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "Component lock hash is invalid: $Id" }
  $actual = Get-Sha256Hex $SourceFile
  if (!$entry.sha256 -or $actual -ne ([string]$entry.sha256).ToLowerInvariant()) {
    throw "Component source hash mismatch: $Id (expected $($entry.sha256), actual $actual)"
  }
  return [string]$entry.version
}

# 为已复制进 RuntimeRoot 的组件生成 manifest 记录：版本、相对 root 与
# entrypoint（统一 '/' 分隔）、entrypoint SHA-256、组件树 SHA-256 与文件数。
# 组件缺失时仅开发模式返回 null（release 模式在复制阶段已失败）。
function New-ComponentRecord([string]$Id, [string]$Version, [string]$RootRelative, [string]$EntryRelative, [string]$RuntimeRoot) {
  $componentRoot = Join-Path $RuntimeRoot $RootRelative
  $entrypoint = Join-Path $RuntimeRoot $EntryRelative
  if (!(Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    if ($mustHaveComponents) { throw "Component entrypoint missing after assembly: $Id -> $entrypoint" }
    return $null
  }
  $tree = Get-TreeHash $componentRoot
  return [ordered]@{
    id = $Id
    version = $Version
    root = $RootRelative.Replace('\', '/')
    entrypoint = $EntryRelative.Replace('\', '/')
    sha256 = Get-Sha256Hex $entrypoint
    treeSha256 = $tree.hash
    fileCount = $tree.fileCount
  }
}

# ---- 构建输入校验 ----
# 必须先存在 release 配置构建的 Native Host 与 TypeScript 构建产物，
# 否则拒绝组装（避免产出不可启动的包）。
if (!(Test-Path -LiteralPath $hostExe -PathType Leaf)) {
  throw "Release Native Host missing. Run: cargo build --release --locked --manifest-path native/posixloom-host/Cargo.toml"
}

$required = @('dist\src\cli\main.js', 'config\defaults.json', 'package.json')
foreach ($path in $required) {
  if (!(Test-Path -LiteralPath (Join-Path $root $path))) { throw "Required build input missing: $path" }
}

# ---- 组件来源解析与锁加载 ----
# 全部组件输入走显式校验（存在性 + reparse point），release 缺一即失败；
# 锁文件校验 lockVersion 与目标平台，并计算其哈希供 manifest 引用。
$nodeSource = Require-Directory $NodeRoot 'NodeRoot'
$msysSource = Require-Directory $MsysRoot 'MsysRoot'
$gitSource = Require-Directory $MinGitRoot 'MinGitRoot'
$rgSource = Require-File $RipgrepExe 'RipgrepExe'
$licenseSource = Require-Directory $LicensesRoot 'LicensesRoot'
if ($mustHaveComponents -and !$licenseSource) { throw 'LicensesRoot is required for a release package' }
$lockPath = Require-File $ComponentLock 'ComponentLock'
if ($mustHaveComponents -and !$lockPath) { throw 'ComponentLock is required for a release package' }
$lock = if ($lockPath) { Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json } else { $null }
if ($lock -and $lock.lockVersion -notin @(1, 2)) { throw "Unsupported component lock version: $($lock.lockVersion)" }
if ($lock -and $lock.platform -and [string]$lock.platform -ne 'win32-x64') { throw "Component lock platform does not match this package target: $($lock.platform)" }
$sourceLockSha256 = if ($lockPath) { Get-Sha256Hex $lockPath } else { $null }
$runtimeArchiveTarget = Join-Path (Split-Path -Parent $Output) "$RuntimeId.runtime.zip"
$packageArchiveTarget = "$Output.zip"
# 所有组件输入与输出目录、两个归档目标两两互不重叠，防止打包自我复制或改写来源。
foreach ($inputRecord in @(
  @{ Path = $nodeSource; Name = 'NodeRoot' },
  @{ Path = $msysSource; Name = 'MsysRoot' },
  @{ Path = $gitSource; Name = 'MinGitRoot' },
  @{ Path = $rgSource; Name = 'RipgrepExe' },
  @{ Path = $licenseSource; Name = 'LicensesRoot' },
  @{ Path = $lockPath; Name = 'ComponentLock' }
)) {
  Assert-DisjointPaths $Output $inputRecord.Path $inputRecord.Name
  Assert-DisjointPaths $runtimeArchiveTarget $inputRecord.Path $inputRecord.Name
  Assert-DisjointPaths $packageArchiveTarget $inputRecord.Path $inputRecord.Name
}

# ---- 组装包骨架 ----
# 清空并重建输出目录，复制启动必需的 dist/config/package.json；
# 顶层 posixloom.exe 即为便携包的启动器入口。
if (Test-Path -LiteralPath $Output) { Remove-Item -LiteralPath $Output -Recurse -Force }
New-Item -ItemType Directory -Path $Output -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Output 'dist') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'dist\src') -Destination (Join-Path $Output 'dist\src') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'config') -Destination (Join-Path $Output 'config') -Recurse
Copy-Item -LiteralPath (Join-Path $root 'package.json') -Destination (Join-Path $Output 'package.json')
Copy-Item -LiteralPath $hostExe -Destination (Join-Path $Output 'posixloom.exe')

# ---- Runtime 快照目录 ----
# 组件安装到 runtime\versions\<RuntimeId> 下，runtime\current 指针指向它，
# 与已安装运行时的 DataRoot 布局保持一致。
$runtimeRoot = Join-Path $Output "runtime\versions\$RuntimeId"
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
Set-Content -LiteralPath (Join-Path $Output 'runtime\current') -Value $RuntimeId -NoNewline
if ($lockPath) { Copy-Item -LiteralPath $lockPath -Destination (Join-Path $runtimeRoot 'components.lock.json') -Force }

# ---- 逐组件复制与锁校验 ----
# 每个组件先复制进 RuntimeRoot，再对照组件锁校验源树与入口哈希；
# 开发包无锁时回退为执行 --version 探测版本。
$componentRecords = @()
if ($nodeSource) {
  Copy-DirectoryContents $nodeSource (Join-Path $runtimeRoot 'node')
  $nodeExe = Join-Path $runtimeRoot 'node\node.exe'
  $version = Assert-LockedDirectory $lock 'node' $nodeSource 'node.exe'
  if ([string]::IsNullOrWhiteSpace($version)) { $version = Get-ToolVersion $nodeExe 'node-unknown' }
  $componentRecords += @(New-ComponentRecord 'node' $version 'node' 'node/node.exe' $runtimeRoot)
}
if ($msysSource) {
  Copy-DirectoryContents $msysSource (Join-Path $runtimeRoot 'msys')
  $bashExe = Join-Path $runtimeRoot 'msys\usr\bin\bash.exe'
  $version = Assert-LockedDirectory $lock 'msys2' $msysSource 'usr/bin/bash.exe'
  if ([string]::IsNullOrWhiteSpace($version)) { $version = Get-ToolVersion $bashExe 'msys2-unknown' }
  $componentRecords += @(New-ComponentRecord 'msys2' $version 'msys' 'msys/usr/bin/bash.exe' $runtimeRoot)
}
if ($gitSource) {
  Copy-DirectoryContents $gitSource (Join-Path $runtimeRoot 'native\mingit')
  $gitEntryRelative = 'cmd\git.exe'
  $gitExe = Join-Path $runtimeRoot (Join-Path 'native\mingit' $gitEntryRelative)
  $version = Assert-LockedDirectory $lock 'mingit' $gitSource $gitEntryRelative
  if ([string]::IsNullOrWhiteSpace($version)) { $version = Get-ToolVersion $gitExe 'mingit-unknown' }
  $componentRecords += @(New-ComponentRecord 'mingit' $version 'native/mingit' ($gitExe.Substring($runtimeRoot.Length + 1)) $runtimeRoot)
}
if ($rgSource) {
  $rgTarget = Join-Path $runtimeRoot 'native\rg\rg.exe'
  New-Item -ItemType Directory -Path (Split-Path -Parent $rgTarget) -Force | Out-Null
  Copy-Item -LiteralPath $rgSource -Destination $rgTarget -Force
  $version = Assert-LockedFile $lock 'ripgrep' $rgSource 'rg.exe'
  if ([string]::IsNullOrWhiteSpace($version)) { $version = Get-ToolVersion $rgTarget 'ripgrep-unknown' }
  $componentRecords += @(New-ComponentRecord 'ripgrep' $version 'native/rg' 'native/rg/rg.exe' $runtimeRoot)
}

# Native Host 自身也作为组件记录，纳入 manifest 的统一哈希覆盖。
$posixloomTarget = Join-Path $runtimeRoot 'native\posixloom-host\posixloom.exe'
New-Item -ItemType Directory -Path (Split-Path -Parent $posixloomTarget) -Force | Out-Null
Copy-Item -LiteralPath $hostExe -Destination $posixloomTarget -Force
$componentRecords += @(New-ComponentRecord 'posixloom' $RuntimeSemver 'native/posixloom-host' 'native/posixloom-host/posixloom.exe' $runtimeRoot)

# ---- 生成 shims ----
# 为 node/git/rg 生成 bash shim（对应组件存在时才生成），把命令名固定解析到
# Runtime 内的 POSIX 绝对路径，避免依赖外部 PATH；shims 目录本身也作为组件记录。
$shimRoot = Join-Path $runtimeRoot 'shims'
New-Item -ItemType Directory -Path $shimRoot -Force | Out-Null
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
# 写入一个 bash shim：exec 转发到 Runtime 内的绝对 POSIX 路径并透传全部参数；
# 以 UTF-8 无 BOM 编码写入，保证 MSYS2 bash 可直接解析。
function Write-Shim([string]$Name, [string]$Target) {
  $content = '#!/usr/bin/env bash' + "`nexec " + $Target + ' "$@"' + "`n"
  [IO.File]::WriteAllText((Join-Path $shimRoot $Name), $content, $utf8NoBom)
}
if (Test-Path -LiteralPath (Join-Path $runtimeRoot 'native\mingit\cmd\git.exe')) { Write-Shim 'git' '/posixloom/tools/mingit/cmd/git.exe' }
if (Test-Path -LiteralPath (Join-Path $runtimeRoot 'native\rg\rg.exe')) { Write-Shim 'rg' '/posixloom/tools/rg/rg.exe' }
if (Test-Path -LiteralPath (Join-Path $runtimeRoot 'node\node.exe')) { Write-Shim 'node' '/posixloom/runtime/node/node.exe' }
$shimRecord = New-ComponentRecord 'shims' $RuntimeSemver 'shims' 'shims/node' $runtimeRoot
if ($shimRecord) { $componentRecords += @($shimRecord) }

# ---- 许可证 ----
# 第三方许可证复制到包顶层与 Runtime 内各一份，Runtime 内相对路径记入 manifest。
$licenseFiles = [string[]]@()
if ($licenseSource) {
  $licenseTarget = Join-Path $Output 'licenses'
  Copy-DirectoryContents $licenseSource $licenseTarget
  $runtimeLicenseTarget = Join-Path $runtimeRoot 'licenses'
  Copy-DirectoryContents $licenseSource $runtimeLicenseTarget
  $licenseFiles = [string[]]@(Get-ChildItem -LiteralPath $runtimeLicenseTarget -File -Force -Recurse | ForEach-Object { $_.FullName.Substring($runtimeRoot.Length + 1).Replace('\', '/') })
}

# release 包必须包含全部六个组件（node/msys2/mingit/ripgrep/posixloom/shims）；
# 开发包允许为空（依赖外部回退）。
$requiredComponents = if ($mustHaveComponents) {
  [string[]]@('node', 'msys2', 'mingit', 'ripgrep', 'posixloom', 'shims')
} else {
  [string[]]@()
}

# 归一化为强类型 List 并过滤空项，避免 null/空字符串进入 manifest 的 JSON。
$licenseList = New-Object System.Collections.Generic.List[string]
foreach ($licenseFile in @($licenseFiles)) {
  if ($licenseFile) { [void]$licenseList.Add([string]$licenseFile) }
}
$licenseFiles = $licenseList
$requiredList = New-Object System.Collections.Generic.List[string]
foreach ($requiredId in @($requiredComponents)) {
  if ($requiredId) { [void]$requiredList.Add([string]$requiredId) }
}
$requiredComponents = $requiredList

# ---- 生成 SBOM 与 manifest ----
# 时间戳优先取 SourceDateEpoch 以支持可复现构建；SBOM 采用 SPDX-2.3 格式，
# 每个组件对应一个 SPDX package；manifest 汇总组件记录、许可证清单、SBOM 引用、
# 组件锁哈希与构建时间，并在提供 updateSequence 时附带更新序号。
$buildTime = if ($SourceDateEpoch) { [DateTimeOffset]::FromUnixTimeSeconds([Int64]$SourceDateEpoch).UtcDateTime } else { [DateTime]::UtcNow }
$sbom = [ordered]@{
  spdxVersion = 'SPDX-2.3'
  dataLicense = 'CC0-1.0'
  SPDXID = 'SPDXRef-DOCUMENT'
  name = "posixloom-$RuntimeId"
  documentNamespace = "https://posixloom.invalid/spdx/$RuntimeId"
  creationInfo = [ordered]@{ created = $buildTime.ToString('o'); creators = @('Tool: posixloom build-runtime.ps1') }
  packages = @($componentRecords | ForEach-Object { [ordered]@{ SPDXID = "SPDXRef-$($_.id)"; name = $_.id; versionInfo = $_.version; downloadLocation = 'NOASSERTION'; filesAnalyzed = $false; licenseConcluded = 'NOASSERTION'; licenseDeclared = 'NOASSERTION'; copyrightText = 'NOASSERTION' } })
}
[IO.File]::WriteAllText((Join-Path $runtimeRoot 'SBOM.spdx.json'), ($sbom | ConvertTo-Json -Depth 10) + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))
$manifest = [ordered]@{
  manifestVersion = 1
  runtimeId = $RuntimeId
  runtimeSemver = $RuntimeSemver
  mode = $Mode
  required = $requiredComponents
  components = @($componentRecords)
  licenses = $licenseFiles
  sbom = 'SBOM.spdx.json'
  sourceLockSha256 = $sourceLockSha256
  buildTimestamp = $buildTime.ToString('o')
  notes = if ($mustHaveComponents) { 'Release package assembled from explicit component roots; no PATH fallback is permitted.' } else { 'Development package; missing third-party components may use explicit development fallbacks.' }
}
if ($lockPath) { $manifest.sourceLock = 'components.lock.json' }
if ($UpdateSequence -gt 0) { $manifest.updateSequence = $UpdateSequence }
$manifestJson = $manifest | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText((Join-Path $runtimeRoot 'manifest.json'), $manifestJson + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false))

# ---- 生成归档与 SHA256SUMS ----
# 先产出 Runtime 更新归档（仅含 runtimeRoot，供更新事务下载）；
# 再对包内全部文件（排除 SHA256SUMS 自身）按路径排序计算哈希写入 SHA256SUMS；
# 最后打包完整分发包，两个归档路径不得相同。
$runtimeArchive = $runtimeArchiveTarget
if (Test-Path -LiteralPath $runtimeArchive) { Remove-Item -LiteralPath $runtimeArchive -Force }
if (!$SkipArchive) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($runtimeRoot, $runtimeArchive, [IO.Compression.CompressionLevel]::Optimal, $false)
  Write-Host "Created Runtime update archive: $runtimeArchive"
}
$sumsPath = Join-Path $Output 'SHA256SUMS'
$sumLines = Get-ChildItem -LiteralPath $Output -File -Force -Recurse | Where-Object { $_.FullName -ne $sumsPath } | Sort-Object FullName | ForEach-Object {
  $relative = $_.FullName.Substring($Output.Length + 1).Replace('\', '/')
  "{0}  {1}" -f (Get-Sha256Hex $_.FullName), $relative
}
[IO.File]::WriteAllLines($sumsPath, $sumLines, [System.Text.UTF8Encoding]::new($false))
$archive = $packageArchiveTarget
if (!$SkipArchive) {
  if ([IO.Path]::GetFullPath($archive).Equals([IO.Path]::GetFullPath($runtimeArchive), [StringComparison]::OrdinalIgnoreCase)) { throw 'Package archive path collides with Runtime archive path' }
  if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
  [IO.Compression.ZipFile]::CreateFromDirectory($Output, $archive, [IO.Compression.CompressionLevel]::Optimal, $false)
  Write-Host "Created package archive: $archive"
}
# 开发包缺少必需组件时明确警告，提示改用 release 模式组装自包含发布包。
if (!$mustHaveComponents) {
  Write-Warning 'Development package assembled without mandatory third-party components. Use -Mode release with explicit NodeRoot, MsysRoot, MinGitRoot, RipgrepExe and LicensesRoot for a self-contained package.'
}
