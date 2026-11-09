#!/usr/bin/env python3
"""
Comparative & Hybrid Analysis: Trend Runner + Gap-and-Go / Williams Chain as Backup
Evaluates:
1. Trend Runner Alone (Baseline)
2. Gap-and-Go -> Williams Alone
3. Hybrid Fallback (Trend Runner primary; if no trade by 10:30, Gap-and-Go / Williams acts as backup)
4. Dual Ensemble (Both running side-by-side)
"""

import pandas as pd
import numpy as np

def run_backup_analysis():
    tr = pd.read_csv('performance/vix_trend_runner_trades.csv')
    gg = pd.read_csv('performance/gap_and_go_williams_official_trades.csv')

    tr['date'] = tr['date'].astype(str)
    gg['date'] = gg['date'].astype(str)

    # Let's extract clean points & pnl
    # In Trend Runner: 'option_pnl_points' is the net option points per trade (or 'pnl_points' for spot)
    # Let's check columns
    tr_daily = {}
    for d, g in tr.groupby('date'):
        # Take first trade of day if multiple
        row = g.iloc[0]
        # In tr: 'option_pnl_points' is option points, 'pnl_points' is spot points
        opt_pts = row['option_pnl_points'] if 'option_pnl_points' in row else row['pnl_points']
        tr_daily[d] = {
            'date': d,
            'entry_time': row['entry_time'],
            'opt_pts': opt_pts,
            'spot_pts': row['pnl_points'],
            'win': 1 if opt_pts > 0 else 0
        }

    gg_daily = {}
    for d, g in gg.groupby('date'):
        row = g.iloc[0]
        gg_daily[d] = {
            'date': d,
            'stage': row['stage'],
            'entry_time': row['entry_time'],
            'opt_pts': row['net_pts_base'],
            'spot_pts': row['spot_pts'],
            'win': 1 if row['net_pts_base'] > 0 else 0
        }

    # All unique dates from both
    all_dates = sorted(list(set(list(tr_daily.keys()) + list(gg_daily.keys()))))

    # Evaluate on all dates, and specifically 2026
    modes = ['TREND_RUNNER_ONLY', 'GAP_AND_GO_ONLY', 'HYBRID_BACKUP', 'DUAL_PARALLEL']
    
    for scope_name, filter_yr in [('FULL 10-YEAR HISTORY (2017-2026)', None), ('YEAR 2026 ONLY', 2026)]:
        print("=" * 85)
        print(f"       PORTFOLIO EVALUATION: {scope_name}")
        print("=" * 85)
        print(f"{'Strategy Mode':<22} | {'Trades':<7} | {'Win Rate':<9} | {'Net Opt Pts':<13} | {'Avg Pts':<8} | {'Spot Pts':<12}")
        print("-" * 85)

        for mode in modes:
            trades = []
            for d in all_dates:
                if filter_yr is not None and not d.startswith(str(filter_yr)):
                    continue

                tr_t = tr_daily.get(d)
                gg_t = gg_daily.get(d)

                if mode == 'TREND_RUNNER_ONLY':
                    if tr_t:
                        trades.append({'opt_pts': tr_t['opt_pts'], 'spot_pts': tr_t['spot_pts']})
                elif mode == 'GAP_AND_GO_ONLY':
                    if gg_t:
                        trades.append({'opt_pts': gg_t['opt_pts'], 'spot_pts': gg_t['spot_pts']})
                elif mode == 'HYBRID_BACKUP':
                    # Priority: Trend Runner primary (09:30 - 10:30)
                    # If Trend Runner traded, use Trend Runner
                    # If Trend Runner took NO trade, use Gap-and-Go as backup!
                    if tr_t:
                        trades.append({'opt_pts': tr_t['opt_pts'], 'spot_pts': tr_t['spot_pts']})
                    elif gg_t:
                        # Backup triggered!
                        trades.append({'opt_pts': gg_t['opt_pts'], 'spot_pts': gg_t['spot_pts']})
                elif mode == 'DUAL_PARALLEL':
                    # Both trade if they signal
                    pts = 0.0
                    s_pts = 0.0
                    if tr_t:
                        pts += tr_t['opt_pts']
                        s_pts += tr_t['spot_pts']
                    if gg_t:
                        pts += gg_t['opt_pts']
                        s_pts += gg_t['spot_pts']
                    if tr_t or gg_t:
                        trades.append({'opt_pts': pts, 'spot_pts': s_pts})

            tdf = pd.DataFrame(trades)
            if len(tdf) == 0:
                continue
            wins = tdf[tdf['opt_pts'] > 0]
            wr = len(wins) / len(tdf) * 100
            net_opt = tdf['opt_pts'].sum()
            avg_pts = tdf['opt_pts'].mean()
            net_spot = tdf['spot_pts'].sum()

            print(f"{mode:<22} | {len(tdf):<7} | {wr:<8.1f}% | {net_opt:<+12.1f} | {avg_pts:<+7.2f} | {net_spot:<+11.1f}")
        print("=" * 85 + "\n")

    # Let's inspect the 742 Backup days specifically
    print("=" * 85)
    print(" PERFORMANCE ON 'SILENT' DAYS (When Trend Runner took 0 trades):")
    print("=" * 85)
    silent_trades = []
    for d, gg_t in gg_daily.items():
        if d not in tr_daily:
            silent_trades.append(gg_t)
    
    st_df = pd.DataFrame(silent_trades)
    st_wins = st_df[st_df['win'] == 1]
    st_wr = len(st_wins) / len(st_df) * 100
    st_net = st_df['opt_pts'].sum()
    st_spot = st_df['spot_pts'].sum()
    print(f"Total Days Trend Runner Missed / Stood Down: {len(st_df)} days")
    print(f"Backup Bot Win Rate:                         {st_wr:.1f}%")
    print(f"Net Option Points Extracted by Backup:       {st_net:+,.1f} pts")
    print(f"Net Spot Points Extracted by Backup:         {st_spot:+,.1f} pts")
    print(f"Avg Points per Rescued Trade:                {st_df['opt_pts'].mean():+.2f} pts")
    print("=" * 85)

if __name__ == '__main__':
    run_backup_analysis()
