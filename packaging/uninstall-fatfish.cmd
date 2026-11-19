@echo off
rem ===================================================================
rem  FatFish uninstaller (standalone).
rem
rem  ASCII-only wrapper: cmd.exe decodes .cmd files with the system ANSI
rem  code page, so all messages live in uninstall-fatfish.ps1.
rem
rem  Why this exists in addition to the uninstaller inside the install
rem  directory: on some machines every NSIS uninstaller aborts with
rem  "Error writing temporary file" before it does anything, so the
rem  packaged one leaves the programme installed. This removes the files,
rem  shortcuts and registry entries directly and cannot be defeated that
rem  way. Chat data in %APPDATA%\FatFish is deliberately kept.
rem ===================================================================
setlocal
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall-fatfish.ps1" %*
endlocal
