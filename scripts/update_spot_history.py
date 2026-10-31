#!/usr/bin/env python3
"""Daily update script for NIFTY50 and SENSEX spot historical data using Kotak Neo.

Updates both daily 1-minute session CSVs and consolidated master daily OHLC CSVs:
  - historical_data/{index}/1min/YYYY/{INDEX}_1min_YYYY-MM-DD.csv
  - historical_data/{index}/daily/{INDEX}_daily.csv
  - Rebuilds Parquet files via DuckDB including {INDEX}_daily.parquet
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
        "daily_file": "NIFTY50_daily.csv",
    },
    "SENSEX": {
        "neosymbol": "bse_cm|1",
        "dir": ROOT / "historical_data" / "sensex",
        "file_prefix": "SENSEX_1min_",
        "daily_file": "SENSEX_daily.csv",
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
    if pd.api.types.is_numeric_dtype(df["ts_raw"]):
        sample = df["ts_raw"].iloc[0]
        unit = "ms" if sample > 1e11 else "s"
        dt = pd.to_datetime(df["ts_raw"], unit=unit, utc=True).dt.tz_convert("Asia/Kolkata")
    else:
        dt = pd.to_datetime(df["ts_raw"]).dt.tz_localize("Asia/Kolkata") if pd.to_datetime(df["ts_raw"]).dt.tz is None else pd.to_datetime(df["ts_raw"]).dt.tz_convert("Asia/Kolkata")

    df["Epoch"] = (dt.astype("int64") // 10**9)
    df["Timestamp"] = dt.dt.strftime("%Y-%m-%dT%H:%M:%S")
    return df[["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume"]].drop_duplicates("Epoch").sort_values("Epoch").reset_index(drop=True)


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

    # 1. Save Clean Daily 1-Minute CSV File (One file per trading session)
    year_str = str(session.year)
    target_dir = cfg["dir"] / "1min" / year_str
    target_dir.mkdir(parents=True, exist_ok=True)
    target_file = target_dir / f"{cfg['file_prefix']}{from_date}.csv"

    new_df.to_csv(target_file, index=False)
    print(f"Saved daily 1-min file: {target_file} ({len(new_df):,} candles)")

    # 2. Update Consolidated Master Daily OHLC CSV
    daily_dir = cfg["dir"] / "daily"
    daily_dir.mkdir(parents=True, exist_ok=True)
    daily_file = daily_dir / cfg["daily_file"]

    daily_bar = pd.DataFrame([{
        "Epoch": int(new_df.iloc[0]["Epoch"]),
        "Date": from_date,
        "Open": float(new_df.iloc[0]["Open"]),
        "High": float(new_df["High"].max()),
        "Low": float(new_df["Low"].min()),
        "Close": float(new_df.iloc[-1]["Close"]),
        "Volume": int(new_df["Volume"].sum()),
    }])

    if daily_file.exists():
        existing_daily = pd.read_csv(daily_file)
        combined_daily = pd.concat([existing_daily, daily_bar], ignore_index=True)
        combined_daily = combined_daily.drop_duplicates(subset=["Date"], keep="last").sort_values("Date")
    else:
        combined_daily = daily_bar

    combined_daily.to_csv(daily_file, index=False)
    print(f"Updated master daily OHLC: {daily_file} (Total daily bars: {len(combined_daily):,})")

    # 3. Rebuild Parquet files with DuckDB if available
    sql_script = cfg["dir"] / "scripts" / "build_parquet.sql"
    if sql_script.exists():
        try:
            subprocess.run(["duckdb", "-c", f".read {sql_script}"], cwd=cfg["dir"], check=False)
            print(f"Rebuilt Parquet files (including daily) for {index_name}")
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
