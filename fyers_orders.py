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

from midpoint_strategy import PAPER_LOTS, TRADE_WINDOW_MINUTES, TRAIL_ACTIVATE_POINTS, TRAIL_POINTS

# One minute after the strategy's last exit candle (09:15 open + window) closes.
SAFETY_EXIT_TIME = (datetime(2000, 1, 1, 9, 15) + timedelta(minutes=TRADE_WINDOW_MINUTES + 1)).time()

ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "fyers_config.json"
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
POSITION_STATE_FILE = ROOT / ".tmp" / "midpoint_live_position.json"
STOP_FILE = ROOT / "STOP_TRADING"  # create this file to block all new entries immediately
SYMBOL_MASTER_URL = "https://public.fyers.in/sym_details/NSE_FO.csv"
IST = timezone(timedelta(hours=5, minutes=30))
STRIKE_STEP = 50
ORDER_LOG_HEADER = ["time", "action", "symbol", "qty", "order_id", "fill_price", "index_price", "reason", "trade_pnl_rs", "day_pnl_rs", "mode"]
BROKER_TEST_HEADER = ["date", "time", "event", "symbol", "qty", "reference_option_ltp", "planned_option_target", "planned_nifty_stop", "planned_nifty_target", "order_id", "status", "details"]


def available_equity_funds(response: dict) -> Optional[float]:
    """Read the available equity balance from a Fyers funds response."""
    if response.get("s") != "ok":
        return None
    data = response.get("data")
    rows = response.get("fund_limit")
    if rows is None and isinstance(data, dict):
        rows = data.get("fund_limit")
    if rows is None and isinstance(data, list):
        rows = data
    for row in rows or []:
        title = str(row.get("title", "")).strip().lower()
        if "available" in title and "balance" in title:
            try:
                return float(row["equityAmount"])
            except (KeyError, TypeError, ValueError):
                return None
    return None


def now_ist() -> datetime:
    return datetime.now(IST)


def load_settings() -> dict:
    cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8")) if CONFIG_FILE.exists() else {}
    return {
        "live": bool(cfg.get("midpoint_live_trading", cfg.get("live_trading", False))),
        "lots": int(cfg.get("lots", PAPER_LOTS)),
        "daily_loss_limit": float(cfg.get("daily_loss_limit", 1000)),
        "strike_offset": int(cfg.get("strike_offset", 100)),
        "option_target_pct": float(cfg.get("option_target_pct", 10)),
        "minimum_live_funds": float(cfg.get("minimum_live_funds", 25000)),
        "broker_test_once": bool(cfg.get("midpoint_broker_test_once", False)),
    }


def place_live_order(rest, symbol: str, qty: int, side: int, on_order_accepted=None) -> tuple[str, float]:
    """Place and confirm a Fyers market order. side 1 = buy, -1 = sell."""
    if qty <= 0 or side not in (-1, 1):
        raise ValueError(f"invalid order quantity or side: qty={qty}, side={side}")
    response = rest.place_order(data={
        "symbol": symbol, "qty": qty, "type": 2, "side": side, "productType": "INTRADAY",
        "limitPrice": 0, "stopPrice": 0, "validity": "DAY", "disclosedQty": 0, "offlineOrder": False,
    })
    if response.get("s") != "ok":
        raise RuntimeError(f"order rejected: {response.get('code')} {response.get('message')}")
    order_id = response["id"]
    if on_order_accepted is not None:
        on_order_accepted(order_id)
    for _ in range(20):
        orderbook = rest.orderbook(data={"id": order_id})
        if orderbook.get("s") not in (None, "ok"):
            raise RuntimeError(f"order {order_id} status lookup failed: {orderbook.get('message', '')}")
        orders = orderbook.get("orderBook") or []
        if orders:
            order = next((row for row in orders if str(row.get("id", order_id)) == str(order_id)), None)
            if order is None:
                raise RuntimeError(f"Fyers returned no matching order for accepted order {order_id}")
            if order.get("status") == 2:
                filled_qty = order.get("filledQty")
                if filled_qty not in (None, "") and int(filled_qty) != qty:
                    raise RuntimeError(f"order {order_id} filled {filled_qty} of {qty} requested")
                return order_id, float(order.get("tradedPrice") or 0)
            if order.get("status") in (1, 5):
                raise RuntimeError(f"order {order_id} not filled: status {order.get('status')} {order.get('message', '')}")
        time.sleep(0.5)
    raise RuntimeError(f"order {order_id} fill not confirmed in 10s")


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
        self.broker_test_file = LIVE_DIR / f"midpoint_broker_test_{now_ist():%Y-%m-%d}.csv"
        self.broker_test_attempted = False
        LIVE_DIR.mkdir(parents=True, exist_ok=True)
        POSITION_STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        self.position_state_file = POSITION_STATE_FILE
        self.lots = self.settings["lots"] if self.settings["live"] else PAPER_LOTS
        if self.settings["live"] or self.position_state_file.exists():
            self._reconcile_position()
        print(f"[orders] mode={self.mode} lots={self.lots} loss_limit=Rs {self.settings['daily_loss_limit']:.0f}")

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

    def _order(self, symbol: str, qty: int, side: int, on_order_accepted=None) -> tuple:
        """side 1 = buy, -1 = sell. Returns (order_id, fill_price)."""
        if not self.settings["live"]:
            return "dry-run", self.option_ltp(symbol)
        return place_live_order(self.rest, symbol, qty, side, on_order_accepted=on_order_accepted)

    def _verify_open_position(self, pos: dict) -> int:
        """Return the broker-confirmed quantity only when it matches this saved position."""
        response = self.rest.positions()
        rows = response.get("netPositions")
        if response.get("s") != "ok" or not isinstance(rows, list):
            raise RuntimeError(response.get("message") or "Fyers positions response was incomplete")

        open_positions = []
        for row in rows:
            symbol = str(row.get("symbol", ""))
            if not (symbol.startswith("NSE:NIFTY") and symbol.endswith(("CE", "PE"))):
                continue
            try:
                net_qty = int(row.get("netQty") or 0)
            except (TypeError, ValueError) as exc:
                raise RuntimeError(f"Cannot read Fyers quantity for {symbol}") from exc
            if net_qty and row.get("productType") == pos.get("product_type", "INTRADAY"):
                open_positions.append(row)

        if len(open_positions) != 1:
            raise RuntimeError(f"Expected one open NIFTY INTRADAY position, found {len(open_positions)}")
        broker_position = open_positions[0]
        if broker_position.get("symbol") != pos.get("symbol"):
            raise RuntimeError(f"Fyers open position {broker_position.get('symbol')} does not match saved {pos.get('symbol')}")
        try:
            net_quantity = int(broker_position.get("netQty"))
        except (TypeError, ValueError) as exc:
            raise RuntimeError(f"Cannot read Fyers quantity for {pos.get('symbol')}") from exc
        if net_quantity <= 0 or net_quantity != int(pos.get("qty") or 0):
            raise RuntimeError(
                f"Fyers quantity {net_quantity} does not match saved quantity {pos.get('qty')} for {pos.get('symbol')}"
            )
        return net_quantity

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

    def _write_position_state(self) -> None:
        if not self.position:
            self.position_state_file.unlink(missing_ok=True)
            return
        temp = self.position_state_file.with_suffix(".tmp")
        temp.write_text(json.dumps(self.position, indent=2) + "\n", encoding="utf-8")
        temp.replace(self.position_state_file)

    def _reconcile_position(self) -> None:
        try:
            saved = json.loads(self.position_state_file.read_text(encoding="utf-8")) if self.position_state_file.exists() else None
            response = self.rest.positions()
            rows = response.get("netPositions")
            if response.get("s") != "ok" or not isinstance(rows, list):
                raise RuntimeError(response.get("message") or "broker positions response was incomplete")
        except Exception as exc:
            self._halt(f"Cannot reconcile NIFTY option positions with Fyers: {exc}")
            return

        open_positions = []
        for row in rows:
            symbol = str(row.get("symbol", ""))
            if not symbol.startswith("NSE:NIFTY") or not symbol.endswith(("CE", "PE")):
                continue
            try:
                if int(row.get("netQty") or 0) != 0:
                    open_positions.append(row)
            except (TypeError, ValueError):
                self._halt(f"Cannot read broker quantity for {symbol}; no new entries")
                return

        if not open_positions:
            if saved and (saved.get("entry_pending") or saved.get("exit_pending")):
                order_id = saved.get("exit_order_id") if saved.get("exit_pending") else saved.get("entry_order_id")
                self._halt(
                    f"Pending Fyers order {order_id or '(order ID unavailable)'} has no confirmed open position; "
                    "verify its order-book status before resuming"
                )
                return
            self.position_state_file.unlink(missing_ok=True)
            return
        if not self.settings["live"]:
            self._halt("Open NIFTY option position exists while Midpoint is PAPER; reconcile it before trading")
            return
        if not saved:
            self._halt("Untracked NIFTY option position exists at Fyers; close or reconcile it before LIVE trading")
            return
        if len(open_positions) != 1 or open_positions[0].get("symbol") != saved.get("symbol"):
            self._halt("Broker positions do not match saved Midpoint state; reconcile manually before trading")
            return

        try:
            broker_position = open_positions[0]
            if broker_position.get("productType") != saved.get("product_type", "INTRADAY"):
                raise ValueError("Fyers position product does not match saved Midpoint position")
            net_quantity = int(broker_position.get("netQty"))
            if net_quantity <= 0:
                raise ValueError(f"unexpected broker net quantity {net_quantity}")
            if saved.get("exit_pending"):
                raise RuntimeError(f"previous exit outcome is uncertain for {saved['symbol']}; verify and close at Fyers")
            saved["qty"] = net_quantity
            broker_average = float(broker_position.get("netAvg") or 0)
            if broker_average > 0:
                saved["entry_fill"] = broker_average
            if saved.get("entry_pending"):
                if broker_average <= 0:
                    raise ValueError("entry is pending but Fyers did not provide a confirmed average fill")
                saved["entry_pending"] = False
                saved["entry_order_id"] = saved.get("entry_order_id") or "reconciled"
            self.position = saved
            print(f"[orders] restored LIVE position {saved['symbol']} qty {net_quantity}")
        except Exception as exc:
            self._halt(f"Saved LIVE position needs manual reconciliation: {exc}")

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

    def _has_live_entry_funds(self, opt: pd.Series) -> bool:
        try:
            available = available_equity_funds(self.rest.funds())
            if available is None:
                print("[orders] LIVE entry blocked: available equity funds unavailable")
                return False
            quantity = int(opt["lot_size"]) * self.settings["lots"]
            premium = self.option_ltp(str(opt["symbol"]))
            if premium is None:
                print("[orders] LIVE entry blocked: option quote unavailable")
                return False
            estimated_debit = premium * quantity * 1.05
            required = max(self.settings["minimum_live_funds"], estimated_debit)
            if available < required:
                print(f"[orders] LIVE entry blocked: available Rs {available:.2f}, required Rs {required:.2f}")
                return False
        except Exception as exc:
            print(f"[orders] LIVE entry blocked: funds check failed: {exc}")
            return False
        return True

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
            qty = int(opt["lot_size"]) * (self.settings["lots"] if self.settings["live"] else PAPER_LOTS)
            if self.settings["live"] and not self._has_live_entry_funds(opt):
                self._log("SKIP", opt["symbol"], qty, "funds-check", "", index_price, "live_entry_funds_unavailable")
                return
            if self.settings["live"]:
                self.position = {
                    "symbol": opt["symbol"],
                    "product_type": "INTRADAY",
                    "qty": qty,
                    "signal_side": signal_side,
                    "entry_fill": None,
                    "index_target": index_target,
                    "index_stop": index_stop,
                    "key": key,
                    "index_entry": index_price,
                    "index_best": index_price,
                    "trailing": False,
                    "live": True,
                    "entry_pending": True,
                    "entry_order_id": None,
                    "option_quote_failures": 0,
                }
                self._write_position_state()
            def save_entry_order_id(order_id):
                self.position.update({"entry_order_id": order_id, "entry_order_status": "accepted"})
                self._write_position_state()

            order_id, fill = self._order(opt["symbol"], qty, 1, on_order_accepted=save_entry_order_id)
        except Exception as exc:
            self._halt(f"entry failed: {exc}")
            return
        if self.settings["live"]:
            self.position.update({"entry_fill": fill, "entry_pending": False, "entry_order_id": order_id,
                                  "entry_order_status": "filled"})
            self._write_position_state()
        else:
            self.position = {
                "symbol": opt["symbol"],
                "qty": qty,
                "signal_side": signal_side,
                "entry_fill": fill,
                "index_target": index_target,
                "index_stop": index_stop,
                "key": key,
                "index_entry": index_price,
                "index_best": index_price,
                "trailing": False,
                "live": False,
                "option_quote_failures": 0,
            }
        self._log("BUY", opt["symbol"], qty, order_id, fill, index_price, f"{signal_side} signal")
        print(f"[orders] {self.mode} BUY {opt['symbol']} qty {qty} @ {fill}")

    def _exit(self, reason: str, index_price: Optional[float] = None) -> None:
        pos = self.position
        if not pos or pos.get("exit_pending"):
            return
        if self.settings["live"]:
            try:
                exit_qty = self._verify_open_position(pos)
            except Exception as exc:
                self._halt(f"EXIT BLOCKED: cannot verify saved position at Fyers: {exc}")
                return
            pos["exit_pending"] = reason
            pos["exit_qty"] = exit_qty
            pos["exit_order_id"] = None
            pos["exit_order_status"] = "pending_submission"
            self._write_position_state()
        else:
            exit_qty = pos["qty"]

        def save_exit_order_id(order_id):
            pos.update({"exit_order_id": order_id, "exit_order_status": "accepted"})
            if self.settings["live"]:
                self._write_position_state()

        try:
            order_id, fill = self._order(pos["symbol"], exit_qty, -1, on_order_accepted=save_exit_order_id)
        except Exception as exc:
            self._halt(f"EXIT FAILED for {pos['symbol']}: {exc} - close it manually in Fyers")
            return
        pos["exit_order_status"] = "filled"
        if pos.get("key"):
            self.closed_keys.add(pos["key"])
        pnl = ((fill or 0) - (pos["entry_fill"] or 0)) * exit_qty
        self.day_pnl += pnl
        self._log("SELL", pos["symbol"], exit_qty, order_id, fill, index_price, reason, round(pnl, 2))
        self.position = None
        if self.settings["live"]:
            self._write_position_state()
        print(f"[orders] {self.mode} SELL {pos['symbol']} @ {fill} [{reason}] trade Rs {pnl:+,.0f} day Rs {self.day_pnl:+,.0f}")
        if self.day_pnl <= -self.settings["daily_loss_limit"]:
            self._halt(f"daily loss limit hit (Rs {self.day_pnl:,.0f})")

    def _on_tick(self, index_ltp: float) -> None:
        """Every second: index target/stop, and option-level loss limit while a position is open."""
        pos = self.position
        if not pos:
            return
        if pos.get("entry_pending") or pos.get("exit_pending"):
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
            try:
                ltp = self.option_ltp(pos["symbol"])
            except Exception as exc:
                ltp = None
                print(f"[orders] option P&L quote failed for {pos['symbol']}: {exc}")
            if ltp is None:
                pos["option_quote_failures"] = pos.get("option_quote_failures", 0) + 1
                if pos["option_quote_failures"] >= 3:
                    self._exit("option_quote_unavailable", index_ltp)
                return
            pos["option_quote_failures"] = 0
            if ltp is not None and pos["entry_fill"]:
                gain_pct = 100 * (ltp - pos["entry_fill"]) / pos["entry_fill"]
                target_pct = self.settings["option_target_pct"]
                if target_pct > 0 and gain_pct >= target_pct:
                    self._exit("option_target", index_ltp)
                    return
                open_pnl = (ltp - pos["entry_fill"]) * pos["qty"]
                if self.day_pnl + open_pnl <= -self.settings["daily_loss_limit"]:
                    self._exit("daily_loss_limit", index_ltp)
