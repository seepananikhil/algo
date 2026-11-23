#!/usr/bin/env python3
"""
Comprehensive Comparative Backtest:
Fixed Spot Ratchet vs Swing Structure Trailing (Previous Swing High/Low)

Evaluates:
  Mode A: Baseline Fixed Spot Ratchet (Current Production - 1m intra-bar tick exit)
  Mode B: 5-Minute Candle-by-Candle Trailing (Close confirmed above/below prev candle high/low)
  Mode C: 5-Minute Swing Pivot Trailing (Confirmed Swing Pivot Highs/Lows, Close confirmed)
  Mode D: 5-Minute 20-EMA Trend Trailing (Close confirmed beyond EMA20)
  Mode E: Hybrid (Breakout + Breakeven Lock at +1R, then Swing Pivot Trailing)
"""

import sys
from pathlib import Path
from datetime import datetime
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent

# Load India VIX 10-Year Daily Data
vix_path = ROOT / "captured_data" / "india_vix_10y.csv"
vix_df = pd.read_csv(vix_path)
vix_df["date"] = pd.to_datetime(vix_df["date"]).dt.date
vix_map = dict(zip(vix_df["date"], vix_df["vix_change_pct"]))
vix_lvl_map = dict(zip(vix_df["date"], vix_df["close"]))

# Load recorded intraday VIX signals if available
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


def resample_to_5m(df_1m: pd.DataFrame) -> pd.DataFrame:
    """Aggregate 1-minute OHLCV into 5-minute bars."""
    df = df_1m.copy()
    df.set_index("timestamp", inplace=True)
    df_5m = df.resample("5min", closed="left", label="left").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "vwap": "last",
    }).dropna().reset_index()
    df_5m["time_str"] = df_5m["timestamp"].dt.strftime("%H:%M")
    # Calculate 20 EMA on 5m
    df_5m["ema20"] = df_5m["close"].ewm(span=20, adjust=False).mean()
    return df_5m


def run_trailing_comparison(symbol: str = "SENSEX", years: list = None):
    lot_size = 20 if symbol == "SENSEX" else 25
    base_sl = 120.0 if symbol == "SENSEX" else 30.0
    wick_noise = 15.0 if symbol == "SENSEX" else 4.0
    r_mult = 3.3 if symbol == "SENSEX" else 1.0

    # Ratchet parameters
    t0_trig_1 = 115.0 if symbol == "SENSEX" else 35.0
    t0_lk_1 = -40.0 if symbol == "SENSEX" else -12.0
    t0_trig_2 = 180.0 if symbol == "SENSEX" else 50.0
    t0_lk_2 = 15.0 if symbol == "SENSEX" else 5.0

    r1_trig = 240.0 if symbol == "SENSEX" else 70.0
    r1_lk = 80.0 if symbol == "SENSEX" else 20.0
    r2_trig = 340.0 if symbol == "SENSEX" else 110.0
    r2_lk = 180.0 if symbol == "SENSEX" else 50.0
    r3_trig = 480.0 if symbol == "SENSEX" else 180.0
    r3_lk = 280.0 if symbol == "SENSEX" else 110.0
    r4_trig = 650.0 if symbol == "SENSEX" else 230.0
    r4_lk = 420.0 if symbol == "SENSEX" else 165.0
    r5_trig = 850.0 if symbol == "SENSEX" else 280.0
    r5_lk = 600.0 if symbol == "SENSEX" else 220.0
    r6_trig = 1100.0 if symbol == "SENSEX" else 330.0
    r6_lk = 850.0 if symbol == "SENSEX" else 270.0

    if symbol == "SENSEX":
        base_dir = ROOT / "captured_data" / "technovusin_sensex" / "1min"
    else:
        base_dir = ROOT / "captured_data" / "technovusin_nifty50" / "1min"

    all_csvs = sorted(base_dir.rglob("*.csv"))
    if years:
        all_csvs = [f for f in all_csvs if any(f"\\{y}\\" in str(f) or f"/{y}/" in str(f) or f.stem.endswith(str(y)) for y in years)]

    print(f"[{symbol}] Processing {len(all_csvs)} files across years {years or 'all'}...")

    # Trades buckets
    modes = {
        "A_Fixed_Ratchets": [],
        "B_5m_Candle_Trail": [],
        "C_5m_Swing_Pivot": [],
        "D_5m_EMA20_Trail": [],
        "E_Hybrid_BE_Swing": []
    }

    total_days = 0

    for csv_file in all_csvs:
        try:
            df_raw = pd.read_csv(csv_file)
        except Exception:
            continue

        df_raw.rename(columns={
            "Timestamp": "timestamp",
            "Open": "open",
            "High": "high",
            "Low": "low",
            "Close": "close"
        }, inplace=True)
        df_raw["timestamp"] = pd.to_datetime(df_raw["timestamp"])
        df_raw.sort_values("timestamp", inplace=True)
        df_raw.drop_duplicates("timestamp", inplace=True)
        df_raw.reset_index(drop=True, inplace=True)
        df_raw["date"] = df_raw["timestamp"].dt.date
        df_raw["time_str"] = df_raw["timestamp"].dt.strftime("%H:%M")

        tp = (df_raw["high"] + df_raw["low"] + df_raw["close"]) / 3.0
        cum_tp = tp.groupby(df_raw["date"]).cumsum()
        counts = df_raw.groupby(df_raw["date"]).cumcount() + 1
        df_raw["vwap"] = cum_tp / counts

        days = sorted(df_raw["date"].unique())

        for d in days:
            if d.weekday() >= 5:
                continue
            g_1m = df_raw[df_raw["date"] == d].copy().reset_index(drop=True)
            if len(g_1m) < 150:
                continue

            total_days += 1
            vix_chg = vix_map.get(d, 0.0)

            or_bars = g_1m[(g_1m["time_str"] >= "09:15") & (g_1m["time_str"] <= "09:30")]
            if or_bars.empty:
                continue
            or_high = float(or_bars["high"].max())
            or_low = float(or_bars["low"].min())
            or_range = or_high - or_low

            min_or_req = 80.0 if symbol == "SENSEX" else 30.0
            if or_range < min_or_req:
                continue

            # Identify Trade 1 Breakout Trigger (Same for all modes)
            entry_idx = None
            entry_sig = None
            rolling_dh = or_high
            rolling_dl = or_low
            tested_or_high = False
            tested_or_low = False

            for idx in range(len(g_1m)):
                row = g_1m.iloc[idx]
                t_str = row["time_str"]
                c = row["close"]
                o = row["open"]
                h = row["high"]
                l = row["low"]
                vwap = row["vwap"]

                prev_dh = rolling_dh
                prev_dl = rolling_dl
                if h > rolling_dh:
                    rolling_dh = h
                if l < rolling_dl:
                    rolling_dl = l

                if t_str >= "09:30":
                    if h >= or_high:
                        tested_or_high = True
                    if l <= or_low:
                        tested_or_low = True

                if t_str < "09:30" or t_str > "11:00":
                    continue

                candle_rng = h - l
                candle_body = abs(c - o)
                body_ratio = candle_body / candle_rng if candle_rng > 0 else 0.0
                upper_wick = h - max(o, c)
                lower_wick = min(o, c) - l
                upper_pct = upper_wick / candle_rng if candle_rng > 0 else 0.0
                lower_pct = lower_wick / candle_rng if candle_rng > 0 else 0.0

                long_conv = (upper_pct <= 0.30) or (upper_wick <= wick_noise)
                short_conv = (lower_pct <= 0.30) or (lower_wick <= wick_noise)

                sig = None
                # Conviction >= 80% with vix confirmation
                if body_ratio >= 0.80:
                    if (c > prev_dh) and (c > o) and (c > vwap) and (vix_chg <= 0.0) and long_conv:
                        sig = "LONG"
                    elif (c < prev_dl) and (c < o) and (c < vwap) and (vix_chg >= 0.0) and short_conv:
                        sig = "SHORT"
                # Standard >= 70% with strict vix
                if not sig and body_ratio >= 0.70:
                    v_call_th = 1.8 if symbol == "NIFTY" else 0.0
                    if (c > prev_dh) and (c > o) and (c > vwap) and (vix_chg <= -v_call_th) and long_conv:
                        sig = "LONG"
                    elif (c < prev_dl) and (c < o) and (c < vwap) and (vix_chg >= 0.0) and short_conv:
                        sig = "SHORT"

                if sig:
                    entry_idx = idx
                    entry_sig = sig
                    break

            if entry_idx is None:
                continue

            entry_row = g_1m.iloc[entry_idx]
            entry_px = float(entry_row["close"])
            entry_time = entry_row["time_str"]
            bars_post_entry = g_1m.iloc[entry_idx + 1:].copy().reset_index(drop=True)
            if bars_post_entry.empty:
                continue

            # 5-min bars for the day
            g_5m = resample_to_5m(g_1m)

            # Previous swing high / low before breakout
            # 09:15 to entry_time bars
            pre_entry_bars = g_1m.iloc[:entry_idx + 1]
            swing_high_pre = float(pre_entry_bars["high"].max())
            swing_low_pre = float(pre_entry_bars["low"].min())
            candle_0930_high = float(g_1m[g_1m["time_str"] == "09:30"]["high"].max()) if not g_1m[g_1m["time_str"] == "09:30"].empty else swing_high_pre
            candle_0930_low = float(g_1m[g_1m["time_str"] == "09:30"]["low"].min()) if not g_1m[g_1m["time_str"] == "09:30"].empty else swing_low_pre

            # ==========================================
            # MODE A: Current Baseline (Fixed Spot Ratchets on 1-min ticks)
            # ==========================================
            curr_sl_A = (entry_px - base_sl) if entry_sig == "LONG" else (entry_px + base_sl)
            max_fav_A = 0.0
            exit_px_A = float(bars_post_entry.iloc[-1]["close"])
            exit_time_A = "15:15"
            exit_reason_A = "EOD"

            for b_idx in range(len(bars_post_entry)):
                b = bars_post_entry.iloc[b_idx]
                bh = float(b["high"])
                bl = float(b["low"])
                bc = float(b["close"])
                bt = str(b["time_str"])

                fav = (bh - entry_px) if entry_sig == "LONG" else (entry_px - bl)
                if fav > max_fav_A:
                    max_fav_A = fav

                # Tier 0A
                if max_fav_A >= t0_trig_1:
                    lvl = entry_px + t0_lk_1 if entry_sig == "LONG" else entry_px - t0_lk_1
                    if (entry_sig == "LONG" and lvl > curr_sl_A) or (entry_sig == "SHORT" and lvl < curr_sl_A):
                        curr_sl_A = lvl
                # Tier 0B
                if max_fav_A >= t0_trig_2:
                    lvl = entry_px + t0_lk_2 if entry_sig == "LONG" else entry_px - t0_lk_2
                    if (entry_sig == "LONG" and lvl > curr_sl_A) or (entry_sig == "SHORT" and lvl < curr_sl_A):
                        curr_sl_A = lvl
                # Tiers 1 - 6
                for trig, lk in [(r1_trig, r1_lk), (r2_trig, r2_lk), (r3_trig, r3_lk),
                                 (r4_trig, r4_lk), (r5_trig, r5_lk), (r6_trig, r6_lk)]:
                    if max_fav_A >= trig:
                        lvl = entry_px + lk if entry_sig == "LONG" else entry_px - lk
                        if (entry_sig == "LONG" and lvl > curr_sl_A) or (entry_sig == "SHORT" and lvl < curr_sl_A):
                            curr_sl_A = lvl

                # Exit check
                if entry_sig == "LONG" and bl <= curr_sl_A:
                    exit_px_A = curr_sl_A
                    exit_time_A = bt
                    exit_reason_A = "RATCHET_LOCK" if curr_sl_A > entry_px else "STOP_LOSS"
                    break
                elif entry_sig == "SHORT" and bh >= curr_sl_A:
                    exit_px_A = curr_sl_A
                    exit_time_A = bt
                    exit_reason_A = "RATCHET_LOCK" if curr_sl_A < entry_px else "STOP_LOSS"
                    break
                if bt >= "15:15":
                    exit_px_A = bc
                    exit_time_A = bt
                    exit_reason_A = "EOD"
                    break

            pnl_pts_A = (exit_px_A - entry_px) if entry_sig == "LONG" else (entry_px - exit_px_A)
            modes["A_Fixed_Ratchets"].append({
                "date": d, "entry_time": entry_time, "exit_time": exit_time_A,
                "side": entry_sig, "entry_px": entry_px, "exit_px": exit_px_A,
                "pnl_pts": pnl_pts_A, "max_fav": max_fav_A, "exit_reason": exit_reason_A
            })

            # ==========================================
            # 5-MINUTE FRAMEWORK SETUP FOR MODES B, C, D, E
            # ==========================================
            entry_5m_idx = None
            for idx_5m in range(len(g_5m)):
                if g_5m.iloc[idx_5m]["time_str"] >= entry_time:
                    entry_5m_idx = idx_5m
                    break
            if entry_5m_idx is None:
                continue

            bars_5m_post = g_5m.iloc[entry_5m_idx:].copy().reset_index(drop=True)

            # Initial SL specifically at 09:30 candle high/low (as requested by user)
            max_sl_cap = 350.0 if symbol == "SENSEX" else 80.0
            catastrophic_sl_pts = max_sl_cap * 1.5

            if entry_sig == "SHORT":
                raw_sl = candle_0930_high
                init_sl_user = min(entry_px + max_sl_cap, max(raw_sl, entry_px + base_sl * 0.75))
            else:
                raw_sl = candle_0930_low
                init_sl_user = max(entry_px - max_sl_cap, min(raw_sl, entry_px - base_sl * 0.75))

            curr_sl_B = init_sl_user
            exit_px_B = float(bars_5m_post.iloc[-1]["close"])
            exit_time_B = "15:15"
            exit_reason_B = "EOD"
            max_fav_B = 0.0

            for i in range(len(bars_5m_post)):
                b5 = bars_5m_post.iloc[i]
                b5_c = float(b5["close"])
                b5_h = float(b5["high"])
                b5_l = float(b5["low"])
                b5_t = str(b5["time_str"])

                fav = (b5_h - entry_px) if entry_sig == "LONG" else (entry_px - b5_l)
                if fav > max_fav_B:
                    max_fav_B = fav

                # Catastrophic intra-bar hard stop
                if entry_sig == "SHORT" and b5_h >= entry_px + catastrophic_sl_pts:
                    exit_px_B = entry_px + catastrophic_sl_pts
                    exit_time_B = b5_t
                    exit_reason_B = "CATASTROPHIC_SL"
                    break
                elif entry_sig == "LONG" and b5_l <= entry_px - catastrophic_sl_pts:
                    exit_px_B = entry_px - catastrophic_sl_pts
                    exit_time_B = b5_t
                    exit_reason_B = "CATASTROPHIC_SL"
                    break

                # Candle close confirmation check
                if entry_sig == "SHORT":
                    if b5_c > curr_sl_B:
                        exit_px_B = b5_c
                        exit_time_B = b5_t
                        exit_reason_B = "TRAIL_CLOSE" if curr_sl_B < entry_px else "SL_CLOSE"
                        break
                    # Trail: High of previous 5m candle
                    if i > 0:
                        prev_5m = bars_5m_post.iloc[i - 1]
                        # If price moved lower than previous low, trail stop down
                        if b5_l < float(prev_5m["low"]):
                            cand_trail = float(prev_5m["high"])
                            if cand_trail < curr_sl_B:
                                curr_sl_B = cand_trail
                else: # LONG
                    if b5_c < curr_sl_B:
                        exit_px_B = b5_c
                        exit_time_B = b5_t
                        exit_reason_B = "TRAIL_CLOSE" if curr_sl_B > entry_px else "SL_CLOSE"
                        break
                    if i > 0:
                        prev_5m = bars_5m_post.iloc[i - 1]
                        if b5_h > float(prev_5m["high"]):
                            cand_trail = float(prev_5m["low"])
                            if cand_trail > curr_sl_B:
                                curr_sl_B = cand_trail

                if b5_t >= "15:15":
                    exit_px_B = b5_c
                    exit_time_B = b5_t
                    exit_reason_B = "EOD"
                    break

            pnl_pts_B = (exit_px_B - entry_px) if entry_sig == "LONG" else (entry_px - exit_px_B)
            modes["B_5m_Candle_Trail"].append({
                "date": d, "entry_time": entry_time, "exit_time": exit_time_B,
                "side": entry_sig, "entry_px": entry_px, "exit_px": exit_px_B,
                "pnl_pts": pnl_pts_B, "max_fav": max_fav_B, "exit_reason": exit_reason_B
            })

            # ------------------------------------------
            # MODE C: 5-Minute Swing Pivot Trailing (Major Pullback Highs/Lows)
            # ------------------------------------------
            curr_sl_C = init_sl_user
            exit_px_C = float(bars_5m_post.iloc[-1]["close"])
            exit_time_C = "15:15"
            exit_reason_C = "EOD"
            max_fav_C = 0.0
            swing_pivot_ext = entry_px

            # Keep rolling swing high / low
            recent_highs = [float(bars_5m_post.iloc[0]["high"])]
            recent_lows = [float(bars_5m_post.iloc[0]["low"])]

            for i in range(len(bars_5m_post)):
                b5 = bars_5m_post.iloc[i]
                b5_c = float(b5["close"])
                b5_h = float(b5["high"])
                b5_l = float(b5["low"])
                b5_t = str(b5["time_str"])

                fav = (b5_h - entry_px) if entry_sig == "LONG" else (entry_px - b5_l)
                if fav > max_fav_C:
                    max_fav_C = fav

                # Catastrophic stop
                if entry_sig == "SHORT" and b5_h >= entry_px + catastrophic_sl_pts:
                    exit_px_C = entry_px + catastrophic_sl_pts
                    exit_time_C = b5_t
                    exit_reason_C = "CATASTROPHIC_SL"
                    break
                elif entry_sig == "LONG" and b5_l <= entry_px - catastrophic_sl_pts:
                    exit_px_C = entry_px - catastrophic_sl_pts
                    exit_time_C = b5_t
                    exit_reason_C = "CATASTROPHIC_SL"
                    break

                recent_highs.append(b5_h)
                recent_lows.append(b5_l)

                # Identify 3-bar swing pivot on 5m chart:
                # When bar i is lower than bar i-1 and bar i-2 was lower than i-1, bar i-1 is a swing high pivot
                if entry_sig == "SHORT":
                    if b5_c > curr_sl_C:
                        exit_px_C = b5_c
                        exit_time_C = b5_t
                        exit_reason_C = "SWING_CLOSE" if curr_sl_C < entry_px else "SL_CLOSE"
                        break
                    if len(recent_highs) >= 4:
                        # Pullback swing high pivot check: bar -2 is peak between bar -3 and bar -1
                        h_prev2 = recent_highs[-3]
                        h_pivot = recent_highs[-2]
                        h_curr = recent_highs[-1]
                        if h_pivot > h_prev2 and h_pivot > h_curr:
                            if h_pivot < curr_sl_C:
                                curr_sl_C = h_pivot
                else: # LONG
                    if b5_c < curr_sl_C:
                        exit_px_C = b5_c
                        exit_time_C = b5_t
                        exit_reason_C = "SWING_CLOSE" if curr_sl_C > entry_px else "SL_CLOSE"
                        break
                    if len(recent_lows) >= 4:
                        l_prev2 = recent_lows[-3]
                        l_pivot = recent_lows[-2]
                        l_curr = recent_lows[-1]
                        if l_pivot < l_prev2 and l_pivot < l_curr:
                            if l_pivot > curr_sl_C:
                                curr_sl_C = l_pivot

                if b5_t >= "15:15":
                    exit_px_C = b5_c
                    exit_time_C = b5_t
                    exit_reason_C = "EOD"
                    break

            pnl_pts_C = (exit_px_C - entry_px) if entry_sig == "LONG" else (entry_px - exit_px_C)
            modes["C_5m_Swing_Pivot"].append({
                "date": d, "entry_time": entry_time, "exit_time": exit_time_C,
                "side": entry_sig, "entry_px": entry_px, "exit_px": exit_px_C,
                "pnl_pts": pnl_pts_C, "max_fav": max_fav_C, "exit_reason": exit_reason_C
            })

            # ------------------------------------------
            # MODE D: 5-Minute 20-EMA Trailing (Close Confirmed beyond EMA20)
            # ------------------------------------------
            curr_sl_D = init_sl_user
            exit_px_D = float(bars_5m_post.iloc[-1]["close"])
            exit_time_D = "15:15"
            exit_reason_D = "EOD"
            max_fav_D = 0.0

            for i in range(len(bars_5m_post)):
                b5 = bars_5m_post.iloc[i]
                b5_c = float(b5["close"])
                b5_h = float(b5["high"])
                b5_l = float(b5["low"])
                b5_t = str(b5["time_str"])
                ema20 = float(b5["ema20"]) if pd.notna(b5["ema20"]) else entry_px

                fav = (b5_h - entry_px) if entry_sig == "LONG" else (entry_px - b5_l)
                if fav > max_fav_D:
                    max_fav_D = fav

                # Catastrophic stop
                if entry_sig == "SHORT" and b5_h >= entry_px + catastrophic_sl_pts:
                    exit_px_D = entry_px + catastrophic_sl_pts
                    exit_time_D = b5_t
                    exit_reason_D = "CATASTROPHIC_SL"
                    break
                elif entry_sig == "LONG" and b5_l <= entry_px - catastrophic_sl_pts:
                    exit_px_D = entry_px - catastrophic_sl_pts
                    exit_time_D = b5_t
                    exit_reason_D = "CATASTROPHIC_SL"
                    break

                # Once in profit >= base_sl * 1.0, trail using EMA20 close
                if fav >= base_sl * 0.75:
                    if entry_sig == "SHORT" and b5_c > ema20:
                        exit_px_D = b5_c
                        exit_time_D = b5_t
                        exit_reason_D = "EMA20_CROSS"
                        break
                    elif entry_sig == "LONG" and b5_c < ema20:
                        exit_px_D = b5_c
                        exit_time_D = b5_t
                        exit_reason_D = "EMA20_CROSS"
                        break
                else:
                    # Initial SL check
                    if entry_sig == "SHORT" and b5_c > curr_sl_D:
                        exit_px_D = b5_c
                        exit_time_D = b5_t
                        exit_reason_D = "SL_CLOSE"
                        break
                    elif entry_sig == "LONG" and b5_c < curr_sl_D:
                        exit_px_D = b5_c
                        exit_time_D = b5_t
                        exit_reason_D = "SL_CLOSE"
                        break

                if b5_t >= "15:15":
                    exit_px_D = b5_c
                    exit_time_D = b5_t
                    exit_reason_D = "EOD"
                    break

            pnl_pts_D = (exit_px_D - entry_px) if entry_sig == "LONG" else (entry_px - exit_px_D)
            modes["D_5m_EMA20_Trail"].append({
                "date": d, "entry_time": entry_time, "exit_time": exit_time_D,
                "side": entry_sig, "entry_px": entry_px, "exit_px": exit_px_D,
                "pnl_pts": pnl_pts_D, "max_fav": max_fav_D, "exit_reason": exit_reason_D
            })

            # ------------------------------------------
            # MODE E: Hybrid (Breakeven Lock at +1.5R, then Swing Pivot Trail)
            # ------------------------------------------
            curr_sl_E = init_sl_user
            exit_px_E = float(bars_5m_post.iloc[-1]["close"])
            exit_time_E = "15:15"
            exit_reason_E = "EOD"
            max_fav_E = 0.0
            be_locked = False

            rec_h_E = [float(bars_5m_post.iloc[0]["high"])]
            rec_l_E = [float(bars_5m_post.iloc[0]["low"])]

            for i in range(len(bars_5m_post)):
                b5 = bars_5m_post.iloc[i]
                b5_c = float(b5["close"])
                b5_h = float(b5["high"])
                b5_l = float(b5["low"])
                b5_t = str(b5["time_str"])

                fav = (b5_h - entry_px) if entry_sig == "LONG" else (entry_px - b5_l)
                if fav > max_fav_E:
                    max_fav_E = fav

                # Breakeven lock when reaching +1.5R (+180 pts Sensex, +45 pts Nifty)
                be_threshold = base_sl * 1.5
                if not be_locked and max_fav_E >= be_threshold:
                    be_locked = True
                    # Lock entry + tiny buffer
                    if entry_sig == "SHORT":
                        curr_sl_E = min(curr_sl_E, entry_px - (15.0 if symbol == "SENSEX" else 5.0))
                    else:
                        curr_sl_E = max(curr_sl_E, entry_px + (15.0 if symbol == "SENSEX" else 5.0))

                rec_h_E.append(b5_h)
                rec_l_E.append(b5_l)

                if entry_sig == "SHORT":
                    if b5_c > curr_sl_E:
                        exit_px_E = b5_c
                        exit_time_E = b5_t
                        exit_reason_E = "BE_OR_SWING_CLOSE"
                        break
                    if len(rec_h_E) >= 4:
                        h_prev2 = rec_h_E[-3]
                        h_pivot = rec_h_E[-2]
                        h_curr = rec_h_E[-1]
                        if h_pivot > h_prev2 and h_pivot > h_curr:
                            if h_pivot < curr_sl_E:
                                curr_sl_E = h_pivot
                else: # LONG
                    if b5_c < curr_sl_E:
                        exit_px_E = b5_c
                        exit_time_E = b5_t
                        exit_reason_E = "BE_OR_SWING_CLOSE"
                        break
                    if len(rec_l_E) >= 4:
                        l_prev2 = rec_l_E[-3]
                        l_pivot = rec_l_E[-2]
                        l_curr = rec_l_E[-1]
                        if l_pivot < l_prev2 and l_pivot < l_curr:
                            if l_pivot > curr_sl_E:
                                curr_sl_E = l_pivot

                if b5_t >= "15:15":
                    exit_px_E = b5_c
                    exit_time_E = b5_t
                    exit_reason_E = "EOD"
                    break

            pnl_pts_E = (exit_px_E - entry_px) if entry_sig == "LONG" else (entry_px - exit_px_E)
            modes["E_Hybrid_BE_Swing"].append({
                "date": d, "entry_time": entry_time, "exit_time": exit_time_E,
                "side": entry_sig, "entry_px": entry_px, "exit_px": exit_px_E,
                "pnl_pts": pnl_pts_E, "max_fav": max_fav_E, "exit_reason": exit_reason_E
            })

    # Summarize Results
    print("\n" + "=" * 90)
    print(f" COMPARATIVE BACKTEST SUMMARY FOR {symbol} ({total_days} TRADING SESSIONS)")
    print("=" * 90)

    summary_rows = []
    for m_name, trade_list in modes.items():
        tdf = pd.DataFrame(trade_list)
        if tdf.empty:
            continue
        tot_trades = len(tdf)
        wins = tdf[tdf["pnl_pts"] > 0]
        losses = tdf[tdf["pnl_pts"] < 0]
        win_rate = len(wins) / tot_trades * 100 if tot_trades > 0 else 0.0
        tot_pts = tdf["pnl_pts"].sum()
        gross_win = wins["pnl_pts"].sum() if not wins.empty else 0.0
        gross_loss = abs(losses["pnl_pts"].sum()) if not losses.empty else 1.0
        pf = gross_win / gross_loss if gross_loss > 0 else 99.0
        avg_trade = tdf["pnl_pts"].mean()
        avg_win = wins["pnl_pts"].mean() if not wins.empty else 0.0
        avg_loss = losses["pnl_pts"].mean() if not losses.empty else 0.0
        
        # Big runners (trades >= 300 pts Sensex or 100 pts Nifty)
        runner_th = 300.0 if symbol == "SENSEX" else 100.0
        big_runners = len(tdf[tdf["pnl_pts"] >= runner_th])

        # Equity Curve and Max Drawdown in points
        tdf["cum_pnl"] = tdf["pnl_pts"].cumsum()
        tdf["peak"] = tdf["cum_pnl"].cummax()
        tdf["dd"] = tdf["cum_pnl"] - tdf["peak"]
        max_dd = abs(tdf["dd"].min())

        summary_rows.append({
            "Mode": m_name,
            "Trades": tot_trades,
            "Win Rate": f"{win_rate:.1f}%",
            "Total Pts": f"{tot_pts:+,.1f}",
            "Futures PnL (₹)": f"₹{tot_pts * lot_size:+,.0f}",
            "Profit Factor": f"{pf:.2f}",
            "Avg Win": f"{avg_win:+.1f}",
            "Avg Loss": f"{avg_loss:+.1f}",
            "Big Runners (>300p)": big_runners,
            "Max DD (Pts)": f"{max_dd:,.1f}",
        })

    sum_df = pd.DataFrame(summary_rows)
    print(sum_df.to_string(index=False))
    print("=" * 90)

    # Today's Trade Check (2026-11-23)
    print("\n--- SPECIFIC FOCUS: TODAY (2026-11-23) ACROSS ALL MODES ---")
    for m_name, trade_list in modes.items():
        tdf = pd.DataFrame(trade_list)
        if not tdf.empty:
            today_t = tdf[tdf["date"].astype(str) == "2026-11-23"]
            if not today_t.empty:
                r = today_t.iloc[0]
                print(f"[{m_name}] Entry: {r['entry_time']} @ {r['entry_px']:.1f} | Exit: {r['exit_time']} @ {r['exit_px']:.1f} | PnL: {r['pnl_pts']:+.1f} pts (₹{r['pnl_pts']*lot_size:+,.0f}) | Reason: {r['exit_reason']}")

    return modes


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default="SENSEX", choices=["SENSEX", "NIFTY"])
    parser.add_argument("--years", nargs="+", default=None)
    args = parser.parse_args()

    run_trailing_comparison(args.symbol, args.years)
