param([string]$Target = 'apk')
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'android-toolchain.ps1')
$toolchain = Get-PhotoMeshAndroidToolchain -RepositoryRoot $repoRoot
$mobileDir = Join-Path $repoRoot 'apps\mobile'
Push-Location $mobileDir
try {
  Invoke-PhotoMeshFlutter -FlutterCommand $toolchain.FlutterCommand -Arguments @('pub', 'get')
  Invoke-PhotoMeshFlutter -FlutterCommand $toolchain.FlutterCommand -Arguments @('build', $Target)
} finally {
  Pop-Location
}
