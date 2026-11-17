import pickle
import pandas as pd
import numpy as np
import json
import yfinance as yf

# 1. Parse fresh triggers from chartink_swingernew_raw.json
with open("scratch/chartink_swingernew_raw.json", "r") as f:
    data = json.load(f)

metaData = data.get("metaData", [{}])[0]
trade_times = [pd.to_datetime(t, unit="ms").tz_localize("UTC").tz_convert("Asia/Kolkata").strftime("%Y-%m-%d") for t in metaData.get("tradeTimes", [])]
agg_stocks = data.get("aggregatedStockList", [])

triggers = []
for dt_str, stock_list in zip(trade_times, agg_stocks):
    for s in stock_list:
        if s.isupper() and ' ' not in s and '/' not in s and not s.startswith('$'):
            triggers.append({"date": dt_str, "symbol": s})

df_triggers = pd.DataFrame(triggers)
df_triggers["date"] = pd.to_datetime(df_triggers["date"])
df_triggers = df_triggers.sort_values("date").reset_index(drop=True)
df_triggers.to_csv("scratch/chartink_swingernew_triggers.csv", index=False)
print(f"Total pure stock triggers: {len(df_triggers)} across {df_triggers['symbol'].nunique()} unique stocks.")
print(f"Date range: {df_triggers['date'].min().strftime('%Y-%m-%d')} to {df_triggers['date'].max().strftime('%Y-%m-%d')}")

# 2. Load all prices
with open("scratch/universe_down_50_prices.pkl", "rb") as f:
    price_data = pickle.load(f)

# Download any missing symbols
syms = df_triggers["symbol"].unique()
missing = [s for s in syms if s not in price_data]
if missing:
    print(f"Downloading {len(missing)} missing symbols: {missing}")
    tickers = [f"{s}.NS" for s in missing]
    try:
        m_data = yf.download(tickers, start="2025-01-01", end="2026-11-17", group_by="ticker", auto_adjust=False, progress=False)
        for s in missing:
            try:
                df = m_data.copy() if len(missing) == 1 else m_data[f"{s}.NS"].copy()
                df = df.dropna(subset=["Close"])
                if len(df) > 30: price_data[s] = df
            except Exception as e:
                print(f"Error {s}: {e}")
    except Exception as e:
        print(f"Download error: {e}")

# Precompute bars
stock_bars = {}
ref_sym = list(syms)[0]
for s in syms:
    if s in price_data and len(price_data[s]) > 200:
        ref_sym = s
        break

all_dates = sorted([d for d in pd.to_datetime(price_data[ref_sym].index) if d >= pd.to_datetime("2026-03-20")])

for s in syms:
    df = price_data.get(s)
    if df is None or len(df) < 30: continue
    df = df.copy()
    if not isinstance(df.index, pd.DatetimeIndex): df.index = pd.to_datetime(df.index)
    df.index = df.index.tz_localize(None)
    df = df.sort_index()
    c = df["Close"].values; h = df["High"].values; l = df["Low"].values; o = df["Open"].values; v = df["Volume"].values
    dates = df.index
    e50 = pd.Series(c).ewm(span=50, adjust=False).mean().values
    vsma50 = pd.Series(v).rolling(50, min_periods=10).mean().values
    stock_bars[s] = {
        "dates": dates,
        "date_map": {d.strftime("%Y-%m-%d"): i for i, d in enumerate(dates)},
        "c": c, "h": h, "l": l, "o": o, "v": v, "e50": e50, "vsma50": vsma50
    }

triggers_by_date = {}
for _, row in df_triggers.iterrows():
    dt_str = row["date"].strftime("%Y-%m-%d")
    triggers_by_date.setdefault(dt_str, []).append(row["symbol"])

# 3. Simulate with No Slot Limit and 15% SL
def simulate(initial_sl_pct=-15.0, shield_trigger_pct=15.0, runner_trigger_pct=30.0, runner_trail_pct=25.0):
    positions = []
    closed = []
    trade_id = 1
    SLOT_SIZE = 25000.0
    
    for cur_dt in all_dates:
        cur_str = cur_dt.strftime("%Y-%m-%d")
        surviving = []
        for pos in positions:
            s = pos["symbol"]
            b = stock_bars.get(s)
            if not b:
                surviving.append(pos)
                continue
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
            
            high_ret = (pos["highest_high"] - entry_p) / entry_p * 100.0
            close_ret = (pos["highest_close"] - entry_p) / entry_p * 100.0
            exited = False; exit_p = None; exit_reason = None
            
            sl_threshold = entry_p * (1.0 + initial_sl_pct / 100.0)
            
            if not pos["runner_mode"]:
                if pos.get("be_shield_active", False) and l <= entry_p * 1.005:
                    exited = True
                    exit_p = min(o, entry_p * 1.005) if o < entry_p * 1.005 else entry_p * 1.005
                    exit_reason = "Cost Shield Hit (BE)"
                elif c <= sl_threshold:
                    exited = True
                    exit_p = c
                    exit_reason = f"Initial SL ({initial_sl_pct}% Close)"
            else:
                peak_trail = pos["runner_peak"] * (1.0 - runner_trail_pct / 100.0)
                if l <= peak_trail:
                    exited = True
                    exit_p = min(o, peak_trail) if o < peak_trail else peak_trail
                    exit_reason = f"Peak Trail Stop ({runner_trail_pct}%)"
                elif pos["bars_held"] >= 10 and c < e50 and vsma50 > 0 and v > 1.2 * vsma50:
                    exited = True
                    exit_p = c
                    exit_reason = "50 EMA Vol Breakdown"
            
            if exited:
                pnl = round(pos["shares"] * (exit_p - entry_p), 2)
                pnl_pct = round((exit_p / entry_p - 1.0) * 100.0, 2)
                closed.append({
                    "trade_id": trade_id, "symbol": s,
                    "entry_date": pos["entry_date"].strftime("%Y-%m-%d"),
                    "exit_date": cur_str,
                    "entry_price": round(entry_p, 2), "exit_price": round(exit_p, 2),
                    "shares": pos["shares"], "invested": round(pos["shares"] * entry_p, 2),
                    "pnl": pnl, "pnl_pct": pnl_pct, "reason": exit_reason,
                    "peak_gain_pct": round(high_ret, 1)
                })
                trade_id += 1
            else:
                if high_ret >= shield_trigger_pct: pos["be_shield_active"] = True
                if high_ret >= runner_trigger_pct and not pos["runner_mode"]:
                    pos["runner_mode"] = True
                    pos["runner_peak"] = pos["highest_close"]
                elif pos["runner_mode"]:
                    if pos["highest_close"] > pos["runner_peak"]:
                        pos["runner_peak"] = pos["highest_close"]
                surviving.append(pos)
        
        positions = surviving
        
        # Enter all triggers today (No slot limits)
        syms_today = triggers_by_date.get(cur_str, [])
        for sym in syms_today:
            # Don't duplicate if already holding this symbol
            if any(p["symbol"] == sym for p in positions):
                continue
            b = stock_bars.get(sym)
            if not b: continue
            i = b["date_map"].get(cur_str)
            if i is None: continue
            entry_p = b["c"][i]
            if entry_p <= 0: continue
            shares = int(SLOT_SIZE // entry_p)
            if shares <= 0: continue
            positions.append({
                "symbol": sym,
                "entry_date": cur_dt,
                "entry_price": entry_p,
                "shares": shares,
                "days_held": 0,
                "bars_held": 0,
                "highest_high": entry_p,
                "highest_close": entry_p,
                "be_shield_active": False,
                "runner_mode": False,
                "runner_peak": entry_p
            })
            
    return closed, positions

closed, open_pos = simulate(initial_sl_pct=-15.0)

df_res = pd.DataFrame(closed)
wins = df_res[df_res["pnl"] > 0]
losses = df_res[df_res["pnl"] <= 0]
net_pnl = df_res["pnl"].sum()
wr = len(wins) / len(df_res) * 100 if len(df_res) > 0 else 0
gp = wins["pnl"].sum() if len(wins) > 0 else 0
gl = abs(losses["pnl"].sum()) if len(losses) > 0 else 1
pf = gp / gl

print("\n==========================================")
print("=== OFFICIAL SWINGERNEW BACKTEST RESULTS ===")
print("==========================================")
print(f"Total Closed Trades: {len(df_res)}")
print(f"Open Positions Still Active: {len(open_pos)}")
print(f"Net Realized P&L: Rs {net_pnl:,.2f}")
print(f"Win Rate: {wr:.1f}% ({len(wins)} Wins / {len(losses)} Losses)")
print(f"Profit Factor: {pf:.2f}")
print(f"Gross Profit: Rs {gp:,.2f}")
print(f"Gross Loss: Rs {gl:,.2f}")
print(f"Average Profit per Trade: Rs {df_res['pnl'].mean():,.2f} ({df_res['pnl_pct'].mean():.1f}%)")
print(f"Max Winner: Rs {df_res['pnl'].max():,.2f} ({df_res['pnl_pct'].max():.1f}%) - {df_res.loc[df_res['pnl'].idxmax()]['symbol']}")
print(f"Max Loser: Rs {df_res['pnl'].min():,.2f} ({df_res['pnl_pct'].min():.1f}%) - {df_res.loc[df_res['pnl'].idxmin()]['symbol']}")

# Exit reason breakdown
print("\n=== EXIT REASON BREAKDOWN ===")
print(df_res["reason"].value_counts())

# Save trades
with open("scratch/official_swingernew_backtest_trades.json", "w") as f:
    json.dump({"trades": closed, "open_positions": [
        {"symbol": p["symbol"], "entry_date": p["entry_date"].strftime("%Y-%m-%d"), "entry_price": p["entry_price"], "shares": p["shares"], "highest_high": p["highest_high"], "runner_mode": p["runner_mode"]}
        for p in open_pos
    ]}, f, indent=2)
print("\nSaved trades to scratch/official_swingernew_backtest_trades.json")
