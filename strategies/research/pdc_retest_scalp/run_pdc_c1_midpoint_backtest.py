#!/usr/bin/env python3
"""
10-Year Backtest for Opening Candle (C1) Previous Close (PDC) Break Strategy.

Rules:
1. Reference:
   - Previous Day Close (PDC) from 15:29:00 candle of previous trading day.
   - Candle 1 (C1, 09:15): High, Low, Open, Close.
   - C1 Midpoint: (C1_high + C1_low) / 2.0.

2. Entry (Keep it simple):
   - PUT: C1 breaks below PDC and closes below PDC (Red candle, close < open).
   - CALL: C1 breaks above PDC and closes above PDC (Green candle, close > open).
   - Enter at 09:16:00 candle open.

3. Stop Loss:
   - "sl is mid point" -> Fixed at C1 Midpoint.
   - If price touches C1 Midpoint, exit immediately.

4. Go With The Trend:
   - Tier 1: At +25 pts profit -> lock +5 pts.
   - Tier 2: At +50 pts profit -> lock +25 pts.
   - Tier 3: At +100 pts profit -> lock +60 pts.
   - Trend hold to 15:15 IST (EOD close).
"""

from __future__ import annotations

import csv
from pathlib import Path
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent

def load_all_1min_data() -> pd.DataFrame:
    base_dir = ROOT / "captured_data" / "technovusin_nifty50" / "1min"
    all_files = sorted(base_dir.rglob("*.csv"))
    years = sorted(list(set(f.parent.name for f in all_files if f.parent.name.isdigit())))
    
    print(f"Loading 1-minute historical data across {len(years)} years ({years[0]} - {years[-1]})...")
    
    dfs = []
    for y in years:
        y_files = sorted([f for f in all_files if f.parent.name == y])
        for f in y_files:
            df_sub = pd.read_csv(f)
            rename_cols = {}
            for c in df_sub.columns:
                if c.lower() in ('timestamp', 'open', 'high', 'low', 'close'):
                    rename_cols[c] = c.lower()
            df_sub.rename(columns=rename_cols, inplace=True)
            dfs.append(df_sub[['timestamp', 'open', 'high', 'low', 'close']])

    # Also load live October 2026 data if available
    live_files = sorted((ROOT / "captured_data" / "fyers" / "live").glob("nifty_1min_2026-10-*.csv"))
    for f in live_files:
        d = pd.read_csv(f)
        if len(d) > 20:
            rename_cols = {}
            for c in d.columns:
                if c.lower() in ('timestamp', 'open', 'high', 'low', 'close'):
                    rename_cols[c] = c.lower()
            d.rename(columns=rename_cols, inplace=True)
            dfs.append(d[['timestamp', 'open', 'high', 'low', 'close']])

    full_df = pd.concat(dfs, ignore_index=True)
    full_df['timestamp'] = pd.to_datetime(full_df['timestamp'], format='mixed')
    full_df.sort_values('timestamp', inplace=True)
    full_df.drop_duplicates('timestamp', inplace=True)
    full_df.reset_index(drop=True, inplace=True)
    full_df['date'] = full_df['timestamp'].dt.date
    full_df['time_str'] = full_df['timestamp'].dt.strftime('%H:%M')
    
    return full_df


def run_strategy(df: pd.DataFrame) -> pd.DataFrame:
    grouped = {d: g.reset_index(drop=True) for d, g in df.groupby('date') if len(g) >= 100}
    valid_days = sorted(grouped.keys())
    print(f"Analyzing {len(valid_days)} trading days...")
    
    trades = []
    equity = 0.0
    peak = 0.0
    
    for i in range(1, len(valid_days)):
        prev_d = valid_days[i - 1]
        curr_d = valid_days[i]
        
        prev_sub = grouped[prev_d]
        curr_sub = grouped[curr_d]
        
        pdc = float(prev_sub.iloc[-1]['close'])
        
        c1 = curr_sub.iloc[0]
        c1_open = float(c1['open'])
        c1_high = float(c1['high'])
        c1_low = float(c1['low'])
        c1_close = float(c1['close'])
        c1_mid = round((c1_high + c1_low) / 2.0, 2)
        
        side = None
        setup_name = ""
        # PUT condition: C1 breaks below PDC and closes below PDC (and C1 is red)
        if c1_close < pdc and c1_low < pdc and c1_high >= (pdc - 20.0) and c1_close < c1_open:
            side = 'PUT'
            setup_name = "C1_RED_BREAK_PDC"
        # CALL condition: C1 breaks above PDC and closes above PDC (and C1 is green)
        elif c1_close > pdc and c1_high > pdc and c1_low <= (pdc + 20.0) and c1_close > c1_open:
            side = 'CALL'
            setup_name = "C1_GREEN_BREAK_PDC"
            
        if not side:
            continue
            
        entry_idx = 1
        entry_price = float(curr_sub.iloc[entry_idx]['open'])
        entry_time = curr_sub.iloc[entry_idx]['time_str']
        
        # Stop is C1 Midpoint
        sl = c1_mid
        risk = abs(entry_price - sl)
        if risk < 4.0 or risk > 65.0:
            continue
            
        current_sl = sl
        best_fav = 0.0
        exit_price = None
        exit_time = None
        exit_reason = None
        bars_held = 0
        
        for k in range(entry_idx, len(curr_sub)):
            bar = curr_sub.iloc[k]
            o, h, l, c = float(bar['open']), float(bar['high']), float(bar['low']), float(bar['close'])
            t_str = bar['time_str']
            bars_held = k - entry_idx
            
            if side == 'PUT':
                fav = entry_price - l
                best_fav = max(best_fav, fav)
                
                # Trend ratchet locks
                if best_fav >= 100.0:
                    current_sl = min(current_sl, entry_price - 60.0)
                elif best_fav >= 50.0:
                    current_sl = min(current_sl, entry_price - 25.0)
                elif best_fav >= 25.0:
                    current_sl = min(current_sl, entry_price - 5.0)
                    
                if h >= current_sl:
                    exit_price = max(o, current_sl)
                    exit_time = t_str
                    exit_reason = 'STOP' if current_sl == sl else 'TRAIL_STOP'
                    break
            else: # CALL
                fav = h - entry_price
                best_fav = max(best_fav, fav)
                
                # Trend ratchet locks
                if best_fav >= 100.0:
                    current_sl = max(current_sl, entry_price + 60.0)
                elif best_fav >= 50.0:
                    current_sl = max(current_sl, entry_price + 25.0)
                elif best_fav >= 25.0:
                    current_sl = max(current_sl, entry_price + 5.0)
                    
                if l <= current_sl:
                    exit_price = min(o, current_sl)
                    exit_time = t_str
                    exit_reason = 'STOP' if current_sl == sl else 'TRAIL_STOP'
                    break
                    
            if t_str >= '15:15':
                exit_price = c
                exit_time = t_str
                exit_reason = 'EOD'
                break
                
        if exit_price is None:
            last_bar = curr_sub.iloc[-1]
            exit_price = float(last_bar['close'])
            exit_time = last_bar['time_str']
            exit_reason = 'EOD'
            
        pnl = round((entry_price - exit_price) if side == 'PUT' else (exit_price - entry_price), 2)
        equity += pnl
        peak = max(peak, equity)
        dd = round(equity - peak, 2)
        
        trades.append({
            'date': str(curr_d),
            'year': curr_d.year,
            'side': side,
            'setup': setup_name,
            'pdc': round(pdc, 2),
            'c1_mid': round(c1_mid, 2),
            'entry_time': entry_time,
            'entry': round(entry_price, 2),
            'stop': round(sl, 2),
            'target': round(entry_price + (60.0 if side == 'CALL' else -60.0), 2),
            'exit_time': exit_time,
            'exit_price': round(exit_price, 2),
            'pnl_points': pnl,
            'bars_held': bars_held,
            'reason': exit_reason,
            'equity': round(equity, 2),
            'drawdown': dd
        })
        
    return pd.DataFrame(trades)


def main():
    df = load_all_1min_data()
    trades_df = run_strategy(df)
    
    if trades_df.empty:
        print("No trades found!")
        return

    export_path = ROOT / "performance" / "aggressive_midpoint_scalp_trades.csv"
    export_path.parent.mkdir(parents=True, exist_ok=True)
    trades_df.to_csv(export_path, index=False)
    print(f"\n[OK] Exported {len(trades_df)} trade logs to {export_path}")
    
    # Yearly Summary
    print("\n" + "=" * 105)
    print(f" 10-YEAR MASTER REPORT: C1 PDC BREAK & MIDPOINT SL STRATEGY (2017 - 2026)")
    print("=" * 105)
    print(f"{'YEAR':<6} | {'TRADES':<6} | {'WIN %':<7} | {'WINS':<5} | {'LOSS':<5} | {'NET PTS':<9} | {'AVG WIN':<8} | {'AVG LOSS':<8} | {'PF':<5} | {'MAX DD':<8}")
    print("-" * 105)
    
    for y, y_df in trades_df.groupby('year'):
        n = len(y_df)
        wins = y_df[y_df['pnl_points'] > 0]
        losses = y_df[y_df['pnl_points'] < 0]
        wr = (len(wins) / n) * 100
        net = y_df['pnl_points'].sum()
        avg_w = wins['pnl_points'].mean() if len(wins) else 0.0
        avg_l = abs(losses['pnl_points'].mean()) if len(losses) else 0.0
        g_win = wins['pnl_points'].sum()
        g_loss = abs(losses['pnl_points'].sum())
        pf = g_win / g_loss if g_loss > 0 else 99.0
        mdd = y_df['drawdown'].min()
        print(f"{y:<6} | {n:<6d} | {wr:5.1f}% | {len(wins):<5d} | {len(losses):<5d} | {net:+9.1f} | {avg_w:8.1f} | {avg_l:8.1f} | {pf:5.2f} | {mdd:8.1f}")
        
    print("-" * 105)
    tot_n = len(trades_df)
    all_wins = trades_df[trades_df['pnl_points'] > 0]
    all_loss = trades_df[trades_df['pnl_points'] < 0]
    tot_wr = (len(all_wins) / tot_n) * 100
    tot_net = trades_df['pnl_points'].sum()
    tot_avg_w = all_wins['pnl_points'].mean()
    tot_avg_l = abs(all_loss['pnl_points'].mean())
    tot_gwin = all_wins['pnl_points'].sum()
    tot_gloss = abs(all_loss['pnl_points'].sum())
    tot_pf = tot_gwin / tot_gloss if tot_gloss > 0 else 99.0
    tot_mdd = trades_df['drawdown'].min()
    print(f"{'TOTAL':<6} | {tot_n:<6d} | {tot_wr:5.1f}% | {len(all_wins):<5d} | {len(all_loss):<5d} | {tot_net:+9.1f} | {tot_avg_w:8.1f} | {tot_avg_l:8.1f} | {tot_pf:5.2f} | {tot_mdd:8.1f}")
    print("=" * 105)
    
    # Side breakdown
    print("\n--- SIDE BREAKDOWN ---")
    for s_name, s_df in trades_df.groupby('side'):
        s_wins = (s_df['pnl_points'] > 0).sum()
        s_wr = s_wins / len(s_df) * 100
        s_net = s_df['pnl_points'].sum()
        print(f"{s_name:<4}: {len(s_df)} trades | Win%: {s_wr:5.1f}% | Net Points: {s_net:+8.1f}")


if __name__ == "__main__":
    main()
