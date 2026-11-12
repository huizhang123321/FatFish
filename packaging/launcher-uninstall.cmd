@echo off
rem ===================================================================
rem  FatFish uninstaller launcher.
rem
rem  The problem
rem  -----------
rem  An NSIS uninstaller copies itself into %TEMP% and runs from there. On some
rem  machines that folder is refused and the uninstaller never starts, so
rem  "uninstall" looks like it does nothing. Measured here: %TEMP% and
rem  %APPDATA%\... both fail; some folders on another volume work and others do
rem  not, with no pattern worth encoding.
rem
rem  The fix that needs no guessing
rem  ------------------------------
rem  Copy the uninstaller to a scratch folder in the *parent* of the install
rem  directory and run it from there. That folder is guaranteed to exist, to be
rem  writable (we were installed next to it), to be on the same volume, and -- the
rem  point -- to be outside the tree being deleted, so the running executable and
rem  its temporary files are never under the directory that gets removed. Its TEMP
rem  is set to the same folder for the same reason.
rem
rem  This file also lives inside the install directory, which is why it does the
rem  copy-and-relaunch dance rather than calling Uninstall.exe directly: cmd.exe
rem  holds a running batch file open, which used to leave one orphan behind.
rem
rem  Success is judged by whether the programme actually went away, not by the
rem  exit code, because NSIS can finish the job and still report a failure.
rem
rem  Arguments are forwarded, so "launcher-uninstall.cmd /S" is a silent uninstall.
rem  ASCII-only: cmd.exe decodes .cmd files with the system ANSI code page.
rem ===================================================================
setlocal
set "ARGS=%*"
set "HERE=%~dp0"

if defined FF_STAGED goto :staged

if not exist "%HERE%Uninstall.exe" (
    echo Nothing to uninstall: %HERE%Uninstall.exe is not there.
    echo.
    pause
    exit /b 2
)

rem Scratch folder next to the install directory, never inside it.
for %%D in ("%HERE%..") do set "PARENT=%%~fD"
set "STAGE=%PARENT%\_fatfish-uninstall"
mkdir "%STAGE%" >nul 2>&1
if not exist "%STAGE%" (
    echo Could not create a scratch folder at %STAGE%
    echo Running the uninstaller in place instead.
    goto :direct
)

copy /y "%HERE%Uninstall.exe" "%STAGE%\Uninstall.exe" >nul 2>&1
copy /y "%~f0" "%STAGE%\run.cmd" >nul 2>&1
if not exist "%STAGE%\run.cmd" (
    echo Could not stage the uninstaller in %STAGE%
    goto :direct
)

set "FF_STAGED=1"
set "FF_INSTALL_DIR=%HERE%"
set "FF_STAGE_DIR=%STAGE%"
call "%STAGE%\run.cmd" %*
set "RC=%ERRORLEVEL%"
timeout /t 2 /nobreak >nul 2>&1
rd /s /q "%STAGE%" >nul 2>&1
exit /b %RC%

:staged
set "HERE=%FF_INSTALL_DIR%"
rem Everything the uninstaller needs lives outside the tree it is about to delete.
set "TEMP=%FF_STAGE_DIR%"
set "TMP=%FF_STAGE_DIR%"
"%FF_STAGE_DIR%\Uninstall.exe" %ARGS%

call :wait_for_removal
if not exist "%HERE%Uninstall.exe" (
    endlocal & exit /b 0
)
echo.
echo Uninstall did not complete. Uninstall.exe is still present:
echo   %HERE%Uninstall.exe
echo Please report this message to the developer.
pause
endlocal & exit /b 1

:direct
set "TEMP=%HERE%_unsetup_temp"
set "TMP=%TEMP%"
mkdir "%TEMP%" >nul 2>&1
"%HERE%Uninstall.exe" %ARGS%
call :wait_for_removal
if not exist "%HERE%Uninstall.exe" (
    if exist "%TEMP%" rd /s /q "%TEMP%" >nul 2>&1
    endlocal & exit /b 0
)
echo.
echo Uninstall did not complete.
pause
endlocal & exit /b 1

rem ---------------------------------------------------------------------------
rem Deleting 386 MB takes a while, and NSIS may return before it has finished.
rem ---------------------------------------------------------------------------
:wait_for_removal
for /l %%I in (1,1,20) do (
    if not exist "%HERE%Uninstall.exe" exit /b 0
    timeout /t 3 /nobreak >nul 2>&1
)
exit /b 0
