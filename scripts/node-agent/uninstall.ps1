[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param([string]$Version)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA) -or -not (Test-Path -LiteralPath $env:LOCALAPPDATA -PathType Container)) {
  throw 'A valid per-user LOCALAPPDATA directory is required to validate the install path.'
}
$AppRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$InstallRoot = [IO.Path]::GetFullPath((Split-Path -Parent $AppRoot))
$ExpectedInstallRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\PhotoMesh\NodeAgent'))
if (-not [string]::Equals($InstallRoot.TrimEnd([char]92, [char]47), $ExpectedInstallRoot.TrimEnd([char]92, [char]47), [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Refusing to uninstall outside the per-user PhotoMesh Node Agent install directory.'
}
$CurrentVersion = Split-Path -Leaf $AppRoot
if (-not $PSBoundParameters.ContainsKey('Version')) { $Version = $CurrentVersion }
$LifecycleScript = Join-Path $AppRoot 'lifecycle.ps1'
if (-not (Test-Path -LiteralPath $LifecycleScript -PathType Leaf)) { throw 'PhotoMesh Node Agent lifecycle helper is missing.' }
. $LifecycleScript
Write-Host 'This removes only the selected versioned Node Agent package. PhotoMesh data, credentials, external photo folders, and firewall settings are retained.'
$removeParameters = @{
  InstallRoot = $InstallRoot
  TrustedRoot = $env:LOCALAPPDATA
  Version = $Version
}
if ($PSBoundParameters.ContainsKey('WhatIf')) { $removeParameters.WhatIf = [bool]$PSBoundParameters.WhatIf }
if ($PSBoundParameters.ContainsKey('Confirm')) { $removeParameters.Confirm = [bool]$PSBoundParameters.Confirm }
$null = Remove-PhotoMeshNodeAgentVersion @removeParameters
