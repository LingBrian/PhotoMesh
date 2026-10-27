function ConvertTo-PhotoMeshCanonicalPath {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { throw 'A filesystem path is required.' }
  try { return [IO.Path]::GetFullPath($Path) }
  catch { throw "Invalid filesystem path: $Path" }
}

function Assert-PhotoMeshPathUnderRoot {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$AllowRoot
  )
  $fullPath = ConvertTo-PhotoMeshCanonicalPath -Path $Path
  $fullRoot = (ConvertTo-PhotoMeshCanonicalPath -Path $Root).TrimEnd([char[]]@('\', '/'))
  if ($fullRoot.Length -eq 2 -and $fullRoot[1] -eq ':') { $fullRoot += '\' }
  $prefix = $fullRoot.TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
  if ($AllowRoot -and [string]::Equals($fullPath.TrimEnd([char[]]@('\', '/')), $fullRoot.TrimEnd([char[]]@('\', '/')), [StringComparison]::OrdinalIgnoreCase)) {
    return $fullPath
  }
  if (-not $fullPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is not a child of its allowed root: $fullPath"
  }
  return $fullPath
}

function Assert-PhotoMeshPathChainHasNoReparsePoint {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$TrustedRoot
  )
  $fullTrustedRoot = ConvertTo-PhotoMeshCanonicalPath -Path $TrustedRoot
  $fullPath = Assert-PhotoMeshPathUnderRoot -Path $Path -Root $fullTrustedRoot -AllowRoot
  $relative = $fullPath.Substring($fullTrustedRoot.TrimEnd([char[]]@('\', '/')).Length).TrimStart([char[]]@('\', '/'))
  $cursor = $fullTrustedRoot
  $segments = @($relative -split '[\\/]+' | Where-Object { $_ })
  foreach ($segment in $segments) {
    $cursor = Join-Path $cursor $segment
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Refusing to use a reparse point in the PhotoMesh install path: $cursor"
      }
    }
  }
  return $fullPath
}

function Assert-PhotoMeshTreeHasNoReparsePoint {
  [CmdletBinding()]
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "Directory does not exist: $Path" }
  $rootItem = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Refusing to process a reparse-point directory: $Path"
  }
  $reparseItem = Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop |
    Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
    Select-Object -First 1
  if ($reparseItem) { throw "Refusing to process a package tree containing a reparse point: $($reparseItem.FullName)" }
}

function Get-PhotoMeshNodeAgentVersionPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$Version
  )
  if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$' -or $Version.Contains('..') -or
      $Version.EndsWith('.') -or $Version.EndsWith('-')) {
    throw "Invalid Node Agent version identifier: $Version"
  }
  $fullRoot = ConvertTo-PhotoMeshCanonicalPath -Path $InstallRoot
  return Assert-PhotoMeshPathUnderRoot -Path (Join-Path $fullRoot $Version) -Root $fullRoot
}

function Test-PhotoMeshNodeAgentPackage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [switch]$AllowLegacy,
    [string]$ExpectedVersion
  )
  $root = ConvertTo-PhotoMeshCanonicalPath -Path $PackageRoot
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw "Node Agent package root does not exist: $root" }
  Assert-PhotoMeshTreeHasNoReparsePoint -Path $root
  $requiredFiles = @('package.json', 'runtime\node.exe', 'dist\index.js', 'start.ps1', 'start.bat', 'external-roots.ps1', 'node_modules\better-sqlite3\package.json')
  if (-not $AllowLegacy) { $requiredFiles += @('lifecycle.ps1', 'uninstall.ps1', 'uninstall.bat') }
  foreach ($relative in $requiredFiles) {
    $path = Join-Path $root $relative
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Node Agent package file is missing: $relative" }
  }
  $manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
  if (-not [string]::Equals([string]$manifest.name, '@photomesh/node-agent', [StringComparison]::Ordinal)) { throw "Unexpected package name: $($manifest.name)" }
  if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$') { throw "Invalid Node Agent package version: $($manifest.version)" }
  if ($ExpectedVersion -and -not [string]::Equals([string]$manifest.version, $ExpectedVersion, [StringComparison]::Ordinal)) { throw "Package version does not match its install directory: expected $ExpectedVersion, got $($manifest.version)" }
  return $true
}

function Expand-PhotoMeshNodeAgentArchive {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$DestinationPath,
    [Parameter(Mandatory = $true)][string]$AllowedRoot,
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [long]$MaximumExpandedBytes = 1073741824,
    [int]$MaximumEntries = 50000
  )
  if ($MaximumExpandedBytes -lt 1 -or $MaximumEntries -lt 1) { throw 'Archive limits must be positive.' }
  $archive = ConvertTo-PhotoMeshCanonicalPath -Path $ArchivePath
  if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Node Agent archive does not exist: $archive" }
  $archiveItem = Get-Item -LiteralPath $archive -Force -ErrorAction Stop
  if (($archiveItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing to read a reparse-point Node Agent archive: $archive" }
  $allowed = Assert-PhotoMeshPathChainHasNoReparsePoint -Path $AllowedRoot -TrustedRoot $TrustedRoot
  $destination = Assert-PhotoMeshPathUnderRoot -Path $DestinationPath -Root $allowed
  if ([IO.Path]::GetDirectoryName($destination).TrimEnd([char[]]@('\', '/')) -ine $allowed.TrimEnd([char[]]@('\', '/')) -or
      [IO.Path]::GetFileName($destination) -notmatch '^\.stage-[A-Za-z0-9-]+$') {
    throw 'Archive extraction is restricted to a new .stage-* child of the install root.'
  }
  if (Test-Path -LiteralPath $destination) { throw "Staging directory already exists: $destination" }

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($archive)
  $validatedEntries = New-Object 'System.Collections.Generic.List[object]'
  $seen = @{}
  $totalLength = [long]0
  try {
    if ($zip.Entries.Count -gt $MaximumEntries) { throw 'Archive exceeds the configured entry-count limit.' }
    foreach ($entry in $zip.Entries) {
      $entryName = [string]$entry.FullName
      if ([string]::IsNullOrWhiteSpace($entryName)) { throw 'Archive contains an empty entry path.' }
      $normalized = $entryName.Replace('\', '/')
      if ($normalized.StartsWith('/') -or $normalized.Contains(':') -or $normalized -match '^[A-Za-z]:') {
        throw "Archive contains an absolute or drive-qualified path: $entryName"
      }
      $isDirectory = $normalized.EndsWith('/')
      $relative = $normalized.TrimEnd('/')
      if ([string]::IsNullOrWhiteSpace($relative)) { throw "Archive contains an invalid root entry: $entryName" }
      $segments = @($relative -split '/')
      foreach ($segment in $segments) {
        if ([string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or
            $segment -match '[<>:"|?*]' -or $segment.EndsWith('.') -or $segment.EndsWith(' ') -or
            $segment -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$') {
          throw "Archive contains an invalid or unsafe path segment: $entryName"
        }
      }
      $externalAttributes = [long]$entry.ExternalAttributes
      $fileAttributes = $externalAttributes -band 0xFFFF
      $unixFileType = ($externalAttributes -shr 16) -band 0xF000
      if (($fileAttributes -band 0x400) -ne 0 -or $unixFileType -eq 0xA000) {
        throw "Archive contains a symbolic link or reparse-point entry: $entryName"
      }
      $key = $relative.ToLowerInvariant()
      if ($seen.ContainsKey($key)) { throw "Archive contains a duplicate Windows path: $entryName" }
      $seen[$key] = $true
      if (-not $isDirectory) {
        $totalLength += [long]$entry.Length
        if ($totalLength -gt $MaximumExpandedBytes) { throw 'Archive exceeds the configured expanded-size limit.' }
      }
      $relativePlatformPath = $relative.Replace('/', [IO.Path]::DirectorySeparatorChar)
      $target = [IO.Path]::GetFullPath((Join-Path $destination $relativePlatformPath))
      if ($isDirectory) { $null = Assert-PhotoMeshPathUnderRoot -Path $target -Root $destination -AllowRoot }
      else { $null = Assert-PhotoMeshPathUnderRoot -Path $target -Root $destination }
      $validatedEntries.Add([pscustomobject]@{ Entry = $entry; Target = $target; IsDirectory = $isDirectory })
    }
    if ($validatedEntries.Count -eq 0) { throw 'Archive contains no files.' }

    $null = New-Item -ItemType Directory -Path $destination -ErrorAction Stop
    Assert-PhotoMeshPathChainHasNoReparsePoint -Path $destination -TrustedRoot $TrustedRoot | Out-Null
    foreach ($item in $validatedEntries) {
      if ($item.IsDirectory) {
        $null = New-Item -ItemType Directory -Path $item.Target -Force -ErrorAction Stop
        continue
      }
      $parent = [IO.Path]::GetDirectoryName($item.Target)
      if (-not (Test-Path -LiteralPath $parent -PathType Container)) { $null = New-Item -ItemType Directory -Path $parent -Force -ErrorAction Stop }
      $null = Assert-PhotoMeshPathUnderRoot -Path $item.Target -Root $destination
      $inputStream = $item.Entry.Open()
      try {
        $outputStream = [IO.File]::Open($item.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
      } finally { $inputStream.Dispose() }
    }
  } catch {
    if (Test-Path -LiteralPath $destination -PathType Container) {
      try {
        Assert-PhotoMeshPathChainHasNoReparsePoint -Path $destination -TrustedRoot $TrustedRoot | Out-Null
        Assert-PhotoMeshTreeHasNoReparsePoint -Path $destination
        Remove-Item -LiteralPath $destination -Recurse -Force -ErrorAction Stop
      } catch { throw "Archive extraction failed and safe staging cleanup was refused: $($_.Exception.Message)" }
    }
    throw
  } finally { $zip.Dispose() }
  return $destination
}

function Test-PhotoMeshNodeAgentManagedProcess {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][object]$Process,
    [Parameter(Mandatory = $true)][string]$InstallRoot
  )
  $executable = [string]$Process.ExecutablePath
  if ([string]::IsNullOrWhiteSpace($executable)) { return $false }
  try { $fullExecutable = ConvertTo-PhotoMeshCanonicalPath -Path $executable } catch { return $false }
  if ([IO.Path]::GetFileName($fullExecutable) -ine 'node.exe') { return $false }
  $runtimeDirectory = [IO.Path]::GetDirectoryName($fullExecutable)
  if ([IO.Path]::GetFileName($runtimeDirectory) -ine 'runtime') { return $false }
  $versionDirectory = [IO.Path]::GetDirectoryName($runtimeDirectory)
  try { $null = Assert-PhotoMeshPathUnderRoot -Path $versionDirectory -Root $InstallRoot -AllowRoot } catch { return $false }
  return $true
}

function Get-PhotoMeshNodeAgentProcesses {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [AllowNull()][object[]]$ProcessSnapshot
  )
  if ($PSBoundParameters.ContainsKey('ProcessSnapshot')) { $processes = @($ProcessSnapshot) }
  else {
    try { $processes = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" -ErrorAction Stop) }
    catch { throw "Could not safely inspect running Node processes; lifecycle operation refused: $($_.Exception.Message)" }
  }
  return @($processes | Where-Object { Test-PhotoMeshNodeAgentManagedProcess -Process $_ -InstallRoot $InstallRoot })
}

function Assert-PhotoMeshNodeAgentNotRunning {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [AllowNull()][object[]]$ProcessSnapshot
  )
  if ($PSBoundParameters.ContainsKey('ProcessSnapshot')) { $running = @(Get-PhotoMeshNodeAgentProcesses -InstallRoot $InstallRoot -ProcessSnapshot $ProcessSnapshot) }
  else { $running = @(Get-PhotoMeshNodeAgentProcesses -InstallRoot $InstallRoot) }
  if ($running.Count -gt 0) {
    $ids = @($running | ForEach-Object { [string]$_.ProcessId }) -join ', '
    throw "A PhotoMesh Node Agent runtime is still running (PID $ids). Stop it with Ctrl+C in its foreground window before continuing."
  }
}

function Install-PhotoMeshNodeAgentVersion {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$StagePath,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Version
  )
  $root = Assert-PhotoMeshPathChainHasNoReparsePoint -Path $InstallRoot -TrustedRoot $TrustedRoot
  $stage = Assert-PhotoMeshPathUnderRoot -Path $StagePath -Root $root
  if ([IO.Path]::GetDirectoryName($stage).TrimEnd([char[]]@('\', '/')) -ine $root.TrimEnd([char[]]@('\', '/')) -or
      [IO.Path]::GetFileName($stage) -notmatch '^\.stage-[A-Za-z0-9-]+$') {
    throw 'Install staging is restricted to a .stage-* child of the Node Agent install root.'
  }
  Assert-PhotoMeshPathChainHasNoReparsePoint -Path $stage -TrustedRoot $TrustedRoot | Out-Null
  Assert-PhotoMeshTreeHasNoReparsePoint -Path $stage
  $target = Get-PhotoMeshNodeAgentVersionPath -InstallRoot $root -Version $Version
  if (Test-Path -LiteralPath $target) { throw "Node Agent version is already installed; refusing in-place overwrite: $target" }
  Test-PhotoMeshNodeAgentPackage -PackageRoot $stage -ExpectedVersion $Version | Out-Null
  [IO.Directory]::Move($stage, $target)
  return $target
}

function Remove-PhotoMeshNodeAgentVersion {
  [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
  param(
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$TrustedRoot,
    [Parameter(Mandatory = $true)][string]$Version,
    [AllowNull()][object[]]$ProcessSnapshot
  )
  $root = Assert-PhotoMeshPathChainHasNoReparsePoint -Path $InstallRoot -TrustedRoot $TrustedRoot
  $target = Get-PhotoMeshNodeAgentVersionPath -InstallRoot $root -Version $Version
  if (-not (Test-Path -LiteralPath $target -PathType Container)) { return $false }
  Assert-PhotoMeshPathChainHasNoReparsePoint -Path $target -TrustedRoot $TrustedRoot | Out-Null
  if ($PSBoundParameters.ContainsKey('ProcessSnapshot')) {
    Assert-PhotoMeshNodeAgentNotRunning -InstallRoot $target -ProcessSnapshot $ProcessSnapshot | Out-Null
  } else {
    Assert-PhotoMeshNodeAgentNotRunning -InstallRoot $target | Out-Null
  }
  Assert-PhotoMeshTreeHasNoReparsePoint -Path $target
  Test-PhotoMeshNodeAgentPackage -PackageRoot $target -AllowLegacy -ExpectedVersion $Version | Out-Null
  if ($PSCmdlet.ShouldProcess($target, 'Remove this PhotoMesh Node Agent version only')) {
    Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
    return $true
  }
  return $false
}

function Remove-PhotoMeshNodeAgentStage {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$StagePath,
    [Parameter(Mandatory = $true)][string]$InstallRoot,
    [Parameter(Mandatory = $true)][string]$TrustedRoot
  )
  $root = Assert-PhotoMeshPathChainHasNoReparsePoint -Path $InstallRoot -TrustedRoot $TrustedRoot
  $stage = Assert-PhotoMeshPathUnderRoot -Path $StagePath -Root $root
  if ([IO.Path]::GetDirectoryName($stage).TrimEnd([char[]]@('\', '/')) -ine $root.TrimEnd([char[]]@('\', '/')) -or
      [IO.Path]::GetFileName($stage) -notmatch '^\.stage-[A-Za-z0-9-]+$') {
    throw 'Staging cleanup is restricted to a .stage-* child of the Node Agent install root.'
  }
  if (-not (Test-Path -LiteralPath $stage -PathType Container)) { return $false }
  Assert-PhotoMeshPathChainHasNoReparsePoint -Path $stage -TrustedRoot $TrustedRoot | Out-Null
  Assert-PhotoMeshTreeHasNoReparsePoint -Path $stage
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop
  return $true
}
