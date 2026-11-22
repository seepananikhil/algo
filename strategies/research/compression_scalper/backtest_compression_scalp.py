#!/usr/bin/env python3
"""CLI runner for Adaptive Micro-Compression Momentum Scalper (CMS)."""

import argparse
from pathlib import Path
import pandas as pd
from compression_scalp_strategy import backtest_compression_scalp, summarize_scalp_performance

def main():
    parser = argparse.ArgumentParser(description="Backtest Micro-Compression Momentum Scalper")
    parser.add_argument("--csv", default="captured_data/fyers/fyers_spot_1min_extended.csv", help="Input 1-min CSV")
    parser.add_argument("--sl", type=float, default=14.0, help="Stop loss in spot points (default: 14.0)")
    parser.add_argument("--target", type=float, default=20.0, help="Target in spot points (default: 20.0)")
    parser.add_argument("--sl-atr", type=float, default=None, help="Stop loss ATR multiplier (optional)")
    parser.add_argument("--target-atr", type=float, default=None, help="Target ATR multiplier (optional)")
    parser.add_argument("--max-hold", type=int, default=8, help="Max hold bars / minutes (default: 8)")
    parser.add_argument("--max-trades", type=int, default=1, help="Max trades per day (default: 1)")
    parser.add_argument("--stop-on-loss", action="store_true", help="Stop trading for the day after 1 loss")
    parser.add_argument("--out", default="performance/compression_scalp_trades.csv", help="Output trades CSV")
    args = parser.parse_args()

    print(f"Loading data from {args.csv}...")
    df = pd.read_csv(args.csv)
    trades = backtest_compression_scalp(
        df,
        sl_points=args.sl,
        target_points=args.target,
        sl_atr_mult=args.sl_atr,
        target_atr_mult=args.target_atr,
        max_hold_bars=args.max_hold,
        max_trades_per_day=args.max_trades,
        stop_on_loss_day=args.stop_on_loss,
    )
    
    perf = summarize_scalp_performance(trades)
    print("\n================ BACKTEST SUMMARY ================")
    for k, v in perf.items():
        print(f"  {k:22s}: {v}")
    print("==================================================")
    
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    trades.to_csv(args.out, index=False)
    print(f"Trade log successfully written to: {args.out}\n")

if __name__ == "__main__":
    main()
