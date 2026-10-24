function Get-PhotoMeshAndroidToolchain {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$RepositoryRoot)

  $root = (Resolve-Path -LiteralPath $RepositoryRoot).Path
  $androidRoot = Join-Path $root 'android'
  $localFlutter = Join-Path $androidRoot 'flutter\bin\flutter.bat'
  $configuredFlutter = $env:PHOTOMESH_FLUTTER_BIN

  if (-not [string]::IsNullOrWhiteSpace($configuredFlutter)) {
    if (Test-Path -LiteralPath $configuredFlutter -PathType Container) {
      $configuredFlutter = Join-Path $configuredFlutter 'bin\flutter.bat'
    }
    $flutterCommand = $configuredFlutter
  } elseif (Test-Path -LiteralPath $localFlutter -PathType Leaf) {
    $flutterCommand = $localFlutter
  } else {
    $globalFlutter = Get-Command flutter -ErrorAction SilentlyContinue
    if ($null -eq $globalFlutter) {
      throw "Flutter was not found. Install it at '$localFlutter' or set PHOTOMESH_FLUTTER_BIN."
    }
    $flutterCommand = $globalFlutter.Source
  }

  if (-not (Test-Path -LiteralPath $flutterCommand -PathType Leaf)) {
    throw "Flutter CLI does not exist: $flutterCommand"
  }

  $localSdk = Join-Path $androidRoot 'sdk'
  if (Test-Path -LiteralPath (Join-Path $localSdk 'platform-tools\adb.exe') -PathType Leaf) {
    $env:ANDROID_HOME = $localSdk
    $env:ANDROID_SDK_ROOT = $localSdk
    $env:ANDROID_USER_HOME = Join-Path $androidRoot '.android'
    $env:ANDROID_SDK_HOME = $androidRoot
    $env:ANDROID_AVD_HOME = Join-Path $androidRoot '.android\avd'
  }

  $localJdk = Join-Path $androidRoot 'jdk-17'
  $localJava = Join-Path $localJdk 'bin\java.exe'
  if (Test-Path -LiteralPath $localJava -PathType Leaf) {
    $env:JAVA_HOME = $localJdk
    $javaBin = Join-Path $localJdk 'bin'
    $pathEntries = $env:PATH -split [System.IO.Path]::PathSeparator
    if ($pathEntries -notcontains $javaBin) {
      $env:PATH = "$javaBin$([System.IO.Path]::PathSeparator)$env:PATH"
    }
  }

  $localTemp = Join-Path $androidRoot 'tmp'
  $null = New-Item -ItemType Directory -Path $localTemp -Force
  $env:TEMP = $localTemp
  $env:TMP = $localTemp
  $localHome = Join-Path $androidRoot 'home'
  $null = New-Item -ItemType Directory -Path $localHome -Force
  $env:HOME = $localHome
  $env:USERPROFILE = $localHome
  $env:HOMEDRIVE = Split-Path -Path $localHome -Qualifier
  $env:HOMEPATH = $localHome.Substring($env:HOMEDRIVE.Length)
  $localAppData = Join-Path $androidRoot 'appdata'
  $env:APPDATA = Join-Path $localAppData 'roaming'
  $env:LOCALAPPDATA = Join-Path $localAppData 'local'
  $null = New-Item -ItemType Directory -Path $env:APPDATA -Force
  $null = New-Item -ItemType Directory -Path $env:LOCALAPPDATA -Force
  $env:PUB_CACHE = Join-Path $androidRoot 'pub-cache'
  $env:GRADLE_USER_HOME = Join-Path $androidRoot '.gradle'

  [PSCustomObject]@{
    AndroidRoot = $androidRoot
    AndroidSdk = if (Test-Path -LiteralPath $localSdk -PathType Container) { $localSdk } else { $env:ANDROID_HOME }
    FlutterCommand = $flutterCommand
    JavaHome = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { $null }
  }
}

function Invoke-PhotoMeshFlutter {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$FlutterCommand,
    [Parameter(Mandatory)][string[]]$Arguments
  )

  & $FlutterCommand @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Flutter command failed with exit code ${LASTEXITCODE}: flutter $($Arguments -join ' ')"
  }
}
