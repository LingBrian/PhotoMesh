$ErrorActionPreference = 'Stop'
$mobileDir = Join-Path $PSScriptRoot '..\apps\mobile'
Push-Location $mobileDir
try {
  flutter pub get
  flutter analyze
  flutter test
} finally {
  Pop-Location
}
