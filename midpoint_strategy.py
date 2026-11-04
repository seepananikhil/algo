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
TARGET_POINTS = 38.0
TRAIL_ACTIVATE_POINTS: Optional[float] = 28.0  # locks in profit once trade reaches +40 pts
TRAIL_POINTS = 8.0
MIDPOINT_SL_OFFSET: float = 15.0  # SL anchored 15 pts beyond the midpoint so normal retests never shake out
HARD_STOP_POINTS: Optional[float] = 20.0  # hard-cap maximum stop loss to 25 pts from entry
MAX_ENTRY_DISTANCE: Optional[float] = 22.0  # keep entry close to buffer zone (skips late runaway candles)
MIN_SETUP_MINUTES = 5
MIN_FIRST_CANDLE_BODY_RATIO = 0.12
MIN_OPENING_RANGE: Optional[float] = 50.0  # filter out chop days where opening swing range < 50 pts
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
            swing_range = ref_high - ref_low
            if MIN_OPENING_RANGE is not None and swing_range < MIN_OPENING_RANGE:
                return None
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




def buffer_entry_level(side: str, mid: float) -> float:
    return mid + MIDPOINT_BUFFER_POINTS if side == "LONG" else mid - MIDPOINT_BUFFER_POINTS


def wick_rejection_side(work: pd.DataFrame, k: int, mid: float) -> Optional[str]:
    """Candle k wicked into (or within WICK_TOUCH_TOLERANCE of) the midpoint and closed back beyond the buffer."""
    if k < 1:
        return None
    o, h, l, c = (float(work.loc[k, x]) for x in ("open", "high", "low", "close"))
    prev_close = float(work.loc[k - 1, "close"])
    tol = WICK_TOUCH_TOLERANCE
    if prev_close > mid and o > mid - OPEN_TOLERANCE and l <= mid + tol and c >= mid + MIDPOINT_BUFFER_POINTS:
        if c >= o:
            return "LONG"
    if prev_close < mid and o < mid + OPEN_TOLERANCE and h >= mid - tol and c <= mid - MIDPOINT_BUFFER_POINTS:
        if c <= o:
            return "SHORT"
    return None


def scan_entry(
    work: pd.DataFrame,
    setup: dict,
    earliest_idx: int,
    last_idx: int,
    side_filter: Optional[str] = None,
) -> dict:
    """Midpoint wick rejection entry with adaptive 2-candle post-break confirmation.

    If the breakdown/breakout was already confirmed (>= 2 closes on side before the rejection candle),
    entry triggers on the immediate next open (k + 1).
    If it was a fresh break (< 2 closes prior), requires 1 sustaining candle at k + 1, entering on k + 2.
    """
    limit = min(setup["last_entry_idx"], last_idx)
    mid = setup["mid"]
    day_start = setup["day_start"]
    for k in range(max(earliest_idx, day_start + 1), limit):
        side = wick_rejection_side(work, k, mid)
        if not side or (side_filter is not None and side != side_filter):
            continue
        closes_on_side = 0
        if k - 1 >= day_start:
            c1 = float(work.loc[k - 1, "close"])
            if (side == "SHORT" and c1 < mid) or (side == "LONG" and c1 > mid):
                closes_on_side += 1
        if k - 2 >= day_start:
            c2 = float(work.loc[k - 2, "close"])
            if (side == "SHORT" and c2 < mid) or (side == "LONG" and c2 > mid):
                closes_on_side += 1
        if closes_on_side >= 2:
            entry_idx = k + 1
            if entry_idx <= last_idx:
                return {"status": "entry", "idx": entry_idx, "side": side, "price": float(work.loc[entry_idx, "open"])}
        else:
            if k + 1 <= last_idx:
                next_c = float(work.loc[k + 1, "close"])
                sustained = (next_c <= mid) if side == "SHORT" else (next_c >= mid)
                if sustained:
                    entry_idx = min(k + 2, limit)
                    if entry_idx <= last_idx:
                        return {"status": "entry", "idx": entry_idx, "side": side, "price": float(work.loc[entry_idx, "open"])}
    return {"status": "none", "earliest": earliest_idx, "side_filter": side_filter}


def entry_stop(setup: dict, side: str, entry: float) -> float:
    """Stop loss anchored beyond the midpoint to give retests breathing room,
    capped to HARD_STOP_POINTS from entry."""
    edge = setup["ref_low"] if side == "LONG" else setup["ref_high"]
    mid = setup["mid"]
    if side == "LONG":
        mid_sl = mid - MIDPOINT_SL_OFFSET
        if HARD_STOP_POINTS is not None:
            return max(edge, mid_sl, entry - HARD_STOP_POINTS)
        return max(edge, mid_sl)
    else:
        mid_sl = mid + MIDPOINT_SL_OFFSET
        if HARD_STOP_POINTS is not None:
            return min(edge, mid_sl, entry + HARD_STOP_POINTS)
        return min(edge, mid_sl)


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
    """If the last closed candle triggers or confirms an entry, arm for the next candle's first tick."""
    last_idx = day_indices[-1]
    last_entry_ts = work.loc[day_indices[0], "timestamp"] + pd.Timedelta(
        minutes=TRADE_WINDOW_MINUTES - MIN_MINUTES_LEFT_FOR_ENTRY
    )
    if work.loc[last_idx, "timestamp"] >= last_entry_ts:
        return None

    mid = setup["mid"]
    earliest = max(r.get("earliest", 0), setup["day_start"] + 1)
    side_filter = r.get("side_filter")

    # Case 1: last_idx itself is a rejection bar, and was already confirmed (>= 2 closes prior to it)
    if last_idx >= earliest:
        side = wick_rejection_side(work, last_idx, mid)
        if side and (side_filter is None or side == side_filter):
            closes_on_side = 0
            if last_idx - 1 >= setup["day_start"]:
                c1 = float(work.loc[last_idx - 1, "close"])
                if (side == "SHORT" and c1 < mid) or (side == "LONG" and c1 > mid):
                    closes_on_side += 1
            if last_idx - 2 >= setup["day_start"]:
                c2 = float(work.loc[last_idx - 2, "close"])
                if (side == "SHORT" and c2 < mid) or (side == "LONG" and c2 > mid):
                    closes_on_side += 1
            if closes_on_side >= 2:
                return {
                    "side": side,
                    "candle_time": work.loc[last_idx, "timestamp"] + pd.Timedelta(minutes=1),
                    "level": buffer_entry_level(side, mid),
                    "mid": mid,
                    "stop": setup["ref_low"] if side == "LONG" else setup["ref_high"],
                }

    # Case 2: last_idx - 1 was a rejection bar on a fresh break (<2 closes prior), and last_idx is the sustaining bar
    prev_idx = last_idx - 1
    if prev_idx >= earliest:
        side = wick_rejection_side(work, prev_idx, mid)
        if side and (side_filter is None or side == side_filter):
            closes_on_side = 0
            if prev_idx - 1 >= setup["day_start"]:
                c1 = float(work.loc[prev_idx - 1, "close"])
                if (side == "SHORT" and c1 < mid) or (side == "LONG" and c1 > mid):
                    closes_on_side += 1
            if prev_idx - 2 >= setup["day_start"]:
                c2 = float(work.loc[prev_idx - 2, "close"])
                if (side == "SHORT" and c2 < mid) or (side == "LONG" and c2 > mid):
                    closes_on_side += 1
            if closes_on_side < 2:
                next_c = float(work.loc[last_idx, "close"])
                sustained = (next_c <= mid) if side == "SHORT" else (next_c >= mid)
                if sustained:
                    return {
                        "side": side,
                        "candle_time": work.loc[last_idx, "timestamp"] + pd.Timedelta(minutes=1),
                        "level": buffer_entry_level(side, mid),
                        "mid": mid,
                        "stop": setup["ref_low"] if side == "LONG" else setup["ref_high"],
                    }

    return None


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
