#!/usr/bin/env python3
"""
Master Portfolio Backtest Runner
Orchestrates Engine 1 (VIX Master) and Engine 2 (Gap-and-Go Williams) into a unified portfolio.

Modes:
  --mode priority   : Strict 1-lot capital discipline.
                      - Gaps >= 0.5% handled by Gap-and-Go.
                      - Normal opens handled by VIX Master.
                      - If VIX Master has no trade by 11:30, Williams Afternoon takes over.
  --mode concurrent : Unconstrained 2-lot deployment (both engines run independently).
"""

import os
import sys
import argparse
import pandas as pd
import numpy as np
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent

def run_master_backtest(mode="priority", symbol="nifty"):
    print("=" * 80)
    print(f"=== RUNNING MASTER PORTFOLIO BACKTEST: Mode={mode.upper()} | Symbol={symbol.upper()} ===")
    print("=" * 80)
    
    # Paths
    vix_path = ROOT / "performance" / f"{symbol}_vix_master_trades.csv"
    if not vix_path.exists():
        print(f"Error: {vix_path} not found. Running VIX master backtest first...")
        os.system(f"python {ROOT}/scripts/run_vix_master_backtest.py")
    
    gap_path = ROOT / "performance" / "gap_and_go_williams_official_trades.csv"
    if not gap_path.exists():
        print(f"Error: {gap_path} not found. Running Gap & Go backtest first...")
        os.system(f"python {ROOT}/scripts/run_gap_and_go_williams_backtest.py")
        
    vix_df = pd.read_csv(vix_path)
    gap_df = pd.read_csv(gap_path)
    
    vix_df['date'] = pd.to_datetime(vix_df['date']).dt.strftime('%Y-%m-%d')
    gap_df['date'] = pd.to_datetime(gap_df['date']).dt.strftime('%Y-%m-%d')
    
    # Tag engine origin
    vix_df['engine'] = 'VIX_MASTER'
    vix_df['strategy_label'] = 'VIX Master'
    
    # Format Gap & Go trades to match VIX schema
    lot_size = 10 if symbol == "sensex" else 25
    gap_clean = pd.DataFrame()
    gap_clean['date'] = gap_df['date']
    gap_clean['year'] = gap_df['year']
    gap_clean['trade_num'] = 1
    gap_clean['stage'] = gap_df['stage']
    gap_clean['origin'] = 'GAP_WILLIAMS'
    gap_clean['side'] = gap_df['type'].map(lambda x: 'LONG' if 'CE' in str(x).upper() else 'SHORT')
    gap_clean['option'] = gap_df['type'].map(lambda x: 'CALL' if 'CE' in str(x).upper() else 'PUT')
    gap_clean['entry_time'] = gap_df['entry_time'].astype(str).str.slice(0, 5)
    gap_clean['entry_price'] = gap_df['entry_spot']
    gap_clean['exit_time'] = gap_df['exit_time'].astype(str).str.slice(0, 5)
    gap_clean['exit_price'] = gap_df['exit_spot']
    gap_clean['initial_sl'] = np.where(gap_clean['side'] == 'LONG', gap_clean['entry_price'] - 28.0, gap_clean['entry_price'] + 28.0)
    gap_clean['final_sl'] = gap_clean['initial_sl']
    gap_clean['pnl_points'] = gap_df['spot_pts']
    gap_clean['weighted_pnl_points'] = gap_df['spot_pts']
    gap_clean['pnl_rupees'] = gap_df['net_pts_base'] * float(lot_size)
    gap_clean['futures_pnl_rupees'] = gap_df['spot_pts'] * float(lot_size)
    gap_clean['max_fav'] = 0.0
    gap_clean['exit_reason'] = gap_df['exit_reason']
    gap_clean['vix_chg'] = 0.0
    gap_clean['base_lots'] = 1
    gap_clean['pyramided'] = 0
    gap_clean['total_lots'] = 1
    gap_clean['engine'] = 'GAP_WILLIAMS'
    gap_clean['strategy_label'] = gap_df['stage'].map(lambda x: 'Gap-and-Go' if x == 'GAP_AND_GO' else 'Williams Fractal')
    gap_clean['gap_pct'] = gap_df['gap_pct']

    if mode == "concurrent":
        # Combine all trades from both engines sorted chronologically
        combined = pd.concat([vix_df, gap_clean], ignore_index=True)
        combined['sort_dt'] = pd.to_datetime(combined['date'] + ' ' + combined['entry_time'])
        combined = combined.sort_values('sort_dt').drop(columns=['sort_dt']).reset_index(drop=True)
    else:
        # Priority Orchestration:
        # 1. On Gap >= 0.5%, Gap-and-Go executes morning gap continuation.
        # 2. On Normal Opens (< 0.5%), VIX Master executes morning ORB.
        # 3. If VIX Master traded before 11:30 AM, Williams afternoon stands down.
        # 4. If VIX Master did NOT trade before 11:30 AM, Williams afternoon fractal takes the late-day runner!
        
        all_dates = sorted(list(set(vix_df['date'].unique()) | set(gap_clean['date'].unique())))
        selected_trades = []
        
        for d in all_dates:
            d_vix = vix_df[vix_df['date'] == d]
            d_gap = gap_clean[gap_clean['date'] == d]
            
            # Check gap size
            gap_pct = abs(d_gap.iloc[0]['gap_pct']) if len(d_gap) > 0 and 'gap_pct' in d_gap else 0.0
            
            if gap_pct >= 0.5 and len(d_gap) > 0 and d_gap.iloc[0]['stage'] == 'GAP_AND_GO':
                # Large gap day -> routed to Gap-and-Go engine
                selected_trades.append(d_gap.iloc[0].to_dict())
            else:
                # Normal day -> VIX Master has first priority
                vix_morning = d_vix[d_vix['entry_time'] < '11:30']
                if len(vix_morning) > 0:
                    for _, r in d_vix.iterrows():
                        selected_trades.append(r.to_dict())
                else:
                    # VIX Master had no morning trade! Check if Williams afternoon fired
                    williams_aft = d_gap[d_gap['entry_time'] >= '11:30']
                    if len(williams_aft) > 0:
                        selected_trades.append(williams_aft.iloc[0].to_dict())
                    elif len(d_vix) > 0:
                        # Trade 2 or late VIX trade
                        for _, r in d_vix.iterrows():
                            selected_trades.append(r.to_dict())
                            
        combined = pd.DataFrame(selected_trades)
        combined['sort_dt'] = pd.to_datetime(combined['date'] + ' ' + combined['entry_time'])
        combined = combined.sort_values('sort_dt').drop(columns=['sort_dt']).reset_index(drop=True)

    # Save to performance
    out_csv = ROOT / "performance" / f"master_portfolio_{symbol}_trades.csv"
    combined.to_csv(out_csv, index=False)
    print(f"Saved {len(combined)} master portfolio trades to: {out_csv}")
    
    # Calculate performance metrics
    total_trades = len(combined)
    win_trades = (combined['pnl_points'] > 0).sum()
    loss_trades = (combined['pnl_points'] < 0).sum()
    win_rate = win_trades / total_trades * 100 if total_trades > 0 else 0
    total_points = combined['pnl_points'].sum()
    total_pnl_rs = combined['pnl_rupees'].sum()
    
    cum = combined['pnl_points'].cumsum()
    peak = cum.cummax()
    dd = peak - cum
    max_dd_pts = dd.max()
    calmar = total_points / max_dd_pts if max_dd_pts > 0 else 0
    
    gross_win = combined[combined['pnl_points'] > 0]['pnl_points'].sum()
    gross_loss = abs(combined[combined['pnl_points'] < 0]['pnl_points'].sum())
    profit_factor = gross_win / gross_loss if gross_loss > 0 else 0
    
    print("\n" + "=" * 80)
    print(f"=== MASTER PORTFOLIO PERFORMANCE SUMMARY ({mode.upper()}) ===")
    print("=" * 80)
    print(f"Total Trades Taken:       {total_trades:,}")
    print(f"Win Rate:                 {win_rate:.1f}% ({win_trades} wins / {loss_trades} losses)")
    print(f"Total Spot Points:        {total_points:,.1f} pts")
    print(f"Total Rupee PnL (1-lot):  Rs. {total_pnl_rs:,.2f}")
    print(f"Max Drawdown (Points):    {max_dd_pts:,.1f} pts")
    print(f"Calmar Ratio (Pts/DD):    {calmar:.1f}x")
    print(f"Profit Factor:            {profit_factor:.2f}")
    print("=" * 80)
    
    # Breakdown by engine
    if 'engine' in combined.columns:
        print("\n--- Breakdown by Strategy Engine ---")
        for eng, grp in combined.groupby('engine'):
            e_pts = grp['pnl_points'].sum()
            e_wr = (grp['pnl_points'] > 0).mean() * 100
            print(f"  * {eng:<15}: {len(grp):4d} trades | {e_wr:5.1f}% win rate | {e_pts:>8,.1f} spot pts | Rs. {grp['pnl_rupees'].sum():>10,.2f}")
            
    return combined

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['priority', 'concurrent'], default='priority', help='Orchestration mode')
    parser.add_argument('--symbol', choices=['nifty', 'sensex'], default='nifty', help='Underlying symbol')
    args = parser.parse_args()
    
    run_master_backtest(mode=args.mode, symbol=args.symbol)
