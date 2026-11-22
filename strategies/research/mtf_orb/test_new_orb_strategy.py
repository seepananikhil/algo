#!/usr/bin/env python3
"""
Test 3 distinct NEW strategy concepts across the 5 timeframes:
1. Concept A: HTF Trend Pullback to 15M Value + 5M EMA Re-cross (Trend Following)
2. Concept B: 15-Minute Opening Range (ORB) Retest + 1H Bias
3. Concept C: 1-Hour Inside Bar / Compression Breakout triggered on 5M
"""

import pandas as pd
import numpy as np

def run_tests():
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

    # Daily aggregation from 5m
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
    
    # 1-Hour Indicators
    df1h['h1_ema20'] = df1h['close'].ewm(span=20, adjust=False).mean()
    df1h['h1_trend'] = np.where(df1h['close'] > df1h['h1_ema20'], 1, -1)
    df1h_ready = df1h[['timestamp', 'h1_trend', 'h1_ema20']].copy()
    df1h_ready['avail_ts'] = df1h_ready['timestamp'] + pd.Timedelta(hours=1)

    # 15-Minute Opening Range (First two 15m candles: 09:15-09:45)
    df15['time_str'] = df15['timestamp'].dt.strftime('%H:%M')
    # 15m VWAP
    tp15 = (df15['high'] + df15['low'] + df15['close']) / 3.0
    pv15 = tp15 * df15['volume']
    cum_pv15 = pv15.groupby(df15['date']).cumsum()
    cum_vol15 = df15['volume'].groupby(df15['date']).cumsum()
    df15['vwap15'] = np.where(cum_vol15 > 0, cum_pv15 / cum_vol15, tp15.groupby(df15['date']).transform(lambda x: x.expanding().mean()))
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15['m15_trend'] = np.where(df15['close'] > df15['m15_ema20'], 1, -1)
    
    df15_ready = df15[['timestamp', 'vwap15', 'm15_ema20', 'm15_trend']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.Timedelta(minutes=15)

    # Merge Daily onto 5m
    df5 = df5.merge(daily[['date', 'pdh', 'pdl', 'pdc', 'daily_bias']], on='date', how='left')
    
    # Merge 1H and 15m asof on 5m
    df5 = pd.merge_asof(
        df5,
        df1h_ready[['avail_ts', 'h1_trend', 'h1_ema20']],
        left_on='timestamp',
        right_on='avail_ts',
        direction='backward'
    )
    df5 = pd.merge_asof(
        df5,
        df15_ready[['avail_ts', 'vwap15', 'm15_ema20', 'm15_trend']],
        left_on='timestamp',
        right_on='avail_ts',
        direction='backward'
    )

    # 5-minute Intraday VWAP & ATR
    tp5 = (df5['high'] + df5['low'] + df5['close']) / 3.0
    pv5 = tp5 * df5['volume']
    cum_pv5 = pv5.groupby(df5['date']).cumsum()
    cum_vol5 = df5['volume'].groupby(df5['date']).cumsum()
    df5['vwap5'] = np.where(cum_vol5 > 0, cum_pv5 / cum_vol5, tp5.groupby(df5['date']).transform(lambda x: x.expanding().mean()))
    
    df5['ema9'] = df5['close'].ewm(span=9, adjust=False).mean()
    df5['ema21'] = df5['close'].ewm(span=21, adjust=False).mean()

    # Opening Range 15m (09:15 to 09:30 range on 5m: first 3 bars)
    or_df = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        or_high=('high', 'max'),
        or_low=('low', 'min')
    ).reset_index()
    df5 = df5.merge(or_df, on='date', how='left')

    # Test Concept: 15M ORB Breakout with Retest & 1H Alignment
    # Rules:
    # 1. 1H Trend matches Daily Bias (Uptrend: 1H=1 & Daily=1; Downtrend: 1H=-1 & Daily=-1)
    # 2. Window: 09:40 to 14:00 (avoid 11:30-12:30 lunch dead zone)
    # 3. For LONG:
    #    - Price broke above OR High (close > or_high)
    #    - Retest: Low of current or previous bar touches or_high ± 8 pts (holding as support)
    #    - Confirmation: Close > 5M EMA9 and Close > Open (green bounce)
    # 4. For SHORT:
    #    - Price broke below OR Low (close < or_low)
    #    - Retest: High of current or previous bar touches or_low ± 8 pts (holding as resistance)
    #    - Confirmation: Close < 5M EMA9 and Close < Open (red bounce)

    session_active = (
        ((df5['time_str'] >= '09:40') & (df5['time_str'] <= '11:30')) |
        ((df5['time_str'] >= '13:00') & (df5['time_str'] <= '14:15'))
    )

    retest_long = (df5['low'] <= df5['or_high'] + 8.0) & (df5['close'] >= df5['or_high'] - 4.0) & (df5['close'] > df5['open']) & (df5['close'] > df5['ema9'])
    long_sig = session_active & (df5['h1_trend'] == 1) & (df5['daily_bias'] == 1) & (df5['m15_trend'] == 1) & retest_long

    retest_short = (df5['high'] >= df5['or_low'] - 8.0) & (df5['close'] <= df5['or_low'] + 4.0) & (df5['close'] < df5['open']) & (df5['close'] < df5['ema9'])
    short_sig = session_active & (df5['h1_trend'] == -1) & (df5['daily_bias'] == -1) & (df5['m15_trend'] == -1) & retest_short

    df5['sig_orb'] = None
    df5.loc[long_sig, 'sig_orb'] = 'LONG'
    df5.loc[short_sig, 'sig_orb'] = 'SHORT'

    print("Simulating MTF 15M ORB-Retest Strategy...")
    run_sim(df5, 'sig_orb')

def run_sim(df5, sig_col):
    n = len(df5)
    opens = df5['open'].values
    highs = df5['high'].values
    lows = df5['low'].values
    closes = df5['close'].values
    sigs = df5[sig_col].values
    dates = df5['date'].values
    times = df5['time_str'].values
    date_strs = df5['date_str'].values
    
    trades = []
    trades_today = {}
    i = 0
    
    while i < n - 1:
        sig = sigs[i]
        d = dates[i]
        d_str = date_strs[i]
        
        if sig in ('LONG', 'SHORT'):
            if trades_today.get(d, 0) >= 1:
                i += 1
                continue
                
            entry_idx = i + 1
            if entry_idx >= n or dates[entry_idx] != d:
                i += 1
                continue
                
            entry_px = opens[entry_idx]
            entry_time = times[entry_idx]
            
            # SL = 20 pts fixed or swing low
            sl_dist = 22.0
            tgt_dist = 55.0 # 1:2.5 RR
            
            sl = entry_px - sl_dist if sig == 'LONG' else entry_px + sl_dist
            tgt = entry_px + tgt_dist if sig == 'LONG' else entry_px - tgt_dist
            
            exit_px = None
            exit_reason = None
            exit_time = None
            exit_idx = None
            
            for j in range(entry_idx, min(n, entry_idx + 24)):
                if dates[j] != d or times[j] >= '15:15':
                    exit_px = closes[j]
                    exit_reason = 'EOD'
                    exit_time = times[j]
                    exit_idx = j
                    break
                    
                h = highs[j]
                l = lows[j]
                
                if sig == 'LONG':
                    if l <= sl:
                        exit_px = sl
                        exit_reason = 'SL'
                        exit_time = times[j]
                        exit_idx = j
                        break
                    elif h >= tgt:
                        exit_px = tgt
                        exit_reason = 'TARGET'
                        exit_time = times[j]
                        exit_idx = j
                        break
                else:
                    if h >= sl:
                        exit_px = sl
                        exit_reason = 'SL'
                        exit_time = times[j]
                        exit_idx = j
                        break
                    elif l <= tgt:
                        exit_px = tgt
                        exit_reason = 'TARGET'
                        exit_time = times[j]
                        exit_idx = j
                        break
                        
            if exit_px is None:
                exit_idx = min(n - 1, entry_idx + 24)
                exit_px = closes[exit_idx]
                exit_time = times[exit_idx]
                exit_reason = 'TIMEOUT'
                
            pnl = (exit_px - entry_px) if sig == 'LONG' else (entry_px - exit_px)
            trades.append({
                'date': d_str,
                'entry_time': entry_time,
                'side': 'CALL' if sig == 'LONG' else 'PUT',
                'entry_spot': round(entry_px, 2),
                'sl_spot': round(sl, 2),
                'target_spot': round(tgt, 2),
                'exit_time': exit_time,
                'exit_spot': round(exit_px, 2),
                'pnl_points': round(pnl, 2),
                'rr': round(pnl / sl_dist, 2),
                'reason': exit_reason
            })
            trades_today[d] = trades_today.get(d, 0) + 1
            i = exit_idx
        else:
            i += 1
            
    tdf = pd.DataFrame(trades)
    if tdf.empty:
        print("No trades found.")
        return
        
    wins = tdf[tdf['pnl_points'] > 0]
    losses = tdf[tdf['pnl_points'] <= 0]
    wr = len(wins) / len(tdf) * 100
    avg_w = wins['pnl_points'].mean()
    avg_l = abs(losses['pnl_points'].mean())
    rr = avg_w / avg_l
    net = tdf['pnl_points'].sum()
    pf = wins['pnl_points'].sum() / abs(losses['pnl_points'].sum()) if len(losses) and losses['pnl_points'].sum() != 0 else 99
    
    print(f"Total Trades: {len(tdf)}")
    print(f"Win Rate:     {wr:.1f}%")
    print(f"Avg Win:      +{avg_w:.1f} pts")
    print(f"Avg Loss:     -{avg_l:.1f} pts")
    print(f"Realized RR:  1:{rr:.2f}")
    print(f"Net Points:   {net:+.1f} pts")
    print(f"Profit Factor:{pf:.2f}")
    
    oct_df = tdf[tdf['date'].str.startswith('2026-10')]
    print("\nTrades for October 2026:")
    if not oct_df.empty:
        print(oct_df.to_string(index=False))
    else:
        print("No trades in October 2026 under this setup.")

if __name__ == '__main__':
    run_tests()
