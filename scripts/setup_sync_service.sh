#!/usr/bin/env bash
# ==============================================================================
# AlgoNeo — Automated Git Sync Systemd Service & Timer Installer
# Usage:
#   npm run setup:sync
#   or: sudo bash scripts/setup_sync_service.sh
# ==============================================================================
set -e

echo "=================================================================="
echo "  🚀 Installing AlgoNeo Automated Git Trade Backup Systemd Timer"
echo "=================================================================="

CURRENT_USER=$(whoami)
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Ensure sync script has execution permissions
chmod +x "${APP_DIR}/scripts/sync_trades.sh"

# Create custom systemd service unit
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

# Create custom systemd timer unit (triggers at 15:35 and 16:35 IST every weekday)
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

# Reload systemd and enable timer
sudo systemctl daemon-reload
sudo systemctl enable --now algo-sync.timer

echo ""
echo "=================================================================="
echo "  ✅ AlgoNeo Git trade backup timer successfully enabled!"
echo "  Scheduled to run automatically at 15:35 & 16:35 IST (Mon-Fri)."
echo "=================================================================="
sudo systemctl list-timers --all | grep algo-sync || true
