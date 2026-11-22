"""
First Candle (C1) + Previous Day Close (PDC) Break & Retest Morning Scalp Strategy.

Rules:
1. First Candle (09:15):
   - BEARISH SETUP (PUT):
     * C1 is a RED candle (Close < Open).
     * C1 breaks or closes below Previous Day Close (PDC).
   - BULLISH SETUP (CALL):
     * C1 is a GREEN candle (Close > Open).
     * C1 breaks or closes above Previous Day Close (PDC).

2. Retest Condition (09:16 to 09:30):
   - For PUT:
     * Price rallies up to retest the broken PDC level (High reaches within buffer of PDC).
     * Retest candle confirms rejection by closing below PDC (Close < PDC).
   - For CALL:
     * Price dips down to retest the broken PDC level (Low reaches within buffer of PDC).
     * Retest candle confirms bounce by closing above PDC (Close > PDC).

3. Entry & Exits:
   - Entry: Next candle open immediately following the rejection/bounce candle.
   - Stop Loss: Placed across PDC (PDC + SL buffer for PUT, PDC - SL buffer for CALL).
   - Target: Quick morning scalp (e.g. +30 to +35 Nifty index points).
   - Max Hold: 15 minutes (fast volatility scalp).
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import List, Optional
import pandas as pd


@dataclass
class C1PDCTrade:
    date: str
    side: str  # "CALL" or "PUT"
    pdc: float
    c1_color: str
    c1_open: float
    c1_high: float
    c1_low: float
    c1_close: float
    retest_time: str
    entry_time: str
    exit_time: str
    entry: float
    stop: float
    target: float
    exit_price: float
    pnl_points: float
    bars_held: int
    reason: str  # "TARGET", "STOP", "TIME"


DEFAULTS = {
    "retest_buffer": 8.0,   # pts within PDC to qualify as retest
    "sl_buffer": 8.0,       # pts beyond PDC for Stop Loss
    "target_points": 35.0,  # scalp target
    "max_hold_bars": 15,    # exit if momentum stalls after 15 mins
    "max_retest_bar": 15,   # retest must occur by 09:30 (bar 15)
}


def evaluate_c1_pdc_day(
    df_day: pd.DataFrame,
    pdc: float,
    config: Optional[dict] = None,
) -> Optional[C1PDCTrade]:
    """Evaluate C1 Break & Retest setup on a single trading day."""
    if len(df_day) < 10:
        return None

    cfg = DEFAULTS.copy()
    if config:
        cfg.update(config)

    retest_buf = float(cfg["retest_buffer"])
    sl_buf = float(cfg["sl_buffer"])
    tp_pts = float(cfg["target_points"])
    max_hold = int(cfg["max_hold_bars"])
    max_retest_bar = int(cfg["max_retest_bar"])

    # 1. First Candle (09:15)
    c1 = df_day.iloc[0]
    c1_o = float(c1["open"])
    c1_h = float(c1["high"])
    c1_l = float(c1["low"])
    c1_c = float(c1["close"])

    c1_red = c1_c < c1_o
    c1_green = c1_c > c1_o

    # Bearish: C1 is RED and closed below PDC (and tested/opened near or above PDC)
    c1_bear_break = c1_red and (c1_c < pdc) and (c1_h >= (pdc - 5.0) or c1_o >= (pdc - 15.0))

    # Bullish: C1 is GREEN and closed above PDC (and tested/opened near or below PDC)
    c1_bull_break = c1_green and (c1_c > pdc) and (c1_l <= (pdc + 5.0) or c1_o <= (pdc + 15.0))

    if not (c1_bear_break or c1_bull_break):
        return None

    entry_side = None
    entry_idx = None
    retest_idx = None

    scan_limit = min(max_retest_bar, len(df_day) - 2)

    # 2. Retest Scanning
    if c1_bear_break:
        for k in range(1, scan_limit):
            h_k = float(df_day.loc[k, "high"])
            c_k = float(df_day.loc[k, "close"])
            o_k = float(df_day.loc[k, "open"])

            # Retest PDC and reject (close below PDC & bearish candle)
            if h_k >= (pdc - retest_buf) and c_k < pdc and c_k <= o_k:
                retest_idx = k
                entry_idx = k + 1
                entry_side = "PUT"
                break
    elif c1_bull_break:
        for k in range(1, scan_limit):
            l_k = float(df_day.loc[k, "low"])
            c_k = float(df_day.loc[k, "close"])
            o_k = float(df_day.loc[k, "open"])

            # Retest PDC and bounce (close above PDC & bullish candle)
            if l_k <= (pdc + retest_buf) and c_k > pdc and c_k >= o_k:
                retest_idx = k
                entry_idx = k + 1
                entry_side = "CALL"
                break

    if entry_side is None or entry_idx is None or entry_idx >= len(df_day):
        return None

    # 3. Execution Simulation
    entry_price = float(df_day.loc[entry_idx, "open"])
    retest_high = float(df_day.loc[retest_idx, "high"])
    retest_low = float(df_day.loc[retest_idx, "low"])

    if entry_side == "PUT":
        sl = max(retest_high + 2.0, pdc + sl_buf)
        risk = sl - entry_price
        if risk > 22.0:
            sl = entry_price + 20.0
        elif risk < 10.0:
            sl = entry_price + 14.0
        tp = entry_price - tp_pts
    else:
        sl = min(retest_low - 2.0, pdc - sl_buf)
        risk = entry_price - sl
        if risk > 22.0:
            sl = entry_price - 20.0
        elif risk < 10.0:
            sl = entry_price - 14.0
        tp = entry_price + tp_pts

    exit_price = float(df_day.loc[min(entry_idx + max_hold, len(df_day) - 1), "close"])
    exit_reason = "TIME"
    exit_bar = min(entry_idx + max_hold, len(df_day) - 1)

    for b in range(entry_idx, min(entry_idx + max_hold, len(df_day))):
        bh = float(df_day.loc[b, "high"])
        bl = float(df_day.loc[b, "low"])

        if entry_side == "PUT":
            if bh >= sl:
                exit_price = sl
                exit_reason = "STOP"
                exit_bar = b
                break
            elif bl <= tp:
                exit_price = tp
                exit_reason = "TARGET"
                exit_bar = b
                break
        else:
            if bl <= sl:
                exit_price = sl
                exit_reason = "STOP"
                exit_bar = b
                break
            elif bh >= tp:
                exit_price = tp
                exit_reason = "TARGET"
                exit_bar = b
                break

    pnl = (entry_price - exit_price) if entry_side == "PUT" else (exit_price - entry_price)

    date_str = str(df_day.loc[0, "ist_ts"])[:10]
    retest_ts = str(df_day.loc[retest_idx, "ist_ts"])[11:16]
    entry_ts = str(df_day.loc[entry_idx, "ist_ts"])[11:16]
    exit_ts = str(df_day.loc[exit_bar, "ist_ts"])[11:16]

    return C1PDCTrade(
        date=date_str,
        side=entry_side,
        pdc=round(pdc, 2),
        c1_color="RED" if c1_red else "GREEN",
        c1_open=round(c1_o, 2),
        c1_high=round(c1_h, 2),
        c1_low=round(c1_l, 2),
        c1_close=round(c1_c, 2),
        retest_time=retest_ts,
        entry_time=entry_ts,
        exit_time=exit_ts,
        entry=round(entry_price, 2),
        stop=round(sl, 2),
        target=round(tp, 2),
        exit_price=round(exit_price, 2),
        pnl_points=round(pnl, 2),
        bars_held=exit_bar - entry_idx,
        reason=exit_reason,
    )


def backtest_c1_pdc_retest(all_df: pd.DataFrame, config: Optional[dict] = None) -> pd.DataFrame:
    """Run full C1 Break & Retest backtest across all trading days."""
    work = all_df.copy()
    work["timestamp"] = pd.to_datetime(work["timestamp"])
    if work["timestamp"].iloc[0].hour < 6:
        work["ist_ts"] = work["timestamp"].dt.tz_localize("UTC").dt.tz_convert("Asia/Kolkata").dt.tz_localize(None)
    else:
        work["ist_ts"] = work["timestamp"]
    work.sort_values("ist_ts", inplace=True)
    work.reset_index(drop=True, inplace=True)
    work["date"] = work["ist_ts"].dt.date

    days = sorted(work["date"].unique())
    day_slices = {d: work[work["date"] == d].reset_index(drop=True) for d in days if len(work[work["date"] == d]) >= 15}
    valid_days = [d for d in days if d in day_slices]

    trades: List[C1PDCTrade] = []
    for i in range(1, len(valid_days)):
        prev_day = valid_days[i - 1]
        curr_day = valid_days[i]

        df_prev = day_slices[prev_day]
        df_curr = day_slices[curr_day]

        pdc = float(df_prev.iloc[-1]["close"])
        trade = evaluate_c1_pdc_day(df_curr, pdc, config=config)
        if trade:
            trades.append(trade)

    if not trades:
        return pd.DataFrame()

    return pd.DataFrame([asdict(t) for t in trades])
