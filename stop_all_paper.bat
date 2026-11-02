@echo off
title Stop Algo Paper Trading
set "ROOT=%~dp0"
cd /d "%ROOT%"

echo ======================================================================
echo   STOPPING ALGO PAPER TRADING SERVICES
echo ======================================================================
echo.

powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'kotak_capture|trend_runner_paper|sensex_key_levels_paper|nifty_key_levels_paper|app_server' } | ForEach-Object { Write-Host 'Stopping PID' $_.ProcessId '(' $_.CommandLine ')'; Stop-Process -Id $_.ProcessId -Force }"

echo.
echo ======================================================================
echo   All algo paper trading services stopped.
echo ======================================================================
timeout /t 3 /nobreak >nul
