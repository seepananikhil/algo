#!/usr/bin/env python3
"""
VIX Master Strategy — Unified State Machine Backtest Engine
Combines VIX Trap Divergence (Morning Sniper Reversal) and Trend Runner (Momentum Expansion)
Supports both NIFTY (10-Year 2017-2026) and SENSEX (4-Year 2023-2026).
"""

import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pandas as pd
import numpy as np

print("=" * 80)
print(" VIX MASTER STRATEGY: UNIFIED STATE MACHINE BACKTEST")
print(" Combines VIX Trap Sniper + Trend Runner Expansion with Dynamic 2+1 Sizing")
print("=" * 80)

# 1. Load VIX Data
vix_path = ROOT / 'captured_data' / 'india_vix_10y.csv'
vdf = pd.read_csv(vix_path)
vdf["date_str"] = pd.to_datetime(vdf["date"]).dt.strftime("%Y-%m-%d")
vdf.sort_values("date_str", inplace=True)
vdf["prev_close"] = vdf["close"].shift(1)
vdf["vix_pts_chg"] = (vdf["close"] - vdf["prev_close"]).abs()
vix_map = dict(zip(vdf["date_str"], vdf["vix_change_pct"].fillna(0.0)))
vix_pts_map = dict(zip(vdf["date_str"], vdf["vix_pts_chg"].fillna(0.0)))

def run_unified_vix_master(symbol: str = "NIFTY"):
    is_sx = (symbol.upper() == "SENSEX")
    lot_size = 10 if is_sx else 25
    delta = 0.60
    
    print(f"\nLoading {symbol} 1-min data...", flush=True)
    if is_sx:
        base_sx = ROOT / "captured_data" / "technovusin_sensex" / "1min"
        dfs = []
        for y in ["2023", "2024", "2025"]:
            f = base_sx / y / f"SENSEX_1min_{y}.csv"
            if f.exists():
                dfs.append(pd.read_csv(f))
        if (base_sx / "2026").exists():
            for f in sorted((base_sx / "2026").glob("*.csv")):
                dfs.append(pd.read_csv(f))
        df_all = pd.concat(dfs, ignore_index=True)
        df_all.columns = [c.lower() for c in df_all.columns]
        dt_col = [c for c in df_all.columns if "time" in c or "date" in c][0]
        df_all["timestamp"] = pd.to_datetime(df_all[dt_col])
        df_all.sort_values("timestamp", inplace=True)
        df_all.drop_duplicates("timestamp", inplace=True)
        df_all.reset_index(drop=True, inplace=True)
        df_all["date_str"] = df_all["timestamp"].dt.strftime("%Y-%m-%d")
        df_all["time_str"] = df_all["timestamp"].dt.strftime("%H:%M")
        min_or_pts = 75.0
        trap_cap = 220.0
        trap_floor = 100.0
        scale_trigger = 120.0
        pyr_trigger = 200.0
        t0_trig_1, t0_lk_1 = 115.0, -40.0
        t0_trig_2, t0_lk_2 = 180.0, 15.0
        r1_trig, r1_lk = 240.0, 80.0
        r2_trig, r2_lk = 400.0, 200.0
        r3_trig, r3_lk = 600.0, 360.0
        r4_trig, r4_lk = 850.0, 550.0
        r5_trig, r5_lk = 1200.0, 850.0
        r6_trig, r6_lk = 1500.0, 1100.0
        runner_sl_floor = 100.0
        runner_sl_cap = 220.0
        runner_buffer = 15.0
    else:
        years = [str(y) for y in range(2017, 2027)]
        base_nifty = ROOT / "captured_data" / "technovusin_nifty50" / "1min"
        dfs = []
        for y in years:
            yp = base_nifty / y
            if not yp.exists(): continue
            for f in sorted(yp.glob("*.csv")):
                dfs.append(pd.read_csv(f))
        df_all = pd.concat(dfs, ignore_index=True)
        df_all.columns = [c.lower() for c in df_all.columns]
        dt_col = [c for c in df_all.columns if "time" in c or "date" in c][0]
        df_all["timestamp"] = pd.to_datetime(df_all[dt_col])
        df_all.sort_values("timestamp", inplace=True)
        df_all.drop_duplicates("timestamp", inplace=True)
        df_all.reset_index(drop=True, inplace=True)
        df_all["date_str"] = df_all["timestamp"].dt.strftime("%Y-%m-%d")
        df_all["time_str"] = df_all["timestamp"].dt.strftime("%H:%M")
        min_or_pts = 25.0
        trap_cap = 65.0
        trap_floor = 25.0
        scale_trigger = 35.0
        pyr_trigger = 60.0
        t0_trig_1, t0_lk_1 = 40.0, -15.0
        t0_trig_2, t0_lk_2 = 55.0, 5.0
        r1_trig, r1_lk = 70.0, 20.0
        r2_trig, r2_lk = 130.0, 60.0
        r3_trig, r3_lk = 180.0, 110.0
        r4_trig, r4_lk = 230.0, 165.0
        r5_trig, r5_lk = 280.0, 220.0
        r6_trig, r6_lk = 340.0, 270.0
        runner_sl_floor = 35.0
        runner_sl_cap = 65.0
        runner_buffer = 5.0

    tp = (df_all["high"] + df_all["low"] + df_all["close"]) / 3.0
    cum_tp = tp.groupby(df_all["date_str"]).cumsum()
    counts = df_all.groupby(df_all["date_str"]).cumcount() + 1
    df_all["vwap"] = cum_tp / counts

    print("Pre-indexing daily packages...", flush=True)
    packages = []
    for d, g in df_all.groupby("date_str"):
        if len(g) < 100:
            continue
        or_bars = g[(g["time_str"] >= "09:15") & (g["time_str"] <= "09:30")]
        if len(or_bars) == 0:
            continue
        or_h = float(or_bars["high"].max())
        or_l = float(or_bars["low"].min())
        if (or_h - or_l) < min_or_pts:
            continue

        packages.append({
            "date": d,
            "year": int(d[:4]),
            "vix_chg": vix_map.get(d, 0.0),
            "vix_pts": vix_pts_map.get(d, 0.0),
            "or_h": or_h,
            "or_l": or_l,
            "times": g["time_str"].values,
            "opens": g["open"].values,
            "highs": g["high"].values,
            "lows": g["low"].values,
            "closes": g["close"].values,
            "vwaps": g["vwap"].values,
            "n_bars": len(g)
        })

    print(f"Indexed {len(packages)} trading days for {symbol}.", flush=True)

    trades = []
    
    for dp in packages:
        d = dp["date"]
        v_chg = dp["vix_chg"]
        v_pts = dp["vix_pts"]
        or_h = dp["or_h"]
        or_l = dp["or_l"]
        times, opens, highs, lows, closes, vwaps = dp["times"], dp["opens"], dp["highs"], dp["lows"], dp["closes"], dp["vwaps"]
        n_bars = dp["n_bars"]
        
        # State Machine Flags
        day_trades = 0
        active_pos = None
        has_tested_h, has_tested_l = False, False
        trap_attempted = False
        last_exit_idx = -999
        roll_h = or_h
        roll_l = or_l
        
        for i in range(n_bars):
            t = times[i]
            if t < "09:30":
                continue
            o, h, l, c, v = opens[i], highs[i], lows[i], closes[i], vwaps[i]
            
            if h >= or_h: has_tested_h = True
            if l <= or_l: has_tested_l = True
            prev_dh = roll_h
            prev_dl = roll_l
            roll_h = max(roll_h, h)
            roll_l = min(roll_l, l)
            
            # --- 1. MANAGE ACTIVE POSITION ---
            if active_pos is not None:
                side = active_pos["side"]
                e_px = active_pos["entry_px"]
                curr_sl = active_pos["sl"]
                initial_sl = active_pos["initial_sl"]
                fav = (h - e_px) if side in ("CALL", "LONG") else (e_px - l)
                active_pos["max_fav"] = max(active_pos["max_fav"], fav)
                
                # Check Ratchets / Transitions
                mf = active_pos["max_fav"]
                
                # Scale-in Confirmation: Lot 1 -> Lot 2 on A+ setups
                if active_pos["is_a_plus"] and not active_pos["scaled_in"]:
                    if mf >= scale_trigger:
                        active_pos["scaled_in"] = True
                        active_pos["total_lots"] = 2

                # Trap / Expansion Pyramid: Lot 2 -> Lot 3
                if not active_pos["pyramided"]:
                    if mf >= pyr_trigger and active_pos["is_a_plus"]:
                        active_pos["pyramided"] = True
                        active_pos["total_lots"] = 3
                        # Move stop to locked profit
                        lock_dist = 20.0 if not is_sx else 80.0
                        if side in ("CALL", "LONG"):
                            curr_sl = max(curr_sl, e_px + lock_dist)
                        else:
                            curr_sl = min(curr_sl, e_px - lock_dist)
                        active_pos["sl"] = curr_sl
                        active_pos["stage"] = "TRAP_RUNNER_PYRAMID"
                
                # Ratchet Logic (Tier 0 Protection + 5-Tier Extended Ratchets)
                if mf >= r6_trig:
                    new_sl = (e_px + r6_lk) if side in ("CALL", "LONG") else (e_px - r6_lk)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= r5_trig:
                    new_sl = (e_px + r5_lk) if side in ("CALL", "LONG") else (e_px - r5_lk)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= r4_trig:
                    new_sl = (e_px + r4_lk) if side in ("CALL", "LONG") else (e_px - r4_lk)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= r3_trig:
                    new_sl = (e_px + r3_lk) if side in ("CALL", "LONG") else (e_px - r3_lk)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= r2_trig:
                    new_sl = (e_px + r2_lk) if side in ("CALL", "LONG") else (e_px - r2_lk)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= r1_trig:
                    new_sl = (e_px + r1_lk) if side in ("CALL", "LONG") else (e_px - r1_lk)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= t0_trig_2:
                    new_sl = (e_px + t0_lk_2) if side in ("CALL", "LONG") else (e_px - t0_lk_2)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                elif mf >= t0_trig_1:
                    new_sl = (e_px + t0_lk_1) if side in ("CALL", "LONG") else (e_px - t0_lk_1)
                    curr_sl = max(curr_sl, new_sl) if side in ("CALL", "LONG") else min(curr_sl, new_sl)
                active_pos["sl"] = curr_sl
                
                # Check Exit
                hit_sl = (l <= curr_sl) if side in ("CALL", "LONG") else (h >= curr_sl)
                is_eod = (t >= "15:15")
                
                if hit_sl or is_eod:
                    exit_px = curr_sl if hit_sl else c
                    exit_reason = ("RATCHET_LOCK" if curr_sl != initial_sl else "STOP_LOSS") if hit_sl else "EOD_1515"
                    pnl = (exit_px - e_px) if side in ("CALL", "LONG") else (e_px - exit_px)
                    
                    # Compute weighted PnL for smart sizing
                    base_lots = active_pos["base_lots"]
                    tot_lots = active_pos["total_lots"]
                    if not active_pos["is_a_plus"]:
                        weighted_pnl = round(pnl, 2)
                    else:
                        if pnl <= 0:
                            # If stopped out before scaling in, loss is ONLY 1 LOT!
                            lots_at_loss = 2 if active_pos["scaled_in"] else 1
                            weighted_pnl = round(pnl * lots_at_loss, 2)
                        else:
                            lot2_pnl = max(0.0, pnl - scale_trigger) if active_pos["scaled_in"] else 0.0
                            lot3_pnl = max(0.0, pnl - pyr_trigger) if active_pos["pyramided"] else 0.0
                            weighted_pnl = round(pnl + lot2_pnl + lot3_pnl, 2)
                            
                    fut_rs = round(weighted_pnl * lot_size, 2)
                    opt_rs = round(weighted_pnl * lot_size * delta, 2)
                    
                    strike_round = round(e_px / (100.0 if is_sx else 50.0)) * (100 if is_sx else 50)
                    strike = strike_round + (400 if is_sx else 150) if side in ("PUT", "SHORT") else strike_round - (400 if is_sx else 150)
                    opt_name = f"{symbol} {int(strike)} {'PE' if side in ('PUT', 'SHORT') else 'CE'} (ITM)"
                    
                    trades.append({
                        "date": d,
                        "year": dp["year"],
                        "trade_num": day_trades,
                        "stage": active_pos["stage"],
                        "origin": active_pos["origin"],
                        "side": "PUT" if side in ("PUT", "SHORT") else "CALL",
                        "option": opt_name,
                        "entry_time": active_pos["entry_time"],
                        "entry_price": round(e_px, 2),
                        "exit_time": t,
                        "exit_price": round(exit_px, 2),
                        "initial_sl": round(initial_sl, 2),
                        "final_sl": round(curr_sl, 2),
                        "pnl_points": round(pnl, 2),
                        "weighted_pnl_points": weighted_pnl,
                        "pnl_rupees": opt_rs,
                        "futures_pnl_rupees": fut_rs,
                        "max_fav": round(active_pos["max_fav"], 2),
                        "exit_reason": exit_reason,
                        "vix_chg": round(v_chg, 2),
                        "base_lots": base_lots,
                        "pyramided": active_pos["pyramided"],
                        "total_lots": tot_lots,
                    })
                    active_pos = None
                    last_exit_idx = i
                    if is_eod:
                        break
                    continue
            
            # --- 2. CHECK NEW ENTRY (IF NO ACTIVE POSITION & DAY_TRADES < 2) ---
            if active_pos is None and day_trades < 2 and t <= "12:30":
                # PHASE A: PRIORITY TO VIX TRAP DIVERGENCE (09:30 - 10:15)
                # Filter: on Nifty require vix_pts >= 0.40
                trap_valid = (not is_sx and v_pts >= 0.40) or is_sx
                
                if not trap_attempted and t <= "10:15" and trap_valid:
                    trap_sig = None
                    if v_chg >= 2.0 and has_tested_h and c < o and c < v and c < or_h:
                        trap_sig = "PUT"
                    elif v_chg <= -2.0 and has_tested_l and c > o and c > v and c > or_l:
                        trap_sig = "CALL"
                        
                    if trap_sig:
                        trap_attempted = True
                        day_trades += 1
                        is_a_plus = abs(v_chg) >= 3.5
                        base_lots = 1
                        
                        # Swing SL calculation
                        if trap_sig == "PUT":
                            swing_high = highs[:i+1].max()
                            sl_dist = max(trap_floor, min(trap_cap, swing_high - c + (10.0 if is_sx else 2.0)))
                            init_sl = c + sl_dist
                        else:
                            swing_low = lows[:i+1].min()
                            sl_dist = max(trap_floor, min(trap_cap, c - swing_low + (10.0 if is_sx else 2.0)))
                            init_sl = c - sl_dist
                            
                        active_pos = {
                            "origin": "VIX_TRAP",
                            "stage": "VIX_TRAP_SNIPER",
                            "side": trap_sig,
                            "entry_time": t,
                            "entry_px": c,
                            "sl": init_sl,
                            "initial_sl": init_sl,
                            "max_fav": 0.0,
                            "is_a_plus": is_a_plus,
                            "base_lots": 1,
                            "total_lots": 1,
                            "scaled_in": False,
                            "pyramided": False,
                        }
                        continue
                        
                # PHASE B: TREND RUNNER BREAKOUT EXPANSION (10:00 - 12:30)
                # If no Trap is running or if Trap was stopped out early
                if t >= "10:00":
                    runner_sig = None
                    
                    # Candle conviction & Rejection Wick Filter
                    c_rng = h - l
                    c_body = abs(c - o)
                    body_ratio = c_body / c_rng if c_rng > 0 else 0.0
                    uw_pct = (h - max(o, c)) / c_rng if c_rng > 0 else 0.0
                    lw_pct = (min(o, c) - l) / c_rng if c_rng > 0 else 0.0
                    
                    if day_trades == 0:
                        # Trade 1: Breakout beyond OR with conviction (body >= 55%, rejection wick <= 30%)
                        # Midday Chop Blackout: No new entries between 11:00 AM and 11:59 AM
                        if "11:00" <= t < "12:00":
                            continue
                        long_pass = (c > or_h) and (body_ratio >= 0.55) and (uw_pct <= 0.30)
                        short_pass = (c < or_l) and (body_ratio >= 0.55) and (lw_pct <= 0.30)
                    else:
                        # Trade 2 (Afternoon Re-entry): Only allowed AFTER 12:00 PM (bypassing morning revenge & lunch chop)
                        # Requires 30-min cool-off AND breaking Rolling Day Extreme
                        if t < "12:00":
                            continue
                        cool_off_ok = (i - last_exit_idx >= 30)
                        long_pass = cool_off_ok and (c > prev_dh) and (body_ratio >= 0.55) and (uw_pct <= 0.30)
                        short_pass = cool_off_ok and (c < prev_dl) and (body_ratio >= 0.55) and (lw_pct <= 0.30)
                    
                    # Long breakout: close > OR high and close > open and close > vwap
                    if long_pass and c > o and c > v:
                        # VIX confirming: VIX negative or flat
                        if v_chg <= 0.0 or (is_sx and v_chg < 1.0):
                            runner_sig = "CALL"
                    # Short breakout: close < OR low and close < open and close < vwap
                    elif short_pass and c < o and c < v:
                        # VIX confirming: VIX positive (spiking fear)
                        if v_chg >= 0.0 or (is_sx and v_chg > -1.0):
                            runner_sig = "PUT"
                            
                    if runner_sig:
                        day_trades += 1
                        is_a_plus = abs(v_chg) >= 3.5
                        base_lots = 1
                        
                        # Dynamic Swing SL calculation
                        if runner_sig == "CALL":
                            swing_low = lows[:i+1].min()
                            sl_dist = max(runner_sl_floor, min(runner_sl_cap, c - swing_low + runner_buffer))
                            init_sl = c - sl_dist
                        else:
                            swing_high = highs[:i+1].max()
                            sl_dist = max(runner_sl_floor, min(runner_sl_cap, swing_high - c + runner_buffer))
                            init_sl = c + sl_dist
                        
                        active_pos = {
                            "origin": "TREND_RUNNER",
                            "stage": "TREND_RUNNER_EXPANSION",
                            "side": runner_sig,
                            "entry_time": t,
                            "entry_px": c,
                            "sl": init_sl,
                            "initial_sl": init_sl,
                            "max_fav": 0.0,
                            "is_a_plus": is_a_plus,
                            "base_lots": 1,
                            "total_lots": 1,
                            "scaled_in": False,
                            "pyramided": False,
                        }
                        continue

    df_out = pd.DataFrame(trades)
    out_csv = ROOT / "performance" / f"{symbol.lower()}_vix_master_trades.csv"
    df_out.to_csv(out_csv, index=False)
    
    print(f"\n[{symbol.upper()} MASTER STRATEGY RESULTS]")
    print(f"Total Trades: {len(df_out)}")
    w = df_out[df_out["pnl_points"] > 0]
    wr = len(w) / len(df_out) * 100 if len(df_out) else 0.0
    print(f"Win Rate: {wr:.1f}% ({len(w)}W / {len(df_out)-len(w)}L)")
    print(f"1-Lot Net Points: {df_out['pnl_points'].sum():+,.2f} pts")
    print(f"Dynamic Net Points: {df_out['weighted_pnl_points'].sum():+,.2f} pts")
    print(f"Dynamic Options Profit: Rs. {df_out['pnl_rupees'].sum():+,.2f}")
    print(f"Futures PnL: Rs. {df_out['futures_pnl_rupees'].sum():+,.2f}")
    
    # Yearly breakdown
    print(f"\nYear-by-Year Performance ({symbol.upper()}):")
    for y, g in df_out.groupby("year"):
        yw = g[g["pnl_points"] > 0]
        ywr = len(yw) / len(g) * 100
        print(f"  {y}: {len(g):3d} trades | WR: {ywr:4.1f}% | Net Pts: {g['weighted_pnl_points'].sum():+8.1f} | Opt Rs: Rs. {g['pnl_rupees'].sum():+10,.2f}")
        
    return df_out

if __name__ == "__main__":
    df_nifty = run_unified_vix_master("NIFTY")
    df_sensex = run_unified_vix_master("SENSEX")
