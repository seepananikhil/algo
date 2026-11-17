#!/usr/bin/env python3
"""
Sync closed intraday paper & live trades directly into master backtests at EOD.
Ensures that after market close (15:15 - 15:30 IST), the Backtest page reflects
the day's actual trades immediately without waiting for third-party repo updates.
"""

from pathlib import Path
from datetime import datetime
import pandas as pd
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent

def sync_eod_trades():
    print("=" * 70)
    print(" Syncing EOD Paper/Live Trades into Master Backtests")
    print("=" * 70)
    updated_nifty = False
    updated_sensex = False

    # 1. NIFTY
    bt_nifty_file = ROOT / "performance" / "nifty_10y_backtest_trades.csv"
    pt_nifty_file = ROOT / "performance" / "trend_runner_paper_trades.csv"
    if bt_nifty_file.exists() and pt_nifty_file.exists():
        bt_df = pd.read_csv(bt_nifty_file)
        pt_df = pd.read_csv(pt_nifty_file)
        pt_closed = pt_df[pt_df["exit_time"].notna() & (pt_df["exit_time"].astype(str).str.strip() != "")].copy()
        if not pt_closed.empty:
            cols = [c for c in bt_df.columns if c in pt_closed.columns]
            pt_subset = pt_closed[cols].copy()
            pt_subset["date"] = pd.to_datetime(pt_subset["date"]).dt.strftime("%Y-%m-%d")
            bt_df["date"] = pd.to_datetime(bt_df["date"]).dt.strftime("%Y-%m-%d")

            merged = pd.concat([bt_df, pt_subset], ignore_index=True)
            merged.drop_duplicates(subset=["date", "trade_num", "entry_time"], keep="last", inplace=True)
            merged.sort_values(by=["date", "trade_num", "entry_time"], inplace=True)
            merged.reset_index(drop=True, inplace=True)
            merged.to_csv(bt_nifty_file, index=False)

            vix_file = ROOT / "performance" / "vix_trend_runner_trades.csv"
            shutil.copy2(bt_nifty_file, vix_file)
            print(f"[Nifty] Synced {len(pt_subset)} EOD trades into backtest.")
            updated_nifty = True

    # 2. SENSEX
    bt_sensex_file = ROOT / "performance" / "sensex_backtest_trades.csv"
    pt_sensex_file = ROOT / "performance" / "trend_runner_sensex_paper_trades.csv"
    if bt_sensex_file.exists() and pt_sensex_file.exists():
        bt_s_df = pd.read_csv(bt_sensex_file)
        pt_s_df = pd.read_csv(pt_sensex_file)
        pt_s_closed = pt_s_df[pt_s_df["exit_time"].notna() & (pt_s_df["exit_time"].astype(str).str.strip() != "")].copy()
        if not pt_s_closed.empty:
            cols_s = [c for c in bt_s_df.columns if c in pt_s_closed.columns]
            pt_s_subset = pt_s_closed[cols_s].copy()
            pt_s_subset["date"] = pd.to_datetime(pt_s_subset["date"]).dt.strftime("%Y-%m-%d")
            bt_s_df["date"] = pd.to_datetime(bt_s_df["date"]).dt.strftime("%Y-%m-%d")

            merged_s = pd.concat([bt_s_df, pt_s_subset], ignore_index=True)
            merged_s.drop_duplicates(subset=["date", "trade_num", "entry_time"], keep="last", inplace=True)
            merged_s.sort_values(by=["date", "trade_num", "entry_time"], inplace=True)
            merged_s.reset_index(drop=True, inplace=True)
            merged_s.to_csv(bt_sensex_file, index=False)
            print(f"[Sensex] Synced {len(pt_s_subset)} EOD trades into backtest.")
            updated_sensex = True

    # 3. Update Master Portfolio (Apex Duo)
    if updated_nifty or updated_sensex:
        master_script = ROOT / "scripts" / "run_master_portfolio_backtest.py"
        if master_script.exists():
            subprocess.run([sys.executable, str(master_script), "--symbol", "nifty"], capture_output=True)
            subprocess.run([sys.executable, str(master_script), "--symbol", "sensex"], capture_output=True)
            print("[Master Portfolio] Apex Duo backtests refreshed with EOD trades.")
    print("EOD trade sync completed successfully.\n")

if __name__ == "__main__":
    sync_eod_trades()
