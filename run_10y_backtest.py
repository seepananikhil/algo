import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import argparse
import pandas as pd
import numpy as np
from trend_runner_paper import TrendRunnerPaperEngine

parser = argparse.ArgumentParser(description="10-Year Nifty 1-Minute Master Backtest")
parser.add_argument("--full", action="store_true", help="Force full 10-year re-run instead of incremental delta")
cli_args, _ = parser.parse_known_args()

print("=" * 80)
print(" 10-YEAR NIFTY 1-MINUTE MASTER BACKTEST (2017 - 2026)")
print(" Data Source: https://github.com/technovusin/nifty50-historical-data")
print(" Strategy: Trend Runner with Symmetric Trade 2 Re-entry & 30-min Cool-off")
if cli_args.full:
    print(" Mode: FULL RECOMPUTATION (--full)")
else:
    print(" Mode: INCREMENTAL DELTA")
print("=" * 80)

# Load 10-Year VIX Data
vix_path = ROOT / 'captured_data' / 'india_vix_10y.csv'
if not vix_path.exists():
    print("Error: 10-year VIX data missing!")
    sys.exit(1)

vix_df = pd.read_csv(vix_path)
vix_df['date'] = pd.to_datetime(vix_df['date']).dt.date
vix_map = dict(zip(vix_df['date'], vix_df['vix_change_pct']))
vix_lvl_map = dict(zip(vix_df['date'], vix_df['close']))

# Check existing performance file for incremental delta
perf_file = ROOT / "performance" / "nifty_10y_backtest_trades.csv"
latest_date = None
existing_trades = []

if not cli_args.full and perf_file.exists():
    try:
        prev_df = pd.read_csv(perf_file)
        if not prev_df.empty and "date" in prev_df.columns:
            prev_df["date"] = pd.to_datetime(prev_df["date"]).dt.date
            latest_date = prev_df["date"].max()
            existing_trades = prev_df.to_dict(orient="records")
            print(f"Incremental delta mode: existing backtest covers through {latest_date}")
    except Exception as exc:
        print(f"Warning reading existing backtest: {exc}")

base_dir = ROOT / "captured_data" / "technovusin_nifty50" / "1min"
all_files = sorted(base_dir.rglob("*.csv"))

if latest_date:
    latest_ym = latest_date.strftime("%Y-%m")
    filtered = []
    for f in all_files:
        try:
            f_year = int(f.parent.name)
            if f_year < latest_date.year:
                continue
        except ValueError:
            pass
        stem = f.stem
        parts = stem.split("_")
        if len(parts) >= 3 and "-" in parts[-1]:
            ym = parts[-1]
            if ym < latest_ym:
                continue
        filtered.append(f)
    all_files = filtered

print(f"Historical files to process: {len(all_files)}")

# Initialize strategy engine
engine = TrendRunnerPaperEngine(
    sl_points=30.0,
    reentry_sl_points=30.0,
    reentry=True,
    max_trades_per_day=2,
    be_trigger=40.0, be_lock=5.0,
    r1_trigger=70.0, r1_lock=20.0,
    r2_trigger=130.0, r2_lock=60.0,
    r3_trigger=180.0, r3_lock=110.0,
    r4_trigger=230.0, r4_lock=165.0,
    r5_trigger=280.0, r5_lock=220.0,
    r6_trigger=330.0, r6_lock=270.0,
    target_pts=None,
    call_cutoff_time="10:15",
    sizing_mode="dynamic",
    allow_call_reentry=True,
    reentry_cooloff_bars=30,
    log_trades=False,
)

all_trades = list(existing_trades)
new_trades = []
yearly_stats = []
total_days_evaluated = 0

years = sorted(list(set(f.parent.name for f in all_files if f.parent.name.isdigit())))

for y in years:
    y_files = sorted([f for f in all_files if f.parent.name == y])
    dfs = []
    for f in y_files:
        df_sub = pd.read_csv(f)
        dfs.append(df_sub)
    if not dfs:
        continue
    
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

    if latest_date:
        df_y = df_y[df_y['date'] > latest_date].copy().reset_index(drop=True)
        if df_y.empty:
            continue

    tp = (df_y['high'] + df_y['low'] + df_y['close']) / 3.0
    cum_tp = tp.groupby(df_y['date']).cumsum()
    counts = df_y.groupby(df_y['date']).cumcount() + 1
    df_y['vwap'] = cum_tp / counts
    df_y['atr14'] = 30.0

    days = sorted(df_y['date'].unique())
    y_trades = []

    for d in days:
        if d.weekday() >= 5:
            continue
        total_days_evaluated += 1

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
        vix_lvl = vix_lvl_map.get(d, 15.0)
        or_bars = g[(g['time_str'] >= '09:15') & (g['time_str'] <= '09:30')]
        or_high = float(or_bars['high'].max()) if not or_bars.empty else float(g.iloc[:15]['high'].max())
        or_low = float(or_bars['low'].min()) if not or_bars.empty else float(g.iloc[:15]['low'].min())
        or_range = or_high - or_low

        if or_range < 30.0:
            continue

        for idx in range(len(g)):
            row = g.iloc[idx]
            next_open = float(g.iloc[idx + 1]['open']) if idx + 1 < len(g) else None
            res = engine.evaluate_bar(row, or_high, or_low, or_range, vix_chg, next_bar_open=next_open, vix_level=vix_lvl)
            if res:
                y_trades.append(res)
                all_trades.append(res)
                new_trades.append(res)

    tdf_y = pd.DataFrame(y_trades)
    if not tdf_y.empty:
        w = tdf_y[tdf_y['pnl_points'] > 0]
        l = tdf_y[tdf_y['pnl_points'] < 0]
        tot = len(tdf_y)
        net_pts = tdf_y['pnl_points'].sum()
        weighted_pts = tdf_y['weighted_pnl_points'].sum() if 'weighted_pnl_points' in tdf_y else net_pts
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
            "1-Lot Pts": round(net_pts, 1),
            "Dyn Pts": round(weighted_pts, 1),
            "Dyn Profit (Rs)": round(weighted_pts * 25, 0),
            "PF": round(pf, 2),
            "Best Win": round(best, 1),
        })
        print(f"[{y}] Days: {len(days):3d} | Trades: {tot:3d} | Win Rate: {wr:4.1f}% | 1-Lot Pts: {net_pts:+8.1f} | Dyn Pts: {weighted_pts:+8.1f} | PF: {pf:4.2f}")

# Check delta completion
if latest_date and total_days_evaluated == 0:
    print(f"Already 100% up to date through {latest_date}. No delta backtest needed.")
    sys.exit(0)

# Summary Table & Save
df_yearly = pd.DataFrame(yearly_stats)
df_all = pd.DataFrame(all_trades)
if not df_all.empty and 'date' in df_all.columns:
    df_all['date'] = pd.to_datetime(df_all['date']).dt.strftime('%Y-%m-%d')
    subset_cols = ['date', 'trade_num', 'entry_time']
    subset_cols = [c for c in subset_cols if c in df_all.columns]
    df_all.drop_duplicates(subset=subset_cols, inplace=True)

(ROOT / "performance").mkdir(exist_ok=True)
df_all.to_csv(perf_file, index=False)
print(f"Saved {len(df_all)} trades to {perf_file} ({len(new_trades)} newly added)")

if not df_yearly.empty:
    print("\n" + "=" * 80)
    print(" PERFORMANCE BREAKDOWN")
    print("=" * 80)
    print(df_yearly.to_string(index=False))

w_all = df_all[df_all['pnl_points'] > 0]
l_all = df_all[df_all['pnl_points'] < 0]
tot_all = len(df_all)
net_all = df_all['pnl_points'].sum()
wr_all = len(w_all) / tot_all * 100 if tot_all else 0.0
pf_all = (w_all['pnl_points'].sum() / abs(l_all['pnl_points'].sum())) if not l_all.empty else 999.0

cum = df_all['pnl_points'].cumsum()
peak = cum.cummax()
dd = (cum - peak).min()

print("\n" + "=" * 80)
print(f" CUMULATIVE MASTER SUMMARY ({len(df_all)} trades)")
print("=" * 80)
print(f" Total Trades       : {tot_all:,}")
print(f" Winning Trades     : {len(w_all):,} ({wr_all:.2f}%)")
print(f" Losing Trades      : {len(l_all):,} ({100 - wr_all:.2f}%)")
print(f" Total Net Points   : {net_all:+,.1f} points")
print(f" Futures PnL (1 Lot): Rs {net_all * 25:+,.0f}")
print(f" ITM-150 PnL (1 Lot): Rs {net_all * 0.70 * 25:+,.0f}")
print(f" Profit Factor      : {pf_all:.2f}")
print(f" Max Drawdown       : {dd:.1f} points (-Rs {abs(dd)*25:,.0f})")
print("=" * 80)
