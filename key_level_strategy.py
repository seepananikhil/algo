"""Five-minute key-level breakout rules and spot-only replay."""

from __future__ import annotations

import math
import csv
from typing import Optional
from pathlib import Path

import pandas as pd


DEFAULTS = {
    "key_levels_paper_enabled": True,
    "key_level_step": 500,
    "key_level_break_buffer": 10,
    "key_level_confirm_candles": 2,
    "key_level_target_points": 50,
}
BAR_MINUTES = 5
ZONE_TOUCH_TOLERANCE = 2.0
EVENT_FIELDS = [
    "date", "trade_id", "event", "time", "side", "level", "break_time",
    "confirm_time", "spot_price", "stop_price", "target_price", "pnl_points", "reason",
]


def settings_from_config(config: dict) -> dict:
    """Strategy rules are fixed; only the paper-tracking switch comes from config."""
    settings = DEFAULTS.copy()
    settings["key_levels_paper_enabled"] = bool(config.get("key_levels_paper_enabled", settings["key_levels_paper_enabled"]))
    return settings


def aggregate_five_minute(minute_candles: pd.DataFrame) -> pd.DataFrame:
    """Aggregate complete five-row 1-minute groups, excluding partial buckets."""
    columns = ["timestamp", "open", "high", "low", "close"]
    if minute_candles.empty or not set(columns).issubset(minute_candles.columns):
        return pd.DataFrame(columns=columns)

    work = minute_candles[columns].copy()
    work["timestamp"] = pd.to_datetime(work["timestamp"], errors="coerce")
    work = work.dropna(subset=columns).sort_values("timestamp")
    work["bucket"] = work["timestamp"].dt.floor("5min")
    bars = work.groupby("bucket", sort=True).agg(
        row_count=("timestamp", "size"),
        minute_count=("timestamp", "nunique"),
        first_minute=("timestamp", "min"),
        last_minute=("timestamp", "max"),
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
    )
    complete = (
        (bars["row_count"] == BAR_MINUTES)
        & (bars["minute_count"] == BAR_MINUTES)
        & (bars["first_minute"] == bars.index)
        & (bars["last_minute"] == bars.index + pd.Timedelta(minutes=BAR_MINUTES - 1))
    )
    bars = bars.loc[complete, ["open", "high", "low", "close"]].reset_index(names="timestamp")
    return bars[columns]


def _crossed_levels(previous_close: float, breakout_close: float, step: int) -> list[int]:
    low, high = sorted((previous_close, breakout_close))
    first = math.ceil(low / step)
    last = math.floor(high / step)
    return [index * step for index in range(first, last + 1)]


def confirmed_signal(bars: pd.DataFrame, confirmation_idx: int, settings: dict) -> Optional[dict]:
    """Return a signal after the break bar and configured confirming closes."""
    closes = bars["close"].to_numpy(dtype=float, copy=False)
    highs = bars["high"].to_numpy(dtype=float, copy=False)
    lows = bars["low"].to_numpy(dtype=float, copy=False)
    return _confirmed_signal_from_arrays(closes, highs, lows, confirmation_idx, settings)


def _confirmed_signal_from_arrays(closes, highs, lows, confirmation_idx: int, settings: dict) -> Optional[dict]:
    confirms = settings["key_level_confirm_candles"]
    breakout_idx = confirmation_idx - confirms
    if breakout_idx <= 0 or confirmation_idx >= len(closes):
        return None

    previous_close = closes[breakout_idx - 1]
    breakout_close = closes[breakout_idx]
    follow_closes = closes[breakout_idx + 1:confirmation_idx + 1]
    follow_highs = highs[breakout_idx + 1:confirmation_idx + 1]
    follow_lows = lows[breakout_idx + 1:confirmation_idx + 1]
    candidates = []
    for level in _crossed_levels(previous_close, breakout_close, settings["key_level_step"]):
        if previous_close < level and breakout_close >= level + settings["key_level_break_buffer"]:
            sustained = all(close > level for close in follow_closes)
            touched_zone = any(
                low <= level + settings["key_level_break_buffer"] + ZONE_TOUCH_TOLERANCE
                and high >= level - settings["key_level_break_buffer"] - ZONE_TOUCH_TOLERANCE
                for high, low in zip(follow_highs, follow_lows)
            )
            if sustained and touched_zone:
                candidates.append((abs(breakout_close - level), level, "CALL"))
        elif previous_close > level and breakout_close <= level - settings["key_level_break_buffer"]:
            sustained = all(close < level for close in follow_closes)
            touched_zone = any(
                low <= level + settings["key_level_break_buffer"] + ZONE_TOUCH_TOLERANCE
                and high >= level - settings["key_level_break_buffer"] - ZONE_TOUCH_TOLERANCE
                for high, low in zip(follow_highs, follow_lows)
            )
            if sustained and touched_zone:
                candidates.append((abs(breakout_close - level), level, "PUT"))
    if not candidates:
        return None

    _, level, side = min(candidates)
    entry_idx = confirmation_idx + 1
    return {
        "break_idx": breakout_idx,
        "confirmation_idx": confirmation_idx,
        "entry_idx": entry_idx,
        "level": level,
        "side": side,
        "stop": level - settings["key_level_break_buffer"] if side == "CALL" else level + settings["key_level_break_buffer"],
    }


def _simulate_trade(bars: pd.DataFrame, signal: dict, settings: dict, minute_candles: pd.DataFrame) -> dict:
    entry_idx = signal["entry_idx"]
    entry = float(bars.iloc[entry_idx]["open"])
    is_call = signal["side"] == "CALL"
    stop = float(signal["stop"])
    target = entry + settings["key_level_target_points"] if is_call else entry - settings["key_level_target_points"]
    last_idx = len(bars) - 1

    status = "open"
    for idx in range(entry_idx, last_idx + 1):
        candle = bars.iloc[idx]
        bucket_start = candle["timestamp"]
        minute_rows = minute_candles[
            (minute_candles["timestamp"] >= bucket_start)
            & (minute_candles["timestamp"] < bucket_start + pd.Timedelta(minutes=BAR_MINUTES))
        ]
        for minute in minute_rows.itertuples(index=False):
            stop_hit = float(minute.low) <= stop if is_call else float(minute.high) >= stop
            if stop_hit:
                open_price = float(minute.open)
                exit_time = minute.timestamp
                exit_price = min(open_price, stop) if is_call else max(open_price, stop)
                exit_idx = idx
                reason = "stop_zone"
                status = "closed"
                break
            target_hit = float(minute.high) >= target if is_call else float(minute.low) <= target
            if target_hit:
                exit_time = minute.timestamp
                exit_price = target
                exit_idx = idx
                reason = "target"
                status = "closed"
                break
        if status == "closed":
            break

    if status != "closed":
        final = bars.iloc[last_idx]
        bucket_end = final["timestamp"] + pd.Timedelta(minutes=BAR_MINUTES)
        minute_rows = minute_candles[
            (minute_candles["timestamp"] >= final["timestamp"])
            & (minute_candles["timestamp"] < bucket_end)
        ]
        if minute_rows.empty:
            exit_price = float(final["close"])
            exit_time = bucket_end
        else:
            last_minute = minute_rows.iloc[-1]
            exit_price = float(last_minute["close"])
            exit_time = last_minute["timestamp"] + pd.Timedelta(minutes=1)
        exit_idx = last_idx
        session_close = final["timestamp"].normalize() + pd.Timedelta(hours=15, minutes=30)
        session_end = bucket_end >= session_close
        reason = "session_end" if session_end else "open"
        status = "closed" if session_end else "open"

    pnl_points = exit_price - entry if is_call else entry - exit_price
    return {
        "date": bars.iloc[entry_idx]["timestamp"].strftime("%Y-%m-%d"),
        "side": signal["side"],
        "level": float(signal["level"]),
        "break_time": bars.iloc[signal["break_idx"]]["timestamp"].strftime("%H:%M"),
        "confirm_time": bars.iloc[signal["confirmation_idx"]]["timestamp"].strftime("%H:%M"),
        "entry_time": bars.iloc[entry_idx]["timestamp"].strftime("%H:%M"),
        "entry_price": round(entry, 2),
        "stop": round(stop, 2),
        "target": round(target, 2),
        "exit_time": exit_time.strftime("%H:%M") if status == "closed" else "",
        "exit_price": round(exit_price, 2),
        "_exit_idx": exit_idx,
        "pnl_points": round(pnl_points, 2),
        "exit_reason": reason,
        "status": status,
    }


def backtest_key_levels(minute_candles: pd.DataFrame, config: dict | None = None) -> list[dict]:
    """Replay one-at-a-time 5-minute break-and-hold trades on 1-minute index data."""
    settings = settings_from_config(config or {})
    bars = aggregate_five_minute(minute_candles)
    if bars.empty:
        return []

    bars["date"] = bars["timestamp"].dt.strftime("%Y-%m-%d")
    minute_work = minute_candles.copy()
    minute_work["timestamp"] = pd.to_datetime(minute_work["timestamp"], errors="coerce")
    minute_work["date"] = minute_work["timestamp"].dt.strftime("%Y-%m-%d")
    minute_by_day = {
        day: group.drop(columns="date").reset_index(drop=True)
        for day, group in minute_work.groupby("date", sort=True)
    }
    trades = []
    for _, day in bars.groupby("date", sort=True):
        day = day.reset_index(drop=True)
        minute_day = minute_by_day.get(str(day["date"].iloc[0]), pd.DataFrame())
        closes = day["close"].to_numpy(dtype=float, copy=False)
        highs = day["high"].to_numpy(dtype=float, copy=False)
        lows = day["low"].to_numpy(dtype=float, copy=False)
        next_allowed_idx = 1
        side_filter = None
        day_trades = []
        confirms = settings["key_level_confirm_candles"]
        for confirmation_idx in range(1 + confirms, len(day) - 1):
            if confirmation_idx < next_allowed_idx:
                continue
            signal = _confirmed_signal_from_arrays(closes, highs, lows, confirmation_idx, settings)
            if signal is None or (side_filter is not None and signal["side"] != side_filter):
                continue
            trade = _simulate_trade(day, signal, settings, minute_day)
            exit_idx = trade.pop("_exit_idx")
            trades.append(trade)
            day_trades.append(trade)
            next_allowed_idx = exit_idx + 1
            if trade["status"] == "open" or trade["pnl_points"] >= 0 or len(day_trades) >= 3:
                break
            if len(day_trades) == 1:
                side_filter = "PUT" if signal["side"] == "CALL" else "CALL"
            else:
                side_filter = None
    return trades


def summarize_key_level_trades(trades: list[dict]) -> dict:
    closed = [trade for trade in trades if trade["status"] == "closed"]
    pnl = [float(trade["pnl_points"]) for trade in closed]
    equity = peak = max_drawdown = 0.0
    for result in pnl:
        equity += result
        peak = max(peak, equity)
        max_drawdown = min(max_drawdown, equity - peak)
    wins = sum(result > 0 for result in pnl)
    return {
        "trades": len(closed),
        "open_trades": len(trades) - len(closed),
        "wins": wins,
        "losses": len(closed) - wins,
        "win_rate_pct": round(100 * wins / len(closed), 2) if closed else 0.0,
        "net_points": round(sum(pnl), 2),
        "avg_points": round(sum(pnl) / len(pnl), 2) if pnl else 0.0,
        "max_drawdown_points": round(max_drawdown, 2),
    }


def read_paper_events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    entries = {}
    for row in csv.DictReader(path.open("r", newline="", encoding="utf-8")):
        trade_id = row["trade_id"]
        if row["event"] == "ENTRY":
            entries[trade_id] = {
                "date": row["date"],
                "side": row["side"],
                "level": float(row["level"]),
                "break_time": row["break_time"],
                "confirm_time": row["confirm_time"],
                "entry_time": row["time"],
                "entry_price": float(row["spot_price"]),
                "stop": float(row["stop_price"]) if row.get("stop_price") else None,
                "exit_time": "",
                "exit_price": None,
                "pnl_points": 0.0,
                "exit_reason": "open",
                "status": "open",
                "source": "paper",
            }
        elif row["event"] == "EXIT" and trade_id in entries:
            trade = entries[trade_id]
            exit_price = float(row["spot_price"])
            trade.update({
                "exit_time": row["time"],
                "exit_price": exit_price,
                "pnl_points": round(exit_price - trade["entry_price"] if trade["side"] == "CALL" else trade["entry_price"] - exit_price, 2),
                "exit_reason": row["reason"],
                "status": "closed",
            })
    return sorted(entries.values(), key=lambda trade: (trade["date"], trade["entry_time"]))


class KeyLevelPaperTracker:
    """Paper-only intraday tracker; it never submits broker orders."""

    def __init__(self, event_file: Path, settings: dict, entry_callback=None) -> None:
        self.event_file = event_file
        self.settings = settings_from_config(settings)
        self.entry_callback = entry_callback
        self.last_bucket = None
        self.pending = None
        self.position = None
        self.processed_ids = set()
        self.session_date = pd.Timestamp.now(tz="Asia/Kolkata").strftime("%Y-%m-%d")
        self.day_trade_count = 0
        self.side_filter = None
        self.halted_today = False
        session_trades = [trade for trade in read_paper_events(event_file) if trade["date"] == self.session_date]
        self.day_trade_count = len(session_trades)
        for trade in read_paper_events(event_file):
            self.processed_ids.add(self._trade_id(trade["date"], trade["break_time"], trade["level"], trade["side"]))
            if trade["status"] == "open":
                self.position = trade
        closed_today = [trade for trade in session_trades if trade["status"] == "closed"]
        if self.day_trade_count >= 3 or (closed_today and closed_today[-1]["pnl_points"] >= 0):
            self.halted_today = True
        elif len(closed_today) == 1:
            self.side_filter = "PUT" if closed_today[-1]["side"] == "CALL" else "CALL"

    @staticmethod
    def _trade_id(date: str, break_time: str, level: float, side: str) -> str:
        return f"{date}|{break_time}|{level:g}|{side}"

    def _append(self, event: dict) -> None:
        self.event_file.parent.mkdir(parents=True, exist_ok=True)
        new = not self.event_file.exists()
        with self.event_file.open("a", newline="", encoding="utf-8") as stream:
            writer = csv.DictWriter(stream, fieldnames=EVENT_FIELDS)
            if new:
                writer.writeheader()
            writer.writerow({field: event.get(field, "") for field in EVENT_FIELDS})

    def on_completed_minutes(self, minute_candles: pd.DataFrame) -> None:
        if not self.settings["key_levels_paper_enabled"] or self.halted_today or self.day_trade_count >= 3:
            return
        bars = aggregate_five_minute(minute_candles)
        if bars.empty:
            return
        if self.last_bucket is None:
            self.last_bucket = bars.iloc[-1]["timestamp"]
            return

        for idx, bar in bars.iterrows():
            if bar["timestamp"] <= self.last_bucket:
                continue
            self.last_bucket = bar["timestamp"]
            if self.pending or self.position:
                continue
            signal = confirmed_signal(bars, idx, self.settings)
            if signal is None or (self.side_filter is not None and signal["side"] != self.side_filter):
                continue
            break_time = bars.iloc[signal["break_idx"]]["timestamp"].strftime("%H:%M")
            trade_id = self._trade_id(bar["timestamp"].strftime("%Y-%m-%d"), break_time, signal["level"], signal["side"])
            if trade_id in self.processed_ids:
                continue
            self.pending = {
                "trade_id": trade_id,
                "date": bar["timestamp"].strftime("%Y-%m-%d"),
                "entry_time": bar["timestamp"] + pd.Timedelta(minutes=BAR_MINUTES),
                "side": signal["side"],
                "level": signal["level"],
                "break_time": break_time,
                "confirm_time": bar["timestamp"].strftime("%H:%M"),
                "stop": signal["stop"],
                "target": signal["stop"] + settings_from_config(self.settings)["key_level_target_points"] if signal["side"] == "CALL" else signal["stop"] - settings_from_config(self.settings)["key_level_target_points"],
            }
            break

    def on_completed_minute_file(self, path: Path) -> None:
        if path.exists():
            self.on_completed_minutes(pd.read_csv(path))

    def on_tick(self, timestamp, spot_price: float) -> None:
        if not self.settings["key_levels_paper_enabled"]:
            return
        timestamp = pd.Timestamp(timestamp)
        price = float(spot_price)
        if self.pending:
            entry_time = self.pending["entry_time"]
            if entry_time <= timestamp < entry_time + pd.Timedelta(minutes=BAR_MINUTES):
                side = self.pending["side"]
                target = price + self.settings["key_level_target_points"] if side == "CALL" else price - self.settings["key_level_target_points"]
                self.position = {**self.pending, "entry_price": price, "target": target, "entry_tick_time": timestamp}
                self.processed_ids.add(self.pending["trade_id"])
                self.day_trade_count += 1
                self._append({
                    "date": self.pending["date"], "trade_id": self.pending["trade_id"], "event": "ENTRY",
                    "time": timestamp.strftime("%H:%M:%S"), "side": side, "level": self.pending["level"],
                    "break_time": self.pending["break_time"], "confirm_time": self.pending["confirm_time"],
                    "spot_price": round(price, 2), "stop_price": self.pending["stop"], "target_price": round(target, 2),
                })
                if self.entry_callback:
                    self.entry_callback(
                        "key_levels", side, price, timestamp,
                        level=self.pending.get("level"),
                        break_time=self.pending.get("break_time", ""),
                        confirm_time=self.pending.get("confirm_time", ""),
                        stop_price=self.pending["stop"],
                        spot_target=target,
                    )
                self.pending = None
            elif timestamp >= entry_time + pd.Timedelta(minutes=BAR_MINUTES):
                self.pending = None

        if not self.position:
            return
        position = self.position
        hit_stop = price <= position["stop"] if position["side"] == "CALL" else price >= position["stop"]
        if hit_stop:
            self._exit(timestamp, position["stop"], "stop_zone")
            return
        hit_target = price >= position["target"] if position["side"] == "CALL" else price <= position["target"]
        if hit_target:
            self._exit(timestamp, position["target"], "target")

    def close(self, timestamp, spot_price: float, reason: str = "session_end") -> None:
        if self.position:
            self._exit(pd.Timestamp(timestamp), float(spot_price), reason)

    def _exit(self, timestamp, price: float, reason: str) -> None:
        position = self.position
        if not position:
            return
        spot_pnl = price - position["entry_price"] if position["side"] == "CALL" else position["entry_price"] - price
        self._append({
            "date": position["date"], "trade_id": position["trade_id"], "event": "EXIT",
            "time": pd.Timestamp(timestamp).strftime("%H:%M:%S"), "side": position["side"],
            "level": position["level"], "spot_price": round(price, 2), "stop_price": position["stop"], "reason": reason,
        })
        self.position = None
        if spot_pnl >= 0 or self.day_trade_count >= 3:
            self.halted_today = True
            self.side_filter = None
        elif self.day_trade_count == 1:
            self.side_filter = "PUT" if position["side"] == "CALL" else "CALL"
        elif self.day_trade_count == 2:
            self.side_filter = None
        else:
            self.halted_today = True