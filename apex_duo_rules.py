"""
Single Source of Truth — Apex Duo Static Strategy Rules.

All entry, exit, stop-loss, and Dual-Cross confluence rules live here.
Both Backtest (`scripts/run_dual_confluence_master_backtest.py`) and
Live/Paper (`trend_runner_paper.py`, `app_server.py`) call these exact
functions so strategy behavior cannot drift across engines.
"""

from __future__ import annotations

from typing import Optional

# --- Static Engine Constants (Non-Tamperable) ---
BODY_STANDARD_TH: float = 0.70
BODY_CONVICTION_TH: float = 0.80
WICK_PCT_MAX: float = 0.30

NIFTY_WICK_TOL: float = 4.0
SENSEX_WICK_TOL: float = 15.0

NIFTY_INITIAL_SL_PTS: float = 50.0
SENSEX_INITIAL_SL_PTS: float = 200.0

NIFTY_EMA_BUFFER_PTS: float = 2.5
SENSEX_EMA_BUFFER_PTS: float = 7.5

NIFTY_EMA_ARM_PTS: float = 50.0
SENSEX_EMA_ARM_PTS: float = 150.0

CALL_CUTOFF_TIME: str = "10:45"
VIX_CALL_TH: float = 1.8
VIX_PUT_TH: float = 0.0
DUAL_ACTIVATION_WINDOW_SECS: int = 3600


def get_initial_sl_pts(symbol: str) -> float:
    return SENSEX_INITIAL_SL_PTS if symbol.upper() == "SENSEX" else NIFTY_INITIAL_SL_PTS


def get_ema_buffer_pts(symbol: str) -> float:
    return SENSEX_EMA_BUFFER_PTS if symbol.upper() == "SENSEX" else NIFTY_EMA_BUFFER_PTS


def get_ema_arm_pts(symbol: str) -> float:
    return SENSEX_EMA_ARM_PTS if symbol.upper() == "SENSEX" else NIFTY_EMA_ARM_PTS


def get_wick_tol_pts(symbol: str) -> float:
    return SENSEX_WICK_TOL if symbol.upper() == "SENSEX" else NIFTY_WICK_TOL


def evaluate_bo_candle(
    symbol: str,
    o: float,
    h: float,
    l: float,
    c: float,
    vix_chg: float,
    t_str: str,
    level_high: float,
    level_low: float,
    vwap: Optional[float] = None,
    trade_num: int = 1,
) -> Optional[str]:
    """
    Evaluate whether a candle is a valid Breakout (BO) entry candle.
    Returns 'CALL', 'PUT', or None.
    """
    rng = h - l
    body_ratio = abs(c - o) / rng if rng > 0 else 0.0
    upper_wick_pts = h - max(o, c)
    lower_wick_pts = min(o, c) - l
    upper_wick_pct = upper_wick_pts / rng if rng > 0 else 0.0
    lower_wick_pct = lower_wick_pts / rng if rng > 0 else 0.0

    wick_tol = get_wick_tol_pts(symbol)
    long_wick_ok = (upper_wick_pct <= WICK_PCT_MAX) or (upper_wick_pts <= wick_tol)
    short_wick_ok = (lower_wick_pct <= WICK_PCT_MAX) or (lower_wick_pts <= wick_tol)

    vwap_long_ok = True if vwap is None else (c > vwap)
    vwap_short_ok = True if vwap is None else (c < vwap)
    call_time_ok = (t_str <= CALL_CUTOFF_TIME) if trade_num == 1 else True

    valid_call_vix = (body_ratio >= BODY_CONVICTION_TH and vix_chg <= 0.0) or (
        body_ratio >= BODY_STANDARD_TH and vix_chg <= -VIX_CALL_TH
    )
    valid_put_vix = body_ratio >= BODY_STANDARD_TH and vix_chg >= VIX_PUT_TH

    if (c > level_high) and (c > o) and vwap_long_ok and long_wick_ok and valid_call_vix and call_time_ok:
        return "CALL"
    if (c < level_low) and (c < o) and vwap_short_ok and short_wick_ok and valid_put_vix:
        return "PUT"
    return None


def check_initial_sl(side: str, h: float, l: float, initial_sl: float) -> bool:
    """Return True if 1m High/Low breached the protective initial stop loss."""
    is_long = side.upper() in ("LONG", "CALL", "CE")
    return (l <= initial_sl) if is_long else (h >= initial_sl)


def is_ema20_armed(symbol: str, max_fav: float) -> bool:
    """Return True once trade favorable excursion reaches the arming threshold."""
    return max_fav >= get_ema_arm_pts(symbol)


def check_ema20_cross(symbol: str, side: str, close_5m: float, ema20_5m: float) -> bool:
    """Return True if 5m close crossed beyond 5m 20-EMA +/- static noise buffer."""
    buf = get_ema_buffer_pts(symbol)
    is_long = side.upper() in ("LONG", "CALL", "CE")
    return (close_5m < (ema20_5m - buf)) if is_long else (close_5m > (ema20_5m + buf))
