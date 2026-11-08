#!/usr/bin/env python3
"""
Master Portfolio Backtest Runner
Orchestrates the 4 modular strategy setups into a unified, configurable portfolio:

The 4 Modular Setups:
  1. vix_morn   : Setup 1: VIX Master Morning ORB (09:30 - 11:00)
  2. vix_aft    : Setup 2: VIX Master Afternoon Rolling Extreme (12:00 - 14:30)
  3. gap_morn   : Setup 3: Pure Gap-and-Go Morning 10% ORB Breakout (09:46 - 12:00)
  4. williams   : Setup 4: Williams Fractal Prior Day Range Breakout (12:00 - 14:30)

Modes:
  --mode priority   : Strict 1-lot margin discipline (priority routing on overlap days).
  --mode concurrent : Deploy all enabled setups independently.
  --setups          : Comma-separated list of setups to enable, e.g. "all" or "vix_morn,williams"
"""

import os
import sys
import argparse
import pandas as pd
import numpy as np
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent

def run_master_backtest(mode="priority", symbol="nifty", enabled_setups=None):
    if enabled_setups is None or "all" in enabled_setups:
        enabled_setups = ["vix_morn", "vix_aft", "gap_morn", "williams"]
    else:
        enabled_setups = [s.strip().lower() for s in enabled_setups]

    print("=" * 85)
    print(f"=== MASTER PORTFOLIO BACKTEST: Mode={mode.upper()} | Symbol={symbol.upper()} ===")
    print(f"=== Active Setups: {', '.join(enabled_setups)} ===")
    print("=" * 85)
    
    # 1. Load VIX Master trades
    vix_path = ROOT / "performance" / f"{symbol}_vix_master_trades.csv"
    if not vix_path.exists():
        os.system(f"python {ROOT}/scripts/run_vix_master_backtest.py")
    vix_df = pd.read_csv(vix_path)
    vix_df['date'] = pd.to_datetime(vix_df['date']).dt.strftime('%Y-%m-%d')
    vix_df['entry_time_str'] = vix_df['entry_time'].astype(str).str.slice(0, 5)

    # Split VIX into Setup 1 and Setup 2
    trades_pool = []
    
    if "vix_morn" in enabled_setups:
        s1 = vix_df[(vix_df['trade_num'] == 1) & (vix_df['entry_time_str'] < '11:30')].copy()
        s1['setup_id'] = 'vix_morn'
        s1['engine'] = 'VIX_MASTER'
        s1['strategy_label'] = 'VIX Master (Morning)'
        trades_pool.append(s1)

    if "vix_aft" in enabled_setups:
        s2 = vix_df[(vix_df['trade_num'] == 2) | (vix_df['entry_time_str'] >= '12:00')].copy()
        s2['setup_id'] = 'vix_aft'
        s2['engine'] = 'VIX_MASTER'
        s2['strategy_label'] = 'VIX Master (Afternoon)'
        trades_pool.append(s2)

    # 2. Load Gap-and-Go & Williams trades (Separated)
    gap_path = ROOT / "performance" / "pure_gap_and_go_trades.csv"
    wil_path = ROOT / "performance" / "williams_fractal_trades.csv"
    if not gap_path.exists() or not wil_path.exists():
        os.system(f"python {ROOT}/scripts/run_gap_and_go_williams_backtest.py")

    lot_size = 10 if symbol == "sensex" else 25

    if "gap_morn" in enabled_setups and gap_path.exists():
        g_raw = pd.read_csv(gap_path)
        g_df = pd.DataFrame()
        g_df['date'] = pd.to_datetime(g_raw['date']).dt.strftime('%Y-%m-%d')
        g_df['year'] = g_raw['year']
        g_df['trade_num'] = 1
        g_df['stage'] = 'GAP_AND_GO'
        g_df['origin'] = 'GAP_AND_GO'
        g_df['side'] = g_raw['type'].map(lambda x: 'LONG' if 'CE' in str(x).upper() else 'SHORT')
        g_df['option'] = g_raw['type'].map(lambda x: 'CALL' if 'CE' in str(x).upper() else 'PUT')
        g_df['entry_time'] = g_raw['entry_time'].astype(str).str.slice(0, 5)
        g_df['entry_price'] = g_raw['entry_spot']
        g_df['exit_time'] = g_raw['exit_time'].astype(str).str.slice(0, 5)
        g_df['exit_price'] = g_raw['exit_spot']
        g_df['initial_sl'] = np.where(g_df['side'] == 'LONG', g_df['entry_price'] - 28.0, g_df['entry_price'] + 28.0)
        g_df['final_sl'] = g_df['initial_sl']
        g_df['pnl_points'] = g_raw['spot_pts']
        g_df['weighted_pnl_points'] = g_raw['spot_pts']
        g_df['pnl_rupees'] = g_raw['net_pts_base'] * float(lot_size)
        g_df['futures_pnl_rupees'] = g_raw['spot_pts'] * float(lot_size)
        g_df['exit_reason'] = g_raw['exit_reason']
        g_df['base_lots'] = 1
        g_df['total_lots'] = 1
        g_df['setup_id'] = 'gap_morn'
        g_df['engine'] = 'GAP_AND_GO'
        g_df['strategy_label'] = 'Gap-and-Go'
        g_df['gap_pct'] = g_raw['gap_pct']
        trades_pool.append(g_df)

    if "williams" in enabled_setups and wil_path.exists():
        w_raw = pd.read_csv(wil_path)
        w_df = pd.DataFrame()
        w_df['date'] = pd.to_datetime(w_raw['date']).dt.strftime('%Y-%m-%d')
        w_df['year'] = w_raw['year']
        w_df['trade_num'] = 1
        w_df['stage'] = 'WILLIAMS'
        w_df['origin'] = 'WILLIAMS'
        w_df['side'] = w_raw['type'].map(lambda x: 'LONG' if 'CE' in str(x).upper() else 'SHORT')
        w_df['option'] = w_raw['type'].map(lambda x: 'CALL' if 'CE' in str(x).upper() else 'PUT')
        w_df['entry_time'] = w_raw['entry_time'].astype(str).str.slice(0, 5)
        w_df['entry_price'] = w_raw['entry_spot']
        w_df['exit_time'] = w_raw['exit_time'].astype(str).str.slice(0, 5)
        w_df['exit_price'] = w_raw['exit_spot']
        w_df['initial_sl'] = np.where(w_df['side'] == 'LONG', w_df['entry_price'] - 28.0, w_df['entry_price'] + 28.0)
        w_df['final_sl'] = w_df['initial_sl']
        w_df['pnl_points'] = w_raw['spot_pts']
        w_df['weighted_pnl_points'] = w_raw['spot_pts']
        w_df['pnl_rupees'] = w_raw['net_pts_base'] * float(lot_size)
        w_df['futures_pnl_rupees'] = w_raw['spot_pts'] * float(lot_size)
        w_df['exit_reason'] = w_raw['exit_reason']
        w_df['base_lots'] = 1
        w_df['total_lots'] = 1
        w_df['setup_id'] = 'williams'
        w_df['engine'] = 'WILLIAMS'
        w_df['strategy_label'] = 'Williams Fractal'
        w_df['gap_pct'] = w_raw['gap_pct']
        trades_pool.append(w_df)

    if not trades_pool:
        print("No setups selected!")
        return None

    raw_combined = pd.concat(trades_pool, ignore_index=True)
    raw_combined['sort_dt'] = pd.to_datetime(raw_combined['date'] + ' ' + raw_combined['entry_time'])
    raw_combined = raw_combined.sort_values('sort_dt').drop(columns=['sort_dt']).reset_index(drop=True)

    if mode == "concurrent":
        final_trades = raw_combined
    else:
        # Priority Mode: Max 1 active position, prioritized routing
        # 1. Big Gap (>=0.5%) -> Gap-and-Go Morning
        # 2. Normal Range -> VIX Master Morning
        # 3. Afternoon -> Williams Fractal or VIX Master Afternoon
        all_dates = sorted(list(raw_combined['date'].unique()))
        selected = []

        for d in all_dates:
            d_trades = raw_combined[raw_combined['date'] == d]
            
            # Morning trade selection
            morn_trades = d_trades[d_trades['entry_time'] < '11:30']
            aft_trades = d_trades[d_trades['entry_time'] >= '12:00']
            
            day_took_morning = False
            if len(morn_trades) > 0:
                # If gap_morn has gap >= 0.5%, take gap_morn
                gap_row = morn_trades[morn_trades['setup_id'] == 'gap_morn']
                if len(gap_row) > 0 and abs(gap_row.iloc[0].get('gap_pct', 0)) >= 0.5:
                    selected.append(gap_row.iloc[0].to_dict())
                    day_took_morning = True
                else:
                    # Take first morning trade (usually VIX Master)
                    vix_row = morn_trades[morn_trades['setup_id'] == 'vix_morn']
                    if len(vix_row) > 0:
                        selected.append(vix_row.iloc[0].to_dict())
                        day_took_morning = True
                    elif len(gap_row) > 0:
                        selected.append(gap_row.iloc[0].to_dict())
                        day_took_morning = True

            # Afternoon trade selection:
            # If no morning trade was taken, allow afternoon runners (Williams or VIX Afternoon)
            if not day_took_morning and len(aft_trades) > 0:
                selected.append(aft_trades.iloc[0].to_dict())
            elif day_took_morning and len(aft_trades) > 0:
                # If morning trade finished before afternoon, allow Trade 2 rolling extreme
                selected.append(aft_trades.iloc[0].to_dict())

        final_trades = pd.DataFrame(selected)
        final_trades['sort_dt'] = pd.to_datetime(final_trades['date'] + ' ' + final_trades['entry_time'])
        final_trades = final_trades.sort_values('sort_dt').drop(columns=['sort_dt']).reset_index(drop=True)

    out_csv = ROOT / "performance" / f"master_portfolio_{symbol}_trades.csv"
    final_trades.to_csv(out_csv, index=False)
    print(f"\nSaved {len(final_trades)} trades to: {out_csv}")

    # Summary
    tot = len(final_trades)
    wins = (final_trades['pnl_points'] > 0).sum()
    wr = wins / tot * 100 if tot > 0 else 0
    spot_pts = final_trades['pnl_points'].sum()
    opt_pts = final_trades['weighted_pnl_points'].sum()
    rs = final_trades['pnl_rupees'].sum()

    cum = final_trades['pnl_points'].cumsum()
    dd = (cum.cummax() - cum).max()
    calmar = spot_pts / dd if dd > 0 else 0

    gw = final_trades[final_trades['pnl_points'] > 0]['pnl_points'].sum()
    gl = abs(final_trades[final_trades['pnl_points'] < 0]['pnl_points'].sum())
    pf = gw / gl if gl > 0 else 0

    print("\n" + "=" * 85)
    print(f"=== MASTER SUITE PERFORMANCE REPORT ({mode.upper()}) ===")
    print("=" * 85)
    print(f"Total Trades Taken:       {tot:,}")
    print(f"Win Rate:                 {wr:.1f}% ({wins} wins / {tot-wins} losses)")
    print(f"Total Spot Points:        {spot_pts:,.1f} pts")
    print(f"Total Rupee PnL (1-lot):  Rs. {rs:,.2f}")
    print(f"Max Drawdown (Points):    {dd:,.1f} pts")
    print(f"Calmar Ratio:             {calmar:.1f}x")
    print(f"Profit Factor:            {pf:.2f}")
    print("=" * 85)

    print("\n--- Breakdown by Active Setup ---")
    for s_id, grp in final_trades.groupby('strategy_label'):
        e_pts = grp['pnl_points'].sum()
        e_wr = (grp['pnl_points'] > 0).mean() * 100
        print(f"  * {s_id:<28}: {len(grp):4d} trades | {e_wr:5.1f}% WR | {e_pts:>8,.1f} pts | Rs. {grp['pnl_rupees'].sum():>10,.2f}")

    return final_trades

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['priority', 'concurrent'], default='priority', help='Orchestration mode')
    parser.add_argument('--symbol', choices=['nifty', 'sensex'], default='nifty', help='Underlying symbol')
    parser.add_argument('--setups', default='all', help='Comma-separated setups: vix_morn,vix_aft,gap_morn,williams or all')
    args = parser.parse_args()

    enabled = [s.strip() for s in args.setups.split(',')] if args.setups != 'all' else ['all']
    run_master_backtest(mode=args.mode, symbol=args.symbol, enabled_setups=enabled)
