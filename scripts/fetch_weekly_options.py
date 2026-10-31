#!/usr/bin/env python3
"""Fetch weekly expiry option candles (NIFTY & SENSEX) using Kotak Neo.

Outputs to standardized CSV format:
  options_data/nifty/1min/YYYY/NIFTY_options_1min_YYYY-MM-DD.csv
  options_data/sensex/1min/YYYY/SENSEX_options_1min_YYYY-MM-DD.csv
"""

from __future__ import annotations

import argparse
import json
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd

from neo_auth import get_neo_client

ROOT = Path(__file__).resolve().parent.parent
IST = timezone(timedelta(hours=5, minutes=30))

CONFIG = {
    "NIFTY": {
        "spot_neosymbol": "nse_cm|26000",
        "exch_seg": "nse_fo",
        "symbol_name": "NIFTY",
        "output_dir": ROOT / "options_data" / "nifty" / "1min",
        "prefix": "NIFTY",
    },
    "SENSEX": {
        "spot_neosymbol": "bse_cm|1",
        "exch_seg": "bse_fo",
        "symbol_name": "SENSEX",
        "output_dir": ROOT / "options_data" / "sensex" / "1min",
        "prefix": "SENSEX",
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
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),
                "volume": int(item[5]) if len(item) > 5 else 0,
            })
        elif isinstance(item, dict):
            ts = item.get("time") or item.get("timestamp") or item.get("date") or item.get("datetime")
            rows.append({
                "ts_raw": ts,
                "open": float(item.get("open") or item.get("Open") or 0.0),
                "high": float(item.get("high") or item.get("High") or 0.0),
                "low": float(item.get("low") or item.get("Low") or 0.0),
                "close": float(item.get("close") or item.get("Close") or 0.0),
                "volume": int(item.get("volume") or item.get("Volume") or 0),
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

    df["epoch"] = dt.astype("int64") // 10**9
    df["timestamp"] = dt.dt.strftime("%Y-%m-%dT%H:%M:%S")
    return df.drop_duplicates("epoch").sort_values("epoch").reset_index(drop=True)


def get_expiry_contracts(client, exch_seg: str, symbol_name: str, session: date) -> list[dict]:
    """Retrieve option contracts matching the underlying and session expiry date."""
    # Try reading from scrip_master
    cache_dir = Path.home() / ".kotak_neo" / "scrip_cache"
    master_df = None

    if cache_dir.exists():
        files = list(cache_dir.glob(f"{exch_seg}_*.csv"))
        if files:
            latest_file = max(files, key=lambda f: f.stat().st_mtime)
            try:
                master_df = pd.read_csv(latest_file)
            except Exception:
                pass

    if master_df is None:
        try:
            client.scrip_master(exchange_segment=exch_seg)
            files = list(cache_dir.glob(f"{exch_seg}_*.csv"))
            if files:
                latest_file = max(files, key=lambda f: f.stat().st_mtime)
                master_df = pd.read_csv(latest_file)
        except Exception as exc:
            print(f"Could not load scrip_master: {exc}")
            return []

    if master_df is None or master_df.empty:
        return []

    # Filter for OPTIDX and matching underlying
    sym_col = "pSymbolName" if "pSymbolName" in master_df.columns else "symbol"
    inst_col = "pInstType" if "pInstType" in master_df.columns else "inst_type"
    expiry_col = "lExpiryDate " if "lExpiryDate " in master_df.columns else ("pExpiryDate" if "pExpiryDate" in master_df.columns else "expiry")

    df_filtered = master_df[(master_df[sym_col] == symbol_name)]
    if inst_col in df_filtered.columns:
        df_filtered = df_filtered[df_filtered[inst_col] == "OPTIDX"]

    contracts = []
    for _, row in df_filtered.iterrows():
        exp_raw = row.get(expiry_col)
        if pd.isna(exp_raw):
            continue
        try:
            if str(exp_raw).isdigit():
                exp_date = pd.to_datetime(int(exp_raw), unit="s", utc=True).tz_convert("Asia/Kolkata").date()
            else:
                exp_date = pd.to_datetime(exp_raw).date()
        except Exception:
            continue

        if exp_date == session:
            token = str(row.get("pSymbol") or row.get("token"))
            trd_sym = str(row.get("pTrdSymbol") or row.get("trading_symbol"))
            opt_type = str(row.get("pOptionType") or row.get("option_type") or "")
            strike_raw = row.get("dStrikePrice;") if "dStrikePrice;" in row else row.get("strike")
            strike = float(strike_raw) if pd.notna(strike_raw) else 0.0

            # Normalize strike if precision offset
            if strike > 100000 and symbol_name == "NIFTY":
                strike = strike / 100.0

            contracts.append({
                "neosymbol": f"{exch_seg}|{token}",
                "symbol": trd_sym,
                "strike": strike,
                "option_type": opt_type,
            })

    return contracts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", choices=["NIFTY", "SENSEX"], required=True)
    parser.add_argument("--date", help="Session date YYYY-MM-DD (defaults to today in IST)")
    parser.add_argument("--count", type=int, default=15, help="Strikes above and below open")
    parser.add_argument("--force", action="store_true", help="Overwrite existing output file")
    args = parser.parse_args()

    cfg = CONFIG[args.index]
    session = date.fromisoformat(args.date) if args.date else datetime.now(IST).date()
    year_str = str(session.year)
    month_str = f"{session.month:02d}"
    out_dir = cfg["output_dir"] / year_str / month_str
    out_dir.mkdir(parents=True, exist_ok=True)
    out_csv = out_dir / f"{cfg['prefix']}_options_1min_{session.isoformat()}.csv"

    if out_csv.exists() and not args.force:
        print(f"File already exists: {out_csv} (use --force to overwrite)")
        return

    client = get_neo_client()
    if client is None:
        return

    # Fetch spot index
    session_str = session.isoformat()
    spot_raw = client.historical_data(
        neosymbol=cfg["spot_neosymbol"],
        interval="1min",
        from_date=session_str,
        to_date=session_str,
    )
    spot = parse_neo_candles(spot_raw)
    if spot.empty:
        raise SystemExit(f"No spot index candles returned for {args.index} on {session}")

    reference = float(spot.iloc[0]["open"])
    contracts = get_expiry_contracts(client, cfg["exch_seg"], cfg["symbol_name"], session)
    if not contracts:
        raise SystemExit(f"No expiry contracts found for {args.index} on {session}")

    strikes = sorted({c["strike"] for c in contracts})
    below = sorted((s for s in strikes if s < reference), reverse=True)[:args.count]
    above = sorted(s for s in strikes if s >= reference)[:args.count]
    selected_strikes = set(below + above)

    selected = [c for c in contracts if c["strike"] in selected_strikes and c["option_type"] in ("CE", "PE")]

    records = []
    # Index spot row
    spot_out = pd.DataFrame({
        "Epoch": spot["epoch"],
        "Timestamp": spot["timestamp"],
        "InstrumentType": "INDEX",
        "Symbol": cfg["spot_neosymbol"],
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

    for c in selected:
        opt_raw = client.historical_data(
            neosymbol=c["neosymbol"],
            interval="1min",
            from_date=session_str,
            to_date=session_str,
        )
        opt_candles = parse_neo_candles(opt_raw)
        if opt_candles.empty:
            continue

        opt_out = pd.DataFrame({
            "Epoch": opt_candles["epoch"],
            "Timestamp": opt_candles["timestamp"],
            "InstrumentType": "OPTION",
            "Symbol": c["symbol"],
            "Expiry": session.isoformat(),
            "OptionType": c["option_type"],
            "Strike": c["strike"],
            "SpotRef": reference,
            "IndexClose": opt_candles["epoch"].map(spot_close_map),
            "Open": opt_candles["open"],
            "High": opt_candles["high"],
            "Low": opt_candles["low"],
            "Close": opt_candles["close"],
            "Volume": opt_candles["volume"],
            "DuplicateCount": 1,
        })
        records.append(opt_out)
        time.sleep(0.1)

    df_out = pd.concat(records, ignore_index=True)
    df_out.to_csv(out_csv, index=False)
    print(f"Saved {len(df_out):,} rows to {out_csv}")


if __name__ == "__main__":
    main()
