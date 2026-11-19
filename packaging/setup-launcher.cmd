@echo off
rem ===================================================================
rem  FatFish installer launcher.
rem
rem  ASCII-only wrapper: cmd.exe decodes .cmd files with the system ANSI
rem  code page, so every message lives in setup-launcher.ps1.
rem
rem  Why this exists: on some machines every NSIS installer aborts with
rem  "Error writing temporary file" because the per-user %TEMP% cannot be
rem  used for NSIS' start-up temp file. This sets TEMP/TMP to a folder we
rem  know is writable before starting the installer. On a healthy machine
rem  you can double-click the .exe directly instead.
rem ===================================================================
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-launcher.ps1" %*
endlocal
