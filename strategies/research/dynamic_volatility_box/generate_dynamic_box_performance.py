#!/usr/bin/env python3
"""
Generate Performance CSV and Daily Boxes JSON for
The Dynamic Volatility Box Breakout Strategy (Nifty 15-Minute, 2023-2026)
"""

import os
import json
import pandas as pd
import numpy as np
from typing import List, Dict, Any
from comprehensive_box_backtest import resample_df, compute_wilder_atr

def generate_dynamic_box_data():
    print("Loading 1m data for Nifty 50 (2023-2026)...")
    df_1m = pd.read_pickle('.tmp/nifty50_1m_2023_2024_2025_2026.pkl')
    df_15m = resample_df(df_1m, '15min')
    
    lookback = 14
    atr_period = 14
    target_mult = 2.0
    min_vol = 0.5
    max_vol = 2.5
    body_confirm_ratio = 0.50
    
    n = len(df_15m)
    opens = df_15m['open'].values
    highs = df_15m['high'].values
    lows = df_15m['low'].values
    closes = df_15m['close'].values
    dates = df_15m['date_str'].values
    times = df_15m['time_str'].values
    ts_strs = df_15m['timestamp'].astype(str).values
    atrs = compute_wilder_atr(df_15m, atr_period)
    
    trades = []
    # Map date -> list of CompressionBox dicts
    daily_boxes: Dict[str, List[Dict[str, Any]]] = {}
    
    in_trade = False
    cur_trade = None
    start_idx = max(atr_period + 1, lookback)
    i = start_idx
    trade_id = 0
    
    while i < n - 1:
        cur_date = dates[i]
        cur_time = times[i]
        
        # State 2: Active Trade Management
        if in_trade and cur_trade is not None:
            bar_o = opens[i]
            bar_h = highs[i]
            bar_l = lows[i]
            bar_c = closes[i]
            bar_ts = ts_strs[i]
            bar_time = times[i]
            
            # EOD check (15:20)
            if cur_time >= "15:20":
                pnl = (bar_c - cur_trade['entry_price']) if cur_trade['side'] == 'CALL' else (cur_trade['entry_price'] - bar_c)
                cur_trade['exit_time'] = bar_time
                cur_trade['exit_price'] = round(float(bar_c), 2)
                cur_trade['exit_reason'] = 'EOD'
                cur_trade['pnl_points'] = round(float(pnl), 2)
                cur_trade['r_multiple'] = round(float(pnl / cur_trade['risk_units']), 2)
                trades.append(cur_trade)
                in_trade = False
                cur_trade = None
                i += 1
                continue
                
            exited = False
            if cur_trade['side'] == 'CALL':
                hit_tp = bar_h >= cur_trade['target']
                hit_sl = bar_l <= cur_trade['sl']
                if hit_tp and hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    exited = True
                elif hit_tp:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['target']), 2)
                    cur_trade['exit_reason'] = 'TARGET_2R'
                    exited = True
                elif hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    exited = True
            else: # PUT (SHORT)
                hit_tp = bar_l <= cur_trade['target']
                hit_sl = bar_h >= cur_trade['sl']
                if hit_tp and hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    exited = True
                elif hit_tp:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['target']), 2)
                    cur_trade['exit_reason'] = 'TARGET_2R'
                    exited = True
                elif hit_sl:
                    cur_trade['exit_time'] = bar_time
                    cur_trade['exit_price'] = round(float(cur_trade['sl']), 2)
                    cur_trade['exit_reason'] = 'STOP_LOSS'
                    exited = True
                    
            if exited:
                pnl = (cur_trade['exit_price'] - cur_trade['entry_price']) if cur_trade['side'] == 'CALL' else (cur_trade['entry_price'] - cur_trade['exit_price'])
                cur_trade['pnl_points'] = round(float(pnl), 2)
                cur_trade['r_multiple'] = round(float(pnl / cur_trade['risk_units']), 2)
                trades.append(cur_trade)
                in_trade = False
                cur_trade = None
                
            i += 1
            continue
            
        # State 0: Scanning & Box Formulation
        if cur_time >= "15:00":
            i += 1
            continue
            
        h_slice = highs[i - lookback + 1 : i + 1]
        l_slice = lows[i - lookback + 1 : i + 1]
        b_high = np.max(h_slice)
        b_low = np.min(l_slice)
        b_med = (b_high + b_low) / 2.0
        b_depth = b_high - b_low
        atr_val = atrs[i]
        
        box_start_time = times[i - lookback + 1]
        box_end_time = times[i]
        
        if atr_val <= 0 or not (min_vol * atr_val <= b_depth <= max_vol * atr_val):
            i += 1
            continue
            
        # State 1: Breakout Confirmation on candle t+1 (index i + 1)
        next_i = i + 1
        cand_o = opens[next_i]
        cand_c = closes[next_i]
        cand_time = times[next_i]
        
        if dates[next_i] != cur_date:
            i += 1
            continue
            
        body_h = abs(cand_c - cand_o)
        long_cond = (cand_c > b_high) and ((cand_c - b_high) >= (body_confirm_ratio * body_h))
        short_cond = (cand_c < b_low) and ((b_low - cand_c) >= (body_confirm_ratio * body_h))
        
        box_status = "breakout_up" if long_cond else ("breakout_down" if short_cond else "coiling")
        
        # Save box record
        box_entry = {
            "box_id": f"box_{cur_date}_{box_end_time}",
            "date": cur_date,
            "start_time": box_start_time,
            "end_time": cand_time if (long_cond or short_cond) else box_end_time,
            "ceiling": round(float(b_high), 2),
            "floor": round(float(b_low), 2),
            "midpoint": round(float(b_med), 2),
            "range_pts": round(float(b_depth), 2),
            "duration_bars": lookback,
            "status": box_status,
            "atr": round(float(atr_val), 2)
        }
        
        daily_boxes.setdefault(cur_date, []).append(box_entry)
        
        if long_cond:
            entry_p = cand_c
            risk_u = entry_p - b_med
            if risk_u > 0:
                trade_id += 1
                cur_trade = {
                    "trade_num": trade_id,
                    "date": cur_date,
                    "side": "CALL",
                    "entry_time": cand_time,
                    "entry_price": round(float(entry_p), 2),
                    "sl": round(float(b_med), 2),
                    "target": round(float(entry_p + target_mult * risk_u), 2),
                    "risk_units": round(float(risk_u), 2),
                    "box_high": round(float(b_high), 2),
                    "box_low": round(float(b_low), 2),
                    "box_median": round(float(b_med), 2),
                    "box_depth": round(float(b_depth), 2),
                    "exit_time": "",
                    "exit_price": 0.0,
                    "exit_reason": "",
                    "pnl_points": 0.0,
                    "r_multiple": 0.0
                }
                in_trade = True
                i = next_i + 1
                continue
                
        elif short_cond:
            entry_p = cand_c
            risk_u = b_med - entry_p
            if risk_u > 0:
                trade_id += 1
                cur_trade = {
                    "trade_num": trade_id,
                    "date": cur_date,
                    "side": "PUT",
                    "entry_time": cand_time,
                    "entry_price": round(float(entry_p), 2),
                    "sl": round(float(b_med), 2),
                    "target": round(float(entry_p - target_mult * risk_u), 2),
                    "risk_units": round(float(risk_u), 2),
                    "box_high": round(float(b_high), 2),
                    "box_low": round(float(b_low), 2),
                    "box_median": round(float(b_med), 2),
                    "box_depth": round(float(b_depth), 2),
                    "exit_time": "",
                    "exit_price": 0.0,
                    "exit_reason": "",
                    "pnl_points": 0.0,
                    "r_multiple": 0.0
                }
                in_trade = True
                i = next_i + 1
                continue
                
        i += 1
        
    os.makedirs("performance", exist_ok=True)
    trades_df = pd.DataFrame(trades)
    csv_path = "performance/dynamic_box_trades.csv"
    trades_df.to_csv(csv_path, index=False)
    print(f"Saved {len(trades_df)} trades to {csv_path}")
    
    # Save daily boxes JSON
    json_path = "performance/dynamic_box_boxes.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(daily_boxes, f, indent=2)
    print(f"Saved {sum(len(v) for v in daily_boxes.values())} boxes across {len(daily_boxes)} days to {json_path}")
    
    # Compute quick stats
    wins = trades_df[trades_df['pnl_points'] > 0]
    losses = trades_df[trades_df['pnl_points'] < 0]
    wr = len(wins) / len(trades_df) * 100
    net = trades_df['pnl_points'].sum()
    gp = wins['pnl_points'].sum()
    gl = abs(losses['pnl_points'].sum())
    pf = gp / gl if gl else 99
    tot_r = trades_df['r_multiple'].sum()
    print(f"Summary: Trades={len(trades_df)} | Win%={wr:.1f}% | Net PnL={net:+.1f} pts | PF={pf:.2f} | R={tot_r:+.2f}")

if __name__ == "__main__":
    generate_dynamic_box_data()
