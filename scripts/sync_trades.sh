#!/usr/bin/env bash
# ==============================================================================
# AlgoNeo — Two-Way Trade Ledger & Data Git Synchronizer
# Usage:
#   npm run sync
#   or: bash scripts/sync_trades.sh
# ==============================================================================
set -e

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

TODAY=$(date +%Y-%m-%d)
echo "=================================================================="
echo "  🔄 Two-Way Git Sync: Trade Ledgers & Remote Data ($TODAY)"
echo "=================================================================="

# 1. Always pull latest remote commits & data first (options, parquet, code fixes)
echo "  📥 Pulling latest remote data from origin/master (rebase)..."
git pull --rebase --autostash origin master

# 2. Stage local trade ledgers, signals, and live orders
# Using -f ensures files inside captured_data/fyers/ are added even if parent folder is ignored
git add -f performance/*trades*.csv 2>/dev/null || true
git add -f performance/*paper*.csv 2>/dev/null || true
git add -f captured_data/fyers/live/live_orders_*.csv 2>/dev/null || true
git add -f captured_data/fyers/live/*paper*.csv 2>/dev/null || true
git add -f captured_data/fyers/live/*signals*.csv 2>/dev/null || true

# 3. Check if there are local staged changes to commit
if git diff --cached --quiet; then
    echo "  ℹ️  No new local trade logs to commit."
    echo "  ✅ System is fully synchronized with latest GitHub data!"
    exit 0
fi

# 4. Commit local trade logs with timestamp
COMMIT_MSG="chore(trades): backup daily paper & live trade logs ($TODAY)"
echo "  📝 Committing daily trade records..."
git commit -m "$COMMIT_MSG"

# 5. Push committed trade logs to GitHub
echo "  🚀 Pushing trade ledger to GitHub origin/master..."
git push origin master

echo ""
echo "=================================================================="
echo "  ✅ Two-Way Sync Complete!"
echo "  - Local trade logs pushed to GitHub"
echo "  - Latest remote historical & options data retrieved"
echo "  View on GitHub: https://github.com/seepananikhil/algo"
echo "=================================================================="
