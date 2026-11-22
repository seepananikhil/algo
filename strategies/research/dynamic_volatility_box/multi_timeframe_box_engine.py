#!/usr/bin/env python3
"""
Multi-Timeframe Box Breakout Engine
Evaluates Box Formulations on: 1m, 3m, 5m, 15m, 30m, 1h (60m)
With Breakout (BO) captured dynamically at 1-minute resolution!
"""

import os
import time
import pandas as pd
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple

@dataclass
class MTFTrade:
    trade_id: int
    direction: str          # 'LONG' or 'SHORT'
    entry_idx_1m: int
    entry_time: str
    entry_price: float
    box_high: float
    box_low: float
    box_median: float
    box_depth: float
    htf_atr: float
    risk_units: float
    initial_sl: float
    active_sl: float
    tp_price: float
    be_price: float
    be_activated: bool = False
    exit_idx_1m: int = -1
    exit_time: str = ""
    exit_price: float = 0.0
    exit_reason: str = ""   # 'TP', 'BE', 'SL', 'EOD'
    pnl_pts: float = 0.0
    pnl_r: float = 0.0
    bars_held_1m: int = 0


def compute_wilder_atr(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(highs)
    tr = np.zeros(n)
    tr[0] = highs[0] - lows[0]
    for i in range(1, n):
        tr[i] = max(highs[i] - lows[i], abs(highs[i] - closes[i-1]), abs(lows[i] - closes[i-1]))
    atr = np.zeros(n)
    if n >= period:
        atr[period - 1] = np.mean(tr[:period])
        alpha = 1.0 / period
        for i in range(period, n):
            atr[i] = atr[i - 1] * (1.0 - alpha) + tr[i] * alpha
    return atr


def run_mtf_box_backtest(
    df_1m: pd.DataFrame,
    htf: str = '15min',
    lookback: int = 14,
    atr_period: int = 14,
    target_mult: float = 2.0,
    min_vol: float = 0.5,
    max_vol: float = 2.5,
    body_confirm_ratio: float = 0.50,
    use_breakeven: bool = False,
    be_trigger_mult: float = 1.0,
    intraday_mode: bool = True,
    eod_exit_time: str = "15:20",
    entry_cutoff_time: str = "15:00"
) -> Tuple[pd.DataFrame, Dict]:
    """
    State 0: Box formulated on HTF (e.g. 1m, 3m, 5m, 15m, 30m, 60m).
    State 1: Breakout captured at 1-minute candle close as soon as 1m bar confirms breakout!
    State 2: Managed tick-by-tick on every 1-minute candle.
    """
    df_1m = df_1m.copy()
    if not isinstance(df_1m.index, pd.DatetimeIndex):
        df_1m['timestamp'] = pd.to_datetime(df_1m['timestamp'])
        df_1m.sort_values('timestamp', inplace=True)
        df_1m.reset_index(drop=True, inplace=True)
        
    df_1m['date_str'] = df_1m['timestamp'].dt.strftime('%Y-%m-%d')
    df_1m['time_str'] = df_1m['timestamp'].dt.strftime('%H:%M')
    
    # Resample to HTF
    if htf in ['1m', '1min']:
        df_htf = df_1m.copy()
    else:
        df_htf = df_1m.set_index('timestamp').resample(htf).agg({
            'open': 'first',
            'high': 'max',
            'low': 'min',
            'close': 'last',
            'volume': 'sum'
        }).dropna().reset_index()
        
    df_htf['date_str'] = df_htf['timestamp'].dt.strftime('%Y-%m-%d')
    df_htf['time_str'] = df_htf['timestamp'].dt.strftime('%H:%M')
    
    # Compute ATR on HTF
    htf_h = df_htf['high'].values
    htf_l = df_htf['low'].values
    htf_c = df_htf['close'].values
    htf_atrs = compute_wilder_atr(htf_h, htf_l, htf_c, atr_period)
    
    # Precompute Box levels for each completed HTF candle
    # Box is valid from the moment HTF candle closes until next HTF candle closes
    n_htf = len(df_htf)
    box_records = []
    
    for j in range(lookback - 1, n_htf):
        slice_h = htf_h[j - lookback + 1 : j + 1]
        slice_l = htf_l[j - lookback + 1 : j + 1]
        b_h = np.max(slice_h)
        b_l = np.min(slice_l)
        b_med = (b_h + b_l) / 2.0
        b_depth = b_h - b_l
        atr = htf_atrs[j]
        
        is_valid = (atr > 0) and (min_vol * atr <= b_depth <= max_vol * atr)
        
        box_records.append({
            'htf_end_time': df_htf['timestamp'].iloc[j],
            'box_high': b_h,
            'box_low': b_l,
            'box_median': b_med,
            'box_depth': b_depth,
            'htf_atr': atr,
            'is_valid': is_valid
        })
        
    df_boxes = pd.DataFrame(box_records)
    
    # Merge boxes onto 1m data using merge_asof (each 1m bar gets the most recently COMPLETED HTF box)
    # Notice: HTF candle ending at T only completes at T + htf_delta!
    # To avoid lookahead bias, we shift htf_end_time to when it actually closed.
    # In pandas resample, label is left edge of interval by default!
    # Let's verify interval closure time:
    htf_freq = pd.to_timedelta(htf) if htf not in ['1m', '1min'] else pd.to_timedelta('1min')
    df_boxes['available_from'] = df_boxes['htf_end_time'] + htf_freq
    df_boxes.sort_values('available_from', inplace=True)
    
    # As-of merge
    df_merged = pd.merge_asof(
        df_1m,
        df_boxes[['available_from', 'box_high', 'box_low', 'box_median', 'box_depth', 'htf_atr', 'is_valid']],
        left_on='timestamp',
        right_on='available_from',
        direction='backward'
    )
    
    # Arrays for super-fast backtesting
    opens_1m = df_merged['open'].values
    highs_1m = df_merged['high'].values
    lows_1m = df_merged['low'].values
    closes_1m = df_merged['close'].values
    dates_1m = df_merged['date_str'].values
    times_1m = df_merged['time_str'].values
    ts_strs_1m = df_merged['timestamp'].astype(str).values
    
    box_highs = df_merged['box_high'].values
    box_lows = df_merged['box_low'].values
    box_medians = df_merged['box_median'].values
    box_depths = df_merged['box_depth'].values
    box_valids = df_merged['is_valid'].values
    atrs_htf = df_merged['htf_atr'].values
    
    n_1m = len(df_merged)
    trades: List[MTFTrade] = []
    trade_id = 0
    in_trade = False
    cur: Optional[MTFTrade] = None
    
    # To prevent multiple entries into the exact same box
    last_entered_box_high = -1.0
    last_entered_box_low = -1.0
    
    k = 0
    while k < n_1m - 1:
        # State 2: Active Trade Management on 1m bars
        if in_trade and cur is not None:
            bar_o = opens_1m[k]
            bar_h = highs_1m[k]
            bar_l = lows_1m[k]
            bar_c = closes_1m[k]
            cur_time = times_1m[k]
            cur_ts = ts_strs_1m[k]
            
            cur.bars_held_1m += 1
            
            # 1. EOD Exit
            if intraday_mode and cur_time >= eod_exit_time:
                cur.exit_idx_1m = k
                cur.exit_time = cur_ts
                cur.exit_price = bar_c
                cur.exit_reason = 'EOD'
                cur.pnl_pts = (bar_c - cur.entry_price) if cur.direction == 'LONG' else (cur.entry_price - bar_c)
                cur.pnl_r = cur.pnl_pts / cur.risk_units
                trades.append(cur)
                in_trade = False
                cur = None
                k += 1
                continue
                
            # 2. Breakeven Trailing Check
            if use_breakeven and not cur.be_activated:
                if cur.direction == 'LONG' and bar_h >= cur.be_price:
                    cur.active_sl = cur.entry_price
                    cur.be_activated = True
                elif cur.direction == 'SHORT' and bar_l <= cur.be_price:
                    cur.active_sl = cur.entry_price
                    cur.be_activated = True
                    
            # 3. Stop Loss / Take Profit Check
            exited = False
            if cur.direction == 'LONG':
                hit_tp = bar_h >= cur.tp_price
                hit_sl = bar_l <= cur.active_sl
                if hit_tp and hit_sl:
                    if bar_o >= cur.tp_price:
                        cur.exit_price = bar_o
                        cur.exit_reason = 'TP'
                    else:
                        cur.exit_price = cur.active_sl
                        cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
                elif hit_tp:
                    cur.exit_price = cur.tp_price
                    cur.exit_reason = 'TP'
                    exited = True
                elif hit_sl:
                    cur.exit_price = min(bar_o, cur.active_sl) if bar_o < cur.active_sl else cur.active_sl
                    cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
            else: # SHORT
                hit_tp = bar_l <= cur.tp_price
                hit_sl = bar_h >= cur.active_sl
                if hit_tp and hit_sl:
                    if bar_o <= cur.tp_price:
                        cur.exit_price = bar_o
                        cur.exit_reason = 'TP'
                    else:
                        cur.exit_price = cur.active_sl
                        cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
                elif hit_tp:
                    cur.exit_price = cur.tp_price
                    cur.exit_reason = 'TP'
                    exited = True
                elif hit_sl:
                    cur.exit_price = max(bar_o, cur.active_sl) if bar_o > cur.active_sl else cur.active_sl
                    cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
                    
            if exited:
                cur.exit_idx_1m = k
                cur.exit_time = cur_ts
                cur.pnl_pts = (cur.exit_price - cur.entry_price) if cur.direction == 'LONG' else (cur.entry_price - cur.exit_price)
                cur.pnl_r = cur.pnl_pts / cur.risk_units
                trades.append(cur)
                in_trade = False
                cur = None
                
            k += 1
            continue

        # Not in trade: Look for 1m Breakout of active HTF box
        cur_time = times_1m[k]
        if intraday_mode and cur_time >= entry_cutoff_time:
            k += 1
            continue
            
        if not box_valids[k] or np.isnan(box_highs[k]):
            k += 1
            continue
            
        b_h = box_highs[k]
        b_l = box_lows[k]
        b_med = box_medians[k]
        b_depth = box_depths[k]
        atr_val = atrs_htf[k]
        
        # Avoid re-entering the exact same box twice
        if b_h == last_entered_box_high and b_l == last_entered_box_low:
            k += 1
            continue
            
        c_1m = closes_1m[k]
        o_1m = opens_1m[k]
        body_1m = abs(c_1m - o_1m)
        
        # 1-minute Breakout confirmation condition
        long_cond = (c_1m > b_h) and ((c_1m - b_h) >= (body_confirm_ratio * body_1m))
        short_cond = (c_1m < b_l) and ((b_l - c_1m) >= (body_confirm_ratio * body_1m))
        
        if long_cond:
            entry_p = c_1m
            risk_u = entry_p - b_med
            if risk_u > 0:
                trade_id += 1
                cur = MTFTrade(
                    trade_id=trade_id,
                    direction='LONG',
                    entry_idx_1m=k,
                    entry_time=ts_strs_1m[k],
                    entry_price=entry_p,
                    box_high=b_h,
                    box_low=b_l,
                    box_median=b_med,
                    box_depth=b_depth,
                    htf_atr=atr_val,
                    risk_units=risk_u,
                    initial_sl=b_med,
                    active_sl=b_med,
                    tp_price=entry_p + (target_mult * risk_u),
                    be_price=entry_p + (be_trigger_mult * risk_u),
                    be_activated=False
                )
                in_trade = True
                last_entered_box_high = b_h
                last_entered_box_low = b_l
                k += 1
                continue
                
        elif short_cond:
            entry_p = c_1m
            risk_u = b_med - entry_p
            if risk_u > 0:
                trade_id += 1
                cur = MTFTrade(
                    trade_id=trade_id,
                    direction='SHORT',
                    entry_idx_1m=k,
                    entry_time=ts_strs_1m[k],
                    entry_price=entry_p,
                    box_high=b_h,
                    box_low=b_l,
                    box_median=b_med,
                    box_depth=b_depth,
                    htf_atr=atr_val,
                    risk_units=risk_u,
                    initial_sl=b_med,
                    active_sl=b_med,
                    tp_price=entry_p - (target_mult * risk_u),
                    be_price=entry_p - (be_trigger_mult * risk_u),
                    be_activated=False
                )
                in_trade = True
                last_entered_box_high = b_h
                last_entered_box_low = b_l
                k += 1
                continue
                
        k += 1
        
    trades_df = pd.DataFrame([t.__dict__ for t in trades]) if trades else pd.DataFrame()
    return trades_df, calculate_metrics(trades_df)


def calculate_metrics(trades_df: pd.DataFrame) -> Dict:
    if len(trades_df) == 0:
        return {"trades": 0, "win_rate": 0.0, "net_pts": 0.0, "profit_factor": 0.0, "total_r": 0.0, "max_dd_pts": 0.0}
    wins = trades_df[trades_df['pnl_pts'] > 0]
    losses = trades_df[trades_df['pnl_pts'] < 0]
    gp = wins['pnl_pts'].sum()
    gl = abs(losses['pnl_pts'].sum())
    pf = (gp / gl) if gl > 0 else 99.0
    net = trades_df['pnl_pts'].sum()
    cum = trades_df['pnl_pts'].cumsum()
    max_dd = (cum.cummax() - cum).max()
    return {
        "trades": len(trades_df),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": round(len(wins) / len(trades_df) * 100, 1),
        "net_pts": round(net, 1),
        "profit_factor": round(pf, 2),
        "total_r": round(trades_df['pnl_r'].sum(), 2),
        "avg_win": round(wins['pnl_pts'].mean(), 1) if len(wins) else 0.0,
        "avg_loss": round(losses['pnl_pts'].mean(), 1) if len(losses) else 0.0,
        "max_dd_pts": round(max_dd, 1)
    }

if __name__ == "__main__":
    print("Testing MTF engine...")
    df_1m = pd.read_pickle('.tmp/nifty50_1m_2023_2024_2025_2026.pkl')
    for tf in ['1min', '3min', '5min', '15min', '30min', '60min']:
        t0 = time.time()
        trades, m = run_mtf_box_backtest(df_1m, htf=tf, lookback=14, target_mult=2.0, use_breakeven=False)
        print(f"HTF Box: {tf:<6} -> 1m BO | Trades: {m['trades']:<4} | Win%: {m['win_rate']:5.1f}% | Net: {m['net_pts']:+8.1f} pts | PF: {m['profit_factor']:4.2f} | Total R: {m['total_r']:+6.2f} | Time: {time.time()-t0:.2f}s")
