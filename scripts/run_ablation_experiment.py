#!/usr/bin/env python3
"""
Ablation and Edge Mechanism Analysis for NIFTY Gap-and-Go -> Williams Chain
Tests the exact quantitative contribution of each specific rule:
1. "filled" stand-down rule
2. "opposite_first" stand-down rule
3. Williams gap filter (<0.2% or >=0.5%) vs trading 0.2-0.5%
4. Williams "not after no_break" rule
5. Trailing SL mechanic (+5% peak, 20% drop)
"""

import duckdb
import numpy as np
import pandas as pd

def run_ablation():
    con = duckdb.connect()
    df = con.query("""
        SELECT 
            ts, epoch, open, high, low, close,
            strftime(ts, '%Y-%m-%d') as date_str,
            strftime(ts, '%H:%M') as time_str
        FROM 'historical_data/nifty50/parquet/NIFTY50_01min.parquet'
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

    # Test variants:
    # 0: Official Strategy (Baseline)
    # 1: Allow Williams on 0.2% - 0.5% gap
    # 2: Allow Williams after "no_break"
    # 3: No "filled" stand-down (Gap-and-Go takes break even if gap was filled)
    # 4: Pure Spot (Delta = 1.0, no option decay)
    
    variants = ['OFFICIAL', 'ALLOW_W_0.2_0.5', 'ALLOW_W_AFTER_NOBREAK', 'NO_FILLED_RULE']
    results = {}

    for var in variants:
        trades = []
        for i in range(1, len(days)):
            prev_d, curr_d = days[i-1], days[i]
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
                            if gap_filled and var != 'NO_FILLED_RULE':
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
                            if gap_filled and var != 'NO_FILLED_RULE':
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
                qualifies = False
                if var == 'OFFICIAL':
                    qualifies = (stand_down_reason in ('opposite_first', 'filled')) and (abs(gap_pct) < 0.2 or abs(gap_pct) >= 0.5)
                elif var == 'ALLOW_W_0.2_0.5':
                    qualifies = (stand_down_reason in ('opposite_first', 'filled')) # any gap size allowed
                elif var == 'ALLOW_W_AFTER_NOBREAK':
                    qualifies = (stand_down_reason in ('opposite_first', 'filled', 'no_break')) and (abs(gap_pct) < 0.2 or abs(gap_pct) >= 0.5)
                elif var == 'NO_FILLED_RULE':
                    qualifies = (stand_down_reason in ('opposite_first', 'filled')) and (abs(gap_pct) < 0.2 or abs(gap_pct) >= 0.5)

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
                        exit_prem = p_close
                        break

                if exit_prem is None:
                    exit_prem = p_close

                gross_pts = exit_prem - entry_prem
                net_pts = gross_pts - (entry_prem + exit_prem) * 0.001
                trades.append(net_pts)

        t_arr = np.array(trades)
        wins = t_arr[t_arr > 0]
        losses = t_arr[t_arr <= 0]
        wr = len(wins) / len(t_arr) * 100 if len(t_arr) else 0
        pf = wins.sum() / abs(losses.sum()) if len(losses) and losses.sum() != 0 else 0
        net_pts = t_arr.sum()
        results[var] = {
            'Trades': len(t_arr),
            'Win Rate %': round(wr, 1),
            'Profit Factor': round(pf, 2),
            'Net Points': round(net_pts, 1),
            'Expectancy (pts)': round(t_arr.mean(), 2)
        }

    res_df = pd.DataFrame(results).T
    print("\n" + "=" * 80)
    print("                    RULE ABLATION EXPERIMENT RESULTS")
    print("=" * 80)
    print(res_df)
    print("=" * 80)

if __name__ == '__main__':
    run_ablation()
