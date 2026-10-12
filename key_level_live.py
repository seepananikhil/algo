"""Real Fyers market orders that mirror Key Levels option entries and exits (LIVE mode only)."""

from __future__ import annotations

import csv
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fyers_orders import STOP_FILE, available_equity_funds, place_live_order

ROOT = Path(__file__).resolve().parent
ORDER_DIR = ROOT / "captured_data" / "fyers" / "key_levels"
IST = timezone(timedelta(hours=5, minutes=30))
ORDER_HEADER = ["date", "time", "action", "symbol", "qty", "order_id", "fill_price", "reason", "status", "day_pnl_rs"]


class KeyLevelLiveExecutor:
    """Fails closed: any rejected or unconfirmed entry halts further live entries for the day."""

    def __init__(self, rest, config: dict) -> None:
        self.rest = rest
        self.minimum_funds = float(config.get("minimum_live_funds", 25000))
        self.loss_limit = float(config.get("daily_loss_limit", 1000))
        self.day_pnl = 0.0
        self.halted: str | None = None
        self.entry_fills: dict[str, float] = {}
        self.exit_retry_after: dict[str, float] = {}

    def _log(self, action: str, symbol: str, qty: int, order_id: str, fill, reason: str, status: str) -> None:
        now = datetime.now(IST)
        path = ORDER_DIR / f"key_level_live_orders_{now:%Y-%m-%d}.csv"
        ORDER_DIR.mkdir(parents=True, exist_ok=True)
        new = not path.exists()
        with path.open("a", newline="", encoding="utf-8") as stream:
            writer = csv.writer(stream)
            if new:
                writer.writerow(ORDER_HEADER)
            writer.writerow([f"{now:%Y-%m-%d}", f"{now:%H:%M:%S}", action, symbol, qty, order_id, fill, reason, status, round(self.day_pnl, 2)])

    def _halt(self, reason: str) -> None:
        if not self.halted:
            self.halted = reason
            print(f"[key-levels] LIVE entries halted: {reason}")

    def buy(self, symbol: str, qty: int, premium: float) -> float | None:
        """Return the fill price, or None when no real order was placed (the paper trade still proceeds)."""
        if STOP_FILE.exists():
            self._log("SKIP", symbol, qty, "", "", "kill_switch_on", "not_submitted")
            return None
        if self.halted:
            self._log("SKIP", symbol, qty, "", "", self.halted, "not_submitted")
            return None
        try:
            available = available_equity_funds(self.rest.funds())
            if available is None:
                self._log("SKIP", symbol, qty, "", "", "available_funds_unavailable", "not_submitted")
                return None
            required = max(self.minimum_funds, premium * qty * 1.05)
            if available < required:
                self._log("SKIP", symbol, qty, "", "", f"insufficient_funds_{available:.0f}_of_{required:.0f}", "not_submitted")
                return None
            order_id, fill = place_live_order(self.rest, symbol, qty, 1)
        except Exception as exc:
            message = str(exc)
            self._halt(message)
            self._log("BUY", symbol, qty, "", "", message, "failed")
            if not message.startswith("order rejected"):
                print(f"[key-levels] CRITICAL: BUY {symbol} may be open at the broker; check Fyers positions")
            return None
        fill = fill if fill > 0 else premium
        self.entry_fills[symbol] = fill
        self._log("BUY", symbol, qty, order_id, fill, "key_levels_entry", "filled")
        print(f"[key-levels] LIVE BUY {symbol} qty {qty} @ {fill}")
        return fill

    def sell(self, symbol: str, qty: int, reason: str) -> float | None:
        now = time.monotonic()
        if now < self.exit_retry_after.get(symbol, 0):
            return None
        for attempt in (1, 2):
            try:
                order_id, fill = place_live_order(self.rest, symbol, qty, -1)
                break
            except Exception as exc:
                self._log("SELL", symbol, qty, "", "", f"attempt {attempt}: {exc}", "failed")
                if attempt == 2:
                    self.exit_retry_after[symbol] = time.monotonic() + 10
                    print(f"[key-levels] CRITICAL: LIVE exit failed for {symbol}; close it manually: {exc}")
                    return None
        self.exit_retry_after.pop(symbol, None)
        entry = self.entry_fills.pop(symbol, None)
        if fill > 0 and entry is not None:
            self.day_pnl += (fill - entry) * qty
            if self.day_pnl <= -self.loss_limit:
                self._halt(f"daily loss limit hit (Rs {self.day_pnl:,.0f})")
        self._log("SELL", symbol, qty, order_id, fill, reason, "filled")
        print(f"[key-levels] LIVE SELL {symbol} qty {qty} @ {fill} [{reason}]")
        return fill if fill > 0 else None
