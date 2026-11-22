#!/usr/bin/env python3
"""
Dynamic Volatility Box Breakout - Backtester
Implements:
1. State 0: Scanning & Box Formulation (Lookback, ATR, Volatility Filter)
2. State 1: Breakout & Entry Engine (50% body breakout confirmation)
3. State 2: Active Trade Management Matrix (SL at box_median, TP, Breakeven at 1R)
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
    be_price: float
    exit_idx: int = -1
    exit_time: str = ""
    exit_price: float = 0.0
    exit_reason: str = ""   # 'TP', 'BE', 'SL', 'EOD'
    pnl_pts: float = 0.0
    pnl_pct: float = 0.0
    pnl_r: float = 0.0
    bars_held: int = 0
    mfe_pts: float = 0.0    # Maximum Favorable Excursion
    mae_pts: float = 0.0    # Maximum Adverse Excursion


def load_nifty_data(years: List[int] = [2026], base_dir: str = 'historical_data/nifty50/1min') -> pd.DataFrame:
    """Loads 1-minute historical data for specified years."""
    cache_file = f".tmp/nifty_1m_{'_'.join(map(str, years))}.pkl"
    if os.path.exists(cache_file):
        print(f"Loading cached 1m data from {cache_file}...")
        return pd.read_pickle(cache_file)
    
    os.makedirs(".tmp", exist_ok=True)
    all_files = []
    for y in years:
        pattern = os.path.join(base_dir, str(y), "**", "*.csv")
        found = glob.glob(pattern, recursive=True)
        all_files.extend(found)
        
    all_files.sort()
    print(f"Loading {len(all_files)} daily 1-minute CSV files for years {years}...")
    dfs = []
    for f in all_files:
        try:
            df = pd.read_csv(f)
            dfs.append(df)
        except Exception as e:
            print(f"Error reading {f}: {e}")
            
    df_all = pd.concat(dfs, ignore_index=True)
    
    # Standardize columns
    df_all.columns = [c.lower() for c in df_all.columns]
    if 'timestamp' in df_all.columns:
        df_all['timestamp'] = pd.to_datetime(df_all['timestamp'])
    elif 'epoch' in df_all.columns:
        df_all['timestamp'] = pd.to_datetime(df_all['epoch'], unit='s')
        
    df_all.sort_values('timestamp', inplace=True)
    df_all.reset_index(drop=True, inplace=True)
    
    print(f"Total 1m candles: {len(df_all):,} ({df_all['timestamp'].iloc[0]} to {df_all['timestamp'].iloc[-1]})")
    df_all.to_pickle(cache_file)
    return df_all


def resample_ohlcv(df_1m: pd.DataFrame, timeframe: str = '5min') -> pd.DataFrame:
    """Resamples 1m data to target timeframe (e.g., '5min', '15min', '3min', '30min')."""
    if timeframe in ['1min', '1m']:
        res = df_1m.copy()
        res['date'] = res['timestamp'].dt.date
        res['time_str'] = res['timestamp'].dt.strftime('%H:%M')
        res['date_str'] = res['timestamp'].dt.strftime('%Y-%m-%d')
        return res
        
    df = df_1m.set_index('timestamp')
    res = df.resample(timeframe).agg({
        'open': 'first',
        'high': 'max',
        'low': 'min',
        'close': 'last',
        'volume': 'sum'
    }).dropna().reset_index()
    
    res['date'] = res['timestamp'].dt.date
    res['time_str'] = res['timestamp'].dt.strftime('%H:%M')
    res['date_str'] = res['timestamp'].dt.strftime('%Y-%m-%d')
    return res


def compute_atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    """Calculates True Range and Wilder's smoothed ATR."""
    high = df['high'].values
    low = df['low'].values
    close = df['close'].values
    
    n = len(df)
    tr = np.zeros(n)
    tr[0] = high[0] - low[0]
    
    for i in range(1, n):
        hl = high[i] - low[i]
        hc = abs(high[i] - close[i - 1])
        lc = abs(low[i] - close[i - 1])
        tr[i] = max(hl, hc, lc)
        
    atr = np.zeros(n)
    if n >= period:
        # Initial SMA
        atr[period - 1] = np.mean(tr[:period])
        # Wilder's RMA smoothing
        alpha = 1.0 / period
        for i in range(period, n):
            atr[i] = atr[i - 1] * (1.0 - alpha) + tr[i] * alpha
            
    return pd.Series(atr, index=df.index)


def run_dynamic_box_backtest(
    df: pd.DataFrame,
    lookback_candles: int = 14,
    atr_period: int = 14,
    target_multiplier: float = 1.5,
    min_vol_mult: float = 0.5,
    max_vol_mult: float = 2.5,
    body_confirmation_ratio: float = 0.50,
    breakeven_r: float = 1.0,
    intraday_mode: bool = True,
    eod_exit_time: str = "15:20",
    allow_reentry_same_day: bool = True,
    max_trade_bars: Optional[int] = None
) -> Tuple[pd.DataFrame, Dict]:
    """
    Executes the exact Dynamic Volatility Box Breakout strategy.
    
    Logic:
    - State 0: Lookback slice [t - lookback + 1 : t + 1]. 
               box_high = Max, box_low = Min, box_median = (H + L) / 2, box_depth = H - L.
               Volatility filter: min_vol_mult * ATR <= box_depth <= max_vol_mult * ATR.
    - State 1: Candle t+1:
               body_height = abs(Close[t+1] - Open[t+1])
               Long: Close[t+1] > box_high AND (Close[t+1] - box_high) >= body_confirmation_ratio * body_height
               Short: Close[t+1] < box_low AND (box_low - Close[t+1]) >= body_confirmation_ratio * body_height
    - State 2: Active Trade Management:
               SL: box_median.
               TP: Entry +/- target_multiplier * Risk_Units.
               Breakeven: when price touches Entry +/- breakeven_r * Risk_Units -> active SL = Entry.
    """
    df = df.copy()
    df['atr'] = compute_atr(df, atr_period)
    
    n = len(df)
    opens = df['open'].values
    highs = df['high'].values
    lows = df['low'].values
    closes = df['close'].values
    atrs = df['atr'].values
    timestamps = df['timestamp'].astype(str).values
    dates = df['date_str'].values
    times = df['time_str'].values
    
    trades: List[Trade] = []
    trade_id = 0
    
    # State tracking
    in_trade = False
    current_trade: Optional[Trade] = None
    last_trade_date = None
    
    # Start scanning after we have enough bars for ATR and lookback
    start_idx = max(atr_period + 1, lookback_candles)
    
    i = start_idx
    while i < n - 1:
        cur_date = dates[i]
        cur_time = times[i]
        
        # In State 2: Manage open position
        if in_trade and current_trade is not None:
            # Check bar i
            bar_o = opens[i]
            bar_h = highs[i]
            bar_l = lows[i]
            bar_c = closes[i]
            bar_time = timestamps[i]
            
            # Duration tracking
            current_trade.bars_held += 1
            
            # Excursion tracking
            if current_trade.direction == 'LONG':
                fav = bar_h - current_trade.entry_price
                adv = current_trade.entry_price - bar_l
            else:
                fav = current_trade.entry_price - bar_l
                adv = bar_h - current_trade.entry_price
            current_trade.mfe_pts = max(current_trade.mfe_pts, fav)
            current_trade.mae_pts = max(current_trade.mae_pts, adv)
            
            # 1. Intraday EOD Exit check
            if intraday_mode and cur_time >= eod_exit_time:
                current_trade.exit_idx = i
                current_trade.exit_time = bar_time
                current_trade.exit_price = bar_c
                current_trade.exit_reason = 'EOD'
                current_trade.pnl_pts = (bar_c - current_trade.entry_price) if current_trade.direction == 'LONG' else (current_trade.entry_price - bar_c)
                current_trade.pnl_pct = current_trade.pnl_pts / current_trade.entry_price * 100
                current_trade.pnl_r = current_trade.pnl_pts / current_trade.risk_units
                trades.append(current_trade)
                in_trade = False
                current_trade = None
                i += 1
                continue
                
            # 2. Breakeven Trailing Trigger Check
            be_triggered_in_bar = False
            if current_trade.exit_reason == "": # Not locked BE yet
                if current_trade.direction == 'LONG':
                    if bar_h >= current_trade.be_price:
                        current_trade.initial_sl = current_trade.entry_price  # lock to entry
                        be_triggered_in_bar = True
                else: # SHORT
                    if bar_l <= current_trade.be_price:
                        current_trade.initial_sl = current_trade.entry_price  # lock to entry
                        be_triggered_in_bar = True
                        
            # 3. Target and Stop Loss evaluations
            exited = False
            if current_trade.direction == 'LONG':
                # Did it hit TP?
                hit_tp = bar_h >= current_trade.tp_price
                hit_sl = bar_l <= current_trade.initial_sl
                
                if hit_tp and hit_sl:
                    # Intrabar ambiguity: conservative approach check open
                    # If open was closer to TP or above BE, or conservative assumption: SL hit first unless gap open
                    if bar_o >= current_trade.tp_price:
                        current_trade.exit_price = bar_o
                        current_trade.exit_reason = 'TP'
                    else:
                        current_trade.exit_price = current_trade.initial_sl
                        current_trade.exit_reason = 'BE' if current_trade.initial_sl == current_trade.entry_price else 'SL'
                    exited = True
                elif hit_tp:
                    current_trade.exit_price = current_trade.tp_price
                    current_trade.exit_reason = 'TP'
                    exited = True
                elif hit_sl:
                    current_trade.exit_price = min(bar_o, current_trade.initial_sl) if bar_o < current_trade.initial_sl else current_trade.initial_sl
                    current_trade.exit_reason = 'BE' if current_trade.initial_sl == current_trade.entry_price else 'SL'
                    exited = True
                    
            else: # SHORT
                hit_tp = bar_l <= current_trade.tp_price
                hit_sl = bar_h >= current_trade.initial_sl
                
                if hit_tp and hit_sl:
                    if bar_o <= current_trade.tp_price:
                        current_trade.exit_price = bar_o
                        current_trade.exit_reason = 'TP'
                    else:
                        current_trade.exit_price = current_trade.initial_sl
                        current_trade.exit_reason = 'BE' if current_trade.initial_sl == current_trade.entry_price else 'SL'
                    exited = True
                elif hit_tp:
                    current_trade.exit_price = current_trade.tp_price
                    current_trade.exit_reason = 'TP'
                    exited = True
                elif hit_sl:
                    current_trade.exit_price = max(bar_o, current_trade.initial_sl) if bar_o > current_trade.initial_sl else current_trade.initial_sl
                    current_trade.exit_reason = 'BE' if current_trade.initial_sl == current_trade.entry_price else 'SL'
                    exited = True
                    
            if exited:
                current_trade.exit_idx = i
                current_trade.exit_time = bar_time
                current_trade.pnl_pts = (current_trade.exit_price - current_trade.entry_price) if current_trade.direction == 'LONG' else (current_trade.entry_price - current_trade.exit_price)
                current_trade.pnl_pct = current_trade.pnl_pts / current_trade.entry_price * 100
                current_trade.pnl_r = current_trade.pnl_pts / current_trade.risk_units
                trades.append(current_trade)
                in_trade = False
                current_trade = None
                
            i += 1
            continue

        # If not in trade: State 0 & State 1
        
        # Filter: Skip new entries late in the day (e.g. after 15:00 if intraday)
        if intraday_mode and cur_time >= "15:00":
            i += 1
            continue
            
        if not allow_reentry_same_day and last_trade_date == cur_date:
            i += 1
            continue

        # State 0: Scanning & Box Formulation
        # Box is formed on slice [t - lookback_candles : t] (excluding t+1)
        # Here i represents candle t
        # In intraday mode, ensure box does not span across previous day session if desired,
        # or continuous box. Let's make it standard continuous lookback.
        high_slice = highs[i - lookback_candles + 1 : i + 1]
        low_slice = lows[i - lookback_candles + 1 : i + 1]
        
        box_high = np.max(high_slice)
        box_low = np.min(low_slice)
        box_median = (box_high + box_low) / 2.0
        box_depth = box_high - box_low
        atr_t = atrs[i]
        
        if atr_t <= 0:
            i += 1
            continue
            
        # Volatility Filter: 0.5 * ATR <= box_depth <= 2.5 * ATR
        if not (min_vol_mult * atr_t <= box_depth <= max_vol_mult * atr_t):
            i += 1
            continue
            
        # State 1: Breakout & Entry Engine
        # Scan immediate closing candle t+1 (index i + 1)
        next_i = i + 1
        cand_o = opens[next_i]
        cand_h = highs[next_i]
        cand_l = lows[next_i]
        cand_c = closes[next_i]
        cand_time = timestamps[next_i]
        
        # Don't enter across market open boundary (e.g., if next candle is next day 09:15)
        if intraday_mode and dates[next_i] != cur_date:
            i += 1
            continue
            
        body_height = abs(cand_c - cand_o)
        
        long_condition = (cand_c > box_high) and ((cand_c - box_high) >= (body_confirmation_ratio * body_height))
        short_condition = (cand_c < box_low) and ((box_low - cand_c) >= (body_confirmation_ratio * body_height))
        
        if long_condition:
            entry_price = cand_c
            risk_units = entry_price - box_median
            if risk_units <= 0:
                i += 1
                continue
                
            trade_id += 1
            current_trade = Trade(
                trade_id=trade_id,
                direction='LONG',
                entry_idx=next_i,
                entry_time=cand_time,
                entry_price=entry_price,
                box_high=box_high,
                box_low=box_low,
                box_median=box_median,
                box_depth=box_depth,
                atr=atr_t,
                risk_units=risk_units,
                initial_sl=box_median,
                tp_price=entry_price + (target_multiplier * risk_units),
                be_price=entry_price + (breakeven_r * risk_units)
            )
            in_trade = True
            last_trade_date = cur_date
            i = next_i + 1
            continue
            
        elif short_condition:
            entry_price = cand_c
            risk_units = box_median - entry_price
            if risk_units <= 0:
                i += 1
                continue
                
            trade_id += 1
            current_trade = Trade(
                trade_id=trade_id,
                direction='SHORT',
                entry_idx=next_i,
                entry_time=cand_time,
                entry_price=entry_price,
                box_high=box_high,
                box_low=box_low,
                box_median=box_median,
                box_depth=box_depth,
                atr=atr_t,
                risk_units=risk_units,
                initial_sl=box_median,
                tp_price=entry_price - (target_multiplier * risk_units),
                be_price=entry_price - (breakeven_r * risk_units)
            )
            in_trade = True
            last_trade_date = cur_date
            i = next_i + 1
            continue
            
        i += 1

    trades_df = pd.DataFrame([t.__dict__ for t in trades])
    metrics = calculate_metrics(trades_df)
    return trades_df, metrics


def calculate_metrics(trades_df: pd.DataFrame) -> Dict:
    """Computes comprehensive performance metrics."""
    if len(trades_df) == 0:
        return {"total_trades": 0, "win_rate": 0.0, "net_pnl_pts": 0.0, "profit_factor": 0.0}
        
    wins = trades_df[trades_df['pnl_pts'] > 0]
    losses = trades_df[trades_df['pnl_pts'] < 0]
    evens = trades_df[trades_df['pnl_pts'] == 0]
    
    total_trades = len(trades_df)
    win_count = len(wins)
    loss_count = len(losses)
    even_count = len(evens)
    win_rate = (win_count / total_trades) * 100 if total_trades > 0 else 0.0
    
    gross_profit = wins['pnl_pts'].sum()
    gross_loss = abs(losses['pnl_pts'].sum())
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (99.0 if gross_profit > 0 else 0.0)
    
    net_pnl = trades_df['pnl_pts'].sum()
    avg_trade_pts = trades_df['pnl_pts'].mean()
    avg_win_pts = wins['pnl_pts'].mean() if len(wins) > 0 else 0.0
    avg_loss_pts = losses['pnl_pts'].mean() if len(losses) > 0 else 0.0
    
    # R-multiple stats
    avg_r = trades_df['pnl_r'].mean()
    total_r = trades_df['pnl_r'].sum()
    
    # Drawdown
    cum_pnl = trades_df['pnl_pts'].cumsum()
    peak = cum_pnl.cummax()
    drawdown = peak - cum_pnl
    max_dd_pts = drawdown.max()
    
    # Exit reasons
    reason_counts = trades_df['exit_reason'].value_counts().to_dict()
    
    # Direction breakdown
    longs = trades_df[trades_df['direction'] == 'LONG']
    shorts = trades_df[trades_df['direction'] == 'SHORT']
    long_wr = (len(longs[longs['pnl_pts'] > 0]) / len(longs) * 100) if len(longs) > 0 else 0
    short_wr = (len(shorts[shorts['pnl_pts'] > 0]) / len(shorts) * 100) if len(shorts) > 0 else 0
    
    return {
        "total_trades": total_trades,
        "wins": win_count,
        "losses": loss_count,
        "breakevens": even_count,
        "win_rate": round(win_rate, 2),
        "gross_profit_pts": round(gross_profit, 1),
        "gross_loss_pts": round(gross_loss, 1),
        "net_pnl_pts": round(net_pnl, 1),
        "profit_factor": round(profit_factor, 2),
        "avg_trade_pts": round(avg_trade_pts, 2),
        "avg_win_pts": round(avg_win_pts, 2),
        "avg_loss_pts": round(avg_loss_pts, 2),
        "total_r": round(total_r, 2),
        "avg_r": round(avg_r, 2),
        "max_dd_pts": round(max_dd_pts, 1),
        "exit_reasons": reason_counts,
        "long_trades": len(longs),
        "long_wr": round(long_wr, 1),
        "long_net_pts": round(longs['pnl_pts'].sum(), 1) if len(longs) > 0 else 0,
        "short_trades": len(shorts),
        "short_wr": round(short_wr, 1),
        "short_net_pts": round(shorts['pnl_pts'].sum(), 1) if len(shorts) > 0 else 0
    }

if __name__ == "__main__":
    print("Testing backtest runner...")
    df_1m = load_nifty_data(years=[2026])
    print("Resampling to 5min...")
    df_5m = resample_ohlcv(df_1m, '5min')
    print("Running baseline 5min backtest (Lookback=14, ATR=14, Target=1.5)...")
    t0 = time.time()
    trades, metrics = run_dynamic_box_backtest(df_5m, lookback_candles=14, atr_period=14, target_multiplier=1.5)
    print(f"Done in {time.time()-t0:.2f}s!")
    print("\n--- RESULTS SUMMARY ---")
    for k, v in metrics.items():
        print(f"  {k}: {v}")
