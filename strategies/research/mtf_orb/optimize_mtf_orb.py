#!/usr/bin/env python3
"""
Parameter Optimizer for MTF ORB-Retest Strategy across 5 Years.
Finds configurations that maximize Win Rate, Profit Factor, and RR.
"""

import pandas as pd
import numpy as np
from itertools import product

def optimize():
    print("Loading data for 5-Year optimization...")
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

    # Daily Bias
    daily = df5.groupby('date').agg(day_close=('close', 'last')).reset_index()
    daily['daily_ema20'] = daily['day_close'].ewm(span=20, adjust=False).mean().shift(1)
    daily['pdc'] = daily['day_close'].shift(1)
    daily['daily_bias'] = (daily['pdc'] > daily['daily_ema20']).astype(int) * 2 - 1

    # 1-Hour Indicators
    df1h['h1_ema20'] = df1h['close'].ewm(span=20, adjust=False).mean()
    df1h['h1_ema50'] = df1h['close'].ewm(span=50, adjust=False).mean()
    df1h['h1_trend_basic'] = (df1h['close'] > df1h['h1_ema20']).astype(int) * 2 - 1
    # Strict 1H trend: Close > EMA20 AND EMA20 > EMA50
    df1h['h1_trend_strict'] = 0
    df1h.loc[(df1h['close'] > df1h['h1_ema20']) & (df1h['h1_ema20'] >= df1h['h1_ema50']), 'h1_trend_strict'] = 1
    df1h.loc[(df1h['close'] < df1h['h1_ema20']) & (df1h['h1_ema20'] <= df1h['h1_ema50']), 'h1_trend_strict'] = -1
    
    df1h_ready = df1h[['timestamp', 'h1_trend_basic', 'h1_trend_strict']].copy()
    df1h_ready['avail_ts'] = df1h_ready['timestamp'] + pd.Timedelta(hours=1)

    # 15-Minute Trend
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15['m15_trend'] = (df15['close'] > df15['m15_ema20']).astype(int) * 2 - 1
    df15_ready = df15[['timestamp', 'm15_trend']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.Timedelta(minutes=15)

    df5 = df5.merge(daily[['date', 'daily_bias']], on='date', how='left')
    df5 = pd.merge_asof(df5, df1h_ready[['avail_ts', 'h1_trend_basic', 'h1_trend_strict']], left_on='timestamp', right_on='avail_ts', direction='backward')
    df5 = pd.merge_asof(df5, df15_ready[['avail_ts', 'm15_trend']], left_on='timestamp', right_on='avail_ts', direction='backward')

    # 5-minute Intraday VWAP & EMAs
    tp5 = (df5['high'] + df5['low'] + df5['close']) / 3.0
    pv5 = tp5 * df5['volume']
    cum_pv5 = pv5.groupby(df5['date']).cumsum()
    cum_vol5 = df5['volume'].groupby(df5['date']).cumsum()
    df5['vwap'] = np.where(cum_vol5 > 0, cum_pv5 / cum_vol5, tp5.groupby(df5['date']).transform(lambda x: x.expanding().mean()))
    
    df5['ema9'] = df5['close'].ewm(span=9, adjust=False).mean()

    # Opening Range 09:15 to 09:30
    or_df = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        or_high=('high', 'max'),
        or_low=('low', 'min')
    ).reset_index()
    or_df['or_range'] = or_df['or_high'] - or_df['or_low']
    df5 = df5.merge(or_df, on='date', how='left')

    # Pre-extract arrays for ultra-fast simulation
    n = len(df5)
    opens = df5['open'].values
    highs = df5['high'].values
    lows = df5['low'].values
    closes = df5['close'].values
    dates = df5['date'].values
    times = df5['time_str'].values
    date_strs = df5['date_str'].values
    or_highs = df5['or_high'].values
    or_lows = df5['or_low'].values
    or_ranges = df5['or_range'].values
    daily_biases = df5['daily_bias'].values
    h1_basics = df5['h1_trend_basic'].values
    h1_stricts = df5['h1_trend_strict'].values
    m15_trends = df5['m15_trend'].values
    vwaps = df5['vwap'].values
    ema9s = df5['ema9'].values

    # Test parameter grid
    grid = {
        'strict_1h': [False, True],
        'require_vwap': [False, True],
        'min_or_range': [30.0, 45.0],
        'sl_pts': [16.0, 18.0, 20.0],
        'target_pts': [45.0, 50.0, 55.0, 60.0],
        'use_be': [False, True],  # move to breakeven after +25 pts
        'morning_only': [False, True] # 09:35 - 11:15 only
    }

    results = []

    for strict_1h, req_vwap, min_or, sl, tgt, use_be, morning_only in product(
        grid['strict_1h'], grid['require_vwap'], grid['min_or_range'],
        grid['sl_pts'], grid['target_pts'], grid['use_be'], grid['morning_only']
    ):
        # Build signals
        trades = []
        trades_today = {}
        i = 0
        
        while i < n - 1:
            t = times[i]
            d = dates[i]
            
            # Session filter
            if morning_only:
                sess_ok = ('09:35' <= t <= '11:15')
            else:
                sess_ok = ('09:35' <= t <= '11:30') or ('13:00' <= t <= '14:15')
                
            if not sess_ok or or_ranges[i] < min_or or trades_today.get(d, 0) >= 1:
                i += 1
                continue
                
            h1 = h1_stricts[i] if strict_1h else h1_basics[i]
            d_bias = daily_biases[i]
            m15 = m15_trends[i]
            c = closes[i]
            o = opens[i]
            l = lows[i]
            h = highs[i]
            v = vwaps[i]
            e9 = ema9s[i]
            oh = or_highs[i]
            ol = or_lows[i]
            
            sig = None
            
            # Long retest:
            if h1 == 1 and d_bias == 1 and m15 == 1:
                if (not req_vwap or c > v) and (l <= oh + 8.0) and (c >= oh - 4.0) and (c > o) and (c > e9):
                    sig = 'LONG'
                    
            # Short retest:
            elif h1 == -1 and d_bias == -1 and m15 == -1:
                if (not req_vwap or c < v) and (h >= ol - 8.0) and (c <= ol + 4.0) and (c < o) and (c < e9):
                    sig = 'SHORT'
                    
            if sig in ('LONG', 'SHORT'):
                entry_idx = i + 1
                if entry_idx >= n or dates[entry_idx] != d:
                    i += 1
                    continue
                    
                entry_px = opens[entry_idx]
                stop_px = entry_px - sl if sig == 'LONG' else entry_px + sl
                target_px = entry_px + tgt if sig == 'LONG' else entry_px - tgt
                
                exit_px = None
                be_active = False
                exit_idx = None
                
                for j in range(entry_idx, min(n, entry_idx + 24)):
                    if dates[j] != d or times[j] >= '15:15':
                        exit_px = closes[j]; exit_idx = j; break
                        
                    bar_h = highs[j]
                    bar_l = lows[j]
                    
                    # Breakeven logic
                    if use_be and not be_active:
                        fav = (bar_h - entry_px) if sig == 'LONG' else (entry_px - bar_l)
                        if fav >= 25.0:
                            be_active = True
                            stop_px = entry_px + 2.0 if sig == 'LONG' else entry_px - 2.0
                            
                    if sig == 'LONG':
                        if bar_l <= stop_px: exit_px = stop_px; exit_idx = j; break
                        elif bar_h >= target_px: exit_px = target_px; exit_idx = j; break
                    else:
                        if bar_h >= stop_px: exit_px = stop_px; exit_idx = j; break
                        elif bar_l <= target_px: exit_px = target_px; exit_idx = j; break
                        
                if exit_px is None:
                    exit_idx = min(n - 1, entry_idx + 24)
                    exit_px = closes[exit_idx]
                    
                pnl = (exit_px - entry_px) if sig == 'LONG' else (entry_px - exit_px)
                trades.append(pnl)
                trades_today[d] = 1
                i = exit_idx
            else:
                i += 1
                
        if len(trades) < 60:
            continue
            
        trades = np.array(trades)
        wins = trades[trades > 0]
        losses = trades[trades <= 0]
        wr = len(wins) / len(trades) * 100
        avg_w = wins.mean() if len(wins) else 0.0
        avg_l = abs(losses.mean()) if len(losses) else 0.0
        rr = avg_w / avg_l if avg_l else 0.0
        net = trades.sum()
        gross_w = wins.sum() if len(wins) else 0.0
        gross_l = abs(losses.sum()) if len(losses) else 0.0
        pf = gross_w / gross_l if gross_l else 99.0
        
        results.append({
            'strict_1h': strict_1h,
            'req_vwap': req_vwap,
            'min_or': min_or,
            'sl': sl,
            'tgt': tgt,
            'use_be': use_be,
            'morning_only': morning_only,
            'trades': len(trades),
            'win_rate': wr,
            'avg_win': avg_w,
            'avg_loss': avg_l,
            'rr': rr,
            'net_pts': net,
            'pf': pf
        })

    res_df = pd.DataFrame(results)
    res_df.sort_values(by='pf', ascending=False, inplace=True)
    
    print("\nTOP 10 CONFIGURATIONS BY PROFIT FACTOR:")
    print("=" * 115)
    print(f"{'Rank':<4} | {'1H':<6} | {'VWAP':<5} | {'MinOR':<5} | {'SL':<4} | {'TGT':<4} | {'BE':<5} | {'Morn':<5} | {'Trades':<6} | {'Win%':<6} | {'AvgWin':<6} | {'AvgLoss':<7} | {'RR':<5} | {'NetPts':<8} | {'PF':<5}")
    print("-" * 115)
    for rank, (_, row) in enumerate(res_df.head(10).iterrows(), 1):
        s1h = "Strict" if row['strict_1h'] else "Basic"
        vw = "Yes" if row['req_vwap'] else "No"
        be = "Yes" if row['use_be'] else "No"
        mo = "Yes" if row['morning_only'] else "No"
        print(f"{rank:<4} | {s1h:<6} | {vw:<5} | {row['min_or']:<5.0f} | {row['sl']:<4.0f} | {row['tgt']:<4.0f} | {be:<5} | {mo:<5} | {row['trades']:<6} | {row['win_rate']:<5.1f}% | +{row['avg_win']:<5.1f} | -{row['avg_loss']:<6.1f} | 1:{row['rr']:<3.2f} | {row['net_pts']:<+7.1f} | {row['pf']:<4.2f}")

    # Also sort by Win Rate
    res_df_wr = res_df[res_df['trades'] >= 100].sort_values(by='win_rate', ascending=False)
    print("\nTOP 5 CONFIGURATIONS BY HIGHEST WIN RATE (>= 100 trades):")
    print("=" * 115)
    for rank, (_, row) in enumerate(res_df_wr.head(5).iterrows(), 1):
        s1h = "Strict" if row['strict_1h'] else "Basic"
        vw = "Yes" if row['req_vwap'] else "No"
        be = "Yes" if row['use_be'] else "No"
        mo = "Yes" if row['morning_only'] else "No"
        print(f"{rank:<4} | {s1h:<6} | {vw:<5} | {row['min_or']:<5.0f} | {row['sl']:<4.0f} | {row['tgt']:<4.0f} | {be:<5} | {mo:<5} | {row['trades']:<6} | {row['win_rate']:<5.1f}% | +{row['avg_win']:<5.1f} | -{row['avg_loss']:<6.1f} | 1:{row['rr']:<3.2f} | {row['net_pts']:<+7.1f} | {row['pf']:<4.2f}")

if __name__ == '__main__':
    optimize()
