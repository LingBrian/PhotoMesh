$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'android-toolchain.ps1')
& (Join-Path $PSScriptRoot 'test-android-toolchain-paths.ps1')
$toolchain = Get-PhotoMeshAndroidToolchain -RepositoryRoot $repoRoot
$mobileDir = Join-Path $repoRoot 'apps\mobile'
Push-Location $mobileDir
try {
  Invoke-PhotoMeshFlutter -FlutterCommand $toolchain.FlutterCommand -Arguments @('pub', 'get')
  Invoke-PhotoMeshFlutter -FlutterCommand $toolchain.FlutterCommand -Arguments @('analyze')
  Invoke-PhotoMeshFlutter -FlutterCommand $toolchain.FlutterCommand -Arguments @('test')
} finally {
  Pop-Location
}
