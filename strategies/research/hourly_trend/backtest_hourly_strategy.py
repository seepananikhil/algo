#!/usr/bin/env python3
"""
CLI Runner for Institutional 1-Hour Compression Trend Strategy.
Saves trades to performance/hourly_trend_trades.csv.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import pandas as pd
from hourly_trend_strategy import backtest_hourly_strategy

ROOT = Path(__file__).resolve().parent
DEFAULT_CSV = ROOT / "captured_data" / "fyers" / "nifty_1hr.csv"
OUTPUT_FILE = ROOT / "performance" / "hourly_trend_trades.csv"

def run_backtest(csv_path: Path, sl_pts: float = 70.0, tgt_pts: float = 140.0, max_hold: int = 5, start_year: int = 2026):
    print("=" * 60)
    print("  INSTITUTIONAL 1-HOUR COMPRESSION TREND STRATEGY")
    print(f"  SL: {sl_pts} pts | Target: {tgt_pts} pts | Max Hold: {max_hold} bars ({max_hold}h)")
    print("=" * 60)
    
    df = pd.read_csv(csv_path)
    df["timestamp"] = pd.to_datetime(df["timestamp"])
    df = df.sort_values("timestamp").reset_index(drop=True)
    if start_year:
        df = df[df["timestamp"].dt.year >= start_year].reset_index(drop=True)
        
    trades_df = backtest_hourly_strategy(
        df,
        sl_points=70.0,
        target_points=150.0,
        sl_mult=1.0,
        target_mult=2.0,
        max_hold_bars=max_hold,
        max_trades_per_day=1,
        slippage_points=1.0,
        intraday_only=True
    )
    
    OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    trades_df.to_csv(OUTPUT_FILE, index=False)
    
    n = len(trades_df)
    wins = trades_df[trades_df["pnl_points"] > 0]
    losses = trades_df[trades_df["pnl_points"] <= 0]
    total_pts = trades_df["pnl_points"].sum()
    
    cum = trades_df["pnl_points"].cumsum()
    max_dd = (cum - cum.cummax()).min()
    
    lot_size = 65
    delta = 0.50
    pnl_1lot = total_pts * delta * lot_size
    dd_1lot = abs(max_dd) * delta * lot_size
    
    print(f"Total Trades:       {n}")
    print(f"Win Rate:           {len(wins) / n * 100:.2f}%")
    print(f"Average Win:        +{wins['pnl_points'].mean():.2f} pts (+Rs {wins['pnl_points'].mean()*delta*lot_size:.0f})")
    print(f"Average Loss:       -{abs(losses['pnl_points'].mean()):.2f} pts (-Rs {abs(losses['pnl_points'].mean())*delta*lot_size:.0f})")
    print(f"Total Net Points:   +{total_pts:.2f} pts")
    print(f"Total Net P&L (1L): +Rs {pnl_1lot:,.2f}")
    print(f"Max Drawdown (1L):  -Rs {dd_1lot:,.2f}")
    print(f"Trades written to:  {OUTPUT_FILE}")
    print("=" * 60)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", type=str, default=str(DEFAULT_CSV))
    parser.add_argument("--sl", type=float, default=70.0)
    parser.add_argument("--target", type=float, default=140.0)
    parser.add_argument("--hold", type=int, default=5)
    parser.add_argument("--year", type=int, default=2026)
    args = parser.parse_args()
    
    run_backtest(Path(args.csv), sl_pts=args.sl, tgt_pts=args.target, max_hold=args.hold, start_year=args.year)
