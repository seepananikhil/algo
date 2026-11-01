@echo off
title Disable Auto-Start on System Boot
cd /d "D:\nikhil\algo"

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_BAT=%STARTUP_FOLDER%\StartAlgoPaperTrading.bat"

echo ======================================================================
echo   DISABLING AUTO-START ON WINDOWS REBOOT
echo ======================================================================
echo.

if exist "%TARGET_BAT%" (
    del "%TARGET_BAT%"
    echo [SUCCESS] Auto-start script removed from Windows Startup folder.
    echo System will NO LONGER auto-start trading on reboot.
) else (
    echo Auto-start was not enabled. Nothing to remove.
)

echo.
pause
