$ErrorActionPreference = 'Stop'
$Version = '__VERSION__'
if ($Version -like '__*__') { throw 'This installer must be downloaded from a PhotoMesh release.' }

if (-not (Get-Command Get-PhotoMeshNodeAgentVersionPath -ErrorAction SilentlyContinue)) {
  $LifecyclePath = Join-Path $PSScriptRoot 'scripts\node-agent\lifecycle.ps1'
  if (-not (Test-Path -LiteralPath $LifecyclePath -PathType Leaf)) { throw 'Node Agent lifecycle helper is missing.' }
  . $LifecyclePath
}

$LocalAppData = $env:LOCALAPPDATA
if ([string]::IsNullOrWhiteSpace($LocalAppData) -or -not (Test-Path -LiteralPath $LocalAppData -PathType Container)) {
  throw 'A valid per-user LOCALAPPDATA directory is required.'
}
$Repo = 'LingBrian/PhotoMesh'
$BaseUrl = "https://github.com/$Repo/releases/download/v$Version"
$AssetName = "PhotoMesh-$Version-node-agent-windows-x64.zip"
$InstallRoot = Join-Path $LocalAppData 'Programs\PhotoMesh\NodeAgent'
$InstallDir = Get-PhotoMeshNodeAgentVersionPath -InstallRoot $InstallRoot -Version $Version
$TempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$Temp = Join-Path $TempRoot ('photomesh-node-agent-' + [guid]::NewGuid().ToString('N'))
$Stage = Join-Path $InstallRoot ('.stage-' + [guid]::NewGuid().ToString('N'))
$TempCreated = $false
$StageOwned = $false

try {
  Assert-PhotoMeshPathChainHasNoReparsePoint -Path $InstallRoot -TrustedRoot $LocalAppData | Out-Null
  if (Test-Path -LiteralPath $InstallDir) {
    throw "Node Agent version $Version is already installed; refusing to overwrite it. Uninstall that version explicitly or install a newer version side-by-side."
  }

  $null = New-Item -ItemType Directory -Path $Temp -ErrorAction Stop
  $TempCreated = $true
  if (-not (Test-Path -LiteralPath $InstallRoot -PathType Container)) {
    $null = New-Item -ItemType Directory -Path $InstallRoot -Force -ErrorAction Stop
  }
  Assert-PhotoMeshPathChainHasNoReparsePoint -Path $InstallRoot -TrustedRoot $LocalAppData | Out-Null

  $Archive = Join-Path $Temp $AssetName
  $Manifest = Join-Path $Temp 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri "$BaseUrl/$AssetName" -OutFile $Archive
  Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $Manifest
  $escapedAsset = [regex]::Escape($AssetName)
  $matchingLines = @(Get-Content -LiteralPath $Manifest | Where-Object { $_ -match "^\s*[A-Fa-f0-9]{64}\s+\*?$escapedAsset\s*$" })
  if ($matchingLines.Count -ne 1) { throw 'The checksum manifest must contain exactly one valid entry for the Windows package.' }
  $Expected = ($matchingLines[0] -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw 'SHA-256 verification failed; the archive will not be installed.' }

  $null = Expand-PhotoMeshNodeAgentArchive -ArchivePath $Archive -DestinationPath $Stage -AllowedRoot $InstallRoot -TrustedRoot $LocalAppData
  $StageOwned = $true
  $InstallDir = Install-PhotoMeshNodeAgentVersion -StagePath $Stage -InstallRoot $InstallRoot -TrustedRoot $LocalAppData -Version $Version
  $StageOwned = $false
  Write-Host "Installed PhotoMesh Node Agent $Version side-by-side at $InstallDir"

  $runningAgents = @(Get-PhotoMeshNodeAgentProcesses -InstallRoot $InstallRoot)
  if ($runningAgents.Count -gt 0) {
    $pids = @($runningAgents | ForEach-Object { [string]$_.ProcessId }) -join ', '
    Write-Warning "The package is installed, but another Agent process is running (PID $pids). Stop it with Ctrl+C in its foreground window, then run '$InstallDir\start.ps1'."
    exit 0
  }

  & (Join-Path $InstallDir 'start.ps1')
  exit $LASTEXITCODE
} finally {
  if ($StageOwned -and (Test-Path -LiteralPath $Stage -PathType Container)) {
    Remove-PhotoMeshNodeAgentStage -StagePath $Stage -InstallRoot $InstallRoot -TrustedRoot $LocalAppData | Out-Null
  }
  if ($TempCreated -and (Test-Path -LiteralPath $Temp -PathType Container)) {
    $resolvedTemp = [IO.Path]::GetFullPath($Temp)
    $tempPrefix = [IO.Path]::GetFullPath($TempRoot).TrimEnd([char[]]@('\', '/')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedTemp.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetFileName($resolvedTemp) -notmatch '^photomesh-node-agent-[0-9a-f]{32}$') {
      throw "Refusing to clean an unexpected installer temp path: $resolvedTemp"
    }
    $tempItem = Get-Item -LiteralPath $resolvedTemp -Force -ErrorAction Stop
    if (($tempItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing to clean an installer temp reparse point: $resolvedTemp" }
    Assert-PhotoMeshTreeHasNoReparsePoint -Path $resolvedTemp
    Remove-Item -LiteralPath $resolvedTemp -Recurse -Force -ErrorAction Stop
  }
}
