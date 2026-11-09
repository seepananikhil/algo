#!/usr/bin/env bash
set -e

# ==============================================================================
# AlgoNeo One-Command VM Updater
# Usage on VM:
#   ./update.sh
# ==============================================================================

echo "=================================================================="
echo "          🔄 Updating AlgoNeo to Latest Version"
echo "=================================================================="

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# 1. Cleanly stash any local runtime changes (e.g. locally updated CSVs/caches)
echo "[1/4] Stashing local runtime files..."
git stash --include-untracked --quiet 2>/dev/null || git stash --quiet 2>/dev/null || true

# 2. Pull the latest commits from GitHub
echo "[2/4] Pulling latest code from origin/master..."
git pull origin master

# 3. Update dependencies if requirements or package files changed
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
    sudo systemctl status algo.service --no-pager -n 7
elif command -v pm2 &> /dev/null && pm2 list | grep -q "algoneo"; then
    pm2 restart algoneo
    echo "  ✅ Restarted PM2 daemon: algoneo"
else
    # Fallback restart via PID
    echo "  Restarting app_server.py..."
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
echo "  🎉 Update Complete! Platform is live at: http://137.23.58.183:8090"
echo "=================================================================="
