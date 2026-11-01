"""Nifty 1-Minute Key Levels Live Paper Trading Engine.
Monitors today's incoming 1-min Nifty bars for Key Level Fades & Reverses.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone, timedelta, time as dt_time
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

PAPER_LOG_CSV = PERF_DIR / "nifty_key_levels_paper_trades.csv"
LIVE_PAPER_CSV = LIVE_DIR / "nifty_key_levels_live_paper.csv"

LOT_SIZE = 25  # Nifty standard lot size


def load_live_nifty_bars(date_str: str) -> pd.DataFrame:
    """Load latest 1-min Nifty bars from live CSV."""
    fpath = LIVE_DIR / f"nifty_1min_{date_str}.csv"
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
    approach_min: int = 40,
    sl: int = 10,
    max_entry_dist: int = 10,
    fade_tp: int = 50,
    rev_tp: int = 80,
    lockout_mins: int = 30,
) -> list:
    """Run exact Nifty 1-min strategy logic on a single day's DataFrame."""
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
                    exit_reason = "STOP_LOSS"
            else:
                if l <= trade_tp:
                    exited = True
                    exit_p = trade_tp
                    exit_reason = "TARGET"
                elif h >= trade_sl:
                    exited = True
                    exit_p = trade_sl
                    exit_reason = "STOP_LOSS"

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
                    rev_tp_price = (rev_entry + rev_tp) if rev_side == "BUY" else (rev_entry - rev_tp)
                    active_trade = {
                        "symbol": "NIFTY",
                        "date": str(date),
                        "entry_ts": ts,
                        "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                        "level": lvl,
                        "type": "REVERSE_RETRY",
                        "side": rev_side,
                        "entry_price": round(rev_entry, 2),
                        "sl": round(rev_sl_price, 2),
                        "tp": round(rev_tp_price, 2),
                    }
                    continue
                else:
                    active_trade = None

        # 2. Check Level Setups
        min_l = int((c - 200) // step * step)
        max_l = int((c + 200) // step * step) + step

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
                in_zone = (h >= lvl - 3) if origin == "BELOW" else (l <= lvl + 3)
                if in_zone:
                    dist = abs(c - lvl)
                    if dist <= max_entry_dist:
                        if origin == "BELOW":
                            side = "SELL"
                            entry_p = c
                            trade_sl = lvl + sl
                            trade_tp = entry_p - fade_tp
                            active_trade = {
                                "symbol": "NIFTY",
                                "date": str(date),
                                "entry_ts": ts,
                                "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                                "level": lvl,
                                "type": "TOUCH1_FADE_RESISTANCE",
                                "side": side,
                                "entry_price": round(entry_p, 2),
                                "sl": round(trade_sl, 2),
                                "tp": round(trade_tp, 2),
                            }
                            st["status"] = "TOUCH1_ACTIVE"
                            break
                        elif origin == "ABOVE":
                            side = "BUY"
                            entry_p = c
                            trade_sl = lvl - sl
                            trade_tp = entry_p + fade_tp
                            active_trade = {
                                "symbol": "NIFTY",
                                "date": str(date),
                                "entry_ts": ts,
                                "entry_time": pd.to_datetime(ts).strftime("%H:%M"),
                                "level": lvl,
                                "type": "TOUCH1_FADE_SUPPORT",
                                "side": side,
                                "entry_price": round(entry_p, 2),
                                "sl": round(trade_sl, 2),
                                "tp": round(trade_tp, 2),
                            }
                            st["status"] = "TOUCH1_ACTIVE"
                            break

    # Format completed trades
    out = []
    for t in trades:
        side_label = "CALL" if t["side"] == "BUY" else "PUT"
        pnl_pts = t.get("pnl_points", 0.0)
        delta = 0.50
        opt_pts = round(pnl_pts * delta, 2)
        pnl_rs = round(opt_pts * LOT_SIZE, 2)
        exit_ts = t.get("exit_ts")
        exit_time = pd.to_datetime(exit_ts).strftime("%H:%M") if exit_ts is not None else ""

        strike = int(round(t["level"] / 50.0) * 50)
        opt_type = "CE" if side_label == "CALL" else "PE"
        opt_name = f"NIFTY {strike} {opt_type}"

        est_entry_px = 120.0
        est_exit_px = max(2.0, est_entry_px + opt_pts)

        out.append({
            "date": t["date"],
            "strategy": "nifty_key_levels",
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
    """Sync all live captured Nifty days into paper trading log files, skipping Inside Days."""
    files = sorted(list(LIVE_DIR.glob("nifty_1min_*.csv")))
    all_paper_trades = []
    prev_high, prev_low = None, None

    for f in files:
        date_str = f.stem.replace("nifty_1min_", "")
        df = load_live_nifty_bars(date_str)
        if not df.empty:
            cur_high = df["high"].max()
            cur_low = df["low"].min()

            is_inside_day = False
            if prev_high is not None and prev_low is not None:
                if cur_high <= prev_high and cur_low >= prev_low:
                    is_inside_day = True

            if not is_inside_day:
                trades = simulate_day_trades(df)
                all_paper_trades.extend(trades)
            else:
                print(f"[Nifty Key Levels Paper] {date_str} is an Inside Day (Mother Bar) - Skipped to avoid false breakout chop.")

            prev_high = cur_high
            prev_low = cur_low

    if all_paper_trades:
        df_out = pd.DataFrame(all_paper_trades)
        df_out.to_csv(PAPER_LOG_CSV, index=False)
        df_out.to_csv(LIVE_PAPER_CSV, index=False)
        print(f"[Nifty Key Levels Paper] Synced {len(df_out)} forward paper trades to {PAPER_LOG_CSV}")
        return len(df_out)
    return 0


def main():
    parser = argparse.ArgumentParser(description="Nifty Key Levels Live Paper Engine")
    parser.add_argument("--sync", action="store_true", help="Sync all recent captured days into paper trade logs")
    parser.add_argument("--poll", type=int, default=5, help="Poll interval in seconds during live session")
    args = parser.parse_args()

    print("=" * 70)
    print("NIFTY KEY LEVELS PAPER TRADING ENGINE (Fade + Reverse)")
    print("=" * 70)

    count = sync_all_recent_paper_trades()
    print(f"Paper trade logs active with {count} trades.")

    if not args.sync:
        print("\nStarting live monitor loop (Press Ctrl+C to stop)...")
        while True:
            try:
                today_str = datetime.now(IST).strftime("%Y-%m-%d")
                df_today = load_live_nifty_bars(today_str)
                if not df_today.empty:
                    today_trades = simulate_day_trades(df_today)
                    if today_trades:
                        df_today_trades = pd.DataFrame(today_trades)
                        df_today_trades.to_csv(LIVE_PAPER_CSV, index=False)
                time.sleep(args.poll)
            except KeyboardInterrupt:
                print("\nStopped.")
                break
            except Exception:
                time.sleep(args.poll)


if __name__ == "__main__":
    main()
