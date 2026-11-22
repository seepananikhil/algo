#!/usr/bin/env python3
"""
NIFTY TREND RUNNER WITH INDIA VIX CONFLUENCE
Tests the impact of India VIX on:
1. Win Rate
2. Profit Factor
3. Capturing 100+ point trend days vs filtering out fake breakouts
"""

import pandas as pd
import numpy as np

def run_vix_analysis():
    print("Loading Nifty and India VIX data...")
    df5 = pd.read_csv('captured_data/fyers/nifty_5min.csv')
    df15 = pd.read_csv('captured_data/fyers/nifty_15min.csv')
    df1h = pd.read_csv('captured_data/fyers/nifty_1hr.csv')
    vix = pd.read_csv('captured_data/fyers/india_vix_daily.csv')

    for d in [df5, df15, df1h]:
        d['timestamp'] = pd.to_datetime(d['timestamp'])
        d.sort_values('timestamp', inplace=True)
        d.reset_index(drop=True, inplace=True)
        d['date'] = d['timestamp'].dt.date
        d['date_str'] = d['timestamp'].dt.strftime('%Y-%m-%d')
        d['time_str'] = d['timestamp'].dt.strftime('%H:%M')

    vix['date_str'] = vix['date'].astype(str)
    # Previous day VIX close and VIX change
    vix['prev_vix_close'] = vix['close'].shift(1)
    vix['vix_pct_change'] = vix['vix_change_pct'].fillna(0.0)
    # VIX 10-day SMA
    vix['vix_sma10'] = vix['close'].rolling(10).mean().shift(1)
    vix['vix_regime'] = np.where(vix['prev_vix_close'] > vix['vix_sma10'], 'HIGH_VOL', 'LOW_VOL')

    # 1. 1-Hour Trend
    df1h['h1_ema20'] = df1h['close'].ewm(span=20, adjust=False).mean()
    df1h['h1_trend'] = np.where(df1h['close'] > df1h['h1_ema20'], 1, -1)
    df1h_ready = df1h[['timestamp', 'h1_trend']].copy()
    df1h_ready['avail_ts'] = df1h_ready['timestamp'] + pd.Timedelta(hours=1)

    # 2. 15-Minute EMA20 for Trailing
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15_ready = df15[['timestamp', 'm15_ema20']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.Timedelta(minutes=15)

    df5 = pd.merge_asof(df5, df1h_ready[['avail_ts', 'h1_trend']], left_on='timestamp', right_on='avail_ts', direction='backward')
    df5 = pd.merge_asof(df5, df15_ready[['avail_ts', 'm15_ema20']], left_on='timestamp', right_on='avail_ts', direction='backward')
    df5['h1_trend'] = df5['h1_trend'].bfill().ffill()

    # 3. 5-min VWAP
    tp5 = (df5['high'] + df5['low'] + df5['close']) / 3.0
    pv5 = tp5 * df5['volume']
    cum_pv5 = pv5.groupby(df5['date']).cumsum()
    cum_vol5 = df5['volume'].groupby(df5['date']).cumsum()
    df5['vwap'] = np.where(cum_vol5 > 0, cum_pv5 / cum_vol5, tp5.groupby(df5['date']).transform(lambda x: x.expanding().mean()))

    # 4. 15-Minute Opening Range (09:15 to 09:30)
    or15 = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        or_high=('high', 'max'),
        or_low=('low', 'min')
    ).reset_index()
    or15['or_range'] = or15['or_high'] - or15['or_low']
    df5 = df5.merge(or15, on='date', how='left')

    # Merge VIX onto df5
    df5 = df5.merge(
        vix[['date_str', 'open', 'close', 'vix_pct_change', 'prev_vix_close', 'vix_regime']],
        on='date_str',
        how='inner',
        suffixes=('', '_vix')
    )

    print(f"Total Nifty-VIX overlapping trading days: {df5['date_str'].nunique()} days (Oct 2023 - Oct 2026)")

    # Base signals: 15-min Breakout with VWAP
    time_window = (df5['time_str'] >= '09:30') & (df5['time_str'] <= '10:30') & (df5['or_range'] >= 30.0)
    raw_long = time_window & (df5['close'] > df5['or_high']) & (df5['close'] > df5['open']) & (df5['close'] > df5['vwap'])
    raw_short = time_window & (df5['close'] < df5['or_low']) & (df5['close'] < df5['open']) & (df5['close'] < df5['vwap'])

    # Test 3 Variations:
    # Var A: Raw (No VIX filter)
    # Var B: VIX Trend Alignment:
    #        - For CALL/LONG: VIX is NOT surging (vix_pct_change <= +2.0%)
    #        - For PUT/SHORT: VIX is NOT crashing (vix_pct_change >= -2.0%)
    # Var C: Strong VIX Expansion Confluence:
    #        - For PUT/SHORT: VIX is Rising (vix_pct_change > 0) -> Fear is rising, huge dump!
    #        - For CALL/LONG: VIX is Falling (vix_pct_change < 0) -> Volatility cooling, strong rally!

    # Var A
    df5['sig_raw'] = None
    df5.loc[raw_long, 'sig_raw'] = 'LONG'
    df5.loc[raw_short, 'sig_raw'] = 'SHORT'

    # Var B (Filter toxic counter-volatility traps)
    df5['sig_vix_filter'] = None
    long_vix_b = raw_long & (df5['vix_pct_change'] <= 2.5)
    short_vix_b = raw_short & (df5['vix_pct_change'] >= -2.5)
    df5.loc[long_vix_b, 'sig_vix_filter'] = 'LONG'
    df5.loc[short_vix_b, 'sig_vix_filter'] = 'SHORT'

    # Var C (Pure VIX Directional Confluence)
    df5['sig_vix_confluence'] = None
    long_vix_c = raw_long & (df5['vix_pct_change'] < 0.0)
    short_vix_c = raw_short & (df5['vix_pct_change'] > 0.0)
    df5.loc[long_vix_c, 'sig_vix_confluence'] = 'LONG'
    df5.loc[short_vix_c, 'sig_vix_confluence'] = 'SHORT'

    for name, col in [
        ("1. Baseline (No VIX Filter)", 'sig_raw'),
        ("2. VIX Safety Filter (Avoids Surging VIX on Calls / Crashing VIX on Puts)", 'sig_vix_filter'),
        ("3. Strong VIX Directional Confluence (Calls when VIX Drops / Puts when VIX Spikes)", 'sig_vix_confluence')
    ]:
        eval_vix_strategy(df5, col, name)

def eval_vix_strategy(df5, sig_col, label):
    n = len(df5)
    opens = df5['open'].values
    highs = df5['high'].values
    lows = df5['low'].values
    closes = df5['close'].values
    sigs = df5[sig_col].values
    dates = df5['date'].values
    times = df5['time_str'].values
    date_strs = df5['date_str'].values
    m15_ema20s = df5['m15_ema20'].values
    vix_changes = df5['vix_pct_change'].values

    sl_pts = 28.0
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

                if sig == 'LONG':
                    if l <= sl:
                        exit_px = sl; exit_reason = 'SL'; exit_time = times[j]; i = j; break
                    elif max_fav >= 50.0 and c < ema_trail:
                        exit_px = c; exit_reason = 'TRAIL_15M'; exit_time = times[j]; i = j; break
                else:
                    if h >= sl:
                        exit_px = sl; exit_reason = 'SL'; exit_time = times[j]; i = j; break
                    elif max_fav >= 50.0 and c > ema_trail:
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
                'vix_chg': round(vix_changes[entry_idx], 2),
                'reason': exit_reason
            })
            trades_today[d] = 1
        else:
            i += 1

    tdf = pd.DataFrame(trades)
    if tdf.empty: return

    wins = tdf[tdf['pnl_points'] > 0]
    losses = tdf[tdf['pnl_points'] <= 0]
    wr = len(wins) / len(tdf) * 100
    aw = wins['pnl_points'].mean() if len(wins) else 0
    al = abs(losses['pnl_points'].mean()) if len(losses) else 0
    rr = aw / al if al else 0
    net = tdf['pnl_points'].sum()
    pf = wins['pnl_points'].sum() / abs(losses['pnl_points'].sum()) if len(losses) and losses['pnl_points'].sum() != 0 else 99
    big_100 = (tdf['pnl_points'] >= 100.0).sum()
    big_200 = (tdf['pnl_points'] >= 200.0).sum()

    print("\n" + "=" * 95)
    print(f"  {label.upper()}")
    print("=" * 95)
    print(f"Total Trades:           {len(tdf)}")
    print(f"Win Rate:               {wr:.1f}% ({len(wins)} wins / {len(losses)} losses)")
    print(f"Average Win:            +{aw:.2f} points (MASSIVE RUNS!)")
    print(f"Average Loss:           -{al:.2f} points (Strict 28 pt SL)")
    print(f"Realized RR:            1 : {rr:.2f}")
    print(f"Total Net Points:       {net:+.2f} points")
    print(f"Profit Factor:          {pf:.2f}")
    print(f"Trades >= 100+ Points:  {big_100} trades")
    print(f"Trades >= 200+ Points:  {big_200} trades")

    tdf['year'] = pd.to_datetime(tdf['date']).dt.year
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
        print(f"  Year {yr} | Trades: {len(grp):<3} | Win%: {y_wr:5.1f}% | AvgWin: +{y_aw:5.1f} | AvgLoss: -{y_al:4.1f} | RR: 1:{y_rr:4.2f} | 100+Pts: {y_100:<2} | Net: {y_net:+8.1f} | PF: {y_pf:4.2f}")

if __name__ == '__main__':
    run_vix_analysis()
