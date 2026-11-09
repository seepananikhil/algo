#!/usr/bin/env python3
"""
Investigating the True Backup Solution:
Why does Trend Runner miss 82 big trend days in 2026?
Testing 3 Concrete Approaches:
  Approach 1: Extended Trend Runner Window (allow breakout entry up to 12:30/13:00)
  Approach 2: Relaxed VIX Filter on Delayed Breakouts (|VIX| >= 1.2% after 10:30)
  Approach 3: Williams Midday Range Expansion (15m close beyond 09:15-12:00 box)
"""

import duckdb
import numpy as np
import pandas as pd

def analyze_backup_solutions():
    tr = pd.read_csv('performance/vix_trend_runner_trades.csv')
    tr['date'] = tr['date'].astype(str)
    tr_dates = set(tr['date'])

    vdf = pd.read_csv('captured_data/india_vix_10y.csv')
    vdf['date_str'] = pd.to_datetime(vdf['date']).dt.strftime('%Y-%m-%d')
    vmap = dict(zip(vdf['date_str'], vdf['vix_change_pct']))

    con = duckdb.connect()
    # Query 2026 data
    df = con.query("""
        SELECT ts, open, high, low, close, volume,
               strftime(ts, '%Y-%m-%d') as date_str,
               strftime(ts, '%H:%M') as time_str
        FROM 'historical_data/nifty50/parquet/NIFTY50_01min.parquet'
        WHERE strftime(ts, '%Y-%m-%d') >= '2026-01-01'
        ORDER BY ts
    """).df()

    daily_groups = {d: group.reset_index(drop=True) for d, group in df.groupby('date_str')}
    days = sorted(list(daily_groups.keys()))

    print(f"Total trading days in 2026: {len(days)}")
    print(f"Days Trend Runner traded: {len(tr_dates.intersection(set(days)))}")
    print(f"Days Trend Runner was silent: {len(set(days) - tr_dates)}")

    # Test Backup Strategy A: "Delayed 15m Box Expansion"
    # Logic:
    # 1. Trend Runner takes no trade by 10:30.
    # 2. Form Morning Box from 09:15 to 11:30 (High & Low).
    # 3. Between 11:30 and 14:00, if price breaks above Morning High or below Morning Low
    #    AND range so far has room to run
    #    Enter ITM option with 28-pt SL (or -30% option SL).
    
    trades = []
    for d in days:
        if d in tr_dates:
            continue # Only on silent days!

        g = daily_groups[d]
        times = g['time_str'].values
        opens = g['open'].values
        highs = g['high'].values
        lows = g['low'].values
        closes = g['close'].values
        n_bars = len(g)

        # 09:15 to 11:30 Morning Box
        box_mask = (times >= '09:15') & (times <= '11:30')
        box_idx = np.where(box_mask)[0]
        if len(box_idx) < 30:
            continue

        b_high = np.max(highs[box_idx])
        b_low = np.min(lows[box_idx])
        b_width = b_high - b_low

        # Filter out days where the box is already gigantic (> 180 pts exhausted)
        # We want coil or moderate expansion (40 to 140 pts)
        if b_width < 40 or b_width > 160:
            continue

        # Look for breakout from 11:31 to 13:45
        aft_mask = (times >= '11:31') & (times <= '13:45')
        aft_indices = np.where(aft_mask)[0]

        sig = None
        for idx in aft_indices:
            c = closes[idx]
            # Must close at least 5 pts beyond box
            if c >= b_high + 5.0:
                sig = ('CE', idx, b_high + 5.0)
                break
            elif c <= b_low - 5.0:
                sig = ('PE', idx, b_low - 5.0)
                break

        if sig is not None:
            opt_type, sig_idx, trig_price = sig
            entry_idx = sig_idx + 1
            if entry_idx >= n_bars or times[entry_idx] > '15:15':
                continue

            entry_spot = opens[entry_idx]
            delta = 0.72
            base_prem = 180.0

            # Trend Runner style stop loss: 30 spot points SL
            # Let's test with 35 spot points SL and trailing at +70 pts
            sl_pts = 35.0
            peak_spot_fav = 0.0
            exit_spot = None
            exit_reason = None

            for k in range(entry_idx, n_bars):
                t_k = times[k]
                h_k, l_k, c_k = highs[k], lows[k], closes[k]

                if opt_type == 'CE':
                    fav = h_k - entry_spot
                    adverse = entry_spot - l_k
                    curr_pts = c_k - entry_spot
                else:
                    fav = entry_spot - l_k
                    adverse = h_k - entry_spot
                    curr_pts = entry_spot - c_k

                if fav > peak_spot_fav:
                    peak_spot_fav = fav

                # Check SL
                cur_sl = sl_pts
                if peak_spot_fav >= 80.0:
                    cur_sl = -30.0 # lock +30 pts
                elif peak_spot_fav >= 50.0:
                    cur_sl = 0.0 # Breakeven

                if adverse >= cur_sl:
                    exit_spot = entry_spot - cur_sl if opt_type == 'CE' else entry_spot + cur_sl
                    exit_reason = 'SL_HIT'
                    break

                if t_k >= '15:15':
                    exit_spot = c_k
                    exit_reason = 'FLAT_15:15'
                    break

            if exit_spot is None:
                exit_spot = closes[-1]
                exit_reason = 'EOD'

            spot_pnl = (exit_spot - entry_spot) if opt_type == 'CE' else (entry_spot - exit_spot)
            opt_pnl = spot_pnl * delta

            trades.append({
                'date': d,
                'type': opt_type,
                'entry_time': times[entry_idx],
                'b_width': round(b_width, 1),
                'spot_pnl': round(spot_pnl, 1),
                'opt_pnl': round(opt_pnl, 1),
                'exit_reason': exit_reason,
                'win': 1 if spot_pnl > 0 else 0
            })

    tdf = pd.DataFrame(trades)
    print("\n--- RESULTS FOR DELAYED 11:30 BOX EXPANSION BACKUP (2026) ---")
    print(f"Total Trades Taken on Silent Days: {len(tdf)}")
    if len(tdf) > 0:
        wins = tdf[tdf['win'] == 1]
        print(f"Win Rate: {len(wins)/len(tdf)*100:.1f}%")
        print(f"Total Spot Points: {tdf['spot_pnl'].sum():+,.1f} pts")
        print(f"Total Option Points: {tdf['opt_pnl'].sum():+,.1f} pts")
        print(f"Avg Spot Points / Trade: {tdf['spot_pnl'].mean():+.2f} pts")
        print(tdf.head(15))

if __name__ == '__main__':
    analyze_backup_solutions()
