# Auditable Runtime extraction helper. Paths and limits are supplied as environment data.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Path]::GetFullPath($env:POSIXLOOM_UPDATE_ARCHIVE)
$destination = [IO.Path]::GetFullPath($env:POSIXLOOM_UPDATE_DEST)
$prefix = $destination.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$maximum = [Int64]$env:POSIXLOOM_UPDATE_EXPANDED_MAX
$seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$count = 0
$expanded = [Int64]0
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
  foreach ($entry in $zip.Entries) {
    $count += 1
    if ($count -gt 200000) { throw 'Runtime archive contains too many entries' }
    $name = $entry.FullName.Replace('/', '\')
    if ([string]::IsNullOrWhiteSpace($name) -or [IO.Path]::IsPathRooted($name) -or $name.Contains(':')) { throw "Unsafe Runtime archive entry: $($entry.FullName)" }
    $normalized = $name.TrimEnd('\')
    $segments = @($normalized -split '\\')
    if ([string]::IsNullOrWhiteSpace($normalized) -or ($segments | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' })) { throw "Unsafe Runtime archive entry: $($entry.FullName)" }
    if (!$seen.Add($normalized)) { throw "Duplicate Runtime archive entry: $($entry.FullName)" }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($destination, $name))
    if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Runtime archive entry escapes staging: $($entry.FullName)" }
    $expanded += [Int64]$entry.Length
    if ($expanded -gt $maximum) { throw 'Runtime archive expanded size exceeds the configured limit' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination)
