import pickle
import pandas as pd
import numpy as np
import json
from datetime import datetime

def pure_xirr(cash_flows):
    if not cash_flows or len(cash_flows) < 2:
        return 0.0
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

CONFIG_PATH = "swinger_config.json"
BLACKLIST = {"V2RETAIL"}
try:
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
        BLACKLIST = set(cfg.get("blacklist", ["V2RETAIL"]))
except Exception:
    pass

print(f"[Ledger Build] Loaded Blacklist ({len(BLACKLIST)} symbols): {BLACKLIST}")

dt_sim_start = pd.to_datetime('2022-01-01')

stock_bars = {}

for s, df in price_data.items():
    if len(df) < 150 or s in ['^NSEI', 'NIFTY'] or s in BLACKLIST:
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
    lowest_30 = pd.Series(l).rolling(30, min_periods=5).min().values
    
    delta = pd.Series(c).diff().values
    gain = pd.Series(np.where(delta > 0, delta, 0)).rolling(14, min_periods=10).mean().values
    loss = pd.Series(np.where(delta < 0, -delta, 0)).rolling(14, min_periods=10).mean().values
    rs = np.where(loss > 0, gain / loss, 1.0)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    
    prev_c = np.roll(c, 1)
    pct_chg = np.where(prev_c > 0, (c - prev_c) / prev_c * 100.0, 0.0)
    
    stock_bars[s] = {
        'dates': dates, 'date_map': {d: i for i, d in enumerate(dates)},
        'c': c, 'h': h, 'l': l, 'o': o, 'v': v,
        'e20': ema20, 'e50': ema50, 'e200': ema200, 'rsi': rsi,
        'vsma50': vol_sma50, 'vr50': vr50, 'vsma60': vol_sma60, 'vr60': vr60,
        'pct_chg': pct_chg, 'max_1000': max_1000, 'lowest_30': lowest_30, 'n': n
    }

# 1. Generate Leg 1 Turnaround Pullback Signals:
# Requires +5% ignition blast below 200 EMA with Trough Memory (-60% trough or -55% close), then enters on 1st 20 EMA pullback bounce!
leg1_signals = []
for s, b in stock_bars.items():
    c = b['c']; h = b['h']; l = b['l']; o = b['o']; n = b['n']
    e20 = b['e20']; e50 = b['e50']; e200 = b['e200']; rsi = b['rsi']
    max_1000 = b['max_1000']; lowest_30 = b['lowest_30']; pct_chg = b['pct_chg']
    vr60 = b['vr60']; vr50 = b['vr50']; dates = b['dates']
    
    # Trough Memory crash condition:
    # Captures deep -60% crashes even when the explosive +12% blast day closes at -55% or -50%
    crash_condition = ((lowest_30 <= 0.40 * max_1000) & (c <= 0.50 * max_1000)) | (c <= 0.45 * max_1000)
    
    blast_mask = (
        crash_condition &
        (c < e200) &
        (pct_chg >= 5.0) &
        (vr60 >= 2.0)
    )
    blast_indices = np.where(blast_mask)[0]
    last_entry_idx = -999
    
    for b_idx in blast_indices:
        # Scan for the 1st 20 EMA pullback bounce occurring 4 to 50 days after ignition
        for j in range(b_idx + 4, min(b_idx + 50, n)):
            if j <= last_entry_idx + 20: continue
            dist_20 = (c[j] - e20[j]) / e20[j] * 100.0 if e20[j] > 0 else 0.0
            rng = h[j] - l[j]
            wick = ((h[j] - c[j]) / rng) if rng > 0 else 0.0
            
            # Overhead Clearance Check: Avoid entries colliding into 200 EMA ceiling (<8% room)
            if c[j] < e200[j]:
                dist_to_200 = (e200[j] - c[j]) / c[j] * 100.0
                if dist_to_200 < 8.0:
                    continue

            # Pure RSI Cool-down Pullback Bounce at 20 EMA:
            if (-3.5 <= dist_20 <= 3.5 and 
                c[j] >= e50[j] * 0.97 and 
                c[j] >= o[j] and 
                0.8 <= pct_chg[j] <= 5.5 and 
                40.0 <= rsi[j] <= 60.0 and 
                vr50[j] >= 0.40 and 
                wick <= 0.45 and 
                dates[j] >= dt_sim_start):
                
                leg1_signals.append({
                    'symbol': s, 'date': dates[j], 'price': c[j], 'open_price': o[j],
                    'low_price': l[j], 'vol_mult': vr50[j], 'score': vr50[j] * 1.5,
                    'leg': 1, 'type': 'TURNAROUND_PULLBACK'
                })
                last_entry_idx = j
                break

# 2. Generate Leg 2 Signals (Pure RSI Cool-down 20 EMA Pullbacks in Stage-2 uptrend)
phoenix_first_dt = {}
for sig in leg1_signals:
    s = sig['symbol']
    if s not in phoenix_first_dt or sig['date'] < phoenix_first_dt[s]:
        phoenix_first_dt[s] = sig['date']

leg2_signals = []
for s, first_leg1_dt in phoenix_first_dt.items():
    b = stock_bars[s]
    c = b['c']; h = b['h']; l = b['l']; o = b['o']; dates = b['dates']
    n = b['n']; vr50 = b['vr50']; e20 = b['e20']; e50 = b['e50']; e200 = b['e200']; rsi = b['rsi']
    pct_chg = b['pct_chg']
    first_idx = b['date_map'][first_leg1_dt]
    last_trigger_idx = -999
    
    for i in range(first_idx + 15, n):
        if i <= last_trigger_idx + 20: continue
        cur_pct = pct_chg[i]
        dist_20 = (c[i] - e20[i]) / e20[i] * 100.0 if e20[i] > 0 else 0.0
        rng = h[i] - l[i]
        wick_ratio = ((h[i] - c[i]) / rng) if rng > 0 else 0.0
        
        # Pure RSI Cool-off 20 EMA Pullback Bounce (Stage-2 Base Accumulation)
        is_ma_pullback = (
            (-3.0 <= dist_20 <= 3.5) and 
            (c[i] >= e50[i] * 0.97) and 
            (c[i] >= o[i]) and 
            (0.8 <= cur_pct <= 5.5) and 
            (40.0 <= rsi[i] <= 60.0) and 
            (vr50[i] >= 0.40) and 
            (wick_ratio <= 0.45)
        )
        if is_ma_pullback:
            # Overhead Clearance Check: Avoid entries colliding into 200 EMA ceiling (<8% room)
            if c[i] < e200[i]:
                dist_to_200 = (e200[i] - c[i]) / c[i] * 100.0
                if dist_to_200 < 8.0:
                    continue
            if abs(c[i] - e200[i]) / e200[i] < 0.01 and c[i] < e200[i] * 1.005:
                continue
            d = dates[i]
            if d >= dt_sim_start:
                leg2_signals.append({
                    'symbol': s, 'date': d, 'price': c[i], 'open_price': o[i],
                    'low_price': l[i], 'vol_mult': vr50[i], 'score': vr50[i] * 1.5,
                    'leg': 2, 'type': 'MA_PULLBACK'
                })
                last_trigger_idx = i

all_signals = leg1_signals + leg2_signals
# Sort Leg 2 before Leg 1 (leg descending: 2 before 1) to prioritize proven Stage-2 pullbacks
df_signals = pd.DataFrame(all_signals).sort_values(by=['date', 'leg', 'score'], ascending=[True, False, False])

sig_by_date = {}
for _, row in df_signals.iterrows():
    d = row['date']
    sig_by_date.setdefault(d, []).append(row.to_dict())

all_market_dates = sorted(list(set(d for b in stock_bars.values() for d in b['dates'] if d >= dt_sim_start)))

SLOT_SIZE = 25000.0 # Standard ₹25k lot per trade
CAPITAL = 500000.0 # Base capital ₹500,000

positions = []
closed_trades = []
trade_id = 1
symbol_l1_attempts = {}
symbol_l2_attempts = {}

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
        pos['days_held'] += 1
        pos['bars_held'] += 1
        if h > pos['highest_high']:
            pos['highest_high'] = h
        if c > pos['highest_close']:
            pos['highest_close'] = c
            
        high_ret = (pos['highest_close'] - entry_p) / entry_p * 100.0
        is_leg2 = pos.get('leg') == 2
        trail_frac = 0.25 # 25% High-Watermark Peak Trail for Turnaround Runners
        exited = False
        exit_p = None
        exit_reason = None
        
        # STOP-LOSS & RUNNER EXIT EVALUATION (PURE TRAILING STOP - NO BE LOCK):
        if not pos['runner_mode']:
            # Initial Stop: 12% Daily Candle Close Stop (Gives stock room to breathe)
            if c <= entry_p * 0.88:
                exited = True
                exit_p = c
                exit_reason = "Initial SL (-12% Close)"
        else:
            # Runner Mode: activated at +20% high watermark
            peak_trail = pos['runner_peak'] * (1.0 - trail_frac)
            # Pure Trailing Stop: NO BE lock (cost floor removed so normal swing pullbacks don't trigger premature exits)
            if l <= peak_trail:
                exited = True
                exit_p = min(o, peak_trail) if o < peak_trail else peak_trail
                exit_reason = f"Peak Trail Stop ({int(trail_frac*100)}% from Peak)"
            elif is_leg2 and pos['bars_held'] >= 5 and c < e50 and vsma50 > 0 and v > 1.2 * vsma50:
                exited = True
                exit_p = c
                exit_reason = "Institutional 50 EMA Volume Breakdown"
            elif not is_leg2 and pos['bars_held'] >= 20 and c < e50 and vsma50 > 0 and v > 1.2 * vsma50:
                exited = True
                exit_p = c
                exit_reason = "Institutional 50 EMA Volume Breakdown"
        if exited:
            pnl_amt = round(pos['shares'] * (exit_p - entry_p), 2)
            pnl_pct = round((exit_p / entry_p - 1.0) * 100.0, 2)
            closed_trades.append({
                'trade_id': trade_id,
                'symbol': s,
                'name': s,
                'leg': pos['leg'],
                'strategy_leg': f"LEG{pos['leg']}_{pos.get('setup_type', 'PULLBACK')}",
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
                'pnl': pnl_amt,
                'pnl_pct': pnl_pct,
                'pct_return': pnl_pct,
                'highest_high': round(pos['highest_high'], 2),
                'stars': 5,
                'mode': 'PAPER'
            })
            trade_id += 1
        else:
            # Runner mode activation at +20% high watermark (Pure Trailing Stop)
            if high_ret >= 20.0 and not pos['runner_mode']:
                pos['runner_mode'] = True
                pos['runner_peak'] = pos['highest_close']
                pos['status'] = 'RUNNER'
            elif pos['runner_mode']:
                if pos['highest_close'] > pos['runner_peak']:
                    pos['runner_peak'] = pos['highest_close']
            surviving.append(pos)
            
    positions = surviving
    
    daily_sigs = sig_by_date.get(cur_dt, [])
    if daily_sigs:
        held = set(p['symbol'] for p in positions)
        for sig in daily_sigs:
            s = sig['symbol']
            if s in held:
                continue
            
            # Max Attempts Rule: Cap at 2 attempts for Leg 1 and 3 for Leg 2
            if sig['leg'] == 1:
                attempt = symbol_l1_attempts.get(s, 0) + 1
                if attempt > 2:
                    continue
                symbol_l1_attempts[s] = attempt
                symbol_l2_attempts[s] = 0 # Cycle Reset: Fresh Leg 1 turnaround resets Leg 2 attempts for the new bull cycle!
            else:
                attempt = symbol_l2_attempts.get(s, 0) + 1
                if attempt > 3:
                    continue
                symbol_l2_attempts[s] = attempt
                
            p = sig['price']
            if p <= 0: continue
            shs = int(SLOT_SIZE / p)
            if shs < 1: continue
            
            sl_12pct = round(p * 0.88, 2)
            
            positions.append({
                'symbol': s,
                'leg': sig['leg'],
                'setup_type': sig.get('type', 'PULLBACK'),
                'entry_date': cur_dt,
                'entry_price': p,
                'shares': shs,
                'trigger_sl': sl_12pct,
                'sl_price': sl_12pct,
                'be_shield_active': False,
                'runner_mode': False,
                'runner_peak': p,
                'highest_high': p,
                'highest_close': p,
                'days_held': 0,
                'bars_held': 0
            })
            held.add(s)

# Financial metrics
pnl_tot = sum(t['pnl'] for t in closed_trades)
wins = [t for t in closed_trades if t['pnl'] > 0]
losses = [t for t in closed_trades if t['pnl'] <= 0]
win_rate = len(wins) / len(closed_trades) * 100.0 if closed_trades else 0.0

gross_profit = sum(t['pnl'] for t in wins)
gross_loss = abs(sum(t['pnl'] for t in losses))
profit_factor = round(gross_profit / gross_loss, 2) if gross_loss > 0 else 99.0

start_dt = pd.to_datetime('2022-01-01')
end_dt = pd.to_datetime(closed_trades[-1]['exit_date']) if closed_trades else start_dt
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

# Drawdown Analysis
df_t = pd.DataFrame(closed_trades)
df_t['cum_pnl'] = df_t['pnl'].cumsum()
df_t['equity'] = CAPITAL + df_t['cum_pnl']
df_t['peak_equity'] = df_t['equity'].cummax()
df_t['dd_amt'] = df_t['equity'] - df_t['peak_equity']
df_t['dd_pct'] = (df_t['equity'] - df_t['peak_equity']) / df_t['peak_equity'] * 100.0

max_dd_amt = float(df_t['dd_amt'].min())
max_dd_pct = float(df_t['dd_pct'].min())

df_t['equity_active'] = 250000.0 + df_t['cum_pnl']
df_t['peak_equity_active'] = df_t['equity_active'].cummax()
df_t['dd_pct_active'] = (df_t['equity_active'] - df_t['peak_equity_active']) / df_t['peak_equity_active'] * 100.0
max_dd_pct_active = float(df_t['dd_pct_active'].min())

avg_win = float(sum(t['pnl'] for t in wins) / len(wins)) if wins else 0.0
avg_loss = float(abs(sum(t['pnl'] for t in losses)) / len(losses)) if losses else 0.0
payoff_ratio = round(avg_win / avg_loss, 2) if avg_loss > 0 else 99.0
expectancy = round(pnl_tot / len(closed_trades), 2) if closed_trades else 0.0

streaks = []
cur_streak = 0
for t in closed_trades:
    if t['pnl'] <= 0:
        cur_streak += 1
    else:
        if cur_streak > 0: streaks.append(cur_streak)
        cur_streak = 0
if cur_streak > 0: streaks.append(cur_streak)
max_consec_losses = max(streaks) if streaks else 0

ann_ret = (pnl_tot / CAPITAL * 100.0) / years if years > 0 else 0.0
calmar_ratio = round(ann_ret / abs(max_dd_pct), 2) if max_dd_pct != 0 else 99.0

print("="*80)
print("PULLBACK ARCHITECTURE + TRIGGER CANDLE LOW STOP LOSS RESULTS")
print("="*80)
print(f"Total Trades: {len(closed_trades)}")
print(f"Win Rate: {win_rate:.1f}%")
print(f"Net P&L: ₹{pnl_tot:,.2f}")
print(f"Profit Factor: {profit_factor}")
print(f"Account XIRR: +{calc_xirr}% p.a.")
print(f"Active Margin XIRR: +{calc_xirr_active}% p.a.")
print(f"Max Drawdown: ₹{max_dd_amt:,.2f} ({max_dd_pct:.2f}%)")
print(f"Payoff Ratio: {payoff_ratio}x | Expectancy: +₹{expectancy:,.2f} | Calmar: {calmar_ratio}")
print(f"Average Win: ₹{avg_win:,.2f} | Average Loss: -₹{avg_loss:,.2f}")

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
        'max_drawdown': round(max_dd_amt, 2),
        'max_drawdown_pct': round(max_dd_pct, 2),
        'max_drawdown_active_pct': round(max_dd_pct_active, 2),
        'avg_win': round(avg_win, 2),
        'avg_loss': round(avg_loss, 2),
        'payoff_ratio': payoff_ratio,
        'expectancy': expectancy,
        'calmar_ratio': calmar_ratio,
        'max_consecutive_losses': max_consec_losses,
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

print("\nSaved updated paper/swinger/trades.json successfully!")

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
    
    current_sl = round(pos['runner_peak'] * 0.75, 2) if pos['runner_mode'] else pos['sl_price']
    status_str = 'RUNNER' if pos['runner_mode'] else 'ACTIVE'
    
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
        'sl_price': round(current_sl, 2),
        'trigger_sl': round(pos['trigger_sl'], 2),
        'be_active': pos['be_shield_active'],
        'runner_mode': pos['runner_mode'],
        'days_held': pos['days_held'],
        'leg': pos['leg'],
        'strategy_leg': f"LEG{pos['leg']}_{pos.get('setup_type', 'PULLBACK')}",
        'status': status_str,
        'stars': 5
    })

with open('paper/swinger/portfolio.json', 'w') as f:
    json.dump({'positions': open_portfolio, 'last_updated': datetime.now().strftime('%Y-%m-%d %H:%M:%S')}, f, indent=2)

print(f"Saved {len(open_portfolio)} active open positions to paper/swinger/portfolio.json!")
