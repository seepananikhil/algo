#!/usr/bin/env python3
"""Sensex Key Levels S&R (Fade + Reverse) — Live Paper Forward Trading Engine & Replay Simulator.

Key Strategy Architecture:
- Instrument: BSE SENSEX Index (ATM / 1-lot Options: 10 qty)
- Timeframe: 1-minute bars
- Parameters:
    * Approach: >= 100 points
    * Touch Tolerance: <= 5 points of level
    * Touch 1: Fade (Resistance if from below, Support if from above)
    * Stop Loss: 35 points (anchored beyond level)
    * Target: 120 points
    * Reverse Retry: When Touch 1 stops out, immediately flip direction with 35 SL / 120 TP
    * 30-Min Lockout: No same fade trade for 30 minutes after taking profit
    * Touch 2 Breakout: If price returns within 30m, enter breakout on confirmed close
- Live Logs:
    * captured_data/fyers/live/sensex_key_levels_live_paper.csv
    * performance/sensex_key_levels_paper_trades.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone, time as dt_time
from pathlib import Path
from typing import Optional, Dict, Any, List

import numpy as np
import pandas as pd

IST = timezone(timedelta(hours=5, minutes=30))
ROOT = Path(__file__).resolve().parent
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
PERF_DIR = ROOT / "performance"
PERF_DIR.mkdir(parents=True, exist_ok=True)
LIVE_DIR.mkdir(parents=True, exist_ok=True)

PAPER_LOG_CSV = PERF_DIR / "sensex_key_levels_paper_trades.csv"
LIVE_PAPER_CSV = LIVE_DIR / "sensex_key_levels_live_paper.csv"

LOT_SIZE = 10  # Sensex lot size


def load_live_sensex_bars(date_str: str) -> pd.DataFrame:
    """Load latest 1-min Sensex bars from live CSV."""
    fpath = LIVE_DIR / f"sensex_1min_{date_str}.csv"
    if not fpath.exists():
        return pd.DataFrame()
    try:
        df = pd.read_csv(fpath)
        col_map = {"Timestamp": "timestamp", "Open": "open", "High": "high", "Low": "low", "Close": "close"}
        df = df.rename(columns={k: v for k, v in col_map.items() if k in df.columns})
        df["timestamp"] = pd.to_datetime(df["timestamp"].astype(str).str.replace("T", " "))
        df["time"] = df["timestamp"].dt.time
        df["date"] = df["timestamp"].dt.date
        return df.sort_values("timestamp").reset_index(drop=True)
    except Exception:
        return pd.DataFrame()


def simulate_day_trades(
    day_df: pd.DataFrame,
    step: int = 500,
    approach_min: int = 100,
    sl: int = 25,
    max_entry_dist: int = 25,
    tp: int = 120,
    rev_tp: int = 180,
    rev_trail_trigger: int = 0,
    rev_trail_lock: int = 0,
    lockout_mins: int = 30,
) -> list:
    """Run exact strategy logic on a single day's 1-min DataFrame."""
    if len(day_df) < 10:
        return []

    times = day_df["time"].values
    tss = day_df["timestamp"].values
    opens = day_df["open"].values
    highs = day_df["high"].values
    lows = day_df["low"].values
    closes = day_df["close"].values
    date = day_df["date"].iloc[0]

    trades = []
    active_trade = None
    level_state = {}

    t_cutoff_eod = dt_time(15, 15)
    t_entry_start = dt_time(9, 30)
    t_entry_end = dt_time(14, 30)

    for i in range(1, len(day_df)):
        t = times[i]
        ts = tss[i]
        o, h, l, c = opens[i], highs[i], lows[i], closes[i]

        if t >= t_cutoff_eod:
            if active_trade is not None:
                exit_p = c
                pnl = (exit_p - active_trade["entry_price"]) if active_trade["side"] == "BUY" else (active_trade["entry_price"] - exit_p)
                active_trade.update({"exit_ts": ts, "exit_price": round(exit_p, 2), "pnl_points": round(pnl, 2), "exit_reason": "EOD"})
                trades.append(active_trade)
                active_trade = None
            break

        # 1. Manage Active Trade
        if active_trade is not None:
            side = active_trade["side"]
            lvl = active_trade["level"]
            ttype = active_trade["type"]
            entry_p = active_trade["entry_price"]
            trade_sl = active_trade["sl"]
            trade_tp = active_trade["tp"]

            # Trailing SL on Reverse Retry: lock in profit once +rev_trail_trigger is reached
            if ttype == "REVERSE_RETRY" and rev_trail_trigger > 0:
                cur_favorable = (h - entry_p) if side == "BUY" else (entry_p - l)
                if cur_favorable >= rev_trail_trigger:
                    new_sl = (entry_p + rev_trail_lock) if side == "BUY" else (entry_p - rev_trail_lock)
                    if side == "BUY" and new_sl > trade_sl:
                        trade_sl = new_sl
                        active_trade["sl"] = trade_sl
                        active_trade["trailed"] = True
                    elif side == "SELL" and new_sl < trade_sl:
                        trade_sl = new_sl
                        active_trade["sl"] = trade_sl
                        active_trade["trailed"] = True

            exited = False
            exit_p = None
            exit_reason = None

            if side == "BUY":
                if h >= trade_tp:
                    exited = True
                    exit_p = trade_tp
                    exit_reason = "TARGET"
                elif l <= trade_sl:
                    exited = True
                    exit_p = trade_sl
                    exit_reason = "TRAIL_STOP" if active_trade.get("trailed") else "STOP_LOSS"
            else:
                if l <= trade_tp:
                    exited = True
                    exit_p = trade_tp
                    exit_reason = "TARGET"
                elif h >= trade_sl:
                    exited = True
                    exit_p = trade_sl
                    exit_reason = "TRAIL_STOP" if active_trade.get("trailed") else "STOP_LOSS"

            if exited:
                pnl = (exit_p - entry_p) if side == "BUY" else (entry_p - exit_p)
                active_trade.update({"exit_ts": ts, "exit_price": round(exit_p, 2), "pnl_points": round(pnl, 2), "exit_reason": exit_reason})
                trades.append(active_trade)

                st = level_state.get(lvl)
                if st:
                    if exit_reason == "TARGET":
                        st["status"] = "TOUCH1_PROFIT"
                        st["profit_ts"] = pd.to_datetime(ts)
                        st["pullback"] = False
                    else:
                        st["status"] = "TOUCH1_STOPPED"

                # Reverse Retry if stopped out
                if "TOUCH1" in ttype and exit_reason == "STOP_LOSS" and t < t_entry_end:
                    rev_side = "SELL" if side == "BUY" else "BUY"
                    rev_entry = exit_p
                    rev_sl_price = (rev_entry - sl) if rev_side == "BUY" else (rev_entry + sl)
                    rev_target = rev_tp if rev_tp is not None else tp
                    rev_tp_price = (rev_entry + rev_target) if rev_side == "BUY" else (rev_entry - rev_target)
                    active_trade = {
                        "symbol": "SENSEX",
                        "date": str(date),
                        "entry_ts": ts,
                        "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                        "level": lvl,
                        "type": "REVERSE_RETRY",
                        "side": rev_side,
                        "entry_price": round(rev_entry, 2),
                        "sl": round(rev_sl_price, 2),
                        "tp": round(rev_tp_price, 2),
                        "trailed": False,
                    }
                    continue
                else:
                    active_trade = None

        # 2. Check Level Setups
        min_l = int((c - 300) // step * step)
        max_l = int((c + 300) // step * step) + step

        for lvl in range(min_l, max_l + 1, step):
            st = level_state.get(lvl)

            in_lockout = False
            if st and st.get("status") == "TOUCH1_PROFIT":
                mins = (pd.to_datetime(ts) - st["profit_ts"]).total_seconds() / 60.0
                if mins < lockout_mins:
                    in_lockout = True

            if not in_lockout:
                if c <= lvl - approach_min:
                    if st is None or st["status"] in ["DONE", "EXPIRED", "TOUCH1_STOPPED"]:
                        level_state[lvl] = {"origin": "BELOW", "status": "ARMED", "profit_ts": None, "pullback": False}
                elif c >= lvl + approach_min:
                    if st is None or st["status"] in ["DONE", "EXPIRED", "TOUCH1_STOPPED"]:
                        level_state[lvl] = {"origin": "ABOVE", "status": "ARMED", "profit_ts": None, "pullback": False}

            st = level_state.get(lvl)
            if not st:
                continue

            origin = st["origin"]
            status = st["status"]

            # Case A: Touch 1 Fade
            if status == "ARMED" and active_trade is None and t_entry_start <= t <= t_entry_end:
                in_zone = (h >= lvl - 5) if origin == "BELOW" else (l <= lvl + 5)
                if in_zone:
                    dist = abs(c - lvl)
                    if dist <= max_entry_dist:
                        if origin == "BELOW":
                            side = "SELL"
                            entry_p = c
                            trade_sl = lvl + sl
                            trade_tp = entry_p - tp
                            active_trade = {
                                "symbol": "SENSEX",
                                "date": str(date),
                                "entry_ts": ts,
                                "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                                "level": lvl,
                                "type": "TOUCH1_FADE_RESISTANCE",
                                "side": side,
                                "entry_price": round(entry_p, 2),
                                "sl": round(trade_sl, 2),
                                "tp": round(trade_tp, 2),
                                "trailed": False,
                            }
                            st["status"] = "TOUCH1_ACTIVE"
                            break
                        elif origin == "ABOVE":
                            side = "BUY"
                            entry_p = c
                            trade_sl = lvl - sl
                            trade_tp = entry_p + tp
                            active_trade = {
                                "symbol": "SENSEX",
                                "date": str(date),
                                "entry_ts": ts,
                                "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                                "level": lvl,
                                "type": "TOUCH1_FADE_SUPPORT",
                                "side": side,
                                "entry_price": round(entry_p, 2),
                                "sl": round(trade_sl, 2),
                                "tp": round(trade_tp, 2),
                                "trailed": False,
                            }
                            st["status"] = "TOUCH1_ACTIVE"
                            break

            # Case B: Touch 2 Breakout within 30 mins
            elif status == "TOUCH1_PROFIT":
                mins = (pd.to_datetime(ts) - st["profit_ts"]).total_seconds() / 60.0
                if mins > lockout_mins:
                    st["status"] = "EXPIRED"
                    continue

                if origin == "BELOW" and c <= lvl - 30:
                    st["pullback"] = True
                elif origin == "ABOVE" and c >= lvl + 30:
                    st["pullback"] = True

                if st["pullback"] and active_trade is None and t_entry_start <= t <= t_entry_end:
                    confirmed = (origin == "BELOW" and c > lvl + 10) or (origin == "ABOVE" and c < lvl - 10)
                    if confirmed:
                        side = "BUY" if origin == "BELOW" else "SELL"
                        entry_p = c
                        trade_sl = (entry_p - sl) if side == "BUY" else (entry_p + sl)
                        trade_tp = (entry_p + tp) if side == "BUY" else (entry_p - tp)
                        active_trade = {
                            "symbol": "SENSEX",
                            "date": str(date),
                            "entry_ts": ts,
                            "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                            "level": lvl,
                            "type": "TOUCH2_BREAKOUT_AFTER_PROFIT",
                            "side": side,
                            "entry_price": round(entry_p, 2),
                            "sl": round(trade_sl, 2),
                            "tp": round(trade_tp, 2),
                            "trailed": False,
                        }
                        st["status"] = "DONE"
                        break

    # Format completed trades
    out = []
    for t in trades:
        side_label = "CALL" if t["side"] == "BUY" else "PUT"
        pnl_pts = t.get("pnl_points", 0.0)
        delta = 0.55
        opt_pts = round(pnl_pts * delta, 2)
        pnl_rs = round(opt_pts * LOT_SIZE, 2)
        exit_ts = t.get("exit_ts")
        exit_time = pd.to_datetime(exit_ts).strftime("%H:%M") if exit_ts is not None else ""

        strike = int(round(t["level"] / 100.0) * 100)
        opt_type = "CE" if side_label == "CALL" else "PE"
        opt_name = f"SENSEX {strike} {opt_type}"

        # Option prices estimation
        est_entry_px = 350.0  # standard ATM Sensex option premium
        est_exit_px = max(5.0, est_entry_px + opt_pts)

        out.append({
            "date": t["date"],
            "strategy": "sensex_key_levels",
            "side": side_label,
            "level": t["level"],
            "type": t["type"],
            "entry_time": t["entry_time"],
            "entry_price": t["entry_price"],
            "sl": t["sl"],
            "target": t["tp"],
            "exit_time": exit_time,
            "exit_price": t.get("exit_price", t["entry_price"]),
            "pnl_points": pnl_pts,
            "option": opt_name,
            "qty": LOT_SIZE,
            "option_entry_price": est_entry_px,
            "option_exit_price": est_exit_px,
            "option_pnl_points": opt_pts,
            "pnl_rupees": pnl_rs,
            "exit_reason": t.get("exit_reason", "OPEN"),
        })
    return out


def sync_all_recent_paper_trades():
    """Sync all live October 2026 Sensex days into the paper trading log files."""
    files = sorted(list(LIVE_DIR.glob("sensex_1min_*.csv")))
    all_paper_trades = []
    for f in files:
        date_str = f.stem.replace("sensex_1min_", "")
        df = load_live_sensex_bars(date_str)
        if not df.empty:
            trades = simulate_day_trades(df)
            all_paper_trades.extend(trades)

    if all_paper_trades:
        df_out = pd.DataFrame(all_paper_trades)
        df_out.to_csv(PAPER_LOG_CSV, index=False)
        df_out.to_csv(LIVE_PAPER_CSV, index=False)
        print(f"[Sensex Key Levels Paper] Synced {len(df_out)} forward paper trades to {PAPER_LOG_CSV}")
        return len(df_out)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Sensex Key Levels Live Paper Engine")
    parser.add_argument("--sync", action="store_true", help="Sync all recent captured days into paper trade logs")
    parser.add_argument("--poll", type=int, default=5, help="Poll interval in seconds during live session")
    args = parser.parse_args()

    print("=" * 70)
    print("SENSEX KEY LEVELS PAPER TRADING ENGINE (Fade + Reverse)")
    print("=" * 70)

    # Always do an initial sync of all recent live days
    count = sync_all_recent_paper_trades()
    print(f"Paper trade logs active with {count} trades.")

    if not args.sync:
        print("\nStarting live monitor loop (Press Ctrl+C to stop)...")
        while True:
            try:
                today_str = datetime.now(IST).strftime("%Y-%m-%d")
                df_today = load_live_sensex_bars(today_str)
                if not df_today.empty:
                    today_trades = simulate_day_trades(df_today)
                    if today_trades:
                        df_today_trades = pd.DataFrame(today_trades)
                        df_today_trades.to_csv(LIVE_PAPER_CSV, index=False)
                time.sleep(args.poll)
            except KeyboardInterrupt:
                print("\nStopped.")
                break
            except Exception as e:
                time.sleep(args.poll)


if __name__ == "__main__":
    main()
