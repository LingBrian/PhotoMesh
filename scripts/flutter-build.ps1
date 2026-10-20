param([string]$Target = 'apk')
$ErrorActionPreference = 'Stop'
$mobileDir = Join-Path $PSScriptRoot '..\apps\mobile'
Push-Location $mobileDir
try {
  flutter pub get
  flutter build $Target
} finally {
  Pop-Location
}
