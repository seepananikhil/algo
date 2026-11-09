#!/usr/bin/env python3
"""
Diagnostic Backtest: Designing the Perfect "Williams Backup" for Trend Runner
Focus: Days where Trend Runner generated ZERO trades between 09:30 and 10:30.
Tests:
  1. Pure Williams Levels: Open +/- 0.5 * R (Prior Day Range)
  2. Williams Levels with VWAP Filter (Close > Level & Close > VWAP)
  3. Williams Midday Box Breakout (Break of 09:30 - 12:00 High/Low after 12:00)
  4. Williams Midday Box with VWAP & 1-min Close confirmation
  5. 150-pt ITM Option Execution with -30% SL, Ratchets & 15:15 Flat
"""

import duckdb
import numpy as np
import pandas as pd

def run_williams_backup_test():
    # 1. Load Trend Runner trades
    tr = pd.read_csv('performance/vix_trend_runner_trades.csv')
    tr['date'] = tr['date'].astype(str)
    tr_dates = set(tr['date'])

    # 2. Load 10-Year 1-min Nifty Parquet
    con = duckdb.connect()
    df = con.query("""
        SELECT ts, open, high, low, close, volume,
               strftime(ts, '%Y-%m-%d') as date_str,
               strftime(ts, '%H:%M') as time_str
        FROM 'historical_data/nifty50/parquet/NIFTY50_01min.parquet'
        ORDER BY ts
    """).df()

    # Daily groups
    daily_groups = {d: group.reset_index(drop=True) for d, group in df.groupby('date_str')}
    days = sorted(list(daily_groups.keys()))

    prev_day_info = {}
    for d in days:
        g = daily_groups[d]
        c1515_rows = g[g['time_str'] == '15:15']
        c1515 = c1515_rows.iloc[-1]['close'] if len(c1515_rows) > 0 else g.iloc[-1]['close']
        r_range = g['close'].max() - g['close'].min()
        prev_day_info[d] = {'c1515': c1515, 'r_range': r_range}

    # Backup Variants to Test on Missed Days (d not in tr_dates):
    # Mode 1: WILLIAMS_LEVELS_RAW (Open +/- 0.5 * R, 12:00 to 14:29)
    # Mode 2: WILLIAMS_LEVELS_VWAP (Open +/- 0.5 * R AND Close above/below VWAP)
    # Mode 3: WILLIAMS_MIDDAY_BOX (Break of 09:30-12:00 consolidation box after 12:00)
    # Mode 4: WILLIAMS_MIDDAY_BOX_VWAP (Break of midday box + VWAP alignment)
    # Mode 5: WILLIAMS_MIDDAY_BOX_EXPANSION (Box width >= 40 pts, break + VWAP)

    modes = [
        'WILLIAMS_LEVELS_RAW',
        'WILLIAMS_LEVELS_VWAP',
        'WILLIAMS_MIDDAY_BOX',
        'WILLIAMS_MIDDAY_BOX_VWAP',
        'WILLIAMS_MIDDAY_BOX_EXPANSION'
    ]

    all_results = {}

    for mode in modes:
        trades = []
        for i in range(1, len(days)):
            prev_d, curr_d = days[i-1], days[i]
            # ONLY evaluate on days where Trend Runner was SILENT!
            if curr_d in tr_dates:
                continue

            g = daily_groups[curr_d]
            if len(g) < 100:
                continue

            times = g['time_str'].values
            opens = g['open'].values
            highs = g['high'].values
            lows = g['low'].values
            closes = g['close'].values
            n_bars = len(g)

            # Intraday trend baseline (20 EMA on 1-min closes)
            s_close = pd.Series(closes)
            ema20 = s_close.ewm(span=20, adjust=False).mean().values
            day_midpoint = (np.maximum.accumulate(highs) + np.minimum.accumulate(lows)) / 2.0

            today_open = opens[0]
            R = prev_day_info[prev_d]['r_range']

            # Levels
            w_up = today_open + 0.50 * R
            w_down = today_open - 0.50 * R

            # Midday Box: 09:30 to 12:00
            mid_mask = (times >= '09:30') & (times <= '12:00')
            mid_indices = np.where(mid_mask)[0]
            if len(mid_indices) < 20:
                continue

            mid_high = np.max(closes[mid_indices])
            mid_low = np.min(closes[mid_indices])
            box_width = mid_high - mid_low

            sig = None # (type, idx)

            # Check afternoon window: 12:00 to 14:29
            afternoon_mask = (times >= '12:00') & (times <= '14:29')
            aft_indices = np.where(afternoon_mask)[0]

            for idx in aft_indices:
                c = closes[idx]
                trend_val = ema20[idx]

                if mode == 'WILLIAMS_LEVELS_RAW':
                    if c > w_up:
                        sig = ('CE', idx); break
                    elif c < w_down:
                        sig = ('PE', idx); break

                elif mode == 'WILLIAMS_LEVELS_VWAP':
                    if c > w_up and c > trend_val:
                        sig = ('CE', idx); break
                    elif c < w_down and c < trend_val:
                        sig = ('PE', idx); break

                elif mode == 'WILLIAMS_MIDDAY_BOX':
                    if c > mid_high:
                        sig = ('CE', idx); break
                    elif c < mid_low:
                        sig = ('PE', idx); break

                elif mode == 'WILLIAMS_MIDDAY_BOX_VWAP':
                    if c > mid_high and c > trend_val:
                        sig = ('CE', idx); break
                    elif c < mid_low and c < trend_val:
                        sig = ('PE', idx); break

                elif mode == 'WILLIAMS_MIDDAY_BOX_EXPANSION':
                    # Filter out tiny dead boxes (width must be >= 40 pts)
                    if box_width >= 40.0:
                        if c > mid_high and c > trend_val:
                            sig = ('CE', idx); break
                        elif c < mid_low and c < trend_val:
                            sig = ('PE', idx); break

            if sig is not None:
                opt_type, sig_idx = sig
                entry_idx = sig_idx + 1
                if entry_idx >= n_bars:
                    continue
                if times[entry_idx] > '15:15':
                    continue

                entry_spot = opens[entry_idx]
                dt = pd.to_datetime(curr_d)
                dow = dt.dayofweek
                dte_days = (3 - dow) % 7
                extrinsic_base = max(15.0, 15.0 * (dte_days + 0.5))
                entry_prem = 150.0 + extrinsic_base
                delta = 0.72

                sl_price = entry_prem * 0.70
                peak_prem = entry_prem
                trail_active = False
                exit_prem = None

                for k in range(entry_idx, n_bars):
                    t_k = times[k]
                    c_k = closes[k]
                    h_k = highs[k]
                    l_k = lows[k]

                    if opt_type == 'CE':
                        p_high = entry_prem + (h_k - entry_spot) * delta
                        p_low = entry_prem + (l_k - entry_spot) * delta
                        p_close = entry_prem + (c_k - entry_spot) * delta
                    else:
                        p_high = entry_prem + (entry_spot - l_k) * delta
                        p_low = entry_prem + (entry_spot - h_k) * delta
                        p_close = entry_prem + (entry_spot - c_k) * delta

                    if p_high > peak_prem:
                        peak_prem = p_high

                    if peak_prem >= entry_prem * 1.05:
                        trail_active = True
                        trail_val = peak_prem * 0.80
                        if trail_val > sl_price:
                            sl_price = trail_val

                    if p_close <= sl_price:
                        exit_idx = min(k + 1, n_bars - 1)
                        exit_spot = opens[exit_idx]
                        if opt_type == 'CE':
                            exit_prem = entry_prem + (exit_spot - entry_spot) * delta
                        else:
                            exit_prem = entry_prem + (entry_spot - exit_spot) * delta
                        break

                    if t_k >= '15:15':
                        exit_spot = c_k
                        exit_prem = p_close
                        break

                if exit_prem is None:
                    exit_spot = closes[-1]
                    exit_prem = p_close

                gross_pts = exit_prem - entry_prem
                net_pts = gross_pts - (entry_prem + exit_prem) * 0.001
                spot_pts = (exit_spot - entry_spot) if opt_type == 'CE' else (entry_spot - exit_spot)

                trades.append({
                    'date': curr_d,
                    'year': dt.year,
                    'type': opt_type,
                    'net_pts': net_pts,
                    'spot_pts': spot_pts,
                    'win': 1 if net_pts > 0 else 0
                })

        tdf = pd.DataFrame(trades)
        all_results[mode] = tdf

    print("=" * 95)
    print(" EVALUATION OF WILLIAMS BACKUP VARIANTS (ONLY ON DAYS TREND RUNNER MISSED / STOOD DOWN)")
    print("=" * 95)
    print(f"{'Williams Backup Mode':<30} | {'Trades':<7} | {'Win Rate':<9} | {'PF':<6} | {'Total Net Opt Pts':<18} | {'Avg Pts':<8}")
    print("-" * 95)

    for m, tdf in all_results.items():
        if len(tdf) == 0:
            continue
        wins = tdf[tdf['win'] == 1]
        losses = tdf[tdf['win'] == 0]
        wr = len(wins) / len(tdf) * 100
        sum_w = wins['net_pts'].sum()
        sum_l = abs(losses['net_pts'].sum())
        pf = sum_w / sum_l if sum_l > 0 else 0
        tot_pts = tdf['net_pts'].sum()
        avg_pts = tdf['net_pts'].mean()

        print(f"{m:<30} | {len(tdf):<7} | {wr:<8.1f}% | {pf:<6.2f} | {tot_pts:<+17.1f} | {avg_pts:<+7.2f}")
    print("=" * 95)

    # 2026 performance of the best variants
    print("\n" + "=" * 95)
    print(" 2026 YEAR-TO-DATE RESULTS FOR BACKUP VARIANTS:")
    print("=" * 95)
    for m, tdf in all_results.items():
        tdf_2026 = tdf[tdf['year'] == 2026]
        if len(tdf_2026) == 0:
            continue
        wins = tdf_2026[tdf_2026['win'] == 1]
        losses = tdf_2026[tdf_2026['win'] == 0]
        wr = len(wins) / len(tdf_2026) * 100
        sum_w = wins['net_pts'].sum()
        sum_l = abs(losses['net_pts'].sum())
        pf = sum_w / sum_l if sum_l > 0 else 0
        tot_pts = tdf_2026['net_pts'].sum()
        avg_pts = tdf_2026['net_pts'].mean()
        print(f"{m:<30} | 2026 Trades: {len(tdf_2026):<4} | WR: {wr:<5.1f}% | PF: {pf:<4.2f} | Net Opt Pts: {tot_pts:<+9.1f} | Avg: {avg_pts:<+6.2f}")
    print("=" * 95)

if __name__ == '__main__':
    run_williams_backup_test()
