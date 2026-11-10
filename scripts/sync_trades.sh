#!/usr/bin/env bash
# ==============================================================================
# AlgoNeo — End-of-Day Trade & Performance Git Synchronizer
# Usage:
#   npm run sync
#   or: bash scripts/sync_trades.sh
# ==============================================================================
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

TODAY=$(date +%Y-%m-%d)
echo "=================================================================="
echo "  📦 Syncing Trade Ledgers & Performance to GitHub ($TODAY)"
echo "=================================================================="

# 1. Stage trade ledgers, signals, and live orders
# Using -f ensures files inside captured_data/fyers/ are added even if parent folder is ignored
git add -f performance/*trades*.csv 2>/dev/null || true
git add -f performance/*paper*.csv 2>/dev/null || true
git add -f captured_data/fyers/live/live_orders_*.csv 2>/dev/null || true
git add -f captured_data/fyers/live/*paper*.csv 2>/dev/null || true
git add -f captured_data/fyers/live/*signals*.csv 2>/dev/null || true

# 2. Check if there are staged changes
if git diff --cached --quiet; then
    echo "  ℹ️  No new trade records or changes to commit for today."
    exit 0
fi

# 3. Pull latest remote changes first to prevent push rejection
echo "  🔄 Pulling latest remote changes (rebase)..."
git pull --rebase origin master

# 4. Commit with timestamp
COMMIT_MSG="chore(trades): backup daily paper & live trade logs ($TODAY)"
git commit -m "$COMMIT_MSG"

# 5. Push to GitHub
echo "  🚀 Pushing trade ledger to GitHub origin/master..."
git push origin master

echo ""
echo "=================================================================="
echo "  ✅ All trades safely backed up to GitHub!"
echo "  View on GitHub: https://github.com/seepananikhil/algo"
echo "=================================================================="
