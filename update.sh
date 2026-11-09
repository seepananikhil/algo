#!/usr/bin/env bash
set -e

# ==============================================================================
# AlgoNeo Automated Daily Updater & Deployer
# Usage:
#   ./update.sh
# ==============================================================================

echo "=================================================================="
echo "          🔄 Auto-Syncing AlgoNeo to Latest Master"
echo "=================================================================="

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# 1. Fetch latest changes from GitHub
echo "[1/4] Fetching latest commits from GitHub..."
git fetch origin master

# 2. Hard sync to origin/master so local modifications never block updates
# (Files in .gitignore like neo_config.json, tokens, and live data are 100% preserved)
echo "[2/4] Resetting tracked files to origin/master..."
git reset --hard origin/master

# 3. Update dependencies if changed
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -E "(requirements.txt|package.json|web/package.json)" > /dev/null; then
    echo "📦 Detected dependency changes, installing..."
    if [ -d "venv" ]; then
        venv/bin/pip install --prefer-binary -r requirements.txt
    elif command -v pip3 &> /dev/null; then
        pip3 install --prefer-binary -r requirements.txt
    fi
    npm --prefix web install
fi

# 4. Rebuild the frontend bundle
echo "[3/4] Rebuilding frontend bundle..."
npm --prefix web run build

# 5. Restart the server service
echo "[4/4] Restarting platform service..."
if command -v systemctl &> /dev/null && systemctl is-active --quiet algo.service 2>/dev/null; then
    sudo systemctl restart algo.service
    echo "  ✅ Restarted systemd service: algo.service"
    sleep 2
    sudo systemctl status algo.service --no-pager -n 5
elif command -v pm2 &> /dev/null && pm2 list | grep -q "algoneo"; then
    pm2 restart algoneo
    echo "  ✅ Restarted PM2 daemon: algoneo"
else
    echo "  Restarting app_server.py in background..."
    pkill -f "python.*app_server.py" 2>/dev/null || true
    sleep 1
    if [ -d "venv" ]; then
        nohup venv/bin/python app_server.py > app_server.log 2>&1 &
    else
        nohup python3 app_server.py > app_server.log 2>&1 &
    fi
    echo "  ✅ Started in background (PID: $!)"
fi

echo ""
echo "=================================================================="
echo "  🎉 Update Complete! Live at: http://137.23.58.183:8090"
echo "=================================================================="
