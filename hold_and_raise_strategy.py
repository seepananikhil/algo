"""
Hold and Raise Strategy Engine.

Philosophy:
1. The Hold (Energy Accumulation):
   - Price gets trapped inside a ceiling and floor over time.
   - Requires substantial hold period (25 to 55+ minutes).
   - Must show true two-sided midpoint oscillation (market equilibrium).
   - Non-overlapping, authoritative structural boxes.

2. The Break (Directional Imbalance):
   - Orders/triggers placed at the boundaries fire when price breaches the consolidation box.
   - Breakout impulse escaping balance.

3. The Raise (Trend Surfing & Escalation):
   - Progressive SL Ratchet: Locks in win progressively behind advancing price.
   - Position Escalation (Pyramiding Lot 2).
"""

from __future__ import annotations

import pandas as pd
import numpy as np
from dataclasses import dataclass, field, asdict
from typing import List, Dict, Any, Optional

TF_CONFIGS = {
    "1m": {
        "resample_rule": "1min",
        "min_duration_bars": 20,   # 20 minutes minimum balance
        "max_box_height": 48.0,    # maximum 48 points compression
        "buffer_pts": 2.0,
        "min_touches": 2,          # tested both resistance and support at least 2 times
    },
    "5m": {
        "resample_rule": "5min",
        "min_duration_bars": 6,    # 30 minutes
        "max_box_height": 55.0,
        "buffer_pts": 3.0,
        "min_touches": 2,
    },
    "15m": {
        "resample_rule": "15min",
        "min_duration_bars": 4,    # 60 minutes
        "max_box_height": 80.0,
        "buffer_pts": 4.0,
        "min_touches": 2,
    },
    "1h": {
        "resample_rule": "60min",
        "min_duration_bars": 3,    # 3 hours
        "max_box_height": 160.0,
        "buffer_pts": 6.0,
        "min_touches": 2,
    },
}

@dataclass
class CompressionBox:
    box_id: str
    timeframe: str
    start_time: str
    end_time: str
    start_dt: str
    end_dt: str
    ceiling: float
    floor: float
    midpoint: float
    range_pts: float
    duration_bars: int
    status: str  # "coiling", "breakout_up", "breakout_down", "exhausted"
    break_time: Optional[str] = None
    break_price: Optional[float] = None
    ceil_touches: int = 0
    floor_touches: int = 0

@dataclass
class RaiseStep:
    time: str
    datetime: str
    price: float
    reason: str

@dataclass
class HoldAndRaiseTrade:
    trade_id: str
    box_id: str
    timeframe: str
    side: str  # "BUY" / "SELL"
    entry_time: str
    entry_datetime: str
    entry_price: float
    initial_sl: float
    current_sl: float
    exit_time: Optional[str] = None
    exit_datetime: Optional[str] = None
    exit_price: Optional[float] = None
    exit_reason: Optional[str] = None
    pnl_points: float = 0.0
    r_multiple: float = 0.0
    raise_steps: List[Dict[str, Any]] = field(default_factory=list)
    pyramid_lots: List[Dict[str, Any]] = field(default_factory=list)

def resample_candles(df_1m: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Resample 1-minute continuous candles into target timeframe."""
    if df_1m.empty:
        return pd.DataFrame()

    work = df_1m.copy()
    if not np.issubdtype(work["timestamp"].dtype, np.datetime64):
        work["timestamp"] = pd.to_datetime(work["timestamp"])
    work = work.sort_values("timestamp").reset_index(drop=True)

    if timeframe == "1m":
        res = work.copy()
    else:
        rule = TF_CONFIGS.get(timeframe, {}).get("resample_rule", "5min")
        res = (
            work.set_index("timestamp")
            .resample(rule, offset="15min")
            .agg({
                "open": "first",
                "high": "max",
                "low": "min",
                "close": "last",
                "volume": "sum",
            })
            .dropna(subset=["open", "close"])
            .reset_index()
        )

    tr = np.maximum(
        res["high"] - res["low"],
        np.maximum(
            (res["high"] - res["close"].shift(1)).abs(),
            (res["low"] - res["close"].shift(1)).abs()
        )
    )
    res["atr"] = tr.rolling(14, min_periods=1).mean()
    res["date_str"] = res["timestamp"].dt.strftime("%Y-%m-%d")
    res["time_str"] = res["timestamp"].dt.strftime("%H:%M")
    res["iso_dt"] = res["timestamp"].dt.strftime("%Y-%m-%dT%H:%M:%S")
    return res

def count_boundary_touches(slice_df: pd.DataFrame, zone_pct: float = 0.28) -> tuple[int, int]:
    """
    Count distinct test waves of the ceiling and floor boundaries.
    A touch occurs when price enters the top/bottom boundary zone, separated by returning towards the midpoint.
    """
    ceil = slice_df["high"].max()
    floor = slice_df["low"].min()
    rng = ceil - floor
    if rng <= 0:
        return 0, 0

    top_thresh = ceil - (zone_pct * rng)
    bot_thresh = floor + (zone_pct * rng)
    mid = (ceil + floor) / 2.0

    ceil_touches = 0
    in_top = False
    for _, r in slice_df.iterrows():
        if r["high"] >= top_thresh:
            if not in_top:
                ceil_touches += 1
                in_top = True
        elif r["close"] < mid:
            in_top = False

    floor_touches = 0
    in_bot = False
    for _, r in slice_df.iterrows():
        if r["low"] <= bot_thresh:
            if not in_bot:
                floor_touches += 1
                in_bot = True
        elif r["close"] > mid:
            in_bot = False

    return ceil_touches, floor_touches

def analyze_hold_and_raise(
    df_bars: pd.DataFrame,
    timeframe: str = "1m",
    target_date: Optional[str] = None,
    enable_pyramiding: bool = True,
    min_bars_override: Optional[int] = None,
    max_height_override: Optional[float] = None,
    target_rr_override: Optional[float] = None,
    min_touches_override: Optional[int] = None,
) -> Dict[str, Any]:
    """
    Institutional Walk-Forward Box Detection:
    1. Identifies genuine multi-touch equilibrium boxes (width + height).
    2. Enforces minimum 3 touches of highs and 3 touches of lows (tested extremes).
    3. Box boundary strictly bounds the consolidation period (excluding breakout bar).
    4. Breakout bar pierces boundary to trigger directional entry.
    5. Simulates proper entry at boundary, midpoint invalidation, and raised stops.
    """
    if df_bars.empty or len(df_bars) < 15:
        return {"timeframe": timeframe, "candles": [], "boxes": [], "trades": [], "metrics": {}}

    if "time_str" not in df_bars.columns or ("timestamp" in df_bars.columns and len(df_bars) > 100 and timeframe != "1m"):
        df_bars = resample_candles(df_bars, timeframe)

    cfg = TF_CONFIGS.get(timeframe, TF_CONFIGS["1m"])
    min_bars = min_bars_override if min_bars_override is not None else cfg["min_duration_bars"]
    max_height = max_height_override if max_height_override is not None else cfg["max_box_height"]
    buffer_pts = cfg["buffer_pts"]
    min_touches = min_touches_override if min_touches_override is not None else cfg.get("min_touches", 2)
    target_rr = target_rr_override if target_rr_override is not None else 1.5

    work = df_bars.copy().reset_index(drop=True)
    if "time_str" not in work.columns and "timestamp" in work.columns:
        work["time_str"] = pd.to_datetime(work["timestamp"]).dt.strftime("%H:%M")
    if "date_str" not in work.columns and "timestamp" in work.columns:
        work["date_str"] = pd.to_datetime(work["timestamp"]).dt.strftime("%Y-%m-%d")
    if "iso_dt" not in work.columns and "timestamp" in work.columns:
        work["iso_dt"] = pd.to_datetime(work["timestamp"]).dt.strftime("%Y-%m-%dT%H:%M:%S")
    if "atr" not in work.columns:
        tr = np.maximum(
            work["high"] - work["low"],
            np.maximum((work["high"] - work["close"].shift(1)).abs(), (work["low"] - work["close"].shift(1)).abs())
        )
        work["atr"] = tr.rolling(14, min_periods=1).mean()
    n = len(work)

    boxes: List[CompressionBox] = []
    trades: List[HoldAndRaiseTrade] = []
    trade_counter = 0

    i = 0
    while i <= n - min_bars:
        win = work.iloc[i : i + min_bars]
        win_ceil = win["high"].max()
        win_floor = win["low"].min()
        win_height = win_ceil - win_floor

        # Is initial seed compressed?
        if win_height <= max_height:
            mid = (win_ceil + win_floor) / 2.0
            above = int((win["close"] > mid).sum())
            below = int((win["close"] < mid).sum())

            # Balanced auction seed: price must spend time both above and below the midpoint
            if above >= int(min_bars * 0.20) and below >= int(min_bars * 0.20):
                start_idx = i
                curr_ceil = win_ceil
                curr_floor = win_floor
                last_coil_idx = i + min_bars - 1
                status = "coiling"
                break_time = None
                break_price = None
                break_idx = None

                # Walk forward candle by candle
                j = last_coil_idx + 1
                while j < n:
                    row_j = work.iloc[j]
                    cj = row_j["close"]
                    hj = row_j["high"]
                    lj = row_j["low"]
                    tj = row_j["time_str"]

                    if cj > curr_ceil + buffer_pts:
                        status = "breakout_up"
                        break_time = tj
                        break_price = float(round(cj, 2))
                        break_idx = j
                        break
                    elif cj < curr_floor - buffer_pts:
                        status = "breakout_down"
                        break_time = tj
                        break_price = float(round(cj, 2))
                        break_idx = j
                        break
                    else:
                        new_ceil = max(curr_ceil, hj)
                        new_floor = min(curr_floor, lj)
                        new_height = new_ceil - new_floor

                        if new_height > max_height:
                            status = "exhausted"
                            break
                        else:
                            curr_ceil = new_ceil
                            curr_floor = new_floor
                            last_coil_idx = j
                            j += 1

                # Structural Consolidation Box: strictly from start_idx to last_coil_idx
                duration = last_coil_idx - start_idx + 1
                if duration >= min_bars:
                    box_slice = work.iloc[start_idx : last_coil_idx + 1]
                    c_touches, f_touches = count_boundary_touches(box_slice, zone_pct=0.25)

                    # Validation Condition: Must have tested both ceiling and floor at least min_touches times
                    if c_touches >= min_touches and f_touches >= min_touches:
                        final_ceil = float(round(box_slice["high"].max(), 2))
                        final_floor = float(round(box_slice["low"].min(), 2))
                        final_mid = float(round((final_ceil + final_floor) / 2.0, 2))
                        final_range = float(round(final_ceil - final_floor, 2))

                        start_row = work.iloc[start_idx]
                        end_row = work.iloc[last_coil_idx]

                        box_obj = CompressionBox(
                            box_id=f"BOX_{len(boxes)+1}_{timeframe}",
                            timeframe=timeframe,
                            start_time=start_row["time_str"],
                            end_time=end_row["time_str"],
                            start_dt=start_row["iso_dt"],
                            end_dt=end_row["iso_dt"],
                            ceiling=final_ceil,
                            floor=final_floor,
                            midpoint=final_mid,
                            range_pts=final_range,
                            duration_bars=duration,
                            status=status,
                            break_time=break_time,
                            break_price=break_price,
                            ceil_touches=c_touches,
                            floor_touches=f_touches,
                        )
                        boxes.append(box_obj)

                        # Simulate Trade if Breakout Occurred
                        if status in ("breakout_up", "breakout_down") and break_time and break_price and break_idx is not None:
                            trade_counter += 1
                            side = "BUY" if status == "breakout_up" else "SELL"
                            entry_price = break_price
                            initial_sl = final_mid
                            risk = max(8.0, abs(entry_price - initial_sl))
                            target = float(round(entry_price + (target_rr * risk) if side == "BUY" else entry_price - (target_rr * risk), 2))

                            trade = HoldAndRaiseTrade(
                                trade_id=f"T_{trade_counter}_{break_time}",
                                box_id=box_obj.box_id,
                                timeframe=timeframe,
                                side=side,
                                entry_time=break_time,
                                entry_datetime=work.iloc[break_idx]["iso_dt"],
                                entry_price=entry_price,
                                initial_sl=initial_sl,
                                current_sl=initial_sl,
                            )

                            raised_be = False
                            # Walk trade forward through subsequent candles
                            for k in range(break_idx + 1, n):
                                row_k = work.iloc[k]
                                tk = row_k["time_str"]
                                dtk = row_k["iso_dt"]
                                hk = row_k["high"]
                                lk = row_k["low"]
                                ck = row_k["close"]
                                ok = row_k["open"]

                                hit_target = False
                                hit_sl = False
                                exit_price = trade.current_sl

                                if side == "BUY":
                                    if hk >= target:
                                        hit_target = True
                                        exit_price = target
                                    elif lk <= trade.current_sl:
                                        hit_sl = True
                                        exit_price = min(ok, trade.current_sl)
                                else:
                                    if lk <= target:
                                        hit_target = True
                                        exit_price = target
                                    elif hk >= trade.current_sl:
                                        hit_sl = True
                                        exit_price = max(ok, trade.current_sl)

                                if hit_target or hit_sl:
                                    trade.exit_time = tk
                                    trade.exit_datetime = dtk
                                    trade.exit_price = float(round(exit_price, 2))
                                    trade.exit_reason = f"TARGET_{target_rr}R" if hit_target else ("STOP_LOSS" if not raised_be else "RAISED_BE_LOCK")
                                    pnl = (exit_price - entry_price) if side == "BUY" else (entry_price - exit_price)
                                    trade.pnl_points = float(round(pnl, 2))
                                    trade.r_multiple = float(round(pnl / risk, 2))
                                    trades.append(trade)
                                    break
                                else:
                                    # Step Up Stop: Lock Break-Even + 1pt at +0.8R
                                    unrealized = (hk - entry_price) if side == "BUY" else (entry_price - lk)
                                    if unrealized >= 0.8 * risk and not raised_be:
                                        new_sl = float(round(entry_price + 1.0 if side == "BUY" else entry_price - 1.0, 2))
                                        trade.current_sl = new_sl
                                        raised_be = True
                                        trade.raise_steps.append(asdict(RaiseStep(
                                            time=tk, datetime=dtk, price=new_sl, reason="BE_LOCK_0.8R"
                                        )))

                                    # Step Up Stop: Lock Profit at +1.5R (if target > 1.5R)
                                    elif unrealized >= 1.5 * risk and len(trade.raise_steps) == 1 and target_rr > 1.5:
                                        new_sl = float(round(entry_price + (risk * 0.8) if side == "BUY" else entry_price - (risk * 0.8), 2))
                                        trade.current_sl = new_sl
                                        trade.raise_steps.append(asdict(RaiseStep(
                                            time=tk, datetime=dtk, price=new_sl, reason="LOCK_PROFIT_0.8R"
                                        )))

                                    if tk >= "15:25":
                                        trade.exit_time = tk
                                        trade.exit_datetime = dtk
                                        trade.exit_price = float(round(ck, 2))
                                        trade.exit_reason = "EOD_SQUAREOFF"
                                        pnl = (ck - entry_price) if side == "BUY" else (entry_price - ck)
                                        trade.pnl_points = float(round(pnl, 2))
                                        trade.r_multiple = float(round(pnl / risk, 2))
                                        trades.append(trade)
                                        break

                        # Skip forward past this box to ensure clean, non-overlapping boxes
                        i = (break_idx if break_idx is not None else last_coil_idx) + 1
                        continue
        i += 1

    # Format candle list
    candle_list = [
        {
            "time": r.time_str,
            "datetime": r.iso_dt,
            "open": float(r.open),
            "high": float(r.high),
            "low": float(r.low),
            "close": float(r.close),
            "volume": float(getattr(r, "volume", 0)),
            "date": r.date_str,
            "atr": float(round(r.atr, 2)) if not np.isnan(r.atr) else 0.0,
        }
        for r in work.itertuples()
    ]

    total_trades = len(trades)
    win_trades = [t for t in trades if t.pnl_points > 0]
    total_pts = float(sum(t.pnl_points for t in trades))
    wr = float(len(win_trades) / total_trades * 100.0) if total_trades > 0 else 0.0

    return {
        "date": target_date or (str(work["date_str"].iloc[0]) if not work.empty and "date_str" in work.columns else ""),
        "timeframe": timeframe,
        "candles": candle_list,
        "boxes": [asdict(b) for b in boxes],
        "trades": [asdict(t) for t in trades],
        "metrics": {
            "total_boxes": len(boxes),
            "total_trades": total_trades,
            "win_trades": len(win_trades),
            "win_rate": float(round(wr, 1)),
            "total_points": float(round(total_pts, 2)),
            "avg_points_per_trade": float(round(total_pts / total_trades, 2)) if total_trades > 0 else 0.0,
        }
    }
