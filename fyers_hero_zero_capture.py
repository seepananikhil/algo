#!/usr/bin/env python3
"""Paper-data capture for low-premium options on NIFTY and SENSEX expiry sessions."""

from __future__ import annotations

import csv
import json
import threading
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fyers_apiv3 import fyersModel
from fyers_apiv3.FyersWebsocket import data_ws

from fyers_fetch_sensex_expiry import expiry_contracts as sensex_expiry_contracts
from fyers_orders import load_nifty_options

ROOT = Path(__file__).resolve().parent
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
OUTPUT_DIR = ROOT / "captured_data" / "fyers" / "hero_zero"
IST = timezone(timedelta(hours=5, minutes=30))
NIFTY_INDEX = "NSE:NIFTY50-INDEX"
SENSEX_INDEX = "BSE:SENSEX-INDEX"
CAPTURE_START = (15, 5)
SNAPSHOT_TIME = (15, 20)
EXIT_TIME = (15, 30)
EXIT_CANDLE_TIME = (15, 29)
CAPTURE_END = (15, 31)
NIFTY_PRICE_BAND = (8.0, 12.0)
SENSEX_PRICE_BAND = (20.0, 40.0)
CANDIDATE_HEADER = ["date", "underlying", "expiry", "symbol", "option_type", "strike", "lot_size", "spot_ltp", "distance_from_spot", "band_low", "band_high", "snapshot_at", "received_at", "quote_age_seconds", "snapshot_ltp", "volume_at_snapshot", "source"]
TICK_HEADER = ["date", "timestamp", "underlying", "symbol", "ltp", "volume", "exchange_time"]
PAPER_TRADE_HEADER = ["date", "underlying", "expiry", "symbol", "option_type", "strike", "lot_size", "spot_ltp", "distance_from_spot", "entry_time", "entry_price", "entry_volume", "exit_time", "exit_price", "exit_volume", "pnl_per_unit", "pnl_rs", "status", "exit_reason", "source"]


def now_ist() -> datetime:
    return datetime.now(IST)


def append_row(path: Path, header: list, row: list) -> None:
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        if new:
            writer.writerow(header)
        writer.writerow(row)


def within_spot_window(underlying: str, strike: float, spot: float) -> bool:
    max_distance = 50.0 if underlying == "NIFTY" else 100.0
    return abs(strike - spot) <= max_distance


def write_status(path: Path, value: dict) -> None:
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2), encoding="utf-8")
    temp.replace(path)


def expiry_universe(session: date) -> tuple[list[dict], dict]:
    universe: list[dict] = []
    expiries = {"NIFTY": [], "SENSEX": []}
    nifty = load_nifty_options()
    nifty = nifty[nifty["expiry"] == session]
    for r in nifty.itertuples(index=False):
        item = {
            "underlying": "NIFTY",
            "expiry": session.isoformat(),
            "symbol": str(r.symbol),
            "lot_size": int(r.lot_size),
            "option_type": str(r.opt_type),
            "strike": float(r.strike),
        }
        universe.append(item)
    if universe:
        expiries["NIFTY"].append(session.isoformat())

    sensex = sensex_expiry_contracts(session)
    for c in sensex:
        universe.append({
            "underlying": "SENSEX",
            "expiry": session.isoformat(),
            "symbol": c["symbol"],
            "lot_size": c["lot_size"],
            "option_type": c["option_type"],
            "strike": float(c["strike"]),
        })
    if sensex:
        expiries["SENSEX"].append(session.isoformat())
    return universe, expiries


class HeroZeroCapture:
    def __init__(self, session: date, universe: list[dict], expiry_info: dict) -> None:
        token = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        self.app_id = token["app_id"]
        self.access_token = token["access_token"]
        self.rest = fyersModel.FyersModel(client_id=self.app_id, token=self.access_token, is_async=False, log_path="/tmp")
        profile = self.rest.get_profile()
        if profile.get("s") != "ok":
            raise RuntimeError("Fyers token is invalid or expired")

        self.session = session
        self.universe = universe
        self.by_symbol = {c["symbol"]: c for c in universe}
        self.expiry_info = expiry_info
        self.quotes: dict[str, dict] = {}
        self.spot_quotes: dict[str, dict] = {}
        self.candidates: dict[str, dict] = {}
        self.exit_quotes: dict[str, dict] = {}
        self.lock = threading.RLock()
        self.snapshot_taken = False
        self.output_dir = OUTPUT_DIR
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.candidates_file = self.output_dir / f"hero_zero_candidates_{session}.csv"
        self.ticks_file = self.output_dir / f"hero_zero_ticks_{session}.csv"
        self.status_file = self.output_dir / f"hero_zero_status_{session}.json"
        self.ws = None

    def on_connect(self) -> None:
        symbols = list(self.by_symbol) + [NIFTY_INDEX, SENSEX_INDEX]
        print(f"[{now_ist():%H:%M:%S}] HeroZero connected; subscribing to {len(symbols)} expiry options")
        self.ws.subscribe(symbols=symbols, data_type="SymbolUpdate")

    def on_message(self, msg) -> None:
        if not isinstance(msg, dict):
            return
        symbol = msg.get("symbol")
        if symbol in (NIFTY_INDEX, SENSEX_INDEX) and msg.get("ltp") is not None:
            with self.lock:
                self.spot_quotes[symbol] = {"ltp": float(msg["ltp"]), "received_at": now_ist()}
            return
        if symbol not in self.by_symbol or msg.get("ltp") is None:
            return
        received = now_ist()
        quote = {
            "ltp": float(msg["ltp"]),
            "volume": msg.get("vol_traded_today", ""),
            "exchange_time": msg.get("exch_feed_time", msg.get("last_traded_time", "")),
            "received_at": received,
        }
        with self.lock:
            self.quotes[symbol] = quote
            if symbol in self.candidates and self.snapshot_taken and received.strftime("%H:%M") >= "15:20":
                c = self.by_symbol[symbol]
                append_row(self.ticks_file, TICK_HEADER, [
                    self.session.isoformat(), received.strftime("%Y-%m-%d %H:%M:%S.%f"),
                    c["underlying"], symbol, quote["ltp"], quote["volume"], quote["exchange_time"],
                ])
                if received.strftime("%H:%M") == f"{EXIT_CANDLE_TIME[0]:02d}:{EXIT_CANDLE_TIME[1]:02d}":
                    self.exit_quotes[symbol] = quote

    def on_error(self, msg) -> None:
        print(f"[{now_ist():%H:%M:%S}] HeroZero websocket error: {msg}")

    def on_close(self, msg) -> None:
        print(f"[{now_ist():%H:%M:%S}] HeroZero websocket closed: {msg}")

    def _snapshot(self) -> None:
        now = now_ist()
        with self.lock:
            if self.snapshot_taken:
                return
            self.snapshot_taken = True
            for symbol, q in self.quotes.items():
                c = self.by_symbol[symbol]
                low, high = NIFTY_PRICE_BAND if c["underlying"] == "NIFTY" else SENSEX_PRICE_BAND
                age = max(0.0, (now - q["received_at"]).total_seconds())
                spot_symbol = NIFTY_INDEX if c["underlying"] == "NIFTY" else SENSEX_INDEX
                spot_quote = self.spot_quotes.get(spot_symbol)
                if age > 60 or not low <= q["ltp"] <= high or not spot_quote:
                    continue
                spot_age = max(0.0, (now - spot_quote["received_at"]).total_seconds())
                if spot_age > 60 or not within_spot_window(c["underlying"], c["strike"], spot_quote["ltp"]):
                    continue
                distance = round(c["strike"] - spot_quote["ltp"], 2)
                candidate = {**c, "band_low": low, "band_high": high, "snapshot_at": now,
                             "spot_ltp": spot_quote["ltp"], "distance_from_spot": distance,
                             "quote_age_seconds": round(age, 2), "quote": q}
                self.candidates[symbol] = candidate
                append_row(self.candidates_file, CANDIDATE_HEADER, [
                    self.session.isoformat(), c["underlying"], c["expiry"], symbol, c["option_type"], c["strike"], c["lot_size"],
                    spot_quote["ltp"], distance, low, high, now.strftime("%Y-%m-%d %H:%M:%S"), q["received_at"].strftime("%Y-%m-%d %H:%M:%S"),
                    round(age, 2), q["ltp"], q["volume"], "live_ticks",
                ])
                append_row(self.ticks_file, TICK_HEADER, [
                    self.session.isoformat(), now.strftime("%Y-%m-%d %H:%M:%S.%f"), c["underlying"],
                    symbol, q["ltp"], q["volume"], q["exchange_time"],
                ])
        print(f"[{now:%H:%M:%S}] HeroZero selected {len(self.candidates)} options in target premium bands")

    def _write_paper_trades(self) -> int:
        trades_file = self.output_dir / f"hero_zero_trades_{self.session}.csv"
        count = 0
        for symbol, candidate in self.candidates.items():
            exit_quote, exit_reason = self._fetch_close_quote(symbol)
            if exit_quote is None:
                exit_quote = self.exit_quotes.get(symbol)
                exit_reason = "time_exit_15:30_last_tick_fallback" if exit_quote else "missing_15:30_exit_quote"
            entry_price = candidate["quote"]["ltp"]
            exit_price = exit_quote["ltp"] if exit_quote else ""
            pnl_per_unit = round(exit_price - entry_price, 2) if exit_quote else ""
            pnl_rs = round(pnl_per_unit * candidate["lot_size"], 2) if exit_quote else ""
            append_row(trades_file, PAPER_TRADE_HEADER, [
                self.session.isoformat(), candidate["underlying"], candidate["expiry"], symbol,
                candidate["option_type"], candidate["strike"], candidate["lot_size"],
                candidate["spot_ltp"], candidate["distance_from_spot"],
                candidate["snapshot_at"].strftime("%Y-%m-%d %H:%M:%S"), entry_price,
                candidate["quote"]["volume"],
                exit_quote["received_at"].strftime("%Y-%m-%d %H:%M:%S.%f") if exit_quote else "",
                exit_price, exit_quote["volume"] if exit_quote else "", pnl_per_unit, pnl_rs,
                "closed" if exit_quote else "no_15:30_exit_quote", exit_reason, "live_ticks",
            ])
            count += 1
        return count

    def _fetch_close_quote(self, symbol: str) -> tuple[Optional[dict], str]:
        response = self.rest.history(data={
            "symbol": symbol,
            "resolution": "1",
            "date_format": "1",
            "range_from": self.session.isoformat(),
            "range_to": self.session.isoformat(),
            "cont_flag": "1",
        })
        if response.get("s") != "ok":
            return None, ""
        for epoch, _open, _high, _low, close, volume in response.get("candles") or []:
            candle_time = datetime.fromtimestamp(epoch, IST)
            if candle_time.strftime("%H:%M") == f"{EXIT_CANDLE_TIME[0]:02d}:{EXIT_CANDLE_TIME[1]:02d}":
                return {
                    "ltp": float(close),
                    "volume": volume,
                    "received_at": (candle_time + timedelta(minutes=1)).replace(second=0, microsecond=0),
                }, "time_exit_15:30_candle_close"
        return None, ""

    def run(self) -> dict:
        start = now_ist().replace(hour=CAPTURE_START[0], minute=CAPTURE_START[1], second=0, microsecond=0)
        snapshot = now_ist().replace(hour=SNAPSHOT_TIME[0], minute=SNAPSHOT_TIME[1], second=0, microsecond=0)
        end = now_ist().replace(hour=CAPTURE_END[0], minute=CAPTURE_END[1], second=0, microsecond=0)
        if now_ist() < start:
            time.sleep((start - now_ist()).total_seconds())

        self.ws = data_ws.FyersDataSocket(
            access_token=f"{self.app_id}:{self.access_token}",
            log_path="/tmp",
            litemode=False,
            reconnect=True,
            on_message=self.on_message,
            on_connect=self.on_connect,
            on_error=self.on_error,
            on_close=self.on_close,
        )
        self.ws.connect()
        try:
            while now_ist() < end:
                now = now_ist()
                if not self.snapshot_taken and now >= snapshot:
                    self._snapshot()
                time.sleep(0.2)
            if not self.snapshot_taken:
                self._snapshot()
        finally:
            try:
                self.ws.close_connection()
            except Exception:
                pass

        paper_trade_count = self._write_paper_trades()

        result = {
            "date": self.session.isoformat(),
            "status": "captured",
            "expiry_underlyings": self.expiry_info,
            "subscribed_symbols": len(self.universe),
            "selected_options": len(self.candidates),
            "paper_trades": paper_trade_count,
            "bands": {"NIFTY": list(NIFTY_PRICE_BAND), "SENSEX": list(SENSEX_PRICE_BAND)},
            "spot_windows": {"NIFTY": 50, "SENSEX": 100},
            "selection_time": "15:20 Asia/Kolkata",
            "exit_time": "15:30 Asia/Kolkata",
            "capture_end": "15:31 Asia/Kolkata",
            "candidates_csv": self.candidates_file.name,
            "ticks_csv": self.ticks_file.name,
            "paper_trades_csv": f"hero_zero_trades_{self.session}.csv",
        }
        write_status(self.status_file, result)
        return result


def main() -> None:
    session = now_ist().date()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    status_file = OUTPUT_DIR / f"hero_zero_status_{session}.json"
    universe, expiry_info = expiry_universe(session)
    if not universe:
        write_status(status_file, {"date": session.isoformat(), "status": "not_expiry_session", "expiry_underlyings": expiry_info})
        print(f"{session}: no NIFTY or SENSEX expiry contracts; HeroZero capture skipped")
        return
    result = HeroZeroCapture(session, universe, expiry_info).run()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
