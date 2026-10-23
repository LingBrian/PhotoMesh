$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Join-Path $AppRoot 'runtime\node.exe'
$Entry = Join-Path $AppRoot 'dist\index.js'
if (-not (Test-Path -LiteralPath $Node) -or -not (Test-Path -LiteralPath $Entry)) { throw 'PhotoMesh node package is incomplete.' }
$DataDir = Join-Path $env:LOCALAPPDATA 'PhotoMesh\data'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:PHOTOMESH_DATA_DIR = $DataDir
$env:PORT = '8443'
$env:PHOTOMESH_API_BIND_ADDRESS = '127.0.0.1'
$token = Read-Host 'Admin token (leave blank to generate a new one)'
if ([string]::IsNullOrWhiteSpace($token)) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create(); $rng.GetBytes($bytes); $rng.Dispose()
  $token = [Convert]::ToBase64String($bytes)
  Write-Host 'Generated admin token (save it in your password manager):' -ForegroundColor Yellow
  Write-Host $token
}
$env:PHOTOMESH_ADMIN_TOKEN = $token
$root = Read-Host 'Optional external photo folder (blank to skip)'
if (-not [string]::IsNullOrWhiteSpace($root)) {
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Photo folder does not exist.' }
  $env:PHOTOMESH_EXTERNAL_ROOTS = @(@{ rootId = 'user-photos'; libraryId = 'user-photos'; path = (Resolve-Path -LiteralPath $root).Path; pathStyle = 'win32' }) | ConvertTo-Json -Compress
} else { Remove-Item Env:PHOTOMESH_EXTERNAL_ROOTS -ErrorAction SilentlyContinue }
Write-Host 'Node API: http://127.0.0.1:8443  (Ctrl+C stops the node)'
& $Node $Entry
exit $LASTEXITCODE
