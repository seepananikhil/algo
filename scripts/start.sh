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

# Detect Python interpreter (prefer virtualenv if active/present)
if [ -n "$VIRTUAL_ENV" ] && [ -f "$VIRTUAL_ENV/bin/python" ]; then
    PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -f "${APP_DIR}/venv/bin/python" ]; then
    PYTHON_BIN="${APP_DIR}/venv/bin/python"
elif [ -f "${APP_DIR}/.venv/bin/python" ]; then
    PYTHON_BIN="${APP_DIR}/.venv/bin/python"
elif [ -f "$HOME/algo_venv/bin/python" ]; then
    PYTHON_BIN="$HOME/algo_venv/bin/python"
else
    PYTHON_BIN=$(which python3 || echo "python")
fi

echo "=================================================================="
echo "  🚀 Starting AlgoNeo Trading Platform & Services..."
echo "  Using Python: $PYTHON_BIN"
echo "=================================================================="

# Auto-verify / install essential dependencies (pyotp, pandas, requests)
if ! ${PYTHON_BIN} -c "import pyotp" &>/dev/null; then
    echo "  📦 Installing missing dependency: pyotp..."
    ${PYTHON_BIN} -m pip install pyotp || pip install pyotp || pip3 install pyotp || true
fi
if ! ${PYTHON_BIN} -c "import neo_api_client" &>/dev/null; then
    echo "  📦 Installing missing dependency: kotakneoapi..."
    ${PYTHON_BIN} -m pip install kotakneoapi || pip install kotakneoapi || pip3 install kotakneoapi || true
fi

# Check if running in a Linux systemd environment (e.g. Cloud VM)
if command -v systemctl &> /dev/null && [ -d /run/systemd/system ]; then
    # Ensure systemd services are installed and enabled
    if [ ! -f /etc/systemd/system/algo.service ] || [ ! -f /etc/systemd/system/algo-sync.timer ]; then
        echo "  ℹ️  Installing / updating systemd auto-boot services..."
        sudo bash "${APP_DIR}/scripts/setup_services.sh"
    else
        echo "  🔄 Starting / Restarting background trading service..."
        sudo systemctl restart algo.service
        sudo systemctl daemon-reload
        sudo systemctl enable --now algo-sync.timer 2>/dev/null || true
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
