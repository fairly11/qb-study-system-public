@echo off
setlocal
if not exist "%LOCALAPPDATA%\QBRecordWindows\scripts\Enable-Autostart.ps1" (
  echo QBRecordWindows is not installed or this package is incomplete. Run install.cmd from the extracted package first.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\QBRecordWindows\scripts\Enable-Autostart.ps1"
set "QB_RESULT=%ERRORLEVEL%"
pause
exit /b %QB_RESULT%
