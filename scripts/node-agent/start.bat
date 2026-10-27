@echo off
setlocal
if /I "%~1"=="-RotateAdminToken" goto rotate
if not "%~1"=="" goto invalid
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
exit /b %ERRORLEVEL%

:rotate
if not "%~2"=="" goto invalid
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" -RotateAdminToken
exit /b %ERRORLEVEL%

:invalid
echo Usage: start.bat [-RotateAdminToken]
exit /b 2
