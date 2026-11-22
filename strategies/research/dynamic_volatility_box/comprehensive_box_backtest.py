#!/usr/bin/env python3
"""
Comprehensive Backtest & Sensitivity Engine for
"The Dynamic Volatility Box Breakout" Strategy
"""

import os
import glob
import time
import pandas as pd
import numpy as np
from dataclasses import dataclass
from typing import List, Dict, Optional, Tuple

@dataclass
class Trade:
    trade_id: int
    direction: str          # 'LONG' or 'SHORT'
    entry_idx: int
    entry_time: str
    entry_price: float
    box_high: float
    box_low: float
    box_median: float
    box_depth: float
    atr: float
    risk_units: float
    initial_sl: float
    tp_price: float
    be_trigger_price: float
    active_sl: float
    be_activated: bool = False
    exit_idx: int = -1
    exit_time: str = ""
    exit_price: float = 0.0
    exit_reason: str = ""   # 'TP', 'BE', 'SL', 'EOD'
    pnl_pts: float = 0.0
    pnl_r: float = 0.0
    bars_held: int = 0
    mfe_pts: float = 0.0
    mae_pts: float = 0.0


def load_nifty_dataset(years: List[int] = [2024, 2025, 2026]) -> pd.DataFrame:
    """Loads 1m data for specified years, using caching."""
    cache_file = f".tmp/nifty_1m_{'_'.join(map(str, sorted(years)))}.pkl"
    if os.path.exists(cache_file):
        print(f"Loading cached 1m data from {cache_file}...")
        return pd.read_pickle(cache_file)
        
    os.makedirs(".tmp", exist_ok=True)
    all_files = []
    for y in years:
        pattern = os.path.join('historical_data', 'nifty50', '1min', str(y), "**", "*.csv")
        found = glob.glob(pattern, recursive=True)
        all_files.extend(found)
    all_files.sort()
    
    print(f"Loading {len(all_files)} daily files for {years}...")
    dfs = []
    for f in all_files:
        try:
            dfs.append(pd.read_csv(f))
        except Exception as e:
            pass
    df_all = pd.concat(dfs, ignore_index=True)
    df_all.columns = [c.lower() for c in df_all.columns]
    if 'timestamp' in df_all.columns:
        df_all['timestamp'] = pd.to_datetime(df_all['timestamp'])
    elif 'epoch' in df_all.columns:
        df_all['timestamp'] = pd.to_datetime(df_all['epoch'], unit='s')
        
    df_all.sort_values('timestamp', inplace=True)
    df_all.reset_index(drop=True, inplace=True)
    df_all['date_str'] = df_all['timestamp'].dt.strftime('%Y-%m-%d')
    df_all['time_str'] = df_all['timestamp'].dt.strftime('%H:%M')
    df_all.to_pickle(cache_file)
    print(f"Loaded and cached {len(df_all):,} bars.")
    return df_all


def resample_df(df_1m: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    """Resample to specified timeframe."""
    if timeframe in ['1m', '1min']:
        res = df_1m.copy()
    else:
        df = df_1m.set_index('timestamp')
        res = df.resample(timeframe).agg({
            'open': 'first',
            'high': 'max',
            'low': 'min',
            'close': 'last',
            'volume': 'sum'
        }).dropna().reset_index()
        
    res['date_str'] = res['timestamp'].dt.strftime('%Y-%m-%d')
    res['time_str'] = res['timestamp'].dt.strftime('%H:%M')
    return res


def compute_wilder_atr(df: pd.DataFrame, period: int = 14) -> np.ndarray:
    """Wilder's smoothed ATR."""
    high = df['high'].values
    low = df['low'].values
    close = df['close'].values
    n = len(df)
    tr = np.zeros(n)
    tr[0] = high[0] - low[0]
    for i in range(1, n):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
    atr = np.zeros(n)
    if n >= period:
        atr[period - 1] = np.mean(tr[:period])
        alpha = 1.0 / period
        for i in range(period, n):
            atr[i] = atr[i - 1] * (1.0 - alpha) + tr[i] * alpha
    return atr


def backtest_strategy(
    df: pd.DataFrame,
    lookback: int = 14,
    atr_period: int = 14,
    target_mult: float = 1.5,
    min_vol: float = 0.5,
    max_vol: float = 2.5,
    body_confirm_ratio: float = 0.50,
    use_breakeven: bool = True,
    be_trigger_mult: float = 1.0,
    intraday_mode: bool = True,
    eod_exit_time: str = "15:20",
    entry_cutoff_time: str = "15:00"
) -> Tuple[pd.DataFrame, Dict]:
    
    n = len(df)
    opens = df['open'].values
    highs = df['high'].values
    lows = df['low'].values
    closes = df['close'].values
    dates = df['date_str'].values
    times = df['time_str'].values
    ts_strs = df['timestamp'].astype(str).values
    
    atrs = compute_wilder_atr(df, atr_period)
    
    trades: List[Trade] = []
    trade_id = 0
    in_trade = False
    cur: Optional[Trade] = None
    
    start_idx = max(atr_period + 1, lookback)
    i = start_idx
    
    while i < n - 1:
        # 1. State 2: Active Trade Management
        if in_trade and cur is not None:
            bar_o = opens[i]
            bar_h = highs[i]
            bar_l = lows[i]
            bar_c = closes[i]
            cur_time = times[i]
            cur_date = dates[i]
            bar_ts = ts_strs[i]
            
            cur.bars_held += 1
            
            # Excursion tracking
            if cur.direction == 'LONG':
                cur.mfe_pts = max(cur.mfe_pts, bar_h - cur.entry_price)
                cur.mae_pts = max(cur.mae_pts, cur.entry_price - bar_l)
            else:
                cur.mfe_pts = max(cur.mfe_pts, cur.entry_price - bar_l)
                cur.mae_pts = max(cur.mae_pts, bar_h - cur.entry_price)
                
            # EOD check
            if intraday_mode and cur_time >= eod_exit_time:
                cur.exit_idx = i
                cur.exit_time = bar_ts
                cur.exit_price = bar_c
                cur.exit_reason = 'EOD'
                cur.pnl_pts = (bar_c - cur.entry_price) if cur.direction == 'LONG' else (cur.entry_price - bar_c)
                cur.pnl_r = cur.pnl_pts / cur.risk_units
                trades.append(cur)
                in_trade = False
                cur = None
                i += 1
                continue
                
            # Breakeven trailing check
            if use_breakeven and not cur.be_activated:
                if cur.direction == 'LONG' and bar_h >= cur.be_trigger_price:
                    cur.active_sl = cur.entry_price
                    cur.be_activated = True
                elif cur.direction == 'SHORT' and bar_l <= cur.be_trigger_price:
                    cur.active_sl = cur.entry_price
                    cur.be_activated = True
                    
            # Stop Loss & Take Profit check
            exited = False
            if cur.direction == 'LONG':
                hit_tp = bar_h >= cur.tp_price
                hit_sl = bar_l <= cur.active_sl
                
                if hit_tp and hit_sl:
                    # Intrabar collision resolution
                    # If open was above/at TP, exit TP at Open; else conservative exit SL
                    if bar_o >= cur.tp_price:
                        cur.exit_price = bar_o
                        cur.exit_reason = 'TP'
                    else:
                        cur.exit_price = cur.active_sl
                        cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
                elif hit_tp:
                    cur.exit_price = cur.tp_price
                    cur.exit_reason = 'TP'
                    exited = True
                elif hit_sl:
                    cur.exit_price = min(bar_o, cur.active_sl) if bar_o < cur.active_sl else cur.active_sl
                    cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
            else: # SHORT
                hit_tp = bar_l <= cur.tp_price
                hit_sl = bar_h >= cur.active_sl
                
                if hit_tp and hit_sl:
                    if bar_o <= cur.tp_price:
                        cur.exit_price = bar_o
                        cur.exit_reason = 'TP'
                    else:
                        cur.exit_price = cur.active_sl
                        cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
                elif hit_tp:
                    cur.exit_price = cur.tp_price
                    cur.exit_reason = 'TP'
                    exited = True
                elif hit_sl:
                    cur.exit_price = max(bar_o, cur.active_sl) if bar_o > cur.active_sl else cur.active_sl
                    cur.exit_reason = 'BE' if cur.be_activated else 'SL'
                    exited = True
                    
            if exited:
                cur.exit_idx = i
                cur.exit_time = bar_ts
                cur.pnl_pts = (cur.exit_price - cur.entry_price) if cur.direction == 'LONG' else (cur.entry_price - cur.exit_price)
                cur.pnl_r = cur.pnl_pts / cur.risk_units
                trades.append(cur)
                in_trade = False
                cur = None
                
            i += 1
            continue
            
        # 2. State 0: Scanning & Box Formulation
        cur_time = times[i]
        cur_date = dates[i]
        
        if intraday_mode and cur_time >= entry_cutoff_time:
            i += 1
            continue
            
        h_slice = highs[i - lookback + 1 : i + 1]
        l_slice = lows[i - lookback + 1 : i + 1]
        
        b_high = np.max(h_slice)
        b_low = np.min(l_slice)
        b_med = (b_high + b_low) / 2.0
        b_depth = b_high - b_low
        atr_val = atrs[i]
        
        if atr_val <= 0 or not (min_vol * atr_val <= b_depth <= max_vol * atr_val):
            i += 1
            continue
            
        # 3. State 1: Breakout & Entry Confirmation on candle t+1 (index i+1)
        next_i = i + 1
        cand_o = opens[next_i]
        cand_c = closes[next_i]
        cand_ts = ts_strs[next_i]
        
        # Avoid carrying signal across daily boundary in intraday mode
        if intraday_mode and dates[next_i] != cur_date:
            i += 1
            continue
            
        body_h = abs(cand_c - cand_o)
        long_cond = (cand_c > b_high) and ((cand_c - b_high) >= (body_confirm_ratio * body_h))
        short_cond = (cand_c < b_low) and ((b_low - cand_c) >= (body_confirm_ratio * body_h))
        
        if long_cond:
            entry_p = cand_c
            risk_u = entry_p - b_med
            if risk_u > 0:
                trade_id += 1
                cur = Trade(
                    trade_id=trade_id,
                    direction='LONG',
                    entry_idx=next_i,
                    entry_time=cand_ts,
                    entry_price=entry_p,
                    box_high=b_high,
                    box_low=b_low,
                    box_median=b_med,
                    box_depth=b_depth,
                    atr=atr_val,
                    risk_units=risk_u,
                    initial_sl=b_med,
                    tp_price=entry_p + (target_mult * risk_u),
                    be_trigger_price=entry_p + (be_trigger_mult * risk_u),
                    active_sl=b_med,
                    be_activated=False
                )
                in_trade = True
                i = next_i + 1
                continue
                
        elif short_cond:
            entry_p = cand_c
            risk_u = b_med - entry_p
            if risk_u > 0:
                trade_id += 1
                cur = Trade(
                    trade_id=trade_id,
                    direction='SHORT',
                    entry_idx=next_i,
                    entry_time=cand_ts,
                    entry_price=entry_p,
                    box_high=b_high,
                    box_low=b_low,
                    box_median=b_med,
                    box_depth=b_depth,
                    atr=atr_val,
                    risk_units=risk_u,
                    initial_sl=b_med,
                    tp_price=entry_p - (target_mult * risk_u),
                    be_trigger_price=entry_p - (be_trigger_mult * risk_u),
                    active_sl=b_med,
                    be_activated=False
                )
                in_trade = True
                i = next_i + 1
                continue
                
        i += 1
        
    trades_df = pd.DataFrame([t.__dict__ for t in trades]) if trades else pd.DataFrame()
    metrics = summarize_metrics(trades_df)
    return trades_df, metrics


def summarize_metrics(trades_df: pd.DataFrame) -> Dict:
    if len(trades_df) == 0:
        return {
            "trades": 0, "wins": 0, "losses": 0, "be_count": 0,
            "win_rate": 0.0, "net_pts": 0.0, "profit_factor": 0.0,
            "total_r": 0.0, "avg_r": 0.0, "avg_win": 0.0, "avg_loss": 0.0,
            "max_dd_pts": 0.0, "exits": {}
        }
        
    wins = trades_df[trades_df['pnl_pts'] > 0]
    losses = trades_df[trades_df['pnl_pts'] < 0]
    breakevens = trades_df[trades_df['pnl_pts'] == 0]
    
    n_trades = len(trades_df)
    wr = len(wins) / n_trades * 100
    gp = wins['pnl_pts'].sum()
    gl = abs(losses['pnl_pts'].sum())
    pf = (gp / gl) if gl > 0 else 99.0
    net = trades_df['pnl_pts'].sum()
    
    cum = trades_df['pnl_pts'].cumsum()
    max_dd = (cum.cummax() - cum).max()
    
    total_r = trades_df['pnl_r'].sum()
    avg_r = trades_df['pnl_r'].mean()
    
    reasons = trades_df['exit_reason'].value_counts().to_dict()
    
    return {
        "trades": n_trades,
        "wins": len(wins),
        "losses": len(losses),
        "be_count": len(breakevens),
        "win_rate": round(wr, 1),
        "net_pts": round(net, 1),
        "profit_factor": round(pf, 2),
        "total_r": round(total_r, 2),
        "avg_r": round(avg_r, 2),
        "avg_win": round(wins['pnl_pts'].mean(), 1) if len(wins) else 0,
        "avg_loss": round(losses['pnl_pts'].mean(), 1) if len(losses) else 0,
        "max_dd_pts": round(max_dd, 1),
        "exits": reasons
    }


def run_experiment_matrix():
    print("=" * 80)
    print("DYNAMIC VOLATILITY BOX BREAKOUT - FULL EXPERIMENT MATRIX")
    print("=" * 80)
    
    # Load 2024 to 2026 data
    df_1m = load_nifty_dataset(years=[2024, 2025, 2026])
    
    timeframes = ['5min', '15min', '3min', '30min']
    dfs = {tf: resample_df(df_1m, tf) for tf in timeframes}
    
    print("\n--- TEST 1: TIMEFRAME COMPARISON (Default: Lookback=14, ATR=14, Target=1.5, BE=ON) ---")
    print(f"{'TF':<8} | {'Trades':<8} | {'Win%':<8} | {'Net PnL (pts)':<14} | {'PF':<6} | {'Total R':<10} | {'Max DD':<10} | {'Exits (TP/SL/BE/EOD)'}")
    print("-" * 95)
    for tf in timeframes:
        t_df, m = backtest_strategy(dfs[tf], lookback=14, atr_period=14, target_mult=1.5, use_breakeven=True)
        ex = m.get('exits', {})
        ex_str = f"TP:{ex.get('TP',0)} SL:{ex.get('SL',0)} BE:{ex.get('BE',0)} EOD:{ex.get('EOD',0)}"
        print(f"{tf:<8} | {m['trades']:<8} | {m['win_rate']:<7.1f}% | {m['net_pts']:<+14.1f} | {m['profit_factor']:<6.2f} | {m['total_r']:<+10.2f} | {m['max_dd_pts']:<10.1f} | {ex_str}")
        
    print("\n--- TEST 2: BREAKEVEN ABLATION (Does Breakeven at 1R help or hurt?) ---")
    print(f"{'TF':<8} | {'BE Mode':<10} | {'Trades':<8} | {'Win%':<8} | {'Net PnL':<12} | {'PF':<6} | {'Total R':<10} | {'Max DD':<10}")
    print("-" * 85)
    for tf in ['5min', '15min']:
        for be in [True, False]:
            be_label = "BE ON (1R)" if be else "BE OFF"
            t_df, m = backtest_strategy(dfs[tf], lookback=14, atr_period=14, target_mult=1.5, use_breakeven=be)
            print(f"{tf:<8} | {be_label:<10} | {m['trades']:<8} | {m['win_rate']:<7.1f}% | {m['net_pts']:<+12.1f} | {m['profit_factor']:<6.2f} | {m['total_r']:<+10.2f} | {m['max_dd_pts']:<10.1f}")
            
    print("\n--- TEST 3: LOOKBACK SWEEP ON 5-MIN & 15-MIN (Lookback: 10, 14, 20, 30, 50) ---")
    print(f"{'TF':<8} | {'Lookback':<9} | {'Trades':<8} | {'Win%':<8} | {'Net PnL':<12} | {'PF':<6} | {'Total R':<10} | {'Max DD':<10}")
    print("-" * 85)
    for tf in ['5min', '15min']:
        for lb in [10, 14, 20, 30, 50]:
            t_df, m = backtest_strategy(dfs[tf], lookback=lb, atr_period=14, target_mult=1.5, use_breakeven=True)
            print(f"{tf:<8} | {lb:<9} | {m['trades']:<8} | {m['win_rate']:<7.1f}% | {m['net_pts']:<+12.1f} | {m['profit_factor']:<6.2f} | {m['total_r']:<+10.2f} | {m['max_dd_pts']:<10.1f}")
            
    print("\n--- TEST 4: TARGET MULTIPLIER SWEEP (Target: 1.0, 1.5, 2.0, 2.5, 3.0) ---")
    print(f"{'TF':<8} | {'Target R':<9} | {'Trades':<8} | {'Win%':<8} | {'Net PnL':<12} | {'PF':<6} | {'Total R':<10} | {'Max DD':<10}")
    print("-" * 85)
    for tf in ['5min', '15min']:
        for tm in [1.0, 1.5, 2.0, 2.5, 3.0]:
            t_df, m = backtest_strategy(dfs[tf], lookback=14, atr_period=14, target_mult=tm, use_breakeven=True)
            print(f"{tf:<8} | {tm:<9.1f} | {m['trades']:<8} | {m['win_rate']:<7.1f}% | {m['net_pts']:<+12.1f} | {m['profit_factor']:<6.2f} | {m['total_r']:<+10.2f} | {m['max_dd_pts']:<10.1f}")

    print("\n--- TEST 5: INTRADAY VS POSITIONAL HOLD (MULTI-DAY) ---")
    print(f"{'TF':<8} | {'Mode':<12} | {'Trades':<8} | {'Win%':<8} | {'Net PnL':<12} | {'PF':<6} | {'Total R':<10} | {'Max DD':<10}")
    print("-" * 85)
    for tf in ['15min']:
        for intra in [True, False]:
            mode_lbl = "Intraday EOD" if intra else "Positional"
            t_df, m = backtest_strategy(dfs[tf], lookback=14, atr_period=14, target_mult=1.5, intraday_mode=intra)
            print(f"{tf:<8} | {mode_lbl:<12} | {m['trades']:<8} | {m['win_rate']:<7.1f}% | {m['net_pts']:<+12.1f} | {m['profit_factor']:<6.2f} | {m['total_r']:<+10.2f} | {m['max_dd_pts']:<10.1f}")


if __name__ == "__main__":
    run_experiment_matrix()
