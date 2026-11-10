#!/usr/bin/env bash
# ==============================================================================
# AlgoNeo — Master Systemd Services Installer & Auto-Start Configuration
# This ensures that upon server reboot or unexpected crash, ALL services
# auto-start together immediately without manual intervention.
#
# Usage:
#   npm run setup:services
#   or: sudo bash scripts/setup_services.sh
# ==============================================================================
set -e

echo "=================================================================="
echo "  🚀 Configuring AlgoNeo Systemd Services & Auto-Reboot Survival"
echo "=================================================================="

CURRENT_USER=$(whoami)
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN=$(which python3 || echo "/usr/bin/python3")

# Ensure executable permissions on all scripts
chmod +x "${APP_DIR}/scripts/sync_trades.sh"
chmod +x "${APP_DIR}/scripts/setup_services.sh" 2>/dev/null || true

# 1. Install algo.service (Core Trading Engine & Dashboard)
echo "  1️⃣  Installing /etc/systemd/system/algo.service..."
cat <<EOF | sudo tee /etc/systemd/system/algo.service > /dev/null
[Unit]
Description=AlgoNeo Automated Options Trading Platform & API Server
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${PYTHON_BIN} app_server.py
Restart=always
RestartSec=5s
Environment=PYTHONUNBUFFERED=1
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 2. Install algo-sync.service (Post-market Git Trade Backup)
echo "  2️⃣  Installing /etc/systemd/system/algo-sync.service..."
cat <<EOF | sudo tee /etc/systemd/system/algo-sync.service > /dev/null
[Unit]
Description=AlgoNeo End-of-Day Trade Git Backup Service
After=network.target

[Service]
Type=oneshot
User=${CURRENT_USER}
WorkingDirectory=${APP_DIR}
ExecStart=/bin/bash ${APP_DIR}/scripts/sync_trades.sh
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

# 3. Install algo-sync.timer (Daily 15:35 & 16:35 IST Scheduler)
echo "  3️⃣  Installing /etc/systemd/system/algo-sync.timer..."
cat <<EOF | sudo tee /etc/systemd/system/algo-sync.timer > /dev/null
[Unit]
Description=Run AlgoNeo Trade Git Backup Daily at 15:35 & 16:35 IST
Requires=algo-sync.service

[Timer]
Unit=algo-sync.service
OnCalendar=Mon..Fri *-*-* 15:35:00
OnCalendar=Mon..Fri *-*-* 16:35:00
Persistent=true

[Install]
WantedBy=timers.target
EOF

# 4. Reload systemd daemon
echo "  4️⃣  Reloading systemd daemon..."
sudo systemctl daemon-reload

# 5. Enable services to boot automatically on server reboot
echo "  5️⃣  Enabling services for auto-start on server reboot..."
sudo systemctl enable algo.service
sudo systemctl enable algo-sync.timer

# 6. Start / restart services immediately
echo "  6️⃣  Starting services now..."
sudo systemctl restart algo.service
sudo systemctl restart algo-sync.timer

echo ""
echo "=================================================================="
echo "  ✅ All AlgoNeo Services Are Active & Configured for Auto-Boot!"
echo "=================================================================="
echo ""
echo "  Core Trading Service:  sudo systemctl status algo.service"
echo "  Git Sync Timer:        sudo systemctl list-timers --all | grep algo-sync"
echo "  Live Terminal Logs:    npm run logs"
echo "=================================================================="
