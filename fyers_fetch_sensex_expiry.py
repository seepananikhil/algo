#!/usr/bin/env python3
"""Fetch SENSEX expiry-day spot and a wide option ladder from Fyers.

Example: python3 fyers_fetch_sensex_expiry.py --date 2026-10-08
The ladder contains 15 strikes above and below the 09:15 SENSEX open for each option type.
"""

from __future__ import annotations

import argparse
import json
import re
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
from fyers_apiv3 import fyersModel

ROOT = Path(__file__).resolve().parent
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
OUTPUT_DIR = ROOT / "captured_data" / "fyers" / "sensex_expiry"
IST = timezone(timedelta(hours=5, minutes=30))
INDEX_SYMBOL = "BSE:SENSEX-INDEX"
FO_MASTER_URL = "https://public.fyers.in/sym_details/BSE_FO.csv"


def make_client() -> fyersModel.FyersModel:
    token = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
    client = fyersModel.FyersModel(
        client_id=token["app_id"], token=token["access_token"], is_async=False, log_path="/tmp"
    )
    if client.get_profile().get("s") != "ok":
        raise SystemExit("Fyers token invalid or expired; log in before fetching.")
    return client


def fetch_candles(client: fyersModel.FyersModel, symbol: str, session: date) -> pd.DataFrame:
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
    frame["timestamp_utc"] = pd.to_datetime(frame.pop("epoch"), unit="s", utc=True)
    frame = frame[frame["timestamp_utc"].dt.date == session]
    grouped = frame.groupby("timestamp_utc", sort=False)
    frame["duplicate_count"] = grouped["open"].transform("size")
    conflicts = grouped[["open", "high", "low", "close", "volume"]].nunique().gt(1).any(axis=1)
    frame["duplicate_conflict"] = frame["timestamp_utc"].map(conflicts).fillna(False)
    alternates = {
        timestamp: group[["open", "high", "low", "close", "volume"]].to_dict("records")
        for timestamp, group in frame.groupby("timestamp_utc", sort=False)
        if len(group) > 1 and bool(conflicts.loc[timestamp])
    }
    frame["duplicate_raw_rows"] = frame["timestamp_utc"].map(
        lambda timestamp: json.dumps(alternates[timestamp], separators=(",", ":")) if timestamp in alternates else ""
    )
    frame = frame.drop_duplicates("timestamp_utc", keep="last")
    return frame.sort_values("timestamp_utc").reset_index(drop=True)


def expiry_contracts(session: date) -> list[dict]:
    master = pd.read_csv(FO_MASTER_URL, header=None, dtype=str)
    expiry_epoch = pd.to_numeric(master[8], errors="coerce")
    expiry_ist = pd.to_datetime(expiry_epoch, unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.date
    rows = master[(master[13] == "SENSEX") & (expiry_ist == session) & master[16].isin(("CE", "PE"))]
    contracts = []
    for row in rows.itertuples(index=False, name=None):
        match = re.fullmatch(r"SENSEX \d{2} \w{3} \d{2} ([\d.]+) (CE|PE)", str(row[1]))
        if not match:
            continue
        contracts.append({"symbol": str(row[9]), "strike": float(row[15]), "option_type": str(row[16])})
    return contracts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", help="expiry session, YYYY-MM-DD (defaults to today in IST)")
    parser.add_argument("--count", type=int, default=15, help="strikes above and below the 09:15 spot per option type")
    parser.add_argument("--force", action="store_true", help="replace existing output for this date")
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be at least 1")
    session = date.fromisoformat(args.date) if args.date else datetime.now(IST).date()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    csv_path = OUTPUT_DIR / f"sensex_expiry_{session.isoformat()}.csv"
    json_path = OUTPUT_DIR / f"sensex_expiry_{session.isoformat()}.json"
    if (csv_path.exists() or json_path.exists()) and not args.force:
        raise SystemExit(f"Output already exists for {session}; pass --force to replace it.")

    client = make_client()
    spot = fetch_candles(client, INDEX_SYMBOL, session)
    if spot.empty:
        raise SystemExit(f"No SENSEX index candles found for {session}.")
    first_time = spot.iloc[0]["timestamp_utc"].tz_convert("Asia/Kolkata")
    if first_time.strftime("%H:%M") != "09:15":
        raise SystemExit(f"First SENSEX candle is {first_time:%H:%M} IST, not 09:15; refusing to infer strikes.")
    reference = float(spot.iloc[0]["open"])

    contracts = expiry_contracts(session)
    strikes = sorted({c["strike"] for c in contracts})
    below = sorted((strike for strike in strikes if strike < reference), reverse=True)[:args.count]
    above = sorted(strike for strike in strikes if strike >= reference)[:args.count]
    selected_strikes = set(below + above)
    calls = [c for c in contracts if c["option_type"] == "CE" and c["strike"] in selected_strikes]
    puts = [c for c in contracts if c["option_type"] == "PE" and c["strike"] in selected_strikes]
    selected = calls + puts
    if len(calls) != len(selected_strikes) or len(puts) != len(selected_strikes):
        raise SystemExit(f"Expiry master has incomplete nearby contracts at spot {reference}: {len(calls)} calls, {len(puts)} puts for {len(selected_strikes)} strikes.")

    records = []
    spot_closes = spot.set_index("timestamp_utc")["close"]
    spot_output = spot.copy()
    spot_output["timestamp_ist"] = spot_output["timestamp_utc"].dt.tz_convert("Asia/Kolkata").astype(str)
    spot_output["instrument_type"] = "INDEX"
    spot_output["symbol"] = INDEX_SYMBOL
    spot_output["expiry_date"] = session.isoformat()
    spot_output["option_type"] = ""
    spot_output["strike"] = None
    spot_output["spot_reference"] = reference
    spot_output["sensex_spot_close"] = spot_output["close"]
    records.append(spot_output)

    for contract in selected:
        candles = fetch_candles(client, contract["symbol"], session)
        if candles.empty:
            raise SystemExit(f"No option candles for selected contract {contract['symbol']}.")
        option = candles.copy()
        option["timestamp_ist"] = option["timestamp_utc"].dt.tz_convert("Asia/Kolkata").astype(str)
        option["instrument_type"] = "OPTION"
        option["symbol"] = contract["symbol"]
        option["expiry_date"] = session.isoformat()
        option["option_type"] = contract["option_type"]
        option["strike"] = contract["strike"]
        option["spot_reference"] = reference
        option["sensex_spot_close"] = option["timestamp_utc"].map(spot_closes)
        option["duplicate_count"] = candles["duplicate_count"]
        option["duplicate_conflict"] = candles["duplicate_conflict"]
        records.append(option)
        conflict_count = int(option["duplicate_conflict"].sum())
        print(f"{contract['option_type']} {contract['strike']:g} {contract['symbol']}: {len(option)} candles, {conflict_count} conflicting duplicate minute(s)")
        time.sleep(0.2)

    output = pd.concat(records, ignore_index=True)
    output["duplicate_count"] = output["duplicate_count"].fillna(1).astype(int)
    output["duplicate_conflict"] = output["duplicate_conflict"].fillna(False).astype(bool)
    output["duplicate_raw_rows"] = output["duplicate_raw_rows"].fillna("")
    output = output[["timestamp_utc", "timestamp_ist", "instrument_type", "symbol", "expiry_date",
                     "option_type", "strike", "spot_reference", "sensex_spot_close",
                     "open", "high", "low", "close", "volume", "duplicate_count", "duplicate_conflict",
                     "duplicate_raw_rows"]]
    temp_path = csv_path.with_suffix(".tmp")
    output.to_csv(temp_path, index=False)
    temp_path.replace(csv_path)
    manifest = {
        "session_date": session.isoformat(),
        "timezone": "Asia/Kolkata",
        "source": "Fyers 1-minute history",
        "duplicate_policy": "Keep last returned row per minute; conflicting source rows are retained in duplicate_raw_rows.",
        "index_symbol": INDEX_SYMBOL,
        "strike_selection": f"{args.count} strikes below and {args.count} strikes at/above the 09:15 SENSEX open for each option type",
        "sensex_open": reference,
        "contracts": selected,
        "candles": {"index": len(spot), **{c["symbol"]: len(r) for c, r in zip(selected, records[1:])}},
        "conflicting_duplicate_minutes": {
            "index": int(spot["duplicate_conflict"].sum()),
            **{c["symbol"]: int(r["duplicate_conflict"].sum()) for c, r in zip(selected, records[1:])},
        },
        "csv": csv_path.name,
    }
    json_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Stored {len(output):,} rows: {csv_path}")
    print(f"Manifest: {json_path}")


if __name__ == "__main__":
    main()