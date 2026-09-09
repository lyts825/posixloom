<#
.SYNOPSIS
  Fail-closed Defender release gate for an assembled package and optional ZIP archives.
.DESCRIPTION
  Uses a custom scan with -DisableRemediation: no Defender settings are changed,
  exclusions are ignored by the scanner, and detected files are not deliberately
  remediated by this scan. Real-time protection remains enabled throughout.
  The package must already pass verify-runtime.ps1. Before/after hashes detect
  files removed or changed by real-time protection during validation.
  A passing scan certifies only this machine, signature version and artifact.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$PackageRoot,
  [string[]]$ArchivePaths = @(),
  [string]$ReportPath,
  [ValidateRange(1, 168)][int]$MaxSignatureAgeHours = 72,
  [ValidateRange(10, 3600)][int]$TimeoutSeconds = 1200,
  [switch]$RequireClientWindows,
  [ValidateSet('10', '11')][string]$ExpectedWindows
)

$ErrorActionPreference = 'Stop'
$package = [IO.Path]::GetFullPath($PackageRoot)
if ([string]::IsNullOrWhiteSpace($ReportPath)) { $ReportPath = "$package.defender.json" }
$ReportPath = [IO.Path]::GetFullPath($ReportPath)
$packagePrefix = $package.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($ReportPath.StartsWith($packagePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The scan report must be outside the immutable package.' }
$report = [ordered]@{
  schemaVersion = 1
  startedAt = [DateTime]::UtcNow.ToString('o')
  status = 'failed'
  stage = 'preflight'
  packageRoot = $package
  scans = @()
  settingsChanged = $false
}
$scanProcess = $null
try {
  if ($env:OS -ne 'Windows_NT') { throw 'Defender verification requires Windows.' }
  if (!(Test-Path -LiteralPath $package -PathType Container)) { throw "Package does not exist: $package" }
  foreach ($relative in @('posixloom.exe', 'SHA256SUMS', 'dist\src\core\assets\state-report.sh', 'dist\src\core\assets\extract-runtime.ps1')) {
    if (!(Test-Path -LiteralPath (Join-Path $package $relative) -PathType Leaf)) { throw "Required package file missing: $relative" }
  }
  $osInfo = Get-CimInstance Win32_OperatingSystem
  $report.os = [ordered]@{ caption = $osInfo.Caption; version = $osInfo.Version; build = $osInfo.BuildNumber; productType = $osInfo.ProductType }
  if ($RequireClientWindows -and ($osInfo.ProductType -ne 1 -or ([Version]$osInfo.Version).Major -ne 10)) { throw 'This gate requires Windows 10 or 11 client, not Windows Server.' }
  $family = if ([int]$osInfo.BuildNumber -ge 22000) { '11' } else { '10' }
  if ($ExpectedWindows -and $family -ne $ExpectedWindows) { throw "Expected Windows $ExpectedWindows, found Windows $family." }
  $status = Get-MpComputerStatus
  $report.defender = [ordered]@{
    serviceEnabled = $status.AMServiceEnabled
    antivirusEnabled = $status.AntivirusEnabled
    realtimeEnabled = $status.RealTimeProtectionEnabled
    signatureVersion = $status.AntivirusSignatureVersion
    signatureUpdatedAt = $status.AntivirusSignatureLastUpdated.ToUniversalTime().ToString('o')
    engineVersion = $status.AMEngineVersion
    productVersion = $status.AMProductVersion
  }
  if (!$status.AMServiceEnabled -or !$status.AntivirusEnabled -or !$status.RealTimeProtectionEnabled) { throw 'Defender antivirus service and real-time protection must already be enabled.' }
  if (([DateTime]::Now - $status.AntivirusSignatureLastUpdated).TotalHours -gt $MaxSignatureAgeHours) { throw "Defender signatures are older than $MaxSignatureAgeHours hours. Update them through normal machine administration and rerun." }

  $platform = Join-Path $env:ProgramData 'Microsoft\Windows Defender\Platform'
  $scanners = @(Get-ChildItem -LiteralPath $platform -Directory -ErrorAction SilentlyContinue |
    Sort-Object { try { [Version]($_.Name -replace '-.*$', '') } catch { [Version]'0.0' } } -Descending |
    ForEach-Object { Join-Path $_.FullName 'MpCmdRun.exe' })
  $scanners += Join-Path $env:ProgramFiles 'Windows Defender\MpCmdRun.exe'
  $scanner = $scanners | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (!$scanner) { throw 'MpCmdRun.exe is unavailable; no scan was performed.' }

  $items = @((Get-Item -LiteralPath $package -Force)) + @(Get-ChildItem -LiteralPath $package -Recurse -Force)
  if (@($items | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -gt 0) { throw 'Package cannot contain reparse points.' }
  $files = @($items | Where-Object { !$_.PSIsContainer })
  $targets = @($package)
  foreach ($archivePath in $ArchivePaths) {
    $archive = Get-Item -LiteralPath ([IO.Path]::GetFullPath($archivePath))
    if ($archive.PSIsContainer -or $archive.Extension -ne '.zip' -or ($archive.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Additional scan targets must be regular ZIP files.' }
    $targets += $archive.FullName
    $files += $archive
  }
  $before = @{}
  foreach ($file in $files) { $before[$file.FullName] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash }
  $report.fileCount = $before.Count
  $report.packageChecksumsSha256 = (Get-FileHash -LiteralPath (Join-Path $package 'SHA256SUMS') -Algorithm SHA256).Hash.ToLowerInvariant()
  $report.stage = 'scan'
  New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null
  $index = 0
  foreach ($target in $targets) {
    $stdout = "$ReportPath.scan-$index.stdout.log"
    $stderr = "$ReportPath.scan-$index.stderr.log"
    Write-Host "Defender custom scan: $target"
    $scanProcess = Start-Process -FilePath $scanner -ArgumentList @('-Scan', '-ScanType', '3', '-File', ('"' + $target + '"'), '-DisableRemediation') -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    # Retain the process handle before it exits (Windows PowerShell 5.1 otherwise
    # sometimes reports a null ExitCode after WaitForExit).
    $null = $scanProcess.Handle
    if (!$scanProcess.WaitForExit($TimeoutSeconds * 1000)) {
      $scanProcess.Kill()
      $scanProcess.WaitForExit()
      throw "Defender scan timed out after $TimeoutSeconds seconds."
    }
    $scanProcess.WaitForExit()
    $exitCode = $scanProcess.ExitCode
    $scanProcess.Dispose()
    $scanProcess = $null
    $report.scans += [ordered]@{ target = $target; exitCode = $exitCode; output = $stdout; errors = $stderr }
    if ($exitCode -ne 0) { throw "Defender did not return a clean scan (exit $exitCode). Inspect $stdout and $stderr. No exclusions or protection changes were applied." }
    $index += 1
  }
  $report.stage = 'post-scan-integrity'
  foreach ($entry in $before.GetEnumerator()) {
    if (!(Test-Path -LiteralPath $entry.Key -PathType Leaf) -or (Get-FileHash -LiteralPath $entry.Key -Algorithm SHA256).Hash -ne $entry.Value) { throw "Package file was removed or changed during scanning: $($entry.Key)" }
  }
  if (@(Get-ChildItem -LiteralPath $package -Recurse -File -Force).Count -ne @($items | Where-Object { !$_.PSIsContainer }).Count) { throw 'Package file inventory changed during scanning.' }
  $afterStatus = Get-MpComputerStatus
  if (!$afterStatus.AMServiceEnabled -or !$afterStatus.AntivirusEnabled -or !$afterStatus.RealTimeProtectionEnabled) { throw 'Defender protection state changed during scanning.' }
  $report.status = 'passed'
  $report.stage = 'complete'
} catch {
  $report.error = $_.Exception.Message
  throw
} finally {
  if ($scanProcess) { $scanProcess.Dispose() }
  $report.finishedAt = [DateTime]::UtcNow.ToString('o')
  New-Item -ItemType Directory -Path (Split-Path -Parent $ReportPath) -Force | Out-Null
  $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
  Write-Host "Defender report: $ReportPath ($($report.status))"
}
