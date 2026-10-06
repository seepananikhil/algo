"""Real-time paper signals: re-run the strategy on today's candles after every 1-min close."""

from __future__ import annotations

import csv
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Set

import pandas as pd

from backtest_midpoint_strategy import load_data
from midpoint_strategy import TARGET_POINTS, backtest_midpoint_strategy, entry_stop, entry_too_far, pending_entry

IST = timezone(timedelta(hours=5, minutes=30))
HEADER = ["detected_at", "event", "side", "entry_time", "candle_time", "price", "mid_point", "sl", "target", "reason", "pnl_points"]
LOT_SIZE = 65  # NIFTY lot size; verify with your broker
LEDGER_HEADER = ["date", "side", "entry_time", "entry_price", "exit_time", "exit_price", "exit_reason", "points", "rupees_1_lot"]


def notify(title: str, text: str) -> None:
    print("\a", end="", flush=True)
    try:
        subprocess.run(
            ["osascript", "-e", f'display notification "{text}" with title "{title}" sound name "Glass"'],
            check=False,
            capture_output=True,
            timeout=5,
        )
    except Exception:
        pass


class LiveSignalEngine:
    def __init__(self, candles_file: Path, signals_file: Path, trader=None) -> None:
        self.candles_file = candles_file
        self.signals_file = signals_file
        self.trader = trader
        self.seen: Set[str] = set()
        self.watch: Optional[dict] = None
        self.fills: dict = {}
        self.ledger_file = signals_file.parent / "paper_trades.csv"
        if signals_file.exists():
            with signals_file.open("r", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    self.seen.add(f"{row['event']}|{row['side']}|{row['entry_time']}")
                    if row["event"] == "ENTRY":
                        self.fills.setdefault(f"{row['side']}|{row['entry_time']}", float(row["price"]))

    def _emit(self, key: str, row: list, title: str, text: str) -> None:
        self.seen.add(key)
        new = not self.signals_file.exists()
        with self.signals_file.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(HEADER)
            w.writerow(row)
        print(f"*** {title}: {text}")
        notify(title, text)

    def check_tick(self, ltp: float, now: datetime) -> None:
        """Called every second: fire ENTRY on the first tick that trades into the buffer."""
        w = self.watch
        if not w or now.strftime("%H:%M") != w["candle_time"].strftime("%H:%M"):
            return
        hit = w.get("market") or (ltp <= w["level"] if w["side"] == "LONG" else ltp >= w["level"])
        if not hit:
            return
        self.watch = None
        side = "CALL" if w["side"] == "LONG" else "PUT"
        key = f"ENTRY|{side}|{w['candle_time']:%H:%M}"
        if key in self.seen:
            return
        # Watch carries the range-edge stop for its side; same rules as the backtest.
        levels = {"mid": w["mid"], "ref_low": w["stop"], "ref_high": w["stop"]}
        if entry_too_far(levels, w["side"], ltp):
            print(f"[{now:%H:%M:%S}] SKIP {side}: entry {ltp:.2f} is more than the max distance from mid {w['mid']:.2f}")
            return
        stop = entry_stop(levels, w["side"], ltp)
        target = ltp + TARGET_POINTS if w["side"] == "LONG" else ltp - TARGET_POINTS
        self.fills[f"{side}|{w['candle_time']:%H:%M}"] = ltp
        self._emit(
            key,
            [now.strftime("%H:%M:%S"), "ENTRY", side, f"{w['candle_time']:%H:%M}", now.strftime("%H:%M:%S"), round(ltp, 2),
             round(w["mid"], 2), round(stop, 2), round(target, 2), "wick_rejection_1s" if w.get("market") else "buffer_touch_1s", ""],
            f"ENTRY {side}",
            f"{now:%H:%M:%S} @ {ltp:.2f} | SL {stop:.2f} TGT {target:.2f} mid {w['mid']:.2f}",
        )
        if self.trader:
            self.trader.enter(side, ltp, target, stop, key=f"{side}|{w['candle_time']:%H:%M}")

    def evaluate(self) -> None:
        if not self.candles_file.exists():
            return
        df = load_data(str(self.candles_file))
        if df.empty:
            return
        trades = backtest_midpoint_strategy(df)
        self.watch = pending_entry(df)
        if self.watch:
            w = self.watch
            side = "CALL" if w["side"] == "LONG" else "PUT"
            how = "at market (midpoint wick rejection)" if w.get("market") else f"if price reaches {w['level']:.2f}"
            print(f"[{datetime.now(IST):%H:%M:%S}] ARMED {side}: {w['candle_time']:%H:%M} candle, enter {how} (mid {w['mid']:.2f})")
        if trades.empty:
            return

        last_candle = df["timestamp"].iloc[-1]
        detected = datetime.now(IST).strftime("%H:%M:%S")
        option = {"LONG": "CALL", "SHORT": "PUT"}

        for t in trades.itertuples(index=False):
            entry_ts = pd.Timestamp(t.entry_time)
            exit_ts = pd.Timestamp(t.exit_time)
            side = option[t.side]
            entry_key = f"ENTRY|{side}|{entry_ts:%H:%M}"
            if entry_key not in self.seen:
                late = f" (LATE, seen at {last_candle:%H:%M} close)" if entry_ts < last_candle else ""
                self._emit(
                    entry_key,
                    [detected, "ENTRY", side, f"{entry_ts:%H:%M}", f"{entry_ts:%H:%M}", round(t.entry, 2), round(t.midpoint, 2),
                     round(t.stop, 2), round(t.target, 2), "", ""],
                    f"ENTRY {side}{late}",
                    f"{entry_ts:%H:%M} close {t.entry:.2f} | SL {t.stop:.2f} TGT {t.target:.2f} mid {t.midpoint:.2f}",
                )
                self.fills.setdefault(f"{side}|{entry_ts:%H:%M}", t.entry)
                # Stale signals (seen after a later candle closed) are logged but not traded.
                if self.trader and not late:
                    self.trader.enter(side, t.entry, t.target, t.stop, key=f"{side}|{entry_ts:%H:%M}")

            closed = not t.reason.endswith("open")
            exit_key = f"EXIT|{side}|{entry_ts:%H:%M}"
            if closed and exit_key not in self.seen:
                fill = self.fills.get(f"{side}|{entry_ts:%H:%M}", t.entry)
                points = t.exit_price - fill if t.side == "LONG" else fill - t.exit_price
                self._emit(
                    exit_key,
                    [detected, "EXIT", side, f"{entry_ts:%H:%M}", f"{exit_ts:%H:%M}", round(t.exit_price, 2), round(t.midpoint, 2),
                     round(t.stop, 2), round(t.target, 2), t.reason, round(points, 2)],
                    f"EXIT {side} {points:+.2f} pts (Rs {points * LOT_SIZE:+,.0f})",
                    f"{exit_ts:%H:%M} @ {t.exit_price:.2f} [{t.reason}]",
                )
                self._record_paper_trade(entry_ts, side, fill, exit_ts, t.exit_price, t.reason, points)
                pos = self.trader.position if self.trader else None
                if pos and pos["key"] == f"{side}|{entry_ts:%H:%M}":
                    self.trader.exit(t.reason, t.exit_price)

    def _record_paper_trade(self, entry_ts, side, entry_px, exit_ts, exit_px, reason, points) -> None:
        new = not self.ledger_file.exists()
        with self.ledger_file.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(LEDGER_HEADER)
            w.writerow([f"{entry_ts:%Y-%m-%d}", side, f"{entry_ts:%H:%M}", round(entry_px, 2), f"{exit_ts:%H:%M}",
                        round(exit_px, 2), reason, round(points, 2), round(points * LOT_SIZE, 2)])
        total = pd.read_csv(self.ledger_file)
        print(f"Paper P&L: {len(total)} trades, {total['points'].sum():+.2f} pts, Rs {total['rupees_1_lot'].sum():+,.0f} (1 lot)")
