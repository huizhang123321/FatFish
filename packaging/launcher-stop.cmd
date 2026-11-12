@echo off
rem ===================================================================
rem  FatFish - stop the running backend. Shipped inside the installer.
rem ===================================================================
setlocal
echo Stopping FatFish backend...
taskkill /IM minimost-server.exe /T /F >nul 2>&1
if errorlevel 1 (echo   backend: not running) else (echo   backend: stopped)
taskkill /IM FatFish.exe /T /F >nul 2>&1
if errorlevel 1 (echo   window : not running) else (echo   window : stopped)
echo.
timeout /t 3 >nul
endlocal
