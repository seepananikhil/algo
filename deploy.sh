#!/usr/bin/env bash
set -e

# ==============================================================================
# AlgoNeo VM One-Click Deployment Script
# Supports: Ubuntu, Debian, CentOS, AlmaLinux, Amazon Linux, Fedora
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
# ==============================================================================

echo "=================================================================="
echo "           AlgoNeo Platform - VM Production Deployment"
echo "=================================================================="

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

# 1. Detect Python3 & Node
echo "[1/5] Checking runtime dependencies..."

if ! command -v python3 &> /dev/null; then
    echo "Python 3 is required but not found. Please install python3 & python3-pip:"
    echo "  Ubuntu/Debian: sudo apt update && sudo apt install -y python3 python3-pip python3-venv"
    echo "  RHEL/CentOS:   sudo yum install -y python3 python3-pip"
    exit 1
fi

if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "Node.js / npm is required but not found. Installing via NodeSource (v20 LTS)..."
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    else
        echo "Please install Node.js (v18+) manually on your distribution."
        exit 1
    fi
fi

echo "  Python: $(python3 --version)"
echo "  Node:   $(node -v)"
echo "  npm:    v$(npm -v)"

# 2. Python Virtual Environment & Requirements
echo "[2/5] Installing Python backend dependencies..."
if [ ! -d "venv" ]; then
    echo "  Creating virtual environment in ./venv ..."
    python3 -m venv venv || python3 -m pip install --user virtualenv && virtualenv venv
fi

# Source virtualenv
source venv/bin/activate
pip install --upgrade pip setuptools wheel
pip install --prefer-binary -r requirements.txt

# 3. Build React Frontend
echo "[3/5] Building modern React frontend..."
npm --prefix web install
npm --prefix web run build

# 4. Check broker credentials configuration
echo "[4/5] Checking Kotak Neo broker credentials..."
if [ ! -f "neo_config.json" ]; then
    if [ -f "neo_config.example.json" ]; then
        echo "  [NOTICE] 'neo_config.json' not found. Creating from template..."
        cp neo_config.example.json neo_config.json
        echo "  --> IMPORTANT: Edit 'neo_config.json' with your real Kotak Neo API keys."
    fi
fi

# 5. Launch Service (PM2 or Background)
echo "[5/5] Starting AlgoNeo Server on port 8090..."

if command -v pm2 &> /dev/null; then
    echo "  PM2 process manager detected. Starting daemon..."
    pm2 delete algoneo 2>/dev/null || true
    pm2 start ecosystem.config.cjs
    pm2 save
    echo ""
    echo "=================================================================="
    echo "  ✅ AlgoNeo successfully deployed with PM2!"
    echo "  Access Terminal: http://$(curl -s ifconfig.me || echo 'YOUR_VM_IP'):8090"
    echo ""
    echo "  Useful PM2 commands:"
    echo "    pm2 logs algoneo      # View live logs"
    echo "    pm2 restart algoneo   # Restart server"
    echo "    pm2 stop algoneo      # Stop server"
    echo "=================================================================="
else
    echo "  PM2 not found. You can install it globally with: npm install -g pm2"
    echo "  Starting server in background via nohup..."
    nohup venv/bin/python3 app_server.py > app_server.log 2>&1 &
    PID=$!
    echo ""
    echo "=================================================================="
    echo "  ✅ AlgoNeo running in background (PID: $PID)!"
    echo "  Access Terminal: http://$(curl -s ifconfig.me || echo 'YOUR_VM_IP'):8090"
    echo "  Log output     : tail -f app_server.log"
    echo "=================================================================="
fi
