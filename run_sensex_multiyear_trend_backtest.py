import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import argparse
import pandas as pd
import numpy as np
from trend_runner_paper import TrendRunnerPaperEngine

parser = argparse.ArgumentParser(description="Sensex Multi-Year Backtest")
parser.add_argument("--full", action="store_true", help="Force full multi-year re-run instead of incremental delta")
cli_args, _ = parser.parse_known_args()

print("=" * 80)
print(" SENSEX MULTI-YEAR 1-MINUTE MASTER BACKTEST (2023 - 2026)")
print(" Data Source: https://github.com/technovusin/sensex-historical-data")
print(" Strategy: Sensex Trend Runner with Dynamic Scaling & Ratchets")
if cli_args.full:
    print(" Mode: FULL RECOMPUTATION (--full)")
else:
    print(" Mode: INCREMENTAL DELTA")
print("=" * 80)

# Load 10-Year VIX Data
vix_path = ROOT / 'captured_data' / 'india_vix_10y.csv'
vix_df = pd.read_csv(vix_path)
vix_df['date'] = pd.to_datetime(vix_df['date']).dt.date
vix_map = dict(zip(vix_df['date'], vix_df['vix_change_pct']))
vix_lvl_map = dict(zip(vix_df['date'], vix_df['close']))

perf_file = ROOT / "performance" / "sensex_backtest_trades.csv"
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

base_dir = ROOT / "captured_data" / "technovusin_sensex" / "1min"
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

# Sensex parameters scaled proportionally (~3.3x to 4x Nifty point scale)
engine = TrendRunnerPaperEngine(
    symbol="SENSEX",
    sl_points=120.0,
    be_trigger=120.0,
    be_lock=15.0,
    reentry_sl_points=120.0,
    sl_mode="fixed",
    reentry=True,
    max_trades_per_day=2,
    r1_trigger=280.0, r1_lock=80.0,
    r2_trigger=520.0, r2_lock=240.0,
    r3_trigger=720.0, r3_lock=440.0,
    r4_trigger=920.0, r4_lock=660.0,
    r5_trigger=1120.0, r5_lock=880.0,
    r6_trigger=1320.0, r6_lock=1080.0,
    target_pts=None,
    call_cutoff_time="10:45",
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
    df_y['atr14'] = 120.0

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

        if or_range < 80.0:
            continue

        for idx in range(len(g)):
            row = g.iloc[idx]
            next_open = float(g.iloc[idx + 1]['open']) if idx + 1 < len(g) else None
            res = engine.evaluate_bar(row, or_high, or_low, or_range, vix_chg, next_bar_open=next_open, vix_level=vix_lvl)
            if res:
                lot_size = 20
                strike = int(round(res['entry_price'] / 100.0) * 100)
                opt_type = "CE" if res['side'] in ("LONG", "CALL") else "PE"
                res['option'] = f"SENSEX {strike} {opt_type} (ATM)"
                res['side'] = "CALL" if res['side'] in ("LONG", "CALL") else "PUT"
                res['sl'] = res.get('initial_sl')
                res['target'] = round(res['entry_price'] + (700.0 if res['side'] == 'CALL' else -700.0), 2)
                res['option_pnl_rupees'] = round(res['pnl_points'] * 0.70 * res.get('total_lots', 1) * lot_size, 2)
                res['pnl_rupees'] = res['option_pnl_rupees']
                res['futures_pnl_rupees'] = round(res.get('weighted_pnl_points', res['pnl_points']) * lot_size, 2)
                y_trades.append(res)
                all_trades.append(res)
                new_trades.append(res)

    tdf_y = pd.DataFrame(y_trades)
    if not tdf_y.empty:
        w = tdf_y[tdf_y['pnl_points'] > 0]
        l = tdf_y[tdf_y['pnl_points'] < 0]
        tot = len(tdf_y)
        net_pts = tdf_y['pnl_points'].sum()
        wr = len(w) / tot * 100
        pf = (w['pnl_points'].sum() / abs(l['pnl_points'].sum())) if not l.empty else 999.0
        yearly_stats.append({
            "Year": y,
            "Trades": tot,
            "Wins": len(w),
            "WinRate": f"{wr:.1f}%",
            "NetPoints": f"{net_pts:+,.1f}",
            "NetPnL_Rs": f"{net_pts * 20:+,.0f}",
            "ProfitFactor": f"{pf:.2f}",
        })

if latest_date and total_days_evaluated == 0:
    print(f"Already 100% up to date through {latest_date}. No delta backtest needed.")
    sys.exit(0)

out_df = pd.DataFrame(all_trades)
if not out_df.empty and 'date' in out_df.columns:
    out_df['date'] = pd.to_datetime(out_df['date']).dt.strftime('%Y-%m-%d')
    subset_cols = ['date', 'trade_num', 'entry_time']
    subset_cols = [c for c in subset_cols if c in out_df.columns]
    out_df.drop_duplicates(subset=subset_cols, inplace=True)

(ROOT / "performance").mkdir(exist_ok=True)
out_df.to_csv(perf_file, index=False)
print(f"Saved {len(out_df)} Sensex backtest trades to {perf_file} ({len(new_trades)} newly added)")
