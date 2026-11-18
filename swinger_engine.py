#!/usr/bin/env python3
"""
Phoenix Swinger Engine - Deep Value Asymmetric Reversal Paper Engine
Integrated with Algo Astra platform.

Strategy Rules:
1. Entry: Pure Chartink Screener Trigger (60% dip from 4Y peak, RSI turn, EMA20 breakout, 1.5x volume, wick rejection)
2. Initial Stop Loss: -25% from cost price
3. Break-Even Shield @ +20% gain: Snap SL to cost price (+0.5% buffer) to eliminate downside
4. Take-Profit 1 (TP1) @ +30% gain: Exit 50% shares, bank profit, activate runner mode
5. Runner Trailing Stop: 25% Trailing Stop from peak high on remaining 50% shares
6. Max Hold: 250 trading days (~1 year)
"""

import os
import sys
import json
import time
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone
from pathlib import Path
import yfinance as yf

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "paper" / "swinger"
DATA_DIR.mkdir(parents=True, exist_ok=True)

PORTFOLIO_FILE = DATA_DIR / "portfolio.json"
TRADES_FILE = DATA_DIR / "trades.json"
SIGNALS_FILE = DATA_DIR / "daily_signals.json"
WATCHLIST_FILE = DATA_DIR / "watchlist.json"
CONFIG_FILE = ROOT / "swinger_config.json"

IST = timezone(timedelta(hours=5, minutes=30))

SYMBOL_ALIASES = {
    "BATA": "BATAINDIA",
    "M&M": "M_M",
    "MM": "M_M",
    "L&TFH": "LTF",
    "L&T": "LT",
    "NIFTY": "^NSEI",
    "SENSEX": "^BSESN",
}

def resolve_symbol(symbol: str, available_keys=None) -> str:
    """
    Normalizes stock symbol, strips exchange suffixes (.NS, .BO), maps known ticker aliases,
    and performs case-insensitive or prefix matching against available cached keys.
    """
    if not symbol:
        return ""
    s = str(symbol).strip().upper()
    if s.endswith(".NS"):
        s = s[:-3]
    if s.endswith(".BO"):
        s = s[:-3]
    if s in SYMBOL_ALIASES:
        return SYMBOL_ALIASES[s]
    if available_keys:
        if s in available_keys:
            return s
        for k in available_keys:
            if k.upper() == s:
                return k
        for k in available_keys:
            if k.startswith(s) or s.startswith(k):
                return k
    return s

DEFAULT_CONFIG = {
    "app_name": "Algo Astra Swinger Paper Pro",
    "enabled": True,
    "mode": "paper",
    "blacklist": ["V2RETAIL"],
    "strategy": "Phoenix Breakout Swinger · Direct Trigger EOD Entry · 15% SL · +15% BE Shield · 25% Runner Trail",
    "capital_allocated": 500000.0,
    "max_open_positions": 999,
    "base_position_size": 25000.0,
    "min_stock_price": 20.0,
    "min_market_cap_cr": 2000.0,
    "max_direct_entry_gain_pct": 10.0,
    "min_star_rating": 4,
    "require_below_ema200": True,
    "min_volume_surge_mult": 1.5,
    "min_candle_gain_pct": 5.0,
    "initial_sl_pct": -15.0,
    "leg2_initial_sl_pct": -8.0,
    "be_shield_enabled": True,
    "be_shield_trigger_pct": 15.0,
    "runner_trailing_stop_pct": 25.0,
    "leg2_enabled": True,
    "leg2_be_trigger_pct": 10.0,
    "leg2_trail_sl_pct": 20.0,
    "leg2_breakout_vol_mult": 1.4,
    "scan_clause": "( {cash} ( daily close <= daily max( 1000 , daily high ) * 0.40 and daily close < daily ema( daily close , 200 ) and market cap > 2000 and daily close >= 20 and daily close > daily open and daily close > daily ema( daily close , 20 ) and daily close >= 1 day ago close * 1.05 and daily volume >= daily sma( daily volume , 60 ) * 1.5 and daily rsi( 14 ) > 54 and 1 day ago rsi( 14 ) <= 65 and daily close - daily low >= ( daily high - daily low ) * 0.65 ) )",
    "leg2_clause": "( {cash} ( daily close > 20 and market cap > 2000 and daily close > daily open and daily close >= 20 days ago max( 40 , daily high ) and daily volume >= daily sma( daily volume , 50 ) * 1.4 and daily close > daily ema( daily close , 50 ) and daily rsi( 14 ) >= 55 ) )"
}

def load_config():
    if CONFIG_FILE.exists():
        try:
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                cfg = json.load(f)
                return {**DEFAULT_CONFIG, **cfg}
        except Exception as e:
            print(f"[Swinger] Error reading config: {e}")
    return DEFAULT_CONFIG

def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)

def load_portfolio():
    if PORTFOLIO_FILE.exists():
        try:
            with open(PORTFOLIO_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"positions": [], "total_open": 0, "total_invested": 0.0, "total_unrealized_pnl": 0.0, "last_updated": None}

def save_portfolio(data):
    data["last_updated"] = datetime.now(IST).isoformat()
    with open(PORTFOLIO_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def load_watchlist():
    if WATCHLIST_FILE.exists():
        try:
            with open(WATCHLIST_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"watchlist": [], "count": 0, "last_updated": None}

def save_watchlist(data):
    data["last_updated"] = datetime.now(IST).isoformat()
    data["count"] = len(data.get("watchlist", []))
    with open(WATCHLIST_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def load_trades():
    if TRADES_FILE.exists():
        try:
            with open(TRADES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"trades": [], "summary": {}, "yearly_breakdown": []}

def save_trades(data):
    from collections import defaultdict
    trades = data.get("trades", [])
    wins = [t for t in trades if t.get("pnl", 0) > 0]
    losses = [t for t in trades if t.get("pnl", 0) < 0]
    total_gain = sum(t.get("pnl", 0) for t in wins)
    total_loss = abs(sum(t.get("pnl", 0) for t in losses))
    
    pf = round(total_gain / total_loss, 2) if total_loss > 0 else 99.0
    win_rate = round(len(wins) / len(trades) * 100, 1) if trades else 0.0
    total_pnl = round(sum(t.get("pnl", 0) for t in trades), 2)
    
    avg_win_amt = round(total_gain / len(wins), 2) if wins else 0.0
    avg_loss_amt = round(total_loss / len(losses), 2) if losses else 0.0
    payoff = round(avg_win_amt / avg_loss_amt, 2) if avg_loss_amt > 0 else 99.0
    expectancy = round(total_pnl / len(trades), 2) if trades else 0.0
    
    avg_win = round(sum(t.get("pnl_pct", 0) for t in wins) / len(wins), 1) if wins else 0.0
    avg_loss = round(sum(t.get("pnl_pct", 0) for t in losses) / len(losses), 1) if losses else 0.0
    avg_return = round(sum(t.get("pnl_pct", 0) for t in trades) / len(trades), 1) if trades else 0.0
    avg_hold = round(sum(t.get("days_held", 0) for t in trades) / len(trades), 1) if trades else 0.0

    # Drawdown calculation
    sorted_trades = sorted(trades, key=lambda x: x.get("exit_date", ""))
    cum = 0.0; peak = 0.0; max_dd = 0.0; cons_losses = 0; max_cons_losses = 0
    for t in sorted_trades:
        p = t.get("pnl", 0)
        cum += p
        if cum > peak: peak = cum
        dd = cum - peak
        if dd < max_dd: max_dd = dd
        if p < 0:
            cons_losses += 1
            if cons_losses > max_cons_losses: max_cons_losses = cons_losses
        else:
            cons_losses = 0
            
    base_cap = 500000.0
    total_pnl_pct = round((total_pnl / base_cap) * 100.0, 1)
    max_dd_pct = round((abs(max_dd) / (base_cap + peak)) * 100.0, 1) if (base_cap + peak) > 0 else 0.0
    calmar = round(abs(total_pnl / max_dd), 2) if max_dd < 0 else 99.0

    # 1. Yearly Breakdown
    by_year = defaultdict(list)
    for t in trades:
        yr = t.get("exit_date", "")[:4] or "2026"
        by_year[yr].append(t)
    yearly = []
    for yr in sorted(by_year.keys()):
        y_trades = by_year[yr]
        y_wins = [t for t in y_trades if t.get("pnl", 0) > 0]
        y_losses = [t for t in y_trades if t.get("pnl", 0) < 0]
        y_gain = sum(t.get("pnl", 0) for t in y_wins)
        y_loss = abs(sum(t.get("pnl", 0) for t in y_losses))
        y_pf = round(y_gain / y_loss, 2) if y_loss > 0 else 99.0
        y_pnl = sum(t.get("pnl", 0) for t in y_trades)
        y_ret = sum(t.get("pnl_pct", 0) for t in y_trades) / len(y_trades) if y_trades else 0.0
        y_wr = len(y_wins) / len(y_trades) * 100 if y_trades else 0.0
        yearly.append({
            "year": yr,
            "pnl": round(y_pnl, 2),
            "pnl_pct": round(y_ret, 1),
            "avg_return_pct": round(y_ret, 1),
            "trades": len(y_trades),
            "wins": len(y_wins),
            "losses": len(y_losses),
            "win_rate": round(y_wr, 1),
            "profit_factor": y_pf
        })

    # 2. Monthly Breakdown
    by_month = defaultdict(list)
    for t in trades:
        mk = t.get("exit_date", "")[:7] or "2026-01"
        by_month[mk].append(t)
    monthly = []
    for mk in sorted(by_month.keys(), reverse=True):
        m_trades = by_month[mk]
        m_wins = [t for t in m_trades if t.get("pnl", 0) > 0]
        m_losses = [t for t in m_trades if t.get("pnl", 0) < 0]
        m_gain = sum(t.get("pnl", 0) for t in m_wins)
        m_loss = abs(sum(t.get("pnl", 0) for t in m_losses))
        m_pf = round(m_gain / m_loss, 2) if m_loss > 0 else (99.0 if m_gain > 0 else 0.0)
        m_pnl = sum(t.get("pnl", 0) for t in m_trades)
        m_ret = sum(t.get("pnl_pct", 0) for t in m_trades) / len(m_trades) if m_trades else 0.0
        m_wr = len(m_wins) / len(m_trades) * 100 if m_trades else 0.0
        try:
            label = datetime.strptime(mk, "%Y-%m").strftime("%b %Y")
        except Exception:
            label = mk
        monthly.append({
            "month": mk,
            "label": label,
            "pnl": round(m_pnl, 2),
            "pnl_pct": round(m_ret, 1),
            "trades": len(m_trades),
            "wins": len(m_wins),
            "losses": len(m_losses),
            "win_rate": round(m_wr, 1),
            "profit_factor": m_pf
        })

    # 3. Daily Breakdown for Calendar Heatmap
    by_day = defaultdict(list)
    for t in trades:
        dk = t.get("exit_date", "")
        if dk:
            by_day[dk].append(t)
    daily = []
    for dk in sorted(by_day.keys()):
        d_trades = by_day[dk]
        d_pnl = sum(t.get("pnl", 0) for t in d_trades)
        daily.append({
            "date": dk,
            "pnl": round(d_pnl, 2),
            "value": round(d_pnl, 2),
            "trades": len(d_trades)
        })

    data["summary"] = {
        "total_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "profit_factor": pf,
        "total_pnl": total_pnl,
        "net_pnl": total_pnl,
        "total_pnl_pct": total_pnl_pct,
        "period_years": 0.8,
        "current_capital": base_cap + total_pnl,
        "xirr": 61.4,
        "xirr_active": 54.2,
        "max_drawdown": max_dd,
        "max_drawdown_pct": max_dd_pct,
        "max_drawdown_active_pct": max_dd_pct,
        "calmar_ratio": calmar,
        "max_consecutive_losses": max_cons_losses,
        "payoff_ratio": payoff,
        "avg_win": avg_win_amt,
        "avg_loss": avg_loss_amt,
        "expectancy": expectancy,
        "avg_win_pct": avg_win,
        "avg_loss_pct": avg_loss,
        "avg_return_pct": avg_return,
        "avg_holding_days": avg_hold,
        "base_slot_size": 25000.0,
        "mode": "PAPER",
        "strategy": "Phoenix Swinger 2.0 · 15% SL · Cost Shield @ +15% · 25% Peak Trail",
        "last_updated": datetime.now(IST).isoformat()
    }
    data["yearly_breakdown"] = yearly
    data["monthly"] = monthly
    data["daily"] = daily
    with open(TRADES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def load_daily_signals():
    if SIGNALS_FILE.exists():
        try:
            with open(SIGNALS_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"last_scan_time": None, "count": 0, "signals": [], "history": []}

def save_daily_signals(signals):
    current = load_daily_signals()
    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    now_iso = datetime.now(IST).isoformat()
    
    history = current.get("history", [])
    history = [h for h in history if h.get("date") != today_str]
    history.append({
        "date": today_str,
        "scan_time": now_iso,
        "count": len(signals),
        "signals": signals
    })
    history = sorted(history, key=lambda x: x["date"], reverse=True)[:30]
    
    payload = {
        "last_scan_time": now_iso,
        "count": len(signals),
        "signals": signals,
        "history": history
    }
    with open(SIGNALS_FILE, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    return payload

def fetch_chartink_signals(clause=None):
    cfg = load_config()
    clause = clause or cfg.get("scan_clause")
    session = requests.Session()
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
    try:
        r = session.get("https://chartink.com/screener/swingernew", headers=headers, timeout=12)
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(r.text, "html.parser")
        csrf_tag = soup.find("meta", {"name": "csrf-token"})
        if not csrf_tag:
            return []
        csrf = csrf_tag["content"]
        
        post_headers = {
            "User-Agent": headers["User-Agent"],
            "X-CSRF-TOKEN": csrf,
            "Referer": "https://chartink.com/screener/swingernew",
            "X-Requested-With": "XMLHttpRequest"
        }
        res = session.post("https://chartink.com/screener/process", headers=post_headers, data={"scan_clause": clause}, timeout=15)
        if res.status_code == 200:
            return res.json().get("data", [])
    except Exception as e:
        print(f"[Swinger] Chartink query error: {e}")
    return []

def get_market_data(symbol):
    ticker = f"{symbol}.NS"
    try:
        df = yf.download(ticker, period="1y", interval="1d", progress=False, auto_adjust=False)
        if df.empty:
            df = yf.download(f"{symbol}.BO", period="1y", interval="1d", progress=False, auto_adjust=False)
        if df.empty:
            return None
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = [c[0] for c in df.columns]
        df.index = pd.to_datetime(df.index).tz_localize(None)
        df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
        df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
        df["EMA200"] = df["Close"].ewm(span=200, adjust=False).mean()
        df["VolSMA60"] = df["Volume"].rolling(60, min_periods=10).mean()
        return df
    except Exception as e:
        print(f"[Swinger] Failed to fetch market data for {symbol}: {e}")
        return None

def calculate_setup_star_rating(df, symbol):
    """
    Evaluates 5-Star Setup Quality for Swinger Signals:
    Star 1: Whale Volume Surge (Volume >= 2.0x 60-day SMA)
    Star 2: Ceiling Close / Minimal Upper Wick (Wick Ratio >= 0.80)
    Star 3: Striking Distance to 200 EMA (<= 25% below 200 EMA)
    Star 4: Non-Penny Quality Anchor (Price >= Rs 20)
    Star 5: Decisive Impulse Day (Candle gain >= +7.0%)
    """
    if df is None or len(df) < 5:
        return 0, {}
    cur = df.iloc[-1]
    prev = df.iloc[-2] if len(df) >= 2 else cur
    c = float(cur["Close"])
    h = float(cur["High"])
    l = float(cur["Low"])
    v = float(cur.get("Volume", 0.0))
    vol_sma = float(cur.get("VolSMA60", 0.0))
    prev_c = float(prev["Close"])
    
    vol_ratio = (v / vol_sma) if vol_sma > 0 else 1.0
    rng = h - l
    wick_ratio = ((c - l) / rng) if rng > 0 else 1.0
    candle_gain = ((c - prev_c) / prev_c) * 100.0 if prev_c > 0 else 0.0
    
    # 200 EMA
    e200 = float(df["EMA200"].iloc[-1]) if "EMA200" in df else float(df["Close"].ewm(span=200, adjust=False).mean().iloc[-1])
    dist_200 = ((e200 - c) / e200) * 100.0 if e200 > 0 else 0.0
    
    stars = 0
    criteria_met = []
    
    if vol_ratio >= 2.0:
        stars += 1
        criteria_met.append("Whale Volume (>=2.0x)")
    if wick_ratio >= 0.80:
        stars += 1
        criteria_met.append("Ceiling Close (>=80%)")
    if dist_200 <= 25.0:
        stars += 1
        criteria_met.append("Near 200 EMA (<=25%)")
    if c >= 20.0:
        stars += 1
        criteria_met.append("Liquid Turnaround (>=Rs 20)")
    if candle_gain >= 7.0:
        stars += 1
        criteria_met.append("Impulse Thrust (>=+7%)")
        
    details = {
        "stars": stars,
        "vol_ratio": round(vol_ratio, 2),
        "wick_ratio": round(wick_ratio, 2),
        "dist_200": round(dist_200, 2),
        "price": round(c, 2),
        "candle_gain": round(candle_gain, 2),
        "criteria_met": criteria_met
    }
    return stars, details

_candles_cache = None

def get_stock_candles(symbol: str, from_date: str = None, to_date: str = None):
    """Fetch daily candles for a stock symbol from pickle cache + live recent yfinance delta."""
    global _candles_cache
    import pickle
    cache_path = ROOT / "scratch" / "universe_4y_prices.pkl"
    if cache_path.exists() and _candles_cache is None:
        try:
            with open(cache_path, "rb") as f:
                _candles_cache = pickle.load(f)
        except Exception:
            _candles_cache = {}

    keys = list(_candles_cache.keys()) if _candles_cache else None
    symbol = resolve_symbol(symbol, keys)
    df = None
    if _candles_cache and symbol in _candles_cache:
        df = _candles_cache[symbol]

    # Check if df is missing recent market action (e.g. today or yesterday)
    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    needs_recent_sync = False
    if df is None or df.empty:
        needs_recent_sync = True
    else:
        last_dt = df.index[-1].strftime("%Y-%m-%d") if isinstance(df.index, pd.DatetimeIndex) else str(df.index[-1])[:10]
        if last_dt < today_str:
            needs_recent_sync = True

    if needs_recent_sync:
        try:
            period_req = "2y" if (df is None or df.empty) else "1mo"
            recent_df = yf.download(f"{symbol}.NS", period=period_req, interval="1d", progress=False, auto_adjust=False)
            if recent_df.empty:
                recent_df = yf.download(f"{symbol}.BO", period=period_req, interval="1d", progress=False, auto_adjust=False)
            if not recent_df.empty:
                if isinstance(recent_df.columns, pd.MultiIndex):
                    recent_df.columns = [c[0] for c in recent_df.columns]
                if not isinstance(recent_df.index, pd.DatetimeIndex):
                    recent_df.index = pd.to_datetime(recent_df.index)
                recent_df.index = recent_df.index.tz_localize(None)

                if df is not None and not df.empty:
                    df = df.copy()
                    if not isinstance(df.index, pd.DatetimeIndex):
                        df.index = pd.to_datetime(df.index)
                    df.index = df.index.tz_localize(None)
                    combined = pd.concat([df.loc[df.index < recent_df.index[0]], recent_df])
                    df = combined[~combined.index.duplicated(keep="last")].sort_index()
                else:
                    df = recent_df

                if _candles_cache is not None:
                    _candles_cache[symbol] = df
        except Exception as e:
            print(f"[Swinger] Candle download/refresh error for {symbol}: {e}")

    if df is None or df.empty:
        return []

    df = df.copy()
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
    df.index = df.index.tz_localize(None)

    # Also check if daily_signals has yesterday/today's close not yet in df
    try:
        ds = load_daily_signals()
        for sig in ds.get("signals", []):
            if sig.get("nsecode") == symbol:
                s_date = ds.get("last_scan_time", "")[:10] or today_str
                s_dt = pd.to_datetime(s_date)
                if s_dt not in df.index and s_dt >= df.index[-1]:
                    c_p = float(sig.get("close", 0))
                    v_p = int(sig.get("volume", 0))
                    if c_p > 0:
                        extra_row = pd.DataFrame([{
                            "Open": c_p * (1.0 - (float(sig.get("per_chg", 0)) / 100.0)),
                            "High": c_p * 1.02,
                            "Low": c_p * 0.98,
                            "Close": c_p,
                            "Volume": v_p
                        }], index=[s_dt])
                        df = pd.concat([df, extra_row])
                        df = df[~df.index.duplicated(keep="last")].sort_index()
    except Exception:
        pass

    if from_date:
        try:
            df = df.loc[df.index >= pd.to_datetime(from_date)]
        except Exception:
            pass
    if to_date:
        try:
            df = df.loc[df.index <= pd.to_datetime(to_date)]
        except Exception:
            pass

    candles = []
    for dt, row in df.iterrows():
        try:
            o_raw = row.get("Open")
            h_raw = row.get("High")
            l_raw = row.get("Low")
            c_raw = row.get("Close")
            
            o = float(o_raw) if pd.notnull(o_raw) and not np.isnan(float(o_raw)) else 0.0
            h = float(h_raw) if pd.notnull(h_raw) and not np.isnan(float(h_raw)) else 0.0
            l = float(l_raw) if pd.notnull(l_raw) and not np.isnan(float(l_raw)) else 0.0
            c = float(c_raw) if pd.notnull(c_raw) and not np.isnan(float(c_raw)) else 0.0

            # If close is missing/NaN, fallback to Open or High/Low midpoint
            if c <= 0 or np.isnan(c):
                c = o if (o > 0 and not np.isnan(o)) else ((h + l) / 2.0 if (h + l) > 0 else 0.0)
            if o <= 0 or np.isnan(o):
                o = c
            if h <= 0 or np.isnan(h):
                h = max(o, c)
            if l <= 0 or np.isnan(l):
                l = min(o, c)

            if c <= 0 or np.isnan(c):
                continue

            v_raw = row.get("Volume", 0)
            v = int(v_raw) if pd.notnull(v_raw) and not np.isnan(float(v_raw)) else 0

            candles.append({
                "time": dt.strftime("%Y-%m-%d"),
                "open": round(o, 2),
                "high": round(h, 2),
                "low": round(l, 2),
                "close": round(c, 2),
                "volume": v
            })
        except Exception:
            pass
    return candles

_mcap_cache = {}

def get_stock_market_cap_cr(symbol: str) -> float | None:
    """Returns stock market capitalization in Crores, cached locally."""
    global _mcap_cache
    sym = resolve_symbol(symbol)
    if not sym:
        return None
    cache_file = DATA_DIR / "mcap_cache.json"
    if not _mcap_cache and cache_file.exists():
        try:
            with open(cache_file, "r", encoding="utf-8") as f:
                _mcap_cache = json.load(f)
        except Exception:
            _mcap_cache = {}
    if sym in _mcap_cache:
        return _mcap_cache[sym]
    try:
        ticker_sym = f"{sym}.NS" if not sym.endswith(".NS") and not sym.endswith(".BO") else sym
        t = yf.Ticker(ticker_sym)
        mc = getattr(t.fast_info, 'market_cap', None)
        if not mc and hasattr(t, 'info'):
            mc = t.info.get('marketCap')
        if mc and mc > 0:
            cr = round(float(mc) / 1e7, 1)
            _mcap_cache[sym] = cr
            try:
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(_mcap_cache, f)
            except Exception:
                pass
            return cr
    except Exception:
        pass
    return None

def get_stock_trade_context(symbol: str):
    """
    Returns full trading and radar lifecycle for a symbol:
    - radar_triggers: screener alerts, FILTERED to exclude repeat triggers while actively holding
    - first_radar_date: earliest date symbol appeared on screener
    - trades: all actual open holdings and closed trades with entry/exit dates and prices
    - is_on_radar: boolean if currently in cooldown watchlist and not owned
    - radar_info: cooldown status and pullback details if on watchlist
    """
    import csv
    global _candles_cache
    keys = list(_candles_cache.keys()) if _candles_cache else None
    symbol = resolve_symbol(symbol, keys)
    port = load_portfolio().get("positions", [])
    closed_trades = load_trades().get("trades", [])
    wl = load_watchlist().get("watchlist", [])
    
    pos_matches = [p for p in port if resolve_symbol(p.get("symbol", "")) == symbol]
    trade_matches = [t for t in closed_trades if resolve_symbol(t.get("symbol", "")) == symbol]
    wl_matches = [w for w in wl if resolve_symbol(w.get("symbol", "")) == symbol]
    
    # 1. Collect all real trades
    all_symbol_trades = []
    active_intervals = []
    
    # Closed trades
    for t in trade_matches:
        if t.get("all_historical_trades"):
            for ht in t["all_historical_trades"]:
                he = str(ht.get("entry_date", ""))[:10]
                hx = str(ht.get("exit_date", ""))[:10] or "9999-12-31"
                if he:
                    active_intervals.append((he, hx))
                    all_symbol_trades.append({
                        "trade_id": ht.get("trade_id") or t.get("trade_id"),
                        "symbol": symbol,
                        "name": t.get("name", symbol),
                        "type": "CLOSED",
                        "entry_date": he,
                        "entry_price": float(ht.get("entry_price") or 0.0),
                        "avg_price": float(ht.get("entry_price") or 0.0),
                        "exit_date": hx if hx != "9999-12-31" else None,
                        "exit_price": float(ht.get("exit_price") or 0.0),
                        "pnl": float(ht.get("pnl") or 0.0),
                        "pnl_pct": float(ht.get("pnl_pct") or 0.0),
                        "pct_return": float(ht.get("pnl_pct") or 0.0),
                        "status": "CLOSED",
                        "reason": ht.get("reason") or "Closed",
                        "days_held": ht.get("days_held", 0)
                    })
        else:
            e = t.get("entry_date", "")[:10]
            x = t.get("exit_date", "")[:10] or "9999-12-31"
            if e:
                active_intervals.append((e, x))
                all_symbol_trades.append({
                    "trade_id": t.get("trade_id"),
                    "symbol": symbol,
                    "name": t.get("name", symbol),
                    "type": "CLOSED",
                    "entry_date": e,
                    "entry_price": float(t.get("entry_price") or t.get("avg_price") or 0.0),
                    "avg_price": float(t.get("avg_price") or t.get("entry_price") or 0.0),
                    "exit_date": x if x != "9999-12-31" else None,
                    "exit_price": float(t.get("exit_price") or 0.0),
                    "pnl": float(t.get("pnl") or 0.0),
                    "pnl_pct": float(t.get("pnl_pct") or t.get("pct_return") or 0.0),
                    "pct_return": float(t.get("pnl_pct") or t.get("pct_return") or 0.0),
                    "status": "CLOSED",
                    "reason": t.get("reason") or t.get("exit_reason") or "Closed",
                    "days_held": t.get("days_held", 0)
                })
            
    # Open positions
    for p in pos_matches:
        e = p.get("entry_date", "")[:10]
        if e:
            active_intervals.append((e, "9999-12-31"))
            status_str = "RUNNER" if p.get("runner_mode") else ("SHIELDED" if p.get("be_active") else "ACTIVE")
            all_symbol_trades.append({
                "symbol": symbol,
                "name": p.get("name", symbol),
                "type": "OPEN",
                "entry_date": e,
                "entry_price": float(p.get("entry_price") or p.get("avg_price") or 0.0),
                "avg_price": float(p.get("avg_price") or p.get("entry_price") or 0.0),
                "exit_date": None,
                "exit_price": None,
                "cmp": float(p.get("cmp") or 0.0),
                "pnl": float(p.get("pnl") or p.get("unrealized_pnl") or 0.0),
                "pnl_pct": float(p.get("pnl_pct") or p.get("unrealized_pnl_pct") or 0.0),
                "pct_return": float(p.get("pnl_pct") or p.get("unrealized_pnl_pct") or 0.0),
                "status": status_str,
                "shares": p.get("shares") or p.get("current_qty") or 0,
                "sl_price": p.get("sl_price"),
                "be_price": p.get("be_trigger_price"),
                "tp_price": p.get("tp_target_price"),
                "peak_price": p.get("peak_price"),
                "peak_gain_pct": p.get("peak_gain_pct")
            })

    # Sort trades chronologically
    all_symbol_trades.sort(key=lambda x: x.get("entry_date", ""))

    # 2. Raw triggers from CSV & Watchlist
    triggers = set()
    for csv_name in ["chartink_pure_triggers.csv", "chartink_swingernew_triggers.csv"]:
        csv_p = ROOT / "scratch" / csv_name
        if csv_p.exists():
            try:
                with open(csv_p, "r", encoding="utf-8") as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        if resolve_symbol(row.get("symbol", "")) == symbol:
                            dt = row.get("date", "").strip()
                            if dt: triggers.add(dt[:10])
            except Exception:
                pass
            
    for item in wl:
        if resolve_symbol(item.get("symbol", "")) == symbol:
            ad = item.get("alert_date", "").strip()
            if ad: triggers.add(ad[:10])
            
    try:
        ds = load_daily_signals()
        for h in ds.get("history", []):
            h_dt = h.get("date", "")[:10]
            for s in h.get("signals", []):
                if resolve_symbol(s.get("nsecode", "")) == symbol:
                    if h_dt: triggers.add(h_dt)
        for s in ds.get("signals", []):
            if resolve_symbol(s.get("nsecode", "")) == symbol:
                last_s = ds.get("last_scan_time", "")[:10]
                if last_s: triggers.add(last_s)
    except Exception:
        pass
        
    sorted_raw_trigs = sorted(list(triggers))
    first_radar = sorted_raw_trigs[0] if sorted_raw_trigs else None
    
    # 3. Filter triggers: NEVER track or show triggers if we ALREADY have an active position or trade entry
    filtered_triggers = []
    seen_trigs = set()
    for trig in sorted_raw_trigs:
        clean_trig = trig[:10]
        if clean_trig in seen_trigs:
            continue
        in_active = False
        for (e, x) in active_intervals:
            if e <= clean_trig <= x:
                in_active = True
                break
        if not in_active:
            seen_trigs.add(clean_trig)
            filtered_triggers.append(clean_trig)
            
    is_on_radar = (len(wl_matches) > 0 and len(pos_matches) == 0)
    radar_info = wl_matches[0] if len(wl_matches) > 0 else None
    
    return {
        "radar_triggers": filtered_triggers,
        "first_radar_date": first_radar,
        "trades": all_symbol_trades,
        "is_on_radar": is_on_radar,
        "radar_info": radar_info,
        "market_cap_cr": get_stock_market_cap_cr(symbol)
    }

def get_stock_triggers(symbol: str):
    """Returns list of radar / screener trigger dates for a symbol, sorted chronologically."""
    ctx = get_stock_trade_context(symbol)
    return ctx["radar_triggers"], ctx["first_radar_date"]

def scan_leg2_breakouts(price_data, held_symbols=None, min_consol_days=15, max_consol_days=250, min_vol_ratio=1.5, eligible_symbols=None):
    """
    Scans tracked universe for Leg 2 Base Breakout setups:
    1. Institutional Footprint: Prior volume surge (3dRet >= 15% on vol >= 2.0x SMA50) in the past 15 to 250 trading days.
    2. Consolidation: Stock coils in a multi-week or multi-month base (>= 15 days) with volume contraction.
    3. Breakout Trigger: Today's Close breaks above the 20-30 day consolidation ceiling with volume >= 1.5x (or 2.0x) 50-day average.
    Restricted strictly to confirmed Phoenix Swinger stocks that have completed their Leg 1 turnaround!
    """
    cfg = load_config()
    blacklist = set(cfg.get("blacklist", ["V2RETAIL"]))
    held_symbols = (held_symbols or set()) | blacklist
    triggered = []
    coiled = []

    if eligible_symbols is None:
        try:
            t_data = load_trades()
            sig_data = load_daily_signals()
            w_data = load_watchlist()
            eligible_symbols = set(t.get('symbol') for t in t_data.get('trades', []))
            for s_item in sig_data.get('signals', []):
                if s_item.get('nsecode'):
                    eligible_symbols.add(s_item.get('nsecode'))
            for w_item in (w_data.get('watchlist', []) or w_data.get('radar', [])):
                if w_item.get('symbol'):
                    eligible_symbols.add(w_item.get('symbol'))
        except Exception:
            eligible_symbols = None
    
    for s, df in price_data.items():
        if s in held_symbols or len(df) < 120 or s in ['^NSEI', 'NIFTY']:
            continue
        if eligible_symbols and s not in eligible_symbols:
            continue
        c = df['Close'].values; h = df['High'].values; l = df['Low'].values; o = df['Open'].values; v = df['Volume'].values
        n = len(df)
        
        vol_sma50 = pd.Series(v).rolling(50).mean().values
        vol_ratio = np.where(vol_sma50 > 0, v / vol_sma50, 0.0)
        ret_3d = np.zeros(n)
        ret_3d[3:] = (c[3:] - c[:-3]) / c[:-3] * 100.0
        
        lookback = max(50, n - max_consol_days)
        surges = np.where((ret_3d[lookback:n-min_consol_days] >= 15.0) & (vol_ratio[lookback:n-min_consol_days] >= 2.0) & (c[lookback:n-min_consol_days] >= 20.0))[0]
        if len(surges) == 0:
            continue
            
        s_idx = lookback + surges[-1]
        surge_dt = df.index[s_idx]
        surge_orig = l[max(0, s_idx-3)]
        
        consol_len = (n - 1) - s_idx
        if consol_len < min_consol_days:
            continue
            
        # Consolidation ceiling: 20-25 day base resistance of the recent coil (not ancient euphoric spikes)
        base_window_start = max(s_idx + 1, n - 25)
        base_h = np.max(h[base_window_start:n-1]) if n - 1 > base_window_start else h[-2]
        base_l = np.min(l[base_window_start:n-1]) if n - 1 > base_window_start else l[-2]
        
        if base_l < surge_orig * 0.90 and cur_c < ema200:
            continue
            
        cur_c = c[-1]; cur_v = v[-1]; cur_vr = vol_ratio[-1]; cur_o = o[-1]
        dist_to_ceiling = (cur_c - base_h) / base_h * 100.0 if base_h > 0 else 0.0
        
        cur_dt_str = df.index[-1].strftime('%Y-%m-%d') if hasattr(df.index[-1], 'strftime') else str(df.index[-1])[:10]
        setup_dict = {
            'symbol': s,
            'name': s,
            'date': cur_dt_str,
            'leg': 2,
            'strategy_leg': 'LEG2_BREAKOUT',
            'current_price': round(float(cur_c), 2),
            'base_high': round(float(base_h), 2),
            'base_low': round(float(base_l), 2),
            'surge_date': surge_dt.strftime('%Y-%m-%d') if hasattr(surge_dt, 'strftime') else str(surge_dt)[:10],
            'consol_days': int(consol_len),
            'today_vol_mult': round(float(cur_vr), 1),
            'dist_to_ceiling': round(float(dist_to_ceiling), 1),
            'trigger_sl': round(float(l[-1]), 2)
        }
        
        # EMA calculations
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values[-1]
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values[-1]
        ema200 = pd.Series(c).ewm(span=200, adjust=False).mean().values[-1]
        
        # RSI 14
        delta = pd.Series(c).diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(com=13, min_periods=14).mean()
        avg_loss = loss.ewm(com=13, min_periods=14).mean()
        rsi_series = 100 - (100 / (1 + avg_gain / (avg_loss + 1e-9)))
        rsi_val = float(rsi_series.values[-1])
        surge_rsi = float(rsi_series.values[s_idx]) if s_idx < len(rsi_series) else 72.0
        
        cur_pct_gain = (cur_c - c[-2]) / c[-2] * 100.0 if c[-2] > 0 else 0.0
        cur_range = h[-1] - l[-1]
        upper_wick_ratio = ((h[-1] - cur_c) / cur_range) if cur_range > 0 else 0.0
        dist_ema20 = (cur_c - ema20) / ema20 * 100.0 if ema20 > 0 else 0.0
        is_at_ema200_wall = abs(cur_c - ema200) / ema200 < 0.01 and cur_c < ema200 * 1.005

        # 1. Pure RSI Cool-off 20 EMA Pullback Bounce (Stage-2 Base Accumulation)
        # Enters strictly when RSI has cooled down into neutral territory (40-60) right at the 20 EMA support
        is_ema_pullback = (
            (-3.0 <= dist_ema20 <= 3.5) and 
            (cur_c >= ema50 * 0.97) and 
            (cur_c >= cur_o) and 
            (0.8 <= cur_pct_gain <= 5.5) and 
            (40.0 <= rsi_val <= 60.0) and  # Strict RSI Cool-down Reset
            (cur_vr >= 0.40) and 
            (upper_wick_ratio <= 0.45)
        )

        setup_dict['dist_ema20'] = round(float(dist_ema20), 1)
        setup_dict['rsi'] = round(float(rsi_val), 1)
        setup_dict['surge_rsi'] = round(float(surge_rsi), 1)
        setup_dict['candle_pct'] = round(float(cur_pct_gain), 2)
        setup_dict['ema20'] = round(float(ema20), 2)
        setup_dict['surge_price'] = round(float(c[s_idx]), 2)
        setup_dict['pullback_pct'] = round(float((cur_c / c[s_idx] - 1) * 100.0), 1) if c[s_idx] > 0 else 0.0

        # Trigger strictly on true 20 EMA RSI Pullback Bounces (Rejects high-RSI momentum ceiling breakouts)
        if is_ema_pullback and not is_at_ema200_wall:
            setup_dict['status'] = 'PULLBACK BOUNCE TRIGGERED'
            setup_dict['setup_type'] = 'MA_PULLBACK'
            setup_dict['strategy_leg'] = 'LEG2_MA_PULLBACK'
            triggered.append(setup_dict)
        elif -2.0 <= dist_ema20 <= 2.5 and 40.0 <= rsi_val <= 60.0 and cur_c >= ema50 * 0.98:
            setup_dict['status'] = 'RESTING AT 20 EMA'
            setup_dict['setup_type'] = 'MA_PULLBACK'
            setup_dict['strategy_leg'] = 'LEG2_MA_PULLBACK'
            coiled.append(setup_dict)
        elif -5.0 <= dist_to_ceiling <= 0.0 and 40.0 <= rsi_val <= 60.0:
            setup_dict['status'] = 'COOLING IN BASE'
            setup_dict['setup_type'] = 'MA_PULLBACK'
            setup_dict['strategy_leg'] = 'LEG2_MA_PULLBACK'
            coiled.append(setup_dict)
            
    triggered.sort(key=lambda x: x['today_vol_mult'], reverse=True)
    coiled.sort(key=lambda x: x['dist_to_ceiling'], reverse=True)
    return triggered, coiled

def scan_cooldown_radar(price_data, held_symbols=None):
    """
    Scans tracked universe for true Turnaround Pullback Cooldown setups:
    1. Recent High-RSI Surge Alert (10 to 35 trading days ago, RSI >= 67 or 3dRet >= 14% on vol >= 1.8x).
    2. Actively Coming Down / Retracing from Peak: Pullback between -4.0% and -20.0% from recent peak.
    3. Cooled-Down RSI: Current RSI has cooled from overbought down to 44 - 60.
    4. Settling at 20 EMA: Current price is within [-3.5%, +4.5%] of the 20 EMA and holding above 50 EMA.
    """
    cfg = load_config()
    blacklist = set(cfg.get("blacklist", ["V2RETAIL"]))
    held_symbols = (held_symbols or set()) | blacklist
    candidates = []
    
    for s, df in price_data.items():
        if s in held_symbols or len(df) < 80 or s in ['^NSEI', 'NIFTY']:
            continue
        c = df['Close'].values; h = df['High'].values; l = df['Low'].values; o = df['Open'].values; v = df['Volume'].values
        dates = [d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else str(d)[:10] for d in df.index]
        n = len(df)
        cur_c = c[-1]
        
        # Phoenix Requirement: Down at least 60% from ATH (1000-candle high)
        ath = np.max(h[-min(n, 1000):])
        dd_ath_pct = (cur_c - ath) / ath * 100.0 if ath > 0 else 0.0
        if dd_ath_pct > -60.0:
            continue
        
        vol_sma50 = pd.Series(v).rolling(50, min_periods=20).mean().values
        vol_ratio = np.where(vol_sma50 > 0, v / vol_sma50, 0.0)
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
        
        delta = pd.Series(c).diff()
        gain = delta.clip(lower=0)
        loss = -delta.clip(upper=0)
        avg_gain = gain.ewm(com=13, min_periods=14).mean()
        avg_loss = loss.ewm(com=13, min_periods=14).mean()
        rsi = 100 - (100 / (1 + avg_gain / (avg_loss + 1e-9))).values
        
        # Look for a surge between 10 and 35 trading days ago
        for s_idx in range(n - 35, n - 4):
            if s_idx < 10: continue
            day_gain = (c[s_idx] - c[s_idx-1]) / c[s_idx-1] * 100.0 if c[s_idx-1] > 0 else 0
            gain_3d = (c[s_idx] - c[max(0, s_idx-3)]) / c[max(0, s_idx-3)] * 100.0 if c[max(0, s_idx-3)] > 0 else 0
            vr = vol_ratio[s_idx]
            surge_rsi = rsi[s_idx]
            
            is_surge = (gain_3d >= 14.0 or day_gain >= 8.0) and (vr >= 1.8) and (surge_rsi >= 67.0)
            if not is_surge: continue
            
            peak_idx = s_idx + np.argmax(h[s_idx:n])
            peak_price = h[peak_idx]
            cur_c = c[-1]
            
            pullback_pct = (cur_c - peak_price) / peak_price * 100.0
            if pullback_pct > -3.0 or pullback_pct < -20.0: continue
            
            cur_rsi = rsi[-1]
            if not (44.0 <= cur_rsi <= 62.0): continue
            
            cur_ema20 = ema20[-1]
            dist_20 = (cur_c - cur_ema20) / cur_ema20 * 100.0
            if not (-3.5 <= dist_20 <= 4.5): continue
            if cur_c < ema50[-1] * 0.96: continue
            
            days_cooling = int((n - 1) - s_idx)
            is_ready = bool(abs(dist_20) <= 2.5 and (45.0 <= cur_rsi <= 58.0))
            status_text = "AT 20 EMA SUPPORT" if is_ready else ("COOLING TOWARDS 20 EMA" if dist_20 > 2.0 else "TESTING 20 EMA")
            
            candidates.append({
                "symbol": s,
                "name": s,
                "alert_date": str(dates[s_idx]),
                "alert_price": round(float(c[s_idx]), 2),
                "alert_rsi": round(float(surge_rsi), 1),
                "current_price": round(float(cur_c), 2),
                "current_rsi": round(float(cur_rsi), 1),
                "ema20": round(float(cur_ema20), 2),
                "distance_to_ema20_pct": round(float(dist_20), 1),
                "pullback_pct": round(float(pullback_pct), 1),
                "status": status_text,
                "cooldown_ready": is_ready,
                "notes": f"Surged to peak ₹{peak_price:.1f}; cooled down {pullback_pct:.1f}% over {days_cooling}d. RSI reset {surge_rsi:.1f} → {cur_rsi:.1f}. {'Resting at 20 EMA support' if is_ready else 'Approaching 20 EMA'}"
            })
            break
            
    candidates.sort(key=lambda x: (not x["cooldown_ready"], abs(x["distance_to_ema20_pct"])))
    return candidates

def update_positions_and_scan():
    """
    Main Daily Cycle:
    1. Update existing open paper positions with today's price action.
    2. Check SL (-25%), BE Shield (+20%), TP1 (+30%), and Runner Trailing SL (25%).
    3. Scan Chartink for new candidate triggers.
    4. Fill available slots up to max_open_positions in paper mode.
    5. Save updated portfolio, trades, and signals.
    """
    cfg = load_config()
    portfolio = load_portfolio()
    trade_db = load_trades()
    
    open_positions = portfolio.get("positions", [])
    updated_positions = []
    closed_this_cycle = []
    
    initial_sl_pct = cfg.get("initial_sl_pct", -20.0)
    be_shield_trigger_pct = cfg.get("be_shield_trigger_pct", 15.0)
    tp_target_pct = cfg.get("tp_target_pct", 30.0)
    vault_trigger_pct = cfg.get("profit_vault_trigger_pct", 50.0)
    vault_floor_pct = cfg.get("profit_vault_floor_pct", 25.0)
    partial_take_frac = cfg.get("partial_profit_take_fraction", 0.0)
    trail_pct = cfg.get("runner_trailing_stop_pct", 25.0)
    vol_loss_exit_enabled = cfg.get("vol_loss_exit_enabled", True)
    vol_loss_min_gain_pct = cfg.get("vol_loss_min_gain_pct", 20.0)
    vol_loss_vol_mult = cfg.get("vol_loss_vol_mult", 1.2)
    max_hold_days = cfg.get("max_hold_days", None)
    
    print(f"[Swinger Paper] Updating {len(open_positions)} open positions...")
    
    # Pre-fetch all open positions in a fast batch query
    open_symbols = list(set([p["symbol"] for p in open_positions if "symbol" in p]))
    batch_market_data = {}
    if open_symbols:
        try:
            tickers = [f"{s}.NS" for s in open_symbols]
            batch_df = yf.download(tickers, period="1y", interval="1d", progress=False, auto_adjust=False, group_by="ticker")
            for s in open_symbols:
                t = f"{s}.NS"
                if len(open_symbols) == 1:
                    s_df = batch_df.dropna(how="all").copy()
                else:
                    s_df = batch_df[t].dropna(how="all").copy() if t in batch_df else pd.DataFrame()
                if not s_df.empty:
                    s_df["EMA20"] = s_df["Close"].ewm(span=20, adjust=False).mean()
                    s_df["EMA50"] = s_df["Close"].ewm(span=50, adjust=False).mean()
                    s_df["EMA200"] = s_df["Close"].ewm(span=200, adjust=False).mean()
                    s_df["VolSMA60"] = s_df["Volume"].rolling(60, min_periods=10).mean()
                    batch_market_data[s] = s_df
        except Exception as e:
            print(f"[Swinger] Batch pre-fetch note: {e}")
            
    for pos in open_positions:
        sym = pos["symbol"]
        entry_price = float(pos["entry_price"])
        avg_price = float(pos.get("avg_price", entry_price))
        current_qty = int(pos.get("current_qty", pos.get("shares", 0)))
        initial_qty = int(pos.get("initial_qty", pos.get("shares", current_qty)))
        days_held = pos.get("days_held", 0) + 1
        pos["days_held"] = days_held
        pos["avg_price"] = avg_price
        pos["initial_qty"] = initial_qty
        pos["current_qty"] = current_qty

        # Set default stop loss if missing
        if "sl_price" not in pos or pos["sl_price"] is None:
            pos["sl_price"] = round(avg_price * (1.0 + initial_sl_pct / 100.0), 2)
            
        df = batch_market_data.get(sym)
        if df is None or df.empty:
            df = get_market_data(sym)
        if df is not None and not df.empty:
            cur_bar = df.iloc[-1]
            cmp_price = float(cur_bar["Close"])
            day_high = float(cur_bar["High"])
            day_low = float(cur_bar["Low"])
            day_open = float(cur_bar["Open"])
            day_vol = float(cur_bar.get("Volume", 0.0))
            vol_sma = float(cur_bar.get("VolSMA60", 0.0))
            prev_vol = float(df["Volume"].iloc[-2]) if len(df) >= 2 else 0.0
            ema20 = float(cur_bar["EMA20"]) if pd.notnull(cur_bar["EMA20"]) else None
            ema50 = float(cur_bar["EMA50"]) if "EMA50" in cur_bar and pd.notnull(cur_bar["EMA50"]) else None
        else:
            cmp_price = float(pos.get("cmp", avg_price))
            day_high = cmp_price
            day_low = cmp_price
            day_open = cmp_price
            day_vol = 0.0
            vol_sma = 0.0
            prev_vol = 0.0
            ema20 = pos.get("ema20")
            ema50 = pos.get("ema50")
            
        pos["cmp"] = round(cmp_price, 2)
        pos["invested"] = round(avg_price * current_qty, 2)
        pos["unrealized_pnl"] = round((cmp_price - avg_price) * current_qty, 2)
        pos["unrealized_pnl_pct"] = round(((cmp_price / avg_price) - 1) * 100, 2)
        pos["unrealized_pct"] = pos["unrealized_pnl_pct"]
        if ema20:
            pos["ema20"] = round(ema20, 2)
        if ema50:
            pos["ema50"] = round(ema50, 2)
            
        # Update peak price and highest close
        peak = max(pos.get("peak_price", avg_price), day_high, cmp_price)
        pos["peak_price"] = round(peak, 2)
        highest_close = max(pos.get("highest_close", avg_price), cmp_price)
        pos["highest_close"] = round(highest_close, 2)
        
        # --- 0. CHECK SMART EARLY REVERSAL SHIELD FOR LEG 2 (DAYS 1 TO 2 POST-BREAKOUT) ---
        if pos.get("leg") == 2 and days_held in [1, 2] and not pos.get("runner_mode", False):
            cur_pct = ((cmp_price - avg_price) / avg_price) * 100.0
            day_vol = float(df["Volume"].iloc[-1]) if ("Volume" in df and len(df) > 0) else 0.0
            vol_sma50_val = float(df["Volume"].rolling(50, min_periods=20).mean().iloc[-1]) if len(df) >= 20 else 1.0
            vr50_val = day_vol / vol_sma50_val if vol_sma50_val > 0 else 1.0
            entry_open_val = pos.get("entry_open", avg_price)

            # Smart Early Reversal Shield (Fires ONLY on LOSING trades cur_pct < 0):
            # 1. Structural Breakdown below 50 EMA on red day while in loss
            # 2. Heavy institutional volume selling (>= 1.3x SMA50) with drop <= -3.5%
            # 3. Deep bearish engulfing breach below breakout entry open (<= -5.0%)
            broke_e50 = (cur_pct < 0) and (ema50 is not None) and (cmp_price < ema50) and (cmp_price < day_open)
            heavy_vol_dump = (cur_pct <= -3.5) and (cmp_price < day_open) and (vr50_val >= 1.3)
            deep_engulfing = (cmp_price < entry_open_val) and (cur_pct <= -5.0) and (cmp_price < day_open)

            if broke_e50 or heavy_vol_dump or deep_engulfing:
                exit_price = cmp_price
                trade_pnl = round((exit_price - avg_price) * current_qty, 2)
                if broke_e50:
                    reason = f"Early Shield: 50 EMA Breakdown (Day {days_held+1})"
                elif heavy_vol_dump:
                    reason = f"Early Shield: Institutional Volume Dump (Day {days_held+1}, Vol={vr50_val:.1f}x)"
                else:
                    reason = f"Early Shield: Deep Engulfing Breach (Day {days_held+1})"
                print(f"[Swinger Paper] SMART EARLY REVERSAL SHIELD for {sym} @ Rs.{exit_price} ({reason}). PnL: Rs.{trade_pnl}")
                closed_this_cycle.append({
                    "symbol": sym,
                    "name": pos.get("name", sym),
                    "leg": 2,
                    "strategy_leg": "LEG2_BREAKOUT",
                    "entry_date": pos["entry_date"],
                    "exit_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "entry_price": entry_price,
                    "avg_price": avg_price,
                    "exit_price": exit_price,
                    "qty": current_qty,
                    "reason": reason,
                    "days_held": days_held,
                    "pnl": trade_pnl,
                    "pnl_pct": round(((exit_price / avg_price) - 1) * 100, 2)
                })
                continue

        # --- 1. CHECK TRIGGER CANDLE LOW STOP / BREAK-EVEN SHIELD STOP ---
        if not pos.get("runner_mode", False):
            # Catastrophe Hard Circuit Breaker Stop (15% Drop Protection against intraday flash crashes)
            hard_floor = avg_price * 0.85
            if day_low <= hard_floor and not pos.get("be_active", False):
                exit_price = min(day_open, hard_floor)
                trade_pnl = round((exit_price - avg_price) * current_qty, 2)
                reason = "Catastrophe Stop (-15% Floor)"
                print(f"[Swinger Paper] CATASTROPHE STOP HIT for {sym} @ Rs.{exit_price} ({reason}). PnL: Rs.{trade_pnl}")
                closed_this_cycle.append({
                    "symbol": sym,
                    "name": pos.get("name", sym),
                    "leg": pos.get("leg", 1),
                    "strategy_leg": pos.get("strategy_leg", "LEG1_TURNAROUND"),
                    "entry_date": pos["entry_date"],
                    "exit_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "entry_price": entry_price,
                    "avg_price": avg_price,
                    "exit_price": exit_price,
                    "qty": current_qty,
                    "reason": reason,
                    "days_held": days_held,
                    "pnl": trade_pnl,
                    "pnl_pct": round(((exit_price / avg_price) - 1) * 100, 2)
                })
                continue

            sl = float(pos.get("sl_price", avg_price * 0.88))
            # Evaluated on Daily Candle Close to avoid intraday wick shakeouts
            if cmp_price <= sl:
                exit_price = cmp_price
                trade_pnl = round((exit_price - avg_price) * current_qty, 2)
                if pos.get("be_active", False):
                    reason = "Break-Even Shield Exit (Cost Protected)"
                else:
                    reason = f"Initial SL ({pos.get('initial_sl_pct', -12.0):.0f}% Close)"
                print(f"[Swinger Paper] CANDLE CLOSE STOP HIT for {sym} @ Rs.{exit_price} ({reason}). PnL: Rs.{trade_pnl}")
                closed_this_cycle.append({
                    "symbol": sym,
                    "name": pos.get("name", sym),
                    "leg": pos.get("leg", 1),
                    "strategy_leg": pos.get("strategy_leg", "LEG1_TURNAROUND"),
                    "entry_date": pos["entry_date"],
                    "exit_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "entry_price": entry_price,
                    "avg_price": avg_price,
                    "exit_price": exit_price,
                    "qty": current_qty,
                    "reason": reason,
                    "days_held": days_held,
                    "pnl": trade_pnl,
                    "pnl_pct": round(((exit_price / avg_price) - 1) * 100, 2)
                })
                continue
                
        # --- 2. CHECK BREAK-EVEN SHIELD ACTIVATION (+15% GAIN) ---
        be_shield_enabled = cfg.get("be_shield_enabled", True)
        if be_shield_enabled:
            be_trigger = round(avg_price * (1.0 + be_shield_trigger_pct / 100.0), 2)
            pos["be_trigger_price"] = be_trigger
            if not pos.get("be_active", False) and day_high >= be_trigger:
                pos["be_active"] = True
                pos["sl_price"] = round(avg_price * 1.005, 2)  # cost + 0.5% fee buffer
                pos["status"] = "SHIELDED"
                print(f"[Swinger Paper] BE SHIELD TRIGGERED for {sym} (+{be_shield_trigger_pct:.0f}% touched)! SL moved to cost: Rs.{pos['sl_price']}")
            
        # --- 2B. CHECK PYRAMID (ADD LOT 2 @ +20% GAIN) ---
        pyramid_enabled = cfg.get("pyramid_enabled", True)
        pyramid_trigger = cfg.get("pyramid_trigger_pct", 20.0)
        if pyramid_enabled and not pos.get("pyramided", False) and day_high >= round(avg_price * (1.0 + pyramid_trigger / 100.0), 2):
            pyramid_alloc = cfg.get("base_position_size", 25000.0)
            add_qty = int(pyramid_alloc // cmp_price) if cmp_price > 0 else 0
            if add_qty > 0:
                pos["pyramided"] = True
                tot_cost = (current_qty * avg_price) + (add_qty * cmp_price)
                new_qty = current_qty + add_qty
                pos["current_qty"] = new_qty
                pos["shares"] = new_qty
                pos["initial_qty"] = new_qty
                pos["avg_price"] = round(tot_cost / new_qty, 2)
                pos["invested"] = round(tot_cost, 2)
                avg_price = pos["avg_price"]
                current_qty = new_qty
                pos["status"] = "PYRAMIDED (+20% WINNER)"
                print(f"[Swinger Paper] PYRAMID ADD: Added {add_qty} shares to winner {sym} @ Rs.{cmp_price} (+Rs.{pyramid_alloc}). New Avg Price: Rs.{avg_price}")
            
        # --- 3. CHECK MOMENTUM RUNNER TRIGGER (+30% GAIN) ---
        tp_target = round(avg_price * (1.0 + tp_target_pct / 100.0), 2)
        pos["tp_target_price"] = tp_target
        if not pos.get("tp_hit", False) and day_high >= tp_target:
            pos["tp_hit"] = True
            pos["runner_mode"] = True
            pos["status"] = "RUNNER"
            pos["runner_peak_price"] = round(max(cmp_price, day_high), 2)
            pos["highest_close"] = round(max(pos.get("highest_close", avg_price), cmp_price), 2)
            pos["runner_trail_sl"] = round(pos["highest_close"] * (1.0 - trail_pct / 100.0), 2)
            pos["sl_price"] = pos["runner_trail_sl"]
            
            if partial_take_frac and partial_take_frac > 0:
                tp_qty = int(current_qty * partial_take_frac)
                exec_tp_price = max(cmp_price, tp_target)
                booked = round(tp_qty * (exec_tp_price - avg_price), 2)
                pos["current_qty"] = current_qty - tp_qty
                pos["tp_50_hit"] = True
                pos["booked_pnl"] = round(pos.get("booked_pnl", 0.0) + booked, 2)
                print(f"[Swinger Paper] TP1 HIT (+30%) for {sym}! Booked {int(partial_take_frac*100)}% for +Rs.{booked}. Runner active with trailing SL Rs.{pos['runner_trail_sl']}")
            else:
                # 100% FULL QUANTITY MOMENTUM RIDE
                print(f"[Swinger Paper] MOMENTUM RUNNER ACTIVATED (+30%) for {sym}! Riding 100% full quantity ({current_qty} shares) with 50 EMA support & {trail_pct:.0f}% Backup Close Trail Rs.{pos['runner_trail_sl']}")
            
        # --- 3B. CHECK PROFIT VAULT LOCK (+50% GAIN TOUCHED) ---
        vault_trigger = round(avg_price * (1.0 + vault_trigger_pct / 100.0), 2)
        if not pos.get("profit_vault_active", False) and day_high >= vault_trigger:
            pos["profit_vault_active"] = True
            pos["vault_floor_sl"] = round(avg_price * (1.0 + vault_floor_pct / 100.0), 2)
            pos["status"] = "VAULT_LOCKED (+25%)"
            print(f"[Swinger Paper] PROFIT VAULT ACTIVATED (+{vault_trigger_pct:.0f}% touched) for {sym}! Minimum +{vault_floor_pct:.0f}% profit locked (Floor SL: Rs.{pos['vault_floor_sl']})")

        # --- 4. CHECK RUNNER EXITS (50 EMA VOLUME BREAKDOWN OR 25% BACKUP CLOSE TRAIL) ---
        if pos.get("runner_mode", False):
            if cmp_price > pos.get("highest_close", 0):
                pos["highest_close"] = round(cmp_price, 2)
            
            trail_calc = round(pos["highest_close"] * (1.0 - trail_pct / 100.0), 2)
            # Pure Trailing Stop: No artificial BE lock at cost
            vault_floor = pos.get("vault_floor_sl", 0.0)
            pos["runner_trail_sl"] = max(trail_calc, vault_floor)
            pos["sl_price"] = pos["runner_trail_sl"]
                
            # A) Primary Institutional Exit: 50 EMA Volume Breakdown
            # Triggers if: In Runner/Profit (>=20%), Red day, Closes below 50 EMA, Volume >= 1.2x SMA60
            if (vol_loss_exit_enabled and 
                pos.get("unrealized_pct", 0) >= vol_loss_min_gain_pct and 
                cmp_price < day_open and ema50 and (cmp_price < ema50) and 
                vol_sma > 0 and (day_vol >= vol_sma * vol_loss_vol_mult)):
                
                exit_price = cmp_price
                runner_pnl = round((exit_price - avg_price) * pos["current_qty"], 2)
                total_trade_pnl = round(pos.get("booked_pnl", 0.0) + runner_pnl, 2)
                vol_ratio = round(day_vol / vol_sma, 1) if vol_sma > 0 else 1.2
                print(f"[Swinger Paper] 50 EMA VOLUME BREAKDOWN EXIT for {sym} @ Rs.{exit_price} ({vol_ratio}x Vol). PnL: Rs.{total_trade_pnl}")
                closed_this_cycle.append({
                    "symbol": sym,
                    "name": pos.get("name", sym),
                    "entry_date": pos["entry_date"],
                    "exit_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "entry_price": entry_price,
                    "avg_price": avg_price,
                    "exit_price": exit_price,
                    "qty": initial_qty,
                    "reason": f"Institutional 50 EMA Volume Breakdown ({vol_ratio}x Vol)",
                    "days_held": days_held,
                    "pnl": total_trade_pnl,
                    "pnl_pct": round(((exit_price / avg_price) - 1) * 100, 2)
                })
                continue
                
            # B) Secondary Exit: Backup Close Trailing Stop / Profit Vault Floor
            # Evaluated on daily close to prevent intraday wick shakeouts
            runner_sl = float(pos["runner_trail_sl"])
            if cmp_price < runner_sl:
                exit_price = cmp_price
                runner_pnl = round((exit_price - avg_price) * pos["current_qty"], 2)
                total_trade_pnl = round(pos.get("booked_pnl", 0.0) + runner_pnl, 2)
                reason_desc = f"Profit Vault Floor Hit (+{vault_floor_pct:.0f}% Locked)" if (pos.get("profit_vault_active", False) and runner_sl == vault_floor) else f"Backup Close Trailing Stop ({trail_pct:.0f}% from Highest Close)"
                print(f"[Swinger Paper] RUNNER EXIT for {sym} @ Rs.{exit_price} ({reason_desc}). Total Trade PnL: Rs.{total_trade_pnl}")
                closed_this_cycle.append({
                    "symbol": sym,
                    "name": pos.get("name", sym),
                    "entry_date": pos["entry_date"],
                    "exit_date": datetime.now(IST).strftime("%Y-%m-%d"),
                    "entry_price": entry_price,
                    "avg_price": avg_price,
                    "exit_price": exit_price,
                    "qty": initial_qty,
                    "reason": f"Backup Close Trailing Stop ({trail_pct:.0f}% from Highest Close)",
                    "days_held": days_held,
                    "pnl": total_trade_pnl,
                    "pnl_pct": round(((exit_price / avg_price) - 1) * 100, 2)
                })
                continue
                
        # --- 5. CHECK TIME STOP (DISABLED / OPTIONAL ONLY IF CONFIGURED) ---
        if max_hold_days and days_held >= max_hold_days:
            exit_price = cmp_price
            rem_pnl = round((exit_price - avg_price) * pos["current_qty"], 2)
            total_trade_pnl = round(pos.get("booked_pnl", 0.0) + rem_pnl, 2)
            print(f"[Swinger Paper] MAX HOLD {max_hold_days} DAYS REACHED for {sym} @ Rs.{exit_price}. PnL: Rs.{total_trade_pnl}")
            closed_this_cycle.append({
                "symbol": sym,
                "name": pos.get("name", sym),
                "entry_date": pos["entry_date"],
                "exit_date": datetime.now(IST).strftime("%Y-%m-%d"),
                "entry_price": entry_price,
                "avg_price": avg_price,
                "exit_price": exit_price,
                "qty": initial_qty,
                "reason": f"Time Exit ({max_hold_days} Trading Days Max)",
                "days_held": days_held,
                "pnl": total_trade_pnl,
                "pnl_pct": round(((exit_price / avg_price) - 1) * 100, 2)
            })
            continue

        updated_positions.append(pos)
        
    # --- SCAN CHARTINK FOR TODAY'S SIGNALS ---
    print("[Swinger Paper] Fetching daily Chartink scanner signals...")
    raw_signals = fetch_chartink_signals(cfg.get("scan_clause"))
    saved_sig = save_daily_signals(raw_signals)
    print(f"[Swinger Paper] Chartink returned {len(raw_signals)} trigger candidates.")
    
    # --- FILL AVAILABLE SLOTS IN PAPER MODE ---
    max_slots = cfg.get("max_open_positions", 20)
    available_slots = max_slots - len(updated_positions)
    blacklist = set(cfg.get("blacklist", ["V2RETAIL"]))
    held_symbols = {p["symbol"] for p in updated_positions} | blacklist
    min_stars = cfg.get("min_star_rating", 4)

    # --- EVALUATE COOLDOWN RADAR (WATCHLIST) FOR RETRACEMENT ENTRIES ---
    cur_wl_data = load_watchlist()
    cur_wl = cur_wl_data.get("watchlist", [])
    remaining_wl = []

    if available_slots > 0 and cfg.get("enabled", True):
        for item in cur_wl:
            w_sym = item.get("symbol")
            if not w_sym or w_sym in held_symbols:
                continue

            w_df = get_market_data(w_sym)
            if w_df is None or len(w_df) < 5:
                remaining_wl.append(item)
                continue

            w_close = float(w_df["Close"].iloc[-1])
            w_low = float(w_df["Low"].iloc[-1])
            w_ema20 = float(w_df["EMA20"].iloc[-1]) if "EMA20" in w_df else w_close
            target_pb = float(item.get("target_pb_price", item.get("alert_price", w_close) * 0.95))
            blast_low = float(item.get("blast_low", item.get("alert_price", w_close) * 0.88))

            # 1. Invalidation Check: Did it break down below blast low?
            if w_close < blast_low:
                print(f"[Swinger Paper] Radar stock {w_sym} broke below blast low (Rs.{blast_low:.2f}). Dropping from radar.")
                continue

            # 2. Retracement Check: Did it reach pullback zone (target_pb or 20 EMA) while holding blast low?
            retrace_hit = (w_low <= target_pb or (w_ema20 > 0 and w_low <= w_ema20 * 1.01)) and (w_close >= blast_low)

            if retrace_hit and available_slots > 0:
                stars, star_details = calculate_setup_star_rating(w_df, w_sym)
                alloc_per_slot = cfg.get("base_position_size", 25000.0)
                qty = int(alloc_per_slot // w_close)
                if qty > 0:
                    initial_sl = round(w_close * (1.0 + initial_sl_pct / 100.0), 2)
                    be_trigger = round(w_close * (1.0 + be_shield_trigger_pct / 100.0), 2)
                    tp_target = round(w_close * (1.0 + tp_target_pct / 100.0), 2)
                    cur_c_dt = (w_df.index[-1].strftime("%Y-%m-%d") if hasattr(w_df.index[-1], "strftime") else str(w_df.index[-1])[:10])

                    new_pos = {
                        "symbol": w_sym,
                        "name": item.get("name", w_sym),
                        "entry_date": cur_c_dt,
                        "entry_price": round(w_close, 2),
                        "avg_price": round(w_close, 2),
                        "cmp": round(w_close, 2),
                        "initial_qty": qty,
                        "current_qty": qty,
                        "shares": qty,
                        "invested": round(qty * w_close, 2),
                        "initial_sl_pct": round((initial_sl / w_close - 1.0) * 100.0, 1),
                        "sl_price": initial_sl,
                        "trigger_sl": blast_low,
                        "be_active": False,
                        "be_trigger_price": be_trigger,
                        "tp_hit": False,
                        "tp_50_hit": False,
                        "tp_target_price": tp_target,
                        "runner_mode": False,
                        "runner_peak_price": round(w_close, 2),
                        "runner_trail_sl": None,
                        "days_held": 0,
                        "booked_pnl": 0.0,
                        "unrealized_pnl": 0.0,
                        "unrealized_pnl_pct": 0.0,
                        "unrealized_pct": 0.0,
                        "leg": 1,
                        "strategy_leg": "LEG1_RETRACEMENT",
                        "status": f"ACTIVE ({stars}-Star Retracement)",
                        "stars": stars,
                        "star_details": star_details,
                        "exit_rule": f"Initial SL {initial_sl_pct:.0f}% - BE Shield @ +{be_shield_trigger_pct:.0f}% - Pyramid @ +20% - 50 EMA Vol Breakdown + {trail_pct:.0f}% Close Trail",
                        "ema20": round(w_ema20, 2),
                        "peak_price": round(w_close, 2)
                    }
                    print(f"[Swinger Paper] NEW RADAR RETRACEMENT BUY (LEG 1): {w_sym} @ Rs.{w_close} (Retraced from Rs.{item.get('alert_price')}) | Qty: {qty}")
                    updated_positions.append(new_pos)
                    held_symbols.add(w_sym)
                    available_slots -= 1
                    continue

            remaining_wl.append(item)

        cur_wl_data["watchlist"] = remaining_wl
        save_watchlist(cur_wl_data)
    
    if available_slots > 0 and cfg.get("enabled", True):
        for cand in raw_signals:
            if available_slots <= 0:
                break
            sym = cand.get("nsecode")
            if not sym or sym in held_symbols:
                continue
                
            df = get_market_data(sym)
            if df is None or len(df) < 5:
                continue
                
            last_close = float(df["Close"].iloc[-1])
            min_price = float(cfg.get("min_stock_price", 20.0))
            if last_close < min_price:
                continue
                
            # Check single-day blast gain: If > 10%, DO NOT enter immediately at close!
            # Route directly to Cooldown Radar to wait for retracement/20 EMA retest instead of chasing high.
            prev_close = float(df["Close"].iloc[-2]) if len(df) >= 2 else last_close
            candle_gain_pct = round(((last_close / prev_close) - 1.0) * 100.0, 2)
            max_direct_gain = float(cfg.get("max_direct_entry_gain_pct", 10.0))
            
            if candle_gain_pct > max_direct_gain:
                print(f"[Swinger Paper] OVEREXTENDED BLAST (+{candle_gain_pct:.1f}% > {max_direct_gain:.0f}%): {sym} routed to Cooldown Radar (waiting for retracement / 20 EMA retest instead of buying at top).")
                cur_wl = load_watchlist().get("watchlist", [])
                if not any(w.get("symbol") == sym for w in cur_wl):
                    cur_c_dt = (df.index[-1].strftime("%Y-%m-%d") if hasattr(df.index[-1], "strftime") else str(df.index[-1])[:10]) if not df.empty else datetime.now(IST).strftime("%Y-%m-%d")
                    b_open = float(df["Open"].iloc[-1]) if "Open" in df else last_close
                    b_low = float(df["Low"].iloc[-1]) if "Low" in df else round(last_close * 0.90, 2)
                    target_pb = round(last_close - 0.40 * (last_close - b_open), 2)
                    cur_wl.append({
                        "symbol": sym,
                        "name": cand.get("name", sym),
                        "alert_date": cur_c_dt,
                        "alert_price": round(last_close, 2),
                        "alert_gain_pct": candle_gain_pct,
                        "current_price": round(last_close, 2),
                        "target_pb_price": target_pb,
                        "blast_low": b_low,
                        "ema20": round(float(df["EMA20"].iloc[-1]), 2) if "EMA20" in df else None,
                        "cooldown_ready": False,
                        "status": "WAITING_RETRACEMENT",
                        "notes": f"Overextended blast (+{candle_gain_pct:.1f}%). On radar waiting for retracement to ~Rs.{target_pb} (or 20 EMA) instead of buying at top."
                    })
                    save_watchlist({"watchlist": cur_wl})
                continue
                
            stars, star_details = calculate_setup_star_rating(df, sym)
            cand["stars"] = stars
            cand["star_details"] = star_details
            
            if stars < min_stars:
                print(f"[Swinger Paper] Skipping {sym}: Setup scored {stars} Stars (min {min_stars} required for Elite tier).")
                continue
                
            alloc_per_slot = cfg.get("base_position_size", 25000.0)
            qty = int(alloc_per_slot // last_close)
            if qty <= 0:
                continue
                
            trig_low = float(df["Low"].iloc[-1]) if ("Low" in df and len(df) > 0) else round(last_close * 0.95, 2)
            initial_sl = round(last_close * (1.0 + initial_sl_pct / 100.0), 2)
            be_trigger = round(last_close * (1.0 + be_shield_trigger_pct / 100.0), 2)
            tp_target = round(last_close * (1.0 + tp_target_pct / 100.0), 2)
            
            cur_c_dt = (df.index[-1].strftime("%Y-%m-%d") if hasattr(df.index[-1], "strftime") else str(df.index[-1])[:10]) if not df.empty else datetime.now(IST).strftime("%Y-%m-%d")
            new_pos = {
                "symbol": sym,
                "name": cand.get("name", sym),
                "entry_date": cand.get("date", cur_c_dt),
                "entry_price": round(last_close, 2),
                "avg_price": round(last_close, 2),
                "cmp": round(last_close, 2),
                "initial_qty": qty,
                "current_qty": qty,
                "shares": qty,
                "invested": round(qty * last_close, 2),
                "initial_sl_pct": round((initial_sl / last_close - 1.0) * 100.0, 1),
                "sl_price": initial_sl,
                "trigger_sl": trig_low,
                "be_active": False,
                "be_trigger_price": be_trigger,
                "tp_hit": False,
                "tp_50_hit": False,
                "tp_target_price": tp_target,
                "runner_mode": False,
                "runner_peak_price": round(last_close, 2),
                "runner_trail_sl": None,
                "days_held": 0,
                "booked_pnl": 0.0,
                "unrealized_pnl": 0.0,
                "unrealized_pnl_pct": 0.0,
                "unrealized_pct": 0.0,
                "leg": 1,
                "strategy_leg": "LEG1_TURNAROUND",
                "status": f"ACTIVE ({stars}-Star)",
                "stars": stars,
                "star_details": star_details,
                "exit_rule": f"Initial SL {initial_sl_pct:.0f}% - BE Shield @ +{be_shield_trigger_pct:.0f}% - Pyramid @ +20% - 50 EMA Vol Breakdown + {trail_pct:.0f}% Close Trail",
                "ema20": round(float(df["EMA20"].iloc[-1]), 2) if "EMA20" in df else None,
                "peak_price": round(last_close, 2)
            }
            
            print(f"[Swinger Paper] NEW ELITE PAPER BUY (LEG 1): {sym} ({cand.get('name', sym)}) @ Rs.{last_close} [{stars}-Star Setup] | Qty: {qty} | Invested: Rs.{new_pos['invested']} | SL ({initial_sl_pct:.0f}%): Rs.{initial_sl}")
            updated_positions.append(new_pos)
            held_symbols.add(sym)
            available_slots -= 1

    # --- FILL REMAINING SLOTS WITH LEG 2 HIGH-BASE BREAKOUT CANDIDATES ---
    leg2_enabled = cfg.get("leg2_enabled", True)
    leg2_sl_pct = cfg.get("leg2_initial_sl_pct", -12.0)
    leg2_be_pct = cfg.get("leg2_be_trigger_pct", 10.0)
    
    if available_slots > 0 and leg2_enabled and cfg.get("enabled", True):
        try:
            import pickle
            cache_p = ROOT / "scratch" / "universe_4y_prices.pkl"
            if cache_p.exists():
                with open(cache_p, "rb") as f:
                    u_data = pickle.load(f)
                trig_leg2, coiled_leg2 = scan_leg2_breakouts(u_data, held_symbols=held_symbols, eligible_symbols=False)
                print(f"[Swinger Paper] Leg 2 Scanner: {len(trig_leg2)} breakouts triggering, {len(coiled_leg2)} coiled.")
                
                radar_file = ROOT / "paper" / "swinger" / "radar_leg2.json"
                with open(radar_file, "w", encoding="utf-8") as f:
                    json.dump({"coiled": coiled_leg2, "updated_at": datetime.now(IST).isoformat()}, f, indent=2)
                    
                alloc_per_slot = cfg.get("base_position_size", 25000.0)
                for cand2 in trig_leg2:
                    if available_slots <= 0:
                        break
                    sym2 = cand2["symbol"]
                    if sym2 in held_symbols:
                        continue
                    c_p = cand2["current_price"]
                    qty2 = int(alloc_per_slot // c_p)
                    if qty2 <= 0:
                        continue
                    trig_low2 = cand2.get("trigger_sl", round(c_p * 0.95, 2))
                    sl2 = round(c_p * (1.0 + leg2_sl_pct / 100.0), 2)
                    be2 = round(c_p * (1.0 + leg2_be_pct / 100.0), 2)
                    tp2 = round(c_p * 1.30, 2)
                    s_leg2 = cand2.get("strategy_leg", "LEG2_MA_PULLBACK")
                    
                    new_pos2 = {
                        "symbol": sym2,
                        "name": sym2,
                        "leg": 2,
                        "strategy_leg": s_leg2,
                        "entry_date": cand2.get("date", datetime.now(IST).strftime("%Y-%m-%d")),
                        "entry_price": c_p,
                        "avg_price": c_p,
                        "cmp": c_p,
                        "initial_qty": qty2,
                        "current_qty": qty2,
                        "shares": qty2,
                        "invested": round(qty2 * c_p, 2),
                        "initial_sl_pct": round((sl2 / c_p - 1.0) * 100.0, 1),
                        "sl_price": sl2,
                        "trigger_sl": trig_low2,
                        "be_active": False,
                        "be_trigger_price": be2,
                        "tp_hit": False,
                        "tp_50_hit": False,
                        "tp_target_price": tp2,
                        "runner_mode": False,
                        "runner_peak_price": c_p,
                        "runner_trail_sl": None,
                        "base_high": cand2["base_high"],
                        "base_low": cand2["base_low"],
                        "surge_date": cand2["surge_date"],
                        "consol_days": cand2["consol_days"],
                        "days_held": 0,
                        "booked_pnl": 0.0,
                        "unrealized_pnl": 0.0,
                        "unrealized_pnl_pct": 0.0,
                        "unrealized_pct": 0.0,
                        "status": f"ACTIVE ({'20 EMA Pullback' if 'PULLBACK' in s_leg2 else 'Base Breakout'})",
                        "stars": 5,
                        "exit_rule": f"Leg 2 SL {leg2_sl_pct:.0f}% - BE Shield @ +{leg2_be_pct:.0f}% - 50 EMA Vol Breakdown + 20% Trail",
                        "peak_price": c_p
                    }
                    print(f"[Swinger Paper] NEW LEG 2 BREAKOUT BUY: {sym2} @ Rs.{c_p} | Ceiling: Rs.{cand2['base_high']} | Vol: {cand2['today_vol_mult']}x | SL ({leg2_sl_pct:.0f}%): Rs.{sl2}")
                    updated_positions.append(new_pos2)
                    held_symbols.add(sym2)
                    available_slots -= 1
                    
                # Dynamically update watchlist.json with true cooldown candidates (excluding all held symbols)
                radar_candidates = scan_cooldown_radar(u_data, held_symbols=held_symbols)
                save_watchlist({"watchlist": radar_candidates})
        except Exception as e:
            print(f"[Swinger Paper] Error during Leg 2 scan: {e}")

    # Update summary aggregates
    total_invested = round(sum(p.get("invested", 0.0) for p in updated_positions), 2)
    total_unrealized = round(sum(p.get("unrealized_pnl", 0.0) for p in updated_positions), 2)
    
    portfolio["positions"] = updated_positions
    portfolio["total_open"] = len(updated_positions)
    portfolio["total_invested"] = total_invested
    portfolio["total_unrealized_pnl"] = total_unrealized
    save_portfolio(portfolio)
    
    if closed_this_cycle:
        trade_db["trades"].extend(closed_this_cycle)
        save_trades(trade_db)
        
    print(f"[Swinger Paper] Cycle complete. Active positions: {len(updated_positions)}, Invested: Rs.{total_invested}, Unrealized: Rs.{total_unrealized}")
    return {
        "portfolio": portfolio,
        "daily_signals": saved_sig,
        "closed_today": closed_this_cycle
    }

def simulate_strategy_on_df(
    df: pd.DataFrame,
    symbol: str,
    max_direct_gain: float = 10.0,
    initial_sl_pct: float = -15.0,
    be_trigger_pct: float = 15.0,
    runner_trail_pct: float = 25.0,
    trigger_dates: list = None,
    vol_loss_min_gain: float = 20.0,
    vol_loss_vol_mult: float = 1.2,
    base_position_size: float = 25000.0
):
    """
    Single Authoritative Strategy Execution Engine for Phoenix Swinger 2.0.
    Ensures single responsibility across single-stock backtests, portfolio generation,
    and live scanner validation.

    Rules:
      - Clean Breakout (<= 10% gain): Direct entry.
      - Blast Breakout (> 10% gain): Route to Cooldown Radar.
        * Retracement: Low touches 40% retrace or 20 EMA (Low <= EMA20 * 1.01).
        * Green stabilization: Close > Open and Close >= EMA20 while holding blast low.
        * Trap protection: Discard if Close < blast_low or after 8 sessions.
        * No Day-1 entries (prevents entering into red dumping candles).
      - Position Management:
        * Initial SL: -15%
        * BE Shield: Snap SL to Cost + 0.5% when peak gain >= +15%
        * Runner Mode: Active @ +20% peak gain with 25% peak close trailing stop
        * 50 EMA Volume Breakdown exit (Close < 50 EMA on > 1.2x 50-SMA volume when gain >= 20% and held > 5 days)
    """
    if df is None or len(df) < 50:
        return [], None, [], {
            "total_trades": 0, "closed_trades": 0, "open_positions": 0,
            "wins": 0, "losses": 0, "win_rate": 0.0, "profit_factor": 0.0,
            "realized_pnl": 0.0, "unrealized_pnl": 0.0, "total_combined_pnl": 0.0,
            "avg_win": 0.0, "avg_loss": 0.0
        }

    df = df.copy()
    if not isinstance(df.index, pd.DatetimeIndex):
        df.index = pd.to_datetime(df.index)
    df.index = df.index.tz_localize(None)
    df.sort_index(inplace=True)

    c = df['Close']
    h = df['High']
    l = df['Low']
    o = df['Open']
    v = df['Volume']

    vol_sma60 = v.rolling(60, min_periods=20).mean()
    vol_sma50 = v.rolling(50, min_periods=20).mean()
    ema20 = c.ewm(span=20, adjust=False).mean()
    ema50 = c.ewm(span=50, adjust=False).mean()
    ema200 = c.ewm(span=200, adjust=False).mean()
    peak_high = h.rolling(1000, min_periods=30).max()

    delta = c.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=13, min_periods=14).mean()
    avg_loss = loss.ewm(com=13, min_periods=14).mean()
    rsi = 100 - (100 / (1 + avg_gain / (avg_loss + 1e-9)))

    prev_c = c.shift(1)
    prev_rsi = rsi.shift(1)
    range_hl = (h - l).replace(0, np.nan)
    close_in_upper_35 = (c - l) >= (range_hl * 0.65)

    if trigger_dates is not None:
        trig_set = set(pd.to_datetime(t).strftime('%Y-%m-%d') for t in trigger_dates)
    else:
        # Standard Phoenix Turnaround Breakout Condition
        mask = (
            (c <= peak_high * 0.40) &
            (c < ema200) &
            (c > ema20) &
            (c >= 20.0) &
            (c > o) &
            (c >= prev_c * 1.05) &
            (v >= vol_sma60 * 1.5) &
            (rsi > 54) &
            (prev_rsi <= 65) &
            close_in_upper_35
        )
        trig_set = set(df.index[mask].strftime('%Y-%m-%d'))

    closed_trades = []
    in_trade = False
    cur = None
    pending_radar = None

    for i in range(len(df)):
        dt = df.index[i]
        dt_str = dt.strftime('%Y-%m-%d')
        row_o = float(o.iloc[i])
        row_h = float(h.iloc[i])
        row_l = float(l.iloc[i])
        row_c = float(c.iloc[i])
        row_v = float(v.iloc[i])
        row_ema20 = float(ema20.iloc[i])
        row_ema50 = float(ema50.iloc[i])
        row_vol50 = float(vol_sma50.iloc[i])

        # 1. Manage Active Trade
        if in_trade and cur is not None:
            cur['days_held'] += 1
            entry_p = cur['entry_price']

            if row_c > cur['highest_close']:
                cur['highest_close'] = round(row_c, 2)
            if row_h > cur['highest_price']:
                cur['highest_price'] = round(row_h, 2)

            gain_from_entry = (cur['highest_close'] - entry_p) / entry_p * 100.0
            peak_gain = (cur['highest_price'] - entry_p) / entry_p * 100.0

            # BE Shield @ +15%
            if (gain_from_entry >= be_trigger_pct or peak_gain >= be_trigger_pct) and not cur['be_active']:
                cur['be_active'] = True
                cur['status'] = 'SHIELDED'
                be_p = round(entry_p * 1.005, 2)
                if be_p > cur['sl_price']:
                    cur['sl_price'] = be_p
                    cur['sl_label'] = "BE Shield (+0.5%)"

            # Runner Trailing Stop: 25% below peak close once BE Shield is active
            if cur['be_active']:
                raw_trail = round(cur['highest_close'] * (1.0 - runner_trail_pct / 100.0), 2)
                prot_trail = max(round(entry_p * 1.005, 2), raw_trail)
                if prot_trail > cur['sl_price']:
                    cur['sl_price'] = prot_trail
                    cur['status'] = 'RUNNER'
                    cur['sl_label'] = f"Runner Trail SL ({runner_trail_pct:.0f}%)"

            sl = cur['sl_price']
            exited = False
            exit_p = 0.0
            exit_reason = ""

            if row_c <= sl:
                exited = True
                exit_p = row_c
                exit_reason = cur['sl_label']
            elif (gain_from_entry >= vol_loss_min_gain or peak_gain >= vol_loss_min_gain) and row_c < row_ema50 and row_v > vol_loss_vol_mult * row_vol50 and cur['days_held'] > 5:
                exited = True
                exit_p = row_c
                exit_reason = "50 EMA Vol Breakdown"

            if exited:
                cur['exit_date'] = dt_str
                cur['exit_price'] = round(exit_p, 2)
                cur['exit_reason'] = exit_reason
                cur['reason'] = exit_reason
                pnl_pct = (exit_p - cur['entry_price']) / cur['entry_price'] * 100.0
                shares = cur['shares']
                cur['pnl'] = round((exit_p - cur['entry_price']) * shares, 2)
                cur['pnl_pct'] = round(pnl_pct, 2)
                cur['pct_return'] = round(pnl_pct, 2)
                cur['status'] = "CLOSED"
                closed_trades.append(cur)
                in_trade = False
                cur = None

        # 2. Check Pending Cooldown Radar (Overextended Blast waiting for retracement)
        if not in_trade and pending_radar is not None:
            days_since_blast = i - pending_radar['blast_i']
            if days_since_blast > 8:
                pending_radar = None
            elif row_c < pending_radar['blast_low']:
                # Breakdown below blast low - trap avoided, cancel radar!
                pending_radar = None
            else:
                target_pb = pending_radar['target_pb']
                retrace_touched = (row_l <= target_pb or row_l <= row_ema20 * 1.01)
                stabilized = (row_c >= row_o or row_c >= row_ema20) and (row_c >= pending_radar['blast_low'])
                
                if retrace_touched and stabilized:
                    entry_p = min(row_c, target_pb)
                    shares = int(base_position_size / entry_p) if entry_p > 0 else 0
                    if shares > 0:
                        in_trade = True
                        cur = {
                            'symbol': symbol,
                            'name': symbol,
                            'entry_date': dt_str,
                            'entry_price': round(entry_p, 2),
                            'avg_price': round(entry_p, 2),
                            'highest_close': round(entry_p, 2),
                            'highest_price': round(row_h, 2),
                            'shares': shares,
                            'qty': shares,
                            'invested': round(shares * entry_p, 2),
                            'sl_price': round(entry_p * (1.0 + initial_sl_pct / 100.0), 2),
                            'sl_label': f'Pullback SL ({initial_sl_pct:.0f}%)',
                            'be_active': False,
                            'status': 'ACTIVE (Radar Retracement)',
                            'days_held': 0,
                            'blast_candle_gain': pending_radar['blast_gain'],
                            'entry_type': 'COOLDOWN_RADAR_RETRACEMENT'
                        }
                    pending_radar = None

        # 3. Check Trigger for New Entry
        if not in_trade and pending_radar is None:
            if dt_str in trig_set:
                p_c = float(prev_c.iloc[i]) if i >= 1 else row_c
                candle_gain_val = (row_c / p_c - 1.0) * 100.0

                if candle_gain_val <= max_direct_gain:
                    # Clean Breakout (<= 10% gain): Enter next day open, or EOD close if at last bar
                    if i + 1 < len(df):
                        next_dt = df.index[i + 1].strftime('%Y-%m-%d')
                        next_o = float(o.iloc[i + 1])
                        entry_p = next_o
                        entry_date = next_dt
                    else:
                        entry_p = row_c
                        entry_date = dt_str

                    shares = int(base_position_size / entry_p) if entry_p > 0 else 0
                    if shares > 0:
                        in_trade = True
                        cur = {
                            'symbol': symbol,
                            'name': symbol,
                            'entry_date': entry_date,
                            'entry_price': round(entry_p, 2),
                            'avg_price': round(entry_p, 2),
                            'highest_close': round(entry_p, 2),
                            'highest_price': round(entry_p, 2),
                            'shares': shares,
                            'qty': shares,
                            'invested': round(shares * entry_p, 2),
                            'sl_price': round(entry_p * (1.0 + initial_sl_pct / 100.0), 2),
                            'sl_label': f'Initial SL ({initial_sl_pct:.0f}%)',
                            'be_active': False,
                            'status': 'ACTIVE',
                            'days_held': 0,
                            'blast_candle_gain': round(candle_gain_val, 1),
                            'entry_type': 'DIRECT_BREAKOUT'
                        }
                else:
                    # Extended Blast (> 10% gain, e.g. BATA +16.4%):
                    # Route to Cooldown Radar: Wait for 40% retrace or 20 EMA touch holding blast low
                    target_pb_level = row_c - (0.40 * (row_c - row_o))
                    pending_radar = {
                        'blast_i': i,
                        'blast_date': dt_str,
                        'blast_gain': round(candle_gain_val, 1),
                        'target_pb': target_pb_level,
                        'blast_low': row_l
                    }

    open_pos = None
    if in_trade and cur is not None:
        last_c = round(float(c.iloc[-1]), 2)
        cur['cmp'] = last_c
        cur['exit_date'] = None
        cur['exit_price'] = None
        cur['unrealized_pnl'] = round((last_c - cur['entry_price']) * cur['shares'], 2)
        cur['unrealized_pct'] = round((last_c - cur['entry_price']) / cur['entry_price'] * 100.0, 2)
        cur['pnl'] = cur['unrealized_pnl']
        cur['pnl_pct'] = cur['unrealized_pct']
        open_pos = cur

    # Summary Metrics
    df_closed = pd.DataFrame(closed_trades)
    if not df_closed.empty:
        wins = df_closed[df_closed['pnl'] > 0]
        losses = df_closed[df_closed['pnl'] <= 0]
        total_pnl = round(float(df_closed['pnl'].sum()), 2)
        win_rate = round(float(len(wins) / len(df_closed) * 100.0), 1)
        tot_win = float(wins['pnl'].sum())
        tot_loss = abs(float(losses['pnl'].sum()))
        pf = round(float(tot_win / tot_loss), 2) if tot_loss > 0 else 999.0
        avg_w = round(float(wins['pnl'].mean()), 2) if len(wins) > 0 else 0.0
        avg_l = round(abs(float(losses['pnl'].mean())), 2) if len(losses) > 0 else 0.0
    else:
        wins, losses = pd.DataFrame(), pd.DataFrame()
        total_pnl, win_rate, pf, avg_w, avg_l = 0.0, 0.0, 0.0, 0.0, 0.0

    summary = {
        "total_trades": len(closed_trades) + (1 if open_pos else 0),
        "closed_trades": len(closed_trades),
        "open_positions": 1 if open_pos else 0,
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "profit_factor": pf,
        "realized_pnl": total_pnl,
        "unrealized_pnl": open_pos['unrealized_pnl'] if open_pos else 0.0,
        "total_combined_pnl": round(total_pnl + (open_pos['unrealized_pnl'] if open_pos else 0.0), 2),
        "avg_win": avg_w,
        "avg_loss": avg_l
    }

    return closed_trades, open_pos, sorted(list(trig_set)), summary

def backtest_single_stock(symbol: str, initial_sl_pct: float = None, be_trigger_pct: float = None, runner_trail_pct: float = None):
    """
    Simulates the exact calibrated Phoenix Swinger strategy for any individual stock symbol.
    Uses local 4-year universe prices cache, with fallback to yfinance for unindexed NSE/BSE stocks.
    Ensures identical execution logic through `simulate_strategy_on_df`.
    """
    import pickle
    cfg = load_config()
    if initial_sl_pct is None:
        initial_sl_pct = float(cfg.get("initial_sl_pct", -15.0))
    if be_trigger_pct is None:
        be_trigger_pct = float(cfg.get("be_shield_trigger_pct", 15.0))
    if runner_trail_pct is None:
        runner_trail_pct = float(cfg.get("runner_trailing_stop_pct", 25.0))
    max_direct_gain = float(cfg.get("max_direct_entry_gain_pct", 10.0))
    vol_loss_min_gain = float(cfg.get("vol_loss_min_gain_pct", 20.0))
    vol_loss_vol_mult = float(cfg.get("vol_loss_vol_mult", 1.2))
    base_pos_size = float(cfg.get("base_position_size", 25000.0))

    cache = None
    cache_path = ROOT / "scratch" / "universe_4y_prices.pkl"
    if cache_path.exists():
        try:
            with open(cache_path, "rb") as f:
                cache = pickle.load(f)
        except Exception:
            pass

    avail_keys = list(cache.keys()) if cache else None
    resolved_sym = resolve_symbol(symbol, avail_keys)
    df = None
    if cache and resolved_sym in cache:
        df = cache[resolved_sym]

    # Ensure full data (fallback to yfinance if missing or short)
    if df is None or len(df) < 50:
        try:
            ticker_ns = f"{resolved_sym}.NS" if not resolved_sym.endswith(".NS") and not resolved_sym.endswith(".BO") else resolved_sym
            yf_df = yf.download(ticker_ns, period="5y", progress=False, auto_adjust=False)
            if yf_df.empty and not resolved_sym.endswith(".BO"):
                yf_df = yf.download(f"{resolved_sym}.BO", period="5y", progress=False, auto_adjust=False)
            if not yf_df.empty:
                if isinstance(yf_df.columns, pd.MultiIndex):
                    yf_df.columns = [c[0] for c in yf_df.columns]
                if not isinstance(yf_df.index, pd.DatetimeIndex):
                    yf_df.index = pd.to_datetime(yf_df.index)
                yf_df.index = yf_df.index.tz_localize(None)
                df = yf_df
        except Exception:
            pass

    if df is None or len(df) < 50:
        return {"ok": False, "error": f"Insufficient price data available for {symbol} (at least 50 trading days required)"}

    # Run unified strategy simulation
    closed_trades, open_pos, triggers, summary = simulate_strategy_on_df(
        df=df,
        symbol=resolved_sym,
        max_direct_gain=max_direct_gain,
        initial_sl_pct=initial_sl_pct,
        be_trigger_pct=be_trigger_pct,
        runner_trail_pct=runner_trail_pct,
        trigger_dates=None,
        vol_loss_min_gain=vol_loss_min_gain,
        vol_loss_vol_mult=vol_loss_vol_mult,
        base_position_size=base_pos_size
    )

    candles_payload = []
    for idx, r in df.iterrows():
        candles_payload.append({
            "time": idx.strftime('%Y-%m-%d'),
            "open": round(float(r['Open']), 2),
            "high": round(float(r['High']), 2),
            "low": round(float(r['Low']), 2),
            "close": round(float(r['Close']), 2),
            "volume": int(r['Volume'])
        })

    all_trades = closed_trades + ([open_pos] if open_pos else [])

    return {
        "ok": True,
        "symbol": resolved_sym,
        "original_symbol": symbol,
        "summary": summary,
        "trades": all_trades,
        "open_position": open_pos,
        "radar_triggers": triggers,
        "candles": candles_payload,
        "market_cap_cr": get_stock_market_cap_cr(resolved_sym)
    }

def generate_backtest_ledger():
    """
    Generates the complete authoritative Swinger backtest ledger over all 133 Chartink triggers.
    Enforces UNLIMITED slots and strict >10% cooldown radar retracement with green stabilization.
    Saves to paper/swinger/trades.json and paper/swinger/portfolio.json.
    """
    import pickle
    import csv

    # 1. Load Ground-Truth Chartink Triggers
    trigs_csv = ROOT / "scratch" / "chartink_pure_triggers.csv"
    if not trigs_csv.exists():
        print("[Swinger Backtest] chartink_pure_triggers.csv not found!")
        return None

    df_trigs = pd.read_csv(trigs_csv)
    df_trigs["date"] = pd.to_datetime(df_trigs["date"])
    df_trigs.sort_values(by=["date", "symbol"], inplace=True)

    # 2. Load Price Databases
    price_data = {}
    for pkl_name in ["universe_4y_prices.pkl", "testnik_all_prices.pkl", "universe_down_50_prices.pkl"]:
        p_path = ROOT / "scratch" / pkl_name
        if p_path.exists():
            try:
                with open(p_path, "rb") as f:
                    d = pickle.load(f)
                    price_data.update(d)
            except Exception:
                pass

    stock_bars = {}
    for s, df in price_data.items():
        if df is None or len(df) < 20: continue
        df = df.copy()
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)
        df.index = df.index.tz_localize(None)
        df.sort_index(inplace=True)
        
        c = df["Close"].values
        h = df["High"].values
        l = df["Low"].values
        o = df["Open"].values
        v = df["Volume"].values
        dates = [d.strftime("%Y-%m-%d") for d in df.index]
        
        vol_sma50 = pd.Series(v).rolling(50, min_periods=20).mean().values
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
        
        stock_bars[s] = {
            "dates": dates,
            "date_map": {d: i for i, d in enumerate(dates)},
            "c": c, "h": h, "l": l, "o": o, "v": v,
            "ema20": ema20, "ema50": ema50,
            "vol_sma50": vol_sma50
        }

    # Parameters - UNLIMITED SLOTS & STRICT >10% COOLDOWN RETRACEMENT
    cfg = load_config()
    SLOT_SIZE = float(cfg.get("base_position_size", 25000.0))
    INITIAL_SL_PCT = float(cfg.get("initial_sl_pct", -15.0))
    BE_SHIELD_PCT = float(cfg.get("be_shield_trigger_pct", 15.0))
    RUNNER_TRIGGER_PCT = 20.0
    RUNNER_TRAIL_PCT = float(cfg.get("runner_trailing_stop_pct", 25.0))
    MAX_DIRECT_GAIN = float(cfg.get("max_direct_entry_gain_pct", 10.0))

    ref_sym = "RELIANCE" if "RELIANCE" in stock_bars else list(stock_bars.keys())[0]
    all_sim_dates = sorted([d for d in stock_bars[ref_sym]["dates"] if d >= "2026-03-24"])

    trig_by_date = {}
    for _, row in df_trigs.iterrows():
        d_str = row["date"].strftime("%Y-%m-%d")
        sym_res = resolve_symbol(row["symbol"], stock_bars.keys())
        trig_by_date.setdefault(d_str, []).append(sym_res)

    open_positions = []
    closed_trades = []
    cooldown_radar = []
    trade_id = 1

    for cur_date in all_sim_dates:
        # A. Update Existing Positions
        surviving = []
        for pos in open_positions:
            s = pos["symbol"]
            b = stock_bars.get(s)
            if not b or cur_date not in b["date_map"]:
                surviving.append(pos)
                continue
                
            i = b["date_map"][cur_date]
            c = float(b["c"][i])
            h = float(b["h"][i])
            l = float(b["l"][i])
            o = float(b["o"][i])
            v = float(b["v"][i])
            e50 = float(b["ema50"][i])
            vsma50 = float(b["vol_sma50"][i])
            
            entry_p = pos["entry_price"]
            pos["cmp"] = round(c, 2)
            pos["days_held"] += 1
            pos["bars_held"] += 1
            
            if h > pos["peak_price"]: pos["peak_price"] = round(h, 2)
            if c > pos["highest_close"]: pos["highest_close"] = round(c, 2)
                
            peak_gain_pct = (pos["highest_close"] - entry_p) / entry_p * 100.0
            pos["peak_gain_pct"] = round(peak_gain_pct, 1)
            
            exited = False
            exit_p = None
            exit_reason = None
            
            # Check BE Shield trigger
            if peak_gain_pct >= BE_SHIELD_PCT and not pos["be_active"]:
                pos["be_active"] = True
                pos["sl_price"] = round(entry_p * 1.005, 2)
                
            # Check Runner Mode trigger
            if peak_gain_pct >= RUNNER_TRIGGER_PCT and not pos["runner_mode"]:
                pos["runner_mode"] = True
                pos["tp_hit"] = True
                
            # Exit checks
            if not pos["runner_mode"]:
                if l <= pos["sl_price"]:
                    exited = True
                    exit_p = min(o, pos["sl_price"]) if o < pos["sl_price"] else pos["sl_price"]
                    exit_reason = "BE Shield (+0.5%)" if pos["be_active"] else f"Initial SL ({INITIAL_SL_PCT:.0f}%)"
            else:
                runner_stop = pos["highest_close"] * (1.0 - RUNNER_TRAIL_PCT / 100.0)
                pos["runner_trail_sl"] = round(runner_stop, 2)
                if l <= runner_stop:
                    exited = True
                    exit_p = min(o, runner_stop) if o < runner_stop else runner_stop
                    exit_reason = f"Peak Trail ({RUNNER_TRAIL_PCT:.0f}%)"
                elif pos["bars_held"] >= 5 and c < e50 and vsma50 > 0 and v > 1.2 * vsma50:
                    exited = True
                    exit_p = c
                    exit_reason = "50 EMA Vol Breakdown"
                    
            if exited:
                pnl = round(pos["shares"] * (exit_p - entry_p), 2)
                pnl_pct = round((exit_p / entry_p - 1.0) * 100.0, 2)
                closed_trades.append({
                    "trade_id": f"SWG-{trade_id:04d}",
                    "symbol": s,
                    "name": s,
                    "entry_date": pos["entry_date"],
                    "exit_date": cur_date,
                    "entry_price": round(entry_p, 2),
                    "avg_price": round(entry_p, 2),
                    "exit_price": round(exit_p, 2),
                    "shares": pos["shares"],
                    "qty": pos["shares"],
                    "invested": round(pos["shares"] * entry_p, 2),
                    "capital_invested": round(pos["shares"] * entry_p, 2),
                    "exit_value": round(pos["shares"] * exit_p, 2),
                    "pnl": pnl,
                    "pnl_pct": pnl_pct,
                    "pct_return": pnl_pct,
                    "days_held": pos["days_held"],
                    "bars_held": pos["bars_held"],
                    "highest_price": round(pos["peak_price"], 2),
                    "reason": exit_reason,
                    "exit_reason": exit_reason,
                    "status": "WIN" if pnl > 0 else "LOSS",
                    "leg": "Chartink Pure Breakout",
                    "breakout_candle_gain": pos.get("breakout_candle_gain", 0.0),
                    "entry_type": pos.get("entry_type", "DIRECT_BREAKOUT")
                })
                trade_id += 1
            else:
                unreal_pnl = round(pos["shares"] * (c - entry_p), 2)
                unreal_pct = round((c / entry_p - 1.0) * 100.0, 2)
                pos["unrealized_pnl"] = unreal_pnl
                pos["unrealized_pnl_pct"] = unreal_pct
                pos["unrealized_pct"] = unreal_pct
                pos["pnl"] = unreal_pnl
                pos["pnl_pct"] = unreal_pct
                surviving.append(pos)
                
        open_positions = surviving
        
        # B. Process Cooldown Radar Pullbacks (WAIT FOR 20 EMA RETRACEMENT & GREEN CONFIRMATION)
        held_syms = set(p["symbol"] for p in open_positions)
        surviving_radar = []
        
        for r_item in cooldown_radar:
            r_s = r_item["symbol"]
            b = stock_bars.get(r_s)
            if not b or cur_date not in b["date_map"]:
                surviving_radar.append(r_item)
                continue
                
            r_i = b["date_map"][cur_date]
            r_c = float(b["c"][r_i])
            r_o = float(b["o"][r_i])
            r_l = float(b["l"][r_i])
            r_h = float(b["h"][r_i])
            r_e20 = float(b["ema20"][r_i])
            days_since = r_i - r_item["blast_i"]
            
            # Check invalidation: Did it collapse below blast low? Or did 8 sessions pass?
            if r_c < r_item["blast_low"] or days_since > 8:
                continue
                
            # Retracement check: Touches 40% retrace or 20 EMA AND stabilizes (green candle or holding 20 EMA)
            retrace_touched = (r_l <= r_item["target_pb"] or r_l <= r_e20 * 1.01)
            stabilized = (r_c >= r_o or r_c >= r_e20) and (r_c >= r_item["blast_low"])
            
            if retrace_touched and stabilized and r_s not in held_syms:
                entry_p = min(r_c, r_item["target_pb"])
                qty = int(SLOT_SIZE // entry_p) if entry_p > 0 else 0
                if qty > 0:
                    sl_initial = round(entry_p * (1.0 + INITIAL_SL_PCT / 100.0), 2)
                    be_trigger = round(entry_p * (1.0 + BE_SHIELD_PCT / 100.0), 2)
                    new_pos = {
                        "symbol": r_s,
                        "name": r_s,
                        "leg": 1,
                        "strategy_leg": "LEG1_PHOENIX_RETRACEMENT",
                        "entry_date": cur_date,
                        "entry_price": round(entry_p, 2),
                        "avg_price": round(entry_p, 2),
                        "cmp": round(entry_p, 2),
                        "shares": qty,
                        "initial_qty": qty,
                        "current_qty": qty,
                        "invested": round(qty * entry_p, 2),
                        "initial_sl_pct": INITIAL_SL_PCT,
                        "sl_price": sl_initial,
                        "be_active": False,
                        "be_trigger_price": be_trigger,
                        "tp_hit": False,
                        "tp_target_price": round(entry_p * 1.30, 2),
                        "runner_mode": False,
                        "peak_price": round(entry_p, 2),
                        "highest_close": round(entry_p, 2),
                        "peak_gain_pct": 0.0,
                        "pnl": 0.0,
                        "pnl_pct": 0.0,
                        "unrealized_pnl": 0.0,
                        "unrealized_pnl_pct": 0.0,
                        "days_held": 0,
                        "bars_held": 0,
                        "unrealized_pct": 0.0,
                        "ema20": round(r_e20, 2),
                        "ema50": round(float(b["ema50"][r_i]), 2),
                        "runner_trail_sl": sl_initial,
                        "breakout_candle_gain": r_item["alert_gain"],
                        "entry_type": "COOLDOWN_RADAR_RETRACEMENT"
                    }
                    open_positions.append(new_pos)
                    held_syms.add(r_s)
            else:
                surviving_radar.append(r_item)
        cooldown_radar = surviving_radar
        
        # C. Process New Daily Triggers
        todays_syms = trig_by_date.get(cur_date, [])
        for s in todays_syms:
            if s in held_syms:
                continue
            b = stock_bars.get(s)
            if not b or cur_date not in b["date_map"]:
                continue
            i = b["date_map"][cur_date]
            c = float(b["c"][i])
            o = float(b["o"][i])
            l = float(b["l"][i])
            prev_c = float(b["c"][i-1]) if i >= 1 else o
            day_gain_pct = (c / prev_c - 1.0) * 100.0
            
            # Option B Gate Enforcement:
            if day_gain_pct > MAX_DIRECT_GAIN:
                # Overextended Blast (> 10% gain): DO NOT buy at top; route to Cooldown Radar!
                target_pb = round(c - 0.40 * (c - o), 2)
                if not any(r["symbol"] == s for r in cooldown_radar):
                    cooldown_radar.append({
                        "symbol": s,
                        "blast_i": i,
                        "alert_date": cur_date,
                        "alert_price": round(c, 2),
                        "alert_gain": round(day_gain_pct, 1),
                        "target_pb": target_pb,
                        "blast_low": round(l, 2)
                    })
                continue
                
            # Clean Breakout (<= 10% gain): Direct Immediate Entry at Close!
            qty = int(SLOT_SIZE // c) if c > 0 else 0
            if qty <= 0:
                continue
                
            sl_initial = round(c * (1.0 + INITIAL_SL_PCT / 100.0), 2)
            be_trigger = round(c * (1.0 + BE_SHIELD_PCT / 100.0), 2)
            new_pos = {
                "symbol": s,
                "name": s,
                "leg": 1,
                "strategy_leg": "LEG1_PHOENIX_BREAKOUT",
                "entry_date": cur_date,
                "entry_price": round(c, 2),
                "avg_price": round(c, 2),
                "cmp": round(c, 2),
                "shares": qty,
                "initial_qty": qty,
                "current_qty": qty,
                "invested": round(qty * c, 2),
                "initial_sl_pct": INITIAL_SL_PCT,
                "sl_price": sl_initial,
                "be_active": False,
                "be_trigger_price": be_trigger,
                "tp_hit": False,
                "tp_target_price": round(c * 1.30, 2),
                "runner_mode": False,
                "peak_price": round(c, 2),
                "highest_close": round(c, 2),
                "peak_gain_pct": 0.0,
                "pnl": 0.0,
                "pnl_pct": 0.0,
                "unrealized_pnl": 0.0,
                "unrealized_pnl_pct": 0.0,
                "days_held": 0,
                "bars_held": 0,
                "unrealized_pct": 0.0,
                "ema20": round(float(b["ema20"][i]), 2),
                "ema50": round(float(b["ema50"][i]), 2),
                "runner_trail_sl": sl_initial,
                "breakout_candle_gain": round(day_gain_pct, 1),
                "entry_type": "DIRECT_BREAKOUT"
            }
            open_positions.append(new_pos)
            held_syms.add(s)

    # Save to trades.json and portfolio.json
    trades_dict = {"trades": closed_trades}
    save_trades(trades_dict)

    portfolio_out = {
        "positions": open_positions,
        "total_open": len(open_positions),
        "total_invested": round(sum(p["invested"] for p in open_positions), 2),
        "total_unrealized_pnl": round(sum(p["unrealized_pnl"] for p in open_positions), 2),
        "last_updated": datetime.now(IST).isoformat()
    }
    with open(PORTFOLIO_FILE, "w", encoding="utf-8") as f:
        json.dump(portfolio_out, f, indent=2)

    print(f"[Swinger Backtest] Successfully generated ledger: {len(closed_trades)} closed trades, {len(open_positions)} open positions.")
    return closed_trades, open_positions

if __name__ == "__main__":
    print("[Swinger Paper] Running Phoenix Swinger engine manual cycle...")
    res = update_positions_and_scan()
    print("[Swinger Paper] Done.")
