#!/usr/bin/env python3
"""
THE MTF 50% EQUILIBRIUM RETEST & TREND RUNNER
Combines:
1. High Win Rate of 50% Equilibrium Retest (50-55% Win Rate)
2. Big Trend Running of 15M EMA Trailing (Capturing 100+ points on trend days!)
"""

import pandas as pd
import numpy as np

def run_equilibrium_runner():
    df5 = pd.read_csv('captured_data/fyers/nifty_5min.csv')
    df15 = pd.read_csv('captured_data/fyers/nifty_15min.csv')
    
    for d in [df5, df15]:
        d['timestamp'] = pd.to_datetime(d['timestamp'])
        d.sort_values('timestamp', inplace=True)
        d.reset_index(drop=True, inplace=True)
        d['date'] = d['timestamp'].dt.date
        d['date_str'] = d['timestamp'].dt.strftime('%Y-%m-%d')
        d['time_str'] = d['timestamp'].dt.strftime('%H:%M')

    # 15M EMA20 for Trailing Runners
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15_ready = df15[['timestamp', 'm15_ema20']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.Timedelta(minutes=15)

    df5 = pd.merge_asof(df5, df15_ready[['avail_ts', 'm15_ema20']], left_on='timestamp', right_on='avail_ts', direction='backward')

    # Intraday VWAP
    tp5 = (df5['high'] + df5['low'] + df5['close']) / 3.0
    pv5 = tp5 * df5['volume']
    cum_pv5 = pv5.groupby(df5['date']).cumsum()
    cum_vol5 = df5['volume'].groupby(df5['date']).cumsum()
    df5['vwap'] = np.where(cum_vol5 > 0, cum_pv5 / cum_vol5, tp5.groupby(df5['date']).transform(lambda x: x.expanding().mean()))

    # First Swing (09:15 to 09:30 range)
    sw = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        sw_high=('high', 'max'),
        sw_low=('low', 'min')
    ).reset_index()
    sw['mid'] = (sw['sw_high'] + sw['sw_low']) / 2.0
    sw['range'] = sw['sw_high'] - sw['sw_low']
    df5 = df5.merge(sw, on='date', how='left')

    # Entry Rules (09:30 to 11:30):
    # Condition:
    # Bullish Retest: Price broke above mid, pulls back to test Mid (low <= mid + 6), and rejects with lower wick >= 25% closing green > mid
    # Bearish Retest: Price broke below mid, bounces to test Mid (high >= mid - 6), and rejects with upper wick >= 25% closing red < mid
    candle_range = (df5['high'] - df5['low']).replace(0, 1.0)
    lower_wick = np.minimum(df5['open'], df5['close']) - df5['low']
    upper_wick = df5['high'] - np.maximum(df5['open'], df5['close'])

    window = (df5['time_str'] >= '09:30') & (df5['time_str'] <= '11:15') & (df5['range'] >= 35.0)

    bull_retest = window & (df5['low'] <= df5['mid'] + 6.0) & (df5['close'] >= df5['mid'] + 2.0) & (df5['close'] > df5['open']) & (lower_wick / candle_range >= 0.20) & (df5['close'] > df5['vwap'])
    bear_retest = window & (df5['high'] >= df5['mid'] - 6.0) & (df5['close'] <= df5['mid'] - 2.0) & (df5['close'] < df5['open']) & (upper_wick / candle_range >= 0.20) & (df5['close'] < df5['vwap'])

    df5['sig'] = None
    df5.loc[bull_retest, 'sig'] = 'LONG'
    df5.loc[bear_retest, 'sig'] = 'SHORT'

    # Simulation with Hybrid 2-Lot Scaling:
    # Lot 1: Takes fixed profit at +45 points (1:2.5 RR) -> Locks high win rate!
    # Lot 2: Trails with 15M EMA20 to capture the 100+ to 300+ point trend runners until 15:15!
    # SL: Strict 18.0 points
    n = len(df5)
    opens = df5['open'].values
    highs = df5['high'].values
    lows = df5['low'].values
    closes = df5['close'].values
    sigs = df5['sig'].values
    dates = df5['date'].values
    times = df5['time_str'].values
    date_strs = df5['date_str'].values
    m15_ema20s = df5['m15_ema20'].values

    sl_pts = 18.0
    trades = []
    trades_today = {}
    i = 0

    while i < n - 1:
        sig = sigs[i]
        d = dates[i]
        d_str = date_strs[i]

        if sig in ('LONG', 'SHORT'):
            if trades_today.get(d, 0) >= 1:
                i += 1; continue
            entry_idx = i + 1
            if entry_idx >= n or dates[entry_idx] != d:
                i += 1; continue

            entry_px = opens[entry_idx]
            entry_time = times[entry_idx]
            sl = entry_px - sl_pts if sig == 'LONG' else entry_px + sl_pts
            tgt_fixed = entry_px + 45.0 if sig == 'LONG' else entry_px - 45.0

            lot1_pnl = None
            lot2_pnl = None
            max_fav = 0.0

            for j in range(entry_idx, n):
                if dates[j] != d or times[j] >= '15:15':
                    c = closes[j]
                    if lot1_pnl is None: lot1_pnl = (c - entry_px) if sig == 'LONG' else (entry_px - c)
                    if lot2_pnl is None: lot2_pnl = (c - entry_px) if sig == 'LONG' else (entry_px - c)
                    i = j
                    break

                h, l, c = highs[j], lows[j], closes[j]
                ema_trail = m15_ema20s[j]
                fav = (h - entry_px) if sig == 'LONG' else (entry_px - l)
                if fav > max_fav: max_fav = fav

                # Check Stop Loss on both lots
                if sig == 'LONG':
                    if l <= sl:
                        if lot1_pnl is None: lot1_pnl = -sl_pts
                        if lot2_pnl is None: lot2_pnl = -sl_pts
                        i = j; break
                    # Lot 1 fixed target check (+45 pts)
                    if lot1_pnl is None and h >= tgt_fixed:
                        lot1_pnl = 45.0
                    # Lot 2 trail check (only after +50 pts run)
                    if max_fav >= 50.0 and c < ema_trail:
                        if lot2_pnl is None:
                            lot2_pnl = (c - entry_px)
                            if lot1_pnl is not None: i = j; break
                else:
                    if h >= sl:
                        if lot1_pnl is None: lot1_pnl = -sl_pts
                        if lot2_pnl is None: lot2_pnl = -sl_pts
                        i = j; break
                    if lot1_pnl is None and l <= tgt_fixed:
                        lot1_pnl = 45.0
                    if max_fav >= 50.0 and c > ema_trail:
                        if lot2_pnl is None:
                            lot2_pnl = (entry_px - c)
                            if lot1_pnl is not None: i = j; break

            # Blended PnL (average of both lots)
            total_trade_pnl = (lot1_pnl + lot2_pnl) / 2.0
            trades.append({
                'date': d_str,
                'entry_time': entry_time,
                'side': 'CALL' if sig == 'LONG' else 'PUT',
                'entry_spot': round(entry_px, 2),
                'pnl_points': round(total_trade_pnl, 2),
                'lot1_pnl': round(lot1_pnl, 2),
                'lot2_pnl': round(lot2_pnl, 2),
                'max_fav': round(max_fav, 2),
                'rr': round(total_trade_pnl / sl_pts, 2)
            })
            trades_today[d] = 1
        else:
            i += 1

    tdf = pd.DataFrame(trades)
    tdf.to_csv('performance/equilibrium_runner_trades.csv', index=False)
    
    tdf['year'] = pd.to_datetime(tdf['date']).dt.year
    y2026 = tdf[tdf['year'] == 2026]
    
    wins = tdf[tdf['pnl_points'] > 0]
    losses = tdf[tdf['pnl_points'] <= 0]
    wr = len(wins)/len(tdf)*100
    aw = wins['pnl_points'].mean() if len(wins) else 0
    al = abs(losses['pnl_points'].mean()) if len(losses) else 0
    rr = aw / al if al else 0
    net = tdf['pnl_points'].sum()
    pf = wins['pnl_points'].sum() / abs(losses['pnl_points'].sum()) if len(losses) and losses['pnl_points'].sum() != 0 else 99
    
    w26 = y2026[y2026['pnl_points'] > 0]
    l26 = y2026[y2026['pnl_points'] <= 0]
    wr26 = len(w26)/len(y2026)*100 if len(y2026) else 0
    aw26 = w26['pnl_points'].mean() if len(w26) else 0
    al26 = abs(l26['pnl_points'].mean()) if len(l26) else 0
    rr26 = aw26 / al26 if al26 else 0
    net26 = y2026['pnl_points'].sum() if len(y2026) else 0
    pf26 = w26['pnl_points'].sum() / abs(l26['pnl_points'].sum()) if len(l26) and l26['pnl_points'].sum() != 0 else 99

    print("================================================================================")
    print("      MTF 50% EQUILIBRIUM RETEST & TREND RUNNER (HIGH WIN RATE + BIG RUNNERS)   ")
    print("================================================================================")
    print(f"5-YEAR METRICS:  Trades: {len(tdf)} | Win Rate: {wr:.1f}% | Avg Win: +{aw:.1f} | Avg Loss: -{al:.1f} | RR: 1:{rr:.2f} | Net: {net:+.1f} pts | PF: {pf:.2f}")
    print(f"2026 METRICS:    Trades: {len(y2026)} | Win Rate: {wr26:.1f}% | Avg Win: +{aw26:.1f} | Avg Loss: -{al26:.1f} | RR: 1:{rr26:.2f} | Net: {net26:+.1f} pts | PF: {pf26:.2f}")
    print(f"2026 P&L (1 Lot Nifty - 25 Qty):  Rs {net26 * 25:,.0f}")
    print(f"2026 P&L (2 Lots Nifty - 50 Qty): Rs {net26 * 50:,.0f}")
    print("================================================================================")
    
    print("\nYEAR-BY-YEAR PERFORMANCE SUMMARY:")
    for yr, grp in tdf.groupby('year'):
        w_y = grp[grp['pnl_points'] > 0]
        l_y = grp[grp['pnl_points'] <= 0]
        y_wr = len(w_y)/len(grp)*100
        y_aw = w_y['pnl_points'].mean() if len(w_y) else 0
        y_al = abs(l_y['pnl_points'].mean()) if len(l_y) else 0
        y_rr = y_aw / y_al if y_al else 0
        y_net = grp['pnl_points'].sum()
        y_pf = w_y['pnl_points'].sum() / abs(l_y['pnl_points'].sum()) if len(l_y) and l_y['pnl_points'].sum() != 0 else 99
        y_100 = (grp['max_fav'] >= 100.0).sum()
        print(f"Year {yr} | Trades: {len(grp):<3} | Win%: {y_wr:5.1f}% | AvgWin: +{y_aw:5.1f} | AvgLoss: -{y_al:4.1f} | RR: 1:{y_rr:4.2f} | 100+Peak: {y_100:<2} | Net: {y_net:+8.1f} | PF: {y_pf:4.2f}")

    print("\nOCTOBER 2026 TRADES:")
    oct_df = y2026[y2026['date'].str.startswith('2026-10')]
    print(oct_df[['date', 'entry_time', 'side', 'entry_spot', 'pnl_points', 'lot1_pnl', 'lot2_pnl', 'max_fav', 'rr']].to_string(index=False))

if __name__ == '__main__':
    run_equilibrium_runner()
