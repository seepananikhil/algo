"""Paper-only one-lot option tracking for Midpoint and Key Levels signals."""

from __future__ import annotations

import csv
from datetime import time as datetime_time
from pathlib import Path

import pandas as pd


EVENT_FIELDS = [
    "date", "trade_id", "strategy", "event", "time", "side", "level", "break_time",
    "confirm_time", "symbol", "expiry", "qty", "spot_price", "option_price",
    "capital_used", "spot_stop", "spot_target", "option_target", "exit_spot", "exit_option",
    "pnl_rs", "return_pct", "reason", "details", "source",
]
STRIKE_STEP = 50
STRIKE_OFFSET = 100
LOTS = 1
SPOT_TARGET_POINTS = 50
PREMIUM_TARGET_RETURN_PCT = 30
MAX_HOLD_MINUTES = 30
QUOTE_INTERVAL_SECONDS = 2


def read_option_paper_trades(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries = {}
    with path.open("r", newline="", encoding="utf-8") as stream:
        for row in csv.DictReader(stream):
            trade_id = row["trade_id"]
            if row["event"] == "SKIP":
                continue
            if row["event"] == "ENTRY":
                entries[trade_id] = {
                    "date": row["date"],
                    "strategy": row["strategy"],
                    "side": row["side"],
                    "level": float(row["level"]) if row.get("level") else None,
                    "break_time": row.get("break_time", ""),
                    "confirm_time": row.get("confirm_time", ""),
                    "entry_time": row["time"],
                    "symbol": row["symbol"],
                    "expiry": row["expiry"],
                    "qty": int(row["qty"]),
                    "spot_entry": float(row["spot_price"]),
                    "option_entry": float(row["option_price"]),
                    "capital_used": float(row["capital_used"]),
                    "spot_stop": float(row["spot_stop"]) if row.get("spot_stop") else None,
                    "spot_target": float(row["spot_target"]),
                    "option_target": float(row["option_target"]),
                    "exit_time": "",
                    "exit_spot": None,
                    "exit_option": None,
                    "pnl_rs": 0.0,
                    "return_pct": 0.0,
                    "reason": "open",
                    "source": row.get("source") or "capture_paper",
                    "status": "open",
                }
            elif row["event"] == "EXIT" and trade_id in entries:
                trade = entries[trade_id]
                exit_option = float(row["exit_option"])
                pnl = round((exit_option - trade["option_entry"]) * trade["qty"], 2)
                trade.update({
                    "exit_time": row["time"],
                    "exit_spot": float(row["exit_spot"]),
                    "exit_option": exit_option,
                    "pnl_rs": pnl,
                    "return_pct": round(pnl / trade["capital_used"] * 100, 2) if trade["capital_used"] else 0.0,
                    "reason": row["reason"],
                    "status": "closed",
                })
    return sorted(entries.values(), key=lambda trade: (trade["date"], trade["entry_time"], trade["strategy"]))


class OptionPaperTracker:
    """Tracks paper option quotes only; this class never submits broker orders."""

    def __init__(self, rest, options: pd.DataFrame, event_file: Path, lots_by_strategy: dict | None = None) -> None:
        self.rest = rest
        self.options = options
        self.event_file = event_file
        self.lots_by_strategy = lots_by_strategy or {}
        self.positions = {}
        self.seen = set()
        for trade in read_option_paper_trades(event_file):
            trade_id = f"{trade['strategy']}|{trade['date']}|{trade['entry_time']}|{trade['side']}"
            self.seen.add(trade_id)
            if trade["status"] == "open":
                timestamp = pd.Timestamp(f"{trade['date']} {trade['entry_time']}").tz_localize("Asia/Kolkata")
                self.positions[trade["strategy"]] = {
                    **trade,
                    "trade_id": trade_id,
                    "entry_timestamp": timestamp,
                    "last_quote_timestamp": timestamp,
                    "last_option_price": trade["option_entry"],
                }

    def _append(self, row: dict) -> None:
        self.event_file.parent.mkdir(parents=True, exist_ok=True)
        new = not self.event_file.exists()
        with self.event_file.open("a", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=EVENT_FIELDS)
            if new:
                writer.writeheader()
            writer.writerow({field: row.get(field, "") for field in EVENT_FIELDS})

    def _option_row(self, side: str, spot: float, timestamp: pd.Timestamp) -> pd.Series:
        atm = round(spot / STRIKE_STEP) * STRIKE_STEP
        # The requested ATM+100 CE / ATM-100 PE formula is 100 points OTM.
        strike = atm + STRIKE_OFFSET if side == "CALL" else atm - STRIKE_OFFSET
        option_type = "CE" if side == "CALL" else "PE"
        valid = self.options[(self.options["expiry"] >= timestamp.date()) & (self.options["strike"] == strike) & (self.options["opt_type"] == option_type)]
        if valid.empty:
            raise RuntimeError(f"no {option_type} contract for strike {strike:g}")
        expiry = min(valid["expiry"])
        return valid[valid["expiry"] == expiry].iloc[0]

    def _quote(self, symbol: str) -> float:
        response = self.rest.quotes(data={"symbols": symbol})
        if response.get("s") != "ok" or not response.get("d"):
            raise RuntimeError(response.get("message") or "option quote unavailable")
        return float(response["d"][0]["v"]["lp"])

    def on_signal(
        self,
        strategy: str,
        side: str,
        spot: float,
        timestamp,
        level: float | None = None,
        break_time: str = "",
        confirm_time: str = "",
        stop_price: float | None = None,
        spot_target: float | None = None,
    ) -> None:
        timestamp = pd.Timestamp(timestamp)
        if timestamp.tzinfo is None:
            timestamp = timestamp.tz_localize("Asia/Kolkata")
        else:
            timestamp = timestamp.tz_convert("Asia/Kolkata")
        trade_id = f"{strategy}|{timestamp:%Y-%m-%d}|{timestamp:%H:%M:%S}|{side}"
        if trade_id in self.seen or strategy in self.positions:
            return
        self.seen.add(trade_id)
        try:
            contract = self._option_row(side, float(spot), timestamp)
            symbol = str(contract["symbol"])
            qty = int(contract["lot_size"]) * int(self.lots_by_strategy.get(strategy, LOTS))
            option_price = self._quote(symbol)
            if option_price <= 0:
                raise RuntimeError("option quote was not positive")
        except Exception as exc:
            self._append({
                "date": timestamp.strftime("%Y-%m-%d"), "trade_id": trade_id, "strategy": strategy,
                "event": "SKIP", "time": timestamp.strftime("%H:%M:%S"), "side": side,
                "spot_price": round(float(spot), 2), "reason": "option_quote_or_contract_unavailable", "details": str(exc),
            })
            return

        capital = round(option_price * qty, 2)
        spot_target = spot_target if spot_target is not None else (float(spot) + SPOT_TARGET_POINTS if side == "CALL" else float(spot) - SPOT_TARGET_POINTS)
        option_target = option_price * (1 + PREMIUM_TARGET_RETURN_PCT / 100)
        expiry = contract["expiry"].isoformat()
        position = {
            "trade_id": trade_id,
            "strategy": strategy,
            "date": timestamp.strftime("%Y-%m-%d"),
            "entry_time": timestamp.strftime("%H:%M:%S"),
            "entry_timestamp": timestamp,
            "last_quote_timestamp": timestamp,
            "last_option_price": option_price,
            "side": side,
            "level": level,
            "break_time": break_time,
            "confirm_time": confirm_time,
            "symbol": symbol,
            "expiry": expiry,
            "qty": qty,
            "spot_entry": float(spot),
            "option_entry": option_price,
            "capital_used": capital,
            "spot_stop": float(stop_price) if stop_price is not None else None,
            "spot_target": spot_target,
            "option_target": option_target,
        }
        self.positions[strategy] = position
        self._append({
            "date": position["date"], "trade_id": trade_id, "strategy": strategy, "event": "ENTRY",
            "time": position["entry_time"], "side": side, "level": level or "",
            "break_time": break_time, "confirm_time": confirm_time, "symbol": symbol, "expiry": expiry,
            "qty": qty, "spot_price": round(float(spot), 2), "option_price": round(option_price, 2),
            "capital_used": capital, "spot_stop": stop_price if stop_price is not None else "",
            "spot_target": round(spot_target, 2), "option_target": round(option_target, 2),
        })

    def on_tick(self, timestamp, spot: float) -> None:
        timestamp = pd.Timestamp(timestamp)
        if timestamp.tzinfo is None:
            timestamp = timestamp.tz_localize("Asia/Kolkata")
        else:
            timestamp = timestamp.tz_convert("Asia/Kolkata")
        for strategy, position in list(self.positions.items()):
            if (timestamp - position["last_quote_timestamp"]).total_seconds() >= QUOTE_INTERVAL_SECONDS:
                try:
                    position["last_option_price"] = self._quote(position["symbol"])
                    position["last_quote_timestamp"] = timestamp
                except Exception:
                    pass
            option_price = position["last_option_price"]
            stop_hit = (
                position["spot_stop"] is not None
                and (float(spot) <= position["spot_stop"] if position["side"] == "CALL" else float(spot) >= position["spot_stop"])
            )
            target_hit = float(spot) >= position["spot_target"] if position["side"] == "CALL" else float(spot) <= position["spot_target"]
            if stop_hit:
                reason = "spot_stop_zone"
            elif target_hit:
                reason = "spot_target_50"
            elif option_price >= position["option_target"]:
                reason = "premium_return_30pct"
            elif strategy != "key_levels" and timestamp >= position["entry_timestamp"] + pd.Timedelta(minutes=MAX_HOLD_MINUTES):
                reason = "time_exit_30m"
            elif timestamp.time() >= datetime_time(15, 30):
                reason = "session_end"
            else:
                continue
            self._exit(strategy, timestamp, float(spot), option_price, reason)

    def close(self, timestamp, spot: float, reason: str = "session_end") -> None:
        timestamp = pd.Timestamp(timestamp)
        for strategy, position in list(self.positions.items()):
            self._exit(strategy, timestamp, float(spot), position["last_option_price"], reason)

    def _exit(self, strategy: str, timestamp, spot: float, option_price: float, reason: str) -> None:
        position = self.positions.pop(strategy, None)
        if not position:
            return
        pnl = (option_price - position["option_entry"]) * position["qty"]
        return_pct = pnl / position["capital_used"] * 100 if position["capital_used"] else 0.0
        self._append({
            "date": position["date"], "trade_id": position["trade_id"], "strategy": strategy, "event": "EXIT",
            "time": timestamp.strftime("%H:%M:%S"), "side": position["side"], "level": position["level"] or "",
            "symbol": position["symbol"], "expiry": position["expiry"], "qty": position["qty"],
            "spot_stop": position["spot_stop"] if position["spot_stop"] is not None else "",
            "exit_spot": round(spot, 2), "exit_option": round(option_price, 2), "pnl_rs": round(pnl, 2),
            "return_pct": round(return_pct, 2), "reason": reason,
        })