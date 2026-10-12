#!/usr/bin/env python3
"""Live NIFTY capture from Fyers (all timestamps IST).

- 1-second LTP snapshots from the Fyers WebSocket.
- Official 1-minute OHLC candles from the Fyers history API, pulled after each minute closes.

Run: python3 fyers_nifty_capture.py   (needs a valid token: python3 fyers_login_ui.py)
"""

from __future__ import annotations

import csv
import json
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from fyers_apiv3 import fyersModel
from fyers_apiv3.FyersWebsocket import data_ws

from live_signals import LiveSignalEngine, notify
from fyers_orders import OptionTrader

ROOT = Path(__file__).resolve().parent
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
OUT_DIR = ROOT / "captured_data" / "fyers" / "live"
SYMBOL = "NSE:NIFTY50-INDEX"
IST = timezone(timedelta(hours=5, minutes=30))
MARKET_OPEN = (9, 15)
MARKET_CLOSE = (10, 0)  # strategy only trades the first 30 minutes; nothing needed after 10:00
TS_FMT = "%Y-%m-%d %H:%M:%S"
TMP_DIR = ROOT / "tmp"  # Windows-safe temp directory for Fyers SDK logging


def now_ist() -> datetime:
    return datetime.now(IST)


def at_today(hm) -> datetime:
    n = now_ist()
    return n.replace(hour=hm[0], minute=hm[1], second=0, microsecond=0)


def append_row(path: Path, header: list, row: list) -> None:
    new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        if new:
            w.writerow(header)
        w.writerow(row)


class NiftyCapture:
    def __init__(self) -> None:
        self._load_token()
        self.ltp: Optional[float] = None
        self.ltp_ts: Optional[datetime] = None
        self.lock = threading.Lock()
        self.stop = threading.Event()
        day = now_ist().strftime("%Y-%m-%d")
        OUT_DIR.mkdir(parents=True, exist_ok=True)
        self.sec_file = OUT_DIR / f"nifty_1s_{day}.csv"
        self.min_file = OUT_DIR / f"nifty_1min_{day}.csv"
        self.last_candle_epoch = self._last_written_epoch()
        self.signals = LiveSignalEngine(self.min_file, OUT_DIR / f"signals_{day}.csv")
        self.trader: Optional[OptionTrader] = None

    def _load_token(self) -> None:
        tok = json.loads(TOKEN_FILE.read_text(encoding="utf-8")) if TOKEN_FILE.exists() else {}
        self.app_id = tok.get("app_id", "")
        self.access_token = tok.get("access_token", "")
        TMP_DIR.mkdir(parents=True, exist_ok=True)
        self.rest = fyersModel.FyersModel(client_id=self.app_id, token=self.access_token, is_async=False, log_path=str(TMP_DIR))

    def wait_for_valid_token(self) -> None:
        while True:
            self._load_token()
            try:
                if self.access_token and self.rest.get_profile().get("s") == "ok":
                    return
            except Exception:
                pass
            print(f"[{now_ist():%H:%M:%S}] Token invalid/expired. Log in via: python3 fyers_login_ui.py  (retrying in 30s)")
            time.sleep(30)

    def _last_written_epoch(self) -> int:
        if not self.min_file.exists():
            return 0
        last = None
        with self.min_file.open("r", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                last = row
        if not last:
            return 0
        return int(datetime.strptime(last["timestamp"], TS_FMT).replace(tzinfo=IST).timestamp())

    # WebSocket callbacks
    def on_message(self, msg) -> None:
        if isinstance(msg, dict) and msg.get("symbol") == SYMBOL and "ltp" in msg:
            with self.lock:
                self.ltp = float(msg["ltp"])
                self.ltp_ts = now_ist()

    def on_connect(self) -> None:
        print(f"[{now_ist():%H:%M:%S}] WebSocket connected, subscribing {SYMBOL}")
        self.ws.subscribe(symbols=[SYMBOL], data_type="SymbolUpdate")

    def on_error(self, msg) -> None:
        print(f"[{now_ist():%H:%M:%S}] WebSocket error: {msg}")

    def on_close(self, msg) -> None:
        print(f"[{now_ist():%H:%M:%S}] WebSocket closed: {msg}")

    def second_loop(self) -> None:
        next_tick = int(time.time()) + 1
        stale_exit_requested = False
        while not self.stop.is_set():
            time.sleep(max(0.0, next_tick - time.time()))
            next_tick += 1
            with self.lock:
                ltp, ltp_ts = self.ltp, self.ltp_ts
            if ltp is None or ltp_ts is None:
                continue
            ts = datetime.fromtimestamp(next_tick - 1, IST)
            if (now_ist() - ltp_ts).total_seconds() > 3:
                if self.trader and self.trader.position and not stale_exit_requested:
                    print(f"[{ts:%H:%M:%S}] NIFTY feed stale; requesting market exit")
                    self.trader.exit("stale_index_feed")
                    stale_exit_requested = True
                continue
            stale_exit_requested = False
            append_row(self.sec_file, ["timestamp", "ltp", "last_tick_at"], [ts.strftime(TS_FMT), ltp, ltp_ts.strftime(TS_FMT)])
            self.signals.check_tick(ltp, ts)
            if self.trader:
                self.trader.on_tick(ltp)

    def minute_loop(self) -> None:
        while not self.stop.is_set():
            # Wait until 3s past the next minute so Fyers has finalised the candle.
            n = now_ist()
            nxt = (n + timedelta(minutes=1)).replace(second=3, microsecond=0)
            self.stop.wait((nxt - n).total_seconds())
            if self.fetch_candles():
                try:
                    self.signals.evaluate()
                except Exception as exc:
                    print(f"[{now_ist():%H:%M:%S}] signal error: {exc}")

    def fetch_candles(self) -> bool:
        """Append newly closed candles; returns True if any were added."""
        day = now_ist().strftime("%Y-%m-%d")
        try:
            r = self.rest.history(data={
                "symbol": SYMBOL, "resolution": "1", "date_format": "1",
                "range_from": day, "range_to": day, "cont_flag": "1",
            })
        except Exception as exc:
            print(f"[{now_ist():%H:%M:%S}] history error: {exc}")
            return False
        if r.get("s") == "no_data":
            return False
        if r.get("s") != "ok":
            print(f"[{now_ist():%H:%M:%S}] history failed: {r.get('code')} {r.get('message')}")
            return False
        added = False
        current_minute = int(now_ist().replace(second=0, microsecond=0).timestamp())
        for epoch, o, h, l, c, v in r.get("candles") or []:
            # Skip the still-forming candle and anything already written.
            if epoch >= current_minute or epoch <= self.last_candle_epoch:
                continue
            ts = datetime.fromtimestamp(epoch, IST).strftime(TS_FMT)
            append_row(self.min_file, ["timestamp", "open", "high", "low", "close", "volume"], [ts, o, h, l, c, v])
            self.last_candle_epoch = epoch
            added = True
            print(f"[{now_ist():%H:%M:%S}] 1m {ts} O{o} H{h} L{l} C{c}")
        return added

    def run(self) -> None:
        open_dt, close_dt = at_today(MARKET_OPEN), at_today(MARKET_CLOSE)
        if now_ist() < open_dt:
            print(f"Waiting for market open (09:15 IST)...")
            interactive = sys.stdout.isatty()
            while (left := (open_dt - now_ist()).total_seconds()) > 0:
                if interactive:
                    mins, secs = divmod(int(left) + 1, 60)
                    print(f"\r  starts in {mins:02d}:{secs:02d} ", end="", flush=True)
                time.sleep(min(1.0, left))
            if interactive:
                print()

        self.wait_for_valid_token()
        self.trader = OptionTrader(self.rest, notify)
        self.signals.trader = self.trader
        self.fetch_candles()  # backfill anything missed earlier today
        self.signals.evaluate()
        self.ws = data_ws.FyersDataSocket(
            access_token=f"{self.app_id}:{self.access_token}",
            log_path=str(TMP_DIR),
            litemode=True,
            reconnect=True,
            on_message=self.on_message,
            on_connect=self.on_connect,
            on_error=self.on_error,
            on_close=self.on_close,
        )
        self.ws.connect()

        threads = [threading.Thread(target=self.second_loop, daemon=True), threading.Thread(target=self.minute_loop, daemon=True)]
        for t in threads:
            t.start()
        print(f"Capturing to {self.sec_file.name} and {self.min_file.name} until 15:30 IST (Ctrl+C to stop)")

        try:
            while now_ist() < close_dt:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop.set()
            if self.trader:
                self.trader.exit("shutdown")
            try:
                self.fetch_candles()
                self.ws.close_connection()
            except (Exception, KeyboardInterrupt):
                pass
            print("Capture stopped.")
            if self.min_file.exists():
                from run_strategy_on_capture import add_to_trade_log, run as run_strategy
                run_strategy(self.min_file, OUT_DIR / f"strategy_trades_{self.min_file.stem.split('_')[-1]}.csv")
                if now_ist() >= close_dt:
                    add_to_trade_log(self.min_file)


if __name__ == "__main__":
    if now_ist().weekday() >= 5:
        print("Market closed: capture does not run on weekends.")
        sys.exit(0)
    NiftyCapture().run()
