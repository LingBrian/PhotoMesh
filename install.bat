@echo off
setlocal
set "REPO=LingBrian/PhotoMesh"
set "TMP_SCRIPT=%TEMP%\PhotoMesh-install-%RANDOM%.ps1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $releases=Invoke-RestMethod -Headers @{'User-Agent'='PhotoMesh-Installer'} -Uri 'https://api.github.com/repos/%REPO%/releases?per_page=100'; $release=$releases | Where-Object { $_.prerelease -and -not $_.draft } | Select-Object -First 1; if(-not $release){throw 'No PhotoMesh prerelease found'}; $asset=$release.assets | Where-Object name -eq 'install.ps1' | Select-Object -First 1; if(-not $asset){throw 'Release installer not found'}; Invoke-WebRequest -Uri $asset.browser_download_url -OutFile '%TMP_SCRIPT%'; & '%TMP_SCRIPT%'"
set "RESULT=%ERRORLEVEL%"
if exist "%TMP_SCRIPT%" del "%TMP_SCRIPT%"
exit /b %RESULT%
