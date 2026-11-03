#!/usr/bin/env python3
"""Live NIFTY market capture and 1-minute candle streaming from Kotak Neo.

- Polls live quotes for NIFTY futures/spot from Kotak Neo.
- Syncs official 1-minute OHLC candles from Kotak Neo historical API.
- Drives LiveSignalEngine for midpoint and key level tracking.
- Runs without any dependency on Fyers.
"""

from __future__ import annotations

import csv
import json
import os
import signal
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

from kotak_orders import get_kotak_client
from live_signals import LiveSignalEngine

ROOT = Path(__file__).resolve().parent
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
KEY_LEVEL_DIR = ROOT / "captured_data" / "fyers" / "key_levels"
CONFIG_FILE = ROOT / "fyers_config.json"
IST = timezone(timedelta(hours=5, minutes=30))
MARKET_OPEN = (9, 15)
MARKET_CLOSE = (15, 30)
TS_FMT = "%Y-%m-%d %H:%M:%S"


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


def resolve_nifty_future_token(client) -> tuple[str, str]:
    """Find current near-month NIFTY futures contract token."""
    try:
        res = client.search_scrip(exchange_segment="nse_fo", symbol="NIFTY", option_type="FUT")
        if isinstance(res, list):
            nifty_futs = [x for x in res if x.get("pSymbolName") == "NIFTY"]
            if nifty_futs:
                tok = str(nifty_futs[0].get("pSymbol"))
                sym = str(nifty_futs[0].get("pTrdSymbol", "NIFTY_FUT"))
                return tok, sym
    except Exception as e:
        print(f"Error resolving Nifty futures: {e}")
    # Default fallback to October 2026 Nifty future token
    return "48704", "NIFTY26OCTFUT"


def resolve_sensex_future_token(client) -> tuple[str, str]:
    """Find current near-month SENSEX futures contract token."""
    try:
        res = client.search_scrip(exchange_segment="bse_fo", symbol="SENSEX", option_type="XX")
        if isinstance(res, list):
            futs = [x for x in res if x.get("pSymbolName") == "SENSEX" and "FUT" in str(x.get("pTrdSymbol", ""))]
            if futs:
                futs.sort(key=lambda x: int(x.get("lExpiryDate") or x.get("lMaturityDate") or 9999999999))
                tok = str(futs[0].get("pSymbol"))
                sym = str(futs[0].get("pTrdSymbol", "SENSEX_FUT"))
                return tok, sym
    except Exception as e:
        print(f"Error resolving Sensex futures: {e}")
    return "864571", "SENSEX26OCTFUT"



def ensure_continuous_1min_candles(df: pd.DataFrame, day: str) -> pd.DataFrame:
    """Ensure an unbroken, complete sequence of 1-minute OHLC bars from 09:15 to current minute / 15:30."""
    if df.empty or "timestamp" not in df.columns:
        return df
    try:
        df = df.copy()
        df["dt"] = pd.to_datetime(df["timestamp"], errors="coerce")
        df = df.dropna(subset=["dt"]).drop_duplicates("dt", keep="last").set_index("dt").sort_index()
        if df.empty:
            return pd.DataFrame()

        start_dt = pd.to_datetime(f"{day} 09:15:00")
        now_t = now_ist().replace(second=0, microsecond=0, tzinfo=None)
        market_end = pd.to_datetime(f"{day} 15:30:00")

        if day == now_ist().strftime("%Y-%m-%d"):
            now_closed = (now_t - pd.Timedelta(minutes=1)) if now_t >= start_dt else start_dt
            end_dt = min(df.index.max(), now_closed, market_end)
        else:
            end_dt = min(max(df.index.max(), start_dt), market_end)
            if (market_end - end_dt) <= pd.Timedelta(hours=2):
                end_dt = market_end

        if end_dt < start_dt:
            end_dt = start_dt

        full_grid = pd.date_range(start_dt, end_dt, freq="1min")
        df_reindexed = df.reindex(full_grid)

        df_reindexed["close"] = df_reindexed["close"].ffill().bfill()
        df_reindexed["open"] = df_reindexed["open"].fillna(df_reindexed["close"])
        df_reindexed["high"] = df_reindexed["high"].fillna(df_reindexed["close"])
        df_reindexed["low"] = df_reindexed["low"].fillna(df_reindexed["close"])
        vol = df_reindexed["volume"].fillna(1000.0) if "volume" in df_reindexed.columns else 1000.0

        return pd.DataFrame({
            "timestamp": full_grid.strftime("%Y-%m-%d %H:%M:00"),
            "open": df_reindexed["open"].values,
            "high": df_reindexed["high"].values,
            "low": df_reindexed["low"].values,
            "close": df_reindexed["close"].values,
            "volume": vol.values if hasattr(vol, "values") else vol,
        })
    except Exception as exc:
        print(f"Error in ensure_continuous_1min_candles: {exc}")
        return df

class KotakCapture:
    def __init__(self) -> None:
        self.stop = threading.Event()
        self.day = now_ist().strftime("%Y-%m-%d")
        LIVE_DIR.mkdir(parents=True, exist_ok=True)
        KEY_LEVEL_DIR.mkdir(parents=True, exist_ok=True)

        self.nifty_sec_file = LIVE_DIR / f"nifty_1s_{self.day}.csv"
        self.nifty_min_file = LIVE_DIR / f"nifty_1min_{self.day}.csv"
        self.sensex_sec_file = LIVE_DIR / f"sensex_1s_{self.day}.csv"
        self.sensex_min_file = LIVE_DIR / f"sensex_1min_{self.day}.csv"
        self.bnf_sec_file = LIVE_DIR / f"banknifty_1s_{self.day}.csv"
        self.bnf_min_file = LIVE_DIR / f"banknifty_1min_{self.day}.csv"

        self.signals = LiveSignalEngine(self.nifty_min_file, LIVE_DIR / f"signals_{self.day}.csv")

        self.client = get_kotak_client()
        if not self.client:
            print("[KotakCapture] Error: Could not initialize Kotak Neo client. Check credentials.")
            sys.exit(1)

        print("[KotakCapture] Tracking Official Spot Indices via Kotak Neo: Nifty 50, Bank Nifty, SENSEX, INDIA VIX")

    def _sync_instrument_candles(self, seg: str, tok: str, target_file: Path) -> bool:
        try:
            res = self.client.historical_data(
                neosymbol=f"{seg}|{tok}",
                interval="1min",
                from_date=self.day,
                to_date=self.day,
            )
            raw = res.get("data", {}).get("candles", [])
            if not raw:
                return False

            rows = []
            for r in raw:
                if len(r) >= 6:
                    ts = r[0][:19].replace("T", " ")
                    rows.append({
                        "timestamp": ts,
                        "open": float(r[1]),
                        "high": float(r[2]),
                        "low": float(r[3]),
                        "close": float(r[4]),
                        "volume": float(r[5]),
                    })

            if rows:
                df = pd.DataFrame(rows)
                df = df.drop_duplicates("timestamp", keep="last").sort_values("timestamp")
                df = ensure_continuous_1min_candles(df, self.day)
                df.to_csv(target_file, index=False)
                return True
        except Exception as e:
            if "429" in str(e):
                time.sleep(10)
            print(f"[{now_ist():%H:%M:%S}] Candle fetch error for {seg}|{tok}: {e}")
        return False
    def _aggregate_from_ticks(self, sec_file: Path, min_file: Path) -> bool:
        if not sec_file.exists():
            return False
        try:
            df = pd.read_csv(sec_file)
            if df.empty or len(df) < 5:
                return False
            df["dt"] = pd.to_datetime(df["timestamp"])
            df = df.set_index("dt").sort_index()
            m = df["ltp"].resample("1min").ohlc()
            # Forward fill any minute gaps so candles are continuous without missing bars
            m["close"] = m["close"].ffill()
            m["open"] = m["open"].fillna(m["close"])
            m["high"] = m["high"].fillna(m["close"])
            m["low"] = m["low"].fillna(m["close"])
            m["volume"] = 1000.0
            m = m.dropna().reset_index()
            m["timestamp"] = m["dt"].dt.strftime("%Y-%m-%d %H:%M:00")
            m = m[["timestamp", "open", "high", "low", "close", "volume"]]
            m = ensure_continuous_1min_candles(m, self.day)
            m.to_csv(min_file, index=False)
            return True
        except Exception:
            return False

    def fetch_candles(self) -> bool:
        """Sync official 1-minute OHLC candles from Kotak Neo historical API."""
        ok_nifty = self._sync_instrument_candles("nse_cm", "Nifty 50", self.nifty_min_file)
        time.sleep(1.2)
        ok_bnf = self._sync_instrument_candles("nse_cm", "Nifty Bank", self.bnf_min_file)
        time.sleep(1.2)
        ok_sensex = self._sync_instrument_candles("bse_cm", "SENSEX", self.sensex_min_file)
        return ok_nifty or ok_bnf or ok_sensex

    def quote_loop(self) -> None:
        """Fetch quotes every 3 seconds to record ticks for NIFTY, SENSEX, and INDIA VIX via Kotak Neo."""
        quote_req = [
            {"instrument_token": "Nifty 50", "exchange_segment": "nse_cm"},
            {"instrument_token": "Nifty Bank", "exchange_segment": "nse_cm"},
            {"instrument_token": "SENSEX", "exchange_segment": "bse_cm"},
            {"instrument_token": "INDIA VIX", "exchange_segment": "nse_cm"},
        ]
        while not self.stop.is_set():
            ts = now_ist()
            try:
                quotes = self.client.quotes(quote_req)
                quotes_data = {}
                if isinstance(quotes, list):
                    for item in quotes:
                        if not isinstance(item, dict):
                            continue
                        ex = str(item.get("exchange", "")).lower()
                        tok = str(item.get("exchange_token", ""))
                        try:
                            ltp = float(item.get("ltp") or 0.0)
                        except (ValueError, TypeError):
                            ltp = 0.0
                        if ltp <= 0:
                            continue

                        change = float(item.get("change") or 0.0)
                        per_change = float(item.get("per_change") or 0.0)
                        ohlc = item.get("ohlc", {})
                        prev_close = float(ohlc.get("close") or 0.0)

                        if "india vix" in tok.lower() or "vix" in tok.lower():
                            quotes_data["vix"] = {
                                "ltp": ltp,
                                "change": change,
                                "per_change": per_change,
                                "prev_close": prev_close,
                                "time": ts.strftime(TS_FMT),
                            }
                        elif "bank" in tok.lower():
                            append_row(
                                self.bnf_sec_file,
                                ["timestamp", "ltp", "last_tick_at"],
                                [ts.strftime(TS_FMT), ltp, ts.strftime(TS_FMT)],
                            )
                            quotes_data["banknifty"] = {
                                "ltp": ltp,
                                "change": change,
                                "per_change": per_change,
                                "prev_close": prev_close,
                                "time": ts.strftime(TS_FMT),
                            }
                        elif "nifty" in tok.lower():
                            append_row(
                                self.nifty_sec_file,
                                ["timestamp", "ltp", "last_tick_at"],
                                [ts.strftime(TS_FMT), ltp, ts.strftime(TS_FMT)],
                            )
                            self.signals.check_tick(ltp, ts)
                            quotes_data["nifty"] = {
                                "ltp": ltp,
                                "change": change,
                                "per_change": per_change,
                                "prev_close": prev_close,
                                "time": ts.strftime(TS_FMT),
                            }
                        elif "sensex" in tok.lower():
                            append_row(
                                self.sensex_sec_file,
                                ["timestamp", "ltp", "last_tick_at"],
                                [ts.strftime(TS_FMT), ltp, ts.strftime(TS_FMT)],
                            )
                            quotes_data["sensex"] = {
                                "ltp": ltp,
                                "change": change,
                                "per_change": per_change,
                                "prev_close": prev_close,
                                "time": ts.strftime(TS_FMT),
                            }
                    if quotes_data:
                        quotes_file = LIVE_DIR / f"quotes_{self.day}.json"
                        quotes_file.write_text(json.dumps(quotes_data), encoding="utf-8")
            except Exception:
                pass
            time.sleep(3)

    def candle_loop(self) -> None:
        """Refresh 1-minute candles from Kotak/Fyers every 20 seconds."""
        time.sleep(2)
        while not self.stop.is_set():
            if self.fetch_candles():
                try:
                    self.signals.evaluate()
                except Exception:
                    pass
            for _ in range(15):
                if self.stop.is_set():
                    break
                time.sleep(1)

    def run(self) -> None:
        open_dt, close_dt = at_today(MARKET_OPEN), at_today(MARKET_CLOSE)
        if now_ist() < open_dt:
            print(f"Waiting for market open (09:15 IST)...")
            while (left := (open_dt - now_ist()).total_seconds()) > 0:
                time.sleep(min(1.0, left))

        print(f"Starting Kotak Live Capture for {self.day}...")
        self.fetch_candles()

        t_quote = threading.Thread(target=self.quote_loop, daemon=True)
        t_candle = threading.Thread(target=self.candle_loop, daemon=True)
        t_quote.start()
        t_candle.start()

        print(f"Capturing to {self.nifty_min_file.name} and {self.sensex_min_file.name} until 15:30 IST")
        try:
            while now_ist() < close_dt:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            self.stop.set()
            self.fetch_candles()
            print("Kotak Capture stopped.")


if __name__ == "__main__":
    if now_ist().weekday() >= 5:
        print("Market closed on weekends.")
        sys.exit(0)
    KotakCapture().run()
