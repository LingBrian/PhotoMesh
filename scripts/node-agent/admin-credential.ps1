function New-PhotoMeshAdminToken {
  [CmdletBinding()]
  param()

  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $rng.Dispose()
  }
}

function Test-PhotoMeshAdminToken {
  [CmdletBinding()]
  param([AllowNull()][string]$Token)

  if ([string]::IsNullOrEmpty($Token) -or $Token -match '\s' -or $Token -notmatch '^[A-Za-z0-9+/]{43}=$') {
    return $false
  }
  try { $bytes = [Convert]::FromBase64String($Token) } catch { return $false }
  try {
    return $bytes.Length -eq 32 -and [string]::Equals([Convert]::ToBase64String($bytes), $Token, [StringComparison]::Ordinal)
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function ConvertFrom-PhotoMeshSecureString {
  [CmdletBinding()]
  param([AllowNull()][Security.SecureString]$SecureString)

  if ($null -eq $SecureString -or $SecureString.Length -eq 0) { return '' }
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureString)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

function Resolve-PhotoMeshAdminCredential {
  [CmdletBinding()]
  param(
    [AllowNull()][AllowEmptyString()][string]$Token,
    [switch]$Rotate,
    [AllowNull()][AllowEmptyString()][string]$RotationConfirmation
  )

  if ($Rotate -or [string]::IsNullOrEmpty($Token)) {
    if (-not [string]::Equals($RotationConfirmation, 'ROTATE', [StringComparison]::Ordinal)) {
      throw 'A new administrator token requires explicit ROTATE confirmation.'
    }
    return [pscustomobject]@{ Token = New-PhotoMeshAdminToken; Generated = $true }
  }
  if (-not (Test-PhotoMeshAdminToken -Token $Token)) {
    throw 'Administrator token must be canonical Base64 for 32 bytes. Use the explicit local rotation flow to replace it.'
  }
  return [pscustomobject]@{ Token = $Token; Generated = $false }
}

function Test-PhotoMeshAdminTokenSaveConfirmation {
  [CmdletBinding()]
  param([AllowNull()][AllowEmptyString()][string]$Confirmation)

  return [string]::Equals($Confirmation, 'SAVED', [StringComparison]::Ordinal)
}
