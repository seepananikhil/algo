#!/usr/bin/env python3
"""
NIFTY Gap-and-Go -> Williams Chain Comprehensive Multi-Year Backtester
Enhanced with Tiered Profit Ratchet (matching VIX Master discipline).

Setups Generated:
  1. Setup 3: Pure Gap-and-Go (Morning 10% ORB Breakout on Gap Continuation)
  2. Setup 4: Williams Fractal Runner (Afternoon Prior Day Range Breakout)
  3. Combined Multi-Engine Chain
"""

import os
import sys
import math
import duckdb
import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')

def run_simulation(parquet_path='historical_data/nifty50/parquet/NIFTY50_01min.parquet'):
    print(f"Loading data from {parquet_path}...")
    con = duckdb.connect()
    df = con.query(f"""
        SELECT
            ts, epoch, open, high, low, close,
            strftime(ts, '%Y-%m-%d') as date_str,
            strftime(ts, '%H:%M') as time_str
        FROM '{parquet_path}'
        ORDER BY ts
    """).df()

    print(f"Total 1-min bars loaded: {len(df):,}")
    print(f"Date range: {df['date_str'].min()} to {df['date_str'].max()}")

    days = df['date_str'].unique()
    daily_groups = {d: group for d, group in df.groupby('date_str')}

    prev_day_info = {}
    for d in days:
        g = daily_groups[d]
        c1515_rows = g[g['time_str'] == '15:15']
        if len(c1515_rows) > 0:
            c1515 = c1515_rows.iloc[-1]['close']
        else:
            pre1515 = g[g['time_str'] <= '15:15']
            c1515 = pre1515.iloc[-1]['close'] if len(pre1515) > 0 else g.iloc[-1]['close']

        r_range = g['close'].max() - g['close'].min()

        prev_day_info[d] = {
            'c1515': c1515,
            'r_range': r_range,
            'high': g['high'].max(),
            'low': g['low'].min(),
            'close': g.iloc[-1]['close']
        }

    all_trades = []
    standdown_counts = {'opposite_first': 0, 'filled': 0, 'no_break': 0, 'gap_zero': 0}
    williams_candidates = 0

    for i in range(1, len(days)):
        prev_date = days[i - 1]
        curr_date = days[i]
        curr_g = daily_groups[curr_date].reset_index(drop=True)
        prev_info = prev_day_info[prev_date]

        if len(curr_g) < 60:
            continue

        times = curr_g['time_str'].values
        opens = curr_g['open'].values
        highs = curr_g['high'].values
        lows = curr_g['low'].values
        closes = curr_g['close'].values
        n_bars = len(curr_g)

        today_open = opens[0]
        prev_1515 = prev_info['c1515']
        gap = today_open - prev_1515
        gap_pct = (gap / prev_1515) * 100.0

        if abs(gap) < 0.01:
            standdown_counts['gap_zero'] += 1
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
                            bot_signal = ('GAP_AND_GO', 'CE', idx, trigger_up)
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
                            bot_signal = ('GAP_AND_GO', 'PE', idx, trigger_down)
                            break

            if bot_signal is None and stand_down_reason is None:
                stand_down_reason = 'no_break'
                handover_idx = check_indices[-1] if len(check_indices) > 0 else or_indices[-1]

        if stand_down_reason in standdown_counts:
            standdown_counts[stand_down_reason] += 1

        # Williams Levels (Setup 4)
        R = prev_info['r_range']
        w_up = today_open + 0.50 * R
        w_down = today_open - 0.50 * R

        if bot_signal is None:
            qualifies_for_williams = (
                stand_down_reason in ('opposite_first', 'filled') and
                (abs(gap_pct) < 0.2 or abs(gap_pct) >= 0.5)
            )
            if qualifies_for_williams:
                williams_candidates += 1
                start_w_idx = handover_idx if handover_idx is not None else 0
                for idx in range(start_w_idx, n_bars):
                    t = times[idx]
                    if t > '14:29':
                        break
                    c = closes[idx]
                    if c > w_up:
                        bot_signal = ('WILLIAMS', 'CE', idx, w_up)
                        break
                    elif c < w_down:
                        bot_signal = ('WILLIAMS', 'PE', idx, w_down)
                        break

        # If a trade was signaled, simulate execution with Tiered Ratchet
        if bot_signal is not None:
            stage_name, opt_type, sig_idx, trig_lvl = bot_signal
            entry_idx = sig_idx + 1
            if entry_idx >= n_bars:
                continue

            entry_time = times[entry_idx]
            if entry_time > '15:15':
                continue

            entry_spot = opens[entry_idx]

            dt = pd.to_datetime(curr_date)
            dow = dt.dayofweek
            dte_days = (3 - dow) % 7
            extrinsic_base = max(15.0, 15.0 * (dte_days + 0.5))
            entry_prem = 150.0 + extrinsic_base
            delta = 0.72

            # Exact Spot Points Ratchet Ladder (Matching VIX Master / Trend Runner discipline):
            # - Initial SL: 28.0 pt
            # - Tier 0A (+40 pt): Pull SL to -15 pt (risk cut in half)
            # - Tier 0B (+55 pt): Lock Breakeven +5 pt
            # - Tier 1 (+70 pt): Lock +20 pt profit
            # - Tier 2 (+130 pt): Lock +60 pt profit
            # - Tier 3 (+180 pt): Lock +110 pt profit
            # - Tier 4 (+230 pt): Lock +165 pt profit
            initial_sl_pts = 28.0
            curr_sl_pts = -initial_sl_pts
            max_fav = 0.0
            exit_prem = None
            exit_time = None
            exit_reason = None
            exit_spot = None

            for k in range(entry_idx, n_bars):
                t_k = times[k]
                c_k = closes[k]
                h_k = highs[k]
                l_k = lows[k]

                fav = (h_k - entry_spot) if opt_type == 'CE' else (entry_spot - l_k)
                curr_fav = (c_k - entry_spot) if opt_type == 'CE' else (entry_spot - c_k)

                if fav > max_fav:
                    max_fav = fav

                # Spot Points Ratchet Locks
                if max_fav >= 230.0:
                    curr_sl_pts = max(curr_sl_pts, 165.0)
                elif max_fav >= 180.0:
                    curr_sl_pts = max(curr_sl_pts, 110.0)
                elif max_fav >= 130.0:
                    curr_sl_pts = max(curr_sl_pts, 60.0)
                elif max_fav >= 70.0:
                    curr_sl_pts = max(curr_sl_pts, 20.0)
                elif max_fav >= 55.0:
                    curr_sl_pts = max(curr_sl_pts, 5.0)
                elif max_fav >= 40.0:
                    curr_sl_pts = max(curr_sl_pts, -15.0)

                if curr_fav <= curr_sl_pts:
                    exit_idx = min(k + 1, n_bars - 1)
                    exit_time = times[exit_idx]
                    exit_spot = opens[exit_idx]
                    if opt_type == 'CE':
                        exit_prem = entry_prem + (exit_spot - entry_spot) * delta
                    else:
                        exit_prem = entry_prem + (entry_spot - exit_spot) * delta
                    exit_reason = 'TRAILING_RATCHET' if curr_sl_pts > -initial_sl_pts else 'INITIAL_SL'
                    break

                if t_k >= '15:15':
                    exit_time = '15:15'
                    exit_spot = c_k
                    if opt_type == 'CE':
                        exit_prem = entry_prem + (exit_spot - entry_spot) * delta
                    else:
                        exit_prem = entry_prem + (entry_spot - exit_spot) * delta
                    exit_reason = 'FLAT_15:15'
                    break

            if exit_prem is None:
                exit_time = times[-1]
                exit_spot = closes[-1]
                exit_prem = p_close
                exit_reason = 'EOD_CLOSE'

            gross_pts = exit_prem - entry_prem
            spot_pts = (exit_spot - entry_spot) if opt_type == 'CE' else (entry_spot - exit_spot)
            turnover = entry_prem + exit_prem
            cost_base_pts = turnover * 0.001
            net_pts_base = gross_pts - cost_base_pts

            year = dt.year
            month = dt.month
            if year < 2021 or (year == 2021 and month <= 6):
                lot_size = 75
            elif year < 2024 or (year == 2024 and month <= 4):
                lot_size = 50
            else:
                lot_size = 25

            qty = lot_size * 5
            modern_qty = 125

            all_trades.append({
                'date': curr_date,
                'year': year,
                'stage': stage_name,
                'type': opt_type,
                'gap_pts': round(gap, 2),
                'gap_pct': round(gap_pct, 3),
                'stand_down_reason': stand_down_reason,
                'entry_time': entry_time,
                'entry_spot': round(entry_spot, 2),
                'entry_prem': round(entry_prem, 2),
                'exit_time': exit_time,
                'exit_spot': round(exit_spot, 2),
                'exit_prem': round(exit_prem, 2),
                'exit_reason': exit_reason,
                'spot_pts': round(spot_pts, 2),
                'gross_pts': round(gross_pts, 2),
                'net_pts_base': round(net_pts_base, 2),
                'pnl_inr_base': round(net_pts_base * qty, 2),
                'pnl_inr_modern': round(net_pts_base * modern_qty, 2),
                'win_base': 1 if net_pts_base > 0 else 0
            })

    tdf = pd.DataFrame(all_trades)
    print("\nSimulation complete with Tiered Ratchet!")
    print(f"Total executed trades: {len(tdf)}")

    os.makedirs('performance', exist_ok=True)
    # Save combined
    tdf.to_csv('performance/gap_and_go_williams_official_trades.csv', index=False)
    
    # Save separated pure datasets
    pure_gap = tdf[tdf['stage'] == 'GAP_AND_GO'].copy()
    pure_gap.to_csv('performance/pure_gap_and_go_trades.csv', index=False)
    
    pure_wil = tdf[tdf['stage'] == 'WILLIAMS'].copy()
    pure_wil.to_csv('performance/williams_fractal_trades.csv', index=False)
    
    print(f"Saved: performance/gap_and_go_williams_official_trades.csv ({len(tdf)} trades)")
    print(f"Saved: performance/pure_gap_and_go_trades.csv ({len(pure_gap)} trades)")
    print(f"Saved: performance/williams_fractal_trades.csv ({len(pure_wil)} trades)")

    return tdf

if __name__ == '__main__':
    run_simulation()
