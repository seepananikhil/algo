import pickle, pandas as pd, numpy as np

with open('scratch/universe_4y_prices.pkl', 'rb') as f:
    price_data = pickle.load(f)

dt_sim_start = pd.to_datetime('2022-01-01')

def test_leg1_filter(filter_name="baseline"):
    stock_bars = {}
    leg1_signals = []

    for s, df in price_data.items():
        if len(df) < 150 or s in ['^NSEI', 'NIFTY']: continue
        df = df.copy()
        if not isinstance(df.index, pd.DatetimeIndex): df.index = pd.to_datetime(df.index)
        df.index = df.index.tz_localize(None)
        df = df.sort_index()
        c = df['Close'].values; h = df['High'].values; l = df['Low'].values; o = df['Open'].values; v = df['Volume'].values
        dates = df.index; n = len(df)
        if n < 200: continue
        vol_sma50 = pd.Series(v).rolling(50, min_periods=20).mean().values
        vol_sma60 = pd.Series(v).rolling(60, min_periods=20).mean().values
        vr50 = np.where(vol_sma50 > 0, v / vol_sma50, 0.0)
        vr60 = np.where(vol_sma60 > 0, v / vol_sma60, 0.0)
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
        ema200 = pd.Series(c).ewm(span=200, adjust=False).mean().values
        max_1000 = pd.Series(h).rolling(1000, min_periods=100).max().values
        
        delta = pd.Series(c).diff().values
        gain = pd.Series(np.where(delta > 0, delta, 0)).rolling(14, min_periods=10).mean().values
        loss = pd.Series(np.where(delta < 0, -delta, 0)).rolling(14, min_periods=10).mean().values
        rs = np.where(loss > 0, gain / loss, 1.0)
        rsi = 100.0 - (100.0 / (1.0 + rs))
        rsi_prev = np.roll(rsi, 1)
        prev_c = np.roll(c, 1)
        pct_chg = np.where(prev_c > 0, (c - prev_c) / prev_c * 100.0, 0.0)
        base_c20 = pd.Series(c).shift(1).rolling(20, min_periods=10).max().values
        
        # 10-day vs 30-day low for base stabilization
        low_10 = pd.Series(l).shift(1).rolling(10, min_periods=5).min().values
        low_30 = pd.Series(l).shift(1).rolling(30, min_periods=10).min().values
        
        date_map = {d: i for i, d in enumerate(dates)}
        stock_bars[s] = {
            'dates': dates, 'date_map': date_map, 'c': c, 'h': h, 'l': l, 'o': o, 'v': v,
            'e20': ema20, 'e50': ema50, 'e200': ema200, 'vsma50': vol_sma50, 'vr50': vr50,
            'base_c20': base_c20, 'n': n
        }
        
        base_mask = (
            (c <= 0.40 * max_1000) & (c < ema200) & (c >= 20.0) & (c > o) &
            (pct_chg >= 5.0) & (v >= vol_sma60 * 1.5) & (rsi > 54) & (rsi <= 68) &
            (rsi_prev <= 60) & ((c - l) >= 0.65 * (h - l)) & (dates >= dt_sim_start)
        )
        
        if filter_name == "baseline":
            cond = base_mask
        elif filter_name == "c_above_ema20":
            # Must reclaim 20-day EMA
            cond = base_mask & (c >= ema20)
        elif filter_name == "higher_low_base":
            # Must not be making fresh multi-week lows (10-day low is holding above 30-day low)
            cond = base_mask & (c >= ema20 * 0.98) & (low_10 >= low_30 * 1.01)
        elif filter_name == "curl_or_reclaim":
            # Must either close above 20 EMA or be within 2% of 20 EMA with 20 EMA not crashing
            cond = base_mask & (c >= ema20 * 0.99)
            
        for idx in np.where(cond)[0]:
            leg1_signals.append({
                'symbol': s, 'date': dates[idx], 'price': c[idx], 'open_price': o[idx],
                'vol_mult': vr60[idx], 'score': vr60[idx] * (pct_chg[idx] / 10.0), 'leg': 1, 'type': 'TURNAROUND'
            })

    phoenix_first_dt = {}
    for sig in leg1_signals:
        s = sig['symbol']
        if s not in phoenix_first_dt or sig['date'] < phoenix_first_dt[s]:
            phoenix_first_dt[s] = sig['date']

    leg2_signals = []
    for s, first_leg1_dt in phoenix_first_dt.items():
        b = stock_bars[s]; c = b['c']; h = b['h']; l = b['l']; o = b['o']; dates = b['dates']
        n = b['n']; vr50 = b['vr50']; base_c20 = b['base_c20']
        e50 = b['e50']; e200 = b['e200']
        first_idx = b['date_map'][first_leg1_dt]
        last_trigger_idx = -999
        
        for i in range(first_idx + 15, n):
            if i <= last_trigger_idx + 20: continue
            cur_pct = (c[i] - c[i-1]) / c[i-1] * 100.0 if c[i-1] > 0 else 0.0
            is_breakout = (c[i] > base_c20[i]) and (vr50[i] >= 2.0) and (c[i] > o[i]) and (cur_pct >= 2.5)
            is_ma_pullback = (c[i] > e200[i]) and (abs(l[i] - e50[i]) / e50[i] <= 0.04 or abs(l[i] - e200[i]) / e200[i] <= 0.04) and (c[i] > o[i]) and (cur_pct >= 4.0) and (vr50[i] >= 1.5)
            
            if is_breakout or is_ma_pullback:
                if abs(c[i] - e200[i]) / e200[i] < 0.01 and c[i] < e200[i] * 1.005: continue
                d = dates[i]
                if d >= dt_sim_start:
                    leg2_signals.append({
                        'symbol': s, 'date': d, 'price': c[i], 'open_price': o[i], 'leg': 2,
                        'type': 'MA_PULLBACK' if is_ma_pullback and not is_breakout else 'BASE_BREAKOUT'
                    })
                    last_trigger_idx = i

    all_signals = leg1_signals + leg2_signals
    df_signals = pd.DataFrame(all_signals).sort_values(by=['date', 'leg'], ascending=[True, True])
    sig_by_date = {}
    for _, row in df_signals.iterrows(): sig_by_date.setdefault(row['date'], []).append(row.to_dict())

    all_market_dates = sorted(list(set(d for b in stock_bars.values() for d in b['dates'] if d >= dt_sim_start)))
    SLOT_SIZE = 25000.0
    positions = []; closed_trades = []

    for cur_dt in all_market_dates:
        surviving = []
        for pos in positions:
            s = pos['symbol']; b = stock_bars[s]
            i = b['date_map'].get(cur_dt)
            if i is None: surviving.append(pos); continue
            c = b['c'][i]; h = b['h'][i]; l = b['l'][i]; o = b['o'][i]; v = b['v'][i]
            e50 = b['e50'][i]; vsma50 = b['vsma50'][i]
            entry_p = pos['entry_price']; entry_o = pos.get('entry_open', entry_p)
            pos['days_held'] += 1
            if h > pos['highest_high']: pos['highest_high'] = h
            if c > pos['highest_close']: pos['highest_close'] = c
            
            cur_ret = (c - entry_p) / entry_p * 100.0
            high_ret = (pos['highest_close'] - entry_p) / entry_p * 100.0
            is_leg2 = pos.get('leg') == 2
            cur_sl_pct = -12.0 if is_leg2 else -25.0
            
            if high_ret >= 15.0: pos['be_shield_active'] = True
            exited = False; exit_p = None; exit_reason = None
            
            if is_leg2 and pos['days_held'] in [1, 2]:
                broke_e50 = (cur_ret < 0) and (c < e50) and (c < o)
                heavy_vol_dump = (cur_ret <= -3.5) and (c < o) and (vsma50 > 0 and v / vsma50 >= 1.3)
                deep_engulfing = (c < entry_o) and (cur_ret <= -5.0) and (c < o)
                if broke_e50 or heavy_vol_dump or deep_engulfing:
                    exited = True; exit_p = c; exit_reason = 'Early Shield'
            
            if not exited:
                if c <= pos['sl_price']:
                    exit_p = c; exit_reason = 'Initial SL'; exited = True
                elif pos['be_shield_active']:
                    trail_p = pos['highest_close'] * 0.75
                    if high_ret >= 20.0: trail_p = max(trail_p, entry_p)
                    if c < trail_p:
                        exit_p = c; exit_reason = 'Trail SL'; exited = True
                    elif c < e50 and vsma50 > 0 and (v / vsma50) >= 1.2 and cur_ret >= 10.0:
                        exit_p = c; exit_reason = 'Institutional 50 EMA Volume Breakdown'; exited = True
                        
            if exited:
                pnl_amt = pos['shares'] * (exit_p - entry_p)
                pnl_pct = (exit_p - entry_p) / entry_p * 100.0
                closed_trades.append({
                    'symbol': s, 'entry_date': str(pos['entry_date'])[:10], 'exit_date': str(cur_dt)[:10],
                    'pnl': round(pnl_amt, 2), 'pnl_pct': round(pnl_pct, 2), 'reason': exit_reason
                })
            else:
                surviving.append(pos)
        positions = surviving
        
        daily_sigs = sig_by_date.get(cur_dt, [])
        if daily_sigs:
            held = set(p['symbol'] for p in positions)
            for sig in daily_sigs:
                s = sig['symbol']
                if s in held: continue
                p = sig['price']
                if p <= 0: continue
                shs = int(SLOT_SIZE / p)
                if shs < 1: continue
                is_l2 = sig['leg'] == 2
                sl_price = p * (0.88 if is_l2 else 0.75)
                positions.append({
                    'symbol': s, 'leg': sig['leg'], 'entry_date': cur_dt, 'entry_price': p,
                    'entry_open': sig.get('open_price', p), 'shares': shs, 'sl_price': sl_price,
                    'be_shield_active': False, 'highest_high': p, 'highest_close': p, 'days_held': 0
                })
                held.add(s)

    pnl_tot = sum(t['pnl'] for t in closed_trades)
    wins = [t for t in closed_trades if t['pnl'] > 0]
    losses = [t for t in closed_trades if t['pnl'] <= 0]
    wr = len(wins) / len(closed_trades) * 100.0 if closed_trades else 0
    gp = sum(t['pnl'] for t in wins); gl = abs(sum(t['pnl'] for t in losses))
    pf = round(gp / gl, 2) if gl > 0 else 99.0
    
    ag_trades = [t for t in closed_trades if t['symbol'] == 'ADANIGREEN']
    return len(closed_trades), wr, pnl_tot, pf, ag_trades

for name in ["baseline", "c_above_ema20", "higher_low_base", "curl_or_reclaim"]:
    n, wr, pnl, pf, ag = test_leg1_filter(name)
    print(f"\nFilter: {name}")
    print(f"  Trades: {n}, WR: {wr:.1f}%, Net PnL: Rs.{pnl:,.2f}, PF: {pf}")
    print(f"  ADANIGREEN trades ({len(ag)}):")
    for t in ag:
        print(f"    {t['entry_date']} -> {t['exit_date']} | Rs.{t['pnl']} ({t['pnl_pct']}%)")
