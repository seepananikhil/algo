"""
Swinger Engine Backtesting Simulator
Replicates the exact Chartink 'swingernew' formula across historical 4-year daily NSE data.

Usage:
    python swinger_backtest.py                     # Runs with default config (15 slots, Rs. 25k)
    python swinger_backtest.py --slots unlimited  # Runs unconstrained unlimited slots
    python swinger_backtest.py --slots 20         # Runs with 20 slots
    python swinger_backtest.py --export           # Exports to paper/swinger/trades.json
"""

import pickle
import json
import argparse
import sys
from pathlib import Path
from datetime import datetime
from collections import defaultdict
import pandas as pd
import numpy as np

ROOT = Path(__file__).resolve().parent

def load_data():
    prices_path = ROOT / "scratch" / "universe_4y_prices.pkl"
    prices_extra_path = ROOT / "scratch" / "universe_down_50_prices.pkl"
    mcap_path = ROOT / "scratch" / "marketcap_2000_symbols.json"
    
    with open(prices_path, "rb") as f:
        price_data = pickle.load(f)
        
    if prices_extra_path.exists():
        with open(prices_extra_path, "rb") as f:
            extra = pickle.load(f)
            for s, df in extra.items():
                if s not in price_data or len(df) > len(price_data[s]):
                    price_data[s] = df
                    
    with open(mcap_path, "r") as f:
        mcap_2000 = set(json.load(f))
        
    return price_data, mcap_2000

def load_config():
    cfg_path = ROOT / "swinger_config.json"
    with open(cfg_path, "r") as f:
        return json.load(f)

def precompute_indicators(price_data, mcap_2000, blacklist=None):
    blacklist = blacklist or {"V2RETAIL", "^NSEI", "NIFTY"}
    stock_bars = {}
    
    for s, df in price_data.items():
        if len(df) < 100 or s in blacklist or s not in mcap_2000:
            continue
        df = df.copy()
        if not isinstance(df.index, pd.DatetimeIndex):
            df.index = pd.to_datetime(df.index)
        df.index = df.index.tz_localize(None)
        df = df.sort_index()
        
        c = df["Close"].values
        h = df["High"].values
        l = df["Low"].values
        o = df["Open"].values
        v = df["Volume"].values
        dates = df.index
        n = len(df)
        if n < 100: continue
        
        vol_sma60 = pd.Series(v).rolling(60, min_periods=20).mean().values
        vr60 = np.where(vol_sma60 > 0, v / vol_sma60, 0.0)
        ema20 = pd.Series(c).ewm(span=20, adjust=False).mean().values
        ema50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
        max_1000 = pd.Series(h).rolling(1000, min_periods=50).max().values
        
        # RSI 14
        delta = pd.Series(c).diff().values
        gain = pd.Series(np.where(delta > 0, delta, 0)).rolling(14, min_periods=10).mean().values
        loss = pd.Series(np.where(delta < 0, -delta, 0)).rolling(14, min_periods=10).mean().values
        rs = np.where(loss > 0, gain / loss, 1.0)
        rsi = 100.0 - (100.0 / (1.0 + rs))
        prev_c = np.roll(c, 1)
        pct_chg = np.where(prev_c > 0, (c - prev_c) / prev_c * 100.0, 0.0)
        prev_rsi = np.roll(rsi, 1)
        rng = h - l
        strong_close = np.where(rng > 0, (c - l) >= (rng * 0.65), True)
        
        # EXACT CHARTINK 'swingernew' CLAUSE:
        # Base: 60% Capitulation, Mcap > 2000, Price >= 20, Green candle
        base_cond = (c <= max_1000 * 0.40) & (c >= 20.0) & (c > o)
        
        # Engine 1: +10% Circuit Blast, Volume >= 3.5x, RSI > 54
        path_a = (pct_chg >= 10.0) & (vr60 >= 3.5) & (rsi > 54.0)
        
        # Engine 2: Precision +5% Breakout, Volume >= 1.5x, 54 < RSI <= 72, Prior RSI <= 60, > 20 EMA, Upper 65% Wick
        path_b = (pct_chg >= 5.0) & (vr60 >= 1.5) & (rsi > 54.0) & (rsi <= 72.0) & (prev_rsi <= 60.0) & (c > ema20) & strong_close
        
        trigger_mask = base_cond & (path_a | path_b)
        
        stock_bars[s] = {
            "dates": dates,
            "date_map": {d.strftime("%Y-%m-%d"): i for i, d in enumerate(dates)},
            "c": c, "h": h, "l": l, "o": o, "v": v,
            "e50": ema50, "vsma50": vol_sma60,
            "mask": trigger_mask, "n": n
        }
        
    return stock_bars

def run_backtest(stock_bars, max_slots=15, slot_size=25000.0, sim_start="2022-01-01", runner_trail_pct=18.0):
    dt_sim_start = pd.to_datetime(sim_start)
    all_market_dates = sorted(list(set(d for b in stock_bars.values() for d in b["dates"] if d >= dt_sim_start)))
    
    # Pre-extract all signals
    signals = []
    for s, b in stock_bars.items():
        dates = b["dates"]
        idxs = np.where(b["mask"])[0]
        last_i = -999
        for i in idxs:
            if i <= last_i + 20: continue
            if dates[i] >= dt_sim_start:
                signals.append({"symbol": s, "date": dates[i], "price": b["c"][i]})
                last_i = i
                
    sig_by_date = {}
    for sig in signals:
        sig_by_date.setdefault(sig["date"].strftime("%Y-%m-%d"), []).append(sig)
        
    positions = []
    closed = []
    trade_id = 1
    daily_slots = []
    
    for cur_dt in all_market_dates:
        cur_str = cur_dt.strftime("%Y-%m-%d")
        
        # 1. Evaluate open position exits
        surviving = []
        for pos in positions:
            s = pos["symbol"]
            b = stock_bars[s]
            i = b["date_map"].get(cur_str)
            if i is None:
                surviving.append(pos)
                continue
                
            c = b["c"][i]; h = b["h"][i]; l = b["l"][i]; o = b["o"][i]; v = b["v"][i]
            e50 = b["e50"][i]; vsma50 = b["vsma50"][i]
            entry_p = pos["entry_price"]
            pos["days_held"] += 1
            pos["bars_held"] += 1
            if h > pos["highest_high"]: pos["highest_high"] = h
            if c > pos["highest_close"]: pos["highest_close"] = c
            
            high_ret = (pos["highest_close"] - entry_p) / entry_p * 100.0
            exited = False; exit_p = None; exit_reason = None
            
            # Risk controls:
            if not pos["runner_mode"]:
                if pos.get("be_shield_active", False) and l <= entry_p * 1.01:
                    exited = True
                    exit_p = min(o, entry_p * 1.01) if o < entry_p * 1.01 else entry_p * 1.01
                    exit_reason = "BE Shield Stop (+1%)"
                elif c <= entry_p * 0.88:
                    exited = True
                    exit_p = c
                    exit_reason = "Initial SL (-12% Close)"
            else:
                peak_trail = pos["runner_peak"] * (1.0 - runner_trail_pct / 100.0)
                if l <= peak_trail:
                    exited = True
                    exit_p = min(o, peak_trail) if o < peak_trail else peak_trail
                    exit_reason = f"Peak Trail Stop ({int(runner_trail_pct)}%)"
                elif pos["bars_held"] >= 10 and c < e50 and vsma50 > 0 and v > 1.2 * vsma50:
                    exited = True
                    exit_p = c
                    exit_reason = "50 EMA Institutional Vol Breakdown"
                    
            if exited:
                pnl = round(pos["shares"] * (exit_p - entry_p), 2)
                pnl_pct = round((exit_p / entry_p - 1.0) * 100.0, 2)
                closed.append({
                    "trade_id": trade_id, "symbol": s,
                    "entry_date": pos["entry_date"].strftime("%Y-%m-%d"),
                    "exit_date": cur_str,
                    "entry_price": round(entry_p, 2), "exit_price": round(exit_p, 2),
                    "shares": pos["shares"], "pnl": pnl, "pnl_pct": pnl_pct,
                    "days_held": pos["days_held"], "reason": exit_reason
                })
                trade_id += 1
            else:
                if high_ret >= 15.0: pos["be_shield_active"] = True
                if high_ret >= 20.0 and not pos["runner_mode"]:
                    pos["runner_mode"] = True
                    pos["runner_peak"] = pos["highest_close"]
                elif pos["runner_mode"] and pos["highest_close"] > pos["runner_peak"]:
                    pos["runner_peak"] = pos["highest_close"]
                surviving.append(pos)
                
        positions = surviving
        
        # 2. Enter new signals
        daily_sigs = sig_by_date.get(cur_str, [])
        if daily_sigs and len(positions) < max_slots:
            held = set(p["symbol"] for p in positions)
            for sig in daily_sigs:
                s = sig["symbol"]
                if s in held: continue
                if len(positions) >= max_slots: break
                p = sig["price"]
                if p <= 0: continue
                shs = int(slot_size / p)
                if shs < 1: continue
                positions.append({
                    "symbol": s, "entry_date": cur_dt, "entry_price": p,
                    "shares": shs, "highest_high": p, "highest_close": p,
                    "days_held": 0, "bars_held": 0, "runner_mode": False, "be_shield_active": False
                })
                held.add(s)
        daily_slots.append(len(positions))

    wins = [t for t in closed if t["pnl"] > 0]
    losses = [t for t in closed if t["pnl"] <= 0]
    wr = len(wins) / len(closed) * 100.0 if closed else 0.0
    gw = sum(t["pnl"] for t in wins)
    gl = abs(sum(t["pnl"] for t in losses))
    pf = gw / gl if gl > 0 else 99.0
    tot_pnl = sum(t["pnl"] for t in closed)
    
    # Calculate open positions unrealized
    u_pnl = 0.0
    open_details = []
    for p in positions:
        b = stock_bars.get(p["symbol"])
        if b and len(b["c"]) > 0:
            last_c = b["c"][-1]
            pnl_val = round(p["shares"] * (last_c - p["entry_price"]), 2)
            pct_val = round((last_c / p["entry_price"] - 1.0) * 100.0, 2)
            u_pnl += pnl_val
            open_details.append({
                "symbol": p["symbol"], "entry_date": p["entry_date"].strftime("%Y-%m-%d"),
                "entry_price": p["entry_price"], "current_price": round(last_c, 2),
                "shares": p["shares"], "pnl": pnl_val, "pnl_pct": pct_val,
                "runner_mode": p["runner_mode"], "be_shield_active": p["be_shield_active"]
            })
            
    # Yearly breakdown
    years = sorted(list(set((t["exit_date"] or "")[:4] for t in closed if t.get("exit_date"))))
    yearly = {}
    for yr in years:
        yt = [t for t in closed if (t["exit_date"] or "").startswith(yr)]
        ypnl = sum(t["pnl"] for t in yt)
        yw = len([t for t in yt if t["pnl"] > 0])
        yl = len([t for t in yt if t["pnl"] <= 0])
        ywr = yw / len(yt) * 100.0 if yt else 0.0
        gw_y = sum(t["pnl"] for t in yt if t["pnl"] > 0)
        gl_y = abs(sum(t["pnl"] for t in yt if t["pnl"] <= 0))
        ypf = gw_y / gl_y if gl_y > 0 else (99.0 if gw_y > 0 else 0.0)
        yearly[yr] = {"trades": len(yt), "wins": yw, "losses": yl, "wr": round(ywr, 1), "pf": round(ypf, 2), "pnl": round(ypnl, 2)}
        
    return {
        "closed_trades": closed,
        "open_positions": open_details,
        "raw_positions": positions,
        "total_trades": len(closed) + len(positions),
        "peak_slots": max(daily_slots) if daily_slots else 0,
        "avg_slots": round(sum(daily_slots)/len(daily_slots), 1) if daily_slots else 0,
        "win_rate": wr,
        "profit_factor": pf,
        "gross_win": gw,
        "gross_loss": gl,
        "net_realized_pnl": tot_pnl,
        "unrealized_pnl": u_pnl,
        "total_pnl": tot_pnl + u_pnl,
        "yearly": yearly
    }

def print_report(res, title="SWINGER ENGINE BACKTEST"):
    print(f"\n{'='*65}")
    print(f"{title}")
    print(f"{'='*65}")
    print(f"Total Trades Executed:      {res['total_trades']} ({len(res['closed_trades'])} Closed + {len(res['open_positions'])} Open)")
    print(f"Peak Concurrent Slots:      {res['peak_slots']} positions (Avg: {res['avg_slots']})")
    print(f"Win Rate on Closed Trades:  {res['win_rate']:.1f}%")
    print(f"Profit Factor:              {res['profit_factor']:.2f}")
    print(f"Gross Profit:               Rs. {res['gross_win']:,.2f}")
    print(f"Gross Loss:                 Rs. {res['gross_loss']:,.2f}")
    print(f"Net Realized P&L:           Rs. {res['net_realized_pnl']:,.2f}")
    print(f"Open Positions Unrealized:  Rs. {res['unrealized_pnl']:,.2f}")
    print(f"TOTAL COMBINED P&L:         Rs. {res['total_pnl']:,.2f}")
    
    print("\nYearly Performance Breakdown:")
    for yr, s in res['yearly'].items():
        print(f"  {yr}: {s['trades']:3} trades | WR: {s['wr']:5.1f}% | PF: {s['pf']:5.2f} | Net: Rs. {s['pnl']:+10,.0f}")
        
    print("\nTop 5 Biggest Winners:")
    df_c = pd.DataFrame(res['closed_trades'])
    if not df_c.empty:
        for _, t in df_c.sort_values("pnl", ascending=False).head(5).iterrows():
            print(f"  {t['symbol']:12} | {t['entry_date']} -> {t['exit_date']} ({t['days_held']:3}d) | Rs.{t['pnl']:+8,.0f} ({t['pnl_pct']:+6.1f}%) | {t['reason']}")

def export_to_paper_ledger(res, cfg):
    trades_path = ROOT / "paper" / "swinger" / "trades.json"
    portfolio_path = ROOT / "paper" / "swinger" / "portfolio.json"
    
    closed = res["closed_trades"]
    positions = res["open_positions"]
    
    wins = [t for t in closed if t["pnl"] > 0]
    losses = [t for t in closed if t["pnl"] <= 0]
    
    by_year = defaultdict(list)
    for t in closed:
        yr = (t.get("exit_date") or "2026")[:4]
        by_year[yr].append(t)
    yearly = []
    for yr in sorted(by_year.keys()):
        yt = by_year[yr]
        yw = [t for t in yt if t["pnl"] > 0]
        yl = [t for t in yt if t["pnl"] <= 0]
        gw = sum(t["pnl"] for t in yw)
        gl = abs(sum(t["pnl"] for t in yl))
        ypf = round(gw / gl, 2) if gl > 0 else (99.0 if gw > 0 else 0.0)
        ywr = round(len(yw) / len(yt) * 100.0, 1) if yt else 0.0
        yearly.append({"year": yr, "trades": len(yt), "wins": len(yw), "losses": len(yl), "win_rate": ywr, "profit_factor": ypf, "pnl": round(sum(t["pnl"] for t in yt), 2)})
        
    by_month = defaultdict(list)
    for t in closed:
        mk = (t.get("exit_date") or "2026-01")[:7]
        by_month[mk].append(t)
    monthly = []
    for mk in sorted(by_month.keys()):
        mt = by_month[mk]
        mw = [t for t in mt if t["pnl"] > 0]
        ml = [t for t in mt if t["pnl"] <= 0]
        gw = sum(t["pnl"] for t in mw)
        gl = abs(sum(t["pnl"] for t in ml))
        mpf = round(gw / gl, 2) if gl > 0 else (99.0 if gw > 0 else 0.0)
        mwr = round(len(mw) / len(mt) * 100.0, 1) if mt else 0.0
        try: label = datetime.strptime(mk, "%Y-%m").strftime("%b %Y")
        except Exception: label = mk
        monthly.append({"month": mk, "label": label, "pnl": round(sum(t["pnl"] for t in mt), 2), "pnl_pct": round(sum(t["pnl_pct"] for t in mt)/len(mt), 1) if mt else 0.0, "trades": len(mt), "wins": len(mw), "losses": len(ml), "win_rate": mwr, "profit_factor": mpf})
        
    by_day = defaultdict(list)
    for t in closed:
        dk = t.get("exit_date", "")
        if dk: by_day[dk].append(t)
    daily = [{"date": dk, "pnl": round(sum(t["pnl"] for t in dt), 2), "value": round(sum(t["pnl"] for t in dt), 2), "trades": len(dt)} for dk, dt in sorted(by_day.items())]
    
    trades_payload = {
        "summary": {
            "total_trades": len(closed), "wins": len(wins), "losses": len(losses),
            "win_rate": round(res["win_rate"], 1), "profit_factor": round(res["profit_factor"], 2),
            "total_pnl": round(res["net_realized_pnl"], 2), "base_slot_size": 25000.0, "mode": "PAPER",
            "strategy": cfg.get("strategy", "Merged Dual-Engine Swinger"),
            "last_updated": datetime.now().isoformat()
        },
        "trades": closed,
        "yearly_breakdown": yearly,
        "monthly": monthly,
        "daily": daily
    }
    
    portfolio_payload = {
        "positions": positions,
        "total_open": len(positions),
        "total_invested": round(sum(p["shares"] * p["entry_price"] for p in positions), 2),
        "total_unrealized_pnl": round(res["unrealized_pnl"], 2),
        "last_updated": datetime.now().isoformat()
    }
    
    with open(trades_path, "w") as f:
        json.dump(trades_payload, f, indent=2)
    with open(portfolio_path, "w") as f:
        json.dump(portfolio_payload, f, indent=2)
    print("\n[SUCCESS] Successfully exported to paper/swinger/trades.json and portfolio.json")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Swinger Historical Backtest Simulator")
    parser.add_argument("--slots", type=str, default="15", help="Max slots cap (e.g., 12, 15, 25, or 'unlimited')")
    parser.add_argument("--slot-size", type=float, default=25000.0, help="Position size in Rs.")
    parser.add_argument("--start", type=str, default="2022-01-01", help="Simulation start date (YYYY-MM-DD)")
    parser.add_argument("--export", action="store_true", help="Export results to paper ledger and portfolio")
    args = parser.parse_args()
    
    max_slots = 9999 if args.slots.lower() == "unlimited" else int(args.slots)
    
    print("[1/3] Loading historical 4-year data and config...")
    price_data, mcap_2000 = load_data()
    cfg = load_config()
    
    print(f"[2/3] Precomputing technical indicators for {len(mcap_2000)} symbols...")
    stock_bars = precompute_indicators(price_data, mcap_2000)
    
    print(f"[3/3] Running simulation with {args.slots.upper()} slots from {args.start}...")
    res = run_backtest(stock_bars, max_slots=max_slots, slot_size=args.slot_size, sim_start=args.start)
    
    print_report(res, title=f"SWINGER BACKTEST ({args.slots.upper()} SLOTS | RS. {args.slot_size:,.0f}/SLOT)")
    
    if args.export:
        export_to_paper_ledger(res, cfg)
