#!/usr/bin/env python3
"""Daily update script for NIFTY50 and SENSEX spot historical data.

Appends today's 1-minute candles to the current month's CSV in historical_data:
  historical_data/nifty50/1min/YYYY/NIFTY50_1min_YYYY-MM.csv
  historical_data/sensex/1min/YYYY/SENSEX_1min_YYYY-MM.csv
"""

from __future__ import annotations

import argparse
import subprocess
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from fyers_headless_auth import get_authenticated_client

ROOT = Path(__file__).resolve().parent.parent
IST = timezone(timedelta(hours=5, minutes=30))

INDICES = {
    "NIFTY50": {
        "symbol": "NSE:NIFTY50-INDEX",
        "dir": ROOT / "historical_data" / "nifty50",
        "file_prefix": "NIFTY50_1min_",
    },
    "SENSEX": {
        "symbol": "BSE:SENSEX-INDEX",
        "dir": ROOT / "historical_data" / "sensex",
        "file_prefix": "SENSEX_1min_",
    },
}


def update_index_for_date(client, index_name: str, session: date) -> None:
    cfg = INDICES[index_name]
    response = client.history(data={
        "symbol": cfg["symbol"],
        "resolution": "1",
        "date_format": "1",
        "range_from": session.isoformat(),
        "range_to": session.isoformat(),
        "cont_flag": "1",
    })

    candles = response.get("candles") or []
    if not candles:
        print(f"No candles found for {index_name} on {session}")
        return

    year_str = str(session.year)
    month_str = f"{session.year:04d}-{session.month:02d}"
    target_dir = cfg["dir"] / "1min" / year_str
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / f"{cfg['file_prefix']}{month_str}.csv"

    new_df = pd.DataFrame(candles, columns=["Epoch", "Open", "High", "Low", "Close", "Volume"])
    new_df["Timestamp"] = (
        pd.to_datetime(new_df["Epoch"], unit="s", utc=True)
        .dt.tz_convert("Asia/Kolkata")
        .dt.strftime("%Y-%m-%dT%H:%M:%S")
    )
    new_df = new_df[["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume"]]

    if target_file.exists():
        existing = pd.read_csv(target_file)
        combined = pd.concat([existing, new_df], ignore_index=True)
        combined = combined.drop_duplicates(subset=["Epoch"], keep="last").sort_values("Epoch")
    else:
        combined = new_df.sort_values("Epoch")

    combined.to_csv(target_file, index=False)
    print(f"Updated {target_file} (Total rows: {len(combined):,})")

    # Build Parquet if DuckDB is installed
    sql_script = cfg["dir"] / "scripts" / "build_parquet.sql"
    if sql_script.exists():
        try:
            subprocess.run(["duckdb", "-c", f".read {sql_script}"], cwd=cfg["dir"], check=False)
            print(f"Rebuilt Parquet files for {index_name}")
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", help="Session date YYYY-MM-DD (default: today in IST)")
    args = parser.parse_args()

    session = date.fromisoformat(args.date) if args.date else datetime.now(IST).date()
    client = get_authenticated_client()

    for name in INDICES:
        update_index_for_date(client, name, session)


if __name__ == "__main__":
    main()
