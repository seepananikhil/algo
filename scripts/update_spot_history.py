#!/usr/bin/env python3
"""Daily update script for NIFTY50 and SENSEX spot historical data using Kotak Neo.

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

from neo_auth import get_neo_client

ROOT = Path(__file__).resolve().parent.parent
IST = timezone(timedelta(hours=5, minutes=30))

INDICES = {
    "NIFTY50": {
        "neosymbol": "nse_cm|26000",
        "dir": ROOT / "historical_data" / "nifty50",
        "file_prefix": "NIFTY50_1min_",
    },
    "SENSEX": {
        "neosymbol": "bse_cm|1",
        "dir": ROOT / "historical_data" / "sensex",
        "file_prefix": "SENSEX_1min_",
    },
}


def parse_neo_candles(res: dict | list) -> pd.DataFrame:
    """Parse candles from Kotak Neo historical data response into a standardized DataFrame."""
    if not res:
        return pd.DataFrame()

    raw_items = []
    if isinstance(res, dict):
        raw_items = res.get("data") or res.get("result") or res.get("candles") or []
        if isinstance(raw_items, dict):
            raw_items = raw_items.get("candles") or []
    elif isinstance(res, list):
        raw_items = res

    if not raw_items:
        return pd.DataFrame()

    rows = []
    for item in raw_items:
        if isinstance(item, list) and len(item) >= 5:
            # Format: [timestamp/epoch, open, high, low, close, volume]
            rows.append({
                "ts_raw": item[0],
                "Open": float(item[1]),
                "High": float(item[2]),
                "Low": float(item[3]),
                "Close": float(item[4]),
                "Volume": int(item[5]) if len(item) > 5 else 0,
            })
        elif isinstance(item, dict):
            ts = item.get("time") or item.get("timestamp") or item.get("date") or item.get("datetime")
            rows.append({
                "ts_raw": ts,
                "Open": float(item.get("open") or item.get("Open") or 0.0),
                "High": float(item.get("high") or item.get("High") or 0.0),
                "Low": float(item.get("low") or item.get("Low") or 0.0),
                "Close": float(item.get("close") or item.get("Close") or 0.0),
                "Volume": int(item.get("volume") or item.get("Volume") or 0),
            })

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(rows)
    # Convert ts_raw to Epoch and Timestamp (IST)
    if pd.api.types.is_numeric_dtype(df["ts_raw"]):
        # Epoch seconds or milliseconds
        sample = df["ts_raw"].iloc[0]
        unit = "ms" if sample > 1e11 else "s"
        dt = pd.to_datetime(df["ts_raw"], unit=unit, utc=True).dt.tz_convert("Asia/Kolkata")
    else:
        dt = pd.to_datetime(df["ts_raw"]).dt.tz_localize("Asia/Kolkata") if pd.to_datetime(df["ts_raw"]).dt.tz is None else pd.to_datetime(df["ts_raw"]).dt.tz_convert("Asia/Kolkata")

    df["Epoch"] = (dt.astype("int64") // 10**9)
    df["Timestamp"] = dt.dt.strftime("%Y-%m-%dT%H:%M:%S")
    return df[["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume"]]


def update_index_for_date(client, index_name: str, session: date) -> None:
    cfg = INDICES[index_name]
    from_date = session.strftime("%Y-%m-%d")
    to_date = session.strftime("%Y-%m-%d")

    try:
        response = client.historical_data(
            neosymbol=cfg["neosymbol"],
            interval="1min",
            from_date=from_date,
            to_date=to_date,
        )
    except Exception as exc:
        print(f"Error fetching {index_name} from Kotak Neo: {exc}")
        return

    new_df = parse_neo_candles(response)
    if new_df.empty:
        print(f"No candles returned for {index_name} on {session}")
        return

    year_str = str(session.year)
    month_str = f"{session.year:04d}-{session.month:02d}"
    target_dir = cfg["dir"] / "1min" / year_str
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / f"{cfg['file_prefix']}{month_str}.csv"

    if target_file.exists():
        existing = pd.read_csv(target_file)
        combined = pd.concat([existing, new_df], ignore_index=True)
        combined = combined.drop_duplicates(subset=["Epoch"], keep="last").sort_values("Epoch")
    else:
        combined = new_df.sort_values("Epoch")

    combined.to_csv(target_file, index=False)
    print(f"Updated {target_file} (Total rows: {len(combined):,})")

    # Rebuild Parquet files with DuckDB if available
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
    client = get_neo_client()
    if client is None:
        return

    for name in INDICES:
        update_index_for_date(client, name, session)


if __name__ == "__main__":
    main()
