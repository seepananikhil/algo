"""
Adaptive Micro-Compression Momentum Scalper (CMS-ATR) for Nifty 50 1-Minute Intraday.

Adaptive Features:
1. Multi-Timeframe Trend: 5-minute EMA 20 + Intraday VWAP alignment.
2. Volatility Compression: 2 consecutive bars inside 0.75 * ATR10.
3. Momentum Expansion: Enters on first expansion candle breaking the compression extreme.
4. Adaptive ATR Sizing: Stop Loss = 1.0 * ATR10, Target = 1.5 * ATR10 (scales dynamically with volatility).
5. Active Session Filter: 09:20 - 11:30 IST & 13:15 - 15:05 IST (skips midday chop).
6. Sniper Limit: 1 to 2 trades max per day, 7-min Time Stop.
"""

from __future__ import annotations

import pandas as pd
import numpy as np
from dataclasses import dataclass
from typing import List, Optional, Dict, Any
from pathlib import Path

@dataclass
class ScalpTradeRecord:
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

def prepare_scalp_indicators(df: pd.DataFrame) -> pd.DataFrame:
    work = df.copy()
    if not np.issubdtype(work["timestamp"].dtype, np.datetime64):
        work["timestamp"] = pd.to_datetime(work["timestamp"])
    work = work.sort_values("timestamp").reset_index(drop=True)
    
    # Auto-detect IST vs UTC
    # Indian market hours: 09:15 to 15:30 IST (03:45 to 10:00 UTC)
    first_hour = work["timestamp"].iloc[0].hour
    if 3 <= first_hour <= 4:
        # UTC data, convert to IST
        work["dt_ist"] = work["timestamp"] + pd.Timedelta(hours=5, minutes=30)
    else:
        # Already IST
        work["dt_ist"] = work["timestamp"]
    work["date"] = work["dt_ist"].dt.date
    work["time_str"] = work["dt_ist"].dt.strftime("%H:%M")
    
    # Intraday VWAP
    work["tp"] = (work["high"] + work["low"] + work["close"]) / 3.0
    work["pv"] = work["tp"] * work["volume"]
    work["cum_pv"] = work.groupby("date")["pv"].cumsum()
    work["cum_vol"] = work.groupby("date")["volume"].cumsum()
    work["vwap"] = np.where(work["cum_vol"] > 0, work["cum_pv"] / work["cum_vol"], work.groupby("date")["tp"].transform(lambda x: x.expanding().mean()))
    
    # Resample 5-minute closed bars for higher timeframe trend
    df_5m = work.set_index("timestamp").resample("5min").agg({
        "open": "first", "high": "max", "low": "min", "close": "last"
    }).dropna()
    df_5m["ema20_5m"] = df_5m["close"].ewm(span=20, adjust=False).mean()
    df_5m["trend_5m"] = np.where(df_5m["close"] > df_5m["ema20_5m"], 1, -1)
    df_5m["trend_5m_shifted"] = df_5m["trend_5m"].shift(1).fillna(0)
    
    work = work.merge(df_5m[["trend_5m_shifted"]], left_on="timestamp", right_index=True, how="left")
    work["trend_5m"] = work["trend_5m_shifted"].ffill().fillna(0)
    
    # 1-minute indicators
    tr = np.maximum(work["high"] - work["low"], np.maximum((work["high"] - work["close"].shift(1)).abs(), (work["low"] - work["close"].shift(1)).abs()))
    work["atr10"] = tr.rolling(10).mean().fillna(10.0)
    
    # Micro compression: 2 consecutive bars inside 0.75 ATR
    c_rng = work["high"] - work["low"]
    work["is_compressed"] = c_rng < 0.75 * work["atr10"]
    work["comp_2"] = work["is_compressed"].rolling(2).sum() >= 2
    
    work["high_2"] = work["high"].rolling(2).max().shift(1)
    work["low_2"] = work["low"].rolling(2).min().shift(1)
    
    # Active Scalping Sessions: 09:20-11:30 & 13:15-15:05 IST
    work["session_ok"] = ((work["time_str"] >= "09:20") & (work["time_str"] <= "11:30")) | ((work["time_str"] >= "13:15") & (work["time_str"] <= "15:05"))
    
    # Signal Generation
    long_sig = (
        work["session_ok"] &
        (work["trend_5m"] == 1) &
        (work["close"] > work["vwap"]) &
        work["comp_2"].shift(1) &
        (work["close"] > work["high_2"]) &
        (work["close"] > work["open"]) &
        (c_rng >= 0.8 * work["atr10"])
    )
    
    short_sig = (
        work["session_ok"] &
        (work["trend_5m"] == -1) &
        (work["close"] < work["vwap"]) &
        work["comp_2"].shift(1) &
        (work["close"] < work["low_2"]) &
        (work["close"] < work["open"]) &
        (c_rng >= 0.8 * work["atr10"])
    )
    
    work["signal"] = None
    work.loc[long_sig, "signal"] = "LONG"
    work.loc[short_sig, "signal"] = "SHORT"
    
    return work

def backtest_compression_scalp(
    df: pd.DataFrame,
    sl_points: Optional[float] = 14.0,
    target_points: Optional[float] = 20.0,
    sl_atr_mult: Optional[float] = None,
    target_atr_mult: Optional[float] = None,
    max_hold_bars: int = 8,
    max_trades_per_day: int = 1,
    slippage_points: float = 0.5,
    stop_on_loss_day: bool = False,
) -> pd.DataFrame:
    work = prepare_scalp_indicators(df)
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
    i = 0
    trades_today = {}
    losses_today = {}
    
    while i < n - 1:
        sig = sigs[i]
        d = dates[i]
        
        if sig in ("LONG", "SHORT"):
            if trades_today.get(d, 0) >= max_trades_per_day:
                i += 1
                continue
            if stop_on_loss_day and losses_today.get(d, 0) >= 1:
                i += 1
                continue
                
            entry_idx = i + 1
            if entry_idx >= n or dates[entry_idx] != d:
                i += 1
                continue
                
            entry_price = float(opens[entry_idx])
            side = sig
            
            # Determine dynamic or fixed SL/Target
            atr_val = atrs[entry_idx]
            if sl_atr_mult is not None and target_atr_mult is not None:
                curr_sl_pts = max(6.0, sl_atr_mult * atr_val)
                curr_target_pts = max(9.0, target_atr_mult * atr_val)
            else:
                curr_sl_pts = sl_points if sl_points is not None else 12.0
                curr_target_pts = target_points if target_points is not None else 18.0
                
            stop_price = entry_price - curr_sl_pts if side == "LONG" else entry_price + curr_sl_pts
            target_price = entry_price + curr_target_pts if side == "LONG" else entry_price - curr_target_pts
            
            exit_idx = entry_idx
            exit_price = entry_price
            reason = "time_exit"
            
            end_limit = min(n - 1, entry_idx + max_hold_bars)
            for j in range(entry_idx, end_limit + 1):
                if dates[j] != d or times[j] >= "15:20":
                    exit_idx = j
                    exit_price = float(closes[j])
                    reason = "eod"
                    break
                    
                h = float(highs[j])
                l = float(lows[j])
                c = float(closes[j])
                
                if side == "LONG":
                    if l <= stop_price:
                        exit_idx = j
                        exit_price = stop_price
                        reason = "stop_loss"
                        break
                    if h >= target_price:
                        exit_idx = j
                        exit_price = target_price
                        reason = "target"
                        break
                else: # SHORT
                    if h >= stop_price:
                        exit_idx = j
                        exit_price = stop_price
                        reason = "stop_loss"
                        break
                    if l <= target_price:
                        exit_idx = j
                        exit_price = target_price
                        reason = "target"
                        break
            else:
                exit_idx = end_limit
                exit_price = float(closes[end_limit])
                reason = "time_exit"
                
            pnl = (exit_price - entry_price - slippage_points) if side == "LONG" else (entry_price - exit_price - slippage_points)
            result_r = pnl / curr_sl_pts
            
            trades_today[d] = trades_today.get(d, 0) + 1
            if pnl <= 0:
                losses_today[d] = losses_today.get(d, 0) + 1
            trades.append(ScalpTradeRecord(
                date=str(d),
                entry_time=str(times[entry_idx]),
                side=side,
                entry_price=round(entry_price, 2),
                exit_time=str(times[exit_idx]),
                exit_price=round(exit_price, 2),
                pnl_points=round(pnl, 2),
                result_r=round(result_r, 2),
                exit_reason=reason,
                bars_held=exit_idx - entry_idx + 1
            ))
            i = exit_idx
        else:
            i += 1
            
    if not trades:
        return pd.DataFrame()
    return pd.DataFrame([t.__dict__ for t in trades])

def summarize_scalp_performance(trades_df: pd.DataFrame) -> Dict[str, Any]:
    if trades_df.empty:
        return {"total_trades": 0, "win_rate_pct": 0.0, "total_pnl_points": 0.0}
        
    wins = trades_df[trades_df["pnl_points"] > 0]
    losses = trades_df[trades_df["pnl_points"] <= 0]
    total_trades = len(trades_df)
    win_rate = (len(wins) / total_trades) * 100
    total_pnl = trades_df["pnl_points"].sum()
    gp = wins["pnl_points"].sum() if not wins.empty else 0.0
    gl = abs(losses["pnl_points"].sum()) if not losses.empty else 1e-6
    pf = gp / gl
    
    trades_df["cum"] = trades_df["pnl_points"].cumsum()
    max_dd = (trades_df["cum"].cummax() - trades_df["cum"]).max()
    
    return {
        "total_trades": total_trades,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate_pct": round(win_rate, 2),
        "profit_factor": round(pf, 2),
        "total_pnl_points": round(total_pnl, 2),
        "avg_pnl_points": round(trades_df["pnl_points"].mean(), 2),
        "max_drawdown_points": round(max_dd, 2),
        "avg_bars_held": round(trades_df["bars_held"].mean(), 1),
        "exit_breakdown": trades_df["exit_reason"].value_counts().to_dict(),
    }
