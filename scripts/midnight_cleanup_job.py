#!/usr/bin/env python3
"""
Midnight Rollover & Cleanup Job
================================
Runs automatically at midnight (00:00:00 - 00:05:00 IST) or on-demand:
1. Syncs all closed trades from the previous day directly into Master Backtests
   (Nifty 10Y, Sensex, VIX Trend Runner, and Apex Duo Master Portfolio).
2. Archives daily live paper/trade CSVs to `captured_data/archive/trades/{date}/`
   and resets active live CSVs with fresh headers so monitoring starts with 0 trades.
3. Completely clears and resets Kill Switch (`STOP_TRADING`), Risk Locks (`RISK_LOCK.json`),
   circuit breaker resets (`RISK_RESET.json`), and scalp targets (`scalp_targets.json`).
4. Rotates and cleans up bloated log files in `logs/` (e.g. `risk_guardian.log`, `neo-api-client.log.*`)
   moving old logs into `logs/archive/{YYYY-MM}/` so disk space is preserved and logs stay clean.
"""

from __future__ import annotations

import csv
import json
import logging
import os
import shutil
import sys
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

logger = logging.getLogger("midnight_cleanup")
if not logger.handlers:
    logger.setLevel(logging.INFO)
    _sh = logging.StreamHandler(sys.stdout)
    _sh.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    logger.addHandler(_sh)


def get_previous_trading_day_str(ref_date_str: str | None = None) -> str:
    """Return yesterday's date string (YYYY-MM-DD)."""
    now = datetime.now(IST) if ref_date_str is None else datetime.strptime(ref_date_str, "%Y-%m-%d").replace(tzinfo=IST)
    prev = now - timedelta(days=1)
    return prev.strftime("%Y-%m-%d")


def today_str() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def reset_csv_with_header(file_path: Path) -> bool:
    """Preserve only the CSV header and clear data rows."""
    if not file_path.exists():
        return False
    try:
        with file_path.open("r", encoding="utf-8") as f:
            reader = csv.reader(f)
            header = next(reader, None)
        if header:
            with file_path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(header)
            return True
        else:
            file_path.write_text("", encoding="utf-8")
            return True
    except Exception as exc:
        logger.error(f"Error resetting CSV {file_path.name}: {exc}")
        return False


def run_midnight_cleanup(ref_date_str: str | None = None) -> dict:
    """
    Execute full midnight cleanup, backtest sync, paper trade archival,
    kill switch release, and log rotation.
    """
    now = datetime.now(IST)
    today = today_str() if ref_date_str is None else ref_date_str
    prev_date = get_previous_trading_day_str(today)
    ym = now.strftime("%Y-%m")

    logger.info("=" * 75)
    logger.info(f"🌙 [MIDNIGHT CLEANUP & ROLLOVER] Running for new day {today} (Archiving {prev_date})")
    logger.info("=" * 75)

    archived_trades = []
    cleaned_locks = []
    rotated_logs = []
    backtest_synced = False

    # ---------------------------------------------------------
    # 1. SYNC CLOSED TRADES TO MASTER BACKTESTS
    # ---------------------------------------------------------
    try:
        from scripts.sync_eod_trades_to_backtest import sync_eod_trades
        logger.info("👉 Step 1: Syncing previous day's closed trades into Master Backtests...")
        sync_eod_trades()
        backtest_synced = True
        logger.info("✅ Step 1: Master backtests successfully synchronized.")
    except Exception as exc:
        logger.error(f"❌ Step 1 Error syncing trades to backtest: {exc}")

    # ---------------------------------------------------------
    # 2. SNAPSHOT CUMULATIVE PAPER TRADE FILES (PRESERVE HISTORY)
    # ---------------------------------------------------------
    logger.info("👉 Step 2: Creating daily archive snapshots of paper trade files (preserving cumulative ledger)...")
    archive_trade_dir = ROOT / "captured_data" / "archive" / "trades" / prev_date
    archive_trade_dir.mkdir(parents=True, exist_ok=True)

    perf_archive_dir = ROOT / "performance" / "archive" / prev_date
    perf_archive_dir.mkdir(parents=True, exist_ok=True)

    # Performance paper trade files (cumulative track records - DO NOT truncate)
    perf_trade_files = [
        ROOT / "performance" / "trend_runner_paper_trades.csv",
        ROOT / "performance" / "trend_runner_sensex_paper_trades.csv",
        ROOT / "performance" / "trend_runner_signals.csv",
        ROOT / "performance" / "trend_runner_sensex_signals.csv",
    ]
    for pfile in perf_trade_files:
        if pfile.exists() and pfile.stat().st_size > 0:
            target_dst = perf_archive_dir / f"{pfile.stem}_{prev_date}{pfile.suffix}"
            try:
                shutil.copy2(pfile, target_dst)
                archived_trades.append(f"{pfile.name} -> {target_dst.relative_to(ROOT)} (snapshotted)")
            except Exception as exc:
                logger.error(f"Error archiving {pfile.name}: {exc}")

    # Live feed paper trade files (cumulative track records - DO NOT truncate)
    live_trade_files = [
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_live_paper.csv",
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_sensex_live_paper.csv",
        ROOT / "captured_data" / "fyers" / "live" / "scalper_live_paper.csv",
        ROOT / "captured_data" / "fyers" / "live" / "paper_trades.csv",
        ROOT / "captured_data" / "fyers" / "live" / "nifty_key_levels_live_paper.csv",
        ROOT / "captured_data" / "fyers" / "live" / "sensex_key_levels_live_paper.csv",
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_live_signals.csv",
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_sensex_live_signals.csv",
    ]
    for lfile in live_trade_files:
        if lfile.exists() and lfile.stat().st_size > 0:
            target_dst = archive_trade_dir / f"{lfile.stem}_{prev_date}{lfile.suffix}"
            try:
                shutil.copy2(lfile, target_dst)
                archived_trades.append(f"{lfile.name} -> {target_dst.relative_to(ROOT)} (snapshotted)")
            except Exception as exc:
                logger.error(f"Error archiving {lfile.name}: {exc}")

    logger.info(f"✅ Step 2: Snapshotted {len(archived_trades)} trade file(s) without losing paper trade history.")

    # ---------------------------------------------------------
    # 3. CLEAR KILL SWITCH & RISK LOCK FILES
    # ---------------------------------------------------------
    logger.info("👉 Step 3: Clearing Kill Switch, Risk Locks, and Scalp Targets...")
    stop_file = ROOT / "STOP_TRADING"
    if stop_file.exists():
        try:
            stop_file.unlink(missing_ok=True)
            cleaned_locks.append("STOP_TRADING")
        except Exception as exc:
            logger.error(f"Error unlinking STOP_TRADING: {exc}")

    risk_lock_file = ROOT / "RISK_LOCK.json"
    if risk_lock_file.exists():
        try:
            risk_lock_file.unlink(missing_ok=True)
            cleaned_locks.append("RISK_LOCK.json")
        except Exception as exc:
            logger.error(f"Error unlinking RISK_LOCK.json: {exc}")

    risk_reset_file = ROOT / "RISK_RESET.json"
    if risk_reset_file.exists():
        try:
            risk_reset_file.unlink(missing_ok=True)
            cleaned_locks.append("RISK_RESET.json")
        except Exception as exc:
            logger.error(f"Error unlinking RISK_RESET.json: {exc}")

    scalp_targets_file = ROOT / "captured_data" / "kotak" / "scalp_targets.json"
    try:
        scalp_targets_file.parent.mkdir(parents=True, exist_ok=True)
        scalp_targets_file.write_text("{}", encoding="utf-8")
        cleaned_locks.append("scalp_targets.json")
    except Exception as exc:
        logger.error(f"Error resetting scalp_targets.json: {exc}")

    # Invalidate broker cache
    try:
        import broker
        broker._last_positions_cache = {}
        broker._last_positions_time = 0.0
        broker._last_positions_err_time = 0.0
        broker._last_positions_date = today
        cleaned_locks.append("broker_positions_cache")
    except Exception:
        pass

    logger.info(f"✅ Step 3: Released locks & resets: {', '.join(cleaned_locks)}")

    # ---------------------------------------------------------
    # 4. ROTATE & CLEAN LOG FILES
    # ---------------------------------------------------------
    logger.info("👉 Step 4: Rotating and cleaning log files...")
    log_dir = ROOT / "logs"
    log_archive_dir = log_dir / "archive" / ym
    log_archive_dir.mkdir(parents=True, exist_ok=True)

    # Rotate risk_guardian.log (archives and initializes fresh header)
    rg_log = log_dir / "risk_guardian.log"
    if rg_log.exists() and rg_log.stat().st_size > 50000:  # > 50 KB
        rg_archive_dst = log_archive_dir / f"risk_guardian_{prev_date}.log"
        try:
            shutil.copy2(rg_log, rg_archive_dst)
            # Reinitialize with fresh header
            rg_log.write_text(f"[{now:%Y-%m-%d %H:%M:%S}] [INFO] 🛡️ [RISK GUARDIAN] New daily session initialized for {today}.\n", encoding="utf-8")
            rotated_logs.append(f"risk_guardian.log -> {rg_archive_dst.relative_to(ROOT)}")
        except Exception as exc:
            logger.error(f"Error rotating risk_guardian.log: {exc}")

    # Move older dated logs (e.g. neo-api-client.log.2026-*) into archive
    for dated_log in log_dir.glob("*.log.20*"):
        target_dst = log_archive_dir / dated_log.name
        try:
            shutil.move(str(dated_log), str(target_dst))
            rotated_logs.append(f"{dated_log.name} -> {target_dst.relative_to(ROOT)}")
        except Exception as exc:
            logger.error(f"Error moving old log {dated_log.name}: {exc}")

    logger.info(f"✅ Step 4: Rotated {len(rotated_logs)} log file(s).")
    logger.info("=" * 75)
    logger.info(f"🎉 [MIDNIGHT CLEANUP COMPLETE] Systems refreshed and ready for {today}.")
    logger.info("=" * 75)

    return {
        "ok": True,
        "date": today,
        "archived_date": prev_date,
        "timestamp": now.strftime("%Y-%m-%d %H:%M:%S"),
        "backtest_synced": backtest_synced,
        "archived_trades": archived_trades,
        "cleaned_locks": cleaned_locks,
        "rotated_logs": rotated_logs,
        "message": f"Midnight cleanup completed successfully for {today}. Trades archived to backtests & paper archives."
    }


if __name__ == "__main__":
    res = run_midnight_cleanup()
    print(json.dumps(res, indent=2))
