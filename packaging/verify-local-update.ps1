<#
.SYNOPSIS
  在隔离 DataRoot 中端到端复验本地更新与回滚（更新冒烟测试）。

.DESCRIPTION
  面向 publish-environment.ps1 产出的签名 Feed，验证完整更新链路：
  在仓库 artifacts 下的专用 DataRoot 中写入仅信任该 Feed 公钥的配置，
  然后用真实 posixloom CLI（node dist/src/cli/main.js）依次执行：
  1. runtime update --force：从本地 Feed 下载归档、校验 Ed25519 签名、
     安装新的完整 Runtime（不做任何 mock）；
  2. runtime doctor：新 Runtime 自检必须全部通过；
  3. 组件冒烟：node/git/rg 版本必须与组件锁一致，shell 输出验证 UTF-8 透传；
  4. runtime rollback：回滚到开发 Runtime 并确认指针恢复。

  设计意图：
  - 更新事务只作用于隔离 DataRoot，绝不触碰安装目录；本脚本验证的正是
    「下载->验签->安装->回滚」这条真实链路，而非模拟结果；
  - 配置强制 requireSignature 且 trustedKeys 仅含本次发布公钥，
    冒烟同时覆盖签名校验路径；
  - DataRoot 必须位于仓库 artifacts 内且携带管理标记文件，防止误删真实数据。

.PARAMETER Feed
  已签名的更新 Feed 文件（environment-feed.json）。
.PARAMETER KeyId
  与签名私钥配对的密钥标识（写入 trustedKeys）。
.PARAMETER PublicKey
  Ed25519 公钥文件路径（写入 trustedKeys）。
.PARAMETER ComponentLock
  组件锁文件，用于断言冒烟输出的组件版本与锁一致。
.PARAMETER DataRoot
  冒烟用隔离数据目录；必须位于仓库 artifacts 内，会被重建与清理。
#>
[CmdletBinding()]
param(
  # 已签名的更新 Feed 文件路径
  [Parameter(Mandatory = $true)][string]$Feed,
  # 与签名私钥配对的密钥标识
  [Parameter(Mandatory = $true)][string]$KeyId,
  # Ed25519 公钥文件路径
  [Parameter(Mandatory = $true)][string]$PublicKey,
  # 组件锁文件，用于断言组件版本一致
  [string]$ComponentLock = (Join-Path (Get-Location) 'packaging\components.lock.json'),
  # 隔离冒烟数据目录（必须位于仓库 artifacts 内）
  [string]$DataRoot = (Join-Path (Get-Location) 'artifacts\update-smoke-data')
)

# ---- 路径解析与前置校验 ----
# DataRoot 强制位于仓库 artifacts 内，避免冒烟操作波及用户真实数据目录。
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$artifactsRoot = [IO.Path]::GetFullPath((Join-Path $root 'artifacts')).TrimEnd('\') + '\'
$Feed = (Resolve-Path -LiteralPath $Feed).Path
$PublicKey = (Resolve-Path -LiteralPath $PublicKey).Path
$ComponentLock = (Resolve-Path -LiteralPath $ComponentLock).Path
$DataRoot = [IO.Path]::GetFullPath($DataRoot).TrimEnd('\')
if (!$DataRoot.StartsWith($artifactsRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Update smoke DataRoot must be inside repository artifacts: $DataRoot" }
if ($KeyId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw "Invalid KeyId: $KeyId" }
# ---- 准备受管理的冒烟 DataRoot ----
# 读取组件锁版本供后续断言；只允许清理带管理标记（.posixloom-update-smoke）的目录，
# 然后重建标记文件、Workspace（名称含空格与中文，顺带覆盖路径翻译）与配置。
$componentVersions = (Get-Content -LiteralPath $ComponentLock -Raw | ConvertFrom-Json).components
$marker = Join-Path $DataRoot '.posixloom-update-smoke'
if (Test-Path -LiteralPath $DataRoot) {
  if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { throw "Refusing to replace an unmanaged update smoke directory: $DataRoot" }
  Remove-Item -LiteralPath $DataRoot -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $DataRoot 'config') -Force | Out-Null
[IO.File]::WriteAllText($marker, "managed update smoke`n", [Text.UTF8Encoding]::new($false))
$workspace = Join-Path $DataRoot '工作 空间'
New-Item -ItemType Directory -Path $workspace -Force | Out-Null
# 冒烟配置：启用更新但手动应用（autoApply=false）、使用本地 Feed、
# 强制签名校验，信任列表只包含本次发布密钥的公钥。
$config = [ordered]@{
  runtime = [ordered]@{ workspace = $workspace }
  updates = [ordered]@{
    enabled = $true
    autoApply = $false
    channel = 'stable'
    feedUrl = $Feed
    checkIntervalMs = 0
    requireSignature = $true
    trustedKeys = [ordered]@{ $KeyId = [IO.File]::ReadAllText($PublicKey) }
  }
}
[IO.File]::WriteAllText((Join-Path $DataRoot 'config\config.json'), ($config | ConvertTo-Json -Depth 8) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))

# ---- 执行真实更新/回滚链路 ----
# 临时替换进程环境变量与输出编码（UTF-8 无 BOM），
# 无论成败都在 finally 中恢复环境并删除冒烟 DataRoot。
$previousDataRoot = $env:POSIXLOOM_DATA_ROOT
$previousWorkspace = $env:POSIXLOOM_WORKSPACE
$previousOutputEncoding = $OutputEncoding
try {
  $env:POSIXLOOM_DATA_ROOT = $DataRoot
  $env:POSIXLOOM_WORKSPACE = $workspace
  $OutputEncoding = [Text.UTF8Encoding]::new($false)
  $cli = Join-Path $root 'dist\src\cli\main.js'
  # 1) 强制执行签名更新：必须报告已安装（installed）且要求重启，
  #    验证「下载->验签->解压->校验->安装」整条事务链路。
  $updateOutput = & node $cli runtime update --force --json 2>&1
  if ($LASTEXITCODE -ne 0) { $updateOutput; throw 'Real signed Runtime update failed' }
  $update = ($updateOutput -join "`n") | ConvertFrom-Json
  if ($update.status -ne 'installed' -or !$update.restartRequired) { $updateOutput; throw 'Real signed Runtime update did not install a new snapshot' }

  # 2) 新装 Runtime 的 doctor 自检必须全部通过（ok=true 且退出码 0）。
  $doctorOutput = & node $cli runtime doctor --json 2>&1
  if ($LASTEXITCODE -ne 0) { $doctorOutput; throw 'Installed Runtime doctor failed' }
  $doctor = ($doctorOutput -join "`n") | ConvertFrom-Json
  if (!$doctor.ok) { $doctorOutput; throw 'Installed Runtime doctor reported failure' }

  # 3) 组件冒烟：node/git/rg 版本必须与组件锁记录完全一致，
  #    shell 输出验证 MSYS2 bash 的 UTF-8 透传。
  $nodeLines = & node $cli exec -- node --version 2>&1
  $nodeExitCode = $LASTEXITCODE
  $nodeVersion = ($nodeLines -join "`n").Trim()
  if ($nodeExitCode -ne 0 -or $nodeVersion -ne "v$($componentVersions.node.version)") { throw "Installed Node smoke failed: $nodeVersion" }
  $gitLines = & node $cli exec -- git --version 2>&1
  $gitExitCode = $LASTEXITCODE
  $gitVersion = ($gitLines -join "`n").Trim()
  if ($gitExitCode -ne 0 -or $gitVersion -ne "git version $($componentVersions.mingit.version)") { throw "Installed MinGit smoke failed: $gitVersion" }
  $rgLines = & node $cli exec -- rg --version 2>&1
  $rgExitCode = $LASTEXITCODE
  $rgVersion = ($rgLines -join "`n").Trim()
  if ($rgExitCode -ne 0 -or !$rgVersion.StartsWith("ripgrep $($componentVersions.ripgrep.version)")) { throw "Installed ripgrep smoke failed: $rgVersion" }
  $shellOutput = 'printf "%s" "update-你好"' | & node $cli shell --stdin 2>&1
  if ($LASTEXITCODE -ne 0 -or ($shellOutput -join "`n").Trim() -ne 'update-你好') { $shellOutput; throw 'Installed MSYS2 Bash smoke failed' }

  # 4) 回滚到上一个 Runtime：必须恢复开发 Runtime（runtime-dev），
  #     验证补偿事务把指针安全回退。
  $rollbackOutput = & node $cli runtime rollback --json 2>&1
  if ($LASTEXITCODE -ne 0) { $rollbackOutput; throw 'Real Runtime rollback failed' }
  $rollback = ($rollbackOutput -join "`n") | ConvertFrom-Json
  if ($rollback.runtimeId -ne 'runtime-dev') { $rollbackOutput; throw 'Rollback did not restore the development Runtime' }
  Write-Host "Real signed update smoke passed: $($update.runtimeId) -> runtime-dev"
} finally {
  $OutputEncoding = $previousOutputEncoding
  if ($null -eq $previousDataRoot) { Remove-Item Env:POSIXLOOM_DATA_ROOT -ErrorAction SilentlyContinue } else { $env:POSIXLOOM_DATA_ROOT = $previousDataRoot }
  if ($null -eq $previousWorkspace) { Remove-Item Env:POSIXLOOM_WORKSPACE -ErrorAction SilentlyContinue } else { $env:POSIXLOOM_WORKSPACE = $previousWorkspace }
  if (Test-Path -LiteralPath $marker -PathType Leaf) { Remove-Item -LiteralPath $DataRoot -Recurse -Force }
}
