#!/usr/bin/env python3
"""
Opening 2-Minute Breakdown & Retest PUT Scalp Strategy
Systematic Backtest Engine for Nifty 50 Index Options.

Strategy Rules:
1. Formation:
   - 09:15 to 09:17 (First two 1-minute bars: 09:15 and 09:16).
   - Compute C2_LOW = min(Low_0915, Low_0916), C2_HIGH = max(High_0915, High_0916).
   - Nearest Round Level (multiples of 50/100) below or around C2_LOW.
   - Breakdown Target Level = min(C2_LOW, Round_Level).
2. HTF Filter (Optional / Configurable):
   - Prior day close / 15-minute trend filter (e.g., Open < PDC or 15m EMA9 < EMA20).
3. Trigger (Window 09:17 to 09:25):
   - Step A: A 1-minute bar closes or trades below Breakdown Target Level.
   - Step B: A subsequent bar retraces back up towards the breakdown level (High reaches within buffer or touches level).
   - Step C: The bar fails/rejects (Close < Breakdown Level) -> Enter PUT (ATM / slight ITM, delta ~0.55).
4. Exit Rules:
   - SL: Breakdown Level + SL_buffer (10-15 pts on index).
   - Target: 1:2 Risk to Reward (2 * SL_points).
   - Time Stop: Stagnation exit after 3 completed minutes (3 bars).
   - Trading Window Cutoff: No new entries past 09:25. End of trade square-off.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd


@dataclass
class ScalpTrade:
    trade_id: int
    date: str
    entry_time: str
    exit_time: str
    side: str  # 'PUT'
    spot_entry: float
    spot_exit: float
    spot_sl: float
    spot_target: float
    opt_entry: float
    opt_exit: float
    opt_sl: float
    opt_target: float
    pnl_pts: float
    pnl_gross_rs: float
    pnl_net_rs: float
    exit_reason: str
    duration_bars: int
    c2_low: float
    round_level: float
    breakdown_level: float


class OpeningRetestPutScalpEngine:
    def __init__(
        self,
        round_step: int = 50,
        sl_buffer: float = 12.0,
        rr_ratio: float = 2.0,
        max_duration_bars: int = 3,
        delta: float = 0.55,
        lot_size: int = 65,
        brokerage: float = 60.0,
        slippage: float = 0.5,
        htf_filter: str = "none",  # 'none', 'pdc_bearish', 'ema_bearish'
        max_entry_time: str = "09:25:00",
    ):
        self.round_step = round_step
        self.sl_buffer = sl_buffer
        self.rr_ratio = rr_ratio
        self.max_duration_bars = max_duration_bars
        self.delta = delta
        self.lot_size = lot_size
        self.brokerage = brokerage
        self.slippage = slippage
        self.htf_filter = htf_filter
        self.max_entry_time = max_entry_time

    def prepare_data(self, df_raw: pd.DataFrame) -> pd.DataFrame:
        df = df_raw.copy()
        cols = {c.lower(): c for c in df.columns}
        rename_map = {}
        for target in ["open", "high", "low", "close", "volume", "timestamp"]:
            for c in df.columns:
                if c.lower() == target:
                    rename_map[c] = target.capitalize() if target != "timestamp" else "Timestamp"
        df.rename(columns=rename_map, inplace=True)

        df["Timestamp"] = pd.to_datetime(df["Timestamp"])
        df.sort_values("Timestamp", inplace=True)
        df.reset_index(drop=True, inplace=True)

        df["date"] = df["Timestamp"].dt.date
        df["date_str"] = df["Timestamp"].dt.strftime("%Y-%m-%d")
        df["time"] = df["Timestamp"].dt.strftime("%H:%M:%S")

        # Prior Day Close calculation
        daily_close = df.groupby("date")["Close"].last()
        df["pdc"] = df["date"].map(daily_close.shift(1))

        # 15-minute resampled EMA for HTF trend filter
        df15 = (
            df.set_index("Timestamp")
            .resample("15min")
            .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last"})
            .dropna()
            .reset_index()
        )
        df15["ema9_15m"] = df15["Close"].ewm(span=9, adjust=False).mean()
        df15["ema20_15m"] = df15["Close"].ewm(span=20, adjust=False).mean()
        df15["avail_ts"] = df15["Timestamp"] + pd.to_timedelta(15, unit="m")

        df = pd.merge_asof(
            df,
            df15[["avail_ts", "ema9_15m", "ema20_15m"]],
            left_on="Timestamp",
            right_on="avail_ts",
            direction="backward",
        )
        return df

    def run_backtest(self, df: pd.DataFrame) -> List[ScalpTrade]:
        trades: List[ScalpTrade] = []
        trade_id = 1

        grouped = df.groupby("date_str")
        for date_str, day_df in grouped:
            day_df = day_df.reset_index(drop=True)
            if len(day_df) < 15:
                continue

            # Check opening candles: need 09:15 and 09:16
            bar_0915 = day_df[day_df["time"] == "09:15:00"]
            bar_0916 = day_df[day_df["time"] == "09:16:00"]
            if bar_0915.empty or bar_0916.empty:
                continue

            b1 = bar_0915.iloc[0]
            b2 = bar_0916.iloc[0]

            c2_low = min(b1["Low"], b2["Low"])
            c2_high = max(b1["High"], b2["High"])
            pdc = b1["pdc"]

            # Round level defense/break level
            # Psychological round level: the 50/100 level at or just below C2_LOW
            round_level = math.floor(c2_low / self.round_step) * self.round_step
            # If C2_LOW is slightly above round_level (e.g. C2_LOW=22510, round=22500),
            # price must break BOTH C2_LOW and round_level.
            breakdown_level = min(c2_low, round_level)

            # HTF Bearish Filter Check
            if self.htf_filter == "pdc_bearish":
                if pd.notna(pdc) and b1["Open"] >= pdc:
                    continue  # Only trade if market opened below PDC or is trading below PDC
            elif self.htf_filter == "ema_bearish":
                if pd.notna(b1.get("ema9_15m")) and pd.notna(b1.get("ema20_15m")):
                    if b1["ema9_15m"] >= b1["ema20_15m"]:
                        continue  # Only trade if 15m EMA9 < EMA20

            # State machine tracking for the morning window (09:17:00 to 09:25:00)
            window_bars = day_df[(day_df["time"] >= "09:17:00") & (day_df["time"] <= self.max_entry_time)]
            if window_bars.empty:
                continue

            state = "WAITING_BREAKDOWN"
            breakdown_seen = False
            retest_seen = False

            entry_idx = None
            entry_row = None

            for i, row in window_bars.iterrows():
                spot_close = row["Close"]
                spot_low = row["Low"]
                spot_high = row["High"]
                spot_open = row["Open"]

                if state == "WAITING_BREAKDOWN":
                    # Step A: Price drops below breakdown_level
                    if spot_low < breakdown_level:
                        breakdown_seen = True
                        state = "WAITING_RETEST"
                        continue

                elif state == "WAITING_RETEST":
                    # Step B: Pullback / Retracement towards broken level
                    # Price tries to bounce back up slightly toward the broken level
                    # High reaches within 5 pts of breakdown level or tests it
                    if spot_high >= (breakdown_level - 6.0):
                        retest_seen = True
                        # Step C: Rejection verification
                        # Candle fails to push back cleanly above breakdown level:
                        # Close is below breakdown level + 3 pts buffer
                        if spot_close <= breakdown_level:
                            state = "ENTERED"
                            entry_idx = i
                            entry_row = row
                            break
                        elif spot_close > breakdown_level + 5.0:
                            # Strong break back above level invalidates the setup
                            state = "INVALIDATED"
                            break

            if state != "ENTERED" or entry_row is None:
                continue

            # Trade Execution
            spot_entry = entry_row["Close"]
            # Stop loss: Placed right above breakdown level + buffer
            spot_sl = breakdown_level + self.sl_buffer
            risk_pts = spot_sl - spot_entry

            # Sanity check: risk should be reasonable (at least 5 pts, at most 25 pts)
            if risk_pts < 5.0:
                risk_pts = 10.0
                spot_sl = spot_entry + risk_pts
            elif risk_pts > 25.0:
                # If risk is too wide, cap SL or skip
                spot_sl = spot_entry + 20.0
                risk_pts = 20.0

            reward_pts = risk_pts * self.rr_ratio
            spot_target = spot_entry - reward_pts

            # Synthetic ATM/ITM Option Pricing Model
            # Put Option gains when Spot drops: opt_pnl = (spot_entry - spot_current) * delta
            opt_entry_base = 120.0  # Normalized ATM premium baseline
            opt_sl = opt_entry_base - (risk_pts * self.delta)
            opt_target = opt_entry_base + (reward_pts * self.delta)

            # Evaluate forward bars for Exit (1 to 3 minutes or until target/SL)
            post_entry_bars = day_df.loc[entry_idx + 1 :]
            exit_row = None
            exit_reason = "TIME_EXIT"
            exit_spot = spot_entry
            bars_held = 0

            for j, frow in post_entry_bars.iterrows():
                bars_held += 1
                cur_high = frow["High"]
                cur_low = frow["Low"]
                cur_close = frow["Close"]

                # Put Stop-Loss hit if Spot rises to spot_sl
                if cur_high >= spot_sl:
                    exit_row = frow
                    exit_reason = "STOP_LOSS"
                    exit_spot = spot_sl
                    break

                # Put Target hit if Spot drops to spot_target
                if cur_low <= spot_target:
                    exit_row = frow
                    exit_reason = "TARGET"
                    exit_spot = spot_target
                    break

                # 3-Minute Time Stagnation Rule
                if self.max_duration_bars and bars_held >= self.max_duration_bars:
                    exit_row = frow
                    exit_reason = "TIME_EXIT"
                    exit_spot = cur_close
                    break

                # Session End / Cutoff at 15:15
                if frow["time"] >= "15:15:00":
                    exit_row = frow
                    exit_reason = "EOD_EXIT"
                    exit_spot = cur_close
                    break

            if exit_row is None:
                if not post_entry_bars.empty:
                    exit_row = post_entry_bars.iloc[-1]
                    exit_spot = exit_row["Close"]
                    bars_held = len(post_entry_bars)
                else:
                    exit_row = entry_row
                    exit_spot = spot_entry
                    bars_held = 0

            # Calculate Option points & PnL
            # For PUT: profit when spot drops (spot_entry - exit_spot)
            spot_pnl_pts = spot_entry - exit_spot
            opt_pts_raw = spot_pnl_pts * self.delta

            # Apply Slippage (0.5 pt each way = 1.0 pt roundtrip)
            opt_pts_net = opt_pts_raw - (self.slippage * 2)

            opt_exit_price = opt_entry_base + opt_pts_raw
            pnl_gross_rs = opt_pts_raw * self.lot_size
            pnl_net_rs = (opt_pts_net * self.lot_size) - self.brokerage

            t = ScalpTrade(
                trade_id=trade_id,
                date=date_str,
                entry_time=entry_row["time"],
                exit_time=exit_row["time"],
                side="PUT",
                spot_entry=spot_entry,
                spot_exit=exit_spot,
                spot_sl=spot_sl,
                spot_target=spot_target,
                opt_entry=opt_entry_base,
                opt_exit=opt_exit_price,
                opt_sl=opt_sl,
                opt_target=opt_target,
                pnl_pts=opt_pts_net,
                pnl_gross_rs=pnl_gross_rs,
                pnl_net_rs=pnl_net_rs,
                exit_reason=exit_reason,
                duration_bars=bars_held,
                c2_low=c2_low,
                round_level=round_level,
                breakdown_level=breakdown_level,
            )
            trades.append(t)
            trade_id += 1

        return trades


def generate_report(trades: List[ScalpTrade], title: str, lot_size: int = 65) -> Dict:
    if not trades:
        return {"total_trades": 0, "title": title}

    df_t = pd.DataFrame([vars(t) for t in trades])
    total = len(df_t)
    wins = df_t[df_t["pnl_net_rs"] > 0]
    losses = df_t[df_t["pnl_net_rs"] < 0]
    scratches = df_t[df_t["pnl_net_rs"] == 0]

    win_rate = (len(wins) / total) * 100.0 if total > 0 else 0.0
    gross_pnl = df_t["pnl_gross_rs"].sum()
    net_pnl = df_t["pnl_net_rs"].sum()
    net_pts = df_t["pnl_pts"].sum()

    total_win_rs = wins["pnl_net_rs"].sum() if not wins.empty else 0.0
    total_loss_rs = abs(losses["pnl_net_rs"].sum()) if not losses.empty else 0.0
    pf = (total_win_rs / total_loss_rs) if total_loss_rs > 0 else (999.0 if total_win_rs > 0 else 0.0)

    # Max Drawdown
    df_t["cum_pnl"] = df_t["pnl_net_rs"].cumsum()
    df_t["peak"] = df_t["cum_pnl"].cummax()
    df_t["dd"] = df_t["cum_pnl"] - df_t["peak"]
    max_dd = df_t["dd"].min() if not df_t.empty else 0.0

    avg_duration = df_t["duration_bars"].mean() if total > 0 else 0.0
    expectancy = net_pnl / total if total > 0 else 0.0

    target_exits = len(df_t[df_t["exit_reason"] == "TARGET"])
    sl_exits = len(df_t[df_t["exit_reason"] == "STOP_LOSS"])
    time_exits = len(df_t[df_t["exit_reason"] == "TIME_EXIT"])

    return {
        "title": title,
        "total_trades": total,
        "wins": len(wins),
        "losses": len(losses),
        "scratches": len(scratches),
        "win_rate": win_rate,
        "profit_factor": pf,
        "net_pnl_rs": net_pnl,
        "net_pts": net_pts,
        "max_dd_rs": max_dd,
        "avg_duration": avg_duration,
        "expectancy_rs": expectancy,
        "target_exits": target_exits,
        "sl_exits": sl_exits,
        "time_exits": time_exits,
        "trades_df": df_t,
    }


def print_report(rep: Dict):
    if rep.get("total_trades", 0) == 0:
        print(f"\n[{rep['title']}] No trades generated.")
        return

    print("\n" + "=" * 70)
    print(f" {rep['title'].upper()}")
    print("=" * 70)
    print(f"{'Total Trades':<30}: {rep['total_trades']}")
    print(f"{'Winning Trades':<30}: {rep['wins']} ({rep['win_rate']:.1f}%)")
    print(f"{'Losing Trades':<30}: {rep['losses']}")
    print(f"{'Profit Factor (Net)':<30}: {rep['profit_factor']:.2f}")
    print(f"{'Net P&L (Rs)':<30}: Rs. {rep['net_pnl_rs']:,.2f}")
    print(f"{'Net Points (Options)':<30}: {rep['net_pts']:+,.2f} pts")
    print(f"{'Max Drawdown (Rs)':<30}: Rs. {rep['max_dd_rs']:,.2f}")
    print(f"{'Average Duration':<30}: {rep['avg_duration']:.2f} mins")
    print(f"{'Expectancy / Trade':<30}: Rs. {rep['expectancy_rs']:,.2f}")
    print(f"{'Exits (Target / SL / Time)':<30}: {rep['target_exits']} / {rep['sl_exits']} / {rep['time_exits']}")
    print("=" * 70)


def load_nifty_data(year: int = 2026, all_years: bool = False) -> pd.DataFrame:
    base_dir = Path("captured_data/technovusin_nifty50/1min")
    if all_years:
        files = sorted(base_dir.rglob("*.csv"))
    elif year:
        year_dir = base_dir / str(year)
        if year_dir.exists():
            files = sorted(year_dir.rglob("*.csv"))
        else:
            files = sorted(base_dir.glob(f"*{year}*.csv"))
    else:
        files = sorted(base_dir.rglob("*.csv"))

    if not files:
        raise FileNotFoundError(f"No 1-minute CSV files found for year {year} in {base_dir}")

    dfs = [pd.read_csv(f) for f in files]
    df_full = pd.concat(dfs, ignore_index=True)
    return df_full


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--year", type=int, default=2026)
    parser.add_argument("--all-years", action="store_true")
    parser.add_argument("--sl-buffer", type=float, default=12.0)
    parser.add_argument("--rr", type=float, default=2.0)
    parser.add_argument("--max-bars", type=int, default=3)
    args = parser.parse_args()

    df_raw = load_nifty_data(year=args.year, all_years=args.all_years)
    print(f"Loaded {len(df_raw):,} 1-minute candles.")

    # 1. Base Setup: Unfiltered
    engine_base = OpeningRetestPutScalpEngine(
        sl_buffer=args.sl_buffer,
        rr_ratio=args.rr,
        max_duration_bars=args.max_bars,
        htf_filter="none",
    )
    df_prep = engine_base.prepare_data(df_raw)
    trades_base = engine_base.run_backtest(df_prep)
    rep_base = generate_report(trades_base, f"Opening Retest Put Scalp (No Filter, Year={args.year})")
    print_report(rep_base)

    # 2. HTF Bearish Filter (PDC Bearish: Open < PDC)
    engine_pdc = OpeningRetestPutScalpEngine(
        sl_buffer=args.sl_buffer,
        rr_ratio=args.rr,
        max_duration_bars=args.max_bars,
        htf_filter="pdc_bearish",
    )
    trades_pdc = engine_pdc.run_backtest(df_prep)
    rep_pdc = generate_report(trades_pdc, f"Opening Retest Put Scalp (HTF Open < PDC, Year={args.year})")
    print_report(rep_pdc)

    # 3. Side-by-Side: No 3-min time exit
    engine_notime = OpeningRetestPutScalpEngine(
        sl_buffer=args.sl_buffer,
        rr_ratio=args.rr,
        max_duration_bars=0,  # No time stop
        htf_filter="none",
    )
    trades_notime = engine_notime.run_backtest(df_prep)
    rep_notime = generate_report(trades_notime, f"Opening Retest Put Scalp (Without 3-Min Exit, Year={args.year})")
    print_report(rep_notime)
