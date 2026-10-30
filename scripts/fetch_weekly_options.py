#!/usr/bin/env python3
"""Fetch weekly expiry option candles (NIFTY & SENSEX) into standardized CSV format.

Example:
  python scripts/fetch_weekly_options.py --index NIFTY --date 2026-10-15
  python scripts/fetch_weekly_options.py --index SENSEX --date 2026-10-08
"""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from fyers_headless_auth import get_authenticated_client

ROOT = Path(__file__).resolve().parent.parent
IST = timezone(timedelta(hours=5, minutes=30))

INDEX_CONFIG = {
    "NIFTY": {
        "spot_symbol": "NSE:NIFTY50-INDEX",
        "fo_master_url": "https://public.fyers.in/sym_details/NSE_FO.csv",
        "underlying": "NIFTY",
        "output_dir": ROOT / "options_data" / "nifty" / "1min",
        "prefix": "NIFTY",
    },
    "SENSEX": {
        "spot_symbol": "BSE:SENSEX-INDEX",
        "fo_master_url": "https://public.fyers.in/sym_details/BSE_FO.csv",
        "underlying": "SENSEX",
        "output_dir": ROOT / "options_data" / "sensex" / "1min",
        "prefix": "SENSEX",
    },
}


def fetch_candles(client, symbol: str, session: date) -> pd.DataFrame:
    response = client.history(data={
        "symbol": symbol,
        "resolution": "1",
        "date_format": "1",
        "range_from": session.isoformat(),
        "range_to": session.isoformat(),
        "cont_flag": "1",
    })
    if response.get("s") == "no_data":
        return pd.DataFrame()
    if response.get("s") != "ok":
        raise RuntimeError(f"History failed for {symbol}: {response.get('code')} {response.get('message')}")
    frame = pd.DataFrame(response.get("candles") or [], columns=["epoch", "open", "high", "low", "close", "volume"])
    if frame.empty:
        return frame
    frame["timestamp_utc"] = pd.to_datetime(frame["epoch"], unit="s", utc=True)
    frame = frame[frame["timestamp_utc"].dt.date == session]
    frame = frame.drop_duplicates("epoch", keep="last")
    return frame.sort_values("epoch").reset_index(drop=True)


def get_expiry_contracts(master_url: str, underlying: str, session: date) -> list[dict]:
    master = pd.read_csv(master_url, header=None, dtype=str)
    expiry_epoch = pd.to_numeric(master[8], errors="coerce")
    expiry_ist = pd.to_datetime(expiry_epoch, unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.date
    rows = master[(master[13] == underlying) & (expiry_ist == session) & master[16].isin(("CE", "PE"))]
    contracts = []
    for row in rows.itertuples(index=False, name=None):
        contracts.append({
            "symbol": str(row[9]),
            "lot_size": int(float(row[3])) if row[3] else 0,
            "strike": float(row[15]),
            "option_type": str(row[16]),
        })
    return contracts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", choices=["NIFTY", "SENSEX"], required=True, help="Index to fetch")
    parser.add_argument("--date", help="Session date YYYY-MM-DD (defaults to today in IST)")
    parser.add_argument("--count", type=int, default=15, help="Strikes above and below the open")
    parser.add_argument("--force", action="store_true", help="Overwrite existing output file")
    args = parser.parse_args()

    cfg = INDEX_CONFIG[args.index]
    session = date.fromisoformat(args.date) if args.date else datetime.now(IST).date()
    year_str = str(session.year)
    out_dir = cfg["output_dir"] / year_str
    out_dir.mkdir(parents=True, exist_ok=True)
    out_csv = out_dir / f"{cfg['prefix']}_options_1min_{session.isoformat()}.csv"

    if out_csv.exists() and not args.force:
        print(f"File already exists: {out_csv} (use --force to overwrite)")
        return

    client = get_authenticated_client()
    spot = fetch_candles(client, cfg["spot_symbol"], session)
    if spot.empty:
        raise SystemExit(f"No spot index candles found for {args.index} on {session}")

    reference = float(spot.iloc[0]["open"])
    contracts = get_expiry_contracts(cfg["fo_master_url"], cfg["underlying"], session)
    if not contracts:
        raise SystemExit(f"No expiry contracts found for {args.index} on {session}")

    strikes = sorted({c["strike"] for c in contracts})
    below = sorted((s for s in strikes if s < reference), reverse=True)[:args.count]
    above = sorted(s for s in strikes if s >= reference)[:args.count]
    selected_strikes = set(below + above)

    calls = [c for c in contracts if c["option_type"] == "CE" and c["strike"] in selected_strikes]
    puts = [c for c in contracts if c["option_type"] == "PE" and c["strike"] in selected_strikes]
    selected = calls + puts

    records = []
    spot_ts = spot["timestamp_utc"].dt.tz_convert("Asia/Kolkata").dt.strftime("%Y-%m-%dT%H:%M:%S")
    spot_out = pd.DataFrame({
        "Epoch": spot["epoch"],
        "Timestamp": spot_ts,
        "InstrumentType": "INDEX",
        "Symbol": cfg["spot_symbol"],
        "Expiry": session.isoformat(),
        "OptionType": "",
        "Strike": None,
        "SpotRef": reference,
        "IndexClose": spot["close"],
        "Open": spot["open"],
        "High": spot["high"],
        "Low": spot["low"],
        "Close": spot["close"],
        "Volume": spot["volume"],
        "DuplicateCount": 1,
    })
    records.append(spot_out)

    spot_close_map = spot.set_index("epoch")["close"].to_dict()

    for idx, c in enumerate(selected):
        candles = fetch_candles(client, c["symbol"], session)
        if candles.empty:
            continue
        ts_ist = candles["timestamp_utc"].dt.tz_convert("Asia/Kolkata").dt.strftime("%Y-%m-%dT%H:%M:%S")
        opt_out = pd.DataFrame({
            "Epoch": candles["epoch"],
            "Timestamp": ts_ist,
            "InstrumentType": "OPTION",
            "Symbol": c["symbol"],
            "Expiry": session.isoformat(),
            "OptionType": c["option_type"],
            "Strike": c["strike"],
            "SpotRef": reference,
            "IndexClose": candles["epoch"].map(spot_close_map),
            "Open": candles["open"],
            "High": candles["high"],
            "Low": candles["low"],
            "Close": candles["close"],
            "Volume": candles["volume"],
            "DuplicateCount": 1,
        })
        records.append(opt_out)
        time.sleep(0.15)

    df_out = pd.concat(records, ignore_index=True)
    df_out.to_csv(out_csv, index=False)
    print(f"Saved {len(df_out):,} rows to {out_csv}")


if __name__ == "__main__":
    main()
