#!/usr/bin/env python3
"""
Nifty 1-Minute Liquidity Sweep & EMA Breakout Scalp (Option Buyer Framework)
Systematic Quantitative Backtest Engine.

Specifications:
- Instrument: Nifty 50 Index Spot 1-minute OHLC
- Resampled HTF: 5-minute OHLC for EMA(9) / EMA(20) trend filter (zero-lookahead)
- Execution: Closest ITM/ATM strike (Delta ~ 0.55 synthetic model)
- Session Windows: 09:20-11:15 & 13:30-15:00 (Blackout: 11:15-13:30, Square-off: 15:15)
- Long: Sweep of 10-bar Low in t-3..t-1 (lower wick >= 40%), Close > VWAP, 5m EMA9 > EMA20,
        Trigger Close > EMA9 & EMA20, Close > Open, Volume > 1.25 * SMA(Vol, 10).
- Short: Sweep of 10-bar High in t-3..t-1 (upper wick >= 40%), Close < VWAP, 5m EMA9 < EMA20,
         Trigger Close < EMA9 & EMA20, Close < Open, Volume > 1.25 * SMA(Vol, 10).
- Targets & Stops: Target = +10.0 pts, Stop = 5.0 to 6.0 pts (max loss 6 pts).
- Time Exit: Stagnation exit after 3 completed bars (3 minutes).
- Daily Risk Budget: Max 4 trades/day, Max 2 consecutive losses, Daily loss cap = -₹700.
- Friction: ₹60 flat per round trip, 0.5 pts slippage per execution (1.0 pt round trip).
- Lot Size: 65 units (default configurable).
"""

from __future__ import annotations

import argparse
import glob
import math
import os
import sys
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
    side: str  # 'CALL' or 'PUT'
    strike: int
    spot_entry: float
    spot_exit: float
    opt_entry: float
    opt_exit: float
    opt_sl: float
    opt_target: float
    risk_pts: float
    bars_held: int
    exit_reason: str  # 'TARGET', 'STOP_LOSS', 'TIME_EXIT', 'HARD_SQOFF'
    gross_pts: float
    slippage_pts: float
    net_pts: float
    friction_rs: float
    net_rs: float


class LiquiditySweepScalpEngine:
    def __init__(
        self,
        lot_size: int = 65,
        delta: float = 0.55,
        target_pts: float = 10.0,
        sl_pts: float = 5.5,
        use_fixed_sl: bool = True,
        min_sl_pts: float = 5.0,
        max_sl_pts: float = 6.0,
        time_exit_bars: Optional[int] = 3,
        brokerage_per_trade: float = 60.0,
        slippage_per_exec: float = 0.5,
        max_trades_per_day: int = 4,
        max_consec_losses: int = 2,
        daily_loss_cap_rs: float = -700.0,
        hard_sqoff_time: str = "15:15:00",
        require_volume: bool = True,
    ):
        self.lot_size = lot_size
        self.delta = delta
        self.target_pts = target_pts
        self.sl_pts = sl_pts
        self.use_fixed_sl = use_fixed_sl
        self.min_sl_pts = min_sl_pts
        self.max_sl_pts = max_sl_pts
        self.time_exit_bars = time_exit_bars
        self.brokerage_per_trade = brokerage_per_trade
        self.slippage_per_exec = slippage_per_exec
        self.roundtrip_slippage = slippage_per_exec * 2.0
        self.max_trades_per_day = max_trades_per_day
        self.max_consec_losses = max_consec_losses
        self.daily_loss_cap_rs = daily_loss_cap_rs
        self.hard_sqoff_time = hard_sqoff_time
        self.require_volume = require_volume

    def prepare_data(self, df_raw: pd.DataFrame) -> pd.DataFrame:
        """Precompute indicators, daily VWAP, HTF 5m EMAs and sweep flags."""
        df = df_raw.copy()

        # Normalize column names
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

        # 1-minute EMAs
        df["ema9"] = df["Close"].ewm(span=9, adjust=False).mean()
        df["ema20"] = df["Close"].ewm(span=20, adjust=False).mean()

        # Volume handling & SMA(Volume, 10)
        has_vol = "Volume" in df.columns and (df["Volume"] > 0).any()
        if has_vol:
            # Volume moving average on preceding 10 bars
            df["vol_sma10"] = df["Volume"].shift(1).rolling(10).mean()
            # Daily VWAP
            typical_price = (df["High"] + df["Low"] + df["Close"]) / 3.0
            pv = typical_price * df["Volume"]
            df["cum_pv"] = pv.groupby(df["date"]).cumsum()
            df["cum_vol"] = df["Volume"].groupby(df["date"]).cumsum()
            df["vwap"] = df["cum_pv"] / df["cum_vol"].replace(0, np.nan)
        else:
            # If volume absent, use typical price cumulative average as proxy
            typical_price = (df["High"] + df["Low"] + df["Close"]) / 3.0
            df["vwap"] = typical_price.groupby(df["date"]).expanding().mean().reset_index(level=0, drop=True)
            df["vol_sma10"] = 1.0
            df["Volume"] = 1.0

        # Resample to 5-minute Higher Timeframe (Strict Zero Lookahead)
        df5 = (
            df.set_index("Timestamp")
            .resample("5min")
            .agg({
                "Open": "first",
                "High": "max",
                "Low": "min",
                "Close": "last",
                "Volume": "sum" if has_vol else "count",
            })
            .dropna()
            .reset_index()
        )
        df5["ema9_5m"] = df5["Close"].ewm(span=9, adjust=False).mean()
        df5["ema20_5m"] = df5["Close"].ewm(span=20, adjust=False).mean()
        # The 5-minute bar starting at T is closed and available at T + 5min
        df5["avail_ts"] = df5["Timestamp"] + pd.to_timedelta(5, unit="m")

        # Merge backward so 1m bar at timestamp T only sees 5m indicators completed at or before T
        df = pd.merge_asof(
            df.sort_values("Timestamp"),
            df5[["avail_ts", "ema9_5m", "ema20_5m"]].sort_values("avail_ts"),
            left_on="Timestamp",
            right_on="avail_ts",
            direction="backward",
        )

        # Rolling 10-bar Swing High and Swing Low (preceding N=10 candles)
        df["l_ref"] = df["Low"].shift(1).rolling(10).min()
        df["h_ref"] = df["High"].shift(1).rolling(10).max()

        # Lower and Upper wicks
        candle_range = (df["High"] - df["Low"]).replace(0, np.nan)
        lower_wick = np.minimum(df["Open"], df["Close"]) - df["Low"]
        upper_wick = df["High"] - np.maximum(df["Open"], df["Close"])

        lower_wick_ratio = lower_wick / candle_range
        upper_wick_ratio = upper_wick / candle_range

        # Liquidity Sweep condition:
        # Bullish: Low dipped below L_ref, closed back above L_ref, lower wick >= 40%
        df["is_bull_sweep"] = (
            (df["Low"] < df["l_ref"])
            & (df["Close"] > df["l_ref"])
            & (lower_wick_ratio >= 0.40)
        )
        # Bearish: High spiked above H_ref, closed back below H_ref, upper wick >= 40%
        df["is_bear_sweep"] = (
            (df["High"] > df["h_ref"])
            & (df["Close"] < df["h_ref"])
            & (upper_wick_ratio >= 0.40)
        )

        # Lookback t-3 to t-1 for sweep
        df["has_bull_sweep_3"] = df["is_bull_sweep"].shift(1).rolling(3).max() > 0
        df["has_bear_sweep_3"] = df["is_bear_sweep"].shift(1).rolling(3).max() > 0

        # Session Timing Filter: 09:20 to 11:15 & 13:30 to 15:00
        in_window = (
            ((df["time"] >= "09:20:00") & (df["time"] <= "11:15:00"))
            | ((df["time"] >= "13:30:00") & (df["time"] <= "15:00:00"))
        )

        # Volume condition
        if has_vol and self.require_volume:
            vol_cond = df["Volume"] > (1.25 * df["vol_sma10"])
        else:
            vol_cond = pd.Series(True, index=df.index)

        # Long Scalp Setup (Call Option Buying)
        df["call_trigger"] = (
            in_window
            & (df["Close"] > df["vwap"])
            & (df["ema9_5m"] > df["ema20_5m"])
            & df["has_bull_sweep_3"]
            & (df["Close"] > df["ema9"])
            & (df["Close"] > df["ema20"])
            & (df["Close"] > df["Open"])  # Bullish candle body
            & vol_cond
        )

        # Short Scalp Setup (Put Option Buying)
        df["put_trigger"] = (
            in_window
            & (df["Close"] < df["vwap"])
            & (df["ema9_5m"] < df["ema20_5m"])
            & df["has_bear_sweep_3"]
            & (df["Close"] < df["ema9"])
            & (df["Close"] < df["ema20"])
            & (df["Close"] < df["Open"])  # Bearish candle body
            & vol_cond
        )

        return df

    def run_backtest(self, df: pd.DataFrame) -> List[ScalpTrade]:
        """Execute iterative bar-by-bar backtest with risk budgeting and stagnation invalidation."""
        trades: List[ScalpTrade] = []
        trade_id = 0

        dates = df["date"].unique()

        for d in dates:
            day_df = df[df["date"] == d].reset_index(drop=True)
            n_bars = len(day_df)
            if n_bars < 20:
                continue

            day_trade_count = 0
            consec_losses = 0
            daily_net_rs = 0.0

            in_pos = False
            pos: Dict[str, Any] = {}
            bars_held = 0

            for i in range(n_bars):
                row = day_df.iloc[i]
                t_str = row["time"]

                # ==============================================================
                # 1. POSITION MANAGEMENT (If currently in a trade)
                # ==============================================================
                if in_pos:
                    bars_held += 1
                    spot_high = row["High"]
                    spot_low = row["Low"]
                    spot_close = row["Close"]

                    # Synthetic Option Price Modeling (Delta = 0.55)
                    if pos["side"] == "CALL":
                        opt_high = pos["opt_entry"] + (spot_high - pos["spot_entry"]) * self.delta
                        opt_low = pos["opt_entry"] + (spot_low - pos["spot_entry"]) * self.delta
                        opt_close = pos["opt_entry"] + (spot_close - pos["spot_entry"]) * self.delta
                    else:  # PUT
                        opt_high = pos["opt_entry"] + (pos["spot_entry"] - spot_low) * self.delta
                        opt_low = pos["opt_entry"] + (pos["spot_entry"] - spot_high) * self.delta
                        opt_close = pos["opt_entry"] + (pos["spot_entry"] - spot_close) * self.delta

                    exited = False
                    exit_price = 0.0
                    spot_exit = spot_close
                    reason = ""

                    # Collision / Target / Stop Loss resolution
                    target_hit = opt_high >= pos["opt_target"]
                    sl_hit = opt_low <= pos["opt_sl"]

                    if target_hit and sl_hit:
                        # Conservative assumption on same-bar conflict: Stop-loss executed first
                        exited = True
                        exit_price = pos["opt_sl"]
                        reason = "STOP_LOSS"
                        # Approximate spot exit
                        spot_exit = (
                            pos["spot_entry"] - (pos["risk_pts"] / self.delta)
                            if pos["side"] == "CALL"
                            else pos["spot_entry"] + (pos["risk_pts"] / self.delta)
                        )
                    elif target_hit:
                        exited = True
                        exit_price = pos["opt_target"]
                        reason = "TARGET"
                        spot_exit = (
                            pos["spot_entry"] + (self.target_pts / self.delta)
                            if pos["side"] == "CALL"
                            else pos["spot_entry"] - (self.target_pts / self.delta)
                        )
                    elif sl_hit:
                        exited = True
                        exit_price = pos["opt_sl"]
                        reason = "STOP_LOSS"
                        spot_exit = (
                            pos["spot_entry"] - (pos["risk_pts"] / self.delta)
                            if pos["side"] == "CALL"
                            else pos["spot_entry"] + (pos["risk_pts"] / self.delta)
                        )
                    elif self.time_exit_bars is not None and bars_held >= self.time_exit_bars:
                        # 3-Candle Stagnation Exit
                        exited = True
                        exit_price = opt_close
                        spot_exit = spot_close
                        reason = "TIME_EXIT"
                    elif t_str >= self.hard_sqoff_time:
                        # 15:15:00 Hard Square-off
                        exited = True
                        exit_price = opt_close
                        spot_exit = spot_close
                        reason = "HARD_SQOFF"

                    if exited:
                        gross_pts = exit_price - pos["opt_entry"]
                        net_pts = gross_pts - self.roundtrip_slippage
                        net_rs = (net_pts * self.lot_size) - self.brokerage_per_trade

                        trade_id += 1
                        trades.append(
                            ScalpTrade(
                                trade_id=trade_id,
                                date=str(d),
                                entry_time=pos["entry_time"],
                                exit_time=t_str,
                                side=pos["side"],
                                strike=pos["strike"],
                                spot_entry=pos["spot_entry"],
                                spot_exit=round(spot_exit, 2),
                                opt_entry=round(pos["opt_entry"], 2),
                                opt_exit=round(exit_price, 2),
                                opt_sl=round(pos["opt_sl"], 2),
                                opt_target=round(pos["opt_target"], 2),
                                risk_pts=round(pos["risk_pts"], 2),
                                bars_held=bars_held,
                                exit_reason=reason,
                                gross_pts=round(gross_pts, 2),
                                slippage_pts=round(self.roundtrip_slippage, 2),
                                net_pts=round(net_pts, 2),
                                friction_rs=round(self.brokerage_per_trade, 2),
                                net_rs=round(net_rs, 2),
                            )
                        )

                        in_pos = False
                        day_trade_count += 1
                        daily_net_rs += net_rs
                        if net_pts < 0:
                            consec_losses += 1
                        else:
                            consec_losses = 0

                    continue

                # ==============================================================
                # 2. DAILY RISK BUDGETING CHECK (No new trades if tripped)
                # ==============================================================
                if day_trade_count >= self.max_trades_per_day:
                    continue
                if consec_losses >= self.max_consec_losses:
                    continue
                if daily_net_rs <= self.daily_loss_cap_rs:
                    continue

                # Entry allowed up to 15:00:00
                if t_str >= "15:00:00":
                    continue
                if i + 1 >= n_bars:
                    continue

                # ==============================================================
                # 3. SIGNAL TRIGGER & EXECUTION (Open of Candle t+1)
                # ==============================================================
                is_call = row["call_trigger"]
                is_put = row["put_trigger"]

                if is_call or is_put:
                    # Execute at Open of Candle t+1
                    next_bar = day_df.iloc[i + 1]
                    spot_entry = next_bar["Open"]
                    entry_time = next_bar["time"]

                    # Blackout check on execution bar
                    if ("11:15:00" < entry_time < "13:30:00") or entry_time > "15:00:00":
                        continue

                    side = "CALL" if is_call else "PUT"

                    # Strike Selection: 1 strike ITM
                    if side == "CALL":
                        strike = int(spot_entry // 50) * 50
                        if self.use_fixed_sl:
                            risk = self.sl_pts
                        else:
                            spot_dist = max(0.0, spot_entry - row["Low"])
                            calc_risk = spot_dist * self.delta
                            risk = max(self.min_sl_pts, min(self.max_sl_pts, calc_risk))
                    else:
                        strike = int(math.ceil(spot_entry / 50.0)) * 50
                        if self.use_fixed_sl:
                            risk = self.sl_pts
                        else:
                            spot_dist = max(0.0, row["High"] - spot_entry)
                            calc_risk = spot_dist * self.delta
                            risk = max(self.min_sl_pts, min(self.max_sl_pts, calc_risk))

                    # Nominal base option premium = 100.0 pts
                    nominal_opt_entry = 100.0
                    opt_target = nominal_opt_entry + self.target_pts
                    opt_sl = nominal_opt_entry - risk

                    pos = {
                        "side": side,
                        "strike": strike,
                        "spot_entry": spot_entry,
                        "entry_time": entry_time,
                        "opt_entry": nominal_opt_entry,
                        "opt_sl": opt_sl,
                        "opt_target": opt_target,
                        "risk_pts": risk,
                    }
                    in_pos = True
                    bars_held = 0

        return trades


def generate_performance_report(
    trades: List[ScalpTrade], title: str = "Backtest Results", lot_size: int = 65
) -> Dict[str, Any]:
    """Calculate and format quantitative metrics for the scalp strategy."""
    if not trades:
        return {"total_trades": 0, "message": "No trades executed."}

    df_t = pd.DataFrame([t.__dict__ for t in trades])

    total_trades = len(df_t)
    winners = df_t[df_t["net_pts"] > 0]
    losers = df_t[df_t["net_pts"] < 0]
    breakeven = df_t[df_t["net_pts"] == 0]

    win_count = len(winners)
    loss_count = len(losers)
    win_rate = (win_count / total_trades) * 100.0

    gross_pnl_pts = df_t["gross_pts"].sum()
    net_pnl_pts = df_t["net_pts"].sum()
    net_pnl_rs = df_t["net_rs"].sum()

    gross_profit_rs = df_t[df_t["net_rs"] > 0]["net_rs"].sum()
    gross_loss_rs = abs(df_t[df_t["net_rs"] < 0]["net_rs"].sum())
    profit_factor = (gross_profit_rs / gross_loss_rs) if gross_loss_rs > 0 else 999.0

    # Friction-free profit factor
    gross_pts_win = df_t[df_t["gross_pts"] > 0]["gross_pts"].sum()
    gross_pts_loss = abs(df_t[df_t["gross_pts"] < 0]["gross_pts"].sum())
    gross_profit_factor = (gross_pts_win / gross_pts_loss) if gross_pts_loss > 0 else 999.0

    avg_win_pts = winners["net_pts"].mean() if len(winners) > 0 else 0.0
    avg_loss_pts = abs(losers["net_pts"].mean()) if len(losers) > 0 else 0.0
    payoff_ratio = (avg_win_pts / avg_loss_pts) if avg_loss_pts > 0 else 0.0

    avg_duration = df_t["bars_held"].mean()
    duration_2_to_4 = (
        (df_t["bars_held"] >= 2) & (df_t["bars_held"] <= 4)
    ).sum() / total_trades * 100.0

    # Max Drawdown
    df_t["cum_pnl_rs"] = df_t["net_rs"].cumsum()
    df_t["peak_rs"] = df_t["cum_pnl_rs"].cummax()
    df_t["dd_rs"] = df_t["cum_pnl_rs"] - df_t["peak_rs"]
    max_dd_rs = abs(df_t["dd_rs"].min()) if not df_t.empty else 0.0

    df_t["cum_pnl_pts"] = df_t["net_pts"].cumsum()
    df_t["peak_pts"] = df_t["cum_pnl_pts"].cummax()
    df_t["dd_pts"] = df_t["cum_pnl_pts"] - df_t["peak_pts"]
    max_dd_pts = abs(df_t["dd_pts"].min()) if not df_t.empty else 0.0

    # Exit reason counts
    exit_counts = df_t["exit_reason"].value_counts().to_dict()

    # Long vs Short
    calls = df_t[df_t["side"] == "CALL"]
    puts = df_t[df_t["side"] == "PUT"]

    return {
        "title": title,
        "total_trades": total_trades,
        "win_count": win_count,
        "loss_count": loss_count,
        "breakeven_count": len(breakeven),
        "win_rate": round(win_rate, 2),
        "profit_factor": round(profit_factor, 2),
        "gross_profit_factor": round(gross_profit_factor, 2),
        "net_pnl_rs": round(net_pnl_rs, 2),
        "net_pnl_pts": round(net_pnl_pts, 2),
        "gross_pnl_pts": round(gross_pnl_pts, 2),
        "avg_win_pts": round(avg_win_pts, 2),
        "avg_loss_pts": round(avg_loss_pts, 2),
        "payoff_ratio": round(payoff_ratio, 2),
        "expectancy_rs": round(net_pnl_rs / total_trades, 2),
        "max_dd_rs": round(max_dd_rs, 2),
        "max_dd_pts": round(max_dd_pts, 2),
        "avg_duration_min": round(avg_duration, 2),
        "pct_2_to_4_min": round(duration_2_to_4, 1),
        "exit_reasons": exit_counts,
        "calls": {
            "count": len(calls),
            "win_rate": round((calls["net_pts"] > 0).mean() * 100.0, 1) if len(calls) else 0.0,
            "net_rs": round(calls["net_rs"].sum(), 2) if len(calls) else 0.0,
        },
        "puts": {
            "count": len(puts),
            "win_rate": round((puts["net_pts"] > 0).mean() * 100.0, 1) if len(puts) else 0.0,
            "net_rs": round(puts["net_rs"].sum(), 2) if len(puts) else 0.0,
        },
        "trades_df": df_t,
    }


def print_performance_table(rep: Dict[str, Any]):
    """Print beautifully formatted CLI report."""
    print("=" * 80)
    print(f" {rep['title'].upper()}")
    print("=" * 80)
    print(f"Total Scalp Trades:        {rep['total_trades']}")
    print(f"Winning Trades:            {rep['win_count']} ({rep['win_rate']}%)")
    print(f"Losing Trades:             {rep['loss_count']}")
    print(f"Breakeven Trades:          {rep['breakeven_count']}")
    print("-" * 80)
    print(f"Profit Factor (Net):       {rep['profit_factor']}  (Gross: {rep['gross_profit_factor']})")
    print(f"Total Net P&L (Rs):        Rs. {rep['net_pnl_rs']:,.2f}")
    print(f"Total Net Points:          {rep['net_pnl_pts']:+,.2f} pts  (Gross: {rep['gross_pnl_pts']:+,.2f} pts)")
    print(f"Average Win:               +{rep['avg_win_pts']:.2f} pts")
    print(f"Average Loss:              -{rep['avg_loss_pts']:.2f} pts")
    print(f"Payoff Ratio (R:R):        {rep['payoff_ratio']:.2f}")
    print(f"Expectancy / Trade:        Rs. {rep['expectancy_rs']:+,.2f}")
    print(f"Max Drawdown (Rs):         Rs. {rep['max_dd_rs']:,.2f}  ({rep['max_dd_pts']:.2f} pts)")
    print("-" * 80)
    print(f"Average Duration:          {rep['avg_duration_min']:.2f} minutes")
    print(f"Trades exiting in 2-4 min: {rep['pct_2_to_4_min']}%")
    print(f"Exit Breakdown:            {rep['exit_reasons']}")
    print("-" * 80)
    c = rep["calls"]
    p = rep["puts"]
    print(f"CALL Scalps (CE):          {c['count']} trades | Win Rate: {c['win_rate']}% | Net Rs: Rs. {c['net_rs']:,.2f}")
    print(f"PUT Scalps (PE):           {p['count']} trades | Win Rate: {p['win_rate']}% | Net Rs: Rs. {p['net_rs']:,.2f}")
    print("=" * 80)


def load_nifty_data(year: Optional[int] = 2026, all_years: bool = False) -> pd.DataFrame:
    """Load historical Nifty 1-minute CSVs from captured_data/technovusin_nifty50/1min."""
    base_dir = Path("captured_data/technovusin_nifty50/1min")
    if not base_dir.exists():
        raise FileNotFoundError(f"Data directory {base_dir} not found.")

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
        raise FileNotFoundError(f"No 1-minute CSV files found for year {year} in {base_dir}.")

    print(f"Loading {len(files)} 1-minute file(s)...")
    dfs = []
    for f in files:
        df_part = pd.read_csv(f)
        dfs.append(df_part)

    df_full = pd.concat(dfs, ignore_index=True)
    print(f"Loaded {len(df_full):,} 1-minute candles.")
    return df_full


def main():
    parser = argparse.ArgumentParser(description="Nifty 1-Min Liquidity Sweep & EMA Scalp Backtest")
    parser.add_argument("--year", type=int, default=2026, help="Year to backtest (default: 2026)")
    parser.add_argument("--all-years", action="store_true", help="Run backtest across all available years (2017-2026)")
    parser.add_argument("--lot-size", type=int, default=65, help="Lot size (default: 65 units)")
    parser.add_argument("--delta", type=float, default=0.55, help="Option Delta factor (default: 0.55)")
    parser.add_argument("--target-pts", type=float, default=10.0, help="Option Target pts (default: 10.0)")
    parser.add_argument("--slippage", type=float, default=0.5, help="Slippage per execution (default: 0.5 pts)")
    parser.add_argument("--brokerage", type=float, default=60.0, help="Brokerage flat per trade (default: ₹60)")
    parser.add_argument("--no-time-exit", action="store_true", help="Disable the 3-minute stagnation rule")
    parser.add_argument("--compare", action="store_true", default=True, help="Run side-by-side comparison With vs Without 3-Min Exit")
    parser.add_argument("--output-csv", type=str, default="performance/liquidity_sweep_scalp_trades.csv", help="Output trades CSV path")
    args = parser.parse_args()

    df_raw = load_nifty_data(year=args.year, all_years=args.all_years)

    engine_with = LiquiditySweepScalpEngine(
        lot_size=args.lot_size,
        delta=args.delta,
        target_pts=args.target_pts,
        time_exit_bars=3,
        brokerage_per_trade=args.brokerage,
        slippage_per_exec=args.slippage,
    )

    print("\nPreparing indicators (EMA9, EMA20, Session VWAP, HTF 5m EMAs, Liquidity Sweeps)...")
    df_prepared = engine_with.prepare_data(df_raw)

    print("Running Backtest WITH 3-Minute Time Exit...")
    trades_with = engine_with.run_backtest(df_prepared)
    rep_with = generate_performance_report(
        trades_with, title=f"Nifty Liquidity Sweep Scalp (WITH 3-Min Exit) - {args.year if not args.all_years else 'All Years'}", lot_size=args.lot_size
    )
    print_performance_table(rep_with)

    # Save trades to CSV
    if trades_with:
        out_path = Path(args.output_csv)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        rep_with["trades_df"].to_csv(out_path, index=False)
        print(f"\n[+] Saved {len(trades_with)} trades to {out_path.resolve()}")

    if args.compare:
        print("\n" + "#" * 80)
        print(" IMPACT OF THE 3-CANDLE RULE: RUNNING WITHOUT 3-MINUTE TIME EXIT")
        print("#" * 80)

        engine_without = LiquiditySweepScalpEngine(
            lot_size=args.lot_size,
            delta=args.delta,
            target_pts=args.target_pts,
            time_exit_bars=None,  # Stagnation exit disabled
            brokerage_per_trade=args.brokerage,
            slippage_per_exec=args.slippage,
        )

        trades_without = engine_without.run_backtest(df_prepared)
        rep_without = generate_performance_report(
            trades_without,
            title=f"Nifty Liquidity Sweep Scalp (WITHOUT 3-Min Exit) - {args.year if not args.all_years else 'All Years'}",
            lot_size=args.lot_size,
        )
        print_performance_table(rep_without)

        # Print Side-by-Side Comparison
        print("\n" + "=" * 80)
        print(" SIDE-BY-SIDE IMPACT COMPARISON: 3-MINUTE RULE")
        print("=" * 80)
        print(f"{'Metric':<32} | {'WITH 3-Min Rule':<20} | {'WITHOUT 3-Min Rule':<20}")
        print("-" * 80)
        print(f"{'Total Trades':<32} | {rep_with['total_trades']:<20} | {rep_without['total_trades']:<20}")
        print(f"{'Win Rate (%)':<32} | {rep_with['win_rate']:<20} | {rep_without['win_rate']:<20}")
        print(f"{'Net Profit Factor':<32} | {rep_with['profit_factor']:<20} | {rep_without['profit_factor']:<20}")
        print(f"{'Gross Profit Factor':<32} | {rep_with['gross_profit_factor']:<20} | {rep_without['gross_profit_factor']:<20}")
        print(f"{'Net P&L (Rs)':<32} | Rs. {rep_with['net_pnl_rs']:<16,.2f} | Rs. {rep_without['net_pnl_rs']:<16,.2f}")
        print(f"{'Net Points':<32} | {rep_with['net_pnl_pts']:<+20,.2f} | {rep_without['net_pnl_pts']:<+20,.2f}")
        print(f"{'Average Duration':<32} | {rep_with['avg_duration_min']:<17.2f}m | {rep_without['avg_duration_min']:<17.2f}m")
        print(f"{'Max Drawdown (Rs)':<32} | Rs. {rep_with['max_dd_rs']:<16,.2f} | Rs. {rep_without['max_dd_rs']:<16,.2f}")
        print(f"{'Expectancy / Trade':<32} | Rs. {rep_with['expectancy_rs']:<16,.2f} | Rs. {rep_without['expectancy_rs']:<16,.2f}")
        print("=" * 80)

        # Monthly breakdown
        if "trades_df" in rep_with and not rep_with["trades_df"].empty:
            df_w = rep_with["trades_df"].copy()
            df_w["month"] = df_w["date"].str.slice(0, 7)
            monthly = df_w.groupby("month").agg(
                trades=("trade_id", "count"),
                win_rate=("net_pts", lambda x: round((x > 0).mean() * 100, 1)),
                net_pts=("net_pts", lambda x: round(x.sum(), 2)),
                net_rs=("net_rs", lambda x: round(x.sum(), 2)),
            ).reset_index()

            print("\nMONTHLY BREAKDOWN (WITH 3-MINUTE TIME EXIT):")
            print("-" * 65)
            print(f"{'Month':<10} | {'Trades':<8} | {'Win Rate':<10} | {'Net Points':<12} | {'Net P&L (Rs)':<14}")
            print("-" * 65)
            for _, mrow in monthly.iterrows():
                print(f"{mrow['month']:<10} | {mrow['trades']:<8} | {mrow['win_rate']:<9}% | {mrow['net_pts']:<+12.2f} | Rs. {mrow['net_rs']:<10,.2f}")
            print("-" * 65)


if __name__ == "__main__":
    main()
