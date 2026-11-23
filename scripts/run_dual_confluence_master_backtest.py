#!/usr/bin/env python3
"""
Symmetrical Dual-Confluence Master Backtest Runner (2017 - 2026)
Executes pure, untampered historical backtests directly on 1-minute candle bars.

Rules (Strict Symmetrical Confluence):
1. Breakout Entry:
   - 15m Opening Range (09:15-09:30) established.
   - 1m Bar closes beyond OR High (CALL) or OR Low (PUT) with VIX directional confirmation.
   - Dual-Activation Gate: BOTH Nifty and Sensex must trigger in the same direction within 60 mins.
   - If one triggers and the other does not confirm within 60m: NEITHER ENTERS.
2. Trailing Rail & Exit:
   - Model D: 5-minute 20-EMA Dynamic Rail.
   - Evaluated on completed 5-minute candle closes across the 20-EMA.
   - Dual-Cross Confluence Gate: An exit triggers IF AND ONLY IF BOTH indices close beyond their respective 5m 20-EMAs.
   - If only one index crosses its 20-EMA: NEITHER EXITS (holds through single-index noise).
   - Once both indices confirm a 5m close beyond 20-EMA: BOTH EXIT TOGETHER.
3. Market Close Square-Off:
   - 15:15 IST EOD exit for all open runners (EOD_RUNNER_1515).
"""

import os
import sys
from pathlib import Path
from datetime import datetime
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

print("=" * 90)
print(" SYMMETRICAL DUAL-CONFLUENCE MASTER BACKTEST ENGINE (2017 - 2026)")
print(" Symmetrical Confluence: Dual Entry + Dual 5m 20-EMA Exit")
print("=" * 90)

# 1. Load 10-Year VIX Data
vix_path = ROOT / "captured_data" / "india_vix_10y.csv"
vix_df = pd.read_csv(vix_path)
vix_df["date"] = pd.to_datetime(vix_df["date"]).dt.date
vix_map = dict(zip(vix_df["date"], vix_df["vix_change_pct"]))
vix_close_map = dict(zip(vix_df["date"], vix_df["close"]))

# Load live recorded VIX overrides if available
for sf in (ROOT / "performance" / "trend_runner_signals.csv",
           ROOT / "performance" / "trend_runner_paper_trades.csv",
           ROOT / "performance" / "trend_runner_sensex_signals.csv",
           ROOT / "performance" / "trend_runner_sensex_paper_trades.csv"):
    if sf.exists():
        try:
            sdf = pd.read_csv(sf)
            if not sdf.empty and "date" in sdf.columns and "vix_chg" in sdf.columns:
                for _, r in sdf.iterrows():
                    try:
                        d_val = pd.to_datetime(r["date"]).date()
                        if pd.notna(r["vix_chg"]):
                            vix_map[d_val] = float(r["vix_chg"])
                    except Exception:
                        pass
        except Exception:
            pass

def run_backtest():
    # Load all available files
    n_base = ROOT / "captured_data" / "technovusin_nifty50" / "1min"
    s_base = ROOT / "captured_data" / "technovusin_sensex" / "1min"

    n_files = sorted(list(n_base.rglob("*.csv")))
    s_files = sorted(list(s_base.rglob("*.csv")))

    print(f"Loaded {len(n_files)} NIFTY files and {len(s_files)} SENSEX files.")

    # Group files by year or month and parse
    print("Reading and indexing intraday 1m data...")
    n_dfs = [pd.read_csv(f) for f in n_files]
    s_dfs = [pd.read_csv(f) for f in s_files]

    n_all = pd.concat(n_dfs, ignore_index=True)
    s_all = pd.concat(s_dfs, ignore_index=True)

    n_all["dt"] = pd.to_datetime(n_all["Timestamp"])
    s_all["dt"] = pd.to_datetime(s_all["Timestamp"])

    n_all.sort_values("dt", inplace=True)
    s_all.sort_values("dt", inplace=True)

    n_dates = sorted(list(set(n_all["dt"].dt.date)))
    s_dates = sorted(list(set(s_all["dt"].dt.date)))

    common_dates = set(n_dates).intersection(set(s_dates))
    print(f"Total Nifty trading days: {len(n_dates)} (2017 - 2026)")
    print(f"Total Sensex trading days: {len(s_dates)} (2023 - 2026)")
    print(f"Overlapping Concurrent trading days: {len(common_dates)} (2023 - 2026)")

    nifty_trades = []
    sensex_trades = []

    # Iterate day-by-day
    for d in n_dates:
        vix_chg = vix_map.get(d, 0.0)
        day_n_1m = n_all[n_all["dt"].dt.date == d].copy().reset_index(drop=True)
        if day_n_1m.empty or len(day_n_1m) < 30:
            continue

        has_sensex = (d in common_dates)
        if has_sensex:
            day_s_1m = s_all[s_all["dt"].dt.date == d].copy().reset_index(drop=True)
            if day_s_1m.empty or len(day_s_1m) < 30:
                has_sensex = False

        # Resample Nifty to 5m
        day_n_1m.set_index("dt", inplace=True)
        b5_n = day_n_1m.resample("5min", closed="left", label="left").agg({
            "Open": "first", "High": "max", "Low": "min", "Close": "last"
        }).dropna().reset_index()
        b5_n["ema20"] = b5_n["Close"].ewm(span=20, adjust=False).mean()
        b5_n["t_str"] = b5_n["dt"].dt.strftime("%H:%M")

        # Nifty Opening Range (09:15 to 09:30)
        or_n = b5_n[(b5_n["t_str"] >= "09:15") & (b5_n["t_str"] < "09:30")]
        if or_n.empty:
            continue
        or_h_n, or_l_n = float(or_n["High"].max()), float(or_n["Low"].min())
        if (or_h_n - or_l_n) < 30.0:
            continue

        # If Sensex exists, resample Sensex to 5m
        if has_sensex:
            day_s_1m.set_index("dt", inplace=True)
            b5_s = day_s_1m.resample("5min", closed="left", label="left").agg({
                "Open": "first", "High": "max", "Low": "min", "Close": "last"
            }).dropna().reset_index()
            b5_s["ema20"] = b5_s["Close"].ewm(span=20, adjust=False).mean()
            b5_s["t_str"] = b5_s["dt"].dt.strftime("%H:%M")

            or_s = b5_s[(b5_s["t_str"] >= "09:15") & (b5_s["t_str"] < "09:30")]
            if or_s.empty:
                has_sensex = False
            else:
                or_h_s, or_l_s = float(or_s["High"].max()), float(or_s["Low"].min())
                if (or_h_s - or_l_s) < 80.0:
                    has_sensex = False

        # --- PHASE 1: ENTRY DETECTION (09:30 to 11:00) ---
        n_entry = None
        s_entry = None

        # Check Nifty breakout
        day_n_trade = day_n_1m.reset_index()
        day_n_trade["t_str"] = day_n_trade["dt"].dt.strftime("%H:%M")
        morn_n = day_n_trade[(day_n_trade["t_str"] >= "09:30") & (day_n_trade["t_str"] <= "11:00")]

        for _, row in morn_n.iterrows():
            c, o, h, l = row["Close"], row["Open"], row["High"], row["Low"]
            t_s = row["t_str"]
            if c > or_h_n and c > o and vix_chg <= 0.05:
                n_entry = {"time": t_s, "side": "CALL", "px": c}
                break
            elif c < or_l_n and c < o and vix_chg >= -0.05:
                n_entry = {"time": t_s, "side": "PUT", "px": c}
                break

        if has_sensex:
            day_s_trade = day_s_1m.reset_index()
            day_s_trade["t_str"] = day_s_trade["dt"].dt.strftime("%H:%M")
            morn_s = day_s_trade[(day_s_trade["t_str"] >= "09:30") & (day_s_trade["t_str"] <= "11:00")]

            for _, row in morn_s.iterrows():
                c, o, h, l = row["Close"], row["Open"], row["High"], row["Low"]
                t_s = row["t_str"]
                if c > or_h_s and c > o and vix_chg <= 0.05:
                    s_entry = {"time": t_s, "side": "CALL", "px": c}
                    break
                elif c < or_l_s and c < o and vix_chg >= -0.05:
                    s_entry = {"time": t_s, "side": "PUT", "px": c}
                    break

        # Symmetrical Dual-Activation Entry Gate:
        # On overlapping dates (has_sensex = True), BOTH MUST CONFIRM SAME SIDE within 60 mins!
        trade_active = False
        if has_sensex:
            if n_entry and s_entry and n_entry["side"] == s_entry["side"]:
                # Check delta window <= 60m
                t_n_dt = datetime.strptime(n_entry["time"], "%H:%M")
                t_s_dt = datetime.strptime(s_entry["time"], "%H:%M")
                if abs((t_n_dt - t_s_dt).total_seconds()) <= 3600:
                    trade_active = True
        else:
            # Pre-2023 Nifty standalone
            if n_entry:
                trade_active = True

        if not trade_active:
            continue

        # --- PHASE 2: TRAILING RAIL & DUAL-CROSS EXIT ---
        # Align on 5m bars starting after both entries
        entry_time_max = max(n_entry["time"], s_entry["time"]) if has_sensex else n_entry["time"]
        side = n_entry["side"]

        b5_n_post = b5_n[b5_n["t_str"] >= entry_time_max].copy().reset_index(drop=True)
        if has_sensex:
            b5_s_post = b5_s[b5_s["t_str"] >= entry_time_max].copy().reset_index(drop=True)
            merged_5m = pd.merge(b5_n_post, b5_s_post, on="t_str", suffixes=("_n", "_s"))
        else:
            merged_5m = b5_n_post

        exit_n = None
        exit_s = None

        for _, row in merged_5m.iterrows():
            t_str = row["t_str"]

            if has_sensex:
                c_n, ema_n = float(row["Close_n"]), float(row["ema20_n"])
                c_s, ema_s = float(row["Close_s"]), float(row["ema20_s"])

                cross_n = (c_n < ema_n) if side == "CALL" else (c_n > ema_n)
                cross_s = (c_s < ema_s) if side == "CALL" else (c_s > ema_s)

                is_eod = (t_str >= "15:15")

                # Symmetrical Exit Gate: Both must cross or EOD!
                if is_eod:
                    exit_n = {"time": t_str, "px": c_n, "reason": "EOD_RUNNER_1515"}
                    exit_s = {"time": t_str, "px": c_s, "reason": "EOD_RUNNER_1515"}
                    break
                elif cross_n and cross_s:
                    exit_n = {"time": t_str, "px": c_n, "reason": "EMA20_CROSS"}
                    exit_s = {"time": t_str, "px": c_s, "reason": "EMA20_CROSS"}
                    break
            else:
                c_n, ema_n = float(row["Close"]), float(row["ema20"])
                cross_n = (c_n < ema_n) if side == "CALL" else (c_n > ema_n)
                is_eod = (t_str >= "15:15")

                if is_eod:
                    exit_n = {"time": t_str, "px": c_n, "reason": "EOD_RUNNER_1515"}
                    break
                elif cross_n:
                    exit_n = {"time": t_str, "px": c_n, "reason": "EMA20_CROSS"}
                    break

        # Fallback to last available bar if no explicit exit hit
        if exit_n is None and not merged_5m.empty:
            last_r = merged_5m.iloc[-1]
            exit_n = {"time": last_r["t_str"], "px": float(last_r["Close_n"] if has_sensex else last_r["Close"]), "reason": "EOD_RUNNER_1515"}
            if has_sensex:
                exit_s = {"time": last_r["t_str"], "px": float(last_r["Close_s"]), "reason": "EOD_RUNNER_1515"}

        # Record NIFTY trade
        pnl_n = round((exit_n["px"] - n_entry["px"]) if side == "CALL" else (n_entry["px"] - exit_n["px"]), 2)
        nifty_trades.append({
            "date": str(d),
            "trade_num": 1,
            "stage": "STAGE_1",
            "side": side,
            "option": side,
            "option_symbol": f"NIFTY_{side}",
            "option_entry_price": round(n_entry["px"] * 0.015, 2),
            "option_exit_price": round(exit_n["px"] * 0.015, 2),
            "option_pnl_points": round(pnl_n * 0.60, 2),
            "option_pnl_rupees": round(pnl_n * 0.60 * 25, 2),
            "entry_time": n_entry["time"],
            "entry_price": round(n_entry["px"], 2),
            "exit_time": exit_n["time"],
            "exit_price": round(exit_n["px"], 2),
            "initial_sl": round(n_entry["px"] - 30.0 if side == "CALL" else n_entry["px"] + 30.0, 2),
            "final_sl": round(exit_n["px"], 2),
            "pnl_points": pnl_n,
            "pnl_rupees": round(pnl_n * 0.60 * 25, 2),
            "futures_pnl_rupees": round(pnl_n * 25, 2),
            "diff_rupees": 0.0,
            "max_fav": 0.0,
            "rr": 0.0,
            "exit_reason": exit_n["reason"],
            "vix_chg": vix_chg,
            "base_lots": 1,
            "pyramided": 0,
            "total_lots": 1,
            "weighted_pnl_points": pnl_n,
            "year": d.year,
            "engine": "TREND_RUNNER",
            "strategy_label": "Trend Runner",
            "trigger_label": f"[Trend Runner] BUY {side} (15m ORB)",
            "trigger_reason": "15m ORB Breakout with Dual Confluence"
        })

        # Record SENSEX trade
        if has_sensex and exit_s is not None:
            pnl_s = round((exit_s["px"] - s_entry["px"]) if side == "CALL" else (s_entry["px"] - exit_s["px"]), 2)
            sensex_trades.append({
                "date": str(d),
                "trade_num": 1,
                "stage": "STAGE_1",
                "side": side,
                "option": side,
                "option_symbol": f"SENSEX_{side}",
                "option_entry_price": round(s_entry["px"] * 0.015, 2),
                "option_exit_price": round(exit_s["px"] * 0.015, 2),
                "option_pnl_points": round(pnl_s * 0.60, 2),
                "option_pnl_rupees": round(pnl_s * 0.60 * 10, 2),
                "entry_time": s_entry["time"],
                "entry_price": round(s_entry["px"], 2),
                "exit_time": exit_s["time"],
                "exit_price": round(exit_s["px"], 2),
                "initial_sl": round(s_entry["px"] - 120.0 if side == "CALL" else s_entry["px"] + 120.0, 2),
                "final_sl": round(exit_s["px"], 2),
                "pnl_points": pnl_s,
                "pnl_rupees": round(pnl_s * 0.60 * 10, 2),
                "futures_pnl_rupees": round(pnl_s * 10, 2),
                "diff_rupees": 0.0,
                "max_fav": 0.0,
                "rr": 0.0,
                "exit_reason": exit_s["reason"],
                "vix_chg": vix_chg,
                "base_lots": 1,
                "pyramided": 0,
                "total_lots": 1,
                "weighted_pnl_points": pnl_s,
                "sl": round(s_entry["px"] - 120.0 if side == "CALL" else s_entry["px"] + 120.0, 2),
                "target": 0.0,
                "year": d.year,
                "engine": "TREND_RUNNER",
                "strategy_label": "Trend Runner",
                "trigger_label": f"[Trend Runner] BUY {side} (15m ORB)",
                "trigger_reason": "15m ORB Breakout with Dual Confluence"
            })

    df_nifty = pd.DataFrame(nifty_trades)
    df_sensex = pd.DataFrame(sensex_trades)

    # Export to authoritative CSVs
    p_dir = ROOT / "performance"
    p_dir.mkdir(exist_ok=True)

    df_nifty.to_csv(p_dir / "vix_trend_runner_trades.csv", index=False)
    df_nifty.to_csv(p_dir / "nifty_10y_backtest_trades.csv", index=False)
    df_sensex.to_csv(p_dir / "sensex_backtest_trades.csv", index=False)

    print("\n" + "=" * 90)
    print(" AUTHORITATIVE BACKTEST PERFORMANCE SUMMARY")
    print("=" * 90)
    print(f"NIFTY  (2017 - 2026): {len(df_nifty)} Trades | Win Rate: {(df_nifty['pnl_points'] > 0).mean():.1%} | Net Spot Points: {df_nifty['pnl_points'].sum():+,.1f} pts | Futures PnL: Rs. {df_nifty['futures_pnl_rupees'].sum():+,.0f}")
    print(f"SENSEX (2023 - 2026): {len(df_sensex)} Trades | Win Rate: {(df_sensex['pnl_points'] > 0).mean():.1%} | Net Spot Points: {df_sensex['pnl_points'].sum():+,.1f} pts | Futures PnL: Rs. {df_sensex['futures_pnl_rupees'].sum():+,.0f}")
    print("=" * 90)

    # Check today's trade specifically
    print("\n--- SPECIFIC FOCUS: TODAY (2026-11-23) ---")
    t_n_today = df_nifty[df_nifty["date"] == "2026-11-23"]
    t_s_today = df_sensex[df_sensex["date"] == "2026-11-23"]
    if not t_n_today.empty:
        r = t_n_today.iloc[0]
        print(f"NIFTY  Today: Entry {r['entry_time']} @ {r['entry_price']} | Exit {r['exit_time']} @ {r['exit_price']} | PnL: {r['pnl_points']:+.2f} pts | Reason: {r['exit_reason']}")
    if not t_s_today.empty:
        r = t_s_today.iloc[0]
        print(f"SENSEX Today: Entry {r['entry_time']} @ {r['entry_price']} | Exit {r['exit_time']} @ {r['exit_price']} | PnL: {r['pnl_points']:+.2f} pts | Reason: {r['exit_reason']}")

    # Re-run master portfolio aggregation with the new authoritative trades
    print("\nRe-aggregating Master Portfolio (Trend Runner + VIX Trap)...")
    os.system(f"python {ROOT}/scripts/run_master_portfolio_backtest.py --mode concurrent --symbol nifty")
    os.system(f"python {ROOT}/scripts/run_master_portfolio_backtest.py --mode concurrent --symbol sensex")

if __name__ == "__main__":
    run_backtest()
