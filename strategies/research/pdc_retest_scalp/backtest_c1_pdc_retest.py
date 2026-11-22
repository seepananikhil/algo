#!/usr/bin/env python3
"""
Backtest Runner for C1 Color + PDC Break & Retest Morning Scalp Strategy.

Usage:
    python backtest_c1_pdc_retest.py
    python backtest_c1_pdc_retest.py --target 35 --stop-buffer 8
"""

from __future__ import annotations

import argparse
import glob
from pathlib import Path
import pandas as pd

from c1_pdc_retest_scalp import backtest_c1_pdc_retest, DEFAULTS


def load_all_candles(archive_path: str = "captured_data/fyers/fyers_spot_1min_extended.csv") -> pd.DataFrame:
    dfs = []
    if Path(archive_path).exists():
        df_arc = pd.read_csv(archive_path)
        dfs.append(df_arc[["timestamp", "open", "high", "low", "close", "volume"]])

    live_files = sorted(glob.glob("captured_data/fyers/live/nifty_1min_2026-10-*.csv"))
    for f in live_files:
        d = pd.read_csv(f)
        if len(d) > 20:
            dfs.append(d[["timestamp", "open", "high", "low", "close", "volume"]])

    combined = pd.concat(dfs, ignore_index=True)
    combined.drop_duplicates(subset=["timestamp"], inplace=True)
    combined.sort_values("timestamp", inplace=True)
    combined.reset_index(drop=True, inplace=True)
    return combined


def print_c1_pdc_report(trades_df: pd.DataFrame, cfg: dict):
    if trades_df.empty:
        print("No trades generated under current rules.")
        return

    trades_df["month"] = trades_df["date"].str[:7]
    wins = trades_df[trades_df["pnl_points"] > 0]
    losses = trades_df[trades_df["pnl_points"] < 0]
    scratch = trades_df[trades_df["pnl_points"] == 0]

    tot_trades = len(trades_df)
    tot_wins = len(wins)
    tot_loss = len(losses)
    win_pct = (tot_wins / tot_trades) * 100
    net_pnl = trades_df["pnl_points"].sum()
    gross_win = wins["pnl_points"].sum()
    gross_loss = abs(losses["pnl_points"].sum())
    pf = gross_win / gross_loss if gross_loss > 0 else 99.0

    trades_df["equity"] = trades_df["pnl_points"].cumsum()
    trades_df["peak"] = trades_df["equity"].cummax()
    trades_df["drawdown"] = trades_df["equity"] - trades_df["peak"]
    max_dd = trades_df["drawdown"].min()

    print("\n" + "=" * 90)
    print(" FIRST CANDLE (C1) + PDC BREAK & RETEST MORNING SCALP REPORT")
    print(f" Target: {cfg.get('target_points', 35)} pts | SL Buffer: {cfg.get('sl_buffer', 8)} pts | Max Hold: {cfg.get('max_hold_bars', 15)}m")
    print("=" * 90)

    print(f"{'MONTH':<10} | {'TRADES':<6} | {'WIN %':<7} | {'WINS':<5} | {'LOSS':<5} | {'NET PTS':<10} | {'AVG WIN':<8} | {'AVG LOSS':<8} | {'PF':<5}")
    print("-" * 90)
    for month, mdf in trades_df.groupby("month"):
        m_win = mdf[mdf["pnl_points"] > 0]
        m_loss = mdf[mdf["pnl_points"] < 0]
        m_wr = (len(m_win) / len(mdf)) * 100
        m_net = mdf["pnl_points"].sum()
        m_gw = m_win["pnl_points"].sum()
        m_gl = abs(m_loss["pnl_points"].sum())
        m_pf = m_gw / m_gl if m_gl > 0 else (99.0 if m_gw > 0 else 0.0)
        avg_w = m_win["pnl_points"].mean() if len(m_win) else 0.0
        avg_l = abs(m_loss["pnl_points"].mean()) if len(m_loss) else 0.0
        print(f"{month:<10} | {len(mdf):<6} | {m_wr:5.1f}%  | {len(m_win):<5} | {len(m_loss):<5} | {m_net:+9.1f} | {avg_w:7.1f}  | {avg_l:7.1f}  | {m_pf:4.2f}")

    print("-" * 90)
    avg_win = wins["pnl_points"].mean() if len(wins) else 0.0
    avg_loss = abs(losses["pnl_points"].mean()) if len(losses) else 0.0
    print(f"{'TOTAL':<10} | {tot_trades:<6} | {win_pct:5.1f}%  | {tot_wins:<5} | {tot_loss:<5} | {net_pnl:+9.1f} | {avg_win:7.1f}  | {avg_loss:7.1f}  | {pf:4.2f}")
    print("=" * 90)

    print(f"Overall Win Rate       : {win_pct:.1f}% ({tot_wins} Wins / {tot_loss} Losses)")
    print(f"Total Net Gain         : {net_pnl:+,.1f} Nifty Spot Points")
    print(f"Profit Factor          : {pf:.2f}")
    print(f"Max Drawdown           : {max_dd:,.1f} points")
    print(f"Average Duration       : {trades_df['bars_held'].mean():.1f} minutes")

    print("\n--- Side Breakdown ---")
    side_summary = (
        trades_df.groupby("side")
        .agg(trades=("pnl_points", "count"), win_rate=("pnl_points", lambda x: f"{(x > 0).mean()*100:.1f}%"), net_pnl=("pnl_points", "sum"))
    )
    print(side_summary.to_string())

    print("\n--- Complete Trade History ---")
    cols = ["date", "side", "pdc", "c1_color", "retest_time", "entry_time", "exit_time", "entry", "stop", "exit_price", "pnl_points", "reason"]
    print(trades_df[cols].to_string(index=False))


def main():
    parser = argparse.ArgumentParser(description="C1 PDC Break & Retest Backtest")
    parser.add_argument("--target", type=float, default=35.0, help="Target points (default: 35.0)")
    parser.add_argument("--stop-buffer", type=float, default=8.0, help="Stop buffer beyond PDC (default: 8.0)")
    parser.add_argument("--retest-buffer", type=float, default=8.0, help="Retest buffer near PDC (default: 8.0)")
    parser.add_argument("--max-hold", type=int, default=15, help="Max hold bars (default: 15)")
    parser.add_argument("--export", type=str, default="performance/c1_pdc_retest_trades.csv", help="CSV export path")
    args = parser.parse_args()

    cfg = {
        "target_points": args.target,
        "sl_buffer": args.stop_buffer,
        "retest_buffer": args.retest_buffer,
        "max_hold_bars": args.max_hold,
    }

    print("Loading candles across full dataset...")
    all_df = load_all_candles()
    trades_df = backtest_c1_pdc_retest(all_df, config=cfg)
    print_c1_pdc_report(trades_df, cfg)

    if not trades_df.empty and args.export:
        export_p = Path(args.export)
        export_p.parent.mkdir(parents=True, exist_ok=True)
        trades_df.to_csv(export_p, index=False)
        print(f"\n[OK] Exported {len(trades_df)} trade logs to {export_p}")


if __name__ == "__main__":
    main()
