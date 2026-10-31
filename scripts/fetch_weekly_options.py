#!/usr/bin/env python3
"""Fetch weekly expiry option candles (NIFTY & SENSEX) using Kotak Neo.

Outputs to standardized CSV format:
  options_data/nifty/1min/YYYY/MM/YYYY-MM-DD/{strike}/CE.csv, PE.csv, spot.csv
  options_data/sensex/1min/YYYY/MM/YYYY-MM-DD/{strike}/CE.csv, PE.csv, spot.csv
"""

from __future__ import annotations

import argparse
import calendar
import io
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import requests

from neo_auth import get_neo_client

ROOT = Path(__file__).resolve().parent.parent
IST = timezone(timedelta(hours=5, minutes=30))

CONFIG = {
    "NIFTY": {
        "spot_neosymbol": "nse_cm|Nifty 50",
        "exch_seg": "nse_fo",
        "symbol_name": "NIFTY",
        "output_dir": ROOT / "options_data" / "nifty" / "1min",
        "prefix": "NIFTY",
    },
    "SENSEX": {
        "spot_neosymbol": "bse_cm|SENSEX",
        "exch_seg": "bse_fo",
        "symbol_name": "SENSEX",
        "output_dir": ROOT / "options_data" / "sensex" / "1min",
        "prefix": "SENSEX",
    },
}

MONTH_MAP = {
    "1": 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9,
    "O": 10, "OCT": 10,
    "N": 11, "NOV": 11,
    "D": 12, "DEC": 12,
    "JAN": 1, "FEB": 2, "MAR": 3, "APR": 4, "MAY": 5, "JUN": 6,
    "JUL": 7, "AUG": 8, "SEP": 9
}


def parse_expiry_from_trdsymbol(symbol: str) -> date | None:
    """Parse expiry date from standard exchange trading symbol."""
    # Pattern 1: Weekly e.g. NIFTY26N0323000CE, SENSEX26N0675000PE
    m = re.search(r"(?:NIFTY|SENSEX)(\d{2})([1-9OND])(\d{2})", symbol)
    if m:
        yy, m_code, dd = m.groups()
        year = 2000 + int(yy)
        month = MONTH_MAP.get(m_code)
        if month:
            try:
                return date(year, month, int(dd))
            except Exception:
                pass

    # Pattern 2: Monthly e.g. NIFTY26NOV23000CE, SENSEX26DEC75000PE
    m2 = re.search(r"(?:NIFTY|SENSEX)(\d{2})([A-Z]{3})(\d{4,6})(?:CE|PE)", symbol)
    if m2:
        yy, mon_str, _ = m2.groups()
        year = 2000 + int(yy)
        month = MONTH_MAP.get(mon_str)
        if month:
            last_day = calendar.monthrange(year, month)[1]
            return date(year, month, last_day)

    return None


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
            if ts:
                rows.append({
                    "ts_raw": ts,
                    "open": float(item.get("open", 0.0)),
                    "high": float(item.get("high", 0.0)),
                    "low": float(item.get("low", 0.0)),
                    "close": float(item.get("close", 0.0)),
                    "volume": int(item.get("volume", 0)),
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


def load_scrip_master(client, exch_seg: str) -> pd.DataFrame:
    """Download and cache live scrip master from Kotak Neo."""
    cache_dir = Path.home() / ".kotak_neo" / "scrip_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    cache_file = cache_dir / f"{exch_seg}_{today_str}.csv"

    if cache_file.exists() and cache_file.stat().st_size > 1000000:
        try:
            return pd.read_csv(cache_file)
        except Exception:
            pass

    try:
        url_or_data = client.scrip_master(exchange_segment=exch_seg)
        if isinstance(url_or_data, str) and url_or_data.startswith("http"):
            resp = requests.get(url_or_data, timeout=45)
            if resp.status_code == 200:
                cache_file.write_bytes(resp.content)
                return pd.read_csv(cache_file)
    except Exception as exc:
        print(f"Could not download live scrip master: {exc}")

    # Fallback to any recent valid file in cache
    files = sorted(cache_dir.glob(f"{exch_seg}_*.csv"))
    if files:
        return pd.read_csv(files[-1])
    return pd.DataFrame()


def get_expiry_contracts(client, exch_seg: str, symbol_name: str, session: date, expiry_only: bool = False) -> list[dict]:
    """Retrieve option contracts for active weekly expiry."""
    master_df = load_scrip_master(client, exch_seg)
    if master_df is None or master_df.empty:
        return []

    sym_col = "pSymbolName" if "pSymbolName" in master_df.columns else "symbol"
    inst_col = "pInstType" if "pInstType" in master_df.columns else "inst_type"
    expiry_col = [c for c in master_df.columns if "expiry" in c.lower()]
    exp_col = expiry_col[0] if expiry_col else "expiry"

    df_filtered = master_df[(master_df[sym_col] == symbol_name)]
    if inst_col in df_filtered.columns:
        df_filtered = df_filtered[df_filtered[inst_col].isin(["OPTIDX", "IO"])]

    parsed_rows = []
    for _, row in df_filtered.iterrows():
        trd_sym = str(row.get("pTrdSymbol") or row.get("trading_symbol") or "")
        exp_date = parse_expiry_from_trdsymbol(trd_sym)

        # Fallback to column if trading symbol doesn't match
        if exp_date is None and exp_col in row and pd.notna(row[exp_col]):
            val = str(row[exp_col])
            if val.isdigit() and int(val) > 1700000000:
                exp_date = pd.to_datetime(int(val), unit="s", utc=True).tz_convert("Asia/Kolkata").date()

        if exp_date and exp_date >= session:
            parsed_rows.append((exp_date, row))

    if not parsed_rows:
        print(f"No active expiry contracts found on or after {session}")
        return []

    target_expiry = min(exp_date for exp_date, _ in parsed_rows)
    if expiry_only and target_expiry != session:
        print(f"Skipping: session {session} is not an expiry date (nearest is {target_expiry})")
        return []

    print(f"Active weekly expiry for {symbol_name} on session {session}: {target_expiry}")

    contracts = []
    for exp_date, row in parsed_rows:
        if exp_date == target_expiry:
            token = str(row.get("pSymbol") or row.get("token"))
            trd_sym = str(row.get("pTrdSymbol") or row.get("trading_symbol"))
            opt_type = str(row.get("pOptionType") or row.get("option_type") or "")
            strike_raw = row.get("dStrikePrice;") if "dStrikePrice;" in row else row.get("strike")
            strike = float(strike_raw) if pd.notna(strike_raw) else 0.0

            if strike > 1000000 and symbol_name == "SENSEX":
                strike = strike / 100.0
            elif strike > 100000 and symbol_name == "NIFTY":
                strike = strike / 100.0

            contracts.append({
                "neosymbol": f"{exch_seg}|{token}",
                "symbol": trd_sym,
                "strike": strike,
                "option_type": opt_type,
                "expiry": exp_date.isoformat(),
            })

    return contracts


def fetch_candles_with_retry(client, neosymbol: str, session_str: str, max_retries: int = 5) -> pd.DataFrame:
    """Fetch candles with rate limit handling and exponential backoff."""
    for attempt in range(max_retries):
        try:
            res = client.historical_data(
                neosymbol=neosymbol,
                interval="1min",
                from_date=session_str,
                to_date=session_str,
            )
            if isinstance(res, dict) and res.get("code") == 429:
                time.sleep(2.0 + attempt * 1.5)
                continue
            df = parse_neo_candles(res)
            if not df.empty:
                return df
        except Exception as exc:
            if "too many" in str(exc).lower():
                time.sleep(2.0 + attempt * 1.5)
            else:
                break
        time.sleep(0.5)
    return pd.DataFrame()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--index", choices=["NIFTY", "SENSEX"], required=True)
    parser.add_argument("--date", help="Session date YYYY-MM-DD (defaults to today in IST)")
    parser.add_argument("--count", type=int, default=15, help="Strikes above and below open")
    parser.add_argument("--force", action="store_true", help="Overwrite existing output file")
    parser.add_argument("--expiry-only", action="store_true", help="Only fetch if session date is an exact expiry date")
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
    spot = fetch_candles_with_retry(client, cfg["spot_neosymbol"], session_str)
    if spot.empty:
        raise SystemExit(f"No spot index candles returned for {args.index} on {session}")

    reference = float(spot.iloc[0]["open"])
    contracts = get_expiry_contracts(client, cfg["exch_seg"], cfg["symbol_name"], session, expiry_only=args.expiry_only)
    if not contracts:
        raise SystemExit(f"No active weekly contracts found for {args.index} on {session}")

    strikes = sorted({c["strike"] for c in contracts})
    below = sorted((s for s in strikes if s < reference), reverse=True)[:args.count]
    above = sorted(s for s in strikes if s >= reference)[:args.count]
    selected_strikes = set(below + above)

    selected = [c for c in contracts if c["strike"] in selected_strikes and c["option_type"] in ("CE", "PE")]
    print(f"Fetching 1-min candles for {len(selected)} option contracts around spot reference {reference}...")

    records = []
    target_expiry = contracts[0]["expiry"]
    # Spot row
    spot_out = pd.DataFrame({
        "Epoch": spot["epoch"],
        "Timestamp": spot["timestamp"],
        "InstrumentType": "INDEX",
        "Symbol": cfg["spot_neosymbol"],
        "Expiry": target_expiry,
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

    for idx, c in enumerate(selected, 1):
        opt_candles = fetch_candles_with_retry(client, c["neosymbol"], session_str)
        if opt_candles.empty:
            continue

        opt_out = pd.DataFrame({
            "Epoch": opt_candles["epoch"],
            "Timestamp": opt_candles["timestamp"],
            "InstrumentType": "OPTION",
            "Symbol": c["symbol"],
            "Expiry": c["expiry"],
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
        time.sleep(0.6)  # Rate limit respect

    df_out = pd.concat(records, ignore_index=True)
    df_out.to_csv(out_csv, index=False)
    print(f"Saved {len(df_out):,} rows to {out_csv}")

    # Partition into strike-based folders: YYYY/MM/YYYY-MM-DD/{strike}/{CE,PE}.csv
    date_dir = out_dir / session.isoformat()
    date_dir.mkdir(parents=True, exist_ok=True)

    # Save spot.csv
    if not spot_out.empty:
        spot_cols = ["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume", "Symbol"]
        spot_cols = [col for col in spot_cols if col in spot_out.columns]
        spot_out[spot_cols].to_csv(date_dir / "spot.csv", index=False)

    # Save each strike's CE.csv and PE.csv
    opt_df = df_out[df_out["InstrumentType"] == "OPTION"].copy()
    opt_cols = ["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume", "Symbol", "Expiry", "Strike", "OptionType", "IndexClose"]
    for strike in sorted(opt_df["Strike"].dropna().unique()):
        strike_val = int(strike) if float(strike).is_integer() else strike
        st_dir = date_dir / str(strike_val)
        st_dir.mkdir(parents=True, exist_ok=True)
        for opt_type in ["CE", "PE"]:
            sub = opt_df[(opt_df["Strike"] == strike) & (opt_df["OptionType"] == opt_type)].copy()
            if not sub.empty:
                sub_cols = [col for col in opt_cols if col in sub.columns]
                sub[sub_cols].to_csv(st_dir / f"{opt_type}.csv", index=False)

    print(f"Partitioned into strike folders under: {date_dir}")


if __name__ == "__main__":
    main()
