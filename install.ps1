$ErrorActionPreference = 'Stop'
$Version = '__VERSION__'
if ($Version -like '__*__') { throw 'This installer must be downloaded from a PhotoMesh release.' }
$Repo = 'LingBrian/PhotoMesh'
$BaseUrl = "https://github.com/$Repo/releases/download/v$Version"
$AssetName = "PhotoMesh-$Version-node-agent-windows-x64.zip"
$Temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
try {
  $Archive = Join-Path $Temp $AssetName
  $Manifest = Join-Path $Temp 'SHA256SUMS.txt'
  Invoke-WebRequest -Uri "$BaseUrl/$AssetName" -OutFile $Archive
  Invoke-WebRequest -Uri "$BaseUrl/SHA256SUMS.txt" -OutFile $Manifest
  $Line = Get-Content -LiteralPath $Manifest | Where-Object { $_ -match [regex]::Escape($AssetName) } | Select-Object -First 1
  if (-not $Line) { throw 'The checksum manifest has no entry for the Windows package.' }
  $Expected = ($Line -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { throw 'SHA-256 verification failed; the archive will not be installed.' }
  $InstallDir = Join-Path $env:LOCALAPPDATA "Programs\PhotoMesh\NodeAgent\$Version"
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  Expand-Archive -LiteralPath $Archive -DestinationPath $InstallDir -Force
  Write-Host "Installed PhotoMesh Node Agent $Version to $InstallDir"
  & (Join-Path $InstallDir 'start.ps1')
  exit $LASTEXITCODE
} finally { Remove-Item -LiteralPath $Temp -Recurse -Force -ErrorAction SilentlyContinue }
