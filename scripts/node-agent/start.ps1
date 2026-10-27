$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallRoot = Split-Path -Parent $AppRoot
$Node = Join-Path $AppRoot 'runtime\node.exe'
$Entry = Join-Path $AppRoot 'dist\index.js'
$ExternalRootsScript = Join-Path $AppRoot 'external-roots.ps1'
$LifecycleScript = Join-Path $AppRoot 'lifecycle.ps1'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath $Entry -PathType Leaf) -or
    -not (Test-Path -LiteralPath $ExternalRootsScript -PathType Leaf) -or -not (Test-Path -LiteralPath $LifecycleScript -PathType Leaf)) {
  throw 'PhotoMesh Node Agent package is incomplete.'
}
. $LifecycleScript
Assert-PhotoMeshNodeAgentNotRunning -InstallRoot $InstallRoot
. $ExternalRootsScript
$DataDir = Join-Path $env:LOCALAPPDATA 'PhotoMesh\data'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:PHOTOMESH_DATA_DIR = $DataDir
$env:PORT = '8443'
$env:PHOTOMESH_API_BIND_ADDRESS = '127.0.0.1'
$secureToken = Read-Host 'Admin token (leave blank to generate a new one)' -AsSecureString
if ($secureToken.Length -eq 0) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $token = [Convert]::ToBase64String($bytes)
  Write-Host 'Generated admin token (save it in your password manager):' -ForegroundColor Yellow
  Write-Host $token
} else {
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer) }
}
$env:PHOTOMESH_ADMIN_TOKEN = $token
$externalRootsJson = Read-PhotoMeshExternalRootJson
if ($null -ne $externalRootsJson) {
  $env:PHOTOMESH_EXTERNAL_ROOTS = $externalRootsJson
} else {
  Remove-Item Env:PHOTOMESH_EXTERNAL_ROOTS -ErrorAction SilentlyContinue
}
Write-Host 'Node API: http://127.0.0.1:8443  (Ctrl+C stops the node)'
& $Node $Entry
exit $LASTEXITCODE
