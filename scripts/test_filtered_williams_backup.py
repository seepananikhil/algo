#!/usr/bin/env python3
"""
Test Filtered Williams Midday Box on Silent Days:
What filter makes the backup profitable even in modern 2026 markets?
"""

import duckdb
import numpy as np
import pandas as pd

def test_filtered_backup():
    tr = pd.read_csv('performance/vix_trend_runner_trades.csv')
    tr['date'] = tr['date'].astype(str)
    tr_dates = set(tr['date'])

    vix_df = pd.read_csv('captured_data/india_vix_10y.csv')
    vix_df['date_str'] = pd.to_datetime(vix_df['date']).dt.strftime('%Y-%m-%d')
    vix_map = dict(zip(vix_df['date_str'], vix_df['vix_change_pct']))

    con = duckdb.connect()
    df = con.query("SELECT ts, open, high, low, close, strftime(ts, '%Y-%m-%d') as date_str, strftime(ts, '%H:%M') as time_str FROM 'historical_data/nifty50/parquet/NIFTY50_01min.parquet' ORDER BY ts").df()
    daily_groups = {d: group.reset_index(drop=True) for d, group in df.groupby('date_str')}
    days = sorted(list(daily_groups.keys()))

    prev_day_info = {}
    for d in days:
        g = daily_groups[d]
        c1515_rows = g[g['time_str'] == '15:15']
        c1515 = c1515_rows.iloc[-1]['close'] if len(c1515_rows) > 0 else g.iloc[-1]['close']
        r_range = g['close'].max() - g['close'].min()
        prev_day_info[d] = {'c1515': c1515, 'r_range': r_range}

    # Filters to test on Midday Box:
    # A: VIX expansion: abs(vix_chg) >= 2.0%
    # B: Big Gap: abs(gap_pct) >= 0.5%
    # C: Narrow Morning Consolidation (Compression Coil: Box Width <= 50 pts)
    # D: European Session Breakout (Only after 13:00 IST!)
    filters = ['ALL', 'VIX_EXPANSION_2PCT', 'BIG_GAP_0.5PCT', 'NARROW_BOX_COIL_LE50', 'EUROPEAN_SESSION_1300']

    for filt in filters:
        trades = []
        for i in range(1, len(days)):
            prev_d, curr_d = days[i-1], days[i]
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

            today_open = opens[0]
            prev_1515 = prev_day_info[prev_d]['c1515']
            gap = today_open - prev_1515
            gap_pct = (gap / prev_1515) * 100.0
            vix_chg = vix_map.get(curr_d, 0.0)

            mid_mask = (times >= '09:30') & (times <= '12:00')
            mid_indices = np.where(mid_mask)[0]
            if len(mid_indices) < 20:
                continue

            mid_high = np.max(closes[mid_indices])
            mid_low = np.min(closes[mid_indices])
            box_width = mid_high - mid_low

            # Apply Filter
            if filt == 'VIX_EXPANSION_2PCT' and abs(vix_chg) < 2.0:
                continue
            elif filt == 'BIG_GAP_0.5PCT' and abs(gap_pct) < 0.5:
                continue
            elif filt == 'NARROW_BOX_COIL_LE50' and box_width > 50.0:
                continue

            start_t = '13:00' if filt == 'EUROPEAN_SESSION_1300' else '12:00'
            aft_mask = (times >= start_t) & (times <= '14:29')
            aft_indices = np.where(aft_mask)[0]

            sig = None
            for idx in aft_indices:
                c = closes[idx]
                if c > mid_high:
                    sig = ('CE', idx); break
                elif c < mid_low:
                    sig = ('PE', idx); break

            if sig is not None:
                opt_type, sig_idx = sig
                entry_idx = sig_idx + 1
                if entry_idx >= n_bars or times[entry_idx] > '15:15':
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
                exit_prem = None
                exit_spot = None

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

                trades.append({
                    'year': dt.year,
                    'net_pts': net_pts,
                    'win': 1 if net_pts > 0 else 0
                })

        tdf = pd.DataFrame(trades)
        if len(tdf) == 0:
            continue
        wins = tdf[tdf['win'] == 1]
        losses = tdf[tdf['win'] == 0]
        wr = len(wins) / len(tdf) * 100
        pf = wins['net_pts'].sum() / abs(losses['net_pts'].sum()) if len(losses) and losses['net_pts'].sum() != 0 else 0
        tot_pts = tdf['net_pts'].sum()
        
        t_2026 = tdf[tdf['year'] == 2026]
        w_26 = t_2026[t_2026['win'] == 1]
        wr_26 = len(w_26) / len(t_2026) * 100 if len(t_2026) else 0
        tot_26 = t_2026['net_pts'].sum() if len(t_2026) else 0

        print(f"Filter: {filt:<25} | 10Y Trades: {len(tdf):<4} | 10Y WR: {wr:<4.1f}% | 10Y PF: {pf:<4.2f} | 10Y Pts: {tot_pts:<+9.1f} | 2026 Pts: {tot_26:<+8.1f} ({len(t_2026)} trades)")

if __name__ == '__main__':
    test_filtered_backup()
