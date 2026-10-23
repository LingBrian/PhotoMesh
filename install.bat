@echo off
setlocal
set "VERSION=__VERSION__"
set "TMP_SCRIPT=%TEMP%\PhotoMesh-install-%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $version='%VERSION%'; if($version -eq '__VERSION__'){$version=(Invoke-RestMethod -Uri 'https://raw.githubusercontent.com/LingBrian/PhotoMesh/main/package.json').version}; if($version -notmatch '^0\.\d+\.\d+-(alpha|beta|rc)\.\d+$'){throw 'Invalid PhotoMesh version'}; $uri='https://github.com/LingBrian/PhotoMesh/releases/download/v'+$version+'/install.ps1'; Invoke-WebRequest -Uri $uri -OutFile '%TMP_SCRIPT%'; & '%TMP_SCRIPT%'"
set "RESULT=%ERRORLEVEL%"
if exist "%TMP_SCRIPT%" del "%TMP_SCRIPT%"
exit /b %RESULT%
