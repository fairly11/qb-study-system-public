@echo off
setlocal
if not exist "%LOCALAPPDATA%\QBStudyFriend\scripts\Review-QBStudyFriend.ps1" (
  echo QBStudyFriend is not installed. Run install.cmd first.
  exit /b 1
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\QBStudyFriend\scripts\Review-QBStudyFriend.ps1" %*
exit /b %ERRORLEVEL%
