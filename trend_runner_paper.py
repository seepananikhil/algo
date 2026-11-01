#!/usr/bin/env python3
"""
Trend Catcher (VIX Runner) — Live Paper Forward Trading Engine & Replay Simulator.

Key Strategy Architecture:
- Instrument: NIFTY 50 Index (ATM Options: 1 Lot / 25 qty)
- Timeframe: 5-minute bars aggregated from live 1-min stream
- Entry Window: 09:30 to 10:30 IST (Max 1 trade / day)
- Setup:
    * 15m Opening Range (09:15 - 09:30), filter: OR Range >= 30.0 pts
    * Long: 5m Close > OR High & Close > Open & Close > VWAP
    * Short: 5m Close < OR Low & Close < Open & Close < VWAP
    * Confluence: Early (09:30-09:55) |Delta VIX| >= 2.2%, Late (10:00-10:30) |Delta VIX| >= 2.5%
- Risk & Trade Management:
    * Stop Loss: 28.0 pts (configurable via --sl / --sl-mode)
    * 3-Tier Progressive Ratchet:
        - Max Fav >= 70 pts  -> Ratchet SL to +20 pts
        - Max Fav >= 130 pts -> Ratchet SL to +60 pts
        - Max Fav >= 180 pts -> Ratchet SL to +100 pts
    * Chandelier Volatility Trail:
        - Max Fav >= 60 pts  -> Trail at Peak - (3.0 * ATR15)
    * Max Hold / Time Exit: 15:15 IST auto square-off
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional, Dict, Any, List

import numpy as np
import pandas as pd

try:
    from telegram_notifier import notify_trade_entry, notify_ratchet, notify_trade_exit
except ImportError:
    notify_trade_entry = notify_ratchet = notify_trade_exit = None

IST = timezone(timedelta(hours=5, minutes=30))
ROOT = Path(__file__).resolve().parent
LIVE_DIR = ROOT / "captured_data" / "fyers" / "live"
CAPTURED_DIR = ROOT / "captured_data" / "fyers"
PERF_DIR = ROOT / "performance"
PERF_DIR.mkdir(parents=True, exist_ok=True)
PAPER_LOG_CSV = PERF_DIR / "trend_runner_paper_trades.csv"
LIVE_PAPER_CSV = LIVE_DIR / "trend_runner_live_paper.csv"
SIGNALS_LOG_CSV = PERF_DIR / "trend_runner_signals.csv"
LIVE_SIGNALS_CSV = LIVE_DIR / "trend_runner_live_signals.csv"

LOT_SIZE = 25  # Nifty standard lot size


def get_vix_change_pct(date_str: str) -> float:
    """Fetch daily VIX change % from Kotak Neo live quotes, today's quote cache, or historical CSV."""
    today_now = datetime.now().strftime("%Y-%m-%d")

    # If asking for a past date, check captured india_vix_daily.csv first
    if date_str != today_now:
        vix_csv = CAPTURED_DIR / "india_vix_daily.csv"
        if vix_csv.exists():
            try:
                vdf = pd.read_csv(vix_csv)
                vdf["date_str"] = vdf["date"].astype(str)
                sub = vdf[vdf["date_str"] == date_str]
                if not sub.empty:
                    val = sub.iloc[-1].get("vix_change_pct")
                    if pd.notna(val):
                        return float(val)
            except Exception:
                pass

    # 1. Try checking today's live quotes cache
    quotes_file = LIVE_DIR / f"quotes_{date_str}.json"
    if quotes_file.exists():
        try:
            qdata = json.loads(quotes_file.read_text(encoding="utf-8"))
            if "vix" in qdata:
                chp = float(qdata["vix"].get("per_change") or 0.0)
                if chp != 0.0:
                    return chp
        except Exception:
            pass

    # 2. Try querying Kotak Neo directly (for live trading today)
    if date_str == today_now:
        try:
            from kotak_orders import get_kotak_client
            client = get_kotak_client()
            if client:
                res = client.quotes([{"instrument_token": "INDIA VIX", "exchange_segment": "nse_cm"}])
                if isinstance(res, list) and res:
                    item = res[0]
                    chp = float(item.get("per_change") or 0.0)
                    return chp
        except Exception:
            pass

    # 3. Fallback to captured india_vix_daily.csv
    vix_csv = CAPTURED_DIR / "india_vix_daily.csv"
    if vix_csv.exists():
        try:
            vdf = pd.read_csv(vix_csv)
            vdf["date_str"] = vdf["date"].astype(str)
            sub = vdf[vdf["date_str"] == date_str]
            if not sub.empty:
                val = sub.iloc[-1].get("vix_change_pct")
                if pd.notna(val):
                    return float(val)
        except Exception:
            pass

    return 0.0


def compute_indicators(df1m: pd.DataFrame) -> tuple[pd.DataFrame, float, float, float]:
    """Resample 1-minute bars into 5-minute bars, calculate VWAP, 15m ATR, and 15m OR."""
    df1 = df1m.copy()
    if not pd.api.types.is_datetime64_any_dtype(df1["timestamp"]):
        df1["timestamp"] = pd.to_datetime(df1["timestamp"])
    df1.sort_values("timestamp", inplace=True)
    df1.set_index("timestamp", inplace=True)

    # 5m Resample
    df5 = df1.resample("5min").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
        "volume": "sum"
    }).dropna().reset_index()

    df5["time_str"] = df5["timestamp"].dt.strftime("%H:%M")
    df5["date_str"] = df5["timestamp"].dt.strftime("%Y-%m-%d")

    # 15m Resample for ATR
    df15 = df1.resample("15min").agg({
        "open": "first",
        "high": "max",
        "low": "min",
        "close": "last",
    }).dropna().reset_index()

    df15["tr"] = np.maximum(
        df15["high"] - df15["low"],
        np.maximum(
            abs(df15["high"] - df15["close"].shift(1)),
            abs(df15["low"] - df15["close"].shift(1))
        )
    )
    df15["atr14"] = df15["tr"].rolling(14, min_periods=1).mean()
    df15["avail_ts"] = df15["timestamp"] + pd.to_timedelta(15, unit="m")

    # Merge 15m ATR to 5m bars
    df15_ready = df15[["avail_ts", "atr14"]].dropna()
    if not df15_ready.empty:
        df5 = pd.merge_asof(df5, df15_ready, left_on="timestamp", right_on="avail_ts", direction="backward")
    else:
        df5["atr14"] = 30.0
    df5["atr14"] = df5["atr14"].fillna(30.0)

    # VWAP
    tp = (df5["high"] + df5["low"] + df5["close"]) / 3.0
    pv = tp * df5["volume"]
    cum_pv = pv.cumsum()
    cum_vol = df5["volume"].cumsum()
    df5["vwap"] = np.where(cum_vol > 0, cum_pv / cum_vol, tp.expanding().mean())

    # Opening Range (09:15 to 09:30)
    or_bars = df5[(df5["time_str"] >= "09:15") & (df5["time_str"] <= "09:30")]
    if not or_bars.empty:
        or_high = float(or_bars["high"].max())
        or_low = float(or_bars["low"].min())
        or_range = or_high - or_low
    else:
        or_high, or_low, or_range = 0.0, 0.0, 0.0

    return df5, or_high, or_low, or_range


class TrendRunnerPaperEngine:
    def __init__(
        self,
        symbol: str = "NIFTY",
        sl_points: float = 30.0,
        reentry_sl_points: float = 30.0,
        sl_mode: str = "adaptive",
        lots: int = 1,
        sizing_mode: str = "hybrid",
        pyramid: bool = True,
        reentry: bool = False,
        max_trades_per_day: int = 2,
        vix_th: float = 2.5,
        vix_call_th: Optional[float] = None,
        vix_put_th: Optional[float] = None,
        target_pts: Optional[float] = None,
        be_trigger: Optional[float] = None,
        be_lock: float = 10.0,
        r1_trigger: float = 70.0,
        r1_lock: float = 20.0,
        r2_trigger: float = 130.0,
        r2_lock: float = 60.0,
        r3_trigger: float = 180.0,
        r3_lock: float = 110.0,
        r4_trigger: Optional[float] = 230.0,
        r4_lock: float = 165.0,
        r5_trigger: Optional[float] = 280.0,
        r5_lock: float = 220.0,
        r6_trigger: Optional[float] = 330.0,
        r6_lock: float = 270.0,
        williams_fallback: bool = True,
        strike_mode: str = "itm150",
        reentry_be_trigger: Optional[float] = None,
        reentry_be_lock: float = 5.0,
        reentry_req_color: bool = False,
        body_conviction_th: float = 0.80,
        body_standard_th: float = 0.70,
        reentry_cooloff_bars: int = 15,
        call_cutoff_time: str = "10:45",
        allow_call_reentry: bool = True,
        **kwargs,
    ) -> None:
        self.sl_points = sl_points
        self.reentry_sl_points = reentry_sl_points
        self.reentry_be_trigger = reentry_be_trigger
        self.reentry_be_lock = reentry_be_lock
        self.reentry_req_color = reentry_req_color
        self.body_conviction_th = body_conviction_th
        self.body_standard_th = body_standard_th
        self.reentry_cooloff_bars = reentry_cooloff_bars
        self.call_cutoff_time = call_cutoff_time
        self.allow_call_reentry = allow_call_reentry
        self.symbol = symbol.upper()
        self.lot_size = 20 if self.symbol == "SENSEX" else 25
        if self.symbol == "SENSEX":
            if sl_points == 30.0:
                self.sl_points = 120.0
                self.reentry_sl_points = 120.0
            if r1_trigger == 70.0:
                self.r1_trigger = 280.0
                self.r1_lock = 80.0
                self.r2_trigger = 520.0
                self.r2_lock = 240.0
                self.r3_trigger = 720.0
                self.r3_lock = 440.0
                self.r4_trigger = 920.0
                self.r4_lock = 660.0
                self.r5_trigger = 1120.0
                self.r5_lock = 880.0
                self.r6_trigger = 1320.0
                self.r6_lock = 1080.0
            self.call_cutoff_time = "10:45"
            self.strike_mode = "atm"
        self.sl_mode = sl_mode
        self.lots = lots
        self.sizing_mode = sizing_mode
        self.pyramid = pyramid
        self.reentry = reentry
        self.max_trades_per_day = max_trades_per_day if reentry else 1
        self.vix_th = vix_th
        self.vix_call_th = vix_call_th if vix_call_th is not None else vix_th
        self.vix_put_th = vix_put_th if vix_put_th is not None else vix_th
        self.target_pts = target_pts
        self.be_trigger = be_trigger
        self.be_lock = be_lock
        self.r1_trigger = r1_trigger
        self.r1_lock = r1_lock
        self.r2_trigger = r2_trigger
        self.r2_lock = r2_lock
        self.r3_trigger = r3_trigger
        self.r3_lock = r3_lock
        self.r4_trigger = r4_trigger
        self.r4_lock = r4_lock
        self.r5_trigger = r5_trigger
        self.r5_lock = r5_lock
        self.r6_trigger = r6_trigger
        self.r6_lock = r6_lock
        self.williams_fallback = williams_fallback
        self.strike_mode = strike_mode
        self.log_trades: bool = kwargs.get("log_trades", True)
        self.fetch_live_quotes: bool = kwargs.get("fetch_live_quotes", False)

        self.active_position: Optional[Dict[str, Any]] = None
        self.trades_today: int = 0
        self.last_trade_sig: str = ""
        self.last_trade_exit_reason: str = ""
        self.last_trade_max_fav: float = 0.0
        self.last_trade_sl: float = 0.0
        self.last_trade_pnl: float = 0.0
        self.last_candle_time: str = ""
        self.current_day_str: str = ""
        self.rolling_day_high: float = 0.0
        self.rolling_day_low: float = 999999.0
        self.midday_high: float = 0.0
        self.midday_low: float = 999999.0
        self.dyn_or_high: float = 0.0
        self.dyn_or_low: float = 999999.0
        self.bars_since_last_exit: int = 999

    def evaluate_bar(
        self,
        bar: pd.Series,
        or_high: float,
        or_low: float,
        or_range: float,
        vix_chg: float,
        next_bar_open: Optional[float] = None,
        **kwargs,
    ) -> Optional[Dict[str, Any]]:
        """Evaluate a closed 1m/5m bar for entry signal or update an active position."""
        t_str = str(bar["time_str"])
        c = float(bar["close"])
        o = float(bar["open"])
        h = float(bar["high"])
        l = float(bar["low"])
        vwap = float(bar["vwap"])
        atr = float(bar["atr14"]) if "atr14" in bar and pd.notna(bar["atr14"]) else 30.0

        # Initialize day extremes with Opening Range baseline if first bar
        if self.rolling_day_high == 0.0:
            self.rolling_day_high = or_high
        if self.rolling_day_low == 999999.0:
            self.rolling_day_low = or_low

        # Rolling day extremes prior to this bar
        prev_dh = self.rolling_day_high
        prev_dl = self.rolling_day_low

        # Update rolling day extremes for subsequent bars
        if h > self.rolling_day_high:
            self.rolling_day_high = h
        if l < self.rolling_day_low:
            self.rolling_day_low = l

        # Simple, robust Rolling Day High/Low for both Nifty and Sensex
        self.dyn_or_high = prev_dh
        self.dyn_or_low = prev_dl

        # Update Midday Consolidation Box (09:45 to 12:00) for Williams Afternoon Fallback
        if "09:45" <= t_str <= "12:00":
            if h > self.midday_high:
                self.midday_high = h
            if l < self.midday_low:
                self.midday_low = l

        # ----------------------------------------------------
        # 1. POSITION MANAGEMENT (If Position is Open)
        # ----------------------------------------------------
        if self.active_position is not None:
            pos = self.active_position
            sig = pos["side"]
            entry_px = pos["entry_price"]
            curr_sl = pos["current_sl"]

            # Update Peak and Favorable Excursion
            if h > pos["peak_high"]:
                pos["peak_high"] = h
            if l < pos["peak_low"]:
                pos["peak_low"] = l

            fav = (h - entry_px) if sig == "LONG" else (entry_px - l)
            if fav > pos["max_fav"]:
                pos["max_fav"] = fav

            # --- 3-Tier Progressive Ratchet Lock ---
            # Tier 1: +70 pts -> Lock +20 pts & Risk-Free Pyramiding
            if self.r1_trigger is not None and pos["max_fav"] >= self.r1_trigger:
                r1_level = entry_px + self.r1_lock if sig == "LONG" else entry_px - self.r1_lock
                if (sig == "LONG" and r1_level > curr_sl) or (sig == "SHORT" and r1_level < curr_sl):
                    pos["current_sl"] = r1_level
                    curr_sl = r1_level
                    if self.log_trades:
                        print(f"  [RATCHET TIER 1 LOCKED] Reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking +{self.r1_lock:.1f} pts profit)")
                    if pos.get("last_ratchet") != "Tier 1":
                        pos["last_ratchet"] = "Tier 1"
                        if notify_ratchet:
                            pyr_txt = f"Added Lot 2 at {pyr_e:.2f} (Risk: Zero)" if pos.get("pyramided") else ""
                            notify_ratchet(self.symbol, sig, f"Tier 1 (+{self.r1_trigger:.0f} pts)", pos["max_fav"], curr_sl, self.r1_lock, pyramided=pos.get("pyramided", False), pyramid_info=pyr_txt)
                    
                    # Risk-Free Pyramiding: Add Lot 2 with stop offset by locked profit
                    if self.pyramid and not pos.get("pyramided", False):
                        pyr_e = entry_px + 70.0 if sig == "LONG" else entry_px - 70.0
                        pyr_sl = pyr_e - 20.0 if sig == "LONG" else pyr_e + 20.0
                        pos["pyramided"] = True
                        pos["pyramid_entry_px"] = pyr_e
                        pos["pyramid_sl"] = pyr_sl
                        if self.log_trades:
                            print(f"  [RISK-FREE PYRAMID ADDED] Added Lot 2 at {pyr_e:.2f} with SL at {pyr_sl:.2f} (Net Combined Risk: ZERO)")

            # Tier 2: +130 pts -> Lock +60 pts
            if self.r2_trigger is not None and pos["max_fav"] >= self.r2_trigger:
                r2_level = entry_px + self.r2_lock if sig == "LONG" else entry_px - self.r2_lock
                if (sig == "LONG" and r2_level > curr_sl) or (sig == "SHORT" and r2_level < curr_sl):
                    pos["current_sl"] = r2_level
                    curr_sl = r2_level
                    if pos.get("pyramided"):
                        pyr_e = pos["pyramid_entry_px"]
                        pos["pyramid_sl"] = pyr_e + 10.0 if sig == "LONG" else pyr_e - 10.0
                    if self.log_trades:
                        print(f"  [RATCHET TIER 2 LOCKED] Reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking +{self.r2_lock:.1f} pts profit)")
                    if pos.get("last_ratchet") != "Tier 2":
                        pos["last_ratchet"] = "Tier 2"
                        if notify_ratchet:
                            notify_ratchet(self.symbol, sig, f"Tier 2 (+{self.r2_trigger:.0f} pts)", pos["max_fav"], curr_sl, self.r2_lock)

            # Tier 3: +180 pts -> Lock +110 pts
            if self.r3_trigger is not None and pos["max_fav"] >= self.r3_trigger:
                r3_level = entry_px + self.r3_lock if sig == "LONG" else entry_px - self.r3_lock
                if (sig == "LONG" and r3_level > curr_sl) or (sig == "SHORT" and r3_level < curr_sl):
                    pos["current_sl"] = r3_level
                    curr_sl = r3_level
                    if pos.get("pyramided"):
                        pyr_e = pos["pyramid_entry_px"]
                        pos["pyramid_sl"] = pyr_e + 50.0 if sig == "LONG" else pyr_e - 50.0
                    if self.log_trades:
                        print(f"  [RATCHET TIER 3 LOCKED] Reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking +{self.r3_lock:.1f} pts profit)")
                    if pos.get("last_ratchet") != "Tier 3":
                        pos["last_ratchet"] = "Tier 3"
                        if notify_ratchet:
                            notify_ratchet(self.symbol, sig, f"Tier 3 (+{self.r3_trigger:.0f} pts)", pos["max_fav"], curr_sl, self.r3_lock)

            # Tier 4: +230 pts -> Lock +165 pts
            if self.r4_trigger is not None and pos["max_fav"] >= self.r4_trigger:
                r4_level = entry_px + self.r4_lock if sig == "LONG" else entry_px - self.r4_lock
                if (sig == "LONG" and r4_level > curr_sl) or (sig == "SHORT" and r4_level < curr_sl):
                    pos["current_sl"] = r4_level
                    curr_sl = r4_level
                    if self.log_trades:
                        print(f"  [RATCHET TIER 4 LOCKED] Reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking +{self.r4_lock:.1f} pts profit)")

            # Tier 5: +280 pts -> Lock +220 pts
            if self.r5_trigger is not None and pos["max_fav"] >= self.r5_trigger:
                r5_level = entry_px + self.r5_lock if sig == "LONG" else entry_px - self.r5_lock
                if (sig == "LONG" and r5_level > curr_sl) or (sig == "SHORT" and r5_level < curr_sl):
                    pos["current_sl"] = r5_level
                    curr_sl = r5_level
                    if self.log_trades:
                        print(f"  [RATCHET TIER 5 LOCKED] Reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking +{self.r5_lock:.1f} pts profit)")

            # Tier 6: +330 pts -> Lock +270 pts (Uncapped Runner Lock)
            if self.r6_trigger is not None and pos["max_fav"] >= self.r6_trigger:
                r6_level = entry_px + self.r6_lock if sig == "LONG" else entry_px - self.r6_lock
                if (sig == "LONG" and r6_level > curr_sl) or (sig == "SHORT" and r6_level < curr_sl):
                    pos["current_sl"] = r6_level
                    curr_sl = r6_level
                    if self.log_trades:
                        print(f"  [RATCHET TIER 6 LOCKED] Reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking +{self.r6_lock:.1f} pts profit)")

            # --- Breakeven Lock (Optional extra override) ---
            if self.be_trigger is not None and pos["max_fav"] >= self.be_trigger:
                be_level = entry_px + self.be_lock if sig == "LONG" else entry_px - self.be_lock
                if (sig == "LONG" and be_level > curr_sl) or (sig == "SHORT" and be_level < curr_sl):
                    pos["current_sl"] = be_level
                    curr_sl = be_level
                    if self.log_trades:
                        print(f"  [BREAKEVEN LOCKED] Trade reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking {self.be_lock:+.1f} pts)")

            # --- Re-entry Specific Breakeven Lock ---
            if pos.get("trade_num") == 2 and self.reentry_be_trigger is not None and pos["max_fav"] >= self.reentry_be_trigger:
                be_level = entry_px + self.reentry_be_lock if sig == "LONG" else entry_px - self.reentry_be_lock
                if (sig == "LONG" and be_level > curr_sl) or (sig == "SHORT" and be_level < curr_sl):
                    pos["current_sl"] = be_level
                    curr_sl = be_level
                    if self.log_trades:
                        print(f"  [REENTRY BREAKEVEN LOCKED] Re-entry reached +{pos['max_fav']:.1f} pts! Stop moved to {curr_sl:.2f} (Locking {self.reentry_be_lock:+.1f} pts)")

            # --- Check Exit Conditions ---
            closed = False
            exit_px = c
            exit_reason = "EOD"

            # 1. Hit Stop Loss / Ratchet Lock
            if sig == "LONG" and l <= curr_sl:
                exit_px = curr_sl
                exit_reason = "RATCHET_LOCK" if curr_sl > entry_px else "STOP_LOSS"
                closed = True
            elif sig == "SHORT" and h >= curr_sl:
                exit_px = curr_sl
                exit_reason = "RATCHET_LOCK" if curr_sl < entry_px else "STOP_LOSS"
                closed = True

            # 2. Hit Max Target (if configured)
            if not closed and self.target_pts is not None:
                if sig == "LONG" and h >= entry_px + self.target_pts:
                    exit_px = entry_px + self.target_pts
                    exit_reason = "TARGET_REACHED"
                    closed = True
                elif sig == "SHORT" and l <= entry_px - self.target_pts:
                    exit_px = entry_px - self.target_pts
                    exit_reason = "TARGET_REACHED"
                    closed = True

            # 3. Market Close / Time Exit at 15:15 IST
            if not closed and t_str >= "15:15":
                exit_px = c
                exit_reason = "EOD_RUNNER_1515"
                closed = True

            if closed:
                pnl_pts = (exit_px - entry_px) if sig == "LONG" else (entry_px - exit_px)
                base_lots = pos.get("base_lots", self.lots)
                pyr_pnl_pts = 0.0
                if pos.get("pyramided"):
                    pyr_e = pos["pyramid_entry_px"]
                    pyr_sl = pos.get("pyramid_sl", pyr_e)
                    pyr_exit = pyr_sl if (sig == "LONG" and exit_px <= pyr_sl) or (sig == "SHORT" and exit_px >= pyr_sl) else exit_px
                    pyr_pnl_pts = (pyr_exit - pyr_e) if sig == "LONG" else (pyr_e - pyr_exit)
                
                total_lots = base_lots + (1 if pos.get("pyramided") else 0)
                weighted_pnl_pts = (pnl_pts * base_lots) + (pyr_pnl_pts * 1)
                futures_pnl_rs = weighted_pnl_pts * self.lot_size

                opt_symbol = pos.get("option_symbol", "")
                opt_entry_px = float(pos.get("option_entry_price") or 0.0)
                opt_exit_px = 0.0
                strike = pos.get("strike", 0)
                opt_type = pos.get("opt_type", "CE")

                if self.fetch_live_quotes and strike > 0:
                    try:
                        from live_option_pricing import get_live_option_ltp
                        q = get_live_option_ltp(self.symbol, strike, opt_type)
                        if q and q.get("ltp"):
                            opt_exit_px = float(q.get("bid") or q.get("ltp"))
                            if not opt_symbol:
                                opt_symbol = q["symbol"]
                    except Exception as exc:
                        print(f"  [Warning] Live option exit quote fetch failed: {exc}")

                if opt_entry_px > 0 and opt_exit_px > 0:
                    opt_pnl_pts = opt_exit_px - opt_entry_px
                    opt_pnl_rs = opt_pnl_pts * total_lots * self.lot_size
                else:
                    opt_pnl_pts = round(pnl_pts * 0.75, 2)
                    opt_pnl_rs = opt_pnl_pts * total_lots * self.lot_size

                diff_rs = futures_pnl_rs - opt_pnl_rs

                trade_result = {
                    "date": self.current_day_str,
                    "trade_num": pos.get("trade_num", 1),
                    "stage": pos.get("stage", "STAGE1_MORNING"),
                    "side": pos["side"],
                    "option": pos["option"],
                    "option_symbol": opt_symbol,
                    "option_entry_price": round(opt_entry_px, 2),
                    "option_exit_price": round(opt_exit_px, 2),
                    "option_pnl_points": round(opt_pnl_pts, 2),
                    "option_pnl_rupees": round(opt_pnl_rs, 2),
                    "entry_time": pos["entry_time"],
                    "entry_price": round(entry_px, 2),
                    "exit_time": t_str,
                    "exit_price": round(exit_px, 2),
                    "initial_sl": round(pos["initial_sl"], 2),
                    "final_sl": round(curr_sl, 2),
                    "pnl_points": round(pnl_pts, 2),
                    "pnl_rupees": round(opt_pnl_rs, 2),
                    "futures_pnl_rupees": round(futures_pnl_rs, 2),
                    "diff_rupees": round(diff_rs, 2),
                    "max_fav": round(pos["max_fav"], 2),
                    "rr": round(weighted_pnl_pts / (base_lots * pos["sl_pts"]), 2),
                    "exit_reason": exit_reason,
                    "vix_chg": round(vix_chg, 2),
                    "base_lots": base_lots,
                    "pyramided": pos.get("pyramided", False),
                    "total_lots": total_lots,
                    "weighted_pnl_points": round(weighted_pnl_pts, 2),
                }

                self.last_trade_sig = sig
                self.last_trade_exit_reason = exit_reason
                self.last_trade_max_fav = pos.get("max_fav", 0.0)
                self.last_trade_sl = pos.get("initial_sl", curr_sl)
                self.last_trade_pnl = pnl_pts
                self.bars_since_last_exit = 0
                if self.log_trades:
                    self._print_exit(trade_result)
                    self._log_trade(trade_result)
                if notify_trade_exit:
                    try:
                        notify_trade_exit(
                            symbol=self.symbol,
                            side=trade_result["side"],
                            option_str=trade_result["option"],
                            pnl_pts=trade_result["pnl_points"],
                            option_pnl_pts=trade_result["option_pnl_points"],
                            pnl_rupees=trade_result["pnl_rupees"],
                            exit_reason=trade_result["exit_reason"],
                            exit_price=trade_result["exit_price"],
                            exit_time=trade_result["exit_time"],
                            total_lots=trade_result["total_lots"],
                            qty=trade_result["total_lots"] * self.lot_size,
                        )
                    except Exception:
                        pass
                self.active_position = None
                self.trades_today += 1
                return trade_result

            return None

        # Position is currently None -> increment cool-off counter
        self.bars_since_last_exit += 1

        # ----------------------------------------------------
        # 2. ENTRY SIGNAL EVALUATION
        # ----------------------------------------------------
        if self.trades_today >= self.max_trades_per_day:
            return None

        trade_num = self.trades_today + 1
        sig = None
        stage_name = "MORNING_TREND"

        if trade_num == 1:
            # Trend Breakout Window: 09:30 to 13:00 IST (1:00 PM Hard Cutoff)
            # MANDATORY: Must break Dynamic Expanded Range (OR High / Low expanded by pre-breakout wicks)
            if "09:30" <= t_str <= "13:00":
                if or_range >= 30.0:
                    # Solid Breakout Candle Filter (Conviction Body >= 70% of candle range, Rejection Wick <= 20%)
                    candle_rng = h - l
                    candle_body = abs(c - o)
                    body_ratio = candle_body / candle_rng if candle_rng > 0 else 0.0
                    upper_wick_pct = (h - max(o, c)) / candle_rng if candle_rng > 0 else 0.0
                    lower_wick_pct = (min(o, c) - l) / candle_rng if candle_rng > 0 else 0.0

                    # Rejection Wick check:
                    # For LONG (CALL): upper wick represents overhead rejection selling -> must be <= 20%
                    # For SHORT (PUT): lower wick represents bottom absorption buying -> must be <= 20%
                    long_conviction = (upper_wick_pct <= 0.20)
                    short_conviction = (lower_wick_pct <= 0.20)

                    # 1. High-Conviction Breakout (Body >= 80% with Directional VIX confirmation <= 0.0% / >= 0.0%)
                    # Captures major trends where VIX cools mildly while blocking counter-trend traps
                    if body_ratio >= self.body_conviction_th:
                        if (c > self.dyn_or_high) and (c > o) and (c > vwap) and (vix_chg <= 0.0) and long_conviction:
                            if t_str <= self.call_cutoff_time:
                                sig = "LONG"
                                stage_name = "STAGE1_TREND"
                        elif (c < self.dyn_or_low) and (c < o) and (c < vwap) and (vix_chg >= 0.0) and short_conviction:
                            sig = "SHORT"
                            stage_name = "STAGE1_TREND"

                    # 2. Standard Breakout (Body >= 70% with Strict VIX confirmation <= -vix_call_th / >= +vix_put_th)
                    if not sig and body_ratio >= self.body_standard_th:
                        raw_long = (c > self.dyn_or_high) and (c > o) and (c > vwap) and long_conviction
                        vix_long = (vix_chg <= -self.vix_call_th)
                        if raw_long and vix_long and (t_str <= self.call_cutoff_time):
                            sig = "LONG"
                            stage_name = "STAGE1_TREND"

                        raw_short = (c < self.dyn_or_low) and (c < o) and (c < vwap) and short_conviction
                        vix_short = (vix_chg >= self.vix_put_th)
                        if raw_short and vix_short:
                            sig = "SHORT"
                            stage_name = "STAGE1_TREND"

        elif trade_num == 2 and self.reentry:
            # 1. Strict Cool-off Gate: Must wait at least reentry_cooloff_bars (30 min) after Trade 1 exit
            # Prevents immediate revenge entries (e.g. 2 min after stop out)
            if self.bars_since_last_exit < self.reentry_cooloff_bars:
                return None

            # 2. Matured Trend Protection Gate:
            # If Trade 1 secured >= +60 pts (Tier 2+ Ratchet lock, excursion >= 130 pts), the daily trend
            # is already matured/exhausted. Re-entering after a >= +60 pt win yields 0% win rate.
            # Blocking Trade 2 here locks in the day's profit and saves -180 pts.
            if self.last_trade_pnl >= 60.0:
                return None

            # 3. Symmetric Re-entry Gate:
            # Window: 09:30 to 13:00 IST
            # Both CALL and PUT re-entries are enabled symmetrically with 30-min cool-off and Day High/Low expansion.
            if "09:30" <= t_str <= "13:00":
                # Dynamic Expansion Re-entry (Breakout continuation after 30-min cool-off)
                candle_rng = h - l
                candle_body = abs(c - o)
                body_ratio = candle_body / candle_rng if candle_rng > 0 else 0.0
                upper_wick_pct = (h - max(o, c)) / candle_rng if candle_rng > 0 else 0.0
                lower_wick_pct = (min(o, c) - l) / candle_rng if candle_rng > 0 else 0.0

                if body_ratio >= 0.70 and self.last_trade_sig:
                    if self.last_trade_sig == "LONG" and self.allow_call_reentry and c >= prev_dh and c > o and c > vwap and (upper_wick_pct <= 0.20):
                        sig = "LONG"
                        stage_name = "REENTRY_EXPANSION"
                    elif self.last_trade_sig == "SHORT" and c <= prev_dl and c < o and c < vwap and (lower_wick_pct <= 0.20):
                        sig = "SHORT"
                        stage_name = "REENTRY_EXPANSION"

        if sig in ("LONG", "SHORT"):
            entry_px = next_bar_open if next_bar_open is not None else c
            if self.sl_mode == "adaptive":
                effective_sl_pts = max(30.0, min(45.0, round(atr * 0.95, 1)))
            else:
                effective_sl_pts = self.sl_points if trade_num == 1 else self.reentry_sl_points

            sl_px = entry_px - effective_sl_pts if sig == "LONG" else entry_px + effective_sl_pts
            opt_type = "CE" if sig == "LONG" else "PE"

            # Strike Selection: ITM-150 vs ATM
            if self.symbol == "SENSEX":
                strike = int(round(entry_px / 100.0) * 100)
                opt_str = f"SENSEX {strike} {opt_type} (ATM)"
            elif self.strike_mode == "itm150":
                strike = int(round((entry_px - 150 if sig == "LONG" else entry_px + 150) / 50.0) * 50)
                opt_str = f"NIFTY {strike} {opt_type} (ITM-150)"
            else:
                strike = int(round(entry_px / 50.0) * 50)
                opt_str = f"NIFTY {strike} {opt_type} (ATM)"

            # Dynamic Confluence Sizing (1 vs 2 Lots)
            if self.sizing_mode in ("hybrid", "dynamic"):
                is_high_conviction = (body_ratio >= 0.85) or (abs(vix_chg) >= 2.0 and body_ratio >= 0.80)
                base_lots = 2 if is_high_conviction else 1
            else:
                base_lots = self.lots

            opt_symbol = ""
            opt_entry_px = 0.0
            if self.fetch_live_quotes:
                try:
                    from live_option_pricing import get_live_option_ltp
                    q = get_live_option_ltp(self.symbol, strike, opt_type)
                    if q and q.get("ltp"):
                        opt_symbol = q["symbol"]
                        opt_entry_px = float(q.get("ask") or q.get("ltp"))
                except Exception as exc:
                    print(f"  [Warning] Live option quote fetch failed: {exc}")

            self.active_position = {
                "trade_num": trade_num,
                "stage": stage_name,
                "side": sig,
                "option": opt_str,
                "strike": strike,
                "opt_type": opt_type,
                "option_symbol": opt_symbol,
                "option_entry_price": opt_entry_px,
                "entry_time": t_str,
                "entry_price": entry_px,
                "sl_pts": effective_sl_pts,
                "initial_sl": sl_px,
                "current_sl": sl_px,
                "peak_high": entry_px,
                "peak_low": entry_px,
                "max_fav": 0.0,
                "base_lots": base_lots,
                "pyramided": False,
                "pyramid_entry_px": None,
            }

            if self.log_trades:
                self._print_entry(self.active_position, effective_sl_pts, or_high, or_low, or_range, vix_chg)

        return None

    def _print_entry(self, pos: dict, sl_pts: float, or_high: float, or_low: float, or_range: float, vix: float) -> None:
        lots = pos["base_lots"]
        vix_tier = "HIGH CONVICTION (2 Lots)" if lots == 2 else "STANDARD (1 Lot)"
        stage_tag = pos.get("stage", "MORNING_TREND")
        print("\n" + "=" * 70)
        print(f" [{stage_tag} TRIGGERED]  Side: {pos['side']}  Time: {pos['entry_time']}")
        print("=" * 70)
        print(f"  Underlying Spot Entry : {pos['entry_price']:.2f}")
        print(f"  Option Contract       : {pos['option']} ({lots} Lot(s) / {lots * self.lot_size} qty)")
        if pos.get("option_entry_price"):
            print(f"  Live Option Quote     : {pos.get('option_symbol')} @ Rs {pos['option_entry_price']:.2f}")
        print(f"  VIX Conviction Sizing : {vix_tier} (|Delta VIX|: {abs(vix):.2f}%)")
        print(f"  Initial Stop Loss     : {pos['initial_sl']:.2f} ({sl_pts:.1f} pts risk, max Rs {sl_pts * LOT_SIZE * lots:.0f})")
        tgt_str = f"{pos['entry_price'] + (self.target_pts if pos['side'] == 'LONG' else -self.target_pts):.2f} (+{self.target_pts} pts)" if self.target_pts is not None else "Uncapped (Pure Ride to 15:15)"
        print(f"  Target                : {tgt_str}")
        or_desc = f"Dyn OR [{self.dyn_or_low:.1f} - {self.dyn_or_high:.1f}] (Static: {or_low:.1f}-{or_high:.1f})" if (self.dyn_or_high != or_high or self.dyn_or_low != or_low) else f"OR [{or_low:.1f} - {or_high:.1f}]"
        print(f"  Confluence Check      : {or_desc} (Range: {or_range:.1f} pts) | VIX Chg: {vix:+.2f}%")
        print("=" * 70 + "\n")
        self._log_signal(pos, sl_pts, vix)
        if notify_trade_entry:
            try:
                notify_trade_entry(
                    symbol=self.symbol,
                    stage=stage_tag,
                    side=pos["side"],
                    option_str=pos["option"],
                    spot_entry=pos["entry_price"],
                    sl_pts=sl_pts,
                    initial_sl=pos["initial_sl"],
                    lots=lots,
                    qty=lots * self.lot_size,
                    target_pts=self.target_pts,
                    option_symbol=pos.get("option_symbol"),
                    option_entry_price=pos.get("option_entry_price"),
                    vix_chg=vix,
                )
            except Exception:
                pass

    def _log_signal(self, pos: dict, sl_pts: float, vix: float) -> None:
        signal_cols = [
            "date", "trade_num", "stage", "side", "option", "entry_time",
            "entry_price", "sl_pts", "initial_sl", "target", "vix_chg", "lots", "qty"
        ]
        target_val = (pos["entry_price"] + (self.target_pts if pos["side"] == "LONG" else -self.target_pts)) if self.target_pts is not None else "UNCAPPED"
        row_dict = {
            "date": self.current_day_str,
            "trade_num": pos.get("trade_num", 1),
            "stage": pos.get("stage", "STAGE1_MORNING"),
            "side": pos["side"],
            "option": pos["option"],
            "entry_time": pos["entry_time"],
            "entry_price": round(pos["entry_price"], 2),
            "sl_pts": round(sl_pts, 2),
            "initial_sl": round(pos["initial_sl"], 2),
            "target": target_val,
            "vix_chg": round(vix, 2),
            "lots": pos.get("base_lots", self.lots),
            "qty": pos.get("base_lots", self.lots) * self.lot_size,
        }
        for fpath in [SIGNALS_LOG_CSV, LIVE_SIGNALS_CSV]:
            exists = fpath.exists() and (fpath.stat().st_size > 0)
            if exists:
                try:
                    existing = pd.read_csv(fpath)
                    match = existing[
                        (existing["date"] == row_dict["date"])
                        & (existing["entry_time"] == row_dict["entry_time"])
                        & (existing["side"] == row_dict["side"])
                    ]
                    if not match.empty:
                        continue
                except Exception:
                    pass
            with open(fpath, "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=signal_cols)
                if not exists:
                    writer.writeheader()
                writer.writerow(row_dict)

    def _print_exit(self, res: dict) -> None:
        pnl_sign = "+" if res["pnl_rupees"] > 0 else ""
        pyr_str = " (Base + 1 Pyramid Lot @ +70)" if res.get("pyramided") else " (Base only)"
        print("\n" + "#" * 70)
        print(f" [POSITION CLOSED]  {res['side']}  Exit Time: {res['exit_time']}  Reason: {res['exit_reason']}")
        print("#" * 70)
        fut_pnl = res.get('futures_pnl_rupees', res['pnl_points'] * res['total_lots'] * self.lot_size)
        fut_sign = "+" if fut_pnl > 0 else ""
        print(f"  Futures (1.0 Delta)  : Entry {res['entry_price']:.2f} -> Exit {res['exit_price']:.2f} | PnL: {fut_sign}Rs {fut_pnl:,.2f} ({res['pnl_points']:+.2f} pts)")
        if res.get("option_entry_price") and res.get("option_exit_price"):
            opt_pnl = res.get("option_pnl_rupees", res["pnl_rupees"])
            opt_sign = "+" if opt_pnl > 0 else ""
            print(f"  Option (ITM-150)     : {res.get('option_symbol')} Buy Rs {res['option_entry_price']:.2f} -> Sell Rs {res['option_exit_price']:.2f} | PnL: {opt_sign}Rs {opt_pnl:,.2f} ({res.get('option_pnl_points', 0):+.2f} pts)")
            print(f"  Futures vs Option    : Difference Rs {res.get('diff_rupees', 0):+,.2f}")
        print(f"  Lots Traded          : {res['total_lots']} Lot(s){pyr_str}  |  R:R: {res['rr']}R")
        print(f"  Peak Run             : +{res['max_fav']:.2f} pts  |  Trailing Stop: {res['final_sl']:.2f}")
        print("#" * 70 + "\n")

    def _log_trade(self, res: dict) -> None:
        canonical_cols = [
            "date", "trade_num", "stage", "side", "option", "option_symbol",
            "option_entry_price", "option_exit_price", "option_pnl_points", "option_pnl_rupees",
            "entry_time", "entry_price", "sl", "final_sl", "target", "exit_time", "exit_price", "exit_reason",
            "pnl_points", "pnl_rupees", "futures_pnl_rupees", "diff_rupees",
            "max_fav", "max_adv", "rr", "lots", "qty", "vix_chg", "initial_sl", "base_lots", "total_lots", "pyramided"
        ]

        if self.symbol == "SENSEX":
            perf_csv = PERF_DIR / "trend_runner_sensex_paper_trades.csv"
            live_csv = LIVE_DIR / "trend_runner_sensex_live_paper.csv"
            parts = str(res.get("date", "")).split("-")
            sess_dir = ROOT / "paper" / "trend_runner_sensex" / parts[0] / parts[1] / parts[2] if len(parts) == 3 else None
        else:
            perf_csv = PERF_DIR / "trend_runner_paper_trades.csv"
            live_csv = LIVE_DIR / "trend_runner_live_paper.csv"
            parts = str(res.get("date", "")).split("-")
            sess_dir = ROOT / "paper" / "trend_runner" / parts[0] / parts[1] / parts[2] if len(parts) == 3 else None

        fpaths = [perf_csv, live_csv]
        if sess_dir:
            sess_dir.mkdir(parents=True, exist_ok=True)
            fpaths.append(sess_dir / f"trend_runner_trades_{res.get('date')}.csv")

        for fpath in fpaths:
            exists = fpath.exists() and (fpath.stat().st_size > 0)
            if exists:
                try:
                    existing = pd.read_csv(fpath)
                    match = existing[
                        (existing["date"] == res["date"])
                        & (existing["entry_time"] == res["entry_time"])
                        & (existing["side"] == res["side"])
                    ]
                    if not match.empty:
                        continue  # Already logged
                except Exception:
                    pass

            row_dict = {c: res.get(c, "") for c in canonical_cols}
            write_header = not exists
            with open(fpath, "a", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=canonical_cols)
                if write_header:
                    writer.writeheader()
                writer.writerow(row_dict)


def run_replay(
    target_date: str,
    sl_pts: float = 30.0,
    sl_mode: str = "fixed",
    lots: int = 1,
    sizing_mode: str = "fixed",
    reentry: bool = True,
    be_trigger: Optional[float] = None,
    vix_chg_override: Optional[float] = None,
    williams_fallback: bool = True,
    strike_mode: str = "itm150",
) -> None:
    """Replay simulation for any historical day with captured 1m or 5m data."""
    be_desc = "Disabled (Path A: Pure Ride)" if be_trigger is None else f"@{be_trigger} pts"
    williams_desc = "Enabled (12:00-14:15 Seamless Fallback)" if williams_fallback else "Disabled"
    print("=" * 75)
    print(f"  TREND CATCHER (VIX RUNNER) — DAY REPLAY: {target_date}")
    print(f"  Configuration: {lots} Lot(s) | Stop Loss: {sl_pts} pts | Strike: {strike_mode.upper()} | Breakeven: {be_desc}")
    print(f"  Williams Afternoon Fallback: {williams_desc} | Target: Uncapped (Pure Ride to 15:15) | Re-entry: {reentry}")
    print("=" * 75)

    # 1. Search for day's 1m candle file, check completeness
    csv_1m = LIVE_DIR / f"nifty_1min_{target_date}.csv"
    loaded_1m = False
    if csv_1m.exists():
        df1m = pd.read_csv(csv_1m)
        if len(df1m) >= 15:
            df5, or_high, or_low, or_range = compute_indicators(df1m)
            loaded_1m = True

    if not loaded_1m:
        # Check master historical file
        master_file = CAPTURED_DIR / "nifty_5min.csv"
        if master_file.exists():
            df_all = pd.read_csv(master_file)
            df_all["timestamp"] = pd.to_datetime(df_all["timestamp"])
            df_day = df_all[df_all["timestamp"].dt.strftime("%Y-%m-%d") == target_date].copy().reset_index(drop=True)
            if df_day.empty:
                print(f"Error: No candle data found for {target_date} in live or master CSV.")
                return
            df5 = df_day.copy()
            df5["time_str"] = df5["timestamp"].dt.strftime("%H:%M")
            df5["date_str"] = target_date
            tp = (df5["high"] + df5["low"] + df5["close"]) / 3.0
            df5["vwap"] = tp.expanding().mean()
            df5["atr14"] = 30.0
            or_bars = df5[(df5["time_str"] >= "09:15") & (df5["time_str"] <= "09:30")]
            or_high = float(or_bars["high"].max()) if not or_bars.empty else 0.0
            or_low = float(or_bars["low"].min()) if not or_bars.empty else 0.0
            or_range = or_high - or_low
        else:
            print(f"Error: Could not locate data for {target_date}.")
            return

    # 2. Get VIX change %
    if vix_chg_override is not None:
        vix_chg = vix_chg_override
    else:
        vix_chg = get_vix_change_pct(target_date)

    print(f"\n[DAY CONTEXT: {target_date}]")
    print(f"  Opening Range (09:15-09:30) : High: {or_high:.2f} | Low: {or_low:.2f} | Range: {or_range:.2f} pts")
    print(f"  India VIX Daily Change      : {vix_chg:+.2f}%")
    if or_range < 30.0:
        if not williams_fallback:
            print(f"  -> Day Filter: OR Range ({or_range:.2f} pts) < 30.0 pts. No trades permitted today.\n")
            return
        else:
            print(f"  -> Morning OR Range ({or_range:.2f} pts) < 30.0 pts. Morning setup skipped; standing down to Midday Williams Fallback.")

    engine = TrendRunnerPaperEngine(
        symbol=symbol,
        sl_points=sl_pts,
        sl_mode=sl_mode,
        lots=lots,
        sizing_mode=sizing_mode,
        reentry=reentry,
        be_trigger=be_trigger,
        williams_fallback=williams_fallback,
        strike_mode=strike_mode,
        fetch_live_quotes=False,
    )
    engine.current_day_str = target_date

    if loaded_1m:
        # High precision 1m evaluation for true tick-level entry
        df_eval = df1m.copy()
        if not pd.api.types.is_datetime64_any_dtype(df_eval["timestamp"]):
            df_eval["timestamp"] = pd.to_datetime(df_eval["timestamp"])
        df_eval.sort_values("timestamp", inplace=True)
        df_eval["time_str"] = df_eval["timestamp"].dt.strftime("%H:%M")
        df_eval["date_str"] = target_date
        tp = (df_eval["high"] + df_eval["low"] + df_eval["close"]) / 3.0
        pv = tp * df_eval["volume"]
        cum_pv = pv.cumsum()
        cum_vol = df_eval["volume"].cumsum()
        df_eval["vwap"] = np.where(cum_vol > 0, cum_pv / cum_vol, tp)
        df_eval["atr14"] = 30.0
    else:
        df_eval = df5

    n_bars = len(df_eval)
    trade_executed = False

    for i in range(n_bars):
        bar = df_eval.iloc[i]
        next_open = float(df_eval.iloc[i + 1]["open"]) if i + 1 < n_bars else None
        res = engine.evaluate_bar(bar, or_high, or_low, or_range, vix_chg, next_bar_open=next_open)
        if res is not None:
            trade_executed = True

    if not trade_executed and engine.active_position is None:
        print("  -> No entry signals triggered on this day (conditions not fully met).\n")


def run_live_monitor(
    symbol: str = "NIFTY",
    poll_interval: int = 5,
    sl_pts: float = 30.0,
    sl_mode: str = "fixed",
    lots: int = 1,
    sizing_mode: str = "fixed",
    reentry: bool = True,
    be_trigger: Optional[float] = None,
    vix_chg_override: Optional[float] = None,
    williams_fallback: bool = True,
    strike_mode: str = "itm150",
) -> None:
    """Continuously monitor today's live 1-min stream during market hours."""
    be_desc = "Disabled (Path A: Pure Ride)" if be_trigger is None else f"@{be_trigger} pts"
    print("=" * 75)
    print("  TREND CATCHER (VIX RUNNER) — LIVE FORWARD PAPER MONITOR")
    print(f"  Lots: {lots} | Stop Loss: {sl_pts} pts | Strike: {strike_mode.upper()} | Breakeven: {be_desc}")
    print(f"  Entry Window: 09:30-13:00 IST (1:00 PM Hard Cutoff) | Target: Uncapped (Pure Ride to 15:15) | Re-entry: {reentry}")
    print(f"  Polling Interval: {poll_interval}s | Saving to: {PAPER_LOG_CSV.name}")
    print("=" * 75)

    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    live_1m_csv = LIVE_DIR / f"{symbol.lower()}_1min_{today_str}.csv"

    engine = TrendRunnerPaperEngine(
        symbol=symbol,
        sl_points=sl_pts,
        sl_mode=sl_mode,
        lots=lots,
        sizing_mode=sizing_mode,
        reentry=reentry,
        be_trigger=be_trigger,
        williams_fallback=williams_fallback,
        strike_mode=strike_mode,
        fetch_live_quotes=True,
    )
    engine.current_day_str = today_str

    vix_chg = vix_chg_override if vix_chg_override is not None else get_vix_change_pct(today_str)
    processed_times = set()
    print(f"Waiting for live 1-min feed: {live_1m_csv}")
    print("Execution Precision: 1-Minute Candle Close")
    print(f"Today's VIX Change: {vix_chg:+.2f}%\n")

    while True:
        try:
            if not live_1m_csv.exists():
                time.sleep(poll_interval)
                continue

            df1 = pd.read_csv(live_1m_csv)
            if df1.empty or len(df1) < 15:
                time.sleep(poll_interval)
                continue

            if not pd.api.types.is_datetime64_any_dtype(df1["timestamp"]):
                df1["timestamp"] = pd.to_datetime(df1["timestamp"])
            df1.sort_values("timestamp", inplace=True)
            df1["time_str"] = df1["timestamp"].dt.strftime("%H:%M")
            tp = (df1["high"] + df1["low"] + df1["close"]) / 3.0
            pv = tp * df1["volume"]
            cum_pv = pv.cumsum()
            cum_vol = df1["volume"].cumsum()
            df1["vwap"] = np.where(cum_vol > 0, cum_pv / cum_vol, tp)
            df1["atr14"] = 30.0

            or_bars = df1[(df1["time_str"] >= "09:15") & (df1["time_str"] <= "09:30")]
            or_high = float(or_bars["high"].max()) if not or_bars.empty else 0.0
            or_low = float(or_bars["low"].min()) if not or_bars.empty else 0.0
            or_range = or_high - or_low

            # Process all newly completed 1-minute bars sequentially
            # iloc[-1] is the forming/uncompleted candle, so we iterate up to len(df1) - 1
            for idx in range(len(df1) - 1):
                completed_bar = df1.iloc[idx]
                curr_1m_time = str(completed_bar["time_str"])
                if curr_1m_time not in processed_times:
                    next_open = float(df1.iloc[idx + 1]["open"]) if idx + 1 < len(df1) else None
                    engine.evaluate_bar(completed_bar, or_high, or_low, or_range, vix_chg, next_bar_open=next_open)
                    processed_times.add(curr_1m_time)

            time.sleep(poll_interval)

        except KeyboardInterrupt:
            print("\nLive Paper Monitor stopped by user.")
            break
        except Exception as exc:
            print(f"[Warning] Error during live cycle: {exc}")
            time.sleep(poll_interval)


if __name__ == "__main__":
    config_file = ROOT / "fyers_config.json"
    default_lots = 3
    if config_file.exists():
        try:
            cfg = json.loads(config_file.read_text(encoding="utf-8"))
            default_lots = int(cfg.get("trend_runner_lots", 3))
        except Exception:
            pass

    parser = argparse.ArgumentParser(description="Trend Catcher (VIX Runner) Live Paper & Replay Engine")
    parser.add_argument("--symbol", choices=["NIFTY", "SENSEX"], default="NIFTY", help="Index to trade (default: NIFTY)")
    parser.add_argument("--replay", type=str, default="", help="Replay a specific date (YYYY-MM-DD), e.g. 2026-10-15")
    parser.add_argument("--lots", type=int, default=1, help="Number of lots to trade (default: 1)")
    parser.add_argument("--sl", type=float, default=30.0, help="Stop loss in spot points (default: 30.0)")
    parser.add_argument("--sl-mode", choices=["fixed", "adaptive"], default="fixed", help="SL mode (default: fixed)")
    parser.add_argument("--sizing", choices=["hybrid", "fixed"], default="fixed", help="Position sizing mode (default: fixed)")
    parser.add_argument("--vix-chg", type=float, default=None, help="Override India VIX %% change for testing")
    parser.add_argument("--poll", type=int, default=5, help="Live monitor polling interval in seconds (default: 5)")
    parser.add_argument("--reentry", action="store_true", default=True, help="Enable smart re-entry after morning stopout (default: True)")
    parser.add_argument("--no-reentry", action="store_false", dest="reentry", help="Disable smart re-entry")
    parser.add_argument("--be-trigger", type=float, default=None, help="Breakeven trigger in spot points (default: None for Path A Pure Ride)")
    parser.add_argument("--williams", action="store_true", default=True, help="Enable Williams Afternoon Fallback (12:00-14:15 Seamless) (default: True)")
    parser.add_argument("--no-williams", action="store_false", dest="williams", help="Disable Williams Afternoon Fallback")
    parser.add_argument("--strike-mode", choices=["itm150", "atm"], default="itm150", help="Strike selection mode (default: itm150)")
    args = parser.parse_args()

    if args.replay:
        run_replay(
            target_date=args.replay,
            sl_pts=args.sl,
            sl_mode=args.sl_mode,
            lots=args.lots,
            sizing_mode=args.sizing,
            reentry=args.reentry,
            be_trigger=args.be_trigger,
            vix_chg_override=args.vix_chg,
            williams_fallback=args.williams,
            strike_mode=args.strike_mode,
        )
    else:
        run_live_monitor(
            symbol=args.symbol,
            poll_interval=args.poll,
            sl_pts=args.sl,
            sl_mode=args.sl_mode,
            lots=args.lots,
            sizing_mode=args.sizing,
            reentry=args.reentry,
            be_trigger=args.be_trigger,
            vix_chg_override=args.vix_chg,
            williams_fallback=args.williams,
            strike_mode=args.strike_mode,
        )
