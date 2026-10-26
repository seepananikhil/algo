import sys
sys.path.insert(0, "D:/nikhil/algo")
import pandas as pd
import numpy as np
from pathlib import Path
from trend_runner_paper import TrendRunnerPaperEngine

print("=" * 80)
print(" 10-YEAR NIFTY 1-MINUTE MASTER BACKTEST (2017 - 2026)")
print(" Data Source: https://github.com/technovusin/nifty50-historical-data")
print(" Strategy: Trend Runner with Symmetric Trade 2 Re-entry & 30-min Cool-off")
print("=" * 80)

# Load 10-Year VIX Data
vix_path = Path('captured_data/india_vix_10y.csv')
if not vix_path.exists():
    print("Error: 10-year VIX data missing!")
    sys.exit(1)

vix_df = pd.read_csv(vix_path)
vix_df['date'] = pd.to_datetime(vix_df['date']).dt.date
vix_map = dict(zip(vix_df['date'], vix_df['vix_change_pct']))

# Discover all 1-minute CSVs from 2017 to 2026
base_dir = Path("captured_data/technovusin_nifty50/1min")
all_files = sorted(base_dir.rglob("*.csv"))
print(f"\nFound {len(all_files)} 1-minute historical data files across all years.")

# Initialize strategy engine with locked production settings
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
    call_cutoff_time="10:30",
    allow_call_reentry=True,
    reentry_cooloff_bars=30,
    log_trades=False,
)

all_trades = []
yearly_stats = []

# Group files by year
years = sorted(list(set(f.parent.name for f in all_files if f.parent.name.isdigit())))

for y in years:
    y_files = sorted([f for f in all_files if f.parent.name == y])
    dfs = []
    for f in y_files:
        df_sub = pd.read_csv(f)
        dfs.append(df_sub)
    
    df_y = pd.concat(dfs, ignore_index=True)
    df_y.rename(columns={
        'Timestamp': 'timestamp',
        'Open': 'open',
        'High': 'high',
        'Low': 'low',
        'Close': 'close'
    }, inplace=True)

    df_y['timestamp'] = pd.to_datetime(df_y['timestamp'])
    df_y.sort_values('timestamp', inplace=True)
    df_y.drop_duplicates('timestamp', inplace=True)
    df_y.reset_index(drop=True, inplace=True)
    df_y['date'] = df_y['timestamp'].dt.date
    df_y['time_str'] = df_y['timestamp'].dt.strftime('%H:%M')

    tp = (df_y['high'] + df_y['low'] + df_y['close']) / 3.0
    df_y['vwap'] = tp.groupby(df_y['date']).expanding().mean().reset_index(level=0, drop=True)
    df_y['atr14'] = 30.0

    days = sorted(df_y['date'].unique())
    y_trades = []

    for d in days:
        g = df_y[df_y['date'] == d].copy().reset_index(drop=True)
        if len(g) < 150:
            continue

        engine.trades_today = 0
        engine.active_position = None
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

        vix_chg = vix_map.get(d, 0.0)
        or_bars = g[(g['time_str'] >= '09:15') & (g['time_str'] <= '09:30')]
        or_high = float(or_bars['high'].max()) if not or_bars.empty else float(g.iloc[:15]['high'].max())
        or_low = float(or_bars['low'].min()) if not or_bars.empty else float(g.iloc[:15]['low'].min())
        or_range = or_high - or_low

        if or_range < 30.0:
            continue

        for idx in range(len(g)):
            row = g.iloc[idx]
            next_open = float(g.iloc[idx + 1]['open']) if idx + 1 < len(g) else None
            res = engine.evaluate_bar(row, or_high, or_low, or_range, vix_chg, next_bar_open=next_open)
            if res:
                y_trades.append(res)
                all_trades.append(res)

    tdf_y = pd.DataFrame(y_trades)
    if not tdf_y.empty:
        w = tdf_y[tdf_y['pnl_points'] > 0]
        l = tdf_y[tdf_y['pnl_points'] < 0]
        tot = len(tdf_y)
        net_pts = tdf_y['pnl_points'].sum()
        wr = len(w) / tot * 100
        pf = (w['pnl_points'].sum() / abs(l['pnl_points'].sum())) if not l.empty else 999.0
        best = tdf_y['pnl_points'].max()
        yearly_stats.append({
            "Year": y,
            "Days": len(days),
            "Trades": tot,
            "Wins": len(w),
            "Losses": len(l),
            "Win Rate": f"{wr:.1f}%",
            "Net Points": round(net_pts, 1),
            "Profit Factor": round(pf, 2),
            "Futures (Rs)": round(net_pts * 25, 0),
            "Best Win": round(best, 1),
        })
        print(f"[{y}] Days: {len(days):3d} | Trades: {tot:3d} | Win Rate: {wr:4.1f}% | Net Pts: {net_pts:+8.1f} | PF: {pf:4.2f}")

# Summary Table
df_yearly = pd.DataFrame(yearly_stats)
df_all = pd.DataFrame(all_trades)

# Save trades to CSV
Path("performance").mkdir(exist_ok=True)
df_all.to_csv("performance/nifty_10y_backtest_trades.csv", index=False)

print("\n" + "=" * 80)
print(" 10-YEAR YEAR-BY-YEAR PERFORMANCE BREAKDOWN")
print("=" * 80)
print(df_yearly.to_string(index=False))

# Calculate Overall 10-Year Stats
w_all = df_all[df_all['pnl_points'] > 0]
l_all = df_all[df_all['pnl_points'] < 0]
tot_all = len(df_all)
net_all = df_all['pnl_points'].sum()
wr_all = len(w_all) / tot_all * 100
pf_all = (w_all['pnl_points'].sum() / abs(l_all['pnl_points'].sum())) if not l_all.empty else 999.0

cum = df_all['pnl_points'].cumsum()
peak = cum.cummax()
dd = (cum - peak).min()

print("\n" + "=" * 80)
print(" 10-YEAR CUMULATIVE MASTER SUMMARY (2017 - 2026)")
print("=" * 80)
print(f" Total Trades       : {tot_all:,}")
print(f" Winning Trades     : {len(w_all):,} ({wr_all:.2f}%)")
print(f" Losing Trades      : {len(l_all):,} ({100 - wr_all:.2f}%)")
print(f" Total Net Points   : {net_all:+,.1f} points")
print(f" Futures PnL (1 Lot): Rs {net_all * 25:+,.0f}")
print(f" ITM-150 PnL (1 Lot): Rs {net_all * 0.70 * 25:+,.0f}")
print(f" Profit Factor      : {pf_all:.2f}")
print(f" Max Drawdown       : {dd:.1f} points (-Rs {abs(dd)*25:,.0f})")
print(f" Avg Return / Trade : {net_all / tot_all:+.2f} points")
print(f" Saved full trade log to: performance/nifty_10y_backtest_trades.csv")
print("=" * 80)
