#!/usr/bin/env python3
"""
FIXED & TUNED HIGH WIN-RATE TREND RUNNER
Removes the 09:15 volume spike distortion.
Uses True Price Displacement + 1-Hour Institutional Bias + Intelligent Trailing.
"""

import pandas as pd
import numpy as np

def run_tuned_trend_runner():
    df5 = pd.read_csv('captured_data/fyers/nifty_5min.csv')
    df15 = pd.read_csv('captured_data/fyers/nifty_15min.csv')
    df1h = pd.read_csv('captured_data/fyers/nifty_1hr.csv')

    for d in [df5, df15, df1h]:
        d['timestamp'] = pd.to_datetime(d['timestamp'])
        d.sort_values('timestamp', inplace=True)
        d.reset_index(drop=True, inplace=True)
        d['date'] = d['timestamp'].dt.date
        d['date_str'] = d['timestamp'].dt.strftime('%Y-%m-%d')
        d['time_str'] = d['timestamp'].dt.strftime('%H:%M')

    # Daily Levels
    daily = df5.groupby('date').agg(
        day_open=('open', 'first'),
        day_high=('high', 'max'),
        day_low=('low', 'min'),
        day_close=('close', 'last')
    ).reset_index()
    daily['pdh'] = daily['day_high'].shift(1)
    daily['pdl'] = daily['day_low'].shift(1)
    daily['pdc'] = daily['day_close'].shift(1)
    daily['daily_ema20'] = daily['day_close'].ewm(span=20, adjust=False).mean().shift(1)
    daily['daily_bias'] = np.where(daily['pdc'] > daily['daily_ema20'], 1, -1)

    # 1-Hour Trend
    df1h['h1_ema20'] = df1h['close'].ewm(span=20, adjust=False).mean()
    df1h['h1_trend'] = np.where(df1h['close'] > df1h['h1_ema20'], 1, -1)
    df1h_ready = df1h[['timestamp', 'h1_trend']].copy()
    df1h_ready['avail_ts'] = df1h_ready['timestamp'] + pd.Timedelta(hours=1)

    # 15-Minute EMA20 for Trailing
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15_ready = df15[['timestamp', 'm15_ema20']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.Timedelta(minutes=15)

    df5 = df5.merge(daily[['date', 'pdh', 'pdl', 'pdc', 'daily_bias']], on='date', how='left')
    df5 = pd.merge_asof(df5, df1h_ready[['avail_ts', 'h1_trend']], left_on='timestamp', right_on='avail_ts', direction='backward')
    df5 = pd.merge_asof(df5, df15_ready[['avail_ts', 'm15_ema20']], left_on='timestamp', right_on='avail_ts', direction='backward')
    df5['h1_trend'] = df5['h1_trend'].bfill().ffill()

    # 5-min VWAP
    tp5 = (df5['high'] + df5['low'] + df5['close']) / 3.0
    pv5 = tp5 * df5['volume']
    cum_pv5 = pv5.groupby(df5['date']).cumsum()
    cum_vol5 = df5['volume'].groupby(df5['date']).cumsum()
    df5['vwap'] = np.where(cum_vol5 > 0, cum_pv5 / cum_vol5, tp5.groupby(df5['date']).transform(lambda x: x.expanding().mean()))

    # 15-Minute Opening Range (09:15 to 09:30)
    or15 = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        or_high=('high', 'max'),
        or_low=('low', 'min')
    ).reset_index()
    or15['or_range'] = or15['or_high'] - or15['or_low']
    df5 = df5.merge(or15, on='date', how='left')

    # Candle metrics
    candle_range = (df5['high'] - df5['low']).replace(0, 1.0)
    bull_body = df5['close'] - df5['open']
    bear_body = df5['open'] - df5['close']
    upper_wick = df5['high'] - np.maximum(df5['open'], df5['close'])
    lower_wick = np.minimum(df5['open'], df5['close']) - df5['low']

    # Quality Breakout:
    # 1. Body >= 50% of candle range (Strong directional candle)
    # 2. Minimal adverse wick (upper wick <= 30% for Long, lower wick <= 30% for Short)
    # 3. 1-Hour Trend matches
    strong_bull = (bull_body / candle_range >= 0.50) & (upper_wick / candle_range <= 0.30)
    strong_bear = (bear_body / candle_range >= 0.50) & (lower_wick / candle_range <= 0.30)

    time_window = (df5['time_str'] >= '09:30') & (df5['time_str'] <= '10:30') & (df5['or_range'] >= 30.0)

    long_sig = time_window & (df5['close'] > df5['or_high']) & (df5['close'] > df5['vwap']) & strong_bull & (df5['h1_trend'] == 1)
    short_sig = time_window & (df5['close'] < df5['or_low']) & (df5['close'] < df5['vwap']) & strong_bear & (df5['h1_trend'] == -1)

    df5['sig'] = None
    df5.loc[long_sig, 'sig'] = 'LONG'
    df5.loc[short_sig, 'sig'] = 'SHORT'

    # SIMULATION WITH PROFIT PRESERVATION:
    # 1. Initial Hard Stop: 25.0 points
    # 2. Lock-in Rule: When trade reaches +40 points, move Stop to +15 points (Guaranteed 15 pt win!)
    # 3. Trend Trail: When trade reaches +70 points, trail with 15M EMA20!
    # 4. Max hold: 15:15 PM EOD
    
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

    sl_pts = 25.0
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
            curr_sl = entry_px - sl_pts if sig == 'LONG' else entry_px + sl_pts

            exit_px = None
            exit_reason = None
            exit_time = None
            max_fav = 0.0

            for j in range(entry_idx, n):
                if dates[j] != d or times[j] >= '15:15':
                    exit_px = closes[j]; exit_reason = 'EOD_RUNNER'; exit_time = times[j]; i = j; break
                h, l, c = highs[j], lows[j], closes[j]
                ema_trail = m15_ema20s[j]

                fav = (h - entry_px) if sig == 'LONG' else (entry_px - l)
                if fav > max_fav: max_fav = fav

                # Profit Protection Lock:
                if max_fav >= 40.0:
                    locked_level = entry_px + 15.0 if sig == 'LONG' else entry_px - 15.0
                    if sig == 'LONG': curr_sl = max(curr_sl, locked_level)
                    else: curr_sl = min(curr_sl, locked_level)

                if sig == 'LONG':
                    if l <= curr_sl:
                        exit_px = curr_sl; exit_reason = 'STOP_OR_LOCK'; exit_time = times[j]; i = j; break
                    elif max_fav >= 70.0 and c < ema_trail:
                        exit_px = c; exit_reason = 'TRAIL_15M'; exit_time = times[j]; i = j; break
                else:
                    if h >= curr_sl:
                        exit_px = curr_sl; exit_reason = 'STOP_OR_LOCK'; exit_time = times[j]; i = j; break
                    elif max_fav >= 70.0 and c > ema_trail:
                        exit_px = c; exit_reason = 'TRAIL_15M'; exit_time = times[j]; i = j; break

            pnl = (exit_px - entry_px) if sig == 'LONG' else (entry_px - exit_px)
            trades.append({
                'date': d_str,
                'entry_time': entry_time,
                'side': 'CALL' if sig == 'LONG' else 'PUT',
                'entry_spot': round(entry_px, 2),
                'pnl_points': round(pnl, 2),
                'max_fav': round(max_fav, 2),
                'rr': round(pnl / sl_pts, 2),
                'reason': exit_reason
            })
            trades_today[d] = 1
        else:
            i += 1

    tdf = pd.DataFrame(trades)
    tdf.to_csv('performance/tuned_high_wr_trend_trades.csv', index=False)
    
    tdf['year'] = pd.to_datetime(tdf['date']).dt.year
    y2026 = tdf[tdf['year'] == 2026]
    
    wins = tdf[tdf['pnl_points'] > 0]
    losses = tdf[tdf['pnl_points'] <= 0]
    wr = len(wins) / len(tdf) * 100
    aw = wins['pnl_points'].mean() if len(wins) else 0
    al = abs(losses['pnl_points'].mean()) if len(losses) else 0
    rr = aw / al if al else 0
    net = tdf['pnl_points'].sum()
    pf = wins['pnl_points'].sum() / abs(losses['pnl_points'].sum()) if len(losses) and losses['pnl_points'].sum() != 0 else 99
    
    w26 = y2026[y2026['pnl_points'] > 0]
    l26 = y2026[y2026['pnl_points'] <= 0]
    wr26 = len(w26) / len(y2026) * 100 if len(y2026) else 0
    aw26 = w26['pnl_points'].mean() if len(w26) else 0
    al26 = abs(l26['pnl_points'].mean()) if len(l26) else 0
    rr26 = aw26 / al26 if al26 else 0
    net26 = y2026['pnl_points'].sum() if len(y2026) else 0
    pf26 = w26['pnl_points'].sum() / abs(l26['pnl_points'].sum()) if len(l26) and l26['pnl_points'].sum() != 0 else 99

    print("================================================================================")
    print("      TUNED HIGH-WINRATE TREND RUNNER PERFORMANCE                               ")
    print("================================================================================")
    print(f"5-YEAR METRICS:  Trades: {len(tdf)} | Win Rate: {wr:.1f}% | Avg Win: +{aw:.1f} | Avg Loss: -{al:.1f} | RR: 1:{rr:.2f} | Net: {net:+.1f} pts | PF: {pf:.2f}")
    print(f"2026 METRICS:    Trades: {len(y2026)} | Win Rate: {wr26:.1f}% | Avg Win: +{aw26:.1f} | Avg Loss: -{al26:.1f} | RR: 1:{rr26:.2f} | Net: {net26:+.1f} pts | PF: {pf26:.2f}")
    print("================================================================================")
    
    print("\nYEAR-BY-YEAR SUMMARY:")
    for yr, grp in tdf.groupby('year'):
        w_y = grp[grp['pnl_points'] > 0]
        l_y = grp[grp['pnl_points'] <= 0]
        y_wr = len(w_y)/len(grp)*100
        y_aw = w_y['pnl_points'].mean() if len(w_y) else 0
        y_al = abs(l_y['pnl_points'].mean()) if len(l_y) else 0
        y_rr = y_aw / y_al if y_al else 0
        y_net = grp['pnl_points'].sum()
        y_pf = w_y['pnl_points'].sum() / abs(l_y['pnl_points'].sum()) if len(l_y) and l_y['pnl_points'].sum() != 0 else 99
        y_100 = (grp['pnl_points'] >= 100.0).sum()
        print(f"Year {yr} | Trades: {len(grp):<3} | Win%: {y_wr:5.1f}% | AvgWin: +{y_aw:5.1f} | AvgLoss: -{y_al:4.1f} | RR: 1:{y_rr:4.2f} | 100+Pts: {y_100:<2} | Net: {y_net:+8.1f} | PF: {y_pf:4.2f}")

    print("\nOCTOBER 2026 TRADES:")
    oct_df = y2026[y2026['date'].str.startswith('2026-10')]
    print(oct_df.to_string(index=False))

if __name__ == '__main__':
    run_tuned_trend_runner()
