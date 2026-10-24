$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'android-toolchain.ps1')

$drivePath = Get-PhotoMeshHomeDrivePath -HomePath 'C:\PhotoMesh\android\home' -PathRoot 'C:\'
if ($drivePath.HomeDrive -ne 'C:' -or $drivePath.HomePath -ne '\PhotoMesh\android\home') {
  throw 'Drive-letter HOME variables were not derived correctly.'
}

$uncPath = Get-PhotoMeshHomeDrivePath -HomePath '\\server\share\PhotoMesh\android\home' -PathRoot '\\server\share\'
if ($uncPath.HomeDrive -ne '\\server\share' -or $uncPath.HomePath -ne '\PhotoMesh\android\home') {
  throw 'UNC HOME variables were not derived correctly.'
}

$posixPath = Get-PhotoMeshHomeDrivePath -HomePath '/home/runner/android/home' -PathRoot '/'
if ($null -ne $posixPath) {
  throw 'POSIX paths must not produce Windows HOMEDRIVE/HOMEPATH values.'
}

Write-Output 'Android toolchain HOME path tests passed.'
