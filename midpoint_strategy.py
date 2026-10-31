from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import List, Optional, Tuple

import pandas as pd


@dataclass
class Trade:
    entry_time: str
    exit_time: str
    setup_index: int
    side: str
    entry: float
    midpoint: float
    stop: float
    target: float
    exit_price: float
    result_r: float
    pnl_points: float
    bars_held: int
    reason: str


def candle_touches_mid(row: pd.Series, mid: float) -> bool:
    return row["low"] <= mid <= row["high"]


def candle_touches_mid_with_buffer(row: pd.Series, mid: float, buffer_points: float) -> bool:
    return row["low"] <= (mid + buffer_points) and row["high"] >= (mid - buffer_points)


def classify_side_from_close(close: float, mid: float, buffer_points: float) -> Optional[str]:
    if close >= (mid + buffer_points):
        return "LONG"
    if close <= (mid - buffer_points):
        return "SHORT"
    return None


def resolve_exit(
    df: pd.DataFrame,
    entry_idx: int,
    side: str,
    midpoint: float,
    midpoint_buffer_points: float,
    stop: float,
    target: float,
    max_hold_bars: int,
    cutoff_idx: int,
    entry: Optional[float] = None,
) -> tuple[int, float, str]:
    last_idx = min(len(df) - 1, entry_idx + max_hold_bars, cutoff_idx)
    long = side == "LONG"
    best = entry
    trailing = False

    for j in range(entry_idx + 1, last_idx + 1):
        open_j = float(df.loc[j, "open"])
        high_j = float(df.loc[j, "high"])
        low_j = float(df.loc[j, "low"])
        close_j = float(df.loc[j, "close"])

        # Trail level uses the best price up to the previous candle (intra-candle order is unknown).
        if trailing:
            level = best - TRAIL_POINTS if long else best + TRAIL_POINTS
            if (long and low_j <= level) or (not long and high_j >= level):
                return j, (min(open_j, level) if long else max(open_j, level)), "trail_stop"

        # The stop works intrabar, so it fires before a candle can close beyond the midpoint.
        if (long and low_j <= stop) or (not long and high_j >= stop):
            return j, (min(open_j, stop) if long else max(open_j, stop)), "stop"

        if (long and close_j < midpoint - midpoint_buffer_points) or (not long and close_j > midpoint + midpoint_buffer_points):
            return j, close_j, "midpoint_close_exit"

        if (long and high_j >= target) or (not long and low_j <= target):
            return j, target, "target"

        if best is not None and TRAIL_ACTIVATE_POINTS is not None:
            best = max(best, high_j) if long else min(best, low_j)
            trailing = trailing or ((best - entry) if long else (entry - best)) >= TRAIL_ACTIVATE_POINTS

    return last_idx, float(df.loc[last_idx, "close"]), "time_exit"


MIDPOINT_BUFFER_POINTS = 5.0
PAPER_LOTS = 2
PAPER_STARTING_CAPITAL = 25_000
WICK_TOUCH_TOLERANCE = 2.0  # a wick within this many points of the midpoint counts as touching it
OPEN_TOLERANCE = 2.0  # the rejection candle may open up to this many points on the wrong side of the midpoint
TARGET_POINTS = 50.0
TRAIL_ACTIVATE_POINTS: Optional[float] = None  # set (e.g. 40.0) to enable a trailing stop; None = fixed target only
TRAIL_POINTS = 10.0
HARD_STOP_POINTS: Optional[float] = None  # set (e.g. 10.0) for a fixed stop from entry; None = range edge
MAX_ENTRY_DISTANCE: Optional[float] = None  # set (e.g. 25.0) to skip entries filling further than this from the midpoint
MIN_SETUP_MINUTES = 5
MIN_FIRST_CANDLE_BODY_RATIO = 0.12
TRADE_WINDOW_MINUTES = 35  # exits by 09:50
MIN_MINUTES_LEFT_FOR_ENTRY = 10  # last entry 09:40


def day_setup(work: pd.DataFrame, day_indices: List[int]) -> Optional[dict]:
    """Opening first-swing range and midpoint for one day, or None if the day is skipped."""
    if len(day_indices) < 5:
        return None
    day_start = day_indices[0]
    day_cutoff_ts = work.loc[day_start, "timestamp"] + pd.Timedelta(minutes=TRADE_WINDOW_MINUTES)
    cutoff_candidates = [idx for idx in day_indices if work.loc[idx, "timestamp"] <= day_cutoff_ts]
    day_cutoff_idx = cutoff_candidates[-1]
    last_entry_ts = day_cutoff_ts - pd.Timedelta(minutes=MIN_MINUTES_LEFT_FOR_ENTRY)
    last_entry_idx = max(idx for idx in cutoff_candidates if work.loc[idx, "timestamp"] <= last_entry_ts)

    ref = work.loc[day_start]
    ref_high = float(ref["high"])
    ref_low = float(ref["low"])
    first_range = ref_high - ref_low
    if first_range <= 0:
        return None
    # Skip indecisive opening candles (very small body vs full range).
    if abs(float(ref["close"]) - float(ref["open"])) / first_range < MIN_FIRST_CANDLE_BODY_RATIO:
        return None

    # First swing: range grows with every new high/low; it is fixed at the first
    # candle from minute 5 onwards that makes neither a new high nor a new low.
    for j in range(day_start + 1, day_cutoff_idx + 1):
        high_j = float(work.loc[j, "high"])
        low_j = float(work.loc[j, "low"])
        makes_new_extreme = high_j > ref_high or low_j < ref_low
        if not makes_new_extreme and (j - day_start) >= MIN_SETUP_MINUTES:
            return {
                "day_start": day_start,
                "day_end": day_indices[-1],
                "day_cutoff_idx": day_cutoff_idx,
                "cutoff_reached": work.loc[day_cutoff_idx, "timestamp"] >= day_cutoff_ts,
                "last_entry_idx": last_entry_idx,
                "range_fixed_idx": j,
                "ref_high": ref_high,
                "ref_low": ref_low,
                "mid": (ref_high + ref_low) / 2.0,
            }
        ref_high = max(ref_high, high_j)
        ref_low = min(ref_low, low_j)
    return None


def key_levels_for_range(setup: dict, step: int = 500) -> List[int]:
    """Round price levels near the daily midpoint range. Used as directional confirmation filters."""
    lo = int((setup["ref_low"] - 1000) // step) * step
    hi = int((setup["ref_high"] + 1000) // step) * step
    return list(range(lo, hi + step, step))


def key_breakout_signal(work: pd.DataFrame, idx: int, side: str, setup: dict, max_follow_candles: int = 3) -> Optional[int]:
    """Return a qualifying key level for breakout continuation.

    Aggressive rule: if the first bar or the next immediate bars break a round level and hold it,
    we can take the trade without waiting for a full retrace back into the midpoint.
    """
    levels = key_levels_for_range(setup)
    base = idx

    if side == "LONG":
        valid_levels = [lvl for lvl in levels if lvl > setup["mid"] and lvl <= setup["ref_high"] + 1000]
        for lvl in valid_levels:
            for j in range(base, min(len(work), base + max_follow_candles + 1)):
                candle = work.iloc[j]
                if candle["close"] >= lvl and candle["high"] >= lvl:
                    follow_ok = True
                    for k in range(j + 1, min(len(work), j + 3)):
                        next_candle = work.iloc[k]
                        if next_candle["close"] < lvl:
                            follow_ok = False
                            break
                    if follow_ok and abs(float(work.loc[j, "close"]) - setup["mid"]) <= 80:
                        return int(lvl)
        return None

    valid_levels = [lvl for lvl in levels if lvl < setup["mid"] and lvl >= setup["ref_low"] - 1000]
    for lvl in valid_levels:
        for j in range(base, min(len(work), base + max_follow_candles + 1)):
            candle = work.iloc[j]
            if candle["close"] <= lvl and candle["low"] <= lvl:
                follow_ok = True
                for k in range(j + 1, min(len(work), j + 3)):
                    next_candle = work.iloc[k]
                    if next_candle["close"] > lvl:
                        follow_ok = False
                        break
                if follow_ok and abs(float(work.loc[j, "close"]) - setup["mid"]) <= 80:
                    return int(lvl)
    return None


def buffer_entry_level(side: str, mid: float) -> float:
    return mid + MIDPOINT_BUFFER_POINTS if side == "LONG" else mid - MIDPOINT_BUFFER_POINTS


def has_breakdown_confirmation(work: pd.DataFrame, k: int, side: str, mid: float, lookback: int = 3) -> bool:
    """Require recent momentum in the same direction before accepting a midpoint rejection trade.

    This keeps the strategy from entering on isolated wick snaps that are not backed by a
    fresh directional breakdown. We treat a 3-candle confirmation as the minimum bar count.
    """
    if k <= lookback:
        return True

    recent = work.iloc[max(0, k - lookback):k].copy()
    if recent.empty:
        return True

    if side == "SHORT":
        closes_below_mid = int((recent["close"] < mid).sum())
        recent_down = int((recent["close"].diff().fillna(0) < 0).sum())
        last_low = float(recent["low"].iloc[-1])
        return closes_below_mid >= 2 and recent_down >= 1 and last_low <= mid

    closes_above_mid = int((recent["close"] > mid).sum())
    recent_up = int((recent["close"].diff().fillna(0) > 0).sum())
    last_high = float(recent["high"].iloc[-1])
    return closes_above_mid >= 2 and recent_up >= 1 and last_high >= mid


def wick_rejection_side(work: pd.DataFrame, k: int, mid: float) -> Optional[str]:
    """Candle k wicked into (or within WICK_TOUCH_TOLERANCE of) the midpoint and closed back beyond the buffer."""
    o, h, l, c = (float(work.loc[k, x]) for x in ("open", "high", "low", "close"))
    prev_close = float(work.loc[k - 1, "close"])
    tol = WICK_TOUCH_TOLERANCE
    if prev_close > mid and o > mid - OPEN_TOLERANCE and l <= mid + tol and c >= mid + MIDPOINT_BUFFER_POINTS:
        side = "LONG"
        if has_breakdown_confirmation(work, k, side, mid):
            return side
        return None
    if prev_close < mid and o < mid + OPEN_TOLERANCE and h >= mid - tol and c <= mid - MIDPOINT_BUFFER_POINTS:
        side = "SHORT"
        if has_breakdown_confirmation(work, k, side, mid):
            return side
        return None
    return None


def scan_entry(
    work: pd.DataFrame,
    setup: dict,
    earliest_idx: int,
    last_idx: int,
    side_filter: Optional[str] = None,
) -> dict:
    """Try breakout continuation first, then fall back to midpoint wick rejection."""
    limit = min(setup["last_entry_idx"], last_idx)

    for k in range(max(earliest_idx, setup["day_start"] + 1), limit - 1):
        for side in ("LONG", "SHORT"):
            if side_filter is not None and side != side_filter:
                continue
            level = key_breakout_signal(work, k, side, setup, max_follow_candles=3)
            if level is not None:
                entry_idx = k + 1
                if entry_idx > limit:
                    entry_idx = limit
                return {
                    "status": "entry",
                    "idx": entry_idx,
                    "side": side,
                    "price": float(work.loc[entry_idx, "open"]),
                    "level": level,
                }

    for k in range(max(earliest_idx, setup["day_start"] + 1), limit):
        side = wick_rejection_side(work, k, setup["mid"])
        if side and (side_filter is None or side == side_filter):
            return {"status": "entry", "idx": k + 1, "side": side, "price": float(work.loc[k + 1, "open"])}
    return {"status": "none", "earliest": earliest_idx, "side_filter": side_filter}


def entry_stop(setup: dict, side: str, entry: float) -> float:
    """Range edge, tightened to HARD_STOP_POINTS from entry when that is set and closer."""
    edge = setup["ref_low"] if side == "LONG" else setup["ref_high"]
    if HARD_STOP_POINTS is None:
        return edge
    if side == "LONG":
        return max(edge, entry - HARD_STOP_POINTS)
    return min(edge, entry + HARD_STOP_POINTS)


def entry_too_far(setup: dict, side: str, entry: float) -> bool:
    if MAX_ENTRY_DISTANCE is None:
        return False
    return (entry - setup["mid"] if side == "LONG" else setup["mid"] - entry) > MAX_ENTRY_DISTANCE


def simulate_trade(
    work: pd.DataFrame, setup: dict, entry_idx: int, side: str, entry: float, max_hold_bars: int, reason_prefix: str = ""
) -> Optional[Trade]:
    mid = setup["mid"]
    buf = MIDPOINT_BUFFER_POINTS
    if entry_too_far(setup, side, entry):
        return None
    stop = entry_stop(setup, side, entry)
    risk = entry - stop if side == "LONG" else stop - entry
    if risk <= 0:
        return None
    target = entry + TARGET_POINTS if side == "LONG" else entry - TARGET_POINTS

    # Entry is at the candle's open, so its own low/high can already hit the stop, and its close the midpoint exit.
    entry_low, entry_high = float(work.loc[entry_idx, "low"]), float(work.loc[entry_idx, "high"])
    entry_close = float(work.loc[entry_idx, "close"])
    if (side == "LONG" and entry_low <= stop) or (side == "SHORT" and entry_high >= stop):
        exit_idx, exit_price, reason = entry_idx, stop, "stop"
    elif (side == "LONG" and entry_close < mid - buf) or (side == "SHORT" and entry_close > mid + buf):
        exit_idx, exit_price, reason = entry_idx, entry_close, "midpoint_close_exit"
    else:
        exit_idx, exit_price, reason = resolve_exit(
            df=work,
            entry_idx=entry_idx,
            side=side,
            midpoint=mid,
            midpoint_buffer_points=buf,
            stop=stop,
            target=target,
            max_hold_bars=max_hold_bars,
            cutoff_idx=setup["day_cutoff_idx"],
            entry=entry,
        )

    pnl = exit_price - entry if side == "LONG" else entry - exit_price
    # Live, partial day: data ended before the cutoff or hold limit, so the trade is still running.
    if reason == "time_exit" and exit_idx < entry_idx + max_hold_bars and not setup["cutoff_reached"]:
        reason = "open"
    return Trade(
        entry_time=str(work.loc[entry_idx, "timestamp"]),
        exit_time=str(work.loc[exit_idx, "timestamp"]),
        setup_index=setup["day_start"],
        side=side,
        entry=entry,
        midpoint=mid,
        stop=stop,
        target=target,
        exit_price=exit_price,
        result_r=pnl / risk,
        pnl_points=pnl,
        bars_held=exit_idx - entry_idx,
        reason=f"{reason_prefix}{reason}",
    )


def plan_day(
    work: pd.DataFrame, day_indices: List[int], max_hold_bars: int = 20
) -> Tuple[Optional[dict], List[Trade], Optional[dict]]:
    """Trades for one day plus the entry armed for the next candle (live use).

    First midpoint wick rejection on either side; after a losing trade, one more on the opposite side;
    if that also loses, a last one on either side.
    """
    setup = day_setup(work, day_indices)
    if setup is None:
        return None, [], None
    last_idx = day_indices[-1]
    trades: List[Trade] = []
    earliest, side_filter, prefix = setup["range_fixed_idx"], None, ""

    for phase in ("first", "opposite", "third"):
        r = scan_entry(work, setup, earliest, last_idx, side_filter)
        if r["status"] != "entry":
            return setup, trades, _armed_for_next(work, setup, r, day_indices)
        opposite = "SHORT" if r["side"] == "LONG" else "LONG"
        trade = simulate_trade(work, setup, r["idx"], r["side"], r["price"], max_hold_bars, prefix)
        if trade is None:
            break
        trades.append(trade)
        exit_idx = work.index[work["timestamp"] == pd.Timestamp(trade.exit_time)][0]
        still_open = trade.reason.endswith("open")
        if phase == "third" or trade.pnl_points >= 0 or still_open:
            break
        if phase == "first":
            earliest, side_filter, prefix = exit_idx, opposite, "reverse_after_sl_"
        else:
            earliest, side_filter, prefix = exit_idx, None, "third_after_2sl_"
    return setup, trades, None


def _armed_for_next(work: pd.DataFrame, setup: dict, r: dict, day_indices: List[int]) -> Optional[dict]:
    """If the last closed candle is a wick rejection, enter at market on the next candle's first tick."""
    last_idx = day_indices[-1]
    last_entry_ts = work.loc[day_indices[0], "timestamp"] + pd.Timedelta(
        minutes=TRADE_WINDOW_MINUTES - MIN_MINUTES_LEFT_FOR_ENTRY
    )
    if work.loc[last_idx, "timestamp"] >= last_entry_ts or last_idx < max(r["earliest"], setup["day_start"] + 1):
        return None
    side = wick_rejection_side(work, last_idx, setup["mid"])
    if side is None or (r["side_filter"] and side != r["side_filter"]):
        return None
    return {
        "side": side,
        "candle_time": work.loc[last_idx, "timestamp"] + pd.Timedelta(minutes=1),
        "level": buffer_entry_level(side, setup["mid"]),
        "mid": setup["mid"],
        "stop": setup["ref_low"] if side == "LONG" else setup["ref_high"],
    }


def run_day(work: pd.DataFrame, day_indices: List[int], max_hold_bars: int = 20) -> Tuple[Optional[dict], List[Trade]]:
    setup, trades, _ = plan_day(work, day_indices, max_hold_bars)
    return setup, trades


def pending_entry(df: pd.DataFrame) -> Optional[dict]:
    """For live use: entry armed for the next (still forming) candle of the latest day, if any."""
    if df.empty:
        return None
    work = df.reset_index(drop=True)
    last_day = work["timestamp"].dt.date.iloc[-1]
    day_indices = work.index[work["timestamp"].dt.date == last_day].tolist()
    return plan_day(work, day_indices)[2]


def backtest_midpoint_strategy(df: pd.DataFrame, rr: float = 1.0, max_hold_bars: int = 20) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    work = df.copy()
    work["trade_day"] = work["timestamp"].dt.date
    trades: List[Trade] = []
    for _, day_df in work.groupby("trade_day", sort=True):
        _, day_trades = run_day(work, day_df.index.tolist(), max_hold_bars)
        trades.extend(day_trades)
    return pd.DataFrame([asdict(t) for t in trades])


def triggered_days_report(df: pd.DataFrame, max_hold_bars: int = 20) -> List[str]:
    """Return a sorted list of dates where the midpoint+key-level strategy would have triggered."""
    if df.empty:
        return []
    work = df.copy()
    work["trade_day"] = work["timestamp"].dt.date
    triggered = set()
    for _, day_df in work.groupby("trade_day", sort=True):
        setup, trades, _ = plan_day(work, day_df.index.tolist(), max_hold_bars)
        if trades:
            triggered.update(str(t.entry_time[:10]) for t in trades)
    return sorted(triggered)
