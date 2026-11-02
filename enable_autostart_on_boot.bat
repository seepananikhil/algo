@echo off
title Enable Auto-Start on System Boot
set "ROOT=%~dp0"
cd /d "%ROOT%"

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET_BAT=%STARTUP_FOLDER%\StartAlgoPaperTrading.bat"

echo ======================================================================
echo   ENABLING AUTO-START ON WINDOWS REBOOT
echo ======================================================================
echo Current Directory: %ROOT%
echo.

(
    echo @echo off
    echo cd /d "%ROOT%"
    echo call "%ROOT%start_all_paper.bat"
) > "%TARGET_BAT%"

if exist "%TARGET_BAT%" (
    echo [SUCCESS] Auto-start script installed in Windows Startup folder:
    echo   "%TARGET_BAT%"
    echo.
    echo Next time Windows starts up and you log in, all paper trading modes,
    echo live feeds, and the dashboard will automatically start in the background!
) else (
    echo [ERROR] Could not create startup entry.
)

echo.
pause
