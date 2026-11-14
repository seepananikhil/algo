import pickle
import pandas as pd
import numpy as np
import json
from datetime import datetime

def pure_xirr(cash_flows):
    t0 = cash_flows[0][0]
    def npv(r):
        return sum(cf / ((1.0 + r) ** ((dt - t0).days / 365.25)) for dt, cf in cash_flows)
    
    low, high = -0.5, 5.0
    for _ in range(100):
        mid = (low + high) / 2.0
        val = npv(mid)
        if abs(val) < 1e-4:
            return mid * 100.0
        if val > 0:
            low = mid
        else:
            high = mid
    return mid * 100.0

with open('scratch/universe_4y_prices.pkl', 'rb') as f:
    price_data = pickle.load(f)

dt_sim_start = pd.to_datetime('2022-01-01')

leg1_signals = []
stock_bars = {}

for s, df in price_data.items():
    if len(df) < 150 or s in ['^NSEI', 'NIFTY']:
        continue
    df = df.copy()
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
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
    ret_3d = np.zeros(n)
    ret_3d[3:] = (c[3:] - c[:-3]) / c[:-3] * 100.0
    
    # 20-day base ceiling
    base_c20 = pd.Series(c).shift(1).rolling(20, min_periods=10).max().values
    
    stock_bars[s] = {
        'dates': dates, 'date_map': {d: i for i, d in enumerate(dates)},
        'c': c, 'h': h, 'l': l, 'o': o, 'v': v,
        'e50': ema50, 'e200': ema200, 'vsma50': vol_sma50, 'vr50': vr50,
        'ret_3d': ret_3d, 'base_c20': base_c20, 'n': n
    }
    
    leg1_mask = (
        (c <= 0.40 * max_1000) &
        (c < ema200) &
        (c >= ema20) &
        (c >= 20.0) &
        (c > o) &
        (pct_chg >= 5.0) &
        (v >= vol_sma60 * 1.5) &
        (rsi > 54) & (rsi <= 68) &
        (rsi_prev <= 60) &
        ((c - l) >= 0.65 * (h - l)) &
        (dates >= dt_sim_start)
    )
    for idx in np.where(leg1_mask)[0]:
        leg1_signals.append({
            'symbol': s,
            'date': dates[idx],
            'price': c[idx],
            'open_price': o[idx],
            'vol_mult': vr60[idx],
            'score': vr60[idx] * (pct_chg[idx] / 10.0),
            'leg': 1,
            'type': 'TURNAROUND'
        })

phoenix_first_dt = {}
for sig in leg1_signals:
    s = sig['symbol']
    if s not in phoenix_first_dt or sig['date'] < phoenix_first_dt[s]:
        phoenix_first_dt[s] = sig['date']

leg2_signals = []
for s, first_leg1_dt in phoenix_first_dt.items():
    b = stock_bars[s]
    c = b['c']; h = b['h']; l = b['l']; o = b['o']; dates = b['dates']
    n = b['n']; vr50 = b['vr50']; base_c20 = b['base_c20']
    e50 = b['e50']; e200 = b['e200']
    first_idx = b['date_map'][first_leg1_dt]
    last_trigger_idx = -999
    
    for i in range(first_idx + 15, n):
        if i <= last_trigger_idx + 20:
            continue
            
        cur_pct = (c[i] - c[i-1]) / c[i-1] * 100.0 if c[i-1] > 0 else 0.0
        
        # 1. Base Breakout
        is_breakout = (c[i] > base_c20[i]) and (vr50[i] >= 2.0) and (c[i] > o[i]) and (cur_pct >= 2.5)
        # 2. Stage-2 50 EMA Pullback Bounce
        is_ma_pullback = (c[i] > e200[i]) and (abs(l[i] - e50[i]) / e50[i] <= 0.04 or abs(l[i] - e200[i]) / e200[i] <= 0.04) and (c[i] > o[i]) and (cur_pct >= 4.0) and (vr50[i] >= 1.5)
        
        if is_breakout or is_ma_pullback:
            # Overhead Resistance Check: Avoid breakout candles colliding directly into the 200 EMA wall
            if abs(c[i] - e200[i]) / e200[i] < 0.01 and c[i] < e200[i] * 1.005:
                continue
            d = dates[i]
            if d >= dt_sim_start:
                leg2_signals.append({
                    'symbol': s,
                    'date': d,
                    'price': c[i],
                    'open_price': o[i],
                    'vol_mult': vr50[i],
                    'score': vr50[i] * 1.5,
                    'leg': 2,
                    'type': 'MA_PULLBACK' if is_ma_pullback and not is_breakout else 'BASE_BREAKOUT'
                })
                last_trigger_idx = i

all_signals = leg1_signals + leg2_signals
df_signals = pd.DataFrame(all_signals).sort_values(by=['date', 'leg', 'score'], ascending=[True, True, False])

sig_by_date = {}
for _, row in df_signals.iterrows():
    d = row['date']
    sig_by_date.setdefault(d, []).append(row.to_dict())

all_market_dates = sorted(list(set(d for b in stock_bars.values() for d in b['dates'] if d >= dt_sim_start)))

SLOT_SIZE = 25000.0 # Fixed ₹25k standard lot per trade
MAX_POS = 9999999 # UNLIMITED LOTS

positions = []
closed_trades = []
trade_id = 1

for cur_dt in all_market_dates:
    surviving = []
    for pos in positions:
        s = pos['symbol']
        b = stock_bars[s]
        i = b['date_map'].get(cur_dt)
        if i is None:
            surviving.append(pos)
            continue
            
        c = b['c'][i]; h = b['h'][i]; l = b['l'][i]; o = b['o'][i]; v = b['v'][i]
        e50 = b['e50'][i]; vsma50 = b['vsma50'][i]
        
        entry_p = pos['entry_price']
        entry_o = pos.get('entry_open', entry_p)
        pos['days_held'] += 1
        pos['bars_held'] += 1
        if h > pos['highest_high']:
            pos['highest_high'] = h
        if c > pos['highest_close']:
            pos['highest_close'] = c
            
        cur_ret = (c - entry_p) / entry_p * 100.0
        high_ret = (pos['highest_close'] - entry_p) / entry_p * 100.0
        
        is_leg2 = pos.get('leg') == 2
        sl_pct = -12.0 if is_leg2 else -25.0
        trail_frac = 0.25  # Model 4: 25% High-Watermark Peak Trail for Turnaround Runners
        
        if high_ret >= 15.0 and not pos['be_shield_active']:
            pos['be_shield_active'] = True
            
        exited = False
        exit_p = None
        exit_reason = None
        
        # SMART EARLY REVERSAL SHIELD for Leg 2 (Days 1 to 2 post-entry):
        # Fires ONLY on true structural or institutional breakdowns on LOSING trades (cur_ret < 0):
        # 1. Price closes below the 50-day EMA on a red day while in a loss
        # 2. Institutional dump volume (>= 1.3x SMA50) with drop <= -3.5%
        # 3. Deep bearish engulfing breach below breakout day open (<= -5.0%)
        if is_leg2 and pos['days_held'] in [1, 2]:
            broke_e50 = (cur_ret < 0) and (c < e50) and (c < o)
            heavy_vol_dump = (cur_ret <= -3.5) and (c < o) and (vsma50 > 0 and v / vsma50 >= 1.3)
            deep_engulfing = (c < entry_o) and (cur_ret <= -5.0) and (c < o)
            
            if broke_e50 or heavy_vol_dump or deep_engulfing:
                exited = True
                exit_p = c
                if broke_e50:
                    exit_reason = f"Early Shield: 50 EMA Breakdown (Day {pos['days_held']})"
                elif heavy_vol_dump:
                    exit_reason = f"Early Shield: Institutional Volume Dump (Day {pos['days_held']}, Vol={v/vsma50:.1f}x)"
                else:
                    exit_reason = f"Early Shield: Deep Engulfing Breach (Day {pos['days_held']})"
        
        # Regular Stop-Loss evaluated on Daily Candle Close to avoid intraday wick shakeouts
        if not exited:
            if c <= pos['sl_price']:
                exit_p = c
                exit_reason = f"Initial SL ({sl_pct:.0f}%)"
                exited = True
            elif pos['be_shield_active']:
                trail_p = pos['highest_close'] * (1.0 - trail_frac)
                # Universal Cost Protection Lock: Once up +20%, stop floor can never fall below cost
                if high_ret >= 20.0:
                    trail_p = max(trail_p, entry_p)
                if c < trail_p:
                    exit_p = c
                    exit_reason = f"Leg {pos['leg']} Trail SL ({int(trail_frac*100)}% from Peak)"
                    exited = True
                elif c < e50 and vsma50 > 0 and (v / vsma50) >= 1.2 and cur_ret >= 10.0:
                    exit_p = c
                    exit_reason = "Institutional 50 EMA Volume Breakdown"
                    exited = True
                    
        if exited:
            pnl_pct = (exit_p - entry_p) / entry_p * 100.0
            pnl_amt = pos['shares'] * (exit_p - entry_p)
            closed_trades.append({
                'trade_id': trade_id,
                'symbol': s,
                'name': s,
                'leg': pos['leg'],
                'strategy_leg': f"LEG{pos['leg']}_{pos.get('setup_type', 'BREAKOUT')}",
                'entry_date': pos['entry_date'].strftime('%Y-%m-%d'),
                'exit_date': cur_dt.strftime('%Y-%m-%d'),
                'entry_price': round(entry_p, 2),
                'avg_price': round(entry_p, 2),
                'exit_price': round(exit_p, 2),
                'shares': pos['shares'],
                'qty': pos['shares'],
                'invested': round(pos['shares'] * entry_p, 2),
                'days_held': pos['days_held'],
                'bars_held': pos['bars_held'],
                'holding_days': pos['days_held'],
                'reason': exit_reason,
                'exit_reason': exit_reason,
                'pnl': round(pnl_amt, 2),
                'pnl_pct': round(pnl_pct, 2),
                'pct_return': round(pnl_pct, 2),
                'highest_high': round(pos['highest_high'], 2),
                'stars': 4 if is_leg2 else 5,
                'mode': 'PAPER'
            })
            trade_id += 1
        else:
            surviving.append(pos)
            
    positions = surviving
    
    daily_sigs = sig_by_date.get(cur_dt, [])
    if daily_sigs:
        held = set(p['symbol'] for p in positions)
        for sig in daily_sigs:
            s = sig['symbol']
            if s in held:
                continue
            p = sig['price']
            if p <= 0: continue
            shs = int(SLOT_SIZE / p)
            if shs < 1: continue
            
            is_l2 = sig['leg'] == 2
            sl_price = p * (0.88 if is_l2 else 0.75)
            
            positions.append({
                'symbol': s,
                'leg': sig['leg'],
                'setup_type': sig.get('type', 'BREAKOUT'),
                'entry_date': cur_dt,
                'entry_price': p,
                'entry_open': sig.get('open_price', p),
                'shares': shs,
                'sl_price': sl_price,
                'be_shield_active': False,
                'highest_high': p,
                'highest_close': p,
                'days_held': 0,
                'bars_held': 0
            })
            held.add(s)

# Calculate financial metrics
pnl_tot = sum(t['pnl'] for t in closed_trades)
wins = [t for t in closed_trades if t['pnl'] > 0]
losses = [t for t in closed_trades if t['pnl'] <= 0]
win_rate = len(wins) / len(closed_trades) * 100.0

gross_profit = sum(t['pnl'] for t in wins)
gross_loss = abs(sum(t['pnl'] for t in losses))
profit_factor = round(gross_profit / gross_loss, 2) if gross_loss > 0 else 99.0

# Capital: Base capital ₹500,000
CAPITAL = 500000.0

# XIRR Calculation
start_dt = pd.to_datetime('2022-01-01')
end_dt = pd.to_datetime(closed_trades[-1]['exit_date'])
years = (end_dt - start_dt).days / 365.25

# Account XIRR (Base 500k)
cfs_acct = [(start_dt, -CAPITAL)]
for t in closed_trades:
    cfs_acct.append((pd.to_datetime(t['exit_date']), t['pnl']))
cfs_acct.append((end_dt, CAPITAL))
calc_xirr = round(pure_xirr(cfs_acct), 1)

# Active Margin XIRR (Base 250k)
cfs_active = [(start_dt, -250000.0)]
for t in closed_trades:
    cfs_active.append((pd.to_datetime(t['exit_date']), t['pnl']))
cfs_active.append((end_dt, 250000.0))
calc_xirr_active = round(pure_xirr(cfs_active), 1)

print(f"Total Trades: {len(closed_trades)}")
print(f"Win Rate: {win_rate:.1f}%")
print(f"Net P&L: ₹{pnl_tot:,.2f}")
print(f"Profit Factor: {profit_factor}")
print(f"Account XIRR: +{calc_xirr}% p.a.")
print(f"Active Margin XIRR: +{calc_xirr_active}% p.a.")

# Yearly Breakdown
yearly = {}
for t in closed_trades:
    yr = t['exit_date'][:4]
    yearly.setdefault(yr, {'trades': 0, 'wins': 0, 'losses': 0, 'pnl': 0.0, 'win_pnl': 0.0, 'loss_pnl': 0.0})
    yearly[yr]['trades'] += 1
    if t['pnl'] > 0:
        yearly[yr]['wins'] += 1
        yearly[yr]['win_pnl'] += t['pnl']
    else:
        yearly[yr]['losses'] += 1
        yearly[yr]['loss_pnl'] += abs(t['pnl'])
    yearly[yr]['pnl'] += t['pnl']

yearly_list = []
for yr, s in sorted(yearly.items()):
    wr = round(s['wins'] / s['trades'] * 100.0, 1)
    pf = round(s['win_pnl'] / s['loss_pnl'], 2) if s['loss_pnl'] > 0 else 99.0
    yearly_list.append({
        'year': yr,
        'label': yr,
        'trades': s['trades'],
        'wins': s['wins'],
        'losses': s['losses'],
        'win_rate': wr,
        'profit_factor': pf,
        'pnl': round(s['pnl'], 2),
        'pnl_pct': round((s['pnl'] / 250000.0) * 100.0, 1)
    })
    print(f"  {yr}: {s['trades']} trades | WR: {wr}% | PF: {pf} | P&L: ₹{s['pnl']:,.2f}")

# Monthly Breakdown
monthly = {}
for t in closed_trades:
    m = t['exit_date'][:7]
    monthly.setdefault(m, {'trades': 0, 'wins': 0, 'losses': 0, 'pnl': 0.0, 'win_pnl': 0.0, 'loss_pnl': 0.0})
    monthly[m]['trades'] += 1
    if t['pnl'] > 0:
        monthly[m]['wins'] += 1
        monthly[m]['win_pnl'] += t['pnl']
    else:
        monthly[m]['losses'] += 1
        monthly[m]['loss_pnl'] += abs(t['pnl'])
    monthly[m]['pnl'] += t['pnl']

monthly_list = []
for m, s in sorted(monthly.items()):
    wr = round(s['wins'] / s['trades'] * 100.0, 1) if s['trades'] > 0 else 0.0
    pf = round(s['win_pnl'] / s['loss_pnl'], 2) if s['loss_pnl'] > 0 else 99.0
    dt_obj = datetime.strptime(m, '%Y-%m')
    label = dt_obj.strftime('%b %Y')
    monthly_list.append({
        'month': m,
        'label': label,
        'trades': s['trades'],
        'wins': s['wins'],
        'losses': s['losses'],
        'win_rate': wr,
        'profit_factor': pf,
        'pnl': round(s['pnl'], 2),
        'pnl_pct': round((s['pnl'] / 250000.0) * 100.0, 1)
    })

# Write to paper/swinger/trades.json
ledger_data = {
    'summary': {
        'total_trades': len(closed_trades),
        'winning_trades': len(wins),
        'losing_trades': len(losses),
        'win_rate': round(win_rate, 1),
        'net_pnl': round(pnl_tot, 2),
        'total_pnl': round(pnl_tot, 2),
        'total_pnl_pct': round(pnl_tot / CAPITAL * 100.0, 1),
        'initial_capital': CAPITAL,
        'current_capital': round(CAPITAL + pnl_tot, 2),
        'profit_factor': profit_factor,
        'xirr': calc_xirr,
        'xirr_active': calc_xirr_active,
        'period_years': round(years, 1),
        'mode': 'UNLIMITED_LOTS'
    },
    'trades': closed_trades,
    'closed_trades': closed_trades,
    'yearly_breakdown': yearly_list,
    'yearly': yearly_list,
    'monthly': monthly_list,
    'last_updated': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
}

with open('paper/swinger/trades.json', 'w') as f:
    json.dump(ledger_data, f, indent=2)

print("\nSaved updated paper/swinger/trades.json with UNLIMITED LOTS successfully!")

# Export surviving active open positions to paper/swinger/portfolio.json
open_portfolio = []
for pos in positions:
    s = pos['symbol']
    b = stock_bars[s]
    last_i = b['n'] - 1
    cmp_price = b['c'][last_i]
    high_c = pos['highest_close']
    entry_p = pos['entry_price']
    shs = pos['shares']
    unreal_pnl = shs * (cmp_price - entry_p)
    unreal_pct = (cmp_price - entry_p) / entry_p * 100.0
    open_portfolio.append({
        'symbol': s,
        'name': s,
        'entry_date': pos['entry_date'].strftime('%Y-%m-%d'),
        'entry_price': round(entry_p, 2),
        'avg_price': round(entry_p, 2),
        'cmp': round(cmp_price, 2),
        'current_qty': shs,
        'shares': shs,
        'invested': round(shs * entry_p, 2),
        'unrealized_pnl': round(unreal_pnl, 2),
        'unrealized_pnl_pct': round(unreal_pct, 2),
        'unrealized_pct': round(unreal_pct, 2),
        'highest_close': round(high_c, 2),
        'peak_price': round(pos['highest_high'], 2),
        'sl_price': round(pos['sl_price'], 2),
        'be_active': pos['be_shield_active'],
        'runner_mode': pos['be_shield_active'],
        'days_held': pos['days_held'],
        'leg': pos['leg'],
        'strategy_leg': f"LEG{pos['leg']}_{pos.get('setup_type', 'BREAKOUT')}",
        'status': 'RUNNER' if pos['be_shield_active'] else 'ACTIVE'
    })

with open('paper/swinger/portfolio.json', 'w') as f:
    json.dump({'positions': open_portfolio, 'last_updated': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}, f, indent=2)

print(f"Saved {len(open_portfolio)} active open positions to paper/swinger/portfolio.json!")
