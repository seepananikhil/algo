"""Live option orders on Fyers for strategy signals: CALL buys CE above ATM, PUT buys PE below ATM."""

from __future__ import annotations

import csv
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import pandas as pd

from midpoint_strategy import TRADE_WINDOW_MINUTES, TRAIL_ACTIVATE_POINTS, TRAIL_POINTS

# One minute after the strategy's last exit candle (09:15 open + window) closes.
SAFETY_EXIT_TIME = (datetime(2000, 1, 1, 9, 15) + timedelta(minutes=TRADE_WINDOW_MINUTES + 1)).time()

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "fyers_config.json"
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
STOP_FILE = ROOT / "STOP_TRADING"  # create this file to block all new entries immediately
SYMBOL_MASTER_URL = "https://public.fyers.in/sym_details/NSE_FO.csv"
IST = timezone(timedelta(hours=5, minutes=30))
STRIKE_STEP = 50
ORDER_LOG_HEADER = ["time", "action", "symbol", "qty", "order_id", "fill_price", "index_price", "reason", "trade_pnl_rs", "day_pnl_rs", "mode"]


def now_ist() -> datetime:
    return datetime.now(IST)


def load_settings() -> dict:
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
    return {
        "live": bool(cfg.get("live_trading", False)),
        "lots": int(cfg.get("lots", 1)),
        "daily_loss_limit": float(cfg.get("daily_loss_limit", 1000)),
        "strike_offset": int(cfg.get("strike_offset", 100)),
        "option_target_pct": float(cfg.get("option_target_pct", 10)),
    }


def load_nifty_options() -> pd.DataFrame:
    cols = {8: "expiry_epoch", 9: "symbol", 3: "lot_size", 13: "underlying", 15: "strike", 16: "opt_type"}
    raw = pd.read_csv(SYMBOL_MASTER_URL, header=None, usecols=list(cols))
    df = raw.rename(columns=cols)
    df = df[(df["underlying"] == "NIFTY") & (df["opt_type"].isin(["CE", "PE"]))].copy()
    df["expiry"] = pd.to_datetime(df["expiry_epoch"], unit="s", utc=True).dt.tz_convert("Asia/Kolkata").dt.date
    return df


class OptionTrader:
    def __init__(self, rest, notify) -> None:
        self.rest = rest
        self.notify = notify
        self.settings = load_settings()
        self.mode = "LIVE" if self.settings["live"] else "DRY_RUN"
        self.options = load_nifty_options()
        self.position: Optional[dict] = None
        self.closed_keys: set[str] = set()
        self.day_pnl = 0.0
        self.halted_reason: Optional[str] = None
        self.last_mtm_check = 0.0
        # Ticks (1-sec thread) and signals (minute thread) both call into the trader.
        self.lock = threading.RLock()
        self.log_file = LIVE_DIR / f"live_orders_{now_ist():%Y-%m-%d}.csv"
        LIVE_DIR.mkdir(parents=True, exist_ok=True)
        print(f"[orders] mode={self.mode} lots={self.settings['lots']} loss_limit=Rs {self.settings['daily_loss_limit']:.0f}")

    # ---------- instrument selection ----------
    def pick_option(self, signal_side: str, index_price: float) -> pd.Series:
        atm = round(index_price / STRIKE_STEP) * STRIKE_STEP
        offset = self.settings["strike_offset"]
        strike, opt_type = (atm + offset, "CE") if signal_side == "CALL" else (atm - offset, "PE")
        today = now_ist().date()
        # Nearest expiry, including a contract that expires today.
        expiries = sorted(e for e in self.options["expiry"].unique() if e >= today)
        rows = self.options[
            (self.options["expiry"] == expiries[0]) & (self.options["strike"] == strike) & (self.options["opt_type"] == opt_type)
        ]
        if rows.empty:
            raise RuntimeError(f"No NIFTY {strike} {opt_type} for expiry {expiries[0]}")
        return rows.iloc[0]

    # ---------- broker calls ----------
    def option_ltp(self, symbol: str) -> Optional[float]:
        r = self.rest.quotes(data={"symbols": symbol})
        if r.get("s") == "ok" and r.get("d"):
            return float(r["d"][0]["v"]["lp"])
        return None

    def _order(self, symbol: str, qty: int, side: int) -> tuple:
        """side 1 = buy, -1 = sell. Returns (order_id, fill_price)."""
        if not self.settings["live"]:
            return "dry-run", self.option_ltp(symbol)
        resp = self.rest.place_order(data={
            "symbol": symbol, "qty": qty, "type": 2, "side": side, "productType": "INTRADAY",
            "limitPrice": 0, "stopPrice": 0, "validity": "DAY", "disclosedQty": 0, "offlineOrder": False,
        })
        if resp.get("s") != "ok":
            raise RuntimeError(f"order rejected: {resp.get('code')} {resp.get('message')}")
        order_id = resp["id"]
        for _ in range(20):
            ob = self.rest.orderbook(data={"id": order_id})
            orders = ob.get("orderBook") or []
            if orders:
                o = orders[0]
                if o.get("status") == 2:
                    return order_id, float(o.get("tradedPrice") or 0)
                if o.get("status") in (1, 5):
                    raise RuntimeError(f"order {order_id} not filled: status {o.get('status')} {o.get('message', '')}")
            time.sleep(0.5)
        raise RuntimeError(f"order {order_id} fill not confirmed in 10s")

    def _log(self, action, symbol, qty, order_id, fill, index_price, reason, trade_pnl="") -> None:
        new = not self.log_file.exists()
        with self.log_file.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(ORDER_LOG_HEADER)
            w.writerow([f"{now_ist():%H:%M:%S}", action, symbol, qty, order_id, fill, index_price, reason, trade_pnl,
                        round(self.day_pnl, 2), self.mode])

    def _halt(self, reason: str) -> None:
        if not self.halted_reason:
            self.halted_reason = reason
            print(f"[orders] TRADING HALTED: {reason}")
            self.notify("TRADING HALTED", reason)

    # ---------- signal hooks ----------
    def enter(self, signal_side: str, index_price: float, index_target: float, index_stop: float, key: str = "") -> None:
        with self.lock:
            self._enter(signal_side, index_price, index_target, index_stop, key)

    def exit(self, reason: str, index_price: Optional[float] = None) -> None:
        with self.lock:
            self._exit(reason, index_price)

    def on_tick(self, index_ltp: float) -> None:
        with self.lock:
            self._on_tick(index_ltp)

    def was_closed(self, key: str) -> bool:
        with self.lock:
            return key in self.closed_keys

    def _enter(self, signal_side: str, index_price: float, index_target: float, index_stop: float, key: str = "") -> None:
        if STOP_FILE.exists():
            print(f"[orders] skip {signal_side} entry (kill switch on)")
            self.notify("Entry skipped", f"{signal_side} signal ignored: kill switch on")
            return
        if self.halted_reason or self.position:
            print(f"[orders] skip {signal_side} entry ({self.halted_reason or 'position already open'})")
            return
        try:
            opt = self.pick_option(signal_side, index_price)
            qty = int(opt["lot_size"]) * self.settings["lots"]
            order_id, fill = self._order(opt["symbol"], qty, 1)
        except Exception as exc:
            self._halt(f"entry failed: {exc}")
            return
        self.position = {
            "symbol": opt["symbol"], "qty": qty, "signal_side": signal_side, "entry_fill": fill,
            "index_target": index_target, "index_stop": index_stop, "key": key,
            "index_entry": index_price, "index_best": index_price, "trailing": False,
        }
        self._log("BUY", opt["symbol"], qty, order_id, fill, index_price, f"{signal_side} signal")
        print(f"[orders] {self.mode} BUY {opt['symbol']} qty {qty} @ {fill}")

    def _exit(self, reason: str, index_price: Optional[float] = None) -> None:
        pos = self.position
        if not pos:
            return
        try:
            order_id, fill = self._order(pos["symbol"], pos["qty"], -1)
        except Exception as exc:
            self._halt(f"EXIT FAILED for {pos['symbol']}: {exc} - close it manually in Fyers")
            return
        if pos.get("key"):
            self.closed_keys.add(pos["key"])
        self.position = None
        pnl = ((fill or 0) - (pos["entry_fill"] or 0)) * pos["qty"]
        self.day_pnl += pnl
        self._log("SELL", pos["symbol"], pos["qty"], order_id, fill, index_price, reason, round(pnl, 2))
        print(f"[orders] {self.mode} SELL {pos['symbol']} @ {fill} [{reason}] trade Rs {pnl:+,.0f} day Rs {self.day_pnl:+,.0f}")
        if self.day_pnl <= -self.settings["daily_loss_limit"]:
            self._halt(f"daily loss limit hit (Rs {self.day_pnl:,.0f})")

    def _on_tick(self, index_ltp: float) -> None:
        """Every second: index target/stop, and option-level loss limit while a position is open."""
        pos = self.position
        if not pos:
            return
        if now_ist().time() >= SAFETY_EXIT_TIME:
            self._exit("time_exit_safety", index_ltp)
            return
        long = pos["signal_side"] == "CALL"
        if (long and index_ltp >= pos["index_target"]) or (not long and index_ltp <= pos["index_target"]):
            self._exit("target", index_ltp)
            return
        if (long and index_ltp <= pos["index_stop"]) or (not long and index_ltp >= pos["index_stop"]):
            self._exit("stop", index_ltp)
            return
        pos["index_best"] = max(pos["index_best"], index_ltp) if long else min(pos["index_best"], index_ltp)
        gain = (pos["index_best"] - pos["index_entry"]) if long else (pos["index_entry"] - pos["index_best"])
        if TRAIL_ACTIVATE_POINTS is not None and not pos["trailing"] and gain >= TRAIL_ACTIVATE_POINTS:
            pos["trailing"] = True
            self.notify("Trailing stop ON", f"{pos['symbol']} up {gain:.1f} pts; trailing {TRAIL_POINTS:.0f} behind best")
        if pos["trailing"]:
            level = pos["index_best"] - TRAIL_POINTS if long else pos["index_best"] + TRAIL_POINTS
            if (long and index_ltp <= level) or (not long and index_ltp >= level):
                self._exit("trail_stop", index_ltp)
                return
        if time.time() - self.last_mtm_check >= 2:
            self.last_mtm_check = time.time()
            ltp = self.option_ltp(pos["symbol"])
            if ltp is not None and pos["entry_fill"]:
                gain_pct = 100 * (ltp - pos["entry_fill"]) / pos["entry_fill"]
                target_pct = self.settings["option_target_pct"]
                if target_pct > 0 and gain_pct >= target_pct:
                    self._exit("option_target", index_ltp)
                    return
                open_pnl = (ltp - pos["entry_fill"]) * pos["qty"]
                if self.day_pnl + open_pnl <= -self.settings["daily_loss_limit"]:
                    self._exit("daily_loss_limit", index_ltp)
