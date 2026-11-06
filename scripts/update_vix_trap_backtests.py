#!/usr/bin/env python3
"""
Update VIX Divergence Trap Backtest Trades for Nifty (10Y) and Sensex (4Y)
Incorporates the Swing High/Low Stop Loss (capped at 60 pts on Nifty, 180 pts on Sensex)
to prevent premature wick stop-outs while respecting maximum risk boundaries.
"""

from pathlib import Path
import pandas as pd
import numpy as np

# 1. Load VIX
vdf = pd.read_csv("captured_data/india_vix_10y.csv")
vdf["date_str"] = pd.to_datetime(vdf["date"]).dt.strftime("%Y-%m-%d")
vix_map = dict(zip(vdf["date_str"], vdf["vix_change_pct"].fillna(0.0)))

# =====================================================================
# PART 1: NIFTY 10-YEAR VIX TRAP (2017 - 2026)
# =====================================================================
print("Loading Nifty 1-min data (2017-2026)...", flush=True)
years = [str(y) for y in range(2017, 2027)]
base_nifty = Path("captured_data/technovusin_nifty50/1min")
dfs = []
for y in years:
    yp = base_nifty / y
    if not yp.exists(): continue
    for f in sorted(yp.glob("*.csv")):
        dfs.append(pd.read_csv(f))
df_nifty = pd.concat(dfs, ignore_index=True)
df_nifty.columns = [c.lower() for c in df_nifty.columns]
dt_col = [c for c in df_nifty.columns if "time" in c or "date" in c][0]
df_nifty["timestamp"] = pd.to_datetime(df_nifty[dt_col])
df_nifty.sort_values("timestamp", inplace=True)
df_nifty.drop_duplicates("timestamp", inplace=True)
df_nifty.reset_index(drop=True, inplace=True)
df_nifty["date_str"] = df_nifty["timestamp"].dt.strftime("%Y-%m-%d")
df_nifty["time_str"] = df_nifty["timestamp"].dt.strftime("%H:%M")

tp_n = (df_nifty["high"] + df_nifty["low"] + df_nifty["close"]) / 3.0
cum_tp_n = tp_n.groupby(df_nifty["date_str"]).cumsum()
counts_n = df_nifty.groupby(df_nifty["date_str"]).cumcount() + 1
df_nifty["vwap"] = cum_tp_n / counts_n

nifty_packages = []
for d, g in df_nifty.groupby("date_str"):
    if len(g) < 100: continue
    or_bars = g[(g["time_str"] >= "09:15") & (g["time_str"] <= "09:30")]
    if len(or_bars) == 0: continue
    or_high = float(or_bars["high"].max())
    or_low = float(or_bars["low"].min())
    if (or_high - or_low) < 25.0: continue
    
    nifty_packages.append({
        "date": d,
        "vix_chg": vix_map.get(d, 0.0),
        "or_high": or_high,
        "or_low": or_low,
        "times": g["time_str"].values,
        "opens": g["open"].values,
        "highs": g["high"].values,
        "lows": g["low"].values,
        "closes": g["close"].values,
        "vwaps": g["vwap"].values,
        "n_bars": len(g)
    })

print(f"Indexed {len(nifty_packages)} Nifty trading days.", flush=True)

nifty_records = []
lot_size_nifty = 25
delta = 0.60

for dp in nifty_packages:
    v_chg = dp["vix_chg"]
    or_h = dp["or_high"]
    or_l = dp["or_low"]
    times, opens, highs, lows, closes, vwaps = dp["times"], dp["opens"], dp["highs"], dp["lows"], dp["closes"], dp["vwaps"]
    n_bars = dp["n_bars"]
    has_tested_high, has_tested_low = False, False
    entry = None
    
    for i in range(n_bars):
        t = times[i]
        if t < "09:30": continue
        if t > "12:30": break
        o, h, l, c, v = opens[i], highs[i], lows[i], closes[i], vwaps[i]
        if h >= or_h: has_tested_high = True
        if l <= or_l: has_tested_low = True
        
        sig = None
        if v_chg >= 2.0 and has_tested_high and c < o and c < v and c < or_h:
            sig = "PUT"
        elif v_chg <= -2.0 and has_tested_low and c > o and c > v and c > or_l:
            sig = "CALL"
        if not sig: continue
        
        # Swing SL with 60 pt cap and 25 pt floor
        if sig == "PUT":
            swing_high = highs[:i+1].max()
            sl_dist = max(25.0, min(60.0, swing_high - c + 2.0))
            initial_sl = c + sl_dist
        else:
            swing_low = lows[:i+1].min()
            sl_dist = max(25.0, min(60.0, c - swing_low + 2.0))
            initial_sl = c - sl_dist
            
        entry = (sig, t, c, initial_sl, sl_dist, i)
        break
        
    if not entry: continue
    
    sig, e_time, e_px, initial_sl, sl_dist, e_bar = entry
    curr_sl = initial_sl
    exit_px = None
    exit_time = None
    max_fav = 0.0
    exit_reason = None
    
    for k in range(e_bar + 1, n_bars):
        bt = times[k]
        bh, bl, bc = highs[k], lows[k], closes[k]
        fav = (bh - e_px) if sig == "CALL" else (e_px - bl)
        if fav > max_fav: max_fav = fav
        
        # Breathing room ratchet locks
        if max_fav >= 50.0:
            r1 = e_px + 20.0 if sig == "CALL" else e_px - 20.0
            if (sig == "CALL" and r1 > curr_sl) or (sig == "PUT" and r1 < curr_sl): curr_sl = r1
        if max_fav >= 100.0:
            r2 = e_px + 60.0 if sig == "CALL" else e_px - 60.0
            if (sig == "CALL" and r2 > curr_sl) or (sig == "PUT" and r2 < curr_sl): curr_sl = r2
        if max_fav >= 150.0:
            r3 = e_px + 100.0 if sig == "CALL" else e_px - 100.0
            if (sig == "CALL" and r3 > curr_sl) or (sig == "PUT" and r3 < curr_sl): curr_sl = r3
            
        if (bl <= curr_sl if sig == "CALL" else bh >= curr_sl):
            exit_px = curr_sl
            exit_time = bt
            exit_reason = "RATCHET_LOCK" if curr_sl != initial_sl else "STOP_LOSS"
            break
        if bt >= "15:15":
            exit_px = bc
            exit_time = bt
            exit_reason = "EOD_1515"
            break
            
    if exit_px is None:
        exit_px = closes[-1]
        exit_time = times[-1]
        exit_reason = "EOD"
        
    pnl = (exit_px - e_px) if sig == "CALL" else (e_px - exit_px)
    
    # Strike selection (ITM 150 pts)
    strike_round = round(e_px / 50.0) * 50
    strike = strike_round + 150 if sig == "PUT" else strike_round - 150
    opt_name = f"NIFTY {int(strike)} {sig[:2]} (ITM-150)"
    
    base_lots = 2
    pyramided = (max_fav >= 60.0 and pnl > 0)
    total_lots = 3 if pyramided else 2
    
    if pnl <= 0:
        weighted_pnl = round(pnl * 2, 2)
    else:
        pyr_pnl = max(0.0, pnl - 60.0) if pyramided else 0.0
        weighted_pnl = round((pnl * 2) + pyr_pnl, 2)
        
    fut_pnl = round(weighted_pnl * lot_size_nifty, 2)
    opt_pnl = round(weighted_pnl * lot_size_nifty * delta, 2)
    
    nifty_records.append({
        "date": dp["date"],
        "trade_num": 1,
        "stage": "VIX_DIVERGENCE_REVERSAL",
        "side": sig,
        "option": opt_name,
        "option_symbol": "",
        "option_entry_price": 0.0,
        "option_exit_price": 0.0,
        "option_pnl_points": round(weighted_pnl * delta, 2),
        "option_pnl_rupees": opt_pnl,
        "entry_time": e_time,
        "entry_price": round(e_px, 2),
        "exit_time": exit_time,
        "exit_price": round(exit_px, 2),
        "initial_sl": round(initial_sl, 2),
        "final_sl": round(curr_sl, 2),
        "pnl_points": round(pnl, 2),
        "pnl_rupees": opt_pnl,
        "futures_pnl_rupees": fut_pnl,
        "diff_rupees": round(fut_pnl - opt_pnl, 2),
        "max_fav": round(max_fav, 2),
        "rr": round(pnl / sl_dist, 2),
        "exit_reason": exit_reason,
        "vix_chg": round(v_chg, 2),
        "base_lots": base_lots,
        "pyramided": pyramided,
        "total_lots": total_lots,
        "weighted_pnl_points": weighted_pnl
    })

df_nifty_out = pd.DataFrame(nifty_records)
df_nifty_out.to_csv("performance/vix_divergence_backtest_trades.csv", index=False)
print(f"Generated Nifty trades: {len(df_nifty_out)}")
print(f"  1-Lot Net Points: {df_nifty_out['pnl_points'].sum():+.2f} pts")
print(f"  Dynamic 2+1 Net Points: {df_nifty_out['weighted_pnl_points'].sum():+.2f} pts")
print(f"  Win Rate: {(df_nifty_out['pnl_points'] > 0).mean()*100:.1f}%\n", flush=True)

# =====================================================================
# PART 2: SENSEX 4-YEAR VIX TRAP (2023 - 2026)
# =====================================================================
print("Loading Sensex 1-min data (2023-2026)...", flush=True)
base_sx = Path("captured_data/technovusin_sensex/1min")
dfs_sx = []
for y in ["2023", "2024", "2025"]:
    f = base_sx / y / f"SENSEX_1min_{y}.csv"
    if f.exists(): dfs_sx.append(pd.read_csv(f))
for f in sorted((base_sx / "2026").glob("*.csv")):
    dfs_sx.append(pd.read_csv(f))
df_sx = pd.concat(dfs_sx, ignore_index=True)
df_sx.columns = [c.lower() for c in df_sx.columns]
dt_col = [c for c in df_sx.columns if "time" in c or "date" in c][0]
df_sx["timestamp"] = pd.to_datetime(df_sx[dt_col])
df_sx.sort_values("timestamp", inplace=True)
df_sx.drop_duplicates("timestamp", inplace=True)
df_sx.reset_index(drop=True, inplace=True)
df_sx["date_str"] = df_sx["timestamp"].dt.strftime("%Y-%m-%d")
df_sx["time_str"] = df_sx["timestamp"].dt.strftime("%H:%M")

tp_sx = (df_sx["high"] + df_sx["low"] + df_sx["close"]) / 3.0
cum_tp_sx = tp_sx.groupby(df_sx["date_str"]).cumsum()
counts_sx = df_sx.groupby(df_sx["date_str"]).cumcount() + 1
df_sx["vwap"] = cum_tp_sx / counts_sx

sx_packages = []
for d, g in df_sx.groupby("date_str"):
    if len(g) < 100: continue
    or_bars = g[(g["time_str"] >= "09:15") & (g["time_str"] <= "09:30")]
    if len(or_bars) == 0: continue
    or_high = float(or_bars["high"].max())
    or_low = float(or_bars["low"].min())
    if (or_high - or_low) < 75.0: continue
    
    sx_packages.append({
        "date": d,
        "year": int(d[:4]),
        "vix_chg": vix_map.get(d, 0.0),
        "or_high": or_high,
        "or_low": or_low,
        "times": g["time_str"].values,
        "opens": g["open"].values,
        "highs": g["high"].values,
        "lows": g["low"].values,
        "closes": g["close"].values,
        "vwaps": g["vwap"].values,
        "n_bars": len(g)
    })

print(f"Indexed {len(sx_packages)} Sensex trading days.", flush=True)

sx_records = []
lot_size_sx = 20

for dp in sx_packages:
    v_chg = dp["vix_chg"]
    or_h = dp["or_high"]
    or_l = dp["or_low"]
    times, opens, highs, lows, closes, vwaps = dp["times"], dp["opens"], dp["highs"], dp["lows"], dp["closes"], dp["vwaps"]
    n_bars = dp["n_bars"]
    has_tested_high, has_tested_low = False, False
    entry = None
    
    for i in range(n_bars):
        t = times[i]
        if t < "09:30": continue
        if t > "12:30": break
        o, h, l, c, v = opens[i], highs[i], lows[i], closes[i], vwaps[i]
        if h >= or_h: has_tested_high = True
        if l <= or_l: has_tested_low = True
        
        sig = None
        if v_chg >= 2.0 and has_tested_high and c < o and c < v and c < or_h:
            sig = "SELL"
        elif v_chg <= -2.0 and has_tested_low and c > o and c > v and c > or_l:
            sig = "BUY"
        if not sig: continue
        
        # Swing SL with 120 pt cap and 60 pt floor (aligns with Trend Runner max 240 pt 2-lot risk)
        if sig == "SELL":
            swing_high = highs[:i+1].max()
            sl_dist = max(60.0, min(120.0, swing_high - c + 10.0))
            initial_sl = c + sl_dist
        else:
            swing_low = lows[:i+1].min()
            sl_dist = max(60.0, min(120.0, c - swing_low + 10.0))
            initial_sl = c - sl_dist
            
        entry = (sig, t, c, initial_sl, sl_dist, i)
        break
        
    if not entry: continue
    
    sig, e_time, e_px, initial_sl, sl_dist, e_bar = entry
    curr_sl = initial_sl
    exit_px = None
    exit_time = None
    max_fav = 0.0
    exit_reason = None
    
    for k in range(e_bar + 1, n_bars):
        bt = times[k]
        bh, bl, bc = highs[k], lows[k], closes[k]
        fav = (bh - e_px) if sig == "BUY" else (e_px - bl)
        if fav > max_fav: max_fav = fav
        
        if max_fav >= 100.0:
            r1 = e_px + 20.0 if sig == "BUY" else e_px - 20.0
            if (sig == "BUY" and r1 > curr_sl) or (sig == "SELL" and r1 < curr_sl): curr_sl = r1
        if max_fav >= 180.0:
            r2 = e_px + 90.0 if sig == "BUY" else e_px - 90.0
            if (sig == "BUY" and r2 > curr_sl) or (sig == "SELL" and r2 < curr_sl): curr_sl = r2
        if max_fav >= 300.0:
            r3 = e_px + 180.0 if sig == "BUY" else e_px - 180.0
            if (sig == "BUY" and r3 > curr_sl) or (sig == "SELL" and r3 < curr_sl): curr_sl = r3
            
        if (bl <= curr_sl if sig == "BUY" else bh >= curr_sl):
            exit_px = curr_sl
            exit_time = bt
            exit_reason = "RATCHET_LOCK" if curr_sl != initial_sl else "STOP_LOSS"
            break
        if bt >= "15:15":
            exit_px = bc
            exit_time = bt
            exit_reason = "EOD_1515"
            break
            
    if exit_px is None:
        exit_px = closes[-1]
        exit_time = times[-1]
        exit_reason = "EOD"
        
    pnl = (exit_px - e_px) if sig == "BUY" else (e_px - exit_px)
    side = "PUT" if sig == "SELL" else "CALL"
    
    strike_round = round(e_px / 100.0) * 100
    strike = strike_round + 400 if side == "PUT" else strike_round - 400
    opt_name = f"SENSEX {int(strike)} {side[:2]} (ITM-400)"
    
    base_lots = 2
    pyramided = (max_fav >= 150.0 and pnl > 0)
    total_lots = 3 if pyramided else 2
    
    if pnl <= 0:
        weighted_pnl = round(pnl * 2, 2)
    else:
        pyr_pnl = max(0.0, pnl - 150.0) if pyramided else 0.0
        weighted_pnl = round((pnl * 2) + pyr_pnl, 2)
        
    fut_pnl = round(weighted_pnl * lot_size_sx, 2)
    opt_pnl = round(weighted_pnl * lot_size_sx * delta, 2)
    
    sx_records.append({
        "date": dp["date"],
        "year": dp["year"],
        "trade_num": 1,
        "stage": "VIX_DIVERGENCE_REVERSAL",
        "side": side,
        "option": opt_name,
        "option_symbol": "",
        "option_entry_price": 0.0,
        "option_exit_price": 0.0,
        "option_pnl_points": round(weighted_pnl * delta, 2),
        "option_pnl_rupees": opt_pnl,
        "entry_time": e_time,
        "entry_price": round(e_px, 2),
        "exit_time": exit_time,
        "exit_price": round(exit_px, 2),
        "initial_sl": round(initial_sl, 2),
        "final_sl": round(curr_sl, 2),
        "pnl_points": round(pnl, 2),
        "pnl_rupees": opt_pnl,
        "futures_pnl_rupees": fut_pnl,
        "diff_rupees": round(fut_pnl - opt_pnl, 2),
        "max_fav": round(max_fav, 2),
        "rr": round(pnl / sl_dist, 2),
        "exit_reason": exit_reason,
        "vix_chg": round(v_chg, 2),
        "base_lots": base_lots,
        "pyramided": pyramided,
        "total_lots": total_lots,
        "weighted_pnl_points": weighted_pnl
    })

df_sx_out = pd.DataFrame(sx_records)
df_sx_out.to_csv("performance/sensex_vix_divergence_trades.csv", index=False)
print(f"Generated Sensex trades: {len(df_sx_out)}")
print(f"  1-Lot Net Points: {df_sx_out['pnl_points'].sum():+.2f} pts")
print(f"  Dynamic 2+1 Net Points: {df_sx_out['weighted_pnl_points'].sum():+.2f} pts")
print(f"  Win Rate: {(df_sx_out['pnl_points'] > 0).mean()*100:.1f}%\n", flush=True)

print("SUCCESS: Both Nifty and Sensex backtest trade logs updated with Swing SL logic!", flush=True)
