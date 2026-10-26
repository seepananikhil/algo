import pandas as pd
import numpy as np
from pathlib import Path
from trend_runner_paper import TrendRunnerPaperEngine, get_vix_change_pct

# Silence print logging
TrendRunnerPaperEngine._print_entry = lambda *args, **kwargs: None
TrendRunnerPaperEngine._print_exit = lambda *args, **kwargs: None
TrendRunnerPaperEngine._log_trade = lambda *args, **kwargs: None

print("Loading and converting 1-minute data to IST...")
dfs = []
for p in [Path('captured_data/fyers/fyers_spot_1min_3y_archive.csv'), Path('captured_data/fyers/fyers_spot_1min_extended.csv')]:
    if p.exists():
        sub = pd.read_csv(p)
        sub['timestamp'] = pd.to_datetime(sub['timestamp'])
        if sub['timestamp'].iloc[0].hour < 6:
            sub['timestamp'] = sub['timestamp'] + pd.Timedelta(hours=5, minutes=30)
        dfs.append(sub)

for lf in Path('captured_data/fyers/live').glob('nifty_1min_*.csv'):
    if lf.stat().st_size > 5000:
        sub = pd.read_csv(lf)
        sub['timestamp'] = pd.to_datetime(sub['timestamp'])
        if sub['timestamp'].iloc[0].hour < 6:
            sub['timestamp'] = sub['timestamp'] + pd.Timedelta(hours=5, minutes=30)
        dfs.append(sub)

df1 = pd.concat(dfs, ignore_index=True)
df1.drop_duplicates('timestamp', inplace=True)
df1.sort_values('timestamp', inplace=True)
df1.reset_index(drop=True, inplace=True)
df1['date'] = df1['timestamp'].dt.date
df1['time_str'] = df1['timestamp'].dt.strftime('%H:%M')

tp = (df1['high'] + df1['low'] + df1['close']) / 3.0
pv = tp * df1['volume']
cum_pv = pv.groupby(df1['date']).cumsum()
cum_vol = df1['volume'].groupby(df1['date']).cumsum()
df1['vwap'] = np.where(cum_vol > 0, cum_pv / cum_vol, tp)
df1['atr14'] = 30.0

vix_df = pd.read_csv('captured_data/fyers/india_vix_daily.csv')
vix_df['date'] = pd.to_datetime(vix_df['date']).dt.date
vix_map = dict(zip(vix_df['date'], vix_df['vix_change_pct']))

engine = TrendRunnerPaperEngine(
    enable_pyramiding=False,
    sl_points=30.0,
    reentry_sl_points=30.0,
    reentry=True,
    max_trades_per_day=2,
    r1_trigger=70.0, r1_lock=20.0,
    r2_trigger=130.0, r2_lock=60.0,
    r3_trigger=180.0, r3_lock=110.0,
    r4_trigger=230.0, r4_lock=165.0,
    r5_trigger=280.0, r5_lock=220.0,
    r6_trigger=330.0, r6_lock=270.0,
    target_pts=None,
    williams_fallback=True,
    lots=1,
    log_trades=False
)

all_trades = []
days = sorted(df1['date'].unique())
print(f"Executing 1-Minute Engine across {len(days)} trading days...")

for d in days:
    g = df1[df1['date'] == d].copy().reset_index(drop=True)
    if len(g) < 150:
        continue
    
    engine.trades_today = 0
    engine.active_position = None
    engine.midday_high = 0.0
    engine.midday_low = 999999.0
    engine.rolling_day_high = 0.0
    engine.rolling_day_low = 999999.0
    engine.dyn_or_high = 0.0
    engine.dyn_or_low = 999999.0
    engine.last_trade_sig = ""
    engine.last_trade_exit_reason = ""
    engine.last_trade_max_fav = 0.0
    engine.last_trade_sl = 0.0
    engine.last_trade_pnl = 0.0
    engine.bars_since_last_exit = 999
    engine.current_day_str = str(d)
    
    vix_chg = vix_map[d] if d in vix_map else get_vix_change_pct(str(d))
    or_bars = g[(g['time_str'] >= '09:15') & (g['time_str'] <= '09:30')]
    or_high = float(or_bars['high'].max()) if not or_bars.empty else float(g.iloc[:15]['high'].max())
    or_low = float(or_bars['low'].min()) if not or_bars.empty else float(g.iloc[:15]['low'].min())
    or_range = or_high - or_low
    
    for idx in range(len(g)):
        row = g.iloc[idx]
        next_open = float(g.iloc[idx + 1]['open']) if idx + 1 < len(g) else None
        res = engine.evaluate_bar(row, or_high, or_low, or_range, vix_chg, next_bar_open=next_open)
        if res:
            all_trades.append({
                'date': str(d),
                'trade_num': res.get('trade_num', 1),
                'stage': res.get('stage', 'STAGE1_MORNING'),
                'side': 'CALL' if res['side'] == 'LONG' else 'PUT',
                'option': res.get('option', f"NIFTY_{d}_{res['side']}"),
                'entry_time': res['entry_time'],
                'entry_price': round(res['entry_price'], 2),
                'sl': round(res['initial_sl'], 2),
                'final_sl': round(res.get('final_sl', res['initial_sl']), 2),
                'target': round(res.get('target', res['entry_price'] + 250.0 if res['side'] == 'LONG' else res['entry_price'] - 250.0), 2),
                'exit_time': res['exit_time'],
                'exit_price': round(res['exit_price'], 2),
                'exit_reason': res['exit_reason'],
                'pnl_points': round(res['pnl_points'], 2),
                'pnl_rupees': round(res['pnl_rupees'], 2),
                'max_fav': round(res['max_fav'], 2),
                'max_adv': round(res.get('sl_pts', 30.0), 2),
                'rr': round(res['rr'], 2),
                'lots': 1,
                'qty': 25,
                'vix_chg': round(res['vix_chg'], 2)
            })

tdf = pd.DataFrame(all_trades)
print(f"Total 1-Minute Trades: {len(tdf)}")
pts = tdf['pnl_points']
wr = (pts > 0).mean() * 100
net = pts.sum()
avg = pts.mean()
best = pts.max()
worst = pts.min()
print(f"Win Rate: {wr:.2f}%")
print(f"Total Net Points: {net:.2f}")
print(f"Avg Points / Trade: {avg:.2f}")
print(f"Best Trade: {best:.2f} pts")
print(f"Worst Loss: {worst:.2f} pts")

tdf.to_csv('performance/vix_trend_runner_trades.csv', index=False)
print("Updated performance/vix_trend_runner_trades.csv successfully!")

