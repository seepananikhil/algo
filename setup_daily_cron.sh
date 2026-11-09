#!/usr/bin/env bash
# ==============================================================================
# Installs a daily cron job to pull from GitHub and deploy automatically
# Runs at 17:15 IST (11:45 UTC) every Monday through Friday, right after
# GitHub Actions finishes updating the day's data and master backtests.
# ==============================================================================

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$APP_DIR/update.sh"
LOG_FILE="$APP_DIR/daily_update.log"

CRON_JOB="45 11 * * 1-5 bash $SCRIPT >> $LOG_FILE 2>&1"

# Check if already installed
(crontab -l 2>/dev/null | grep -F "$SCRIPT") && {
    echo "Daily update cron job is already installed!"
    exit 0
}

# Add to crontab
(crontab -l 2>/dev/null; echo "$CRON_JOB") | crontab -

echo "✅ Daily update cron job installed successfully!"
echo "Schedule : 17:15 IST (11:45 UTC) Monday - Friday"
echo "Command  : $CRON_JOB"
echo "Log file : $LOG_FILE"
