@echo off
setlocal
if not exist "%LOCALAPPDATA%\QBStudyFriend\scripts\Start-QBStudyFriend.ps1" (
  echo QBStudyFriend is not installed or this package is incomplete. Run install.cmd from the extracted package first.
  pause
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\QBStudyFriend\scripts\Start-QBStudyFriend.ps1"
set "QB_RESULT=%ERRORLEVEL%"
if not "%QB_RESULT%"=="0" pause
exit /b %QB_RESULT%
