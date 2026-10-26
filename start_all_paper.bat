@echo off
title Algo Paper Trading Launcher
cd /d "D:\nikhil\algo"

echo ======================================================================
echo   STARTING ALGO PAPER TRADING SYSTEM (KOTAK NEO)
echo ======================================================================
echo.

:: 1. Start Kotak Live Market Feed (1-min streaming)
echo [1/3] Starting Kotak Live Feed (kotak_capture.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'kotak_capture.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Kotak Live Feed" /min python -u kotak_capture.py

:: 2. Start Trend Catcher Paper Engine (Locked Strategy with Real Option Pricing)
echo [2/3] Starting Trend Catcher Paper Engine (trend_runner_paper.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'trend_runner_paper.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Trend Catcher Paper" /min python -u trend_runner_paper.py --poll 5

:: 3. Start Dashboard Server
echo [3/3] Starting Web Dashboard Server (app_server.py)...
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'app_server.py' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }" >nul 2>&1
start "Algo Dashboard Server" /min python app_server.py

echo.
echo ======================================================================
echo   All 3 services launched successfully!
echo   - Kotak Live Feed: RUNNING
echo   - Trend Catcher Paper (09:30-13:00, 30m cooloff, Real Quotes): RUNNING
echo   - Web Dashboard: http://localhost:8090/
echo ======================================================================
echo.
timeout /t 3 /nobreak >nul
start http://localhost:8090/
