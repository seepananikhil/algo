#!/usr/bin/env python3
"""
Simple backtest for midpoint-retrace momentum strategy.

Strategy interpretation used here:
1) Pick a reference candle i and compute midpoint = (high_i + low_i) / 2.
2) If next candle (i+1) breaks reference high -> initial direction LONG.
   If it breaks reference low -> initial direction SHORT.
3) Momentum is considered continuing while each new candle keeps breaking
    the previous candle extreme in the direction of the break.
4) Wait for the first candle that does NOT break previous extreme
    (momentum pause/retrace trigger).
5) From there, wait for a candle that touches midpoint.
   - If that candle closes on direction side of midpoint, trade with initial direction.
   - If it closes on opposite side, trade reverse direction.
6) Exit with reference-candle extreme as stop-loss and 1R target.

This script is intentionally simple and can be tuned further.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd

from midpoint_strategy import backtest_midpoint_strategy


def add_ist_time_columns(trades: pd.DataFrame, input_tz: str = "UTC") -> pd.DataFrame:
    if trades.empty:
        return trades

    out = trades.copy()

    entry_dt = pd.to_datetime(out["entry_time"], errors="coerce")
    exit_dt = pd.to_datetime(out["exit_time"], errors="coerce")

    if getattr(entry_dt.dt, "tz", None) is None:
        entry_dt = entry_dt.dt.tz_localize(input_tz)
    if getattr(exit_dt.dt, "tz", None) is None:
        exit_dt = exit_dt.dt.tz_localize(input_tz)

    entry_ist = entry_dt.dt.tz_convert("Asia/Kolkata")
    exit_ist = exit_dt.dt.tz_convert("Asia/Kolkata")

    out["trade_date_ist"] = entry_ist.dt.strftime("%Y-%m-%d")
    out["entry_time_ist"] = entry_ist.dt.strftime("%H:%M")
    out["exit_time_ist"] = exit_ist.dt.strftime("%H:%M")

    # Avoid floating display artifacts like 22721.000000000004.
    for col in ["entry", "midpoint", "stop", "target", "exit_price", "result_r", "pnl_points"]:
        if col in out.columns:
            out[col] = out[col].round(2)

    simple = out.rename(
        columns={
            "trade_date_ist": "date",
            "entry_time_ist": "entry",
            "entry": "entry_spot",
            "midpoint": "mid_point",
            "stop": "sl_spot",
            "target": "target_spot",
            "exit_time_ist": "exit",
            "exit_price": "exit_spot",
            "pnl_points": "profit_loss",
        }
    )
    simple["option_type"] = simple["side"].map({"LONG": "CALL", "SHORT": "PUT"})
    return simple[[
        "date",
        "mid_point",
        "option_type",
        "entry",
        "entry_spot",
        "sl_spot",
        "target_spot",
        "exit",
        "exit_spot",
        "profit_loss",
    ]]


def load_data(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)
    required = {"timestamp", "open", "high", "low", "close"}
    missing = required - set(df.columns)
    if missing:
        raise ValueError(f"Missing required columns: {sorted(missing)}")

    df["timestamp"] = pd.to_datetime(df["timestamp"], errors="coerce")
    df = df.dropna(subset=["timestamp", "open", "high", "low", "close"]).copy()
    df = df.sort_values("timestamp").reset_index(drop=True)
    return df


def summarize(trades: pd.DataFrame) -> None:
    if trades.empty:
        print("No trades found with current rules.")
        return

    wins = (trades["pnl_points"] > 0).sum()
    total = len(trades)
    win_rate = 100.0 * wins / total
    total_pnl = trades["pnl_points"].sum()
    total_r = trades["result_r"].sum()
    avg_pnl = trades["pnl_points"].mean()
    avg_r = trades["result_r"].mean()

    print("=== Backtest Summary ===")
    print(f"Total trades: {total}")
    print(f"Wins: {wins}")
    print(f"Win rate: {win_rate:.2f}%")
    print(f"Total PnL (points): {total_pnl:.2f}")
    print(f"Average PnL/trade (points): {avg_pnl:.2f}")
    print(f"Total R: {total_r:.2f}")
    print(f"Average R/trade: {avg_r:.2f}")
    print()
    print("Last 10 trades:")
    print(trades.tail(10).to_string(index=False))


def calculate_performance(trades: pd.DataFrame) -> dict:
    if trades.empty:
        return {
            "total_trades": 0,
            "wins": 0,
            "losses": 0,
            "win_rate_pct": 0.0,
            "total_pnl_points": 0.0,
            "avg_pnl_points": 0.0,
            "total_r": 0.0,
            "avg_r": 0.0,
            "best_trade_points": 0.0,
            "worst_trade_points": 0.0,
            "max_trades_per_day": 0,
        }

    wins = int((trades["pnl_points"] > 0).sum())
    losses = int((trades["pnl_points"] < 0).sum())
    total = int(len(trades))
    win_rate = 100.0 * wins / total if total else 0.0

    return {
        "total_trades": total,
        "wins": wins,
        "losses": losses,
        "win_rate_pct": round(win_rate, 2),
        "total_pnl_points": round(float(trades["pnl_points"].sum()), 2),
        "avg_pnl_points": round(float(trades["pnl_points"].mean()), 2),
        "total_r": round(float(trades["result_r"].sum()), 2),
        "avg_r": round(float(trades["result_r"].mean()), 2),
        "best_trade_points": round(float(trades["pnl_points"].max()), 2),
        "worst_trade_points": round(float(trades["pnl_points"].min()), 2),
        "max_trades_per_day": int(trades["entry_time"].str.slice(0, 10).value_counts().max()),
    }


def build_day_review(df: pd.DataFrame, trades: pd.DataFrame) -> pd.DataFrame:
    all_days = pd.Series(df["timestamp"].dt.strftime("%Y-%m-%d").unique(), name="date").sort_values()

    if trades.empty:
        out = pd.DataFrame({"date": all_days})
        out["trade_count"] = 0
        out["day_pnl_points"] = 0.0
        out["status"] = "NO_TRADE"
        out["comment"] = "No trade under current rules"
        return out

    trade_days = trades.copy()
    trade_days["date"] = pd.to_datetime(trade_days["entry_time"], errors="coerce").dt.strftime("%Y-%m-%d")
    daily = (
        trade_days.groupby("date", as_index=False)
        .agg(trade_count=("entry_time", "count"), day_pnl_points=("pnl_points", "sum"))
    )
    daily["day_pnl_points"] = daily["day_pnl_points"].round(2)

    out = pd.DataFrame({"date": all_days})
    out = out.merge(daily, on="date", how="left")
    out["trade_count"] = out["trade_count"].fillna(0).astype(int)
    out["day_pnl_points"] = out["day_pnl_points"].fillna(0.0)
    out["status"] = out["trade_count"].apply(lambda x: "TRADED" if x > 0 else "NO_TRADE")
    out["comment"] = out["status"].map({
        "TRADED": "Trade(s) generated",
        "NO_TRADE": "No trade under current rules",
    })
    return out


def store_performance(
    performance: dict,
    latest_json_path: str,
    history_csv_path: str,
    args: argparse.Namespace,
) -> None:
    latest_path = Path(latest_json_path)
    history_path = Path(history_csv_path)
    latest_path.parent.mkdir(parents=True, exist_ok=True)
    history_path.parent.mkdir(parents=True, exist_ok=True)

    run_record = {
        "run_ts_utc": pd.Timestamp.utcnow().strftime("%Y-%m-%d %H:%M:%S"),
        "input_csv": args.csv,
        "rr": args.rr,
        "max_hold_bars": args.max_hold_bars,
        **performance,
    }

    latest_path.write_text(json.dumps(run_record, indent=2), encoding="utf-8")

    hist_row = pd.DataFrame([run_record])
    if history_path.exists():
        hist_row.to_csv(history_path, mode="a", header=False, index=False)
    else:
        hist_row.to_csv(history_path, index=False)

    print(f"Saved performance (latest): {latest_json_path}")
    print(f"Appended performance history: {history_csv_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Simple midpoint retrace strategy backtest")
    parser.add_argument(
        "--csv",
        default="captured_data/fyers/fyers_spot_1min_extended.csv",
        help="Path to OHLC CSV",
    )
    parser.add_argument("--rr", type=float, default=1.0, help="Risk-reward multiple for target")
    parser.add_argument(
        "--max-hold-bars",
        type=int,
        default=20,
        help="Maximum bars to hold a position before time exit",
    )
    parser.add_argument(
        "--out",
        default="captured_data/fyers/midpoint_backtest_trades.csv",
        help="Output CSV for trade list",
    )
    parser.add_argument(
        "--input-tz",
        default="UTC",
        help="Timezone of input timestamps (default: UTC)",
    )
    parser.add_argument(
        "--perf-out",
        default="performance/midpoint_backtest_performance.json",
        help="Path to save latest performance summary JSON",
    )
    parser.add_argument(
        "--perf-history",
        default="performance/midpoint_backtest_performance_history.csv",
        help="Path to append performance history CSV",
    )
    parser.add_argument(
        "--day-review-out",
        default="performance/midpoint_backtest_day_review.csv",
        help="Path to save day-level review including non-trade days",
    )
    args = parser.parse_args()

    df = load_data(args.csv)
    trades = backtest_midpoint_strategy(df, rr=args.rr, max_hold_bars=args.max_hold_bars)
    trades_export = add_ist_time_columns(trades, input_tz=args.input_tz)

    output_columns = [
        "date",
        "mid_point",
        "option_type",
        "entry",
        "entry_spot",
        "sl_spot",
        "target_spot",
        "exit",
        "exit_spot",
        "profit_loss",
    ]
    if trades_export.empty:
        pd.DataFrame(columns=output_columns).to_csv(args.out, index=False)
    else:
        trades_export.to_csv(args.out, index=False)
    print(f"Saved trades to: {args.out}")

    perf = calculate_performance(trades)
    store_performance(
        performance=perf,
        latest_json_path=args.perf_out,
        history_csv_path=args.perf_history,
        args=args,
    )

    day_review = build_day_review(df, trades)
    day_review_path = Path(args.day_review_out)
    day_review_path.parent.mkdir(parents=True, exist_ok=True)
    day_review.to_csv(day_review_path, index=False)
    print(f"Saved day review: {args.day_review_out}")

    summarize(trades)


if __name__ == "__main__":
    main()
