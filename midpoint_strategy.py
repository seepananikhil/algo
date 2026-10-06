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

        if (long and close_j < midpoint - midpoint_buffer_points) or (not long and close_j > midpoint + midpoint_buffer_points):
            return j, close_j, "midpoint_close_exit"

        hit_stop = low_j <= stop if long else high_j >= stop
        hit_target = high_j >= target if long else low_j <= target
        if hit_stop and hit_target:
            return j, stop, "both_hit_stop_first_assumed"
        if hit_stop:
            return j, stop, "stop"
        if hit_target:
            return j, target, "target"

        if best is not None:
            best = max(best, high_j) if long else min(best, low_j)
            trailing = trailing or ((best - entry) if long else (entry - best)) >= TRAIL_ACTIVATE_POINTS

    return last_idx, float(df.loc[last_idx, "close"]), "time_exit"


MIDPOINT_BUFFER_POINTS = 5.0
TARGET_POINTS = 50.0
TRAIL_ACTIVATE_POINTS = 40.0
TRAIL_POINTS = 10.0
MIN_SETUP_MINUTES = 5
MIN_FIRST_CANDLE_BODY_RATIO = 0.12
ACTIVATION_CLOSES = 3
ENTRY_WINDOW_CANDLES = 1
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


def activated_side(work: pd.DataFrame, m: int, mid: float, earliest_idx: int) -> Optional[str]:
    """Side armed for candle m: the previous 3 closes (none before earliest_idx) are on one side of mid."""
    first = m - ACTIVATION_CLOSES
    if first < earliest_idx:
        return None
    closes = [float(work.loc[i, "close"]) for i in range(first, m)]
    if all(c > mid for c in closes):
        return "LONG"
    if all(c < mid for c in closes):
        return "SHORT"
    return None


def buffer_entry_level(side: str, mid: float) -> float:
    return mid + MIDPOINT_BUFFER_POINTS if side == "LONG" else mid - MIDPOINT_BUFFER_POINTS


def scan_entry(
    work: pd.DataFrame,
    setup: dict,
    earliest_idx: int,
    last_idx: int,
    side_filter: Optional[str] = None,
    allow_flip: bool = True,
) -> dict:
    """Walk candles after activation: a buffer touch within the window enters; a close across mid
    flips to the opposite setup (if allowed); a window with neither voids the setup for the day."""
    mid = setup["mid"]
    limit = min(setup["last_entry_idx"], last_idx)
    armed: Optional[Tuple[str, float, int]] = None  # side, entry level, first window candle
    k = earliest_idx + ACTIVATION_CLOSES
    while k <= limit:
        if armed is None:
            side = activated_side(work, k, mid, earliest_idx)
            if side is None or (side_filter and side != side_filter):
                k += 1
                continue
            armed = (side, buffer_entry_level(side, mid), k)
        side, level, start = armed
        open_k = float(work.loc[k, "open"])
        if side == "LONG" and float(work.loc[k, "low"]) <= level:
            return {"status": "entry", "idx": k, "side": side, "price": min(open_k, level)}
        if side == "SHORT" and float(work.loc[k, "high"]) >= level:
            return {"status": "entry", "idx": k, "side": side, "price": max(open_k, level)}
        close_k = float(work.loc[k, "close"])
        if (side == "LONG" and close_k < mid) or (side == "SHORT" and close_k > mid):
            if not allow_flip:
                return {"status": "void", "idx": k, "side": side}
            # This close counts as the first of the opposite side's 3 activation closes.
            earliest_idx, side_filter, armed = k, ("SHORT" if side == "LONG" else "LONG"), None
        elif k - start + 1 >= ENTRY_WINDOW_CANDLES:
            return {"status": "void", "idx": k, "side": side}
        k += 1
    return {"status": "open", "armed": armed, "earliest": earliest_idx, "side_filter": side_filter}


def simulate_trade(
    work: pd.DataFrame, setup: dict, entry_idx: int, side: str, entry: float, max_hold_bars: int, reason_prefix: str = ""
) -> Optional[Trade]:
    mid = setup["mid"]
    buf = MIDPOINT_BUFFER_POINTS
    stop = setup["ref_low"] if side == "LONG" else setup["ref_high"]
    risk = entry - stop if side == "LONG" else stop - entry
    if risk <= 0:
        return None
    target = entry + TARGET_POINTS if side == "LONG" else entry - TARGET_POINTS

    # Entry is intra-candle, so that candle's own close can already breach the midpoint exit.
    entry_close = float(work.loc[entry_idx, "close"])
    if (side == "LONG" and entry_close < mid - buf) or (side == "SHORT" and entry_close > mid + buf):
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
    """Trades for one day plus the setup still armed for the next candle (live use).

    First setup on either side; then one opposite-side setup if the first trade lost
    or the first setup was cancelled. Both use the same activation/entry rules.
    """
    setup = day_setup(work, day_indices)
    if setup is None:
        return None, [], None
    last_idx = day_indices[-1]
    trades: List[Trade] = []
    earliest, side_filter, allow_flip, prefix = setup["range_fixed_idx"], None, True, ""

    for phase in ("first", "opposite"):
        r = scan_entry(work, setup, earliest, last_idx, side_filter, allow_flip)
        if r["status"] == "open":
            return setup, trades, _armed_for_next(work, setup, r, day_indices)
        opposite = "SHORT" if r["side"] == "LONG" else "LONG"
        if r["status"] == "void":
            if phase == "opposite":
                break
            earliest, side_filter, allow_flip, prefix = r["idx"], opposite, False, "reverse_after_void_"
            continue
        trade = simulate_trade(work, setup, r["idx"], r["side"], r["price"], max_hold_bars, prefix)
        if trade is None:
            break
        trades.append(trade)
        exit_idx = work.index[work["timestamp"] == pd.Timestamp(trade.exit_time)][0]
        still_open = trade.reason.endswith("open")
        if phase == "opposite" or trade.pnl_points >= 0 or still_open:
            break
        earliest, side_filter, allow_flip, prefix = exit_idx, opposite, False, "reverse_after_sl_"
    return setup, trades, None


def _armed_for_next(work: pd.DataFrame, setup: dict, r: dict, day_indices: List[int]) -> Optional[dict]:
    last_idx = day_indices[-1]
    last_entry_ts = work.loc[day_indices[0], "timestamp"] + pd.Timedelta(
        minutes=TRADE_WINDOW_MINUTES - MIN_MINUTES_LEFT_FOR_ENTRY
    )
    if work.loc[last_idx, "timestamp"] >= last_entry_ts:
        return None
    if r["armed"]:
        side = r["armed"][0]
    else:
        side = activated_side(work, last_idx + 1, setup["mid"], r["earliest"])
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
