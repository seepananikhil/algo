#!/usr/bin/env python3
"""Run the midpoint strategy on a captured day's 1-min candles (offline, after the fact).

Run: python3 run_strategy_on_capture.py                 # today
     python3 run_strategy_on_capture.py --date 2026-10-05
"""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from backtest_midpoint_strategy import add_ist_time_columns, load_data
from midpoint_strategy import backtest_midpoint_strategy

LIVE_DIR = Path(__file__).resolve().parent / "captured_data" / "fyers" / "live"
MASTER_CSV = Path(__file__).resolve().parent / "captured_data" / "fyers" / "fyers_spot_1min_extended.csv"
IST = timezone(timedelta(hours=5, minutes=30))


def add_to_trade_log(csv_path: Path) -> None:
    """Append captured candles to the master OHLC file (stored in UTC), then rebuild the trade log."""
    import subprocess
    import sys

    master = pd.read_csv(MASTER_CSV)
    last_utc = pd.to_datetime(master["timestamp"]).max()
    new = pd.read_csv(csv_path)
    new["timestamp"] = (
        pd.to_datetime(new["timestamp"]).dt.tz_localize("Asia/Kolkata").dt.tz_convert("UTC").dt.tz_localize(None)
    )
    new = new[new["timestamp"] > last_utc][["timestamp", "open", "high", "low", "close", "volume"]]
    if new.empty:
        print("Trade log: no new candles to add.")
    else:
        new["timestamp"] = new["timestamp"].dt.strftime("%Y-%m-%d %H:%M:%S")
        new.to_csv(MASTER_CSV, mode="a", header=False, index=False)
        print(f"Trade log: added {len(new)} candles to {MASTER_CSV.name}")
    subprocess.run([sys.executable, str(MASTER_CSV.parents[2] / "backtest_midpoint_strategy.py")], check=True, stdout=subprocess.DEVNULL)
    print("Trade log rebuilt (trades CSV, day review, performance).")


def run(csv_path: Path, out_path: Path) -> pd.DataFrame:
    df = load_data(str(csv_path))
    trades = backtest_midpoint_strategy(df)
    if trades.empty:
        print(f"{csv_path.name}: {len(df)} candles, NO TRADE triggered.")
        pd.DataFrame().to_csv(out_path, index=False)
        return trades

    report = add_ist_time_columns(trades, input_tz="Asia/Kolkata")
    report["exit_reason"] = trades["reason"].values
    report.to_csv(out_path, index=False)

    print(f"{csv_path.name}: {len(df)} candles, {len(report)} trade(s)")
    for r in report.itertuples(index=False):
        print(
            f"  {r.option_type:<4} ENTRY {r.entry} @ {r.entry_spot}  (mid {r.mid_point}, SL {r.sl_spot}, TGT {r.target_spot})"
            f"  -> EXIT {r.exit} @ {r.exit_spot} [{r.exit_reason}]  P/L {r.profit_loss:+.2f}"
        )
    print(f"  Day P/L: {report['profit_loss'].sum():+.2f} points  ->  {out_path}")
    return trades


def main() -> None:
    parser = argparse.ArgumentParser(description="Offline strategy run on captured 1-min data")
    parser.add_argument("--date", default=datetime.now(IST).strftime("%Y-%m-%d"), help="Capture date (YYYY-MM-DD)")
    parser.add_argument("--csv", default=None, help="Override input CSV (IST timestamps)")
    parser.add_argument("--add-to-log", action="store_true", help="Also append this day to the master data and rebuild the trade log")
    args = parser.parse_args()

    csv_path = Path(args.csv) if args.csv else LIVE_DIR / f"nifty_1min_{args.date}.csv"
    if not csv_path.exists():
        raise SystemExit(f"No captured data: {csv_path}")
    run(csv_path, LIVE_DIR / f"strategy_trades_{args.date}.csv")
    if args.add_to_log:
        add_to_trade_log(csv_path)


if __name__ == "__main__":
    main()
