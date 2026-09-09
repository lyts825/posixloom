<#
.SYNOPSIS
  验证已组装的 PosixLoom 便携包目录（build-runtime.ps1 的产物）。

.DESCRIPTION
  发布流水线中位于 build-runtime.ps1 之后，对包做完整性验证：
  - 校验 runtime\current 指针与 manifest 身份（runtimeId、manifestVersion、mode）；
  - 拒绝包内任何 reparse point（符号链接/junction），防止哈希校验被链接绕过；
  - 逐行核对 SHA256SUMS：哈希与路径格式、规范化包内相对路径（禁止绝对路径、
    盘符、反斜杠、空段与 ./.. 跳转）、排除可变的 data/ 目录与 SHA256SUMS 自身、
    路径不重复、目标存在且未逃逸包根、哈希与实际文件一致；
  - 反向核对包内全部不可变文件均被登记且数量相等（无遗漏、无多余）；
  - 在隔离的临时 DataRoot/Workspace 中运行包内 posixloom 的 runtime doctor，
    release 包必须全部通过，development 包仅允许外部 Bash 回退缺失（告警）。

.PARAMETER PackageRoot
  待验证的包目录（即 build-runtime.ps1 的 -Output）。
.PARAMETER RunCorpus
  额外执行真实兼容性语料：通过包内 posixloom.exe 真实运行 node/bash/git/rg，
  覆盖含空格与中文的 argv 透传、bash 的 cwd/环境变量、ripgrep 路径搜索、
  git init 建仓等场景（publish-environment.ps1 默认开启，可用 -SkipCorpus 跳过）。

.NOTES
  语料刻意使用含空格与非 ASCII（中文）的路径与参数，用于暴露参数引用、
  编码与路径翻译的兼容性缺陷。验证期间临时替换 POSIXLOOM_WORKSPACE/POSIXLOOM_DATA_ROOT
  环境变量，结束后恢复并清理临时目录。
#>
param(
  # 待验证的包目录（build-runtime.ps1 的 -Output）
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  # 执行真实兼容性语料（node/bash/git/rg 四组件）
  [switch]$RunCorpus
)

$ErrorActionPreference = 'Stop'

# 计算文件 SHA-256，返回小写十六进制字符串（与 SHA256SUMS 登记值比对）。
function Get-Sha256Hex([string]$Path) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($Path)
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '')).ToLowerInvariant() }
  finally { $stream.Dispose(); $sha.Dispose() }
}

# ---- 定位启动器并读取 Runtime 身份 ----
# 依次校验：包根不是 reparse point、runtime\current 指针格式合法、
# 对应版本的 manifest 存在且身份字段（清单版本/ID/模式）自洽。
$posixloom = Join-Path (Resolve-Path $PackageRoot).Path 'posixloom.exe'
if (!(Test-Path -LiteralPath $posixloom)) { throw "posixloom.exe not found: $posixloom" }
$package = (Resolve-Path $PackageRoot).Path
$packageItem = Get-Item -LiteralPath $package -Force
if (($packageItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Package root cannot be a reparse point: $package" }
$packagePrefix = $package.TrimEnd('\') + '\'
$pointerPath = Join-Path $package 'runtime\current'
if (!(Test-Path -LiteralPath $pointerPath -PathType Leaf)) { throw "Runtime pointer missing: $pointerPath" }
$runtimeId = (Get-Content -LiteralPath $pointerPath -Raw).Trim()
if ($runtimeId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "Runtime pointer contains an invalid id: $runtimeId" }
$manifestPath = Join-Path $package "runtime\versions\$runtimeId\manifest.json"
if (!(Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Runtime manifest missing: $manifestPath" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.manifestVersion -ne 1 -or [string]$manifest.runtimeId -ne $runtimeId -or [string]$manifest.mode -notin @('development', 'release')) { throw "Runtime manifest identity or mode is invalid: $manifestPath" }
$runtimeMode = [string]$manifest.mode
# ---- 校验 SHA256SUMS 完整性 ----
# SHA256SUMS 文件必须存在；包内不允许任何 reparse point（符号链接/junction），
# 防止后续哈希校验被链接绕过。
$sums = Join-Path $package 'SHA256SUMS'
if (!(Test-Path -LiteralPath $sums -PathType Leaf)) { throw "SHA256SUMS is required: $sums" }
$reparsePoints = @(Get-ChildItem -LiteralPath $package -Force -Recurse | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 })
if ($reparsePoints.Count -gt 0) { throw "Package contains a reparse point: $($reparsePoints[0].FullName)" }
# 逐行校验：两空格分隔的「哈希 相对路径」格式、规范化路径（禁止绝对路径/
# 盘符/反斜杠/空段/./..）、排除可变 data/ 与 SHA256SUMS 自身、路径不重复、
# 目标存在且解析后仍在包根内、实际哈希与登记值一致。
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
foreach ($line in @(Get-Content -LiteralPath $sums)) {
    if (!$line.Trim()) { continue }
    if ($line -notmatch '^([0-9a-fA-F]{64})  (.+)$') { throw "Invalid SHA256SUMS line: $line" }
    $digest = $Matches[1]
    $relative = $Matches[2]
    if ($digest -notmatch '^[0-9a-fA-F]{64}$') { throw "Invalid SHA256SUMS digest: $digest" }
    if ([IO.Path]::IsPathRooted($relative) -or $relative.Contains(':') -or $relative.Contains('\')) { throw "SHA256SUMS path is not a canonical package-relative path: $relative" }
    $normalizedRelative = $relative.Replace('\', '/')
    $segments = @($normalizedRelative -split '/')
    if ($segments | Where-Object { [string]::IsNullOrEmpty($_) -or $_ -eq '.' -or $_ -eq '..' }) { throw "SHA256SUMS path is not canonical: $relative" }
    if ($normalizedRelative -eq 'SHA256SUMS' -or $normalizedRelative.StartsWith('data/', [StringComparison]::OrdinalIgnoreCase)) { throw "SHA256SUMS contains a mutable or self-referential path: $relative" }
    if (!$seen.Add($normalizedRelative)) { throw "SHA256SUMS contains a duplicate path: $relative" }
    $target = Join-Path $package $relative
    if (!(Test-Path -LiteralPath $target -PathType Leaf)) { throw "SHA256SUMS target missing: $target" }
    $resolvedTarget = (Resolve-Path -LiteralPath $target).Path
    if (!$resolvedTarget.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "SHA256SUMS target escapes package: $relative" }
    $actual = Get-Sha256Hex $target
    if ($actual -ne $digest.ToLowerInvariant()) { throw "SHA256SUMS mismatch: $target" }
}
# 反向核对：包内全部不可变文件（排除 SHA256SUMS 与 data/）必须都已登记，
# 且登记数与实际文件数相等--保证清单无遗漏、无多余文件。
$packageFiles = @(Get-ChildItem -LiteralPath $package -File -Force -Recurse | ForEach-Object {
  $_.FullName.Substring($package.Length + 1).Replace('\', '/')
} | Where-Object { $_ -ne 'SHA256SUMS' -and !$_.StartsWith('data/', [StringComparison]::OrdinalIgnoreCase) })
foreach ($relative in $packageFiles) {
  if (!$seen.Contains($relative)) { throw "Package file is not covered by SHA256SUMS: $relative" }
}
if ($seen.Count -ne $packageFiles.Count) { throw "SHA256SUMS file count does not match the package" }

# ---- 隔离环境中的运行时自检与兼容性语料 ----
# 在系统临时目录下创建一次性验证根（并复核其确实落在临时目录内），
# 其中构建独立的 DataRoot 与 Workspace（名称含空格与中文，顺带覆盖路径翻译）；
# 备份并替换进程环境变量，无论成败都在 finally 中恢复并清理。
$previousWorkspace = $env:POSIXLOOM_WORKSPACE
$previousDataRoot = $env:POSIXLOOM_DATA_ROOT
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$verificationRoot = Join-Path $tempBase ("posixloom-verify-" + [Guid]::NewGuid().ToString('N'))
if (![IO.Path]::GetFullPath($verificationRoot).StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe verification root: $verificationRoot" }
try {
  $workspace = Join-Path $verificationRoot '工作 空间'
  $env:POSIXLOOM_DATA_ROOT = Join-Path $verificationRoot 'data'
  $env:POSIXLOOM_WORKSPACE = $workspace
  New-Item -ItemType Directory -Path $workspace -Force | Out-Null
  # 运行包内 posixloom 的 runtime doctor：release 包要求全部检查通过且退出码为 0；
  # development 包仅允许 bash 检查失败（外部回退不可用），此时降级为告警。
  $output = & $posixloom runtime doctor --json 2>&1
  $doctorExitCode = $LASTEXITCODE
  try { $doctorReport = ($output -join "`n") | ConvertFrom-Json } catch { $output; throw "Runtime doctor did not return valid JSON" }
  $unexpectedFailures = @($doctorReport.checks | Where-Object { $_.level -eq 'FAIL' -and !($runtimeMode -eq 'development' -and $_.id -eq 'bash') })
  if ($unexpectedFailures.Count -gt 0 -or ($runtimeMode -eq 'release' -and ($doctorExitCode -ne 0 -or !$doctorReport.ok))) {
    $output
    throw "Runtime doctor failed package validation with exit code $doctorExitCode"
  }
  if ($runtimeMode -eq 'development' -and $doctorExitCode -ne 0) { Write-Warning 'Development package uses an external Bash fallback that is unavailable on this machine.' }
  $output
  # ---- 真实兼容性语料（-RunCorpus）----
  # 四个语料分别覆盖：argv 透传、bash cwd/环境变量、ripgrep 路径搜索、
  # git 建仓，全部使用含空格与中文的路径/参数以暴露编码与路径翻译缺陷。
  if ($RunCorpus) {
    # 语料 1：Node argv 精确透传（含空格、& 与中文字符，不允许被引号/转义破坏）。
    $exactArgument = 'a b&中'
    $argvOutput = & $posixloom exec -- node -p 'process.argv.at(1)' $exactArgument 2>&1
    if ($LASTEXITCODE -ne 0 -or (($argvOutput -join "`n").Trim() -ne $exactArgument)) { $argvOutput; throw 'argv compatibility corpus failed' }

    # 语料 2：bash 在含空格中文目录中切换 cwd 并导出环境变量，
    # 验证工作目录挂载与变量透传；期间把输出编码切换为 UTF-8 保证中文正确传输。
    $subdirectory = Join-Path $workspace '子 目录'
    New-Item -ItemType Directory -Path $subdirectory -Force | Out-Null
    $shellScript = 'cd "/workspace/子 目录" && export POSIXLOOM_CORPUS="值" && printf "%s|%s" "$PWD" "$POSIXLOOM_CORPUS"'
    $previousOutputEncoding = $OutputEncoding
    try {
      $OutputEncoding = [Text.UTF8Encoding]::new($false)
      $shellOutput = $shellScript | & $posixloom shell --stdin 2>&1
    } finally {
      $OutputEncoding = $previousOutputEncoding
    }
    if ($LASTEXITCODE -ne 0 -or (($shellOutput -join "`n").Trim() -ne '/workspace/子 目录|值')) { $shellOutput; throw 'shell cwd/env compatibility corpus failed' }

    # 语料 3：ripgrep 在含空格中文路径下做固定字符串搜索，验证路径翻译与 UTF-8 匹配。
    $searchFile = Join-Path $workspace '资料 文件.txt'
    [IO.File]::WriteAllText($searchFile, "needle-你好`n", [Text.UTF8Encoding]::new($false))
    $rgOutput = & $posixloom exec -- rg --fixed-strings 'needle-你好' '/workspace/资料 文件.txt' 2>&1
    if ($LASTEXITCODE -ne 0 -or !(($rgOutput -join "`n").Contains('needle-你好'))) { $rgOutput; throw 'ripgrep path compatibility corpus failed' }

    # 语料 4：git 在含空格中文路径下 init 建仓，并确认 .git 目录真实生成。
    $gitOutput = & $posixloom exec -- git init '/workspace/仓 库' 2>&1
    if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath (Join-Path $workspace '仓 库\.git') -PathType Container)) { $gitOutput; throw 'git path compatibility corpus failed' }
  }
}
finally {
  if ($null -eq $previousWorkspace) { Remove-Item Env:POSIXLOOM_WORKSPACE -ErrorAction SilentlyContinue }
  else { $env:POSIXLOOM_WORKSPACE = $previousWorkspace }
  if ($null -eq $previousDataRoot) { Remove-Item Env:POSIXLOOM_DATA_ROOT -ErrorAction SilentlyContinue }
  else { $env:POSIXLOOM_DATA_ROOT = $previousDataRoot }
  if (Test-Path -LiteralPath $verificationRoot) { Remove-Item -LiteralPath $verificationRoot -Recurse -Force }
}
