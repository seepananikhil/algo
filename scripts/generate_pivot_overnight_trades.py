#!/usr/bin/env python3
"""
Generate and Compare Baseline vs Optimized NRML Pivot Strategy
Saves the optimized ledger to performance/nrml_pivot_overnight_trades.csv.
"""

from pathlib import Path
import duckdb
import pandas as pd
import numpy as np

ROOT = Path("d:/nikhil/algo")
PERF_DIR = ROOT / "performance"
PERF_DIR.mkdir(parents=True, exist_ok=True)
OUT_CSV = PERF_DIR / "nrml_pivot_overnight_trades.csv"

parquet_path = ROOT / "historical_data" / "nifty50" / "parquet" / "NIFTY50_01min.parquet"

print("Loading data...", flush=True)
con = duckdb.connect()
df = con.query(f"""
    SELECT ts, strftime(ts, '%Y-%m-%d') as date_str, strftime(ts, '%H:%M') as time_str,
           strftime(ts, '%w') as day_of_week,
           open, high, low, close, COALESCE(volume, 0) as volume
    FROM '{parquet_path}'
    ORDER BY ts
""").df()

daily_groups = {d: g for d, g in df.groupby('date_str')}
days = sorted(daily_groups.keys())

daily_pivots = {}
daily_np = {}

for d in days:
    g = daily_groups[d].reset_index(drop=True)
    h, l, c = g['high'].max(), g['low'].min(), g['close'].iloc[-1]
    p = (h + l + c) / 3.0
    r1 = (2.0 * p) - l
    s1 = (2.0 * p) - h
    r2 = p + (h - l)
    s2 = p - (h - l)
    r3 = h + 2 * (p - l)
    s3 = l - 2 * (h - p)
    daily_pivots[d] = {'H': h, 'L': l, 'C': c, 'P': p, 'R1': r1, 'S1': s1, 'R2': r2, 'S2': s2, 'R3': r3, 'S3': s3}
    
    vol = g['volume'].values.astype(float)
    vol = np.where(vol <= 0, 1.0, vol)
    tp = (g['high'].values + g['low'].values + g['close'].values) / 3.0
    vwap = np.cumsum(tp * vol) / np.cumsum(vol)

    daily_np[d] = {
        'times': g['time_str'].values,
        'opens': g['open'].values.astype(float),
        'highs': g['high'].values.astype(float),
        'lows': g['low'].values.astype(float),
        'closes': g['close'].values.astype(float),
        'vwap': vwap,
        'is_expiry': (g['day_of_week'].iloc[0] == '4'),
        'length': len(g)
    }

def generate_trades(
    max_trades_per_day=1,
    use_vwap=True,
    body_filter=True,
    lock_trigger=100.0,
    lock_amt=25.0,
    trail_trigger=140.0,
    trail_dist=50.0
):
    lot_size = 25
    option_delta = 0.72
    trades = []
    active_pos = None

    for i in range(1, len(days)):
        prev_d, cur_d = days[i-1], days[i]
        d_data = daily_np[cur_d]
        n_bars = d_data['length']
        if n_bars < 60: continue

        piv = daily_pivots[prev_d]
        p, r1, s1 = piv['P'], piv['R1'], piv['S1']
        today_open = d_data['opens'][0]
        gap_pct = abs(today_open - piv['C']) / piv['C'] * 100.0
        is_expiry_day = d_data['is_expiry']

        times = d_data['times']
        opens = d_data['opens']
        highs = d_data['highs']
        lows = d_data['lows']
        closes = d_data['closes']
        vwaps = d_data['vwap']

        trades_today = 0

        for idx in range(n_bars):
            t_str = times[idx]
            o_bar, h_bar, l_bar, c_bar = opens[idx], highs[idx], lows[idx], closes[idx]
            vwap_val = vwaps[idx]

            # 1. Manage Active Position
            if active_pos is not None:
                side = active_pos['side']
                entry_px = active_pos['entry_px']
                closed = False
                exit_px = c_bar
                exit_reason = None

                if side == 'CALL':
                    cur_fav = h_bar - entry_px
                    if cur_fav > active_pos['peak_fav']:
                        active_pos['peak_fav'] = cur_fav
                        if lock_trigger > 0 and cur_fav >= lock_trigger:
                            active_pos['sl_px'] = max(active_pos['sl_px'], entry_px + lock_amt)
                        if trail_trigger > 0 and cur_fav >= trail_trigger:
                            active_pos['sl_px'] = max(active_pos['sl_px'], h_bar - trail_dist)

                    if l_bar <= active_pos['sl_px']:
                        exit_px = active_pos['sl_px']
                        exit_reason = 'STOP_LOSS' if active_pos['sl_px'] < entry_px else ('PROFIT_LOCK' if active_pos['sl_px'] == entry_px + lock_amt else 'TRAILING_STOP')
                        closed = True
                    elif is_expiry_day and t_str >= '15:15':
                        exit_px = c_bar
                        exit_reason = 'WEEKLY_EXPIRY'
                        closed = True
                else: # PUT
                    cur_fav = entry_px - l_bar
                    if cur_fav > active_pos['peak_fav']:
                        active_pos['peak_fav'] = cur_fav
                        if lock_trigger > 0 and cur_fav >= lock_trigger:
                            active_pos['sl_px'] = min(active_pos['sl_px'], entry_px - lock_amt)
                        if trail_trigger > 0 and cur_fav >= trail_trigger:
                            active_pos['sl_px'] = min(active_pos['sl_px'], l_bar + trail_dist)

                    if h_bar >= active_pos['sl_px']:
                        exit_px = active_pos['sl_px']
                        exit_reason = 'STOP_LOSS' if active_pos['sl_px'] > entry_px else ('PROFIT_LOCK' if active_pos['sl_px'] == entry_px - lock_amt else 'TRAILING_STOP')
                        closed = True
                    elif is_expiry_day and t_str >= '15:15':
                        exit_px = c_bar
                        exit_reason = 'WEEKLY_EXPIRY'
                        closed = True

                if closed:
                    pnl_pts = round((exit_px - entry_px) if side == 'CALL' else (entry_px - exit_px), 2)
                    opt_pnl_rs = round(pnl_pts * lot_size * option_delta, 2)
                    fut_pnl_rs = round(pnl_pts * lot_size, 2)
                    strike = int(round((entry_px - 150 if side == 'CALL' else entry_px + 150) / 50.0) * 50)
                    opt_type = 'CE' if side == 'CALL' else 'PE'

                    trades.append({
                        'date': cur_d,
                        'year': int(cur_d[:4]),
                        'month': cur_d[:7],
                        'trade_num': len(trades) + 1,
                        'stage': 'PIVOT_NRML',
                        'side': side,
                        'option': f"NIFTY {strike} {opt_type} (ITM-150)",
                        'entry_time': active_pos['entry_time'],
                        'entry_price': round(entry_px, 2),
                        'exit_time': t_str,
                        'exit_price': round(exit_px, 2),
                        'initial_sl': round(active_pos['initial_sl'], 2),
                        'final_sl': round(active_pos['sl_px'], 2),
                        'sl': round(active_pos['sl_px'], 2),
                        'target': round(entry_px + 300.0 if side == 'CALL' else entry_px - 300.0, 2),
                        'pnl_points': pnl_pts,
                        'weighted_pnl_points': pnl_pts,
                        'pnl_rupees': opt_pnl_rs,
                        'futures_pnl_rupees': fut_pnl_rs,
                        'max_fav': round(active_pos['peak_fav'], 2),
                        'exit_reason': exit_reason,
                        'days_held': i - active_pos['day_idx'],
                        'base_lots': 1,
                        'total_lots': 1,
                        'setup_id': 'nrml_pivot_overnight',
                        'engine': 'NRML_PIVOT_OVERNIGHT',
                        'strategy_label': 'Pivot Runner (NRML)',
                        'trigger_label': f"[Pivot Runner] BUY {opt_type} ({('R1 Breakout' if side == 'CALL' else 'S1 Breakdown')})",
                        'trigger_reason': 'R1 Resistance Breakout (Call) / S1 Breakdown (Put)'
                    })
                    active_pos = None

            # 2. Check New Entry
            if active_pos is None and ('09:30' <= t_str <= '13:00') and trades_today < max_trades_per_day:
                if gap_pct <= 0.6:
                    sig = None
                    bar_range = (h_bar - l_bar) if (h_bar - l_bar) > 0 else 1.0
                    body = abs(c_bar - o_bar)
                    body_ratio = body / bar_range

                    if c_bar > r1 and c_bar > o_bar:
                        if (not use_vwap or c_bar > vwap_val):
                            if (not body_filter or body_ratio >= 0.5):
                                sig = 'CALL'
                    elif c_bar < s1 and c_bar < o_bar:
                        if (not use_vwap or c_bar < vwap_val):
                            if (not body_filter or body_ratio >= 0.5):
                                sig = 'PUT'

                    if sig and (idx + 1 < n_bars):
                        next_open = opens[idx + 1]
                        sl_level = next_open - 45.0 if sig == 'CALL' else next_open + 45.0
                        active_pos = {
                            'side': sig,
                            'entry_date': cur_d,
                            'entry_time': t_str,
                            'entry_px': next_open,
                            'initial_sl': sl_level,
                            'sl_px': sl_level,
                            'peak_fav': 0.0,
                            'day_idx': i
                        }
                        trades_today += 1

    return pd.DataFrame(trades)

# Generate Optimized Trades
print("Generating optimized trades...", flush=True)
tdf_opt = generate_trades(
    max_trades_per_day=1,
    use_vwap=True,
    body_filter=True,
    lock_trigger=100.0,
    lock_amt=25.0,
    trail_trigger=140.0,
    trail_dist=50.0
)

tdf_opt.to_csv(OUT_CSV, index=False)
print(f"Saved {len(tdf_opt):,} trades to {OUT_CSV}", flush=True)

# Performance metrics
cum = tdf_opt['pnl_points'].cumsum()
peak = cum.cummax()
dd = (cum - peak).min()
wins = tdf_opt[tdf_opt['pnl_points'] > 0]
losses = tdf_opt[tdf_opt['pnl_points'] < 0]
gross_win = wins['pnl_points'].sum()
gross_loss = abs(losses['pnl_points'].sum()) if len(losses) > 0 else 1.0
monthly = tdf_opt.groupby('month')['pnl_points'].sum()
green_m = (monthly > 0).sum()
red_m = (monthly < 0).sum()

print("\n=== OPTIMIZED NRML PIVOT RESULTS ===")
print(f"Total Trades: {len(tdf_opt)}")
print(f"Total Spot Points: +{tdf_opt['pnl_points'].sum():,.2f} pts")
print(f"1-Lot Option PnL: Rs +{tdf_opt['pnl_rupees'].sum():,.2f}")
print(f"Win Rate: {len(wins)/len(tdf_opt)*100:.1f}% ({len(wins)}W / {len(losses)}L)")
print(f"Profit Factor: {gross_win / gross_loss:.2f}")
print(f"Max Drawdown: {dd:.1f} pts")
print(f"Monthly Consistency: {green_m} Green / {red_m} Red ({green_m/len(monthly)*100:.1f}% profitable months)")
print(f"Worst Month: {monthly.min():.1f} pts")

yearly = tdf_opt.groupby('year').agg(
    trades=('pnl_points', 'count'),
    points=('pnl_points', 'sum'),
    win_rate=('pnl_points', lambda x: round((x > 0).mean() * 100, 1)),
    pnl_rs=('pnl_rupees', 'sum')
)
print("\nYearly Breakdown:")
print(yearly)
