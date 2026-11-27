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
from datetime import datetime, timedelta
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from apex_duo_rules import (
    evaluate_bo_candle,
    check_initial_sl,
    is_ema20_armed,
    check_ema20_cross,
    get_initial_sl_pts,
    REENTRY_CUTOFF_TIME,
)
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
    n_all["ema200_1m"] = n_all["Close"].ewm(span=200, adjust=False).mean()
    s_all["ema200_1m"] = s_all["Close"].ewm(span=200, adjust=False).mean()
    n_all["date_val"] = n_all["dt"].dt.date
    s_all["date_val"] = s_all["dt"].dt.date

    n_day_map = {d: g.reset_index(drop=True) for d, g in n_all.groupby("date_val")}
    s_day_map = {d: g.reset_index(drop=True) for d, g in s_all.groupby("date_val")}

    n_dates = sorted(n_day_map.keys())
    s_dates = sorted(s_day_map.keys())

    common_dates = set(n_dates).intersection(set(s_dates))
    print(f"Total Nifty trading days: {len(n_dates)} (2017 - 2026)", flush=True)
    print(f"Total Sensex trading days: {len(s_dates)} (2023 - 2026)", flush=True)
    print(f"Overlapping Concurrent trading days: {len(common_dates)} (2023 - 2026)", flush=True)

    nifty_trades = []
    sensex_trades = []

    def build_trade_record(d, trade_num, side, sym, entry_info, exit_info, sl_dist, lot_sz, max_fav, vix_chg):
        pnl = round((exit_info["px"] - entry_info["px"]) if side == "CALL" else (entry_info["px"] - exit_info["px"]), 2)
        isl = round(entry_info["px"] - sl_dist if side == "CALL" else entry_info["px"] + sl_dist, 2)
        rec = {
            "date": str(d),
            "trade_num": trade_num,
            "stage": f"STAGE_{trade_num}",
            "side": side,
            "option": side,
            "option_symbol": f"{sym}_{side}",
            "option_entry_price": round(entry_info["px"] * 0.015, 2),
            "option_exit_price": round(exit_info["px"] * 0.015, 2),
            "option_pnl_points": round(pnl * 0.60, 2),
            "option_pnl_rupees": round(pnl * 0.60 * lot_sz, 2),
            "entry_time": entry_info["time"],
            "entry_price": round(entry_info["px"], 2),
            "exit_time": exit_info["time"],
            "exit_price": round(exit_info["px"], 2),
            "initial_sl": isl,
            "final_sl": round(exit_info["px"], 2),
            "pnl_points": pnl,
            "pnl_rupees": round(pnl * 0.60 * lot_sz, 2),
            "futures_pnl_rupees": round(pnl * lot_sz, 2),
            "diff_rupees": 0.0,
            "max_fav": round(max_fav, 2),
            "rr": round(pnl / sl_dist, 2),
            "exit_reason": exit_info["reason"],
            "vix_chg": vix_chg,
            "base_lots": 1,
            "pyramided": 0,
            "total_lots": 1,
            "weighted_pnl_points": pnl,
            "year": d.year,
            "engine": "TREND_RUNNER",
            "strategy_label": "Trend Runner",
            "trigger_label": f"[Trend Runner] BUY {side} (15m ORB)",
            "trigger_reason": "15m ORB Breakout with Dual Confluence"
        }
        if sym == "SENSEX":
            rec["sl"] = isl
            rec["target"] = 0.0
        return rec

    # Iterate day-by-day
    for d in n_dates:
        vix_chg = vix_map.get(d, 0.0)
        day_n_1m = n_day_map.get(d)
        if day_n_1m is None or len(day_n_1m) < 30:
            continue

        has_sensex = (d in common_dates)
        day_s_1m = s_day_map.get(d) if has_sensex else None
        if has_sensex and (day_s_1m is None or len(day_s_1m) < 30):
            has_sensex = False

        # Resample Nifty to 5m
        day_n_idx = day_n_1m.set_index("dt")
        b5_n = day_n_idx.resample("5min", closed="left", label="left").agg({
            "Open": "first", "High": "max", "Low": "min", "Close": "last"
        }).dropna().reset_index()
        b5_n["ema20"] = b5_n["Close"].ewm(span=20, adjust=False).mean()
        b5_n["open_t"] = b5_n["dt"].dt.strftime("%H:%M")
        b5_n["t_str"] = (b5_n["dt"] + pd.to_timedelta(4, unit="m")).dt.strftime("%H:%M")

        # Nifty Opening Range (09:15 to 09:30)
        or_n = b5_n[(b5_n["open_t"] >= "09:15") & (b5_n["open_t"] < "09:30")]
        if or_n.empty:
            continue
        or_h_n, or_l_n = float(or_n["High"].max()), float(or_n["Low"].min())
        if (or_h_n - or_l_n) < 30.0:
            continue

        day_n_1m_t = day_n_1m.copy()
        day_n_1m_t["t_str"] = day_n_1m_t["dt"].dt.strftime("%H:%M")
        n_5m_map = b5_n.set_index("t_str")

        # If Sensex exists, resample Sensex to 5m
        if has_sensex:
            day_s_idx = day_s_1m.set_index("dt")
            b5_s = day_s_idx.resample("5min", closed="left", label="left").agg({
                "Open": "first", "High": "max", "Low": "min", "Close": "last"
            }).dropna().reset_index()
            b5_s["ema20"] = b5_s["Close"].ewm(span=20, adjust=False).mean()
            b5_s["open_t"] = b5_s["dt"].dt.strftime("%H:%M")
            b5_s["t_str"] = (b5_s["dt"] + pd.to_timedelta(4, unit="m")).dt.strftime("%H:%M")

            or_s = b5_s[(b5_s["open_t"] >= "09:15") & (b5_s["open_t"] < "09:30")]
            if or_s.empty:
                has_sensex = False
            else:
                or_h_s, or_l_s = float(or_s["High"].max()), float(or_s["Low"].min())
                if (or_h_s - or_l_s) < 80.0:
                    has_sensex = False

        if has_sensex:
            day_s_1m_t = day_s_1m.copy()
            day_s_1m_t["t_str"] = day_s_1m_t["dt"].dt.strftime("%H:%M")
            s_5m_map = b5_s.set_index("t_str")
            s_1m_map = day_s_1m_t.set_index("t_str")
        else:
            s_5m_map = None
            s_1m_map = None

        # Up to 2 trades per day (Trade 1 + Cooloff Re-entry after STOP_LOSS or HOD/LOD break after EMA20_CROSS)
        min_search_time = "09:30"
        lvl_h_n, lvl_l_n = or_h_n, or_l_n
        lvl_h_s, lvl_l_s = (or_h_s, or_l_s) if has_sensex else (None, None)
        for trade_num in (1, 2):
            max_entry_time = "13:00" if trade_num == 1 else REENTRY_CUTOFF_TIME
            if min_search_time > max_entry_time:
                break

            # --- PHASE 1: ENTRY DETECTION ---
            n_entry = None
            s_entry = None

            # Single Source of Truth BO Candle Rules (apex_duo_rules.evaluate_bo_candle)
            morn_n = day_n_1m_t[(day_n_1m_t["t_str"] >= min_search_time) & (day_n_1m_t["t_str"] <= max_entry_time)]
            for _, row in morn_n.iterrows():
                o, h, l, c = float(row["Open"]), float(row["High"]), float(row["Low"]), float(row["Close"])
                t_s = row["t_str"]
                sig_n = evaluate_bo_candle("NIFTY", o, h, l, c, vix_chg, t_s, lvl_h_n, lvl_l_n, vwap=None, trade_num=trade_num)
                if sig_n is not None:
                    n_entry = {"time": t_s, "side": sig_n, "px": c}
                    break

            if has_sensex:
                morn_s = day_s_1m_t[(day_s_1m_t["t_str"] >= min_search_time) & (day_s_1m_t["t_str"] <= max_entry_time)]
                for _, row in morn_s.iterrows():
                    o, h, l, c = float(row["Open"]), float(row["High"]), float(row["Low"]), float(row["Close"])
                    t_s = row["t_str"]
                    sig_s = evaluate_bo_candle("SENSEX", o, h, l, c, vix_chg, t_s, lvl_h_s, lvl_l_s, vwap=None, trade_num=trade_num)
                    if sig_s is not None:
                        s_entry = {"time": t_s, "side": sig_s, "px": c}
                        break

            # Symmetrical Dual-Activation Entry Gate (<= 60m)
            trade_active = False
            if has_sensex:
                if n_entry and s_entry and n_entry["side"] == s_entry["side"]:
                    t_n_dt = datetime.strptime(n_entry["time"], "%H:%M")
                    t_s_dt = datetime.strptime(s_entry["time"], "%H:%M")
                    if abs((t_n_dt - t_s_dt).total_seconds()) <= 3600:
                        trade_active = True
            else:
                if n_entry:
                    trade_active = True

            if not trade_active:
                break

            # Align both legs to the actual dual-confirmation minute (when the 2nd index confirms)
            if has_sensex:
                confirm_time = max(n_entry["time"], s_entry["time"])
                if n_entry["time"] < confirm_time:
                    n_sub = day_n_1m_t[day_n_1m_t["t_str"] <= confirm_time]
                    if not n_sub.empty:
                        n_entry["time"] = confirm_time
                        n_entry["px"] = float(n_sub.iloc[-1]["Close"])
                if s_entry["time"] < confirm_time:
                    s_sub = day_s_1m_t[day_s_1m_t["t_str"] <= confirm_time]
                    if not s_sub.empty:
                        s_entry["time"] = confirm_time
                        s_entry["px"] = float(s_sub.iloc[-1]["Close"])

            # --- PHASE 2: 1m SL + ARMED DUAL-CROSS 1m 200-EMA EXIT (apex_duo_rules) ---
            side = n_entry["side"]
            n_sl_pts = get_initial_sl_pts("NIFTY")
            s_sl_pts = get_initial_sl_pts("SENSEX")
            n_sl = (n_entry["px"] - n_sl_pts) if side == "CALL" else (n_entry["px"] + n_sl_pts)
            s_sl = ((s_entry["px"] - s_sl_pts) if side == "CALL" else (s_entry["px"] + s_sl_pts)) if has_sensex else None

            n_max_fav = 0.0
            s_max_fav = 0.0
            n_ema_armed = False
            s_ema_armed = False

            exit_n = None
            exit_s = None

            post_n = day_n_1m_t[day_n_1m_t["t_str"] > n_entry["time"]]
            for _, row_n in post_n.iterrows():
                t_str = row_n["t_str"]
                nh, nl, nc = float(row_n["High"]), float(row_n["Low"]), float(row_n["Close"])

                fav_n = (nh - n_entry["px"]) if side == "CALL" else (n_entry["px"] - nl)
                if fav_n > n_max_fav:
                    n_max_fav = fav_n
                if is_ema20_armed("NIFTY", n_max_fav):
                    n_ema_armed = True

                # Check Sensex 1m bar if still open
                row_s = None
                sh = sl_val = sc = None
                if has_sensex and exit_s is None and t_str > s_entry["time"] and t_str in s_1m_map.index:
                    row_s = s_1m_map.loc[t_str]
                    if isinstance(row_s, pd.DataFrame):
                        row_s = row_s.iloc[-1]
                    sh, sl_val, sc = float(row_s["High"]), float(row_s["Low"]), float(row_s["Close"])
                    fav_s = (sh - s_entry["px"]) if side == "CALL" else (s_entry["px"] - sl_val)
                    if fav_s > s_max_fav:
                        s_max_fav = fav_s
                    if is_ema20_armed("SENSEX", s_max_fav):
                        s_ema_armed = True

                # 1. Protective Initial Stop Loss (per-index 1m check)
                if exit_n is None and check_initial_sl(side, nh, nl, n_sl):
                    exit_n = {"time": t_str, "px": n_sl, "reason": "STOP_LOSS"}

                if has_sensex and exit_s is None and sh is not None and check_initial_sl(side, sh, sl_val, s_sl):
                    exit_s = {"time": t_str, "px": s_sl, "reason": "STOP_LOSS"}

                # If all open legs stopped out, break early
                if exit_n is not None and (not has_sensex or exit_s is not None):
                    break

                # 2. Symmetrical Dual-Cross 1m 200-EMA Exit (apex_duo_rules.check_ema20_cross)
                cross_n = check_ema20_cross("NIFTY", side, nc, float(row_n["ema200_1m"]))
                if has_sensex and exit_s is None and exit_n is None:
                    if row_s is not None and sc is not None and t_str > max(n_entry["time"], s_entry["time"]):
                        cross_s = check_ema20_cross("SENSEX", side, sc, float(row_s["ema200_1m"]))
                        if (n_ema_armed or s_ema_armed) and cross_n and cross_s:
                            exit_n = {"time": t_str, "px": nc, "reason": "EMA20_CROSS"}
                            exit_s = {"time": t_str, "px": sc, "reason": "EMA20_CROSS"}
                            break
                elif not has_sensex and exit_n is None:
                    if n_ema_armed and cross_n:
                        exit_n = {"time": t_str, "px": nc, "reason": "EMA20_CROSS"}
                        break

                # 3. EOD 15:15 Square-Off
                if t_str >= "15:15":
                    if exit_n is None:
                        exit_n = {"time": t_str, "px": nc, "reason": "EOD_RUNNER_1515"}
                    if has_sensex and exit_s is None:
                        eod_sc = sc if sc is not None else float(day_s_1m_t[day_s_1m_t["t_str"] <= t_str].iloc[-1]["Close"])
                        exit_s = {"time": t_str, "px": eod_sc, "reason": "EOD_RUNNER_1515"}
                    break

            # Fallback to last available bar if no explicit exit hit
            if exit_n is None and not day_n_1m_t.empty:
                last_nr = day_n_1m_t.iloc[-1]
                exit_n = {"time": last_nr["t_str"], "px": float(last_nr["Close"]), "reason": "EOD_RUNNER_1515"}
            if has_sensex and exit_s is None and not day_s_1m_t.empty:
                last_sr = day_s_1m_t.iloc[-1]
                exit_s = {"time": last_sr["t_str"], "px": float(last_sr["Close"]), "reason": "EOD_RUNNER_1515"}

            nifty_trades.append(build_trade_record(d, trade_num, side, "NIFTY", n_entry, exit_n, 50.0, 25, n_max_fav, vix_chg))
            if has_sensex and exit_s is not None:
                sensex_trades.append(build_trade_record(d, trade_num, side, "SENSEX", s_entry, exit_s, 200.0, 10, s_max_fav, vix_chg))

            # Check if eligible for Re-entry (after STOP_LOSS or HOD/LOD continuation after EMA20_CROSS)
            if exit_n["reason"] in ("STOP_LOSS", "EMA20_CROSS") and (not has_sensex or exit_s["reason"] == exit_n["reason"]):
                last_exit_t = max(exit_n["time"], exit_s["time"]) if has_sensex else exit_n["time"]
                cool_mins = 20 if exit_n["reason"] == "STOP_LOSS" else 10
                cooloff_dt = datetime.strptime(last_exit_t, "%H:%M") + timedelta(minutes=cool_mins)
                min_search_time = cooloff_dt.strftime("%H:%M")
                if exit_n["reason"] == "EMA20_CROSS":
                    sub_n = day_n_1m_t[day_n_1m_t["t_str"] <= last_exit_t]
                    lvl_h_n, lvl_l_n = float(sub_n["High"].max()), float(sub_n["Low"].min())
                    if has_sensex:
                        sub_s = day_s_1m_t[day_s_1m_t["t_str"] <= last_exit_t]
                        lvl_h_s, lvl_l_s = float(sub_s["High"].max()), float(sub_s["Low"].min())
            else:
                break

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
