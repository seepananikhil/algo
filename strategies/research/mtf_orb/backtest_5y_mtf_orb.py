#!/usr/bin/env python3
"""
Official 5-Year Backtest:
NIFTY MULTI-TIMEFRAME 15M ORB-RETEST & 1-HOUR TREND STRATEGY
October 2021 to October 2026 (5 Full Years)
"""

import pandas as pd
import numpy as np

def run_official_5y_backtest():
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

    # 1. Daily Bias
    daily = df5.groupby('date').agg(day_close=('close', 'last')).reset_index()
    daily['daily_ema20'] = daily['day_close'].ewm(span=20, adjust=False).mean().shift(1)
    daily['pdc'] = daily['day_close'].shift(1)
    daily['daily_bias'] = (daily['pdc'] > daily['daily_ema20']).astype(int) * 2 - 1

    # 2. 1-Hour Trend
    df1h['h1_ema20'] = df1h['close'].ewm(span=20, adjust=False).mean()
    df1h['h1_trend'] = (df1h['close'] > df1h['h1_ema20']).astype(int) * 2 - 1
    df1h_ready = df1h[['timestamp', 'h1_trend']].copy()
    df1h_ready['avail_ts'] = df1h_ready['timestamp'] + pd.Timedelta(hours=1)

    # 3. 15-Minute Trend
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15['m15_trend'] = (df15['close'] > df15['m15_ema20']).astype(int) * 2 - 1
    df15_ready = df15[['timestamp', 'm15_trend']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.Timedelta(minutes=15)

    df5 = df5.merge(daily[['date', 'daily_bias']], on='date', how='left')
    df5 = pd.merge_asof(df5, df1h_ready[['avail_ts', 'h1_trend']], left_on='timestamp', right_on='avail_ts', direction='backward')
    df5 = pd.merge_asof(df5, df15_ready[['avail_ts', 'm15_trend']], left_on='timestamp', right_on='avail_ts', direction='backward')

    # 4. 5-Minute EMA 9
    df5['ema9'] = df5['close'].ewm(span=9, adjust=False).mean()

    # 5. 15-Minute Opening Range (09:15 - 09:30)
    or_df = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        or_high=('high', 'max'),
        or_low=('low', 'min')
    ).reset_index()
    df5 = df5.merge(or_df, on='date', how='left')

    # Active Execution Windows (09:40-11:30 & 13:00-14:15)
    session_active = (
        ((df5['time_str'] >= '09:40') & (df5['time_str'] <= '11:30')) |
        ((df5['time_str'] >= '13:00') & (df5['time_str'] <= '14:15'))
    )

    # Retest Rules:
    # Long: Pullback to OR High (low <= or_high + 8), closes above level, green candle, close > 5m EMA9
    retest_long = (df5['low'] <= df5['or_high'] + 8.0) & (df5['close'] >= df5['or_high'] - 4.0) & (df5['close'] > df5['open']) & (df5['close'] > df5['ema9'])
    long_sig = session_active & (df5['h1_trend'] == 1) & (df5['daily_bias'] == 1) & (df5['m15_trend'] == 1) & retest_long

    # Short: Pullback to OR Low (high >= or_low - 8), closes below level, red candle, close < 5m EMA9
    retest_short = (df5['high'] >= df5['or_low'] - 8.0) & (df5['close'] <= df5['or_low'] + 4.0) & (df5['close'] < df5['open']) & (df5['close'] < df5['ema9'])
    short_sig = session_active & (df5['h1_trend'] == -1) & (df5['daily_bias'] == -1) & (df5['m15_trend'] == -1) & retest_short

    df5['sig'] = None
    df5.loc[long_sig, 'sig'] = 'LONG'
    df5.loc[short_sig, 'sig'] = 'SHORT'

    n = len(df5)
    opens = df5['open'].values
    highs = df5['high'].values
    lows = df5['low'].values
    closes = df5['close'].values
    sigs = df5['sig'].values
    dates = df5['date'].values
    times = df5['time_str'].values
    date_strs = df5['date_str'].values

    sl_pts = 22.0
    tgt_pts = 55.0

    trades = []
    trades_today = {}
    i = 0
    while i < n - 1:
        sig = sigs[i]
        d = dates[i]
        if sig in ('LONG', 'SHORT'):
            if trades_today.get(d, 0) >= 1:
                i += 1
                continue
            entry_idx = i + 1
            if entry_idx >= n or dates[entry_idx] != d:
                i += 1
                continue
            entry_px = opens[entry_idx]
            sl = entry_px - sl_pts if sig == 'LONG' else entry_px + sl_pts
            tgt = entry_px + tgt_pts if sig == 'LONG' else entry_px - tgt_pts
            
            exit_px = None
            exit_reason = None
            exit_time = None
            exit_idx = None
            
            for j in range(entry_idx, min(n, entry_idx + 24)):
                if dates[j] != d or times[j] >= '15:15':
                    exit_px = closes[j]; exit_reason = 'EOD'; exit_time = times[j]; exit_idx = j; break
                h, l = highs[j], lows[j]
                
                if sig == 'LONG':
                    if l <= sl: exit_px = sl; exit_reason = 'SL'; exit_time = times[j]; exit_idx = j; break
                    elif h >= tgt: exit_px = tgt; exit_reason = 'TARGET'; exit_time = times[j]; exit_idx = j; break
                else:
                    if h >= sl: exit_px = sl; exit_reason = 'SL'; exit_time = times[j]; exit_idx = j; break
                    elif l <= tgt: exit_px = tgt; exit_reason = 'TARGET'; exit_time = times[j]; exit_idx = j; break
                    
            if exit_px is None:
                exit_idx = min(n - 1, entry_idx + 24)
                exit_px = closes[exit_idx]
                exit_reason = 'TIMEOUT'
                exit_time = times[exit_idx]
                
            pnl = (exit_px - entry_px) if sig == 'LONG' else (entry_px - exit_px)
            trades.append({
                'date': date_strs[i],
                'entry_time': times[entry_idx],
                'side': 'CALL' if sig == 'LONG' else 'PUT',
                'entry_spot': round(entry_px, 2),
                'sl_spot': round(sl, 2),
                'target_spot': round(tgt, 2),
                'exit_time': exit_time,
                'exit_spot': round(exit_px, 2),
                'pnl_points': round(pnl, 2),
                'rr': round(pnl / sl_pts, 2),
                'reason': exit_reason
            })
            trades_today[d] = 1
            i = exit_idx
        else:
            i += 1

    tdf = pd.DataFrame(trades)
    tdf.to_csv('performance/mtf_orb_5y_trades.csv', index=False)
    
    wins = tdf[tdf['pnl_points'] > 0]
    losses = tdf[tdf['pnl_points'] <= 0]
    wr = len(wins)/len(tdf)*100
    aw = wins['pnl_points'].mean()
    al = abs(losses['pnl_points'].mean())
    rr = aw / al
    net = tdf['pnl_points'].sum()
    pf = wins['pnl_points'].sum() / abs(losses['pnl_points'].sum())
    
    # Calculate Max Drawdown
    tdf['cum_pnl'] = tdf['pnl_points'].cumsum()
    peak = tdf['cum_pnl'].cummax()
    dd = tdf['cum_pnl'] - peak
    max_dd = dd.min()

    print("================================================================================")
    print("      5-YEAR NIFTY MULTI-TIMEFRAME ORB-RETEST & 1-HOUR TREND BACKTEST           ")
    print("================================================================================")
    print(f"Total Trades:           {len(tdf)}")
    print(f"Winning Trades:         {len(wins)} ({wr:.1f}%)")
    print(f"Losing Trades:          {len(losses)} ({100-wr:.1f}%)")
    print(f"Average Win:            +{aw:.2f} pts")
    print(f"Average Loss:           -{al:.2f} pts")
    print(f"Realized RR:            1 : {rr:.2f}")
    print(f"Total Net Points:       {net:+.2f} pts")
    print(f"Profit Factor:          {pf:.2f}")
    print(f"Max Drawdown:           {max_dd:.2f} pts")
    print(f"Total P&L 1 Lot (25Q):  Rs {net * 25:,.0f}")
    print(f"Total P&L 2 Lots (50Q): Rs {net * 50:,.0f}")
    print(f"Total P&L 4 Lots (100Q):Rs {net * 100:,.0f}")
    print("================================================================================")
    
    tdf['year'] = pd.to_datetime(tdf['date']).dt.year
    print("\nYEAR-BY-YEAR DETAILED SUMMARY:")
    print(f"{'Year':<6} | {'Trades':<6} | {'Win Rate':<8} | {'Avg Win':<8} | {'Avg Loss':<8} | {'RR':<5} | {'Net Pts':<10} | {'Profit Factor':<6}")
    print("-" * 75)
    for yr, grp in tdf.groupby('year'):
        w = grp[grp['pnl_points'] > 0]
        l = grp[grp['pnl_points'] <= 0]
        y_wr = len(w)/len(grp)*100
        y_aw = w['pnl_points'].mean() if len(w) else 0
        y_al = abs(l['pnl_points'].mean()) if len(l) else 0
        y_rr = y_aw / y_al if y_al else 0
        y_net = grp['pnl_points'].sum()
        y_pf = w['pnl_points'].sum() / abs(l['pnl_points'].sum()) if len(l) and l['pnl_points'].sum() != 0 else 99
        print(f"{yr:<6} | {len(grp):<6} | {y_wr:<7.1f}% | +{y_aw:<7.1f} | -{y_al:<7.1f} | 1:{y_rr:<3.2f} | {y_net:<+9.1f} | {y_pf:<5.2f}")

if __name__ == '__main__':
    run_official_5y_backtest()
