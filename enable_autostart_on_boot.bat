@echo off
title Enable Auto-Start on System Boot
cd /d "D:\nikhil\algo"

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_BAT=%STARTUP_FOLDER%\StartAlgoPaperTrading.bat"

echo ======================================================================
echo   ENABLING AUTO-START ON WINDOWS REBOOT
echo ======================================================================
echo.

(
    echo @echo off
    echo cd /d "D:\nikhil\algo"
    echo call "D:\nikhil\algo\start_all_paper.bat"
) > "%TARGET_BAT%"

if exist "%TARGET_BAT%" (
    echo [SUCCESS] Auto-start script installed in Windows Startup folder:
    echo   "%TARGET_BAT%"
    echo.
    echo Next time Windows restarts and you log in, all paper trading modes
    echo and the dashboard will automatically start in the background!
) else (
    echo [ERROR] Could not create startup entry.
)

echo.
pause
