"""Real-time paper signals: re-run the strategy on today's candles after every 1-min close."""

from __future__ import annotations

import csv
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Set

import pandas as pd

from backtest_midpoint_strategy import load_data
from midpoint_strategy import PAPER_LOTS, TARGET_POINTS, backtest_midpoint_strategy, entry_stop, entry_too_far, pending_entry

IST = timezone(timedelta(hours=5, minutes=30))
HEADER = ["detected_at", "event", "side", "entry_time", "candle_time", "price", "mid_point", "sl", "target", "reason", "pnl_points"]
LOT_SIZE = 65  # NIFTY lot size; verify with your broker
LEDGER_HEADER = ["date", "side", "entry_time", "entry_price", "exit_time", "exit_price", "exit_reason", "points", "lots", "rupees"]


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
        self.open_entries: dict = {}
        self.option_paper_tracker = None
        self.ledger_file = signals_file.parent / "paper_trades.csv"
        if signals_file.exists():
            with signals_file.open("r", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    key = f"{row['side']}|{row['entry_time']}"
                    self.seen.add(f"{row['event']}|{key}")
                    if row["event"] == "ENTRY":
                        self.fills.setdefault(key, float(row["price"]))
                        self.open_entries[key] = row
                    elif row["event"] == "EXIT":
                        self.open_entries.pop(key, None)

    def _emit(self, key: str, row: list, title: str, text: str) -> None:
        self.seen.add(key)
        if len(row) >= 4:
            event = row[1]
            pos_key = f"{row[2]}|{row[3]}"
            if event == "ENTRY":
                self.open_entries[pos_key] = {
                    "detected_at": row[0],
                    "event": row[1],
                    "side": row[2],
                    "entry_time": row[3],
                    "candle_time": row[4] if len(row) > 4 else row[3],
                    "price": str(row[5]) if len(row) > 5 else "0",
                    "mid_point": str(row[6]) if len(row) > 6 else "0",
                    "sl": str(row[7]) if len(row) > 7 else "0",
                    "target": str(row[8]) if len(row) > 8 else "0",
                    "reason": row[9] if len(row) > 9 else "",
                    "pnl_points": row[10] if len(row) > 10 else "",
                }
            elif event == "EXIT":
                self.open_entries.pop(pos_key, None)

        new = not self.signals_file.exists()
        with self.signals_file.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(HEADER)
            w.writerow(row)
        print(f"*** {title}: {text}")

    def check_tick(self, ltp: float, now: datetime) -> None:
        """Called every second: check active entries for intrabar exits, then check arming for entry."""
        time_str = now.strftime("%H:%M")
        detected = now.strftime("%H:%M:%S")

        # 1. Intrabar SL / Target check on any currently open live entry
        if self.open_entries:
            for pos_key in list(self.open_entries.keys()):
                info = self.open_entries[pos_key]
                side = info["side"]
                entry_time = info["entry_time"]
                entry_px = float(info.get("price") or 0.0)
                sl = float(info.get("sl") or 0.0)
                target = float(info.get("target") or 0.0)
                mid = float(info.get("mid_point") or 0.0)

                exit_reason = None
                exit_px = None
                if side == "CALL":
                    if ltp <= sl:
                        exit_reason, exit_px = "stop", sl
                    elif ltp >= target:
                        exit_reason, exit_px = "target", target
                elif side == "PUT":
                    if ltp >= sl:
                        exit_reason, exit_px = "stop", sl
                    elif ltp <= target:
                        exit_reason, exit_px = "target", target

                if exit_reason:
                    fill = self.fills.get(pos_key, entry_px)
                    points = round(exit_px - fill if side == "CALL" else fill - exit_px, 2)
                    exit_key = f"EXIT|{side}|{entry_time}"
                    if exit_key not in self.seen:
                        self._emit(
                            exit_key,
                            [detected, "EXIT", side, entry_time, time_str, round(exit_px, 2), round(mid, 2),
                             round(sl, 2), round(target, 2), exit_reason, points],
                            f"EXIT {side} {points:+.2f} pts (Rs {points * LOT_SIZE * PAPER_LOTS:+,.0f})",
                            f"{time_str} @ {exit_px:.2f} [{exit_reason}]",
                        )
                        self._record_paper_trade(now, side, fill, now, exit_px, exit_reason, points)
                        pos = self.trader.position if self.trader else None
                        if pos and pos.get("key") == pos_key:
                            self.trader.exit(exit_reason, exit_px)
                    self.open_entries.pop(pos_key, None)

        # 2. Check pending armed entry
        w = self.watch
        if not w or now.strftime("%H:%M") != w["candle_time"].strftime("%H:%M"):
            return
        self.watch = None
        side = "CALL" if w["side"] == "LONG" else "PUT"
        key = f"ENTRY|{side}|{w['candle_time']:%H:%M}"
        if key in self.seen:
            return
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
             round(w["mid"], 2), round(stop, 2), round(target, 2), "market_1s", ""],
            f"ENTRY {side}",
            f"{now:%H:%M:%S} @ {ltp:.2f} | SL {stop:.2f} TGT {target:.2f} mid {w['mid']:.2f}",
        )
        if self.option_paper_tracker:
            self.option_paper_tracker.on_signal("midpoint", side, ltp, now, stop_price=stop, spot_target=target)
        if self.trader:
            self.trader.enter(side, ltp, target, stop, key=f"{side}|{w['candle_time']:%H:%M}")

    def _resolve_open_entries(self, df: pd.DataFrame) -> None:
        """Fallback position manager: ensures any live entry is exited by rules even if backtest drops it."""
        if not self.open_entries or df.empty:
            return

        detected = datetime.now(IST).strftime("%H:%M:%S")

        for pos_key in list(self.open_entries.keys()):
            info = self.open_entries[pos_key]
            side = info["side"]
            entry_time = info["entry_time"]
            entry_px = float(info.get("price") or 0.0)
            sl = float(info.get("sl") or 0.0)
            target = float(info.get("target") or 0.0)
            mid = float(info.get("mid_point") or 0.0)

            sub = df[df["timestamp"].dt.strftime("%H:%M") >= entry_time].reset_index(drop=True)
            if len(sub) <= 1:
                continue

            exit_hit = False
            for bar_idx in range(1, len(sub)):
                c_row = sub.iloc[bar_idx]
                c_ts = c_row["timestamp"]
                c_time_str = c_ts.strftime("%H:%M")
                o, h, l, c = float(c_row["open"]), float(c_row["high"]), float(c_row["low"]), float(c_row["close"])

                # Check stop
                if (side == "CALL" and l <= sl) or (side == "PUT" and h >= sl):
                    exit_px = min(o, sl) if side == "CALL" else max(o, sl)
                    reason = "stop"
                    exit_hit = True
                # Check midpoint close breach
                elif (side == "CALL" and c < mid - 5.0) or (side == "PUT" and c > mid + 5.0):
                    exit_px = c
                    reason = "midpoint_close_exit"
                    exit_hit = True
                # Check target
                elif (side == "CALL" and h >= target) or (side == "PUT" and l <= target):
                    exit_px = target
                    reason = "target"
                    exit_hit = True
                # Check time exit (20 bars hold or 09:50 cutoff)
                elif bar_idx >= 20 or (c_ts.hour == 9 and c_ts.minute >= 50) or (c_ts.hour >= 10):
                    exit_px = c
                    reason = "time_exit"
                    exit_hit = True

                if exit_hit:
                    fill = self.fills.get(pos_key, entry_px)
                    points = round(exit_px - fill if side == "CALL" else fill - exit_px, 2)
                    exit_key = f"EXIT|{side}|{entry_time}"
                    if exit_key not in self.seen:
                        self._emit(
                            exit_key,
                            [detected, "EXIT", side, entry_time, c_time_str, round(exit_px, 2), round(mid, 2),
                             round(sl, 2), round(target, 2), reason, points],
                            f"EXIT {side} {points:+.2f} pts (Rs {points * LOT_SIZE * PAPER_LOTS:+,.0f})",
                            f"{c_time_str} @ {exit_px:.2f} [{reason}]",
                        )
                        self._record_paper_trade(c_ts, side, fill, c_ts, exit_px, reason, points)
                        pos = self.trader.position if self.trader else None
                        if pos and pos.get("key") == pos_key:
                            self.trader.exit(reason, exit_px)
                    self.open_entries.pop(pos_key, None)
                    break

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
            print(f"[{datetime.now(IST):%H:%M:%S}] ARMED {side}: enter at market on the first tick of {w['candle_time']:%H:%M} "
                  f"(mid {w['mid']:.2f})")

        last_candle = df["timestamp"].iloc[-1]
        detected = datetime.now(IST).strftime("%H:%M:%S")
        option = {"LONG": "CALL", "SHORT": "PUT"}

        if not trades.empty:
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
                    if self.trader and not late:
                        self.trader.enter(side, t.entry, t.target, t.stop, key=f"{side}|{entry_ts:%H:%M}")

                closed = not t.reason.endswith("open")
                exit_key = f"EXIT|{side}|{entry_ts:%H:%M}"
                position_key = f"{side}|{entry_ts:%H:%M}"
                if closed and self.trader and self.trader.was_closed(position_key):
                    self.seen.add(exit_key)
                    self.open_entries.pop(position_key, None)
                    continue
                if closed and exit_key not in self.seen:
                    fill = self.fills.get(position_key, t.entry)
                    points = t.exit_price - fill if t.side == "LONG" else fill - t.exit_price
                    self._emit(
                        exit_key,
                        [detected, "EXIT", side, f"{entry_ts:%H:%M}", f"{exit_ts:%H:%M}", round(t.exit_price, 2), round(t.midpoint, 2),
                         round(t.stop, 2), round(t.target, 2), t.reason, round(points, 2)],
                        f"EXIT {side} {points:+.2f} pts (Rs {points * LOT_SIZE * PAPER_LOTS:+,.0f})",
                        f"{exit_ts:%H:%M} @ {t.exit_price:.2f} [{t.reason}]",
                    )
                    self._record_paper_trade(entry_ts, side, fill, exit_ts, t.exit_price, t.reason, points)
                    pos = self.trader.position if self.trader else None
                    if pos and pos["key"] == position_key:
                        self.trader.exit(t.reason, t.exit_price)
                    self.open_entries.pop(position_key, None)

        # Fallback position manager: resolve any open entries that backtest missed or dropped
        self._resolve_open_entries(df)

    def _record_paper_trade(self, entry_ts, side, entry_px, exit_ts, exit_px, reason, points) -> None:
        new = not self.ledger_file.exists()
        with self.ledger_file.open("a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(LEDGER_HEADER)
            w.writerow([f"{entry_ts:%Y-%m-%d}", side, f"{entry_ts:%H:%M}", round(entry_px, 2), f"{exit_ts:%H:%M}",
                        round(exit_px, 2), reason, round(points, 2), PAPER_LOTS, round(points * LOT_SIZE * PAPER_LOTS, 2)])
        total = pd.read_csv(self.ledger_file)
        print(f"Paper P&L: {len(total)} trades, {total['points'].sum():+.2f} pts, Rs {total['rupees'].sum():+,.0f} ({PAPER_LOTS} lots)")
