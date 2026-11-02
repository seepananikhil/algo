import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import argparse
import pandas as pd
from midpoint_strategy import backtest_midpoint_strategy

parser = argparse.ArgumentParser(description="Midpoint 10-Year Backtest")
parser.add_argument("--full", action="store_true", help="Force full re-run instead of incremental delta")
cli_args, _ = parser.parse_known_args()

print("=" * 80)
print(" 10-YEAR MIDPOINT STRATEGY MASTER BACKTEST (2017 - 2026)")
print(" Data Source: https://github.com/technovusin/nifty50-historical-data")
if cli_args.full:
    print(" Mode: FULL RECOMPUTATION (--full)")
else:
    print(" Mode: INCREMENTAL DELTA")
print("=" * 80)

perf_file = ROOT / "performance" / "nifty_10y_midpoint_trades.csv"
latest_date = None
existing_df = pd.DataFrame()

if not cli_args.full and perf_file.exists():
    try:
        prev_df = pd.read_csv(perf_file)
        if not prev_df.empty and "date" in prev_df.columns:
            prev_df["date"] = pd.to_datetime(prev_df["date"]).dt.date
            latest_date = prev_df["date"].max()
            existing_df = prev_df
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

years = sorted(list(set(f.parent.name for f in all_files if f.parent.name.isdigit())))
new_trade_dfs = []
total_days_evaluated = 0

for y in years:
    y_files = sorted([f for f in all_files if f.parent.name == y])
    dfs = []
    for f in y_files:
        df_sub = pd.read_csv(f)
        dfs.append(df_sub)
    if not dfs:
        continue
    
    df_y = pd.concat(dfs, ignore_index=True)
    ts_col = 'Timestamp' if 'Timestamp' in df_y.columns else 'timestamp'
    df_y['timestamp'] = pd.to_datetime(df_y[ts_col])
    df_y.rename(columns={
        'Open': 'open',
        'High': 'high',
        'Low': 'low',
        'Close': 'close',
        'Volume': 'volume',
        'open': 'open',
        'high': 'high',
        'low': 'low',
        'close': 'close',
    }, inplace=True)
    df_y = df_y.dropna(subset=['timestamp', 'open', 'high', 'low', 'close'])
    df_y.sort_values('timestamp', inplace=True)
    df_y.drop_duplicates('timestamp', inplace=True)
    df_y.reset_index(drop=True, inplace=True)

    if latest_date:
        df_y = df_y[df_y['timestamp'].dt.date > latest_date].copy().reset_index(drop=True)
        if df_y.empty:
            continue

    total_days_evaluated += len(df_y['timestamp'].dt.date.unique())
    t_df = backtest_midpoint_strategy(df_y)
    if not t_df.empty:
        t_df['date'] = pd.to_datetime(t_df['entry_time']).dt.strftime('%Y-%m-%d')
        t_df['entry_str'] = pd.to_datetime(t_df['entry_time']).dt.strftime('%H:%M')
        t_df['exit_str'] = pd.to_datetime(t_df['exit_time']).dt.strftime('%H:%M')
        
        wins = len(t_df[t_df['pnl_points'] > 0])
        total = len(t_df)
        pts = t_df['pnl_points'].sum()
        wr = (wins / total * 100) if total else 0
        new_trade_dfs.append(t_df)
        print(f"Year {y}: {total} trades | Win Rate: {wr:.1f}% | Net Pts: {pts:+.1f}")

if latest_date and total_days_evaluated == 0:
    print(f"Already 100% up to date through {latest_date}. No delta backtest needed.")
    sys.exit(0)

if new_trade_dfs:
    combined_new = pd.concat(new_trade_dfs, ignore_index=True)
    new_export = pd.DataFrame({
        'date': combined_new['date'],
        'side': combined_new['side'],
        'entry_time': combined_new['entry_str'],
        'entry_price': combined_new['entry'].round(2),
        'sl': combined_new['stop'].round(2),
        'target': combined_new['target'].round(2),
        'exit_time': combined_new['exit_str'],
        'exit_price': combined_new['exit_price'].round(2),
        'reason': combined_new['reason'],
        'pnl_points': combined_new['pnl_points'].round(2),
        'bars_held': combined_new['bars_held'],
        'result_r': combined_new['result_r'].round(2),
    })
else:
    new_export = pd.DataFrame()

if not existing_df.empty and not new_export.empty:
    existing_df['date'] = existing_df['date'].astype(str)
    new_export['date'] = new_export['date'].astype(str)
    final_df = pd.concat([existing_df, new_export], ignore_index=True)
elif not new_export.empty:
    final_df = new_export
else:
    final_df = existing_df

if not final_df.empty:
    final_df['date'] = final_df['date'].astype(str)
    final_df.drop_duplicates(subset=['date', 'entry_time', 'side'], inplace=True)
    (ROOT / "performance").mkdir(exist_ok=True)
    final_df.to_csv(perf_file, index=False)
    print(f"Saved {len(final_df)} trades to {perf_file} ({len(new_export)} newly added)")
