#!/usr/bin/env python3
"""
Update VIX Divergence Trap Backtest Trades for Nifty (10Y) and Sensex (4Y)
Features:
  1. Swing High/Low Structural Initial Stop Loss (proportional to index value)
  2. Profit-Armed 5-Minute 20-EMA Dynamic Rail Exit (identical to Trend Runner)
  3. Symmetrical Dual-Partner Confirmation Gate: Both indices must confirm the EMA cross
     before exiting, filtering out micro-tick fakeouts when the partner is still trending.
  4. Proportional Noise Buffers: 3.5 pts on Nifty, 10.0 pts on Sensex to prevent noise triggers.
"""

import sys
from pathlib import Path
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from apex_duo_rules import is_ema20_armed, check_ema20_cross, check_initial_sl

# 1. Load VIX
print("Loading VIX data...", flush=True)
vdf = pd.read_csv("captured_data/india_vix_10y.csv")
vdf["date_str"] = pd.to_datetime(vdf["date"]).dt.strftime("%Y-%m-%d")
vdf["prev_close"] = vdf["close"].shift(1)
vdf["vix_pts_chg"] = (vdf["close"] - vdf["prev_close"]).abs()
vix_map = dict(zip(vdf["date_str"], vdf["vix_change_pct"].fillna(0.0)))
vix_pts_map = dict(zip(vdf["date_str"], vdf["vix_pts_chg"].fillna(0.0)))

# =====================================================================
# LOAD NIFTY 1-MIN & 5-MIN CANDLES (2017 - 2026)
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

df_nifty["ema200_1m"] = df_nifty["close"].ewm(span=200, adjust=False).mean()
day_1m_n_map = {d: g.set_index("time_str") for d, g in df_nifty.groupby("date_str")}

# Resample Nifty to 5m (kept for compatibility if needed)
df_nifty.set_index("timestamp", inplace=True)
ohlc_5m_n = df_nifty.resample("5min", closed="left", label="left").agg({
    "open": "first", "high": "max", "low": "min", "close": "last"
}).dropna().reset_index()
ohlc_5m_n["date_str"] = ohlc_5m_n["timestamp"].dt.strftime("%Y-%m-%d")
ohlc_5m_n["t_str"] = (ohlc_5m_n["timestamp"] + pd.to_timedelta(4, unit="m")).dt.strftime("%H:%M")
ohlc_5m_n["ema20"] = ohlc_5m_n.groupby("date_str")["close"].transform(lambda s: s.ewm(span=20, adjust=False).mean())
df_nifty.reset_index(inplace=True)
day_5m_n_map = {d: g.set_index("t_str") for d, g in ohlc_5m_n.groupby("date_str")}

# =====================================================================
# LOAD SENSEX 1-MIN & 5-MIN CANDLES (2023 - 2026)
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
dt_col_s = [c for c in df_sx.columns if "time" in c or "date" in c][0]
df_sx["timestamp"] = pd.to_datetime(df_sx[dt_col_s])
df_sx.sort_values("timestamp", inplace=True)
df_sx.drop_duplicates("timestamp", inplace=True)
df_sx.reset_index(drop=True, inplace=True)
df_sx["date_str"] = df_sx["timestamp"].dt.strftime("%Y-%m-%d")
df_sx["time_str"] = df_sx["timestamp"].dt.strftime("%H:%M")

tp_sx = (df_sx["high"] + df_sx["low"] + df_sx["close"]) / 3.0
cum_tp_sx = tp_sx.groupby(df_sx["date_str"]).cumsum()
counts_sx = df_sx.groupby(df_sx["date_str"]).cumcount() + 1
df_sx["vwap"] = cum_tp_sx / counts_sx

df_sx["ema200_1m"] = df_sx["close"].ewm(span=200, adjust=False).mean()
day_1m_s_map = {d: g.set_index("time_str") for d, g in df_sx.groupby("date_str")}

# Resample Sensex to 5m (kept for compatibility if needed)
df_sx.set_index("timestamp", inplace=True)
ohlc_5m_s = df_sx.resample("5min", closed="left", label="left").agg({
    "open": "first", "high": "max", "low": "min", "close": "last"
}).dropna().reset_index()
ohlc_5m_s["date_str"] = ohlc_5m_s["timestamp"].dt.strftime("%Y-%m-%d")
ohlc_5m_s["t_str"] = (ohlc_5m_s["timestamp"] + pd.to_timedelta(4, unit="m")).dt.strftime("%H:%M")
ohlc_5m_s["ema20"] = ohlc_5m_s.groupby("date_str")["close"].transform(lambda s: s.ewm(span=20, adjust=False).mean())
df_sx.reset_index(inplace=True)
day_5m_s_map = {d: g.set_index("t_str") for d, g in ohlc_5m_s.groupby("date_str")}

# Precompute candidate VIX Trap entries
nifty_entries = {}
for d, g in df_nifty.groupby("date_str"):
    if len(g) < 100: continue
    if vix_pts_map.get(d, 0.0) < 0.40: continue
    or_bars = g[(g["time_str"] >= "09:15") & (g["time_str"] <= "09:30")]
    if len(or_bars) == 0: continue
    or_high = float(or_bars["high"].max())
    or_low = float(or_bars["low"].min())
    if (or_high - or_low) < 25.0: continue
    times, opens, highs, lows, closes, vwaps = g["time_str"].values, g["open"].values, g["high"].values, g["low"].values, g["close"].values, g["vwap"].values
    has_th, has_tl = False, False
    v_chg = vix_map.get(d, 0.0)
    for i in range(len(g)):
        t = times[i]
        if t < "09:30": continue
        if t > "14:30": break
        h, l, c, o, v = highs[i], lows[i], closes[i], opens[i], vwaps[i]
        if h >= or_high: has_th = True
        if l <= or_low: has_tl = True
        sig = None
        if v_chg >= 2.0 and has_th and c < o and c < v and c < or_high: sig = "PUT"
        elif v_chg <= -2.0 and has_tl and c > o and c > v and c > or_low: sig = "CALL"
        if not sig: continue
        if sig == "PUT":
            sh = highs[:i+1].max()
            sld = max(25.0, min(80.0, sh - c + 2.0))
            isl = c + sld
        else:
            sl = lows[:i+1].min()
            sld = max(25.0, min(80.0, c - sl + 2.0))
            isl = c - sld
        nifty_entries[d] = {
            "date": d, "sig": sig, "time": t, "px": c, "sl": isl, "sld": sld, "bar": i,
            "times": times, "highs": highs, "lows": lows, "closes": closes, "v_chg": v_chg
        }
        break

sensex_entries = {}
for d, g in df_sx.groupby("date_str"):
    if len(g) < 100: continue
    or_bars = g[(g["time_str"] >= "09:15") & (g["time_str"] <= "09:30")]
    if len(or_bars) == 0: continue
    or_high = float(or_bars["high"].max())
    or_low = float(or_bars["low"].min())
    if (or_high - or_low) < 75.0: continue
    times, opens, highs, lows, closes, vwaps = g["time_str"].values, g["open"].values, g["high"].values, g["low"].values, g["close"].values, g["vwap"].values
    has_th, has_tl = False, False
    v_chg = vix_map.get(d, 0.0)
    for i in range(len(g)):
        t = times[i]
        if t < "09:30": continue
        if t > "14:30": break
        h, l, c, o, v = highs[i], lows[i], closes[i], opens[i], vwaps[i]
        if h >= or_high: has_th = True
        if l <= or_low: has_tl = True
        sig = None
        if v_chg >= 2.0 and has_th and c < o and c < v and c < or_high: sig = "PUT"
        elif v_chg <= -2.0 and has_tl and c > o and c > v and c > or_low: sig = "CALL"
        if not sig: continue
        if sig == "PUT":
            sh = highs[:i+1].max()
            sld = max(60.0, min(220.0, sh - c + 10.0))
            isl = c + sld
        else:
            sl = lows[:i+1].min()
            sld = max(60.0, min(220.0, c - sl + 10.0))
            isl = c - sld
        sensex_entries[d] = {
            "date": d, "sig": sig, "time": t, "px": c, "sl": isl, "sld": sld, "bar": i,
            "times": times, "highs": highs, "lows": lows, "closes": closes, "v_chg": v_chg
        }
        break

print(f"Precomputed {len(nifty_entries)} Nifty entries, {len(sensex_entries)} Sensex entries.", flush=True)

# =====================================================================
# SIMULATE NIFTY VIX TRAP (10-YEAR WITH DUAL SENSEX CONFIRMATION)
# =====================================================================
nifty_records = []
lot_size_nifty = 25
delta = 0.60

for d, en in nifty_entries.items():
    es = sensex_entries.get(d)
    has_dual_partner = (es is not None and es["sig"] == en["sig"])
    
    g1n = day_1m_n_map.get(d)
    g1s = day_1m_s_map.get(d)
    
    sig = en["sig"]
    e_px = en["px"]
    curr_sl = en["sl"]
    initial_sl = curr_sl
    sl_dist = en["sld"]
    times = en["times"]
    highs = en["highs"]
    lows = en["lows"]
    closes = en["closes"]
    e_bar = en["bar"]
    n_bars = len(times)
    v_chg = en["v_chg"]
    
    max_fav = 0.0
    ema_armed = False
    exit_px, exit_time, exit_reason = None, None, None
    
    for k in range(e_bar + 1, n_bars):
        bt = times[k]
        bh, bl, bc = highs[k], lows[k], closes[k]
        fav = (bh - e_px) if sig == "CALL" else (e_px - bl)
        if fav > max_fav: max_fav = fav
        if is_ema20_armed("NIFTY", max_fav): ema_armed = True
        
        # Structural Stop Loss
        if check_initial_sl(sig, bh, bl, curr_sl):
            exit_px = curr_sl
            exit_time = bt
            exit_reason = "STOP_LOSS"
            break
            
        # Symmetrical 1m 200-EMA Trail with Noise Buffer (10p Nifty / 30p Sensex)
        if ema_armed and g1n is not None and bt in g1n.index:
            r1_n = g1n.loc[bt]
            if isinstance(r1_n, pd.DataFrame): r1_n = r1_n.iloc[-1]
            c_1n, ema_1n = float(r1_n["close"]), float(r1_n["ema200_1m"])
            cross_n = check_ema20_cross("NIFTY", sig, c_1n, ema_1n)
            
            if has_dual_partner and g1s is not None and bt in g1s.index:
                r1_s = g1s.loc[bt]
                if isinstance(r1_s, pd.DataFrame): r1_s = r1_s.iloc[-1]
                c_1s, ema_1s = float(r1_s["close"]), float(r1_s["ema200_1m"])
                cross_s = check_ema20_cross("SENSEX", sig, c_1s, ema_1s)
                if cross_n and cross_s and bt > en["time"]:
                    exit_px = c_1n
                    exit_time = bt
                    exit_reason = "EMA20_CROSS"
                    break
            else:
                if cross_n and bt > en["time"]:
                    exit_px = c_1n
                    exit_time = bt
                    exit_reason = "EMA20_CROSS"
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
    
    is_a_plus = abs(v_chg) >= 3.5
    base_lots = 2 if is_a_plus else 1
    pyramided = (is_a_plus and max_fav >= 80.0 and pnl > 0)
    total_lots = (3 if pyramided else 2) if is_a_plus else 1
    
    if not is_a_plus:
        weighted_pnl = round(pnl, 2)
    else:
        if pnl <= 0:
            weighted_pnl = round(pnl * 2, 2)
        else:
            pyr_pnl = max(0.0, pnl - 80.0) if pyramided else 0.0
            weighted_pnl = round((pnl * 2) + pyr_pnl, 2)
        
    fut_pnl = round(weighted_pnl * lot_size_nifty, 2)
    opt_pnl = round(weighted_pnl * lot_size_nifty * delta, 2)
    
    nifty_records.append({
        "date": d,
        "trade_num": 1,
        "stage": "VIX_DIVERGENCE_REVERSAL",
        "side": sig,
        "option": opt_name,
        "option_symbol": "",
        "option_entry_price": 0.0,
        "option_exit_price": 0.0,
        "option_pnl_points": round(weighted_pnl * delta, 2),
        "option_pnl_rupees": opt_pnl,
        "entry_time": en["time"],
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
print(f"\nGenerated Nifty trades: {len(df_nifty_out)}")
print(f"  1-Lot Net Points: {df_nifty_out['pnl_points'].sum():+.2f} pts")
print(f"  Win Rate: {(df_nifty_out['pnl_points'] > 0).mean()*100:.1f}%\n", flush=True)

# =====================================================================
# SIMULATE SENSEX VIX TRAP (4-YEAR WITH DUAL NIFTY CONFIRMATION)
# =====================================================================
sx_records = []
lot_size_sx = 20

for d, es in sensex_entries.items():
    en = nifty_entries.get(d)
    has_dual_partner = (en is not None and en["sig"] == es["sig"])
    
    g1n = day_1m_n_map.get(d)
    g1s = day_1m_s_map.get(d)
    
    sig = es["sig"]
    e_px = es["px"]
    curr_sl = es["sl"]
    initial_sl = curr_sl
    sl_dist = es["sld"]
    times = es["times"]
    highs = es["highs"]
    lows = es["lows"]
    closes = es["closes"]
    e_bar = es["bar"]
    n_bars = len(times)
    v_chg = es["v_chg"]
    
    max_fav = 0.0
    ema_armed = False
    exit_px, exit_time, exit_reason = None, None, None
    
    for k in range(e_bar + 1, n_bars):
        bt = times[k]
        bh, bl, bc = highs[k], lows[k], closes[k]
        fav = (bh - e_px) if sig == "CALL" else (e_px - bl)
        if fav > max_fav: max_fav = fav
        if is_ema20_armed("SENSEX", max_fav): ema_armed = True
        
        # Structural Stop Loss
        if check_initial_sl(sig, bh, bl, curr_sl):
            exit_px = curr_sl
            exit_time = bt
            exit_reason = "STOP_LOSS"
            break
            
        # Symmetrical 1m 200-EMA Trail with Noise Buffer (30p Sensex / 10p Nifty)
        if ema_armed and g1s is not None and bt in g1s.index:
            r1_s = g1s.loc[bt]
            if isinstance(r1_s, pd.DataFrame): r1_s = r1_s.iloc[-1]
            c_1s, ema_1s = float(r1_s["close"]), float(r1_s["ema200_1m"])
            cross_s = check_ema20_cross("SENSEX", sig, c_1s, ema_1s)
            
            if has_dual_partner and g1n is not None and bt in g1n.index:
                r1_n = g1n.loc[bt]
                if isinstance(r1_n, pd.DataFrame): r1_n = r1_n.iloc[-1]
                c_1n, ema_1n = float(r1_n["close"]), float(r1_n["ema200_1m"])
                cross_n = check_ema20_cross("NIFTY", sig, c_1n, ema_1n)
                if cross_n and cross_s and bt > es["time"]:
                    exit_px = c_1s
                    exit_time = bt
                    exit_reason = "EMA20_CROSS"
                    break
            else:
                if cross_s and bt > es["time"]:
                    exit_px = c_1s
                    exit_time = bt
                    exit_reason = "EMA20_CROSS"
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
    
    strike_round = round(e_px / 100.0) * 100
    strike = strike_round + 400 if sig == "PUT" else strike_round - 400
    opt_name = f"SENSEX {int(strike)} {sig[:2]} (ITM-400)"
    
    is_a_plus = abs(v_chg) >= 3.5
    base_lots = 2 if is_a_plus else 1
    pyramided = (is_a_plus and max_fav >= 150.0 and pnl > 0)
    total_lots = (3 if pyramided else 2) if is_a_plus else 1
    
    if not is_a_plus:
        weighted_pnl = round(pnl, 2)
    else:
        if pnl <= 0:
            weighted_pnl = round(pnl * 2, 2)
        else:
            pyr_pnl = max(0.0, pnl - 150.0) if pyramided else 0.0
            weighted_pnl = round((pnl * 2) + pyr_pnl, 2)
        
    fut_pnl = round(weighted_pnl * lot_size_sx, 2)
    opt_pnl = round(weighted_pnl * lot_size_sx * delta, 2)
    
    sx_records.append({
        "date": d,
        "year": int(d[:4]),
        "trade_num": 1,
        "stage": "VIX_DIVERGENCE_REVERSAL",
        "side": sig,
        "option": opt_name,
        "option_symbol": "",
        "option_entry_price": 0.0,
        "option_exit_price": 0.0,
        "option_pnl_points": round(weighted_pnl * delta, 2),
        "option_pnl_rupees": opt_pnl,
        "entry_time": es["time"],
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
print(f"  Win Rate: {(df_sx_out['pnl_points'] > 0).mean()*100:.1f}%\n", flush=True)
print("SUCCESS: VIX Trap backtest trade logs updated with Dual-Partner Exit Gate + Noise Buffers!")
