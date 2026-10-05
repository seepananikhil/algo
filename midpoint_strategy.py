from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import List, Optional

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
) -> tuple[int, float, str]:
    last_idx = min(len(df) - 1, entry_idx + max_hold_bars, cutoff_idx)

    for j in range(entry_idx + 1, last_idx + 1):
        high_j = float(df.loc[j, "high"])
        low_j = float(df.loc[j, "low"])
        close_j = float(df.loc[j, "close"])

        if side == "LONG":
            # Immediate protection exit: close below midpoint buffer invalidates LONG.
            if close_j < (midpoint - midpoint_buffer_points):
                return j, close_j, "midpoint_close_exit"

            hit_stop = low_j <= stop
            hit_target = high_j >= target
            if hit_stop and hit_target:
                return j, stop, "both_hit_stop_first_assumed"
            if hit_stop:
                return j, stop, "stop"
            if hit_target:
                return j, target, "target"
        else:
            # Immediate protection exit: close above midpoint buffer invalidates SHORT.
            if close_j > (midpoint + midpoint_buffer_points):
                return j, close_j, "midpoint_close_exit"

            hit_stop = high_j >= stop
            hit_target = low_j <= target
            if hit_stop and hit_target:
                return j, stop, "both_hit_stop_first_assumed"
            if hit_stop:
                return j, stop, "stop"
            if hit_target:
                return j, target, "target"

    return last_idx, float(df.loc[last_idx, "close"]), "time_exit"


def backtest_midpoint_strategy(df: pd.DataFrame, rr: float = 1.0, max_hold_bars: int = 20) -> pd.DataFrame:
    trades: List[Trade] = []
    if df.empty:
        return pd.DataFrame()

    midpoint_buffer_points = 5.0
    near_midpoint_points = midpoint_buffer_points
    min_directional_distance_points = 0.0
    min_first_candle_body_ratio = 0.12

    work = df.copy()
    work["trade_day"] = work["timestamp"].dt.date

    for _, day_df in work.groupby("trade_day", sort=True):
        day_indices = day_df.index.tolist()
        if len(day_indices) < 5:
            continue

        day_start = day_indices[0]
        day_end = day_indices[-1]
        day_start_ts = work.loc[day_start, "timestamp"]
        day_cutoff_ts = day_start_ts + pd.Timedelta(minutes=30)
        cutoff_candidates = [idx for idx in day_indices if work.loc[idx, "timestamp"] <= day_cutoff_ts]
        if not cutoff_candidates:
            continue
        day_cutoff_idx = cutoff_candidates[-1]

        # First swing only: keep first candle as reference, then start from
        # whichever arrives first:
        # 1) one-sided first-candle range break, or
        # 2) midpoint cross by candle close.
        setup_idx = day_start
        break_idx: Optional[int] = None
        initial_dir: Optional[str] = None

        ref = work.loc[setup_idx]
        ref_high = float(ref["high"])
        ref_low = float(ref["low"])
        ref_open = float(ref["open"])
        ref_close = float(ref["close"])

        # Skip indecisive opening candles (very small body vs full range).
        # This avoids days where first candle direction quality is weak.
        first_range = ref_high - ref_low
        first_body = abs(ref_close - ref_open)
        if first_range <= 0:
            continue
        if (first_body / first_range) < min_first_candle_body_ratio:
            continue

        # Midpoint anchor logic (opening candles):
        # - Candle 2: if inside candle 1, keep range; else extend range.
        # - Candle 3: if it breaks candle 2 high/low, include candle 3 in range.
        # This keeps reference responsive when early momentum extends on candle 3.
        second_idx = day_indices[1] if len(day_indices) > 1 else None
        third_idx = day_indices[2] if len(day_indices) > 2 else None
        if second_idx is not None:
            second_row = work.loc[second_idx]
            second_high = float(second_row["high"])
            second_low = float(second_row["low"])
            second_is_inside = second_high <= ref_high and second_low >= ref_low
            if not second_is_inside:
                ref_high = max(ref_high, second_high)
                ref_low = min(ref_low, second_low)

            if third_idx is not None:
                third_row = work.loc[third_idx]
                third_high = float(third_row["high"])
                third_low = float(third_row["low"])
                third_breaks_second = third_high > second_high or third_low < second_low
                if third_breaks_second:
                    ref_high = max(ref_high, third_high)
                    ref_low = min(ref_low, third_low)

        ref_mid = (ref_high + ref_low) / 2.0
        opening_range = ref_high - ref_low
        aggressive_buffer = 6.0 if opening_range >= 50.0 else 0.0
        activation_reach_points = 2.0
        activation_buffer_points = max(aggressive_buffer, near_midpoint_points) + activation_reach_points

        range_break_idx: Optional[int] = None
        range_break_dir: Optional[str] = None
        anchor_count = 3 if third_idx is not None else 2
        break_search_start = day_start + anchor_count
        for j in range(break_search_start, day_end + 1):
            row_j = work.loc[j]
            row_high = float(row_j["high"])
            row_low = float(row_j["low"])
            broke_high = row_high > ref_high
            broke_low = row_low < ref_low

            if broke_high and not broke_low:
                range_break_idx = j
                range_break_dir = "LONG"
                break
            if broke_low and not broke_high:
                range_break_idx = j
                range_break_dir = "SHORT"
                break

        mid_cross_idx: Optional[int] = None
        mid_cross_dir: Optional[str] = None
        if third_idx is not None:
            prev_close = float(work.loc[third_idx, "close"])
            mid_cross_start = day_start + 3
        elif second_idx is not None:
            prev_close = float(work.loc[second_idx, "close"])
            mid_cross_start = day_start + 2
        else:
            prev_close = float(ref["close"])
            mid_cross_start = day_start + 1

        for j in range(mid_cross_start, day_end + 1):
            close_j = float(work.loc[j, "close"])
            if prev_close <= ref_mid < close_j:
                mid_cross_idx = j
                mid_cross_dir = "LONG"
                break
            if prev_close >= ref_mid > close_j:
                mid_cross_idx = j
                mid_cross_dir = "SHORT"
                break
            prev_close = close_j

        trigger_source = "range_break"
        if mid_cross_idx is not None and (range_break_idx is None or mid_cross_idx < range_break_idx):
            break_idx = mid_cross_idx
            initial_dir = mid_cross_dir
            trigger_source = "mid_cross"
        else:
            break_idx = range_break_idx
            initial_dir = range_break_dir

        # If no midpoint close-cross exists, allow early activation from
        # midpoint buffer entry before the range-break trigger.
        if (
            trigger_source == "range_break"
            and mid_cross_idx is None
            and break_idx is not None
            and break_idx > break_search_start
        ):
            for j in range(break_search_start, break_idx):
                row_j = work.loc[j]
                if not candle_touches_mid_with_buffer(row_j, ref_mid, activation_buffer_points):
                    continue
                close_j = float(row_j["close"])
                break_idx = j
                initial_dir = "LONG" if close_j >= ref_mid else "SHORT"
                trigger_source = "mid_cross"
                break

        if break_idx is None or initial_dir is None:
            continue

        # Use full opening window for retrace/entry search.
        touch_deadline = min(day_end, day_cutoff_idx)

        # Retrace (user-preferred): first pause after the trigger break.
        # For SHORT, retrace starts when a candle no longer makes a lower low.
        # For LONG, retrace starts when a candle no longer makes a higher high.
        # Inside candles are naturally included in this definition.
        retrace_idx: Optional[int] = None
        for j in range(break_idx + 1, touch_deadline + 1):
            prev_high = float(work.loc[j - 1, "high"])
            prev_low = float(work.loc[j - 1, "low"])
            curr_high = float(work.loc[j, "high"])
            curr_low = float(work.loc[j, "low"])

            if initial_dir == "LONG":
                pause_after_break = curr_high <= prev_high
            else:
                pause_after_break = curr_low >= prev_low

            if pause_after_break:
                retrace_idx = j
                break

        if retrace_idx is None:
            continue

        # Preserve continuation extreme tracking for midpoint projection when
        # range-break flow uses continuation extension.
        prev_idx = break_idx
        for j in range(break_idx + 1, touch_deadline + 1):
            prev_high = float(work.loc[prev_idx, "high"])
            prev_low = float(work.loc[prev_idx, "low"])
            curr_high = float(work.loc[j, "high"])
            curr_low = float(work.loc[j, "low"])

            if initial_dir == "LONG":
                if curr_high > prev_high:
                    prev_idx = j
                    continue
                break
            else:
                if curr_low < prev_low:
                    prev_idx = j
                    continue
                break

        # Midpoint rule:
        # - Mid-cross trigger path: use first-candle midpoint only.
        # - Range-break path: use continuation-based midpoint when available,
        #   else first-candle midpoint fallback.
        if trigger_source == "mid_cross":
            mid = (ref_high + ref_low) / 2.0
        elif prev_idx == break_idx:
            mid = (ref_high + ref_low) / 2.0
        elif initial_dir == "LONG":
            cont_extreme = float(work.loc[prev_idx, "high"])
            mid = (ref_low + cont_extreme) / 2.0
        else:
            cont_extreme = float(work.loc[prev_idx, "low"])
            mid = (ref_high + cont_extreme) / 2.0

        entry_idx: Optional[int] = None
        final_side: Optional[str] = None

        # Midpoint-break activation mode:
        # If setup started from midpoint cross, activate on that candle and
        # take next-candle entry when direction sustains.
        if trigger_source == "mid_cross":
            activation_idx = break_idx
            next_idx = activation_idx + 1
            if next_idx <= touch_deadline and next_idx <= day_cutoff_idx:
                activation_close = float(work.loc[activation_idx, "close"])
                next_close = float(work.loc[next_idx, "close"])
                activation_ok = (initial_dir == "LONG" and activation_close > mid) or (initial_dir == "SHORT" and activation_close < mid)
                next_ok = (initial_dir == "LONG" and next_close >= mid) or (initial_dir == "SHORT" and next_close < mid)
                if activation_ok and next_ok:
                    final_side = initial_dir
                    entry_idx = next_idx

        expected_side = initial_dir
        scan_start = retrace_idx

        # Entry rule: after midpoint touch, require confirmation within
        # midpoint buffer and sustain on next candle. If sustain fails in
        # initial direction, switch expected side and require full
        # re-confirmation (same buffer rules) instead of immediate reverse.
        while scan_start < touch_deadline and entry_idx is None:
            restart_with_reverse = False

            for k in range(scan_start, touch_deadline):
                row_k = work.loc[k]
                close_k = float(row_k["close"])
                activation_by_buffer = candle_touches_mid_with_buffer(row_k, mid, activation_buffer_points)
                activation_by_sustain = (
                    expected_side == initial_dir
                    and ((initial_dir == "LONG" and close_k >= mid) or (initial_dir == "SHORT" and close_k < mid))
                )

                # Activation:
                # - primary: entry into midpoint buffer zone
                # - fallback: continuation sustain on expected side
                if not (activation_by_buffer or activation_by_sustain):
                    continue

                for m in range(k + 1, touch_deadline + 1):
                    close_m = float(work.loc[m, "close"])
                    high_m = float(work.loc[m, "high"])
                    low_m = float(work.loc[m, "low"])

                    if expected_side == initial_dir:
                        side_m = initial_dir

                        # Initial-direction execution:
                        # after setup activation candle k, only next candle
                        # (k+1) can trigger entry. It does not need to retouch
                        # buffer; it must sustain on the expected side.
                        if m != (k + 1):
                            break

                        sustain_side_ok = (side_m == "LONG" and close_m >= mid) or (side_m == "SHORT" and close_m < mid)
                        if not sustain_side_ok:
                            break

                        final_side = side_m
                        entry_idx = m
                        break
                    else:
                        # Reverse side must still satisfy same midpoint-side
                        # close behavior before entry.
                        side_m = expected_side
                        if side_m == "LONG" and close_m < mid:
                            continue
                        if side_m == "SHORT" and close_m >= mid:
                            continue

                    # Entry quality check near midpoint buffer:
                    # - Initial direction: require confirmation close near midpoint.
                    # - Reverse revalidation: allow confirmation when candle enters
                    #   midpoint buffer zone (not only close-in-buffer).
                    if expected_side == initial_dir:
                        if abs(close_m - mid) > near_midpoint_points:
                            continue
                    else:
                        if not candle_touches_mid_with_buffer(work.loc[m], mid, near_midpoint_points):
                            continue

                        # Reverse revalidation flow:
                        # 1) activation candle sustains on reverse side of midpoint
                        # 2) next candle must come into midpoint buffer zone
                        # 3) enter on that next candle
                        activation_sustain = (side_m == "LONG" and close_m >= mid) or (side_m == "SHORT" and close_m < mid)
                        if not activation_sustain:
                            continue

                        reverse_entry_idx = m + 1
                        if reverse_entry_idx > touch_deadline or reverse_entry_idx > day_cutoff_idx:
                            continue
                        if not candle_touches_mid_with_buffer(work.loc[reverse_entry_idx], mid, near_midpoint_points):
                            continue

                        final_side = side_m
                        entry_idx = reverse_entry_idx
                        break

                    # Avoid fragile entries too close to midpoint.
                    if side_m == "LONG" and (close_m - mid) < min_directional_distance_points:
                        continue
                    if side_m == "SHORT" and (mid - close_m) < min_directional_distance_points:
                        continue

                    # Rejection confirmation from midpoint:
                    # SHORT needs candle to come down from midpoint zone.
                    # LONG needs candle to come up from midpoint zone.
                    if side_m == "SHORT" and high_m < mid:
                        continue
                    if side_m == "LONG" and low_m > mid:
                        continue

                    sustain_idx = m + 1
                    if sustain_idx > touch_deadline or sustain_idx > day_cutoff_idx:
                        continue

                    sustain_close = float(work.loc[sustain_idx, "close"])
                    sustain_same_side = (side_m == "LONG" and sustain_close >= mid) or (side_m == "SHORT" and sustain_close < mid)
                    if not sustain_same_side:
                        if expected_side == initial_dir:
                            expected_side = "SHORT" if initial_dir == "LONG" else "LONG"
                            scan_start = sustain_idx
                            restart_with_reverse = True
                            break
                        continue

                    final_side = side_m
                    entry_idx = sustain_idx
                    break

                if entry_idx is not None or restart_with_reverse:
                    break

            if not restart_with_reverse:
                break

        # Midpoint not touched in first 10 minutes => no trade for this day.
        if entry_idx is None or final_side is None:
            continue

        if entry_idx > day_cutoff_idx:
            continue

        fixed_target_points = 40.0
        entry = float(work.loc[entry_idx, "close"])
        if final_side == "LONG":
            stop = ref_low
            risk = entry - stop
            if risk <= 0:
                continue
            target = entry + fixed_target_points
        else:
            stop = ref_high
            risk = stop - entry
            if risk <= 0:
                continue
            target = entry - fixed_target_points

        exit_idx, exit_price, reason = resolve_exit(
            df=work,
            entry_idx=entry_idx,
            side=final_side,
            midpoint=mid,
            midpoint_buffer_points=midpoint_buffer_points,
            stop=stop,
            target=target,
            max_hold_bars=max_hold_bars,
            cutoff_idx=day_cutoff_idx,
        )

        if final_side == "LONG":
            pnl = exit_price - entry
            result_r = pnl / risk
        else:
            pnl = entry - exit_price
            result_r = pnl / risk

        trades.append(
            Trade(
                entry_time=str(work.loc[entry_idx, "timestamp"]),
                exit_time=str(work.loc[exit_idx, "timestamp"]),
                setup_index=setup_idx,
                side=final_side,
                entry=entry,
                midpoint=mid,
                stop=stop,
                target=target,
                exit_price=exit_price,
                result_r=result_r,
                pnl_points=pnl,
                bars_held=exit_idx - entry_idx,
                reason=reason,
            )
        )

        # Max 2 trades/day and reverse only if first trade is in loss.
        if pnl < 0:
            rev_entry_idx = exit_idx + 1
            if rev_entry_idx <= day_end and rev_entry_idx < len(work) and rev_entry_idx <= day_cutoff_idx:
                rev_side = "SHORT" if final_side == "LONG" else "LONG"
                rev_entry = float(work.loc[rev_entry_idx, "open"])

                if rev_side == "LONG":
                    rev_stop = ref_low
                    rev_risk = rev_entry - rev_stop
                    if rev_risk > 0:
                        rev_target = rev_entry + fixed_target_points
                    else:
                        rev_target = None
                else:
                    rev_stop = ref_high
                    rev_risk = rev_stop - rev_entry
                    if rev_risk > 0:
                        rev_target = rev_entry - fixed_target_points
                    else:
                        rev_target = None

                if rev_target is not None:
                    rev_exit_idx, rev_exit_price, rev_reason = resolve_exit(
                        df=work,
                        entry_idx=rev_entry_idx,
                        side=rev_side,
                        midpoint=mid,
                        midpoint_buffer_points=midpoint_buffer_points,
                        stop=rev_stop,
                        target=rev_target,
                        max_hold_bars=max_hold_bars,
                        cutoff_idx=day_cutoff_idx,
                    )

                    if rev_side == "LONG":
                        rev_pnl = rev_exit_price - rev_entry
                        rev_result_r = rev_pnl / rev_risk
                    else:
                        rev_pnl = rev_entry - rev_exit_price
                        rev_result_r = rev_pnl / rev_risk

                    trades.append(
                        Trade(
                            entry_time=str(work.loc[rev_entry_idx, "timestamp"]),
                            exit_time=str(work.loc[rev_exit_idx, "timestamp"]),
                            setup_index=setup_idx,
                            side=rev_side,
                            entry=rev_entry,
                            midpoint=mid,
                            stop=rev_stop,
                            target=rev_target,
                            exit_price=rev_exit_price,
                            result_r=rev_result_r,
                            pnl_points=rev_pnl,
                            bars_held=rev_exit_idx - rev_entry_idx,
                            reason=f"reverse_after_sl_{rev_reason}",
                        )
                    )

    return pd.DataFrame([asdict(t) for t in trades])
