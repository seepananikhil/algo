#!/usr/bin/env python3
"""
Comprehensive Backtest: 3-Touch Support & Resistance Breakout Strategy
Testing on Nifty 50 and Sensex (2023 - 2026)
"""

import sys
import numpy as np
import pandas as pd
from typing import List, Dict, Any, Tuple

def resample_bars(df_1m: pd.DataFrame, tf_minutes: int) -> pd.DataFrame:
    if tf_minutes == 1:
        work = df_1m.copy()
        if "timestamp" in work.columns and not np.issubdtype(work["timestamp"].dtype, np.datetime64):
            work["timestamp"] = pd.to_datetime(work["timestamp"])
        work["date_str"] = work["timestamp"].dt.strftime("%Y-%m-%d")
        work["time_str"] = work["timestamp"].dt.strftime("%H:%M")
        return work.reset_index(drop=True)
    
    rule = f"{tf_minutes}min"
    work = df_1m.copy()
    if not np.issubdtype(work["timestamp"].dtype, np.datetime64):
        work["timestamp"] = pd.to_datetime(work["timestamp"])
    
    agg_df = (
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
    agg_df["date_str"] = agg_df["timestamp"].dt.strftime("%Y-%m-%d")
    agg_df["time_str"] = agg_df["timestamp"].dt.strftime("%H:%M")
    return agg_df

def compute_atr(df: pd.DataFrame, period: int = 14) -> np.ndarray:
    high = df['high'].values
    low = df['low'].values
    close = df['close'].values
    n = len(df)
    tr = np.zeros(n)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
    atr = np.zeros(n)
    if n < period:
        return tr
    atr[period - 1] = np.mean(tr[:period])
    alpha = 1.0 / period
    for i in range(period, n):
        atr[i] = atr[i - 1] * (1.0 - alpha) + tr[i] * alpha
    return atr

def count_touches(highs: np.ndarray, lows: np.ndarray, closes: np.ndarray, 
                  ceil: float, floor: float, zone_pct: float = 0.25) -> Tuple[int, int]:
    """
    Count distinct test waves of ceiling and floor.
    A touch occurs when price enters the top/bottom boundary zone,
    separated by returning towards the midpoint.
    """
    rng = ceil - floor
    if rng <= 0:
        return 0, 0
    top_thresh = ceil - (zone_pct * rng)
    bot_thresh = floor + (zone_pct * rng)
    mid = (ceil + floor) / 2.0
    
    c_touches = 0
    in_top = False
    for h, c in zip(highs, closes):
        if h >= top_thresh:
            if not in_top:
                c_touches += 1
                in_top = True
        elif c < mid:
            in_top = False
            
    f_touches = 0
    in_bot = False
    for l, c in zip(lows, closes):
        if l <= bot_thresh:
            if not in_bot:
                f_touches += 1
                in_bot = True
        elif c > mid:
            in_bot = False
            
    return c_touches, f_touches

def backtest_3touch_sr(
    df: pd.DataFrame,
    min_touches: int = 3,
    touch_mode: str = "specific_side", # "specific_side" (>=3 on breakout side), "either_side" (either >=3), "both_sides" (both >=3)
    lookback_bars: int = 15,
    max_box_atr_mult: float = 2.5,
    min_box_atr_mult: float = 0.5,
    target_mult: float = 1.5,
    sl_type: str = "midpoint", # "midpoint" or "opposite_boundary" or "fixed_r"
    buffer_pts: float = 2.0,
    lot_size: int = 25
) -> Dict[str, Any]:
    
    n = len(df)
    opens = df['open'].values
    highs = df['high'].values
    lows = df['low'].values
    closes = df['close'].values
    times = df['time_str'].values
    dates = df['date_str'].values
    atrs = compute_atr(df, 14)
    
    trades = []
    in_trade = False
    cur_trade = None
    
    i = max(lookback_bars, 15)
    while i < n - 1:
        cur_date = dates[i]
        cur_time = times[i]
        
        # If active in trade, manage it
        if in_trade and cur_trade is not None:
            bar_o = opens[i]
            bar_h = highs[i]
            bar_l = lows[i]
            bar_c = closes[i]
            bar_time = times[i]
            
            # Intraday square-off at 15:20
            if bar_time >= "15:20":
                pnl = (bar_c - cur_trade['entry_price']) if cur_trade['side'] == 'CALL' else (cur_trade['entry_price'] - bar_c)
                cur_trade['exit_time'] = bar_time
                cur_trade['exit_price'] = round(float(bar_c), 2)
                cur_trade['exit_reason'] = 'EOD'
                cur_trade['pnl_points'] = round(float(pnl), 2)
                cur_trade['r_multiple'] = round(float(pnl / cur_trade['risk_units']), 2) if cur_trade['risk_units'] > 0 else 0.0
                trades.append(cur_trade)
                in_trade = False
                cur_trade = None
                i += 1
                continue
                
            # Check SL & TP
            if cur_trade['side'] == 'CALL':
                hit_tp = bar_h >= cur_trade['target']
                hit_sl = bar_l <= cur_trade['sl']
                if hit_tp and hit_sl:
                    # Conservative: Assume SL was hit
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    cur_trade['pnl_points'] = round(float(cur_trade['sl'] - cur_trade['entry_price']), 2)
                    cur_trade['r_multiple'] = -1.0
                    trades.append(cur_trade)
                    in_trade = False
                    cur_trade = None
                elif hit_tp:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['target']), 2)
                    cur_trade['exit_reason'] = 'TARGET'
                    cur_trade['pnl_points'] = round(float(cur_trade['target'] - cur_trade['entry_price']), 2)
                    cur_trade['r_multiple'] = round(float(cur_trade['pnl_points'] / cur_trade['risk_units']), 2)
                    trades.append(cur_trade)
                    in_trade = False
                    cur_trade = None
                elif hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    cur_trade['pnl_points'] = round(float(cur_trade['sl'] - cur_trade['entry_price']), 2)
                    cur_trade['r_multiple'] = -1.0
                    trades.append(cur_trade)
                    in_trade = False
                    cur_trade = None
            else: # PUT
                hit_tp = bar_l <= cur_trade['target']
                hit_sl = bar_h >= cur_trade['sl']
                if hit_tp and hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    cur_trade['pnl_points'] = round(float(cur_trade['entry_price'] - cur_trade['sl']), 2)
                    cur_trade['r_multiple'] = -1.0
                    trades.append(cur_trade)
                    in_trade = False
                    cur_trade = None
                elif hit_tp:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['target']), 2)
                    cur_trade['exit_reason'] = 'TARGET'
                    cur_trade['pnl_points'] = round(float(cur_trade['entry_price'] - cur_trade['target']), 2)
                    cur_trade['r_multiple'] = round(float(cur_trade['pnl_points'] / cur_trade['risk_units']), 2)
                    trades.append(cur_trade)
                    in_trade = False
                    cur_trade = None
                elif hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    cur_trade['pnl_points'] = round(float(cur_trade['entry_price'] - cur_trade['sl']), 2)
                    cur_trade['r_multiple'] = -1.0
                    trades.append(cur_trade)
                    in_trade = False
                    cur_trade = None
                    
            i += 1
            continue
            
        # Only evaluate entries between 09:30 and 14:45
        if cur_time < "09:30" or cur_time > "14:45":
            i += 1
            continue
            
        # Formulate recent lookback range
        slice_h = highs[i - lookback_bars : i]
        slice_l = lows[i - lookback_bars : i]
        slice_c = closes[i - lookback_bars : i]
        
        ceil = np.max(slice_h)
        floor = np.min(slice_l)
        rng = ceil - floor
        atr = atrs[i - 1]
        
        if atr <= 0 or rng <= 0:
            i += 1
            continue
            
        # Volatility filter: range must be a reasonable consolidation
        if rng < min_box_atr_mult * atr or rng > max_box_atr_mult * atr:
            i += 1
            continue
            
        # Count touches
        c_touches, f_touches = count_touches(slice_h, slice_l, slice_c, ceil, floor, zone_pct=0.25)
        
        # Breakout Candle (candle i)
        break_c = closes[i]
        break_o = opens[i]
        body = abs(break_c - break_o)
        
        # Long condition: Breakout above resistance
        long_valid_touches = False
        if touch_mode == "specific_side":
            long_valid_touches = (c_touches >= min_touches)
        elif touch_mode == "either_side":
            long_valid_touches = (c_touches >= min_touches or f_touches >= min_touches)
        elif touch_mode == "both_sides":
            long_valid_touches = (c_touches >= min_touches and f_touches >= min_touches)
            
        # Short condition: Breakout below support
        short_valid_touches = False
        if touch_mode == "specific_side":
            short_valid_touches = (f_touches >= min_touches)
        elif touch_mode == "either_side":
            short_valid_touches = (c_touches >= min_touches or f_touches >= min_touches)
        elif touch_mode == "both_sides":
            short_valid_touches = (c_touches >= min_touches and f_touches >= min_touches)
            
        mid = (ceil + floor) / 2.0
        
        if long_valid_touches and break_c > ceil + buffer_pts:
            entry_price = break_c
            if sl_type == "midpoint":
                sl = mid
            elif sl_type == "opposite_boundary":
                sl = floor
            else:
                sl = entry_price - atr
                
            risk = entry_price - sl
            if risk > 4.0:
                target = entry_price + (target_mult * risk)
                in_trade = True
                cur_trade = {
                    'trade_id': len(trades) + 1,
                    'date': cur_date,
                    'side': 'CALL',
                    'entry_time': cur_time,
                    'entry_price': round(float(entry_price), 2),
                    'sl': round(float(sl), 2),
                    'target': round(float(target), 2),
                    'risk_units': round(float(risk), 2),
                    'ceil': round(float(ceil), 2),
                    'floor': round(float(floor), 2),
                    'mid': round(float(mid), 2),
                    'c_touches': c_touches,
                    'f_touches': f_touches,
                }
                i += 1
                continue
                
        elif short_valid_touches and break_c < floor - buffer_pts:
            entry_price = break_c
            if sl_type == "midpoint":
                sl = mid
            elif sl_type == "opposite_boundary":
                sl = ceil
            else:
                sl = entry_price + atr
                
            risk = sl - entry_price
            if risk > 4.0:
                target = entry_price - (target_mult * risk)
                in_trade = True
                cur_trade = {
                    'trade_id': len(trades) + 1,
                    'date': cur_date,
                    'side': 'PUT',
                    'entry_time': cur_time,
                    'entry_price': round(float(entry_price), 2),
                    'sl': round(float(sl), 2),
                    'target': round(float(target), 2),
                    'risk_units': round(float(risk), 2),
                    'ceil': round(float(ceil), 2),
                    'floor': round(float(floor), 2),
                    'mid': round(float(mid), 2),
                    'c_touches': c_touches,
                    'f_touches': f_touches,
                }
                i += 1
                continue
                
        i += 1
        
    # Summarize metrics
    total_trades = len(trades)
    if total_trades == 0:
        return {'trades': 0, 'win_rate': 0, 'net_points': 0, 'pf': 0, 'max_dd': 0, 'trade_list': []}
        
    pts = [t['pnl_points'] for t in trades]
    wins = [p for p in pts if p > 0]
    losses = [p for p in pts if p < 0]
    gross_win = sum(wins)
    gross_loss = abs(sum(losses))
    pf = round(gross_win / gross_loss, 2) if gross_loss > 0 else 99.0
    wr = round(len(wins) / total_trades * 100.0, 1)
    net_pts = round(sum(pts), 2)
    
    # Drawdown
    equity = np.cumsum(pts)
    peaks = np.maximum.accumulate(equity)
    dds = equity - peaks
    max_dd = round(abs(float(np.min(dds))), 2) if len(dds) > 0 else 0.0
    
    return {
        'trades': total_trades,
        'win_rate': wr,
        'gross_win': round(gross_win, 2),
        'gross_loss': round(gross_loss, 2),
        'net_points': net_pts,
        'profit_factor': pf,
        'max_dd': max_dd,
        'trade_list': trades
    }

if __name__ == "__main__":
    print("Loading 1m data for Nifty 50 and Sensex (2023 - 2026)...")
    nifty_1m = pd.read_pickle('.tmp/nifty50_1m_2023_2024_2025_2026.pkl')
    sensex_1m = pd.read_pickle('.tmp/sensex_1m_2023_2024_2025_2026.pkl')
    
    print(f"Loaded Nifty bars: {len(nifty_1m)}, Sensex bars: {len(sensex_1m)}")
    
    # We will test Nifty and Sensex across 5m and 15m
    for sym_name, raw_df, lot_size, buffer in [("NIFTY 50", nifty_1m, 25, 2.0), ("SENSEX", sensex_1m, 10, 6.0)]:
        print(f"\n=================================================================")
        print(f"          {sym_name} 3-TOUCH S/R BREAKOUT SENSITIVITY GRID       ")
        print(f"=================================================================")
        
        for tf in [5, 15]:
            df_tf = resample_bars(raw_df, tf)
            print(f"\n--- Timeframe: {tf}-Minute ({len(df_tf)} bars) ---")
            
            for touch_mode in ["specific_side", "either_side", "both_sides"]:
                for min_t in [2, 3]:
                    for tgt in [1.5, 2.0]:
                        for sl_type in ["midpoint", "opposite_boundary"]:
                            res = backtest_3touch_sr(
                                df_tf,
                                min_touches=min_t,
                                touch_mode=touch_mode,
                                lookback_bars=14,
                                target_mult=tgt,
                                sl_type=sl_type,
                                buffer_pts=buffer,
                                lot_size=lot_size
                            )
                            print(f"Mode: {touch_mode:<13} | Touches: {min_t} | Tgt: {tgt}R | SL: {sl_type:<17} | "
                                  f"Trades: {res['trades']:>4} | WR: {res['win_rate']:>5.1f}% | Net Pts: {res['net_points']:>9.2f} | PF: {res['profit_factor']:>4.2f} | MaxDD: {res['max_dd']:>7.2f}")

