#!/usr/bin/env python3
"""
Backtest NIFTY & SENSEX Gap-and-Go -> Williams Chain for 2026
Outputs exact points, win rates, and monthly breakdowns for both indices.
"""

import os
import glob
import duckdb
import numpy as np
import pandas as pd

def run_index_backtest(index_name='sensex', year=2026):
    pattern = f'historical_data/{index_name}/1min/{year}/**/*.csv'
    files = glob.glob(pattern, recursive=True)
    if not files:
        print(f"No files found for {index_name} {year}")
        return None

    con = duckdb.connect()
    # Read prior day 2025-12 data if possible, or start from day 1
    # Let's read all files for that year plus previous month if exists
    prev_month_pattern = f'historical_data/{index_name}/1min/{year-1}/12/*.csv'
    all_files = glob.glob(prev_month_pattern) + files

    df = con.query(f"""
        SELECT 
            Timestamp::TIMESTAMP as ts,
            Epoch::BIGINT as epoch,
            Open::DOUBLE as open,
            High::DOUBLE as high,
            Low::DOUBLE as low,
            Close::DOUBLE as close,
            strftime(Timestamp::TIMESTAMP, '%Y-%m-%d') as date_str,
            strftime(Timestamp::TIMESTAMP, '%H:%M') as time_str
        FROM read_csv({all_files}, union_by_name=true, header=true)
        ORDER BY ts
    """).df()

    days = df['date_str'].unique()
    daily_groups = {d: group for d, group in df.groupby('date_str')}

    prev_day_info = {}
    for d in days:
        g = daily_groups[d]
        c1515_rows = g[g['time_str'] == '15:15']
        c1515 = c1515_rows.iloc[-1]['close'] if len(c1515_rows) > 0 else g.iloc[-1]['close']
        r_range = g['close'].max() - g['close'].min()
        prev_day_info[d] = {'c1515': c1515, 'r_range': r_range}

    trades = []
    # Strike ITM parameters:
    # NIFTY: 150 pt ITM (base prem ~ 180-220 pts)
    # SENSEX: 450-500 pt ITM (base prem ~ 550-650 pts)
    itm_pts = 150.0 if index_name == 'nifty50' else 450.0
    delta = 0.72

    for i in range(1, len(days)):
        prev_d, curr_d = days[i-1], days[i]
        if not curr_d.startswith(str(year)):
            continue

        g = daily_groups[curr_d].reset_index(drop=True)
        prev_info = prev_day_info[prev_d]
        if len(g) < 60:
            continue

        times = g['time_str'].values
        opens = g['open'].values
        highs = g['high'].values
        lows = g['low'].values
        closes = g['close'].values
        n_bars = len(g)

        today_open = opens[0]
        prev_1515 = prev_info['c1515']
        gap = today_open - prev_1515
        gap_pct = (gap / prev_1515) * 100.0

        if abs(gap) < 0.01:
            gap_dir = None
        elif gap > 0:
            gap_dir = 'UP'
        else:
            gap_dir = 'DOWN'

        or_mask = (times >= '09:15') & (times <= '09:45')
        or_indices = np.where(or_mask)[0]
        if len(or_indices) < 20:
            continue

        or_closes = closes[or_indices]
        or_high = float(np.max(or_closes))
        or_low = float(np.min(or_closes))
        W = or_high - or_low
        if W <= 0.0:
            continue

        trigger_up = or_high + 0.10 * W
        trigger_down = or_low - 0.10 * W

        bot_signal = None
        stand_down_reason = None
        handover_idx = None

        if gap_dir is None:
            stand_down_reason = 'gap_zero'
        else:
            gap_filled = False
            for k in range(0, or_indices[-1] + 1):
                if gap_dir == 'UP' and lows[k] <= prev_1515:
                    gap_filled = True
                elif gap_dir == 'DOWN' and highs[k] >= prev_1515:
                    gap_filled = True

            check_mask = (times >= '09:46') & (times <= '12:00')
            check_indices = np.where(check_mask)[0]

            for idx in check_indices:
                if gap_dir == 'UP' and lows[idx] <= prev_1515:
                    gap_filled = True
                elif gap_dir == 'DOWN' and highs[idx] >= prev_1515:
                    gap_filled = True

                c = closes[idx]

                if gap_dir == 'UP':
                    if c < trigger_down:
                        stand_down_reason = 'opposite_first'
                        handover_idx = idx
                        break
                    elif c > trigger_up:
                        if gap_filled:
                            stand_down_reason = 'filled'
                            handover_idx = idx
                            break
                        else:
                            bot_signal = ('GAP_AND_GO', 'CE', idx)
                            break
                elif gap_dir == 'DOWN':
                    if c > trigger_up:
                        stand_down_reason = 'opposite_first'
                        handover_idx = idx
                        break
                    elif c < trigger_down:
                        if gap_filled:
                            stand_down_reason = 'filled'
                            handover_idx = idx
                            break
                        else:
                            bot_signal = ('GAP_AND_GO', 'PE', idx)
                            break

            if bot_signal is None and stand_down_reason is None:
                stand_down_reason = 'no_break'
                handover_idx = check_indices[-1] if len(check_indices) > 0 else or_indices[-1]

        # Stage 2: Williams
        R = prev_info['r_range']
        w_up = today_open + 0.50 * R
        w_down = today_open - 0.50 * R

        if bot_signal is None:
            qualifies = (
                stand_down_reason in ('opposite_first', 'filled') and
                (abs(gap_pct) < 0.2 or abs(gap_pct) >= 0.5)
            )
            if qualifies:
                start_w = handover_idx if handover_idx is not None else 0
                for idx in range(start_w, n_bars):
                    t = times[idx]
                    if t > '14:29':
                        break
                    c = closes[idx]
                    if c > w_up:
                        bot_signal = ('WILLIAMS', 'CE', idx)
                        break
                    elif c < w_down:
                        bot_signal = ('WILLIAMS', 'PE', idx)
                        break

        if bot_signal is not None:
            stg, opt_type, s_idx = bot_signal
            entry_idx = s_idx + 1
            if entry_idx >= n_bars:
                continue
            if times[entry_idx] > '15:15':
                continue

            entry_spot = opens[entry_idx]
            dt = pd.to_datetime(curr_d)
            dow = dt.dayofweek
            
            # Expiry day: Nifty = Thu (3), Sensex = Fri (4)
            exp_dow = 4 if index_name == 'sensex' else 3
            dte_days = (exp_dow - dow) % 7
            
            extrinsic_factor = 3.0 if index_name == 'sensex' else 1.0
            extrinsic_base = max(15.0 * extrinsic_factor, 15.0 * extrinsic_factor * (dte_days + 0.5))
            entry_prem = itm_pts + extrinsic_base

            sl_price = entry_prem * 0.70
            peak_prem = entry_prem
            trail_active = False
            exit_prem = None
            exit_time = None
            exit_reason = None
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
                    trail_active = True
                    trail_val = peak_prem * 0.80
                    if trail_val > sl_price:
                        sl_price = trail_val

                if p_close <= sl_price:
                    exit_idx = min(k + 1, n_bars - 1)
                    exit_spot = opens[exit_idx]
                    exit_time = times[exit_idx]
                    if opt_type == 'CE':
                        exit_prem = entry_prem + (exit_spot - entry_spot) * delta
                    else:
                        exit_prem = entry_prem + (entry_spot - exit_spot) * delta
                    exit_reason = 'TRAILING_SL' if (trail_active and sl_price > entry_prem * 0.70) else 'STOP_LOSS_-30%'
                    break

                if t_k >= '15:15':
                    exit_time = '15:15'
                    exit_spot = c_k
                    exit_prem = p_close
                    exit_reason = 'FLAT_15:15'
                    break

            if exit_prem is None:
                exit_time = times[-1]
                exit_spot = closes[-1]
                exit_prem = p_close
                exit_reason = 'EOD_CLOSE'

            gross_pts = exit_prem - entry_prem
            cost_pts = (entry_prem + exit_prem) * 0.001
            net_pts = gross_pts - cost_pts
            spot_pts = (exit_spot - entry_spot) if opt_type == 'CE' else (entry_spot - exit_spot)

            trades.append({
                'index': index_name.upper(),
                'date': curr_d,
                'month': curr_d[:7],
                'stage': stg,
                'type': opt_type,
                'entry_time': times[entry_idx],
                'entry_spot': round(entry_spot, 2),
                'exit_time': exit_time,
                'exit_spot': round(exit_spot, 2),
                'exit_reason': exit_reason,
                'spot_pts': round(spot_pts, 2),
                'gross_pts': round(gross_pts, 2),
                'net_pts': round(net_pts, 2),
                'win': 1 if net_pts > 0 else 0
            })

    return pd.DataFrame(trades)

if __name__ == '__main__':
    nifty_2026 = run_index_backtest('nifty50', 2026)
    sensex_2026 = run_index_backtest('sensex', 2026)
    
    print("\n" + "=" * 80)
    print("        2026 YEAR-TO-DATE COMPARISON: NIFTY vs SENSEX")
    print("=" * 80)
    for name, df in [('NIFTY 50', nifty_2026), ('SENSEX', sensex_2026)]:
        if df is None or len(df) == 0:
            continue
        wins = df[df['win'] == 1]
        wr = len(wins) / len(df) * 100
        pf = wins['net_pts'].sum() / abs(df[df['win'] == 0]['net_pts'].sum())
        print(f"\n--- {name} (2026 YTD) ---")
        print(f"Total Trades:        {len(df)}")
        print(f"Win Rate:            {wr:.1f}%")
        print(f"Profit Factor:       {pf:.2f}")
        print(f"Total Spot Points:   {df['spot_pts'].sum():+,.1f} pts")
        print(f"Total Net Opt Pts:   {df['net_pts'].sum():+,.1f} pts (after 0.1% friction)")
        print(f"Avg Net Pts / Trade: {df['net_pts'].mean():+.2f} pts")
        
        print("\nMonthly Breakdown:")
        m_grp = df.groupby('month').agg(
            trades=('win', 'count'),
            wins=('win', 'sum'),
            spot_pts=('spot_pts', 'sum'),
            net_pts=('net_pts', 'sum')
        )
        m_grp['wr'] = (m_grp['wins'] / m_grp['trades'] * 100).round(1)
        m_grp['spot_pts'] = m_grp['spot_pts'].round(1)
        m_grp['net_pts'] = m_grp['net_pts'].round(1)
        print(m_grp[['trades', 'wr', 'spot_pts', 'net_pts']])
