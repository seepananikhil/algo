import math
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
import pickle
import requests
import pandas as pd
import numpy as np
from datetime import datetime, timedelta, timezone
from pathlib import Path
try:
    import yfinance as yf
except Exception:
    yf = None

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "paper" / "swinger"
DATA_DIR.mkdir(parents=True, exist_ok=True)

PORTFOLIO_FILE = DATA_DIR / "portfolio.json"
TRADES_FILE = DATA_DIR / "trades.json"
BACKTEST_TRADES_FILE = DATA_DIR / "backtest_trades.json"
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
    "max_direct_entry_gain_pct": 0.0,
    "min_star_rating": 4,
    "require_below_ema200": True,
    "min_volume_surge_mult": 1.5,
    "min_candle_gain_pct": 5.0,
    "initial_sl_pct": -15.0,
    "leg2_initial_sl_pct": -8.0,
    "be_shield_enabled": True,
    "be_shield_trigger_pct": 15.0,
    "runner_trailing_stop_pct": 25.0,
    "leg2_enabled": False,
    "leg2_be_trigger_pct": 10.0,
    "leg2_trail_sl_pct": 18.0,
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

def load_backtest_trades():
    if BACKTEST_TRADES_FILE.exists():
        try:
            with open(BACKTEST_TRADES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"trades": [], "summary": {}, "yearly_breakdown": []}

def load_trades():
    if TRADES_FILE.exists():
        try:
            with open(TRADES_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"trades": [], "summary": {}, "yearly_breakdown": []}

def compute_swinger_summary(trades, positions=None):
    from collections import defaultdict
    wins = [t for t in trades if t.get("pnl", 0) > 0]
    losses = [t for t in trades if t.get("pnl", 0) < 0]
    total_gain = sum(t.get("pnl", 0) for t in wins)
    total_loss = abs(sum(t.get("pnl", 0) for t in losses))
    
    pf = round(total_gain / total_loss, 2) if total_loss > 0 else 99.0
    win_rate = round(len(wins) / len(trades) * 100, 1) if trades else 0.0
    total_realized_pnl = round(sum(t.get("pnl", 0) for t in trades), 2)
    
    avg_win_amt = round(total_gain / len(wins), 2) if wins else 0.0
    avg_loss_amt = round(total_loss / len(losses), 2) if losses else 0.0
    payoff = round(avg_win_amt / avg_loss_amt, 2) if avg_loss_amt > 0 else 99.0
    expectancy = round(total_realized_pnl / len(trades), 2) if trades else 0.0
    
    avg_win = round(sum(t.get("pnl_pct", 0) for t in wins) / len(wins), 1) if wins else 0.0
    avg_loss = round(sum(t.get("pnl_pct", 0) for t in losses) / len(losses), 1) if losses else 0.0
    avg_return = round(sum(t.get("pnl_pct", 0) for t in trades) / len(trades), 1) if trades else 0.0
    avg_hold = round(sum(t.get("days_held", 0) for t in trades) / len(trades), 1) if trades else 0.0

    # Drawdown calculation across closed trades
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
            
    cfg = load_config()
    base_cap = float(cfg.get("capital_allocated", 500000.0))
    slot_size = float(cfg.get("base_position_size", 25000.0))
    is_paper = str(cfg.get("mode", "paper")).lower() == "paper"
    max_slots = 999 if is_paper else int(cfg.get("max_open_positions", 20))

    # Active positions integration
    if positions is None:
        try:
            positions = load_portfolio().get("positions", [])
        except Exception:
            positions = []
            
    valid_inv = []
    for x in positions:
        try:
            val = float(x.get("invested", 0) or 0)
            if not math.isnan(val): valid_inv.append(val)
        except Exception:
            pass
    tot_invested = round(sum(valid_inv), 2)

    valid_unreal = []
    for x in positions:
        try:
            val = float(x.get("unrealized_pnl", 0) or 0)
            if not math.isnan(val): valid_unreal.append(val)
        except Exception:
            pass
    tot_unrealized = round(sum(valid_unreal), 2)
    tot_combined_pnl = round(total_realized_pnl + tot_unrealized, 2)
    ending_capital = round(base_cap + tot_combined_pnl, 2)
    free_cash = round(base_cap - tot_invested + total_realized_pnl, 2)

    # Date span & CAGR calculation
    all_dates = [t.get("entry_date") for t in trades if t.get("entry_date")] + \
                [t.get("exit_date") for t in trades if t.get("exit_date")] + \
                [p.get("entry_date") for p in positions if p.get("entry_date")]
    if all_dates:
        min_dt = datetime.strptime(min(all_dates)[:10], "%Y-%m-%d")
        max_dt = datetime.strptime(max(all_dates)[:10], "%Y-%m-%d")
        days_span = max(1, (max_dt - min_dt).days)
        period_years = round(days_span / 365.25, 2)
    else:
        period_years = 0.67

    total_pnl_pct = round((tot_combined_pnl / base_cap) * 100.0, 1)
    max_dd_pct = round((abs(max_dd) / (base_cap + peak)) * 100.0, 1) if (base_cap + peak) > 0 else 0.0
    calmar = round(abs(total_realized_pnl / max_dd), 2) if max_dd < 0 else 99.0

    # Dynamic CAGR on full portfolio capital
    if period_years > 0 and ending_capital > 0:
        cagr = round(((ending_capital / base_cap) ** (1.0 / period_years) - 1.0) * 100.0, 1)
    else:
        cagr = 0.0

    # Dynamic XIRR on active deployed margin
    active_base = max(tot_invested, 25000.0)
    if period_years > 0:
        active_xirr = round((((active_base + tot_combined_pnl) / active_base) ** (1.0 / period_years) - 1.0) * 100.0, 1)
    else:
        active_xirr = 0.0

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

    summary = {
        "total_trades": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "profit_factor": pf,
        "total_pnl": total_realized_pnl,
        "net_pnl": total_realized_pnl,
        "total_realized_pnl": total_realized_pnl,
        "total_unrealized_pnl": tot_unrealized,
        "total_combined_pnl": tot_combined_pnl,
        "total_pnl_pct": total_pnl_pct,
        "period_years": period_years,
        "base_capital": base_cap,
        "capital_allocated": base_cap,
        "current_capital": ending_capital,
        "total_invested": tot_invested,
        "free_cash": free_cash,
        "active_positions_count": len(positions),
        "xirr": cagr,
        "cagr": cagr,
        "xirr_active": active_xirr,
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
        "base_slot_size": slot_size,
        "max_slots": max_slots,
        "mode": "PAPER",
        "strategy": "Phoenix Swinger 2.0 · 15% SL · Cost Shield @ +15% · 25% Peak Trail",
        "last_updated": datetime.now(IST).isoformat()
    }
    return summary, yearly, monthly, daily

def save_trades(data, positions=None):
    trades = data.get("trades", [])
    summary, yearly, monthly, daily = compute_swinger_summary(trades, positions)
    data["summary"] = summary
    data["yearly_breakdown"] = yearly
    data["monthly"] = monthly
    data["daily"] = daily
    with open(TRADES_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

def save_backtest_trades(data, positions=None):
    trades = data.get("trades", [])
    summary, yearly, monthly, daily = compute_swinger_summary(trades, positions)
    data["summary"] = summary
    data["yearly_breakdown"] = yearly
    data["monthly"] = monthly
    data["daily"] = daily
    with open(BACKTEST_TRADES_FILE, "w", encoding="utf-8") as f:
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

def fetch_yahoo_candles(symbol: str, years: int = 4):
    """
    Fetch multi-year daily OHLCV candles from Yahoo Finance.
    Provides up to 4+ years (~1000 daily bars) for backtesting without hitting
    Kotak Neo historical API, eliminating rate limits and preventing order execution interference.
    """
    import urllib.request
    clean_sym = symbol.upper().replace(".NS", "").replace(".BO", "").replace("NSE:", "").strip()
    for ext in [".NS", ".BO"]:
        t_sym = f"{clean_sym}{ext}"
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{t_sym}?range={years}y&interval=1d"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"})
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                data = json.loads(res.read().decode("utf-8"))
                res_arr = data.get("chart", {}).get("result", [])
                if not res_arr:
                    continue
                chart_data = res_arr[0]
                timestamps = chart_data.get("timestamp", [])
                quotes = chart_data.get("indicators", {}).get("quote", [{}])[0]
                if not timestamps or not quotes:
                    continue
                opens = quotes.get("open", [])
                highs = quotes.get("high", [])
                lows = quotes.get("low", [])
                closes = quotes.get("close", [])
                volumes = quotes.get("volume", [])

                rows = []
                for ts, o, h, l, c, v in zip(timestamps, opens, highs, lows, closes, volumes):
                    if None in (ts, o, h, l, c) or (c is not None and c <= 0):
                        continue
                    dt = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
                    rows.append({
                        "Date": dt,
                        "Open": round(float(o), 2),
                        "High": round(float(h), 2),
                        "Low": round(float(l), 2),
                        "Close": round(float(c), 2),
                        "Volume": int(v or 0)
                    })
                if len(rows) >= 50:
                    df = pd.DataFrame(rows).set_index("Date")
                    df.index = pd.to_datetime(df.index)
                    return df
        except Exception:
            continue
    return None

def get_market_data(symbol):
    """Fetch daily market data and compute indicators using cached/Yahoo candles without hitting Kotak order lines."""
    try:
        df = None
        if _candles_cache and symbol in _candles_cache:
            df = _candles_cache[symbol]
        if df is None or df.empty or len(df) < 50:
            df = fetch_yahoo_candles(symbol, years=2)
            if df is not None and not df.empty and _candles_cache is not None:
                _candles_cache[symbol] = df
        if (df is None or df.empty or len(df) < 50):
            try:
                from kotak_orders import get_kotak_candles
                df = get_kotak_candles(symbol, days=330)
                if df is not None and not df.empty and _candles_cache is not None:
                    _candles_cache[symbol] = df
            except Exception:
                pass
        if df is None or df.empty or len(df) < 50:
            df = get_kotak_candles(symbol, days=330)
            if df is not None and not df.empty and _candles_cache is not None:
                _candles_cache[symbol] = df
        if df is None or df.empty:
            return None
        df = df.copy()
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)
        df.index = df.index.tz_localize(None)
        df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
        df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
        df["EMA200"] = df["Close"].ewm(span=200, adjust=False).mean()
        df["VolSMA60"] = df["Volume"].rolling(60, min_periods=10).mean()
        return df
    except Exception as e:
        print(f"[Swinger] Failed to fetch Kotak market data for {symbol}: {e}")
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
_formatted_candles_cache = {}
_synced_today_symbols = set()
_last_sync_date = ""
CANDLES_CACHE_FILE = ROOT / "paper" / "swinger" / "candles_cache.json"

def _warmup_universe_cache():
    global _candles_cache
    if _candles_cache is None:
        _candles_cache = {}
        # 1. Bundled lightweight candles_cache.json (available on all deployed servers)
        if CANDLES_CACHE_FILE.exists():
            try:
                import json
                with open(CANDLES_CACHE_FILE, "r", encoding="utf-8") as f:
                    j_data = json.load(f)
                for sym, rows in j_data.items():
                    if rows:
                        df_sym = pd.DataFrame(rows)
                        if "Date" in df_sym.columns:
                            df_sym["Date"] = pd.to_datetime(df_sym["Date"])
                            df_sym = df_sym.set_index("Date").sort_index()
                            _candles_cache[sym] = df_sym
                print(f"[Swinger] Pre-warmed {len(_candles_cache)} symbols from candles_cache.json")
            except Exception as e:
                print(f"[Swinger] Error loading candles_cache.json: {e}")

        # 2. Merge local scratch pkl if present on development machine
        p = ROOT / "scratch" / "universe_4y_prices.pkl"
        if p.exists():
            try:
                import pickle
                with open(p, "rb") as f:
                    pkl_data = pickle.load(f)
                for sym, df_pkl in pkl_data.items():
                    if sym not in _candles_cache:
                        _candles_cache[sym] = df_pkl
                print(f"[Swinger] Universe candles cache: {len(_candles_cache)} symbols in RAM")
            except Exception as e:
                print(f"[Swinger] Warmup pkl error: {e}")

import threading
threading.Thread(target=_warmup_universe_cache, daemon=True).start()

def get_stock_candles(symbol: str, from_date: str = None, to_date: str = None):
    """Fetch daily candles for a stock symbol from bundled cache + live Kotak Neo delta."""
    global _candles_cache, _formatted_candles_cache, _synced_today_symbols, _last_sync_date
    if _candles_cache is None:
        _warmup_universe_cache()

    keys = list(_candles_cache.keys()) if _candles_cache else None
    symbol = resolve_symbol(symbol, keys)

    # Instant RAM cache hit (< 1 millisecond response)
    if not from_date and not to_date and symbol in _formatted_candles_cache:
        return _formatted_candles_cache[symbol]
    df = None
    if _candles_cache and symbol in _candles_cache:
        df = _candles_cache[symbol]

    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    if _last_sync_date != today_str:
        _synced_today_symbols.clear()
        _last_sync_date = today_str

    # Only sync recent delta once per day per symbol to keep chart opening ultra-fast (<10ms)
    needs_recent_sync = False
    if symbol not in _synced_today_symbols:
        if df is None or df.empty:
            needs_recent_sync = True
        else:
            last_dt = df.index[-1].strftime("%Y-%m-%d") if isinstance(df.index, pd.DatetimeIndex) else str(df.index[-1])[:10]
            if last_dt < today_str:
                needs_recent_sync = True

    if needs_recent_sync:
        _synced_today_symbols.add(symbol)
        recent_df = None

        # 1. Primary: Load progressive multi-year historical candles (up to 4 years) from Yahoo Finance (Zero hit to Kotak Neo orders)
        if df is None or df.empty or len(df) < 200:
            recent_df = fetch_yahoo_candles(symbol, years=4)

        # 2. Secondary fallback: Kotak Neo Historical API (only for short recent delta if Yahoo unavailable)
        if recent_df is None or recent_df.empty:
            try:
                from kotak_orders import get_kotak_candles
                recent_df = get_kotak_candles(symbol, days=90 if (df is not None and not df.empty) else 180)
                if recent_df is not None and not recent_df.empty:
                    print(f"[Swinger] Refreshed {len(recent_df)} live candles for {symbol} via Kotak Neo API")
            except Exception as e:
                print(f"[Swinger] Kotak candle fetch error for {symbol}: {e}")

        if recent_df is not None and not recent_df.empty:
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

    # Cap at last 1200 trading days (~5 years) for lightning fast rendering
    if not from_date and len(df) > 1200:
        df = df.tail(1200)

    candles = []
    try:
        d_strs = [d.strftime("%Y-%m-%d") if hasattr(d, "strftime") else str(d)[:10] for d in df.index]
        o_vals = np.round(df["Open"].fillna(0).values, 2)
        h_vals = np.round(df["High"].fillna(0).values, 2)
        l_vals = np.round(df["Low"].fillna(0).values, 2)
        c_vals = np.round(df["Close"].fillna(0).values, 2)
        v_vals = df["Volume"].fillna(0).astype(int).values

        for i in range(len(d_strs)):
            c_val = float(c_vals[i])
            if c_val <= 0 or np.isnan(c_val):
                continue
            o_val = float(o_vals[i]) if o_vals[i] > 0 else c_val
            h_val = float(h_vals[i]) if h_vals[i] > 0 else max(o_val, c_val)
            l_val = float(l_vals[i]) if l_vals[i] > 0 else min(o_val, c_val)
            candles.append({
                "time": d_strs[i],
                "open": o_val,
                "high": h_val,
                "low": l_val,
                "close": c_val,
                "volume": int(v_vals[i])
            })
    except Exception as e:
        print(f"[Swinger] Vectorized candle parse error for {symbol}: {e}")

    if not from_date and not to_date and candles:
        _formatted_candles_cache[symbol] = candles

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
    bt_trades = load_backtest_trades().get("trades", [])
    wl = load_watchlist().get("watchlist", [])
    
    pos_matches = [p for p in port if resolve_symbol(p.get("symbol", "")) == symbol]
    trade_matches = [t for t in closed_trades if resolve_symbol(t.get("symbol", "")) == symbol]
    bt_matches = [t for t in bt_trades if resolve_symbol(t.get("symbol", "")) == symbol]
    wl_matches = [w for w in wl if resolve_symbol(w.get("symbol", "")) == symbol]
    
    # 1. Collect all real trades (deduplicate closed trades across paper & backtest)
    all_symbol_trades = []
    active_intervals = []
    seen_closed_entries = set()
    combined_closed = []
    for t in trade_matches + bt_matches:
        ed = str(t.get("entry_date", ""))[:10]
        ep = round(float(t.get("entry_price") or t.get("avg_price") or 0.0), 2)
        key = (ed, ep)
        if key not in seen_closed_entries:
            seen_closed_entries.add(key)
            combined_closed.append(t)
    
    # Closed trades
    for t in combined_closed:
        t_leg = t.get("leg") or (2 if "LEG2" in str(t.get("strategy_leg", "")).upper() else 1)
        t_strat = t.get("strategy_leg") or ("LEG2_BASE_BREAKOUT" if t_leg == 2 else "LEG1_TURNAROUND")
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
                        "leg": ht.get("leg") or t_leg,
                        "strategy_leg": ht.get("strategy_leg") or t_strat,
                        "entry_type": ht.get("entry_type") or t.get("entry_type"),
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
                    "leg": t_leg,
                    "strategy_leg": t_strat,
                    "entry_type": t.get("entry_type"),
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
            p_leg = p.get("leg") or (2 if "LEG2" in str(p.get("strategy_leg", "")).upper() else 1)
            p_strat = p.get("strategy_leg") or ("LEG2_BASE_BREAKOUT" if p_leg == 2 else "LEG1_TURNAROUND")
            all_symbol_trades.append({
                "symbol": symbol,
                "name": p.get("name", symbol),
                "leg": p_leg,
                "strategy_leg": p_strat,
                "entry_type": p.get("entry_type"),
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
    for csv_name in ["chartink_verified_triggers.csv", "chartink_pure_triggers.csv", "chartink_swingernew_triggers.csv"]:
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

def scan_leg2_breakouts(price_data, held_symbols=None, min_consol_days=8, max_consol_days=45, min_vol_ratio=1.5, eligible_symbols=None):
    """
    Scans tracked universe for Leg 2 Post-Blast Consolidation Pullback setups:
    1. Institutional Footprint: Prior massive blast (+15% 3dRet or +7% 1dRet) with HUGE volume >= 3.0x SMA50 in past 10 to 45 trading days.
    2. Consolidation & Pullback: Stock pulls back / retraces by 30% to 45% of the blast move (or 10% to 25% from peak) over >= 8 trading days.
    3. Volume Dry-Up: During consolidation, average daily volume contracts significantly (< 0.85x SMA50).
    4. Entry Trigger: Today's candle is a Volume Green Candle (Close > Open, Close >= Close[-1], Volume >= 1.5x SMA50) bouncing off 20 EMA / 50 EMA.
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
        if s in held_symbols or len(df) < 100 or s in ['^NSEI', 'NIFTY']:
            continue
        if eligible_symbols and s not in eligible_symbols:
            continue
            
        c = df['Close'].values.astype(float)
        h = df['High'].values.astype(float)
        l = df['Low'].values.astype(float)
        o = df['Open'].values.astype(float)
        v = df['Volume'].values.astype(float)
        n = len(df)
        
        vol_sma50 = pd.Series(v).rolling(50, min_periods=20).mean().values
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
        
        # Turnaround Stair-Step: Must still be on the lower side (<= 65% of 500-1000 bar ATH)
        ath_lookback = min(n, 1000)
        ath_h = np.max(h[-ath_lookback:])
        cur_c = c[-1]
        if cur_c > ath_h * 0.65:
            continue
            
        # 1. Look for huge blast (>= 3.0x volume) in past 10 to 45 days
        for s_idx in range(n - 45, n - min_consol_days):
            if s_idx < 50:
                continue
            vsma = vol_sma50[s_idx]
            if vsma <= 0:
                continue
                
            is_blast_1d = (c[s_idx] / c[s_idx-1] - 1.0 >= 0.07) and (v[s_idx] >= 3.0 * vsma)
            is_blast_3d = (c[s_idx] / c[s_idx-3] - 1.0 >= 0.15) and (v[s_idx] >= 2.5 * vsma)
            
            if not (is_blast_1d or is_blast_3d):
                continue
                
            blast_peak = np.max(h[s_idx:min(s_idx+5, n-5)])
            blast_base = c[s_idx-1] if is_blast_1d else c[s_idx-3]
            blast_move = blast_peak - blast_base
            if blast_move <= 0:
                continue
                
            peak_idx = s_idx + int(np.argmax(h[s_idx:min(s_idx+5, n-5)]))
            consol_len = (n - 1) - peak_idx
            if consol_len < min_consol_days:
                continue
                
            consol_l = np.min(l[peak_idx+1:n-1])
            consol_h = np.max(h[peak_idx+1:n-1])
            consol_v_avg = np.mean(v[peak_idx+1:n-1])
            consol_vsma_avg = np.mean(vol_sma50[peak_idx+1:n-1])
            
            retrace_pct = (blast_peak - consol_l) / blast_move
            pullback_from_peak = (blast_peak - consol_l) / blast_peak
            vol_dryup = (consol_v_avg < 0.85 * consol_vsma_avg) if consol_vsma_avg > 0 else False
            
            cur_c = c[-1]; cur_o = o[-1]; cur_v = v[-1]; cur_vsma = vol_sma50[-1]
            cur_vr = cur_v / cur_vsma if cur_vsma > 0 else 1.0
            
            is_green = (cur_c > cur_o) and (cur_c >= c[-2])
            is_vol_surge = (cur_v >= min_vol_ratio * cur_vsma) if cur_vsma > 0 else False
            holds_support = (cur_c >= ema20[-1] * 0.98) and (cur_c >= ema50[-1] * 0.95)
            
            valid_retrace = (0.25 <= retrace_pct <= 0.50) or (0.10 <= pullback_from_peak <= 0.28)
            
            cur_dt_str = df.index[-1].strftime('%Y-%m-%d') if hasattr(df.index[-1], 'strftime') else str(df.index[-1])[:10]
            surge_dt_str = df.index[s_idx].strftime('%Y-%m-%d') if hasattr(df.index[s_idx], 'strftime') else str(df.index[s_idx])[:10]
            
            setup_dict = {
                'symbol': s,
                'name': s,
                'date': cur_dt_str,
                'leg': 2,
                'strategy_leg': 'LEG2_POST_BLAST_PULLBACK',
                'current_price': round(float(cur_c), 2),
                'base_high': round(float(consol_h), 2),
                'base_low': round(float(consol_l), 2),
                'surge_date': surge_dt_str,
                'consol_days': int(consol_len),
                'blast_vol_mult': round(float(v[s_idx] / vsma), 1),
                'retrace_pct': round(float(retrace_pct * 100), 1),
                'vol_dryup_ratio': round(float(consol_v_avg / (consol_vsma_avg or 1.0)), 2),
                'today_vol_mult': round(float(cur_vr), 1),
                'trigger_sl': round(float(l[-1]), 2),
                'status': 'TRIGGERED'
            }
            
            if valid_retrace and vol_dryup and is_green and is_vol_surge and holds_support:
                setup_dict['status'] = 'VOLUME GREEN TRIGGER'
                triggered.append(setup_dict)
                break
            elif valid_retrace and vol_dryup and holds_support:
                setup_dict['status'] = 'DRYING IN BASE'
                coiled.append(setup_dict)
                break
                
    triggered.sort(key=lambda x: x['today_vol_mult'], reverse=True)
    coiled.sort(key=lambda x: x['vol_dryup_ratio'])
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
    trail_pct = cfg.get("runner_trailing_stop_pct", 18.0)
    vol_loss_exit_enabled = cfg.get("vol_loss_exit_enabled", True)
    vol_loss_min_gain_pct = cfg.get("vol_loss_min_gain_pct", 20.0)
    vol_loss_vol_mult = cfg.get("vol_loss_vol_mult", 1.2)
    max_hold_days = cfg.get("max_hold_days", None)
    
    print(f"[Swinger Paper] Updating {len(open_positions)} open positions...")
    
    # Pre-fetch all open positions via Kotak Neo
    open_symbols = list(set([p["symbol"] for p in open_positions if "symbol" in p]))
    batch_market_data = {}
    for s in open_symbols:
        try:
            s_df = get_market_data(s)
            if s_df is not None and not s_df.empty:
                batch_market_data[s] = s_df
        except Exception as e:
            print(f"[Swinger] Market data fetch note for {s}: {e}")
            
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
        
    # --- SCAN CHARTINK FOR TODAY'S SIGNALS (LEG 1 + LEG 2) ---
    print("[Swinger Paper] Fetching daily Chartink scanner signals (Leg 1 & Leg 2)...")
    raw_signals_leg1 = fetch_chartink_signals(cfg.get("scan_clause"))
    for s in raw_signals_leg1:
        s["leg"] = 1
        s["strategy_leg"] = "LEG1_TURNAROUND"

    raw_signals_leg2 = fetch_chartink_signals(cfg.get("leg2_clause"))
    for s in raw_signals_leg2:
        s["leg"] = 2
        s["strategy_leg"] = "LEG2_BASE_BREAKOUT"

    raw_signals = raw_signals_leg1
    combined_signals = raw_signals_leg1 + raw_signals_leg2
    saved_sig = save_daily_signals(combined_signals)
    print(f"[Swinger Paper] Chartink returned {len(raw_signals_leg1)} Leg 1 and {len(raw_signals_leg2)} Leg 2 trigger candidates.")
    
    # --- FILL AVAILABLE SLOTS IN PAPER MODE ---
    is_paper = str(cfg.get("mode", "paper")).lower() == "paper"
    max_slots = 999 if is_paper else int(cfg.get("max_open_positions", 20))
    available_slots = max_slots - len(updated_positions)
    blacklist = set(cfg.get("blacklist", ["V2RETAIL"]))
    held_symbols = {p["symbol"] for p in updated_positions} | blacklist
    min_stars = cfg.get("min_star_rating", 4)

    # --- EVALUATE COOLDOWN RADAR (WATCHLIST) FOR RETRACEMENT ENTRIES ---
    cur_wl_data = load_watchlist()
    cur_wl = cur_wl_data.get("watchlist", [])
    remaining_wl = []

    if cfg.get("enabled", True):
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
            alert_px = float(item.get("alert_price", w_close))

            # Update live fields
            item["current_price"] = round(w_close, 2)
            item["ema20"] = round(w_ema20, 2)
            dist_20 = round((w_close - w_ema20) / w_ema20 * 100.0, 1) if w_ema20 > 0 else 0.0
            item["distance_to_ema20_pct"] = dist_20
            item["pullback_pct"] = round((w_close - alert_px) / alert_px * 100.0, 1) if alert_px > 0 else 0.0

            # 1. Invalidation Check: Did it break down below blast low?
            if w_close < blast_low:
                print(f"[Swinger Paper] Radar stock {w_sym} broke below blast low (Rs.{blast_low:.2f}). Dropping from radar.")
                continue

            # 2. Retracement Check: Did it reach pullback zone (target_pb with buffer or 20 EMA) while holding blast low?
            entry_buf = 1.0 + float(cfg.get("cooldown_entry_buffer_pct", 1.5)) / 100.0
            retrace_hit = (w_low <= target_pb * entry_buf or (w_ema20 > 0 and w_low <= w_ema20 * (entry_buf + 0.005))) and (w_close >= blast_low)
            item["cooldown_ready"] = bool(retrace_hit or abs(dist_20) <= 2.5)

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
                        "status": "ACTIVE",
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

            if item["cooldown_ready"]:
                item["status"] = "READY (Awaiting Slot)" if available_slots <= 0 else "AT 20 EMA SUPPORT"
            else:
                item["status"] = "COOLING TOWARDS 20 EMA" if dist_20 > 2.0 else "TESTING 20 EMA"

            remaining_wl.append(item)

    if cfg.get("enabled", True):
        for cand in raw_signals:
            sym = cand.get("nsecode") or cand.get("symbol")
            if not sym or sym in held_symbols:
                continue
                
            df = get_market_data(sym)
            if df is None or len(df) < 5:
                continue
                
            last_close = float(df["Close"].iloc[-1])
            min_price = float(cfg.get("min_stock_price", 20.0))
            if last_close < min_price:
                continue
                
            prev_close = float(df["Close"].iloc[-2]) if len(df) >= 2 else last_close
            candle_gain_pct = round(((last_close / prev_close) - 1.0) * 100.0, 2)
            max_direct_gain = float(cfg.get("max_direct_entry_gain_pct", 10.0))
            cur_ema20 = float(df["EMA20"].iloc[-1]) if "EMA20" in df else last_close
            dist_20 = round((last_close - cur_ema20) / cur_ema20 * 100.0, 1) if cur_ema20 > 0 else 0.0
            cur_c_dt = (df.index[-1].strftime("%Y-%m-%d") if hasattr(df.index[-1], "strftime") else str(df.index[-1])[:10]) if not df.empty else datetime.now(IST).strftime("%Y-%m-%d")
            b_open = float(df["Open"].iloc[-1]) if "Open" in df else last_close
            b_low = float(df["Low"].iloc[-1]) if "Low" in df else round(last_close * 0.90, 2)
            retrace_frac = float(cfg.get("cooldown_target_retrace_pct", 30.0)) / 100.0
            target_pb = round(last_close - retrace_frac * (last_close - b_open), 2)
            stars, star_details = calculate_setup_star_rating(df, sym)
            cand["stars"] = stars
            cand["star_details"] = star_details

            # Calculate RSI
            delta = df["Close"].diff()
            gain = delta.clip(lower=0).ewm(com=13, min_periods=14).mean()
            loss = (-delta.clip(upper=0)).ewm(com=13, min_periods=14).mean()
            rsi_val = float((100 - (100 / (1 + (gain / (loss + 1e-9))))).iloc[-1]) if len(df) >= 15 else 55.0

            # If slots are available and not overextended and stars qualified, enter directly
            if available_slots > 0 and candle_gain_pct <= max_direct_gain and stars >= min_stars:
                alloc_per_slot = cfg.get("base_position_size", 25000.0)
                qty = int(alloc_per_slot // last_close)
                if qty > 0:
                    trig_low = float(df["Low"].iloc[-1]) if ("Low" in df and len(df) > 0) else round(last_close * 0.95, 2)
                    initial_sl = round(last_close * (1.0 + initial_sl_pct / 100.0), 2)
                    be_trigger = round(last_close * (1.0 + be_shield_trigger_pct / 100.0), 2)
                    tp_target = round(last_close * (1.0 + tp_target_pct / 100.0), 2)
                    
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
                        "status": "ACTIVE",
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
                    continue

            # Otherwise, place on Cooldown Radar!
            if not any(w.get("symbol") == sym for w in remaining_wl):
                is_ready = bool(abs(dist_20) <= 2.5)
                status_text = "OVEREXTENDED BLAST" if candle_gain_pct > max_direct_gain else ("READY (Awaiting Slot)" if (available_slots <= 0 and is_ready) else "COOLING TOWARDS 20 EMA")
                reason_note = f"Leg 1 Turnaround (+{candle_gain_pct:.1f}%). {stars}-Star setup. {'Slots full - queued on radar.' if available_slots <= 0 else f'Waiting for retracement to ~Rs.{target_pb} (or 20 EMA).'}"
                print(f"[Swinger Paper] RADAR CANDIDATE (LEG 1): {sym} @ Rs.{last_close:.2f} ({status_text}) | Pullback Target: Rs.{target_pb:.2f}")
                remaining_wl.append({
                    "symbol": sym,
                    "name": cand.get("name", sym),
                    "alert_date": cur_c_dt,
                    "alert_price": round(last_close, 2),
                    "alert_gain_pct": candle_gain_pct,
                    "alert_rsi": round(rsi_val, 1),
                    "current_price": round(last_close, 2),
                    "current_rsi": round(rsi_val, 1),
                    "ema20": round(cur_ema20, 2),
                    "distance_to_ema20_pct": dist_20,
                    "pullback_pct": 0.0,
                    "target_pb_price": target_pb,
                    "blast_low": b_low,
                    "stars": stars,
                    "leg": 1,
                    "cooldown_ready": is_ready,
                    "status": status_text,
                    "notes": reason_note
                })

    # --- FILL REMAINING SLOTS WITH LEG 2 HIGH-BASE BREAKOUT CANDIDATES ---
    leg2_enabled = cfg.get("leg2_enabled", True)
    leg2_sl_pct = cfg.get("leg2_initial_sl_pct", -12.0)
    leg2_be_pct = cfg.get("leg2_be_trigger_pct", 10.0)
    alloc_per_slot = cfg.get("base_position_size", 25000.0)
    
    if leg2_enabled and cfg.get("enabled", True):
        try:
            trig_leg2 = []
            coiled_leg2 = []

            # 1. Primary: Live Real-Time Chartink Leg 2 Scanner (Whole NSE Market)
            chartink_leg2_raw = raw_signals_leg2
            if chartink_leg2_raw:
                print(f"[Swinger Paper] Live Chartink returned {len(chartink_leg2_raw)} Leg 2 breakout candidates: {[x.get('nsecode') for x in chartink_leg2_raw]}")
                for sig in chartink_leg2_raw:
                    s_sym = sig.get("nsecode")
                    if not s_sym or s_sym in held_symbols:
                        continue
                    m_df = get_market_data(s_sym)
                    if m_df is not None and len(m_df) >= 50:
                        cur_bar = m_df.iloc[-1]
                        c_p = float(cur_bar["Close"])
                        vol_now = float(cur_bar.get("Volume", 0))
                        vol_sma = float(cur_bar.get("VolSMA60", 0)) or 1.0
                        vol_mult = round(vol_now / vol_sma, 1)
                        trig_leg2.append({
                            "symbol": s_sym,
                            "name": sig.get("name", s_sym),
                            "date": datetime.now(IST).strftime("%Y-%m-%d"),
                            "leg": 2,
                            "strategy_leg": "LEG2_BASE_BREAKOUT",
                            "current_price": c_p,
                            "base_high": float(cur_bar["High"]),
                            "base_low": float(cur_bar["Low"]),
                            "surge_date": datetime.now(IST).strftime("%Y-%m-%d"),
                            "consol_days": 15,
                            "today_vol_mult": vol_mult,
                            "trigger_sl": round(float(cur_bar["Low"]), 2),
                            "status": "LIVE CHARTINK TRIGGER"
                        })

            # 2. Secondary Supplement: Local Cache Scanning (for Coiled Watchlist & Extra Setups)
            cache_p = ROOT / "scratch" / "universe_4y_prices.pkl"
            if cache_p.exists():
                with open(cache_p, "rb") as f:
                    u_data = pickle.load(f)
                cache_trig, cache_coiled = scan_leg2_breakouts(u_data, held_symbols=held_symbols, eligible_symbols=False)
                coiled_leg2.extend(cache_coiled)
                for ct in cache_trig:
                    if ct["symbol"] not in [x["symbol"] for x in trig_leg2] and ct["symbol"] not in held_symbols:
                        trig_leg2.append(ct)

            print(f"[Swinger Paper] Leg 2 Total: {len(trig_leg2)} breakouts triggering, {len(coiled_leg2)} coiled.")

            radar_file = ROOT / "paper" / "swinger" / "radar_leg2.json"
            with open(radar_file, "w", encoding="utf-8") as f:
                json.dump({"coiled": coiled_leg2, "updated_at": datetime.now(IST).isoformat()}, f, indent=2)

            for cand2 in trig_leg2:
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
                s_leg2 = cand2.get("strategy_leg", "LEG2_BASE_BREAKOUT")

                # If available slots exist, enter directly
                if available_slots > 0:
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
                        "status": "ACTIVE",
                        "runner_peak_price": c_p,
                        "runner_trail_sl": None,
                        "base_high": cand2.get("base_high", c_p),
                        "base_low": cand2.get("base_low", c_p),
                        "surge_date": cand2.get("surge_date", datetime.now(IST).strftime("%Y-%m-%d")),
                        "consol_days": cand2.get("consol_days", 15),
                        "days_held": 0,
                        "booked_pnl": 0.0,
                        "unrealized_pnl": 0.0,
                        "unrealized_pnl_pct": 0.0,
                        "unrealized_pct": 0.0,
                        "stars": 5,
                        "exit_rule": f"Leg 2 SL {leg2_sl_pct:.0f}% - BE Shield @ +{leg2_be_pct:.0f}% - 50 EMA Vol Breakdown + 20% Trail",
                        "peak_price": c_p
                    }
                    print(f"[Swinger Paper] NEW LEG 2 BREAKOUT BUY: {sym2} @ Rs.{c_p} | Ceiling: Rs.{cand2.get('base_high', c_p)} | Vol: {cand2.get('today_vol_mult', 1.5)}x | SL ({leg2_sl_pct:.0f}%): Rs.{sl2}")
                    updated_positions.append(new_pos2)
                    held_symbols.add(sym2)
                    available_slots -= 1
                    continue

                # Otherwise, place on Cooldown Radar!
                if not any(w.get("symbol") == sym2 for w in remaining_wl):
                    m_df2 = get_market_data(sym2)
                    ema20_2 = float(m_df2["EMA20"].iloc[-1]) if (m_df2 is not None and "EMA20" in m_df2) else c_p
                    dist_20_2 = round((c_p - ema20_2) / ema20_2 * 100.0, 1) if ema20_2 > 0 else 0.0
                    is_ready_2 = bool(abs(dist_20_2) <= 3.5)
                    delta2 = m_df2["Close"].diff() if m_df2 is not None else pd.Series([0])
                    gain2 = delta2.clip(lower=0).ewm(com=13, min_periods=14).mean()
                    loss2 = (-delta2.clip(upper=0)).ewm(com=13, min_periods=14).mean()
                    rsi_2 = float((100 - (100 / (1 + (gain2 / (loss2 + 1e-9))))).iloc[-1]) if len(m_df2) >= 15 else 58.0

                    print(f"[Swinger Paper] RADAR CANDIDATE (LEG 2): {sym2} @ Rs.{c_p:.2f} (Breakout trigger, awaiting slot)")
                    remaining_wl.append({
                        "symbol": sym2,
                        "name": cand2.get("name", sym2),
                        "alert_date": cand2.get("date", datetime.now(IST).strftime("%Y-%m-%d")),
                        "alert_price": round(c_p, 2),
                        "alert_gain_pct": round(cand2.get("today_vol_mult", 1.5) * 2.0, 1),
                        "alert_rsi": round(rsi_2, 1),
                        "current_price": round(c_p, 2),
                        "current_rsi": round(rsi_2, 1),
                        "ema20": round(ema20_2, 2),
                        "distance_to_ema20_pct": dist_20_2,
                        "pullback_pct": 0.0,
                        "target_pb_price": round(c_p * 0.95, 2),
                        "blast_low": trig_low2,
                        "stars": 5,
                        "leg": 2,
                        "cooldown_ready": is_ready_2,
                        "status": "READY (Awaiting Slot)" if is_ready_2 else "BASE BREAKOUT TRIGGERED",
                        "notes": f"Leg 2 Base Breakout. {cand2.get('today_vol_mult', 1.5)}x vol surge. {'Slots full - queued on radar.' if available_slots <= 0 else 'Breakout trigger queued.'}"
                    })

        except Exception as e:
            print(f"[Swinger Paper] Error during Leg 2 scan: {e}")

    # Always persist updated Radar Watchlist
    cur_wl_data["watchlist"] = remaining_wl
    cur_wl_data["last_updated"] = datetime.now(IST).isoformat()
    save_watchlist(cur_wl_data)

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
    save_trades(trade_db, updated_positions)
        # Telegram notifications disabled for swinger positions (FnO only)
        # try:
        #     from telegram_notifier import notify_swinger_trade_exit
        #     for ct in closed_this_cycle:
        #         notify_swinger_trade_exit(...)
        # except Exception:
        #     pass
        
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
    runner_trail_pct: float = 18.0,
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
        leg1_dates = set()
    else:
        # Leg 1: Phoenix Turnaround Breakout (< 40% of 1000-day ATH & < 200 EMA)
        leg1_mask = (
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
        leg1_dates = set(df.index[leg1_mask].strftime('%Y-%m-%d'))

        # Leg 2: Post-Blast Consolidation Base Breakout / MA Pullback Bounce
        # (Within 65% of ATH, prior institutional blast in past 8-50 days, volume dry-up, green expansion today)
        peak_500 = h.rolling(500, min_periods=30).max()
        vol_max_45 = v.shift(8).rolling(45, min_periods=10).max()
        vsma_min_45 = vol_sma50.shift(8).rolling(45, min_periods=10).min()
        c_max_45 = c.shift(8).rolling(45, min_periods=10).max()
        c_min_45 = c.shift(8).rolling(45, min_periods=10).min()
        vol_sma10 = v.rolling(10, min_periods=5).mean()
        vol_sma20 = v.rolling(20, min_periods=10).mean()

        leg2_mask = (
            ((c <= peak_high * 0.65) | (c <= peak_500 * 0.65)) &
            (c >= 20.0) &
            (c > o) &
            (c >= prev_c) &
            ((v >= vol_sma50 * 1.4) | (v >= vol_sma20 * 1.4)) &
            (c >= ema20 * 0.99) &
            (vol_max_45 >= vsma_min_45 * 2.5) &
            (c_max_45 >= c_min_45 * 1.12) &
            (vol_sma10.shift(1) <= vol_sma50.shift(1) * 1.1)
        )

        combined_mask = leg1_mask | leg2_mask
        trig_set = set(df.index[combined_mask].strftime('%Y-%m-%d'))

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
                        is_leg1 = pending_radar['blast_date'] in leg1_dates
                        cur = {
                            'symbol': symbol,
                            'name': symbol,
                            'leg': 1 if is_leg1 else 2,
                            'strategy_leg': 'LEG1_TURNAROUND' if is_leg1 else 'LEG2_BASE_BREAKOUT',
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
                        is_leg1 = dt_str in leg1_dates
                        cur = {
                            'symbol': symbol,
                            'name': symbol,
                            'leg': 1 if is_leg1 else 2,
                            'strategy_leg': 'LEG1_TURNAROUND' if is_leg1 else 'LEG2_BASE_BREAKOUT',
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
        runner_trail_pct = float(cfg.get("runner_trailing_stop_pct", 18.0))
    max_direct_gain = float(cfg.get("max_direct_entry_gain_pct", 10.0))
    if max_direct_gain <= 0:
        max_direct_gain = 10.0  # Standard calibrated Phoenix Swinger rule: clean breakouts <= 10% enter directly
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

    # 1. Primary: If df is missing or shorter than 250 bars (e.g. only 180-day slice),
    # fetch multi-year historical candles (up to 4 years / ~1000 bars) progressively from Yahoo Finance.
    # This prevents hitting Kotak Neo historical API and eliminates rate limit interference with live orders.
    if df is None or len(df) < 250:
        y_df = fetch_yahoo_candles(resolved_sym, years=4)
        if y_df is not None and not y_df.empty:
            if df is not None and not df.empty:
                df = df.copy()
                if not isinstance(df.index, pd.DatetimeIndex):
                    df.index = pd.to_datetime(df.index)
                df.index = df.index.tz_localize(None)
                combined = pd.concat([y_df.loc[y_df.index < df.index[0]], df])
                df = combined[~combined.index.duplicated(keep="last")].sort_index()
            else:
                df = y_df
            if _candles_cache is not None:
                _candles_cache[resolved_sym] = df
            print(f"[OnDemand Backtest] Progressively loaded {len(df)} multi-year candles for {resolved_sym} via Yahoo (Zero Kotak Neo hit)")

    # 2. Append today's candle from daily signals if present without hitting Kotak
    try:
        ds = load_daily_signals()
        for sig in ds.get("signals", []):
            if sig.get("nsecode") == resolved_sym:
                s_date = ds.get("last_scan_time", "")[:10]
                s_dt = pd.to_datetime(s_date)
                if df is not None and not df.empty and s_dt not in df.index and s_dt >= df.index[-1]:
                    c_p = float(sig.get("close", 0))
                    v_p = int(sig.get("volume", 0))
                    if c_p > 0:
                        extra_row = pd.DataFrame([{
                            "Open": c_p * (1.0 - (float(sig.get("per_chg", 0)) / 100.0)),
                            "High": max(c_p, c_p * 1.01),
                            "Low": min(c_p, c_p * 0.99),
                            "Close": c_p,
                            "Volume": v_p
                        }], index=[s_dt])
                        df = pd.concat([df, extra_row])
    except Exception:
        pass

    # 3. Fallback: only if df is still missing or < 50 bars, try Kotak
    if df is None or len(df) < 50:
        try:
            from kotak_orders import get_kotak_candles
            kotak_df = get_kotak_candles(resolved_sym, days=180)
            if kotak_df is not None and not kotak_df.empty:
                df = kotak_df
        except Exception:
            pass

    if df is None or len(df) < 50:
        return {"ok": False, "error": f"Insufficient price data available for {symbol} (at least 50 trading days required)"}

    # Restrict to calibrated 4-year universe period (~1000-1200 trading days)
    # This prevents running backtests across 30-year unindexed historical artifacts (e.g. 1996 data)
    # while ensuring every simulated trade has corresponding chart candles and exact Kotak Neo levels.
    if len(df) > 1200:
        df = df.iloc[-1200:].copy()

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

    # Fast vectorized candle payload (capped at last 1200 bars for instant UI rendering)
    plot_df = df.tail(1200) if len(df) > 1200 else df
    d_strs = [d.strftime('%Y-%m-%d') if hasattr(d, 'strftime') else str(d)[:10] for d in plot_df.index]
    o_vals = np.round(plot_df['Open'].fillna(0).values, 2)
    h_vals = np.round(plot_df['High'].fillna(0).values, 2)
    l_vals = np.round(plot_df['Low'].fillna(0).values, 2)
    c_vals = np.round(plot_df['Close'].fillna(0).values, 2)
    v_vals = plot_df['Volume'].fillna(0).astype(int).values

    candles_payload = [
        {
            "time": d_strs[i],
            "open": float(o_vals[i]),
            "high": float(h_vals[i]),
            "low": float(l_vals[i]),
            "close": float(c_vals[i]),
            "volume": int(v_vals[i])
        }
        for i in range(len(d_strs))
        if float(c_vals[i]) > 0
    ]

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

def generate_backtest_ledger(trigs_filename="chartink_verified_triggers.csv"):
    """
    Generates the complete authoritative Swinger backtest ledger over Chartink triggers.
    Enforces UNLIMITED slots, strict >10% cooldown radar retracement,
    and calibrated Leg 2 Base Breakout engine strictly for stocks that completed Leg 1.
    Saves to paper/swinger/trades.json, paper/swinger/backtest_trades.json, and paper/swinger/portfolio.json.
    """
    import pickle
    import csv

    # 1. Load Ground-Truth Chartink Triggers
    trigs_csv = ROOT / "scratch" / trigs_filename
    if not trigs_csv.exists():
        print(f"[Swinger Backtest] {trigs_filename} not found!")
        return None

    df_trigs = pd.read_csv(trigs_csv)
    df_trigs["date"] = pd.to_datetime(df_trigs["date"])
    df_trigs.sort_values(by=["date", "symbol"], inplace=True)

    # 2. Load Price Databases
    price_data = {}
    for pkl_name in ["universe_down_50_prices.pkl", "testnik_all_prices.pkl", "universe_4y_prices.pkl"]:
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
        
        c = df["Close"].ffill().bfill().values.astype(float)
        h = df["High"].ffill().bfill().values.astype(float)
        l = df["Low"].ffill().bfill().values.astype(float)
        o = df["Open"].ffill().bfill().values.astype(float)
        v = df["Volume"].fillna(0).values.astype(float)
        dates = [d.strftime("%Y-%m-%d") for d in df.index]
        
        vol_sma50 = pd.Series(v).rolling(50, min_periods=20).mean().values
        vol_sma20 = pd.Series(v).rolling(20, min_periods=10).mean().values
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
        
        stock_bars[s] = {
            "dates": dates,
            "date_map": {d: i for i, d in enumerate(dates)},
            "c": c, "h": h, "l": l, "o": o, "v": v,
            "ema20": ema20, "ema50": ema50,
            "vol_sma50": vol_sma50,
            "vol_sma20": vol_sma20
        }

    # Parameters
    cfg = load_config()
    SLOT_SIZE = float(cfg.get("base_position_size", 25000.0))
    INITIAL_SL_PCT = float(cfg.get("initial_sl_pct", -15.0))
    BE_SHIELD_PCT = float(cfg.get("be_shield_trigger_pct", 15.0))
    RUNNER_TRIGGER_PCT = 20.0
    RUNNER_TRAIL_PCT = float(cfg.get("runner_trailing_stop_pct", 25.0))
    MAX_DIRECT_GAIN = float(cfg.get("max_direct_entry_gain_pct", 0.0))

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
    leg2_radar = {}
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
            e20 = float(b["ema20"][i])
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

            is_l2 = (pos.get("leg") == 2)
            be_trig = 10.0 if is_l2 else BE_SHIELD_PCT
            trail_pct = float(cfg.get("leg2_trail_sl_pct", 18.0)) if is_l2 else RUNNER_TRAIL_PCT
            
            # Check BE Shield trigger
            if peak_gain_pct >= be_trig and not pos["be_active"]:
                pos["be_active"] = True
                pos["sl_price"] = round(entry_p * 1.005, 2)
                
            # Check Runner Mode trigger
            if peak_gain_pct >= RUNNER_TRIGGER_PCT and not pos["runner_mode"]:
                pos["runner_mode"] = True
                pos["tp_hit"] = True
                
            exited = False
            exit_p = None
            exit_reason = None
            
            # Exit checks
            if not pos["runner_mode"]:
                # Early cut for Leg 1 failing momentum within 12 sessions
                if not is_l2 and pos["bars_held"] >= 3 and pos["bars_held"] <= 12 and c < e20 and vsma50 > 0 and v >= 1.0 * vsma50:
                    exited = True
                    exit_p = c
                    exit_reason = "10-Day 20 EMA Momentum Eject"
                elif l <= pos["sl_price"]:
                    exited = True
                    exit_p = min(o, pos["sl_price"]) if o < pos["sl_price"] else pos["sl_price"]
                    sl_label = pos.get("initial_sl_pct", INITIAL_SL_PCT)
                    exit_reason = "BE Shield (+0.5%)" if pos["be_active"] else f"Initial SL ({sl_label:.0f}%)"
            else:
                runner_stop = pos["highest_close"] * (1.0 - trail_pct / 100.0)
                pos["runner_trail_sl"] = round(runner_stop, 2)
                if l <= runner_stop:
                    exited = True
                    exit_p = min(o, runner_stop) if o < runner_stop else runner_stop
                    exit_reason = f"Peak Trail ({trail_pct:.0f}%)"
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
                    "highest_close": round(pos["highest_close"], 2),
                    "peak_gain_pct": round((pos["peak_price"] - entry_p) / entry_p * 100.0, 1),
                    "reason": exit_reason,
                    "exit_reason": exit_reason,
                    "status": "WIN" if pnl > 0 else "LOSS",
                    "leg": pos.get("leg", 1),
                    "strategy_leg": pos.get("strategy_leg", "LEG1_TURNAROUND"),
                    "breakout_candle_gain": pos.get("breakout_candle_gain", 0.0),
                    "entry_type": pos.get("entry_type", "DIRECT_BREAKOUT")
                })
                trade_id += 1

                # USER RULE: On Leg 1 exit, ONLY proven runners (peak gain >= 30%) qualify for Leg 2 Radar!
                l1_peak_gain = round((pos["highest_close"] - entry_p) / entry_p * 100.0, 1)
                min_l1_gain = float(cfg.get("leg2_min_leg1_gain_pct", 30.0))
                if pos.get("leg") == 1 and l1_peak_gain >= min_l1_gain:
                    leg2_radar[s] = {
                        "exit_date": cur_date,
                        "exit_i": i,
                        "exit_price": exit_p,
                        "peak_price": pos["peak_price"],
                        "base_low": l,
                        "base_high": h,
                        "entry_p": entry_p,
                        "l1_peak_gain": l1_peak_gain
                    }
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
                
            # Retracement check: Touches pullback zone (with buffer) or 20 EMA AND stabilizes
            entry_buf = 1.0 + float(cfg.get("cooldown_entry_buffer_pct", 1.5)) / 100.0
            retrace_touched = (r_l <= r_item["target_pb"] * entry_buf or r_l <= r_e20 * (entry_buf + 0.005))
            stabilized = (r_c >= r_o or r_c >= r_e20) and (r_c >= r_item["blast_low"])
            
            if retrace_touched and stabilized and r_s not in held_syms:
                entry_p = min(r_c, r_item["target_pb"] * entry_buf)
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
                        "status": "ACTIVE",
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
            
            # STRICT COOLDOWN ONLY RULE: Zero Direct Buys!
            # Every screener trigger MUST wait on Cooldown Radar for pullback & stabilization!
            retrace_frac = float(cfg.get("cooldown_target_retrace_pct", 40.0)) / 100.0
            target_pb = round(c - retrace_frac * (c - o), 2)
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

        # D. Process Leg 2 Entries (ON EXITED PROVEN LEG 1 RUNNERS ONLY & "STILL LOW")
        min_cooldown = int(cfg.get("leg2_min_cooldown_days", 12))
        max_cooldown = int(cfg.get("leg2_max_cooldown_days", 90))
        min_retrace = float(cfg.get("leg2_min_retrace_from_peak_pct", 25.0))
        max_dist_base = float(cfg.get("leg2_max_dist_from_base_low_pct", 18.0))

        for s, r_info in list(leg2_radar.items()):
            if s in held_syms:
                continue
            b = stock_bars.get(s)
            if not b or cur_date not in b["date_map"]:
                continue
            i = b["date_map"][cur_date]
            days_since = i - r_info["exit_i"]

            # Must consolidate for at least min_cooldown sessions
            if days_since < min_cooldown:
                r_info["base_low"] = min(r_info["base_low"], float(b["l"][i]))
                r_info["base_high"] = max(r_info["base_high"], float(b["h"][i]))
                continue

            # Expire after max_cooldown sessions (allows "old little bit older" up to 90 sessions)
            if days_since > max_cooldown:
                del leg2_radar[s]
                continue

            c = float(b["c"][i]); o = float(b["o"][i]); l = float(b["l"][i]); h = float(b["h"][i]); v = float(b["v"][i])
            e20 = float(b["ema20"][i]); e50 = float(b["ema50"][i]); vsma50 = float(b["vol_sma50"][i]); vsma20 = float(b["vol_sma20"][i])
            prev_c = float(b["c"][i-1])

            # Invalidation: Drops below Leg 1 entry price
            if c < r_info.get("entry_p", 0.0) * 0.95:
                del leg2_radar[s]
                continue

            # "STILL LOW" CRITERIA:
            peak_p = r_info.get("peak_price", r_info["exit_price"])
            retrace_from_peak_pct = (peak_p - c) / peak_p * 100.0
            is_cooled_down = (retrace_from_peak_pct >= min_retrace)

            dist_from_base_low_pct = (c - r_info["base_low"]) / r_info["base_low"] * 100.0
            is_still_low = (dist_from_base_low_pct <= max_dist_base)

            is_green = (c > o) and (c >= prev_c * 1.025)
            holds_trend = (c >= e20 * 0.97) and (c >= e50 * 0.92)
            vol_surge = (vsma50 > 0 and v >= 1.4 * vsma50) or (vsma20 > 0 and v >= 1.4 * vsma20)

            if is_cooled_down and is_still_low and is_green and holds_trend and vol_surge:
                qty = int(SLOT_SIZE // c) if c > 0 else 0
                if qty > 0:
                    base_l = min(r_info["base_low"], l)
                    sl_pct = (base_l / c - 1.0) * 100.0
                    sl_initial = round(c * 0.92, 2) if sl_pct < -8.0 else round(c * 0.96, 2) if sl_pct > -4.0 else round(base_l, 2)
                    day_gain_pct = round((c / prev_c - 1.0) * 100.0, 1)
                    new_pos = {
                        "symbol": s,
                        "name": s,
                        "leg": 2,
                        "strategy_leg": "LEG2_COOLOFF_BREAKOUT",
                        "entry_date": cur_date,
                        "entry_price": round(c, 2),
                        "avg_price": round(c, 2),
                        "cmp": round(c, 2),
                        "shares": qty,
                        "initial_qty": qty,
                        "current_qty": qty,
                        "invested": round(qty * c, 2),
                        "initial_sl_pct": -8.0,
                        "sl_price": sl_initial,
                        "be_active": False,
                        "be_trigger_price": round(c * 1.10, 2),
                        "tp_hit": False,
                        "tp_target_price": round(c * 1.30, 2),
                        "runner_mode": False,
                        "status": "ACTIVE",
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
                        "ema20": round(e20, 2),
                        "ema50": round(e50, 2),
                        "runner_trail_sl": sl_initial,
                        "breakout_candle_gain": day_gain_pct,
                        "entry_type": "LEG2_BASE_BREAKOUT",
                        "notes": f"Leg 2 Entry (Proven Leg 1 +{r_info['l1_peak_gain']:.0f}% runner | Cooled -{retrace_from_peak_pct:.0f}% from peak | +{dist_from_base_low_pct:.1f}% from base low)"
                    }
                    open_positions.append(new_pos)
                    held_syms.add(s)
                    del leg2_radar[s]
            else:
                r_info["base_low"] = min(r_info["base_low"], l)
                r_info["base_high"] = max(r_info["base_high"], h)

    # Save active leg2 radar for UI display & watchlist
    radar_list = []
    last_dt = all_sim_dates[-1] if all_sim_dates else ""
    for s, r in leg2_radar.items():
        b = stock_bars.get(s)
        if b and last_dt in b["date_map"]:
            i = b["date_map"][last_dt]
            radar_list.append({
                "symbol": s,
                "exit_date": r["exit_date"],
                "days_in_cooldown": i - r["exit_i"],
                "base_low": round(r["base_low"], 2),
                "base_high": round(r["base_high"], 2),
                "cmp": round(float(b["c"][i]), 2),
                "ema20": round(float(b["ema20"][i]), 2),
                "ema50": round(float(b["ema50"][i]), 2),
                "status": "COOLING_DOWN" if (i - r["exit_i"]) < 8 else "READY_FOR_BREAKOUT"
            })
    try:
        radar_file = ROOT / "paper" / "swinger" / "radar_leg2.json"
        with open(radar_file, "w", encoding="utf-8") as f:
            json.dump({"coiled": radar_list, "radar": radar_list, "updated_at": datetime.now(IST).isoformat()}, f, indent=2)
            
        # Update Watchlist for UI with Leg 2 Cooldown candidates including JINDWORLD
        wl_candidates = []
        for r_item in radar_list:
            wl_candidates.append({
                "symbol": r_item["symbol"],
                "name": r_item["symbol"],
                "alert_date": r_item["exit_date"],
                "alert_price": r_item["base_high"],
                "alert_rsi": 55.0,
                "current_price": r_item["cmp"],
                "current_rsi": 52.0,
                "ema20": r_item["ema20"],
                "distance_to_ema20_pct": round((r_item["cmp"] / r_item["ema20"] - 1.0) * 100.0, 1) if r_item["ema20"] > 0 else 0.0,
                "pullback_pct": round((r_item["cmp"] / r_item["base_high"] - 1.0) * 100.0, 1) if r_item["base_high"] > 0 else 0.0,
                "status": "LEG 2 COOLDOWN" if r_item["days_in_cooldown"] < 8 else "READY FOR 2ND LEG",
                "cooldown_ready": r_item["days_in_cooldown"] >= 8,
                "notes": f"Exited Leg 1; consolidated {r_item['days_in_cooldown']}d in base (Rs. {r_item['base_low']} - {r_item['base_high']}). Waiting for 2nd leg blast!"
            })
        if wl_candidates:
            save_watchlist({"watchlist": wl_candidates})
    except Exception as e:
        print(f"[Swinger Backtest] Warning saving radar/watchlist: {e}")

    # Write portfolio first
    tot_inv = round(sum(p["invested"] for p in open_positions), 2)
    valid_unreal = [p["unrealized_pnl"] for p in open_positions if not np.isnan(p.get("unrealized_pnl", 0.0))]
    tot_unreal = round(sum(valid_unreal), 2)

    portfolio_out = {
        "positions": open_positions,
        "total_open": len(open_positions),
        "total_invested": tot_inv,
        "total_unrealized_pnl": tot_unreal,
        "last_updated": datetime.now(IST).isoformat()
    }
    with open(PORTFOLIO_FILE, "w", encoding="utf-8") as f:
        json.dump(portfolio_out, f, indent=2)

    # Save to backtest_trades.json and sync trades.json with active positions passed
    trades_dict = {"trades": closed_trades}
    save_backtest_trades(trades_dict, open_positions)
    save_trades(trades_dict, open_positions)

    print(f"[Swinger Backtest] Successfully generated ledger: {len(closed_trades)} closed trades, {len(open_positions)} open positions.")
    return closed_trades, open_positions

if __name__ == "__main__":
    print("[Swinger Paper] Running Phoenix Swinger engine manual cycle...")
    res = update_positions_and_scan()
    print("[Swinger Paper] Done.")
