[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$script:assertionCount = 0
$script:credentialPath = Join-Path $PSScriptRoot 'node-agent\admin-credential.ps1'
if (-not (Test-Path -LiteralPath $script:credentialPath -PathType Leaf)) {
  throw "Node Agent admin credential helper is missing: $script:credentialPath"
}
. $script:credentialPath

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
  $script:assertionCount++
}

function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  if ($Actual -cne $Expected) { throw "$Message (expected '$Expected', got '$Actual')" }
  $script:assertionCount++
}

function Assert-Throws {
  param([scriptblock]$Action, [string]$Message)
  $threw = $false
  try { & $Action } catch { $threw = $true }
  if (-not $threw) { throw $Message }
  $script:assertionCount++
}

$tokenA = New-PhotoMeshAdminToken
$tokenB = New-PhotoMeshAdminToken
Assert-True ($tokenA -match '^[A-Za-z0-9+/]{43}=$') 'Generated admin token was not canonical Base64 for 32 bytes'
Assert-Equal ([Convert]::FromBase64String($tokenA).Length) 32 'Generated admin token did not decode to 32 bytes'
Assert-True ($tokenA -cne $tokenB) 'CSPRNG returned the same admin token twice'
Assert-True (Test-PhotoMeshAdminToken -Token $tokenA) 'Generated admin token failed validation'
Assert-True (-not (Test-PhotoMeshAdminToken -Token '')) 'Empty admin token was accepted'
Assert-True (-not (Test-PhotoMeshAdminToken -Token ('x' * 32))) 'Weak non-Base64 admin token was accepted'
Assert-True (-not (Test-PhotoMeshAdminToken -Token (($tokenA.Substring(0, 43) + 'A')))) 'Noncanonical Base64 padding was accepted'
Assert-True (-not (Test-PhotoMeshAdminToken -Token ($tokenA + "`n"))) 'Admin token with trailing whitespace was accepted'

$secure = ConvertTo-SecureString -String $tokenA -AsPlainText -Force
Assert-Equal (ConvertFrom-PhotoMeshSecureString -SecureString $secure) $tokenA 'SecureString conversion changed the admin token'
$emptySecure = New-Object System.Security.SecureString
Assert-Equal (ConvertFrom-PhotoMeshSecureString -SecureString $emptySecure) '' 'Empty SecureString did not convert to an empty token'

$existing = Resolve-PhotoMeshAdminCredential -Token $tokenA
Assert-Equal $existing.Token $tokenA 'Normal start did not preserve the existing token'
Assert-True (-not $existing.Generated) 'Normal start incorrectly marked the existing token as generated'
Assert-Throws { Resolve-PhotoMeshAdminCredential -Token '' } 'Empty token was accepted without explicit rotation confirmation'
Assert-Throws { Resolve-PhotoMeshAdminCredential -Token '' -RotationConfirmation 'rotate' } 'Case-mismatched rotation confirmation was accepted'
Assert-Throws { Resolve-PhotoMeshAdminCredential -Token ('x' * 44) } 'Invalid token was accepted for a normal restart'

$firstUse = Resolve-PhotoMeshAdminCredential -Token '' -RotationConfirmation 'ROTATE'
Assert-True $firstUse.Generated 'First-use token generation was not marked as generated'
Assert-True (Test-PhotoMeshAdminToken -Token $firstUse.Token) 'First-use token generation produced an invalid token'
Assert-True ($firstUse.Token -cne $tokenA) 'Generated first-use token reused the existing token'

$rotation = Resolve-PhotoMeshAdminCredential -Token '' -Rotate -RotationConfirmation 'ROTATE'
Assert-True $rotation.Generated 'Explicit token rotation was not marked as generated'
Assert-True (Test-PhotoMeshAdminToken -Token $rotation.Token) 'Rotation produced an invalid token'
Assert-True ($rotation.Token -cne $tokenA) 'Rotation did not replace the prior token'
Assert-Throws { Resolve-PhotoMeshAdminCredential -Token '' -Rotate } 'Rotation proceeded without explicit confirmation'
Assert-True (Test-PhotoMeshAdminTokenSaveConfirmation -Confirmation 'SAVED') 'Exact save confirmation was rejected'
Assert-True (-not (Test-PhotoMeshAdminTokenSaveConfirmation -Confirmation 'saved')) 'Case-mismatched save confirmation was accepted'
Assert-True (-not (Test-PhotoMeshAdminTokenSaveConfirmation -Confirmation '')) 'Empty save confirmation was accepted'

$startScriptPath = Join-Path $PSScriptRoot 'node-agent\start.ps1'
$startBatchPath = Join-Path $PSScriptRoot 'node-agent\start.bat'
$startScriptContent = Get-Content -LiteralPath $startScriptPath -Raw
$startBatchContent = Get-Content -LiteralPath $startBatchPath -Raw
Assert-True ($startScriptContent -match '\[switch\]\$RotateAdminToken') 'Start script does not expose the explicit rotation switch'
Assert-True ($startBatchContent -match 'start\.ps1" -RotateAdminToken') 'Start batch launcher does not expose the fixed rotation switch'
Assert-True ($startBatchContent -match 'goto invalid') 'Start batch launcher does not reject unexpected command-line arguments'
Assert-True ($startBatchContent -notmatch '%\*') 'Start batch launcher forwards arbitrary command-line arguments'
$startTokens = $null
$startParseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($startScriptPath, [ref]$startTokens, [ref]$startParseErrors) | Out-Null
Assert-Equal $startParseErrors.Count 0 'Node Agent start script contains a PowerShell syntax error'

Write-Host "Windows Node Agent admin credential tests passed ($script:assertionCount assertions)."
