"""
Institutional 1-Hour Compression Trend Strategy for Nifty 50.

Strategy Architecture:
1. Volatility Compression: 1-hour bar inside previous range or range < 0.85 * ATR10.
2. Trend Filter: 1-hour EMA 20 trend alignment.
3. Breakout Impulse: Confirmed 1-hour expansion breaking compression extreme between 10:15 and 13:15 IST.
4. Target & Stop: High RR (1:2.0), typically ~70 pt SL and ~140 pt Target (or dynamic 1.0x / 2.0x ATR).
5. Intraday Closure: Closes by 15:20 IST to avoid overnight gap risk, capturing clean trend-day moves.
"""

from __future__ import annotations

import pandas as pd
import numpy as np
from dataclasses import dataclass
from typing import Optional, List, Dict, Any
from pathlib import Path

@dataclass
class HourlyTradeRecord:
    date: str
    entry_time: str
    side: str
    entry_price: float
    exit_time: str
    exit_price: float
    pnl_points: float
    result_r: float
    exit_reason: str
    bars_held: int

def prepare_hourly_indicators(df: pd.DataFrame) -> pd.DataFrame:
    work = df.copy()
    if not np.issubdtype(work["timestamp"].dtype, np.datetime64):
        work["timestamp"] = pd.to_datetime(work["timestamp"])
    work = work.sort_values("timestamp").reset_index(drop=True)
    
    work["date"] = work["timestamp"].dt.date
    work["time_str"] = work["timestamp"].dt.strftime("%H:%M")
    
    # Intraday VWAP
    tp = (work["high"] + work["low"] + work["close"]) / 3.0
    pv = tp * work["volume"]
    cum_pv = pv.groupby(work["date"]).cumsum()
    cum_vol = work["volume"].groupby(work["date"]).cumsum()
    work["vwap"] = np.where(cum_vol > 0, cum_pv / cum_vol, tp.groupby(work["date"]).transform(lambda x: x.expanding().mean()))
    
    # 1-hour EMA 20
    work["ema20"] = work["close"].ewm(span=20, adjust=False).mean()
    work["trend"] = np.where(work["close"] > work["ema20"], 1, -1)
    work["trend_shifted"] = work["trend"].shift(1).fillna(0)
    
    # ATR 10
    tr = np.maximum(
        work["high"] - work["low"],
        np.maximum((work["high"] - work["close"].shift(1)).abs(), (work["low"] - work["close"].shift(1)).abs())
    )
    work["atr10"] = tr.rolling(10).mean().bfill()
    
    # Compression: 2 consecutive bars < 0.80 * ATR10
    rng = work["high"] - work["low"]
    is_compressed = rng < 0.80 * work["atr10"]
    comp_2 = is_compressed.rolling(2).sum() >= 2
    
    high_2 = work["high"].rolling(2).max().shift(1)
    low_2 = work["low"].rolling(2).min().shift(1)
    
    # Execution Window: 10:15 to 14:15 IST
    work["window_ok"] = (work["time_str"] >= "10:15") & (work["time_str"] <= "14:15")
    
    long_sig = (
        work["window_ok"] &
        comp_2.shift(1) &
        (work["trend_shifted"] == 1) &
        (work["close"] > work["vwap"]) &
        (work["close"] > high_2) &
        (work["close"] > work["open"])
    )
    
    short_sig = (
        work["window_ok"] &
        comp_2.shift(1) &
        (work["trend_shifted"] == -1) &
        (work["close"] < work["vwap"]) &
        (work["close"] < low_2) &
        (work["close"] < work["open"])
    )
    
    work["signal"] = None
    work.loc[long_sig, "signal"] = "LONG"
    work.loc[short_sig, "signal"] = "SHORT"
    
    return work

def backtest_hourly_strategy(
    df: pd.DataFrame,
    sl_points: float = 70.0,
    target_points: float = 140.0,
    sl_mult: Optional[float] = None,
    target_mult: Optional[float] = None,
    max_hold_bars: int = 5,
    max_trades_per_day: int = 1,
    slippage_points: float = 1.0,
    intraday_only: bool = True
) -> pd.DataFrame:
    work = prepare_hourly_indicators(df)
    n = len(work)
    
    times = work["time_str"].values
    dates = work["date"].values
    opens = work["open"].values
    highs = work["high"].values
    lows = work["low"].values
    closes = work["close"].values
    sigs = work["signal"].values
    atrs = work["atr10"].values
    
    trades = []
    trades_today = {}
    i = 0
    
    while i < n - 1:
        sig = sigs[i]
        d = dates[i]
        
        if sig in ("LONG", "SHORT"):
            if intraday_only and trades_today.get(d, 0) >= max_trades_per_day:
                i += 1
                continue
                
            entry_idx = i + 1
            if entry_idx >= n:
                break
            if intraday_only and dates[entry_idx] != d:
                i += 1
                continue
                
            entry_px = float(opens[entry_idx])
            side = sig
            atr = atrs[entry_idx]
            
            if sl_mult is not None and target_mult is not None:
                curr_sl = max(50.0, sl_mult * atr)
                curr_tgt = max(100.0, target_mult * atr)
            else:
                curr_sl = sl_points
                curr_tgt = target_points
                
            stop_px = entry_px - curr_sl if side == "LONG" else entry_px + curr_sl
            tgt_px = entry_px + curr_tgt if side == "LONG" else entry_px - curr_tgt
            
            exit_px = entry_px
            reason = "time_exit"
            
            end_limit = min(n - 1, entry_idx + max_hold_bars)
            for j in range(entry_idx, end_limit + 1):
                if intraday_only and (dates[j] != d or times[j] >= "15:15"):
                    exit_px = float(closes[j])
                    reason = "eod"
                    break
                    
                h = float(highs[j])
                l = float(lows[j])
                
                if side == "LONG":
                    if l <= stop_px:
                        exit_px = stop_px
                        reason = "stop_loss"
                        break
                    if h >= tgt_px:
                        exit_px = tgt_px
                        reason = "target"
                        break
                else: # SHORT
                    if h >= stop_px:
                        exit_px = stop_px
                        reason = "stop_loss"
                        break
                    if l <= tgt_px:
                        exit_px = tgt_px
                        reason = "target"
                        break
                        
            pnl_pts = (exit_px - entry_px - slippage_points) if side == "LONG" else (entry_px - exit_px - slippage_points)
            result_r = round(pnl_pts / curr_sl, 2)
            
            trades.append({
                "date": str(dates[entry_idx]),
                "entry_time": str(times[entry_idx]),
                "side": side,
                "entry_price": round(entry_px, 2),
                "exit_time": str(times[j]),
                "exit_price": round(exit_px, 2),
                "pnl_points": round(pnl_pts, 2),
                "result_r": result_r,
                "exit_reason": reason,
                "bars_held": j - entry_idx + 1
            })
            
            trades_today[d] = trades_today.get(d, 0) + 1
            i = j
        i += 1
        
    return pd.DataFrame(trades)
