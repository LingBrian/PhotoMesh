param(
  [Parameter(Mandatory = $true)][string]$RepositoryRoot,
  [Parameter(Mandatory = $true)][string]$FileList,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($RepositoryRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$destinationPath = [IO.Path]::GetFullPath($Destination)
if (-not $destinationPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetExtension($destinationPath) -ne '.zip') {
  throw 'Candidate ZIP must be written inside the repository output directory.'
}
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$stage = Join-Path $tempRoot ("photomesh-release-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $stage
try {
  $count = 0
  Get-Content -LiteralPath $FileList -Encoding UTF8 | Where-Object { $_ } | ForEach-Object {
  $candidate = [IO.Path]::GetFullPath((Join-Path $root $_))
  if (-not $candidate.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Archive path escaped the repository: $_"
  }
  if (Test-Path -LiteralPath $candidate -PathType Leaf) {
    if (([IO.File]::GetAttributes($candidate) -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Refusing to package a symlink/reparse point: $_"
    }
    $destination = [IO.Path]::GetFullPath((Join-Path $stage $_))
    if (-not $destination.StartsWith($stage + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Archive path escaped its staging directory: $_"
    }
    $parent = Split-Path -Parent $destination
    $null = New-Item -ItemType Directory -Path $parent -Force
    Copy-Item -LiteralPath $candidate -Destination $destination
    $count++
  }
}
  if ($count -eq 0) { throw 'No source files found for release candidate archive.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $destinationPath) { [IO.File]::Delete($destinationPath) }
  [IO.Compression.ZipFile]::CreateFromDirectory($stage, $destinationPath, [IO.Compression.CompressionLevel]::Optimal, $false)
} finally {
  if ($stage.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and $stage -like "$tempRoot`photomesh-release-*") {
    Remove-Item -LiteralPath $stage -Recurse -Force
  }
}
