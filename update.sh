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
echo "[1/3] Fetching latest commits from GitHub..."
git fetch origin master

# 2. Hard sync to origin/master so local modifications never block updates
echo "[2/3] Resetting tracked files to origin/master..."
PREV_COMMIT=$(git rev-parse HEAD 2>/dev/null || echo "HEAD~1")
git reset --hard origin/master
CURR_COMMIT=$(git rev-parse HEAD)

# Detect what actually changed in this update
CHANGED_FILES=$(git diff --name-only "$PREV_COMMIT" "$CURR_COMMIT" 2>/dev/null || echo "")

# 3. Smart dependency check (only run if files changed)
if echo "$CHANGED_FILES" | grep -qE "requirements.txt"; then
    echo "📦 Detected Python dependency changes, installing..."
    if [ -d "venv" ]; then
        venv/bin/pip install --prefer-binary -r requirements.txt
    elif command -v pip3 &> /dev/null; then
        pip3 install --prefer-binary -r requirements.txt
    fi
fi

if echo "$CHANGED_FILES" | grep -qE "web/package.json"; then
    echo "📦 Detected npm package changes, installing..."
    npm --prefix web install
fi

# 4. Smart frontend build:
# If prebuilt web/dist is already committed or web/src didn't change, SKIP the heavy npm build!
if echo "$CHANGED_FILES" | grep -qE "^web/src/"; then
    if ! echo "$CHANGED_FILES" | grep -qE "^web/dist/"; then
        echo "🎨 Detected source changes in web/src without prebuilt dist. Rebuilding..."
        npm --prefix web run build
    else
        echo "⚡ Using pre-built web/dist from Git (skipped slow npm build)."
    fi
else
    echo "⚡ No frontend changes detected (skipped slow npm build)."
fi

# 5. Fast restart service
echo "[3/3] Reloading platform service..."
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
echo "  🎉 Update Complete! Live at: http://$(curl -s ifconfig.me || echo 'YOUR_VM_IP'):8090"
echo "=================================================================="
