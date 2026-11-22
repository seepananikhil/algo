import pandas as pd
import numpy as np

def run_vix_level_vs_change_test():
    print("Loading data for VIX Level vs VIX Change comparison...")
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
    # Today's open VIX or previous day's close VIX (known at 09:15 AM)
    vix['prev_vix_close'] = vix['close'].shift(1)
    vix['vix_pct_change'] = vix['vix_change_pct'].fillna(0.0)

    # 15-Minute EMA20 for Trailing
    df15['m15_ema20'] = df15['close'].ewm(span=20, adjust=False).mean()
    df15_ready = df15[['timestamp', 'm15_ema20']].copy()
    df15_ready['avail_ts'] = df15_ready['timestamp'] + pd.to_timedelta(15, unit='m')
    df5 = pd.merge_asof(df5, df15_ready[['avail_ts', 'm15_ema20']], left_on='timestamp', right_on='avail_ts', direction='backward')

    # VWAP
    tp5 = (df5['high'] + df5['low'] + df5['close']) / 3.0
    pv5 = tp5 * df5['volume']
    cum_pv5 = pv5.groupby(df5['date']).cumsum()
    cum_vol5 = df5['volume'].groupby(df5['date']).cumsum()
    df5['vwap'] = np.where(cum_vol5 > 0, cum_pv5 / cum_vol5, tp5.groupby(df5['date']).transform(lambda x: x.expanding().mean()))

    # 15m Opening Range (09:15 to 09:30)
    or15 = df5[(df5['time_str'] >= '09:15') & (df5['time_str'] <= '09:30')].groupby('date').agg(
        or_high=('high', 'max'),
        or_low=('low', 'min')
    ).reset_index()
    or15['or_range'] = or15['or_high'] - or15['or_low']
    df5 = df5.merge(or15, on='date', how='left')

    # Merge VIX
    df5 = df5.merge(
        vix[['date_str', 'open', 'close', 'vix_pct_change', 'prev_vix_close']],
        on='date_str',
        how='inner',
        suffixes=('', '_vix')
    )

    # Base signals: 09:30 - 10:30 breakout with range >= 30
    time_window = (df5['time_str'] >= '09:30') & (df5['time_str'] <= '10:30') & (df5['or_range'] >= 30.0)
    base_long = time_window & (df5['close'] > df5['or_high']) & (df5['close'] > df5['open']) & (df5['close'] > df5['vwap'])
    base_short = time_window & (df5['close'] < df5['or_low']) & (df5['close'] < df5['open']) & (df5['close'] < df5['vwap'])

    def evaluate_filter(condition_long, condition_short, filter_name):
        df5['sig'] = None
        df5.loc[condition_long, 'sig'] = 'LONG'
        df5.loc[condition_short, 'sig'] = 'SHORT'

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

        sl_pts = 28.0
        trades = []
        trades_today = {}
        i = 0

        while i < n - 1:
            sig = sigs[i]
            d = dates[i]
            if sig in ('LONG', 'SHORT'):
                if trades_today.get(d, 0) >= 1:
                    i += 1; continue
                entry_idx = i + 1
                if entry_idx >= n or dates[entry_idx] != d:
                    i += 1; continue

                entry_px = opens[entry_idx]
                entry_time = times[entry_idx]
                sl = entry_px - sl_pts if sig == 'LONG' else entry_px + sl_pts
                exit_px = None; exit_reason = None; max_fav = 0.0

                for j in range(entry_idx, n):
                    if dates[j] != d or times[j] >= '15:15':
                        exit_px = closes[j]; exit_reason = 'EOD_RUNNER'; i = j; break
                    h, l, c = highs[j], lows[j], closes[j]
                    ema_trail = m15_ema20s[j]
                    fav = (h - entry_px) if sig == 'LONG' else (entry_px - l)
                    if fav > max_fav: max_fav = fav

                    if sig == 'LONG':
                        if l <= sl:
                            exit_px = sl; exit_reason = 'SL'; i = j; break
                        elif max_fav >= 50.0 and c < ema_trail:
                            exit_px = c; exit_reason = 'TRAIL_15M'; i = j; break
                    else:
                        if h >= sl:
                            exit_px = sl; exit_reason = 'SL'; i = j; break
                        elif max_fav >= 50.0 and c > ema_trail:
                            exit_px = c; exit_reason = 'TRAIL_15M'; i = j; break

                pnl = (exit_px - entry_px) if sig == 'LONG' else (entry_px - exit_px)
                trades.append({
                    'pnl': round(pnl, 2),
                    'max_fav': round(max_fav, 2),
                    'reason': exit_reason
                })
                trades_today[d] = 1
            else:
                i += 1

        tdf = pd.DataFrame(trades)
        if tdf.empty:
            return {'Name': filter_name, 'Trades': 0, 'Win%': 0, 'Net': 0, 'PF': 0, 'AvgWin': 0, 'AvgLoss': 0, 'RR': 0, '100+': 0}

        w = tdf[tdf['pnl'] > 0]
        l = tdf[tdf['pnl'] <= 0]
        wr = len(w) / len(tdf) * 100
        aw = w['pnl'].mean() if len(w) else 0
        al = abs(l['pnl'].mean()) if len(l) else 0
        rr = aw / al if al else 0
        net = tdf['pnl'].sum()
        pf = w['pnl'].sum() / abs(l['pnl'].sum()) if len(l) and l['pnl'].sum() != 0 else 99
        b100 = (tdf['pnl'] >= 100.0).sum()

        return {
            'Name': filter_name,
            'Trades': len(tdf),
            'Win%': round(wr, 1),
            'Net Points': round(net, 1),
            'PF': round(pf, 2),
            'Avg Win': round(aw, 1),
            'Avg Loss': round(al, 1),
            'RR': f"1:{rr:.2f}",
            '100+ Pts': b100
        }

    results = []

    # 1. Baseline: No VIX
    results.append(evaluate_filter(base_long, base_short, "1. Baseline (No VIX)"))

    # 2. Absolute Level Tests:
    # A. VIX < 13 (Low Volatility)
    results.append(evaluate_filter(base_long & (df5['close_vix'] < 13.0), base_short & (df5['close_vix'] < 13.0), "2A. Absolute VIX < 13 (Low Vol)"))
    # B. VIX >= 13 (Medium to High Vol)
    results.append(evaluate_filter(base_long & (df5['close_vix'] >= 13.0), base_short & (df5['close_vix'] >= 13.0), "2B. Absolute VIX >= 13"))
    # C. VIX >= 14
    results.append(evaluate_filter(base_long & (df5['close_vix'] >= 14.0), base_short & (df5['close_vix'] >= 14.0), "2C. Absolute VIX >= 14"))
    # D. VIX >= 15
    results.append(evaluate_filter(base_long & (df5['close_vix'] >= 15.0), base_short & (df5['close_vix'] >= 15.0), "2D. Absolute VIX >= 15"))

    # 3. Relative VIX Directional Change Tests:
    # A. VIX % Change alone (Calls if VIX < 0, Puts if VIX > 0)
    cond_long_chg = base_long & (df5['vix_pct_change'] < 0.0)
    cond_short_chg = base_short & (df5['vix_pct_change'] > 0.0)
    results.append(evaluate_filter(cond_long_chg, cond_short_chg, "3A. VIX % Change Direction (Calls: dVIX<0, Puts: dVIX>0)"))

    # 4. Combination Tests: Absolute Level + Relative Direction
    # A. VIX >= 13 AND VIX Directional Change
    results.append(evaluate_filter(
        cond_long_chg & (df5['close_vix'] >= 13.0),
        cond_short_chg & (df5['close_vix'] >= 13.0),
        "4A. VIX >= 13 AND VIX Directional Change"
    ))
    # B. VIX >= 12 AND VIX Directional Change
    results.append(evaluate_filter(
        cond_long_chg & (df5['close_vix'] >= 12.0),
        cond_short_chg & (df5['close_vix'] >= 12.0),
        "4B. VIX >= 12 AND VIX Directional Change"
    ))

    # Also test CALL vs PUT under Low VIX vs High VIX
    # What happens to CALLs when VIX < 13?
    # What happens to PUTs when VIX < 13?
    results.append(evaluate_filter(base_long & (df5['close_vix'] < 13.0), pd.Series([False]*len(df5)), "5A. CALLs ONLY when VIX < 13"))
    results.append(evaluate_filter(pd.Series([False]*len(df5)), base_short & (df5['close_vix'] < 13.0), "5B. PUTs ONLY when VIX < 13"))
    results.append(evaluate_filter(base_long & (df5['close_vix'] >= 14.0), pd.Series([False]*len(df5)), "5C. CALLs ONLY when VIX >= 14"))
    results.append(evaluate_filter(pd.Series([False]*len(df5)), base_short & (df5['close_vix'] >= 14.0), "5D. PUTs ONLY when VIX >= 14"))

    res_df = pd.DataFrame(results)
    print("\n" + "="*110)
    print("VIX ABSOLUTE LEVEL VS RELATIVE CHANGE COMPARISON TABLE")
    print("="*110)
    print(res_df.to_string(index=False))

if __name__ == '__main__':
    run_vix_level_vs_change_test()
