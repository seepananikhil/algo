import sys
from pathlib import Path
import pandas as pd
import numpy as np
import time

print("=" * 80, flush=True)
print(" SENSEX MASTER BACKTEST: VIX DIVERGENCE TRAP REVERSAL (2023 - 2026)", flush=True)
print("=" * 80, flush=True)

# 1. Load VIX
vix_path = Path('captured_data/india_vix_10y.csv')
vdf = pd.read_csv(vix_path)
vdf['date_str'] = pd.to_datetime(vdf['date']).dt.strftime('%Y-%m-%d')
vix_map = dict(zip(vdf['date_str'], vdf['vix_change_pct'].fillna(0.0)))

# 2. Load Sensex 1-minute data (2023 - 2026)
t0 = time.time()
base = Path('captured_data/technovusin_sensex/1min')
dfs = []
for y in ['2023', '2024', '2025']:
    f = base / y / f'SENSEX_1min_{y}.csv'
    if f.exists():
        dfs.append(pd.read_csv(f))
for f in sorted((base / '2026').glob('*.csv')):
    dfs.append(pd.read_csv(f))

df_all = pd.concat(dfs, ignore_index=True)
df_all.columns = [c.lower() for c in df_all.columns]
dt_col = [c for c in df_all.columns if 'time' in c or 'date' in c][0]
df_all['timestamp'] = pd.to_datetime(df_all[dt_col])
df_all.sort_values('timestamp', inplace=True)
df_all.drop_duplicates('timestamp', inplace=True)
df_all.reset_index(drop=True, inplace=True)

df_all['date_str'] = df_all['timestamp'].dt.strftime('%Y-%m-%d')
df_all['time_str'] = df_all['timestamp'].dt.strftime('%H:%M')

# Calculate VWAP per day
tp = (df_all['high'] + df_all['low'] + df_all['close']) / 3.0
cum_tp = tp.groupby(df_all['date_str']).cumsum()
counts = df_all.groupby(df_all['date_str']).cumcount() + 1
df_all['vwap'] = cum_tp / counts

# Pre-parse daily packages
print("Pre-indexing Sensex days...", flush=True)
daily_packages = []
for d, g in df_all.groupby('date_str'):
    if len(g) < 100: continue
    
    # OR 09:15 - 09:30
    or_bars = g[(g['time_str'] >= '09:15') & (g['time_str'] <= '09:30')]
    if len(or_bars) == 0: continue
    or_high = float(or_bars['high'].max())
    or_low = float(or_bars['low'].min())
    or_mid = (or_high + or_low) / 2.0
    or_range = or_high - or_low
    if or_range < 75.0: continue # Minimum range for Sensex
    
    # Trade window 09:30 to 12:30
    w_bars = g[(g['time_str'] >= '09:30') & (g['time_str'] <= '12:30')]
    if len(w_bars) == 0: continue
    
    times = g['time_str'].values
    opens = g['open'].values
    highs = g['high'].values
    lows = g['low'].values
    closes = g['close'].values
    vwaps = g['vwap'].values
    w_indices = [i for i, t in enumerate(times) if '09:30' <= t <= '12:30']
    
    daily_packages.append({
        'date': d,
        'year': int(d[:4]),
        'vix_chg': vix_map.get(d, 0.0),
        'or_high': or_high,
        'or_low': or_low,
        'or_mid': or_mid,
        'times': times,
        'opens': opens,
        'highs': highs,
        'lows': lows,
        'closes': closes,
        'vwaps': vwaps,
        'w_indices': w_indices,
        'n_bars': len(times)
    })

print(f"Loaded and indexed {len(daily_packages)} valid Sensex trading days in {time.time()-t0:.2f}s", flush=True)

def run_sensex_simulation(vix_th=2.0, sl_pts=100.0, target_pts=None, allow_short=True, allow_long=True):
    trades = []
    
    for dp in daily_packages:
        v_chg = dp['vix_chg']
        or_h = dp['or_high']
        or_l = dp['or_low']
        or_m = dp['or_mid']
        times = dp['times']
        opens = dp['opens']
        highs = dp['highs']
        lows = dp['lows']
        closes = dp['closes']
        vwaps = dp['vwaps']
        w_idx = dp['w_indices']
        n_bars = dp['n_bars']
        
        entry = None
        has_tested_high = False
        has_tested_low = False
        
        for i in w_idx:
            t = times[i]
            o, h, l, c, v = opens[i], highs[i], lows[i], closes[i], vwaps[i]
            
            if h >= or_h: has_tested_high = True
            if l <= or_l: has_tested_low = True
            
            # SETUP 1: Fade Bull Trap (VIX surging, tested high, rejects below VWAP & OR High)
            if allow_short and v_chg >= vix_th and has_tested_high:
                if c < o and c < v and c < or_h:
                    entry = ('SHORT', t, c, c + sl_pts, i, v_chg, 'BULL_TRAP_FADE', or_m)
                    break
                    
            # SETUP 2: Fade Bear Trap (VIX collapsing, tested low, bounces above VWAP & OR Low)
            if allow_long and v_chg <= -vix_th and has_tested_low:
                if c > o and c > v and c > or_l:
                    entry = ('LONG', t, c, c - sl_pts, i, v_chg, 'BEAR_TRAP_FADE', or_m)
                    break
                    
        if entry:
            sig, e_time, e_px, initial_sl, e_idx, v_val, setup_type, mid_px = entry
            curr_sl = initial_sl
            exit_px = None
            exit_time = None
            max_fav = 0.0
            exit_reason = None
            
            for k in range(e_idx + 1, n_bars):
                bt = times[k]
                bh, bl, bc = highs[k], lows[k], closes[k]
                fav = (bh - e_px) if sig == 'LONG' else (e_px - bl)
                if fav > max_fav: max_fav = fav
                
                # Check fixed target
                if target_pts is not None:
                    if max_fav >= float(target_pts):
                        exit_px = e_px + float(target_pts) if sig == 'LONG' else e_px - float(target_pts)
                        exit_time = bt
                        exit_reason = f'TARGET_{target_pts}'
                        break
                else:
                    # Dynamic Ratchets for Sensex (scaled ~3x Nifty):
                    # Lock +60 pts when gain reaches +150 pts
                    # Lock +180 pts when gain reaches +300 pts
                    if max_fav >= 150.0:
                        r1 = e_px + 60.0 if sig == 'LONG' else e_px - 60.0
                        if (sig == 'LONG' and r1 > curr_sl) or (sig == 'SHORT' and r1 < curr_sl):
                            curr_sl = r1
                    if max_fav >= 300.0:
                        r2 = e_px + 180.0 if sig == 'LONG' else e_px - 180.0
                        if (sig == 'LONG' and r2 > curr_sl) or (sig == 'SHORT' and r2 < curr_sl):
                            curr_sl = r2
                            
                # Check SL hit
                if (sig == 'LONG' and bl <= curr_sl) or (sig == 'SHORT' and bh >= curr_sl):
                    exit_px = curr_sl
                    exit_time = bt
                    exit_reason = 'STOP_LOSS' if curr_sl == initial_sl else 'RATCHET_LOCK'
                    break
                    
                # EOD 15:15
                if bt >= '15:15':
                    exit_px = bc
                    exit_time = bt
                    exit_reason = 'EOD_1515'
                    break
                    
            if exit_px is None:
                exit_px = closes[-1]
                exit_time = times[-1]
                exit_reason = 'EOD'
                
            pnl = (exit_px - e_px) if sig == 'LONG' else (e_px - exit_px)
            trades.append({
                'date': dp['date'],
                'year': dp['year'],
                'setup': setup_type,
                'side': sig,
                'entry_time': e_time,
                'entry_price': round(e_px, 2),
                'exit_time': exit_time,
                'exit_price': round(exit_px, 2),
                'pnl_points': round(pnl, 2),
                'max_fav': round(max_fav, 2),
                'exit_reason': exit_reason,
                'vix_chg': round(v_val, 2)
            })
            
    return pd.DataFrame(trades)

def summarize(tdf, name):
    if len(tdf) == 0:
        print(f"{name:55s} | 0 trades", flush=True)
        return None
    pts = tdf['pnl_points'].sum()
    gw = tdf[tdf['pnl_points'] > 0]['pnl_points'].sum()
    gl = abs(tdf[tdf['pnl_points'] <= 0]['pnl_points'].sum())
    pf = gw / gl if gl > 0 else 999.0
    wr = len(tdf[tdf['pnl_points'] > 0]) / len(tdf) * 100.0
    eq = tdf['pnl_points'].cumsum()
    pk = eq.cummax()
    dd = (eq - pk).min()
    print(f"{name:55s} | Trades: {len(tdf):3d} | WR: {wr:5.1f}% | Pts: {pts:+9.1f} | PF: {pf:4.2f} | Max DD: {dd:7.1f}", flush=True)
    return pts, pf, wr, dd

print("\n--- SENSEX PARAMETER MATRIX (2023 - 2026) ---", flush=True)
configs = [
    ("Bull Trap (VIX >= +2%, SL 90, Target 180 pt)", 2.0, 90.0, 180.0, True, False),
    ("Bull Trap (VIX >= +2%, SL 100, Target 200 pt)", 2.0, 100.0, 200.0, True, False),
    ("Bull Trap (VIX >= +2%, SL 100, Trail to EOD)", 2.0, 100.0, None, True, False),
    ("Bull Trap (VIX >= +3%, SL 100, Trail to EOD)", 3.0, 100.0, None, True, False),
    ("Bear Trap (VIX <= -2%, SL 100, Target 200 pt)", 2.0, 100.0, 200.0, False, True),
    ("Bear Trap (VIX <= -2%, SL 100, Trail to EOD)", 2.0, 100.0, None, False, True),
    ("Dual Trap (VIX >= +-2%, SL 90, Target 180 pt)", 2.0, 90.0, 180.0, True, True),
    ("Dual Trap (VIX >= +-2%, SL 100, Target 200 pt)", 2.0, 100.0, 200.0, True, True),
    ("Dual Trap (VIX >= +-2%, SL 100, Trail to EOD)", 2.0, 100.0, None, True, True),
    ("Dual Trap (VIX >= +-3%, SL 100, Trail to EOD)", 3.0, 100.0, None, True, True),
]

results = []
for label, v_th, sl, tgt, ash, alg in configs:
    tdf = run_sensex_simulation(vix_th=v_th, sl_pts=sl, target_pts=tgt, allow_short=ash, allow_long=alg)
    res = summarize(tdf, label)
    if res:
        results.append((label, tdf, res))

best = max(results, key=lambda x: x[2][0])
best_label, best_df, best_res = best

print("\n" + "=" * 80, flush=True)
print(f" TOP PERFORMING SENSEX CONFIGURATION: {best_label}", flush=True)
print("=" * 80, flush=True)

# Add dynamic lots to best_df (2 Base Lots + 1 Pyramid Lot at +150 pts gain)
lot_size = 20
delta = 0.60
records = []
for _, r in best_df.iterrows():
    pnl = float(r['pnl_points'])
    mf = float(r['max_fav'])
    side = 'PUT' if r['side'] == 'SHORT' else 'CALL'
    e_px = float(r['entry_price'])
    x_px = float(r['exit_price'])
    
    # Strike selection (ITM 300-500 pts)
    strike_round = round(e_px / 100.0) * 100
    strike = strike_round + 400 if side == 'PUT' else strike_round - 400
    opt_name = f'SENSEX {int(strike)} {side[:2]} (ITM-400)'
    
    base_lots = 2
    pyramided = (mf >= 150.0 and pnl > 0)
    total_lots = 3 if pyramided else 2
    
    if pnl <= 0:
        weighted_pnl = round(pnl * 2, 2)
    else:
        pyr_pnl = max(0.0, pnl - 150.0) if pyramided else 0.0
        weighted_pnl = round((pnl * 2) + pyr_pnl, 2)
        
    fut_pnl = round(weighted_pnl * lot_size, 2)
    opt_pnl = round(weighted_pnl * lot_size * delta, 2)
    sl_px = e_px + 100.0 if side == 'PUT' else e_px - 100.0
    
    records.append({
        'date': r['date'],
        'year': r['year'],
        'trade_num': 1,
        'stage': 'VIX_DIVERGENCE_REVERSAL',
        'side': side,
        'option': opt_name,
        'option_symbol': '',
        'option_entry_price': 0.0,
        'option_exit_price': 0.0,
        'option_pnl_points': round(weighted_pnl * delta, 2),
        'option_pnl_rupees': opt_pnl,
        'entry_time': r['entry_time'],
        'entry_price': e_px,
        'exit_time': r['exit_time'],
        'exit_price': x_px,
        'initial_sl': sl_px,
        'final_sl': sl_px,
        'pnl_points': pnl,
        'pnl_rupees': opt_pnl,
        'futures_pnl_rupees': fut_pnl,
        'diff_rupees': round(fut_pnl - opt_pnl, 2),
        'max_fav': mf,
        'rr': round(pnl / 100.0, 2),
        'exit_reason': r['exit_reason'],
        'vix_chg': r['vix_chg'],
        'base_lots': base_lots,
        'pyramided': pyramided,
        'total_lots': total_lots,
        'weighted_pnl_points': weighted_pnl
    })

enriched_df = pd.DataFrame(records)

print(f"Total Trades: {len(enriched_df)}")
print(f"1-Lot Net Points: {enriched_df['pnl_points'].sum():+.2f} pts")
print(f"Dynamic Net Points (2+1 Lots): {enriched_df['weighted_pnl_points'].sum():+.2f} pts")
dyn_gw = enriched_df[enriched_df['weighted_pnl_points'] > 0]['weighted_pnl_points'].sum()
dyn_gl = abs(enriched_df[enriched_df['weighted_pnl_points'] <= 0]['weighted_pnl_points'].sum())
dyn_pf = dyn_gw / dyn_gl if dyn_gl > 0 else 999.0
print(f"Dynamic Profit Factor: {dyn_pf:.2f}")

print("\n--- SENSEX YEAR-BY-YEAR BREAKDOWN ---")
for y, ydf in enriched_df.groupby('year'):
    y_pts = ydf['weighted_pnl_points'].sum()
    y_bpts = ydf['pnl_points'].sum()
    y_wr = len(ydf[ydf['weighted_pnl_points'] > 0]) / len(ydf) * 100.0 if len(ydf) else 0
    y_gw = ydf[ydf['weighted_pnl_points'] > 0]['weighted_pnl_points'].sum()
    y_gl = abs(ydf[ydf['weighted_pnl_points'] <= 0]['weighted_pnl_points'].sum())
    y_pf = y_gw / y_gl if y_gl > 0 else 999.0
    print(f"Year {y}: Trades: {len(ydf):2d} | WR: {y_wr:5.1f}% | 1-Lot: {y_bpts:+7.1f} | Dynamic: {y_pts:+8.1f} pts | PF: {y_pf:4.2f}")

enriched_df.to_csv('performance/sensex_vix_divergence_trades.csv', index=False)
print("\nSaved Sensex trade log to performance/sensex_vix_divergence_trades.csv", flush=True)
