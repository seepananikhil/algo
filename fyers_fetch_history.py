#!/usr/bin/env python3
"""Extend the NIFTY 1-minute master history backwards from Fyers.

Run: python3 fyers_fetch_history.py --years 3
Master file stores timestamps in UTC (03:45 = 09:15 IST); a backup is written before merging.
"""

from __future__ import annotations

import argparse
import json
import shutil
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from fyers_apiv3 import fyersModel

ROOT = Path(__file__).resolve().parent
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
MASTER = ROOT / "captured_data" / "fyers" / "fyers_spot_1min_extended.csv"
SYMBOL = "NSE:NIFTY50-INDEX"
CHUNK_DAYS = 90  # Fyers allows up to 100 days per 1-minute request


def client() -> fyersModel.FyersModel:
    tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    fy = fyersModel.FyersModel(client_id=tok["app_id"], token=tok["access_token"], is_async=False, log_path="/tmp")
    if fy.get_profile().get("s") != "ok":
        raise SystemExit("Fyers token invalid/expired. Log in first (dashboard -> Fyers, or python3 fyers_daily_login.py auto).")
    return fy


def fetch(fy, start: date, end: date) -> pd.DataFrame:
    for attempt in range(3):
        r = fy.history(data={
            "symbol": SYMBOL, "resolution": "1", "date_format": "1",
            "range_from": start.isoformat(), "range_to": end.isoformat(), "cont_flag": "1",
        })
        if r.get("s") in ("ok", "no_data"):
            break
        print(f"  {start}..{end}: {r.get('code')} {r.get('message')} (retry {attempt + 1})")
        time.sleep(2 * (attempt + 1))
    else:
        raise SystemExit(f"Fyers history failed for {start}..{end}")
    rows = r.get("candles") or []
    out = pd.DataFrame(rows, columns=["epoch", "open", "high", "low", "close", "volume"])
    out["timestamp"] = pd.to_datetime(out["epoch"], unit="s", utc=True).dt.tz_localize(None)
    return out[["timestamp", "open", "high", "low", "close", "volume"]]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--years", type=float, default=3, help="how far back from today to go")
    args = ap.parse_args()

    master = pd.read_csv(MASTER, parse_dates=["timestamp"])
    oldest = master["timestamp"].min().date()
    stop_at = (datetime.now(timezone.utc) - timedelta(days=int(args.years * 365))).date()
    print(f"Master: {len(master):,} rows, {oldest} .. {master['timestamp'].max().date()}. Fetching back to {stop_at}.")

    fy = client()
    parts, end, empty_chunks = [], oldest - timedelta(days=1), 0
    while end > stop_at:
        start = max(stop_at, end - timedelta(days=CHUNK_DAYS - 1))
        chunk = fetch(fy, start, end)
        days = chunk["timestamp"].dt.date.nunique()
        print(f"  {start} .. {end}: {len(chunk):,} candles, {days} days")
        if chunk.empty:
            empty_chunks += 1
            if empty_chunks >= 2:
                print("  No more data available from Fyers.")
                break
        else:
            empty_chunks = 0
            parts.append(chunk)
        end = start - timedelta(days=1)
        time.sleep(0.4)

    if not parts:
        print("Nothing new fetched.")
        return
    backup = MASTER.with_name(f"{MASTER.stem}.backup_{datetime.now():%Y%m%d_%H%M%S}.csv")
    shutil.copy2(MASTER, backup)
    merged = (pd.concat([master, *parts]).drop_duplicates("timestamp", keep="last")
              .sort_values("timestamp").reset_index(drop=True))
    merged.to_csv(MASTER, index=False, date_format="%Y-%m-%d %H:%M:%S")
    print(f"Backup: {backup.name}")
    print(f"Master now: {len(merged):,} rows, {merged['timestamp'].min().date()} .. {merged['timestamp'].max().date()}, "
          f"{merged['timestamp'].dt.date.nunique()} trading days")


if __name__ == "__main__":
    main()
