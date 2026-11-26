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
    lot_size = 20 if is_sx else 65
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
            t_df['year'] = pd.to_datetime(t_df['date']).dt.year
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
            tp_df['year'] = pd.to_datetime(tp_df['date']).dt.year
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
            w_df['year'] = pd.to_datetime(w_df['date']).dt.year
            w_df['trade_num'] = 1
            w_df['stage'] = 'WILLIAMS'
            w_df['side'] = w_raw['type'].map(lambda x: 'CALL' if 'CE' in str(x).upper() else 'PUT')
            w_df['option'] = w_df['side']
            w_df['option_symbol'] = ''
            w_df['option_entry_price'] = w_raw.get('entry_prem', 0.0)
            w_df['option_exit_price'] = w_raw.get('exit_prem', 0.0)
            net_pts_series = w_raw['net_pts_base'] if 'net_pts_base' in w_raw.columns else w_raw['net_pts']
            w_df['option_pnl_points'] = net_pts_series
            w_df['option_pnl_rupees'] = w_raw.get('pnl_inr_base', net_pts_series * float(lot_size))
            w_df['entry_time'] = w_raw['entry_time'].astype(str).str.slice(0, 5)
            w_df['entry_price'] = w_raw['entry_spot']
            w_df['exit_time'] = w_raw['exit_time'].astype(str).str.slice(0, 5)
            w_df['exit_price'] = w_raw['exit_spot']
            w_df['initial_sl'] = np.where(w_df['side'] == 'CALL', w_df['entry_price'] - 28.0, w_df['entry_price'] + 28.0)
            w_df['final_sl'] = w_df['initial_sl']
            w_df['pnl_points'] = w_raw['spot_pts']
            w_df['weighted_pnl_points'] = w_raw['spot_pts']
            w_df['pnl_rupees'] = net_pts_series * float(lot_size)
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

    # Load Dual Confluence settings from master_portfolio_config.json
    cfg_path = ROOT / "master_portfolio_config.json"
    port_cfg = {}
    if cfg_path.exists():
        try:
            port_cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
        except Exception:
            pass
    require_dual = bool(port_cfg.get("require_dual_activation", False))
    window_mins = int(port_cfg.get("dual_activation_window_mins", 60))
    max_concurrent = int(port_cfg.get("max_concurrent_positions", 1))
    max_trades_per_day = int(port_cfg.get("max_trades_per_day", 2))

    # Load complete partner trades (Both Trend Runner & VIX Trap)
    if not is_sx:
        partner_files = [
            ROOT / "performance" / "sensex_backtest_trades.csv",
            ROOT / "performance" / "sensex_vix_divergence_trades.csv",
        ]
    else:
        partner_files = [
            ROOT / "performance" / "vix_trend_runner_trades.csv",
            ROOT / "performance" / "vix_divergence_backtest_trades.csv",
        ]

    min_p_date, max_p_date = "9999-99-99", "0000-00-00"
    p_df = None
    if require_dual:
        try:
            p_dfs = []
            for pf in partner_files:
                if pf.exists():
                    df_part = pd.read_csv(pf)
                    df_part['date_str'] = pd.to_datetime(df_part['date']).dt.strftime('%Y-%m-%d')
                    df_part['side_norm'] = df_part['side'].astype(str).str.upper().apply(
                        lambda s: 'LONG' if s in ('LONG', 'CALL', 'CE', 'BUY') else 'SHORT'
                    )
                    df_part['t_str'] = df_part['entry_time'].astype(str).str.slice(0, 5)
                    p_dfs.append(df_part)
            if p_dfs:
                p_df = pd.concat(p_dfs, ignore_index=True)
                p_df = p_df.sort_values(['date_str', 't_str']).reset_index(drop=True)
                min_p_date = p_df['date_str'].min()
                max_p_date = p_df['date_str'].max()
                print(f"[Dual Confluence Active] Loaded {len(p_df)} complete partner trades ({min_p_date} to {max_p_date}). Window = {window_mins}m")
        except Exception as exc:
            print(f"[Dual Confluence Error] {exc}")

    raw_combined['side_norm'] = raw_combined['side'].astype(str).str.upper().apply(
        lambda s: 'LONG' if s in ('LONG', 'CALL', 'CE', 'BUY') else 'SHORT'
    )

    if mode == "concurrent":
        # Concurrent Mode: Keep trades that triggered in BOTH (1-to-1 matching), respecting max_concurrent_positions
        if not require_dual or p_df is None or p_df.empty:
            final_trades = raw_combined
        else:
            from datetime import datetime as dt_cls
            selected = []
            # Pre-2023: Nifty trades only (no partner historical data exists)
            for d, grp in raw_combined[raw_combined['date'] < min_p_date].groupby('date'):
                last_exit_by_engine = {}
                count_today = 0
                for _, r in grp.iterrows():
                    if count_today >= max_trades_per_day:
                        break
                    eng = r['setup_id']
                    t_str = r['entry_time_str']
                    t_dt = dt_cls.strptime(t_str, "%H:%M")
                    if max_concurrent == 1 and eng in last_exit_by_engine and t_dt < last_exit_by_engine[eng]:
                        continue
                    exit_str = str(r.get('exit_time') or '15:15')[:5]
                    try:
                        last_exit_by_engine[eng] = dt_cls.strptime(exit_str, "%H:%M")
                    except Exception:
                        last_exit_by_engine[eng] = dt_cls.strptime('15:15', "%H:%M")
                    count_today += 1
                    selected.append(r)

            # 2023+: Only trades confirmed by partner index
            for d, grp in raw_combined[raw_combined['date'] >= min_p_date].groupby('date'):
                p_grp = p_df[p_df['date_str'] == d].copy()
                if p_grp.empty:
                    continue
                used_p = set()
                last_exit_by_engine = {}
                count_today = 0
                for _, r in grp.iterrows():
                    if count_today >= max_trades_per_day:
                        break
                    eng = r['setup_id']
                    t_str = r['entry_time_str']
                    t_dt = dt_cls.strptime(t_str, "%H:%M")
                    if max_concurrent == 1 and eng in last_exit_by_engine and t_dt < last_exit_by_engine[eng]:
                        continue

                    rside = r['side_norm']
                    best_p_idx = None
                    best_diff = 999999
                    for p_idx, pr in p_grp.iterrows():
                        if pr['side_norm'] != rside:
                            continue
                        p_dt = dt_cls.strptime(pr['t_str'], "%H:%M")
                        p_exit_str = str(pr.get('exit_time') or pr.get('exit_time_str') or '15:15')[:5]
                        try:
                            p_exit_dt = dt_cls.strptime(p_exit_str, "%H:%M")
                        except Exception:
                            p_exit_dt = dt_cls.strptime('15:15', "%H:%M")

                        diff = abs((t_dt - p_dt).total_seconds()) / 60.0
                        is_partner_active = (p_dt <= t_dt <= p_exit_dt)
                        if (diff <= window_mins and (p_idx not in used_p) and diff < best_diff) or is_partner_active:
                            best_diff = diff
                            best_p_idx = p_idx
                            if is_partner_active:
                                break

                    if best_p_idx is not None:
                        used_p.add(best_p_idx)
                        r_copy = r.copy()
                        pr = p_grp.loc[best_p_idx]
                        p_t_str = str(pr['t_str'])
                        p_dt = dt_cls.strptime(p_t_str, "%H:%M")
                        if t_dt < p_dt:
                            r_copy['first_armed_sym'] = symbol.upper()
                            r_copy['first_armed_time'] = t_str
                            r_copy['actual_trigger_time'] = p_t_str
                            r_copy['delta_mins'] = round(best_diff, 1)
                        elif p_dt < t_dt:
                            r_copy['first_armed_sym'] = 'SENSEX' if not is_sx else 'NIFTY'
                            r_copy['first_armed_time'] = p_t_str
                            r_copy['actual_trigger_time'] = t_str
                            r_copy['delta_mins'] = round(best_diff, 1)
                        else:
                            r_copy['first_armed_sym'] = 'SIMULTANEOUS'
                            r_copy['first_armed_time'] = t_str
                            r_copy['actual_trigger_time'] = t_str
                            r_copy['delta_mins'] = 0.0

                        exit_str = str(r.get('exit_time') or '15:15')[:5]
                        try:
                            last_exit_by_engine[eng] = dt_cls.strptime(exit_str, "%H:%M")
                        except Exception:
                            last_exit_by_engine[eng] = dt_cls.strptime('15:15', "%H:%M")
                        count_today += 1
                        selected.append(r_copy)

            final_trades = pd.DataFrame(selected).reset_index(drop=True)
    else:
        # Priority Mode: Max 2 trades per day, max 1 morning (<11:30) and max 1 afternoon (>=12:00)
        selected = []
        for d, grp in raw_combined.groupby('date'):
            count_today = 0
            morn_taken = False
            aft_taken = False
            p_grp = p_df[p_df['date_str'] == d].copy() if (require_dual and p_df is not None and not p_df.empty) else pd.DataFrame()
            used_p = set()

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

                # Dual Confluence Check on overlapping multi-year dates (from min_p_date 2023 onwards)
                if require_dual and str(d) >= min_p_date:
                    from datetime import datetime as dt_cls
                    rside = r['side_norm']
                    t_dt = dt_cls.strptime(t_str, "%H:%M")
                    confirmed = False
                    best_p_idx = None
                    best_diff = 999999

                    for p_idx, pr in p_grp.iterrows():
                        if p_idx in used_p or pr['side_norm'] != rside:
                            continue
                        p_dt = dt_cls.strptime(pr['t_str'], "%H:%M")
                        diff = abs((t_dt - p_dt).total_seconds()) / 60.0
                        if diff <= window_mins and diff < best_diff:
                            best_diff = diff
                            best_p_idx = p_idx
                            confirmed = True

                    if not confirmed or best_p_idx is None:
                        continue  # Filter single-index unconfirmed fakeout
                    used_p.add(best_p_idx)

                selected.append(r)
                count_today += 1
                if is_morn:
                    morn_taken = True
                else:
                    aft_taken = True

        final_trades = pd.DataFrame(selected).reset_index(drop=True)

    final_trades['pnl_rupees'] = final_trades['pnl_points'] * float(lot_size)
    final_trades['futures_pnl_rupees'] = final_trades['pnl_points'] * float(lot_size)
    final_trades['qty'] = int(lot_size)
    final_trades = final_trades.drop(columns=['entry_time_str', 'side_norm'], errors='ignore')
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
    cfg_path = ROOT / "master_portfolio_config.json"
    default_mode = "concurrent"
    if cfg_path.exists():
        try:
            cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
            default_mode = cfg.get("mode", "concurrent")
        except Exception:
            pass

    parser = argparse.ArgumentParser()
    parser.add_argument('--mode', choices=['priority', 'concurrent'], default=default_mode, help='Orchestration mode')
    parser.add_argument('--symbol', choices=['nifty', 'sensex', 'both'], default='both', help='Underlying symbol')
    parser.add_argument('--setups', default=None, help='Comma-separated setups: trend_runner,vix_trap or all')
    args = parser.parse_args()
    setups_list = args.setups.split(',') if args.setups else None

    if args.symbol == 'both':
        print(f"\n>>> Running Master Portfolio Backtest for BOTH Nifty and Sensex in {args.mode.upper()} mode...\n")
        run_master_backtest(mode=args.mode, symbol='nifty', enabled_setups=setups_list)
        run_master_backtest(mode=args.mode, symbol='sensex', enabled_setups=setups_list)
    else:
        run_master_backtest(mode=args.mode, symbol=args.symbol, enabled_setups=setups_list)
