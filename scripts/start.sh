#!/usr/bin/env bash
# ==============================================================================
# AlgoNeo — Master Unified Startup Script
# Usage:
#   npm start
#   or: bash scripts/start.sh
# ==============================================================================
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

PYTHON_BIN=$(which python3 || echo "python")

echo "=================================================================="
echo "  🚀 Starting AlgoNeo Trading Platform & Services..."
echo "=================================================================="

# Check if running in a Linux systemd environment (e.g. Cloud VM)
if command -v systemctl &> /dev/null && [ -d /run/systemd/system ]; then
    # Ensure systemd services are installed and enabled
    if [ ! -f /etc/systemd/system/algo.service ]; then
        echo "  ℹ️  First-time setup: Installing systemd auto-boot services..."
        bash "${APP_DIR}/scripts/setup_services.sh"
    else
        echo "  🔄 Starting / Restarting background trading service..."
        sudo systemctl restart algo.service
        sudo systemctl restart algo-sync.timer 2>/dev/null || true
    fi

    # Wait 2 seconds for server port to bind
    sleep 2

    # Execute preflight check and output diagnostic banner
    ${PYTHON_BIN} "${APP_DIR}/scripts/preflight_check.py" || true

    VM_IP=$(curl -s --max-time 2 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || echo "YOUR_VM_IP")
    echo "=================================================================="
    echo "  ✅ AlgoNeo is RUNNING 24/7 in the background!"
    echo "  🌐 Dashboard:  http://${VM_IP}:8090"
    echo "  📜 View Logs:  npm run logs"
    echo "  🔍 Status:     npm run check"
    echo "  🛑 Stop:       npm run stop"
    echo "=================================================================="
else
    # Standalone dev environment (Windows / Mac)
    echo "  Running preflight check..."
    python scripts/preflight_check.py || true
    echo "  Starting local app server..."
    python app_server.py
fi
