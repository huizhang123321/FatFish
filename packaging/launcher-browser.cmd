@echo off
rem ===================================================================
rem  FatFish - browser-mode launcher, shipped inside the installer.
rem  ASCII-only: cmd.exe decodes .cmd files with the system ANSI code
rem  page, so all localised text lives in launcher-browser.ps1.
rem ===================================================================
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher-browser.ps1" %*
endlocal
