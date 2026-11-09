@echo off
echo Starting AlgoNeo Terminal...
cmd /c "npm --prefix web run build"
python app_server.py
pause
