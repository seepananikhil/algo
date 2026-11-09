#!/usr/bin/env python3
"""
Master Portfolio Backtest Runner
Orchestrates the decoupled strategy engines into a unified, configurable portfolio:

Active Core Engines (Elite Duo):
  1. trend_runner     : Trend Runner (15m ORB Breakout with VIX momentum confirmation)
  2. vix_trap         : VIX Trap (Volatility Divergence / Liquidity Trap Reversal)

Optional/Deferred:
  3. williams_fractal : Williams Fractal (Disabled by default to avoid morning churn)

Configuration is loaded directly from `master_portfolio_config.json` with CLI override support.
"""

import os
import sys
import json
import argparse
import pandas as pd
import numpy as np
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
ROOT = Path(__file__).resolve().parent.parent

def load_config_setups():
    cfg_path = ROOT / "master_portfolio_config.json"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            setups = cfg.get("setups", {})
            active = [k for k, v in setups.items() if v]
            if active:
                return active
        except Exception:
            pass
    return ["trend_runner", "vix_trap"]

def run_master_backtest(mode="priority", symbol="nifty", enabled_setups=None):
    if enabled_setups is None:
        enabled_setups = load_config_setups()
    elif "all" in enabled_setups:
        enabled_setups = ["trend_runner", "vix_trap"]
    else:
        enabled_setups = [s.strip().lower() for s in enabled_setups]

    print("=" * 85)
    print(f"=== MASTER PORTFOLIO BACKTEST: Mode={mode.upper()} | Symbol={symbol.upper()} ===")
    print(f"=== Active Engines: {', '.join(enabled_setups)} ===")
    print("=" * 85)

    is_sx = (symbol.lower() == "sensex")
    lot_size = 10 if is_sx else 25
    trades_pool = []

    # 1. Setup 1: Trend Runner (15m ORB Breakout with VIX momentum confirmation)
    if any(k in enabled_setups for k in ("trend_runner", "trend", "vix_morn")):
        if is_sx:
            trend_path = ROOT / "performance" / "sensex_backtest_trades.csv"
        else:
            trend_path = ROOT / "performance" / "vix_trend_runner_trades.csv"
            if not trend_path.exists():
                print(f"Generating Trend Runner trades...")
                os.system(f"python {ROOT}/scripts/run_vix_master_backtest.py")
        if trend_path.exists():
            t_df = pd.read_csv(trend_path)
            t_df['date'] = pd.to_datetime(t_df['date']).dt.strftime('%Y-%m-%d')
            t_df['setup_id'] = 'trend_runner'
            t_df['engine'] = 'TREND_RUNNER'
            t_df['strategy_label'] = 'Trend Runner'
            t_df['trigger_label'] = t_df['side'].map(
                lambda s: f"[Trend Runner] BUY {('CALL' if str(s).upper() in ('LONG', 'CALL') else 'PUT')} (15m ORB)"
            )
            t_df['trigger_reason'] = '15m ORB Breakout with VIX Momentum Confirmation'
            trades_pool.append(t_df)

    # 2. Setup 2: VIX Trap (Volatility Divergence / Liquidity Trap Reversal)
    if any(k in enabled_setups for k in ("vix_trap", "trap", "divergence", "vix_divergence")):
        if is_sx:
            trap_path = ROOT / "performance" / "sensex_vix_divergence_trades.csv"
        else:
            trap_path = ROOT / "performance" / "vix_divergence_backtest_trades.csv"
            if not trap_path.exists():
                print(f"Generating VIX Trap trades...")
                os.system(f"python {ROOT}/scripts/run_vix_divergence_backtest.py")
        if trap_path.exists():
            tp_df = pd.read_csv(trap_path)
            tp_df['date'] = pd.to_datetime(tp_df['date']).dt.strftime('%Y-%m-%d')
            tp_df['setup_id'] = 'vix_trap'
            tp_df['engine'] = 'VIX_TRAP'
            tp_df['strategy_label'] = 'VIX Trap'
            tp_df['trigger_label'] = tp_df['side'].map(
                lambda s: f"[VIX Trap] BUY {('CALL' if str(s).upper() in ('LONG', 'CALL') else 'PUT')} (Divergence Trap)"
            )
            tp_df['trigger_reason'] = 'Volatility Divergence / Liquidity Trap Reversal'
            trades_pool.append(tp_df)

    # 3. Setup 3: Williams Fractal (Optional, only if explicitly enabled)
    if any(k in enabled_setups for k in ("williams_fractal", "williams", "williams_afternoon")):
        if is_sx:
            wil_path = ROOT / "performance" / "gap_and_go_sensex_trades.csv"
        else:
            wil_path = ROOT / "performance" / "williams_fractal_trades.csv"
            if not wil_path.exists():
                print(f"Generating Williams Fractal trades...")
                os.system(f"python {ROOT}/scripts/run_gap_and_go_williams_backtest.py")
        if wil_path.exists():
            w_raw = pd.read_csv(wil_path)
            w_df = pd.DataFrame()
            w_df['date'] = pd.to_datetime(w_raw['date']).dt.strftime('%Y-%m-%d')
            w_df['trade_num'] = 1
            w_df['stage'] = 'WILLIAMS'
            w_df['side'] = w_raw['type'].map(lambda x: 'CALL' if 'CE' in str(x).upper() else 'PUT')
            w_df['option'] = w_df['side']
            w_df['option_symbol'] = ''
            w_df['option_entry_price'] = w_raw.get('entry_prem', 0.0)
            w_df['option_exit_price'] = w_raw.get('exit_prem', 0.0)
            w_df['option_pnl_points'] = w_raw.get('net_pts_base', 0.0)
            w_df['option_pnl_rupees'] = w_raw.get('pnl_inr_base', 0.0)
            w_df['entry_time'] = w_raw['entry_time'].astype(str).str.slice(0, 5)
            w_df['entry_price'] = w_raw['entry_spot']
            w_df['exit_time'] = w_raw['exit_time'].astype(str).str.slice(0, 5)
            w_df['exit_price'] = w_raw['exit_spot']
            w_df['initial_sl'] = np.where(w_df['side'] == 'CALL', w_df['entry_price'] - 28.0, w_df['entry_price'] + 28.0)
            w_df['final_sl'] = w_df['initial_sl']
            w_df['pnl_points'] = w_raw['spot_pts']
            w_df['weighted_pnl_points'] = w_raw['spot_pts']
            w_df['pnl_rupees'] = w_raw['net_pts_base'] * float(lot_size)
            w_df['futures_pnl_rupees'] = w_raw['spot_pts'] * float(lot_size)
            w_df['diff_rupees'] = 0.0
            w_df['max_fav'] = 0.0
            w_df['rr'] = 0.0
            w_df['exit_reason'] = w_raw['exit_reason']
            w_df['vix_chg'] = 0.0
            w_df['base_lots'] = 1
            w_df['pyramided'] = 0
            w_df['total_lots'] = 1
            w_df['setup_id'] = 'williams_fractal'
            w_df['engine'] = 'WILLIAMS_FRACTAL'
            w_df['strategy_label'] = 'Williams Fractal'
            w_df['trigger_label'] = w_df['side'].map(
                lambda s: f"[Williams Fractal] BUY {s} (PD Range Break)"
            )
            w_df['trigger_reason'] = 'Afternoon Prior Day Range Breakout'
            trades_pool.append(w_df)

    if not trades_pool:
        print("No setups selected!")
        return None

    raw_combined = pd.concat(trades_pool, ignore_index=True)
    raw_combined['entry_time_str'] = raw_combined['entry_time'].astype(str).str.slice(0, 5)
    raw_combined['sort_dt'] = pd.to_datetime(raw_combined['date'] + ' ' + raw_combined['entry_time_str'])
    raw_combined = raw_combined.sort_values('sort_dt').drop(columns=['sort_dt']).reset_index(drop=True)

    if mode == "concurrent":
        final_trades = raw_combined
    else:
        # Priority Mode: Max 2 trades per day, max 1 morning (<11:30) and max 1 afternoon (>=12:00)
        selected = []
        for d, grp in raw_combined.groupby('date'):
            count_today = 0
            morn_taken = False
            aft_taken = False
            for _, r in grp.iterrows():
                t_str = r['entry_time_str']
                is_morn = t_str < '11:30'
                is_aft = t_str >= '12:00'
                if is_morn and morn_taken:
                    continue
                if is_aft and aft_taken:
                    continue
                if count_today >= 2:
                    break
                selected.append(r)
                count_today += 1
                if is_morn:
                    morn_taken = True
                else:
                    aft_taken = True

        final_trades = pd.DataFrame(selected).reset_index(drop=True)

    final_trades = final_trades.drop(columns=['entry_time_str'], errors='ignore')
    out_csv = ROOT / "performance" / f"master_portfolio_{symbol.lower()}_trades.csv"
    final_trades.to_csv(out_csv, index=False)
    print(f"\nSaved {len(final_trades)} trades to: {out_csv}")

    # Summary Metrics
    tot = len(final_trades)
    wins = (final_trades['pnl_points'] > 0).sum()
    wr = wins / tot * 100 if tot > 0 else 0
    spot_pts = final_trades['pnl_points'].sum()
    rs = final_trades['pnl_rupees'].sum()

    cum = final_trades['pnl_points'].cumsum()
    dd = (cum.cummax() - cum).max()
    calmar = spot_pts / dd if dd > 0 else 0

    gw = final_trades[final_trades['pnl_points'] > 0]['pnl_points'].sum()
    gl = abs(final_trades[final_trades['pnl_points'] < 0]['pnl_points'].sum())
    pf = gw / gl if gl > 0 else 0

    print("\n" + "=" * 85)
    print(f"=== MASTER PORTFOLIO PERFORMANCE REPORT ({mode.upper()}) ===")
    print("=" * 85)
    print(f"Total Trades Taken:       {tot:,}")
    print(f"Win Rate:                 {wr:.1f}% ({wins} wins / {tot-wins} losses)")
    print(f"Total Spot Points:        {spot_pts:,.1f} pts")
    print(f"Total Rupee PnL (1-lot):  Rs. {rs:,.2f}")
    print(f"Max Drawdown (Points):    {dd:,.1f} pts")
    print(f"Calmar Ratio:             {calmar:.1f}x")
    print(f"Profit Factor:            {pf:.2f}")
    print("=" * 85)

    print("\n--- Breakdown by Triggering Engine ---")
    for s_id, grp in final_trades.groupby('strategy_label'):
        e_pts = grp['pnl_points'].sum()
        e_wr = (grp['pnl_points'] > 0).mean() * 100
        print(f"  * {s_id:<22}: {len(grp):4d} trades | {e_wr:5.1f}% WR | {e_pts:>8,.1f} pts | Rs. {grp['pnl_rupees'].sum():>10,.2f}")

    return final_trades

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['priority', 'concurrent'], default='priority', help='Orchestration mode')
    parser.add_argument('--symbol', choices=['nifty', 'sensex'], default='nifty', help='Underlying symbol')
    parser.add_argument('--setups', default=None, help='Comma-separated setups: trend_runner,vix_trap or all')
    args = parser.parse_args()
    setups_list = args.setups.split(',') if args.setups else None
    run_master_backtest(mode=args.mode, symbol=args.symbol, enabled_setups=setups_list)
