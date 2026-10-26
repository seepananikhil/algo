@echo off
title Stop Algo Paper Trading
cd /d "D:\nikhil\algo"

echo ======================================================================
echo   STOPPING ALGO PAPER TRADING SERVICES
echo ======================================================================
echo.

powershell -Command "Get-CimInstance Win32_Process -Filter \"Name LIKE 'python%'\" | Where-Object { $_.CommandLine -match 'kotak_capture|trend_runner_paper|app_server' } | ForEach-Object { Write-Host 'Stopping PID' $_.ProcessId; Stop-Process -Id $_.ProcessId -Force }"

echo.
echo ======================================================================
echo   All algo paper trading processes stopped.
echo ======================================================================
timeout /t 3 /nobreak >nul
