@echo off
title Algo Paper Trading Launcher
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo ======================================================================
echo   STARTING ALGO PAPER TRADING SYSTEM (KOTAK NEO)
echo ======================================================================
echo Working Directory: %ROOT%
echo.

:: 1. Start Kotak Live Market Feed (1-min streaming for NIFTY, SENSEX, VIX)
echo [1/6] Starting Kotak Live Feed (kotak_capture.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'kotak_capture.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Kotak Live Feed" /min python -u kotak_capture.py

:: 2. Start Nifty Trend Runner Paper Engine
echo [2/6] Starting Nifty Trend Runner Paper (trend_runner_paper.py --symbol NIFTY)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'trend_runner_paper.py.*NIFTY' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Nifty Trend Runner Paper" /min python -u trend_runner_paper.py --symbol NIFTY --poll 5

:: 3. Start Sensex Trend Runner Paper Engine
echo [3/6] Starting Sensex Trend Runner Paper (trend_runner_paper.py --symbol SENSEX)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'trend_runner_paper.py.*SENSEX' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Sensex Trend Runner Paper" /min python -u trend_runner_paper.py --symbol SENSEX --poll 5

:: 4. Start Sensex Key Levels Paper Engine (Fade + Reverse)
echo [4/6] Starting Sensex Key Levels Paper (sensex_key_levels_paper.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'sensex_key_levels_paper.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Sensex Key Levels Paper" /min python -u sensex_key_levels_paper.py --poll 5

:: 5. Start Nifty Key Levels Paper Engine (Fade + Reverse)
echo [5/6] Starting Nifty Key Levels Paper (nifty_key_levels_paper.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'nifty_key_levels_paper.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Nifty Key Levels Paper" /min python -u nifty_key_levels_paper.py --poll 5

:: 6. Start Dashboard Server
echo [6/6] Starting Web Dashboard Server (app_server.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'app_server.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Algo Dashboard Server" /min python app_server.py

echo.
echo ======================================================================
echo   All 6 services launched successfully!
echo   - [1] Kotak Live Feed (Nifty, Sensex, VIX): RUNNING
echo   - [2] Nifty Trend Runner (ITM-150 / Dynamic): RUNNING
echo   - [3] Sensex Trend Runner (ATM / Dynamic): RUNNING
echo   - [4] Sensex Key Levels Paper: RUNNING
echo   - [5] Nifty Key Levels Paper: RUNNING
echo   - [6] Web Dashboard Server: http://localhost:8090/
echo ======================================================================
echo.
timeout /t 3 /nobreak >nul
start http://localhost:8090/
