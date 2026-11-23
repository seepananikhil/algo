#!/usr/bin/env python3
"""Recover authentic 1-minute options data for November 2026 from Kotak Neo.

Downloads 1-minute candles for active weekly/monthly contracts and saves them
into standardized CSV directories and DuckDB parquet catalogs.
"""

import datetime
import os
import sys
import time
from pathlib import Path
import pandas as pd
import pytz

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import kotak_orders

IST = pytz.timezone("Asia/Kolkata")

CONFIG = {
    "NIFTY": {
        "spot_neosymbol": "nse_cm|Nifty 50",
        "exch_seg": "nse_fo",
        "symbol_name": "NIFTY",
        "output_dir": ROOT / "options_data" / "nifty" / "1min" / "2026" / "11",
        "prefix": "NIFTY",
        "lot_size": 25,
        "scrip_file": Path.home() / ".kotak_neo" / "scrip_cache" / "nse_fo_2026-11-23.csv",
    },
    "SENSEX": {
        "spot_neosymbol": "bse_cm|SENSEX",
        "exch_seg": "bse_fo",
        "symbol_name": "SENSEX",
        "output_dir": ROOT / "options_data" / "sensex" / "1min" / "2026" / "11",
        "prefix": "SENSEX",
        "lot_size": 20,
        "scrip_file": Path.home() / ".kotak_neo" / "scrip_cache" / "bse_fo_2026-11-23.csv",
    },
}

_last_request_time = 0.0

def rate_limit():
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < 1.25:
        time.sleep(1.25 - elapsed)
    _last_request_time = time.time()

def parse_candles(res: dict) -> pd.DataFrame:
    if not isinstance(res, dict):
        return pd.DataFrame()
    raw = res.get("data", {}).get("candles", [])
    if not raw:
        return pd.DataFrame()
    rows = []
    for r in raw:
        if len(r) >= 5:
            dt_str = r[0]
            dt = pd.to_datetime(dt_str)
            if dt.tz is None:
                dt = dt.tz_localize(IST)
            else:
                dt = dt.tz_convert(IST)
            rows.append({
                "Epoch": int(dt.timestamp()),
                "Timestamp": dt.strftime("%Y-%m-%dT%H:%M:%S"),
                "Open": float(r[1]),
                "High": float(r[2]),
                "Low": float(r[3]),
                "Close": float(r[4]),
                "Volume": int(r[5]) if len(r) > 5 else 0,
            })
    return pd.DataFrame(rows)

def fetch_candles_safe(client, neosymbol: str, from_date: str, to_date: str) -> pd.DataFrame:
    for attempt in range(4):
        rate_limit()
        try:
            res = client.historical_data(
                neosymbol=neosymbol,
                interval="1min",
                from_date=from_date,
                to_date=to_date,
            )
            if isinstance(res, dict) and res.get("code") == 429:
                time.sleep(3.5)
                continue
            df = parse_candles(res)
            if not df.empty:
                return df
            time.sleep(0.5)
        except Exception as e:
            if "429" in str(e):
                time.sleep(3.5)
            else:
                time.sleep(1.5)
    return pd.DataFrame()

def run_recovery():
    client = kotak_orders.get_kotak_client()
    if not client:
        print("Failed to initialize Kotak Neo client.")
        return

    status = kotak_orders.kotak_token_status()
    if not status.get("valid"):
        print("Kotak Neo token invalid. Attempting login...")
        login_res = kotak_orders.kotak_login()
        if not login_res.get("ok"):
            print("Login failed:", login_res)
            return

    # Prioritize Today (23-Nov) and 17-Nov first, then previous sessions
    dates_to_recover = [
        "2026-11-23", "2026-11-17", "2026-11-20", "2026-11-19",
        "2026-11-18", "2026-11-16", "2026-11-13", "2026-11-12"
    ]

    for index_key in ["SENSEX", "NIFTY"]:
        cfg = CONFIG[index_key]
        print(f"\n==========================================", flush=True)
        print(f" Recovering options for {index_key}", flush=True)
        print(f"==========================================", flush=True)
        
        scrip_df = pd.read_csv(cfg["scrip_file"])
        if index_key == "NIFTY":
            sub_scrip = scrip_df[(scrip_df["pSymbolName"] == "NIFTY") & (scrip_df["pTrdSymbol"].str.contains("26NOV", na=False))].copy()
            sub_scrip["Strike"] = sub_scrip["dStrikePrice;"] / 100.0
        else:
            sub_scrip = scrip_df[(scrip_df["pSymbolName"].str.contains("^SENSEX$", na=False, regex=True)) & (scrip_df["pTrdSymbol"].str.contains("26NOV", na=False))].copy()
            sub_scrip["Strike"] = sub_scrip["dStrikePrice;"] / 100.0

        for d_str in dates_to_recover:
            out_csv = cfg["output_dir"] / f"{cfg['prefix']}_options_1min_{d_str}.csv"
            if out_csv.exists() and out_csv.stat().st_size > 50000:
                print(f"[{index_key}] {d_str} already recovered ({out_csv.stat().st_size:,} bytes). Skipping.", flush=True)
                continue

            d_obj = datetime.date.fromisoformat(d_str)
            next_d = (d_obj + datetime.timedelta(days=1)).isoformat()
            
            spot_df = fetch_candles_safe(client, cfg["spot_neosymbol"], d_str, next_d)
            if spot_df.empty:
                print(f"[{index_key}] {d_str}: No spot data returned.", flush=True)
                continue
            spot_df = spot_df[spot_df["Timestamp"].str.startswith(d_str)].reset_index(drop=True)
            if spot_df.empty:
                continue

            ref_open = spot_df.iloc[0]["Open"]
            spot_close_map = dict(zip(spot_df["Epoch"], spot_df["Close"]))
            
            all_strikes = sorted(sub_scrip["Strike"].unique())
            below = sorted([s for s in all_strikes if s <= ref_open], reverse=True)[:5]
            above = sorted([s for s in all_strikes if s > ref_open])[:5]
            selected_strikes = set(below + above)
            
            if index_key == "NIFTY":
                selected_strikes.update([25500.0, 25600.0, 25650.0, 25700.0, 25800.0])
            elif index_key == "SENSEX":
                selected_strikes.update([82400.0, 83400.0, 83500.0, 82500.0])

            selected_contracts = sub_scrip[sub_scrip["Strike"].isin(selected_strikes)]
            print(f"[{index_key}] {d_str} (Ref Open: {ref_open:.2f}) -> Fetching {len(selected_contracts)} option contracts...", flush=True)
            
            records = []
            date_dir = cfg["output_dir"] / d_str
            date_dir.mkdir(parents=True, exist_ok=True)
            
            spot_cols = ["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume"]
            spot_df[spot_cols].to_csv(date_dir / "spot.csv", index=False)

            for _, row in selected_contracts.iterrows():
                token = str(row["pSymbol"])
                trd_sym = str(row["pTrdSymbol"])
                strike = float(row["Strike"])
                opt_type = str(row["pOptionType"])
                neosymbol = f"{cfg['exch_seg']}|{token}"
                
                opt_candles = fetch_candles_safe(client, neosymbol, d_str, next_d)
                if opt_candles.empty:
                    continue
                opt_candles = opt_candles[opt_candles["Timestamp"].str.startswith(d_str)].reset_index(drop=True)
                if opt_candles.empty:
                    continue

                strike_val = int(strike) if float(strike).is_integer() else strike
                st_dir = date_dir / str(strike_val)
                st_dir.mkdir(parents=True, exist_ok=True)
                
                opt_candles["Symbol"] = trd_sym
                opt_candles["Expiry"] = "2026-11-26"
                opt_candles["Strike"] = strike
                opt_candles["OptionType"] = opt_type
                opt_candles["IndexClose"] = opt_candles["Epoch"].map(spot_close_map)
                
                sub_cols = ["Epoch", "Timestamp", "Open", "High", "Low", "Close", "Volume", "Symbol", "Expiry", "Strike", "OptionType", "IndexClose"]
                opt_candles[sub_cols].to_csv(st_dir / f"{opt_type}.csv", index=False)

                opt_out = pd.DataFrame({
                    "Epoch": opt_candles["Epoch"],
                    "Timestamp": opt_candles["Timestamp"],
                    "InstrumentType": "OPTION",
                    "Symbol": trd_sym,
                    "Expiry": "2026-11-26",
                    "OptionType": opt_type,
                    "Strike": strike,
                    "SpotRef": ref_open,
                    "IndexClose": opt_candles["IndexClose"],
                    "Open": opt_candles["Open"],
                    "High": opt_candles["High"],
                    "Low": opt_candles["Low"],
                    "Close": opt_candles["Close"],
                    "Volume": opt_candles["Volume"],
                    "DuplicateCount": 1,
                })
                records.append(opt_out)

            if records:
                df_out = pd.concat(records, ignore_index=True)
                df_out.to_csv(out_csv, index=False)
                print(f"Saved {len(df_out):,} option rows for {index_key} {d_str} to {out_csv}", flush=True)

if __name__ == "__main__":
    run_recovery()
