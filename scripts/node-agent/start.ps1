[CmdletBinding()]
param([switch]$RotateAdminToken)

$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$InstallRoot = Split-Path -Parent $AppRoot
$Node = Join-Path $AppRoot 'runtime\node.exe'
$Entry = Join-Path $AppRoot 'dist\index.js'
$ExternalRootsScript = Join-Path $AppRoot 'external-roots.ps1'
$LifecycleScript = Join-Path $AppRoot 'lifecycle.ps1'
$AdminCredentialScript = Join-Path $AppRoot 'admin-credential.ps1'
if (-not (Test-Path -LiteralPath $Node -PathType Leaf) -or -not (Test-Path -LiteralPath $Entry -PathType Leaf) -or
    -not (Test-Path -LiteralPath $ExternalRootsScript -PathType Leaf) -or -not (Test-Path -LiteralPath $LifecycleScript -PathType Leaf) -or
    -not (Test-Path -LiteralPath $AdminCredentialScript -PathType Leaf)) {
  throw 'PhotoMesh Node Agent package is incomplete.'
}
. $LifecycleScript
. $AdminCredentialScript
if (Test-Path Env:PHOTOMESH_ADMIN_TOKEN) {
  Write-Warning 'Ignoring inherited PHOTOMESH_ADMIN_TOKEN. Remove any persistent Windows environment setting; enter the token at this foreground prompt instead.'
  Remove-Item Env:PHOTOMESH_ADMIN_TOKEN -ErrorAction SilentlyContinue
}
Assert-PhotoMeshNodeAgentNotRunning -InstallRoot $InstallRoot
. $ExternalRootsScript

if ($RotateAdminToken) {
  $rotationConfirmation = Read-Host 'Type ROTATE to generate a new token and invalidate the previous token'
  $adminCredential = Resolve-PhotoMeshAdminCredential -Token '' -Rotate -RotationConfirmation $rotationConfirmation
} else {
  $secureToken = Read-Host 'Admin token (paste the saved 32-byte Base64 token; leave blank only for first setup or recovery)' -AsSecureString
  try { $tokenInput = ConvertFrom-PhotoMeshSecureString -SecureString $secureToken }
  finally { if ($null -ne $secureToken) { $secureToken.Dispose() } }
  if ([string]::IsNullOrEmpty($tokenInput)) {
    Write-Host 'An empty token does not rotate automatically. To create a new token, confirm below.' -ForegroundColor Yellow
    $rotationConfirmation = Read-Host 'Type ROTATE to generate a new token and invalidate the previous token'
    $adminCredential = Resolve-PhotoMeshAdminCredential -Token $tokenInput -RotationConfirmation $rotationConfirmation
  } else {
    $adminCredential = Resolve-PhotoMeshAdminCredential -Token $tokenInput
  }
}

if ($adminCredential.Generated) {
  Write-Host 'New administrator token (shown once; save it in your password manager):' -ForegroundColor Yellow
  Write-Host $adminCredential.Token -ForegroundColor Yellow
  $savedConfirmation = Read-Host 'Type SAVED after saving this token. Anything else cancels startup.'
  if (-not (Test-PhotoMeshAdminTokenSaveConfirmation -Confirmation $savedConfirmation)) {
    $adminCredential = $null
    $tokenInput = $null
    $secureToken = $null
    throw 'The displayed token was not confirmed saved; the Agent was not started. If you saved it, enter it on the next normal start; otherwise repeat the explicit rotation flow.'
  }
}

$DataDir = Join-Path $env:LOCALAPPDATA 'PhotoMesh\data'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:PHOTOMESH_DATA_DIR = $DataDir
$env:PORT = '8443'
$env:PHOTOMESH_API_BIND_ADDRESS = '127.0.0.1'
$env:PHOTOMESH_ADMIN_TOKEN = $adminCredential.Token
$adminCredential = $null
$tokenInput = $null
$secureToken = $null
$externalRootsJson = Read-PhotoMeshExternalRootJson
if ($null -ne $externalRootsJson) {
  $env:PHOTOMESH_EXTERNAL_ROOTS = $externalRootsJson
} else {
  Remove-Item Env:PHOTOMESH_EXTERNAL_ROOTS -ErrorAction SilentlyContinue
}
Write-Host 'Node API: http://127.0.0.1:8443  (Ctrl+C stops the node)'
& $Node $Entry
exit $LASTEXITCODE
