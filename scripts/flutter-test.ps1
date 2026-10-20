$ErrorActionPreference = 'Stop'
$mobileDir = Join-Path $PSScriptRoot '..\apps\mobile'
Push-Location $mobileDir
try {
  flutter pub get
  flutter test
} finally {
  Pop-Location
}
