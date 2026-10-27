[CmdletBinding()]
param(
  [string]$PackageRoot,
  [string]$PackageArchive
)

$ErrorActionPreference = 'Stop'
$script:assertionCount = 0
$script:lifecyclePath = Join-Path $PSScriptRoot 'node-agent\lifecycle.ps1'
if (-not (Test-Path -LiteralPath $script:lifecyclePath -PathType Leaf)) {
  throw "Node Agent lifecycle helper is missing: $script:lifecyclePath"
}
. $script:lifecyclePath

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
  $script:assertionCount++
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -ne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
  $script:assertionCount++
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Message)
  $threw = $false
  try { & $Action } catch { $threw = $true }
  if (-not $threw) { throw $Message }
  $script:assertionCount++
}

function New-ZipFixture {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object[]]$Entries
  )
  $zip = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($item in $Entries) {
      $entry = $zip.CreateEntry([string]$item.Name)
      if ($item.ContainsKey('ExternalAttributes')) { $entry.ExternalAttributes = [int]$item.ExternalAttributes }
      $stream = $entry.Open()
      try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$item.Value)
        $stream.Write($bytes, 0, $bytes.Length)
      } finally { $stream.Dispose() }
    }
  } finally { $zip.Dispose() }
}

function Write-FixturePackage {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Version = '0.1.0-rc.1'
  )
  $null = New-Item -ItemType Directory -Path $Path -Force
  foreach ($relative in @('runtime', 'dist', 'node_modules\better-sqlite3')) {
    $null = New-Item -ItemType Directory -Path (Join-Path $Path $relative) -Force
  }
  Set-Content -LiteralPath (Join-Path $Path 'package.json') -Value ('{"name":"@photomesh/node-agent","version":"' + $Version + '"}') -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'runtime\node.exe') -Value 'fixture runtime' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'dist\index.js') -Value 'fixture entry' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'start.ps1') -Value '# fixture start' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'start.bat') -Value '@echo off' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'external-roots.ps1') -Value '# fixture roots' -Encoding UTF8
  Copy-Item -LiteralPath $script:lifecyclePath -Destination (Join-Path $Path 'lifecycle.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node-agent\admin-credential.ps1') -Destination (Join-Path $Path 'admin-credential.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node-agent\uninstall.ps1') -Destination (Join-Path $Path 'uninstall.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'node-agent\uninstall.bat') -Destination (Join-Path $Path 'uninstall.bat')
  Set-Content -LiteralPath (Join-Path $Path 'node_modules\better-sqlite3\package.json') -Value '{"name":"better-sqlite3"}' -Encoding UTF8
}

function Write-LegacyFixturePackage {
  param([Parameter(Mandatory = $true)][string]$Path)
  $null = New-Item -ItemType Directory -Path $Path -Force
  foreach ($relative in @('runtime', 'dist', 'node_modules\better-sqlite3')) {
    $null = New-Item -ItemType Directory -Path (Join-Path $Path $relative) -Force
  }
  Set-Content -LiteralPath (Join-Path $Path 'package.json') -Value '{"name":"@photomesh/node-agent","version":"0.1.0-rc.0"}' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'runtime\node.exe') -Value 'legacy fixture runtime' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'dist\index.js') -Value 'legacy fixture entry' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'start.ps1') -Value '# legacy fixture start' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'start.bat') -Value '@echo off' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'external-roots.ps1') -Value '# legacy fixture roots' -Encoding UTF8
  Set-Content -LiteralPath (Join-Path $Path 'node_modules\better-sqlite3\package.json') -Value '{"name":"better-sqlite3"}' -Encoding UTF8
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
Import-Module CimCmdlets -ErrorAction Stop
$testRootPath = Join-Path ([IO.Path]::GetTempPath()) ('photomesh-node-agent-lifecycle-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRootPath
try {
  $repositoryRoot = Split-Path -Parent $PSScriptRoot
  $installerTemplate = Get-Content -LiteralPath (Join-Path $repositoryRoot 'install.ps1') -Raw
  $embeddedLifecycle = Get-Content -LiteralPath $script:lifecyclePath -Raw
  $generatedInstaller = $embeddedLifecycle + [Environment]::NewLine + $installerTemplate.Replace('__VERSION__', '0.1.0-rc.10')
  Assert-True ($generatedInstaller -match 'function Expand-PhotoMeshNodeAgentArchive' -and $generatedInstaller -notmatch '__VERSION__') 'Generated installer did not embed lifecycle helpers or replace its version'
  $installerTokens = $null
  $installerParseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseInput($generatedInstaller, [ref]$installerTokens, [ref]$installerParseErrors) | Out-Null
  Assert-Equal $installerParseErrors.Count 0 'Generated standalone installer contains a PowerShell syntax error'
  $installerAsset = 'PhotoMesh-0.1.0-rc.10-node-agent-windows-x64.zip'
  $checksumPattern = '^\s*[A-Fa-f0-9]{64}\s+\*?' + [regex]::Escape($installerAsset) + '\s*$'
  Assert-True ((('a' * 64) + '  ' + $installerAsset) -match $checksumPattern) 'Windows installer rejected sha256sum manifest formatting'
  Assert-True (-not ((('a' * 64) + '  ./'+ $installerAsset) -match $checksumPattern)) 'Windows installer accepted a noncanonical manifest path'
  $startTokens = $null
  $startParseErrors = $null
  [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'node-agent\start.ps1'), [ref]$startTokens, [ref]$startParseErrors) | Out-Null
  Assert-Equal $startParseErrors.Count 0 'Node Agent start script contains a PowerShell syntax error'

  if ($PackageRoot) {
    Test-PhotoMeshNodeAgentPackage -PackageRoot $PackageRoot | Out-Null
    $script:assertionCount++
  }
  if ($PackageArchive) {
    $archiveStage = Join-Path $testRootPath '.stage-real-package'
    $null = Expand-PhotoMeshNodeAgentArchive -ArchivePath $PackageArchive -DestinationPath $archiveStage -AllowedRoot $testRootPath -TrustedRoot $testRootPath
    Test-PhotoMeshNodeAgentPackage -PackageRoot $archiveStage | Out-Null
    $script:assertionCount++
  }

  $installRoot = Join-Path $testRootPath 'Programs\PhotoMesh\NodeAgent'
  $null = New-Item -ItemType Directory -Path $installRoot -Force
  $validPath = Get-PhotoMeshNodeAgentVersionPath -InstallRoot $installRoot -Version '0.1.0-rc.10'
  Assert-Equal $validPath (Join-Path $installRoot '0.1.0-rc.10') 'A valid prerelease version did not resolve under the package root'
  Assert-Throws { Get-PhotoMeshNodeAgentVersionPath -InstallRoot $installRoot -Version '..\..\PhotoMesh\data' } 'Version path traversal was accepted'
  Assert-Throws { Get-PhotoMeshNodeAgentVersionPath -InstallRoot $installRoot -Version '0.1.0/../../outside' } 'Slash-based version path traversal was accepted'

  $safeArchive = Join-Path $testRootPath 'safe.zip'
  $safeDestination = Join-Path $testRootPath '.stage-safe'
  New-ZipFixture -Path $safeArchive -Entries @(@{ Name = 'dist/index.js'; Value = 'safe fixture' })
  $null = Expand-PhotoMeshNodeAgentArchive -ArchivePath $safeArchive -DestinationPath $safeDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath
  Assert-Equal (Get-Content -LiteralPath (Join-Path $safeDestination 'dist\index.js') -Raw).Trim() 'safe fixture' 'A valid archive entry was not extracted'

  $sizeLimitedArchive = Join-Path $testRootPath 'size-limit.zip'
  $sizeLimitedDestination = Join-Path $testRootPath '.stage-size-limit'
  New-ZipFixture -Path $sizeLimitedArchive -Entries @(@{ Name = 'large.txt'; Value = 'expanded bytes' })
  Assert-Throws { Expand-PhotoMeshNodeAgentArchive -ArchivePath $sizeLimitedArchive -DestinationPath $sizeLimitedDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath -MaximumExpandedBytes 2 } 'Archive expanded-size limit was not enforced'
  Assert-True (-not (Test-Path -LiteralPath $sizeLimitedDestination)) 'Oversized archive created a partial staging directory'

  $duplicateArchive = Join-Path $testRootPath 'duplicate.zip'
  $duplicateDestination = Join-Path $testRootPath '.stage-duplicate'
  New-ZipFixture -Path $duplicateArchive -Entries @(@{ Name = 'Photo.txt'; Value = 'one' }, @{ Name = 'photo.txt'; Value = 'two' })
  Assert-Throws { Expand-PhotoMeshNodeAgentArchive -ArchivePath $duplicateArchive -DestinationPath $duplicateDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath -MaximumEntries 1 } 'Archive entry-count limit was not enforced'
  Assert-True (-not (Test-Path -LiteralPath $duplicateDestination)) 'Over-limit archive created a partial staging directory'
  Assert-Throws { Expand-PhotoMeshNodeAgentArchive -ArchivePath $duplicateArchive -DestinationPath $duplicateDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath } 'Case-insensitive duplicate Windows paths were accepted'
  Assert-True (-not (Test-Path -LiteralPath $duplicateDestination)) 'Duplicate-path archive created a partial staging directory'

  $unsafeArchive = Join-Path $testRootPath 'unsafe.zip'
  $unsafeDestination = Join-Path $testRootPath '.stage-unsafe'
  $outsideFile = Join-Path $testRootPath 'outside.txt'
  New-ZipFixture -Path $unsafeArchive -Entries @(@{ Name = '../outside.txt'; Value = 'must not escape' })
  Assert-Throws { Expand-PhotoMeshNodeAgentArchive -ArchivePath $unsafeArchive -DestinationPath $unsafeDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath } 'Parent traversal in a ZIP entry was accepted'
  Assert-True (-not (Test-Path -LiteralPath $outsideFile)) 'Unsafe ZIP extraction wrote outside its staging directory'
  Assert-True (-not (Test-Path -LiteralPath $unsafeDestination)) 'Unsafe archive created a partial extraction directory'

  $absoluteArchive = Join-Path $testRootPath 'absolute.zip'
  $absoluteDestination = Join-Path $testRootPath '.stage-absolute'
  New-ZipFixture -Path $absoluteArchive -Entries @(@{ Name = 'C:/outside.txt'; Value = 'must not escape' })
  Assert-Throws { Expand-PhotoMeshNodeAgentArchive -ArchivePath $absoluteArchive -DestinationPath $absoluteDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath } 'An absolute Windows ZIP entry was accepted'
  Assert-True (-not (Test-Path -LiteralPath $absoluteDestination)) 'Absolute-path archive created a destination directory'

  $linkArchive = Join-Path $testRootPath 'link.zip'
  $linkDestination = Join-Path $testRootPath '.stage-link'
  New-ZipFixture -Path $linkArchive -Entries @(@{ Name = 'link'; Value = '../outside.txt'; ExternalAttributes = [int]0xA1FF0000 })
  Assert-Throws { Expand-PhotoMeshNodeAgentArchive -ArchivePath $linkArchive -DestinationPath $linkDestination -AllowedRoot $testRootPath -TrustedRoot $testRootPath } 'A ZIP symlink entry was accepted'
  Assert-True (-not (Test-Path -LiteralPath $linkDestination)) 'Symlink archive created a destination directory'

  $oldPath = Join-Path $installRoot '0.1.0-rc.1'
  Write-FixturePackage -Path $oldPath
  $legacyPath = Join-Path $installRoot '0.1.0-rc.0'
  Write-LegacyFixturePackage -Path $legacyPath
  $oldMarker = Join-Path $oldPath 'rollback-marker.txt'
  Set-Content -LiteralPath $oldMarker -Value 'old version intact' -Encoding UTF8
  $dataRoot = Join-Path $testRootPath 'PhotoMesh\data'
  $null = New-Item -ItemType Directory -Path $dataRoot -Force
  $dataMarker = Join-Path $dataRoot 'preserve-me.txt'
  Set-Content -LiteralPath $dataMarker -Value 'user data must remain' -Encoding UTF8
  $legacyMarker = Join-Path $legacyPath 'dist\index.js'
  $originalLocalAppData = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $testRootPath
    & (Join-Path $oldPath 'uninstall.ps1') -Version '0.1.0-rc.0' -WhatIf
    Assert-True (Test-Path -LiteralPath $legacyMarker) 'WhatIf uninstall removed a legacy package'
    & (Join-Path $oldPath 'uninstall.ps1') -Version '0.1.0-rc.0' -Confirm:$false
  } finally { $env:LOCALAPPDATA = $originalLocalAppData }
  Assert-True (-not (Test-Path -LiteralPath $legacyPath)) 'Uninstaller could not safely remove a prior package without lifecycle tools'
  Assert-True (Test-Path -LiteralPath $dataMarker) 'Legacy package uninstall modified user data'

  $managedProcess = [pscustomobject]@{
    ProcessId = 12345
    ExecutablePath = Join-Path $oldPath 'runtime\node.exe'
    CommandLine = '"' + (Join-Path $oldPath 'runtime\node.exe') + '" "' + (Join-Path $oldPath 'dist\index.js') + '"'
  }
  $foreignProcess = [pscustomobject]@{
    ProcessId = 23456
    ExecutablePath = 'C:\Tools\node.exe'
    CommandLine = '"C:\Tools\node.exe" "C:\Tools\unrelated.js"'
  }
  $pidOnlyProcess = [pscustomobject]@{ ProcessId = 34567; CommandLine = 'node.exe dist\index.js' }
  $matches = @(Get-PhotoMeshNodeAgentProcesses -InstallRoot $installRoot -ProcessSnapshot @($managedProcess, $foreignProcess, $pidOnlyProcess))
  Assert-Equal $matches.Count 1 'Managed process detection relied on PID alone or included a foreign process'
  Assert-Equal $matches[0].ProcessId 12345 'Managed process detection returned the wrong process'
  Assert-Throws { Assert-PhotoMeshNodeAgentNotRunning -InstallRoot $installRoot -ProcessSnapshot @($managedProcess) } 'Start guard allowed a duplicate Agent process'
  Assert-PhotoMeshNodeAgentNotRunning -InstallRoot $installRoot -ProcessSnapshot @($foreignProcess, $pidOnlyProcess)
  $script:assertionCount++

  $newStage = Join-Path $installRoot '.stage-test-upgrade'
  Write-FixturePackage -Path $newStage -Version '0.1.0-rc.2'
  $newPath = Install-PhotoMeshNodeAgentVersion -StagePath $newStage -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '0.1.0-rc.2'
  Assert-Equal $newPath (Join-Path $installRoot '0.1.0-rc.2') 'Upgrade did not install into a separate version directory'
  Assert-True (Test-Path -LiteralPath $oldMarker) 'Upgrade removed the previous version before the new version was validated'
  Assert-True (Test-Path -LiteralPath $dataMarker) 'Upgrade modified the user data directory'
  Assert-True (-not (Test-Path -LiteralPath $newStage)) 'Upgrade did not move its validated staging directory'

  $invalidStage = Join-Path $installRoot '.stage-invalid-package'
  $null = New-Item -ItemType Directory -Path $invalidStage -Force
  Set-Content -LiteralPath (Join-Path $invalidStage 'package.json') -Value '{"name":"@photomesh/node-agent"}' -Encoding UTF8
  Assert-Throws { Install-PhotoMeshNodeAgentVersion -StagePath $invalidStage -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '0.1.0-rc.3' } 'An incomplete package was installed'
  Assert-True (Test-Path -LiteralPath $oldMarker) 'Failed upgrade modified the prior rollback package'
  Assert-True (Test-Path -LiteralPath $dataMarker) 'Failed upgrade modified user data'

  $duplicateStage = Join-Path $installRoot '.stage-duplicate-version'
  Write-FixturePackage -Path $duplicateStage -Version '0.1.0-rc.2'
  Assert-Throws { Install-PhotoMeshNodeAgentVersion -StagePath $duplicateStage -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '0.1.0-rc.2' } 'Install overwrote an existing version directory'
  Assert-True (Test-Path -LiteralPath (Join-Path $newPath 'dist\index.js')) 'Failed duplicate install modified the existing version'

  Assert-Throws { Remove-PhotoMeshNodeAgentVersion -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '0.1.0-rc.1' -ProcessSnapshot @($managedProcess) -Confirm:$false } 'Uninstall removed a running Agent version'
  Assert-True (Test-Path -LiteralPath $oldMarker) 'Running-process uninstall attempt modified the package'
  $originalLocalAppData = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $testRootPath
    & (Join-Path $oldPath 'uninstall.ps1') -WhatIf
    Assert-True (Test-Path -LiteralPath $oldMarker) 'WhatIf uninstall wrapper removed the package'
    & (Join-Path $oldPath 'uninstall.ps1') -Confirm:$false
  } finally { $env:LOCALAPPDATA = $originalLocalAppData }
  Assert-True (-not (Test-Path -LiteralPath $oldPath)) 'Uninstall did not remove the requested stopped package version'
  Assert-True (Test-Path -LiteralPath $newPath) 'Uninstall removed a different installed version'
  Assert-True (Test-Path -LiteralPath $dataMarker) 'Uninstall removed user data outside the application package root'

  Assert-Throws { Remove-PhotoMeshNodeAgentVersion -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '..\..\PhotoMesh\data' -ProcessSnapshot @() -Confirm:$false } 'Uninstall accepted a traversal version'
  Assert-True (Test-Path -LiteralPath $dataMarker) 'Rejected path traversal changed the user data directory'
  $unrelatedPath = Join-Path $installRoot '9.9.9'
  $null = New-Item -ItemType Directory -Path $unrelatedPath -Force
  $unrelatedMarker = Join-Path $unrelatedPath 'precious.txt'
  Set-Content -LiteralPath $unrelatedMarker -Value 'not a PhotoMesh package' -Encoding UTF8
  Assert-Throws { Remove-PhotoMeshNodeAgentVersion -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '9.9.9' -ProcessSnapshot @() -Confirm:$false } 'Uninstall removed an unrecognized directory'
  Assert-True (Test-Path -LiteralPath $unrelatedMarker) 'Uninstall deleted files from an unrecognized directory'
  $mismatchPath = Join-Path $installRoot '1.0.0'
  Write-FixturePackage -Path $mismatchPath -Version '1.0.1'
  $mismatchMarker = Join-Path $mismatchPath 'dist\index.js'
  Assert-Throws { Remove-PhotoMeshNodeAgentVersion -InstallRoot $installRoot -TrustedRoot $testRootPath -Version '1.0.0' -ProcessSnapshot @() -Confirm:$false } 'Uninstall removed a package whose manifest version did not match its directory'
  Assert-True (Test-Path -LiteralPath $mismatchMarker) 'Uninstall deleted a mismatched-version package'
  $wrongLocation = Join-Path $testRootPath 'Unapproved\NodeAgent\1.1.0'
  Write-FixturePackage -Path $wrongLocation -Version '1.1.0'
  $originalLocalAppData = $env:LOCALAPPDATA
  try {
    $env:LOCALAPPDATA = $testRootPath
    Assert-Throws { & (Join-Path $wrongLocation 'uninstall.ps1') -Confirm:$false } 'Uninstaller accepted a package outside the canonical per-user install root'
  } finally { $env:LOCALAPPDATA = $originalLocalAppData }
  Assert-True (Test-Path -LiteralPath (Join-Path $wrongLocation 'dist\index.js')) 'Rejected alternate install root was modified'

  Write-Host "Windows Node Agent lifecycle tests passed ($script:assertionCount assertions)."
} finally {
  $resolvedTestRoot = [IO.Path]::GetFullPath($testRootPath)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $resolvedTestRoot.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolvedTestRoot) -notmatch '^photomesh-node-agent-lifecycle-[0-9a-f]{32}$') {
    throw "Refusing to clean a path outside the dedicated lifecycle test fixture: $resolvedTestRoot"
  }
  if (Test-Path -LiteralPath $resolvedTestRoot -PathType Container) {
    Assert-PhotoMeshTreeHasNoReparsePoint -Path $resolvedTestRoot
    Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
  }
}
