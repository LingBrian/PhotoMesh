@echo off
setlocal
set "VERSION=__VERSION__"
set "TMP_SCRIPT=%TEMP%\PhotoMesh-install-%RANDOM%-%RANDOM%-%RANDOM%-%RANDOM%.ps1"
if exist "%TMP_SCRIPT%" (
  echo Refusing to overwrite an existing temporary file: "%TMP_SCRIPT%"
  exit /b 1
)
set "PHOTOMESH_INSTALL_SCRIPT=%TMP_SCRIPT%"
set "PHOTOMESH_INSTALL_VERSION=%VERSION%"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $version=$env:PHOTOMESH_INSTALL_VERSION; if($version -eq '__VERSION__'){$version=(Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/LingBrian/PhotoMesh/main/package.json').version}; if($version -notmatch '^0\.\d+\.\d+-(alpha|beta|rc)\.\d+$'){throw 'Invalid PhotoMesh version'}; $uri='https://github.com/LingBrian/PhotoMesh/releases/download/v'+$version+'/install.ps1'; $scriptPath=$env:PHOTOMESH_INSTALL_SCRIPT; Invoke-WebRequest -Uri $uri -OutFile $scriptPath; & $scriptPath"
set "RESULT=%ERRORLEVEL%"
if exist "%TMP_SCRIPT%" del "%TMP_SCRIPT%"
exit /b %RESULT%
