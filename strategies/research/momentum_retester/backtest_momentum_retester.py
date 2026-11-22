import pandas as pd
import numpy as np
import pickle
import os
import json
from datetime import datetime

# Load signals
df_signals = pd.read_csv('momentum_retester_signals.csv')
print(f"Loaded {len(df_signals)} signals.")

cache_file = 'scratch/retester_prices.pkl'
if not os.path.exists(cache_file):
    print(f"Error: {cache_file} does not exist yet.")
    exit(1)

with open(cache_file, 'rb') as f:
    price_data = pickle.load(f)

print(f"Loaded price data for {len(price_data)} symbols.")

# -------------------------------------------------------------
# Part 1: Raw Forward Performance (Unmanaged EOD & Next Day Open)
# -------------------------------------------------------------
raw_results = []

for idx, row in df_signals.iterrows():
    s = row['symbol']
    t_date = pd.to_datetime(row['date'])
    
    if s not in price_data:
        continue
    
    df_p = price_data[s]
    sub = df_p[df_p.index <= t_date]
    if sub.empty:
        continue
    
    actual_t_date = sub.index[-1]
    if abs((actual_t_date - t_date).days) > 4:
        continue
    
    t_idx = df_p.index.get_loc(actual_t_date)
    close_t = df_p['Close'].iloc[t_idx]
    
    future = df_p.iloc[t_idx:]
    flen = len(future) - 1
    
    if flen < 1:
        continue
        
    next_open = future['Open'].iloc[1]
    
    # Forward Returns from EOD Close
    ret_1d_close = (future['Close'].iloc[1] / close_t - 1) * 100 if flen >= 1 else np.nan
    ret_3d_close = (future['Close'].iloc[3] / close_t - 1) * 100 if flen >= 3 else np.nan
    ret_5d_close = (future['Close'].iloc[5] / close_t - 1) * 100 if flen >= 5 else np.nan
    ret_10d_close = (future['Close'].iloc[10] / close_t - 1) * 100 if flen >= 10 else np.nan
    ret_20d_close = (future['Close'].iloc[20] / close_t - 1) * 100 if flen >= 20 else np.nan
    ret_40d_close = (future['Close'].iloc[40] / close_t - 1) * 100 if flen >= 40 else np.nan
    ret_60d_close = (future['Close'].iloc[60] / close_t - 1) * 100 if flen >= 60 else np.nan
    
    # Forward Returns from Next Day Open
    ret_1d_open = (future['Close'].iloc[1] / next_open - 1) * 100 if flen >= 1 else np.nan
    ret_3d_open = (future['Close'].iloc[3] / next_open - 1) * 100 if flen >= 3 else np.nan
    ret_5d_open = (future['Close'].iloc[5] / next_open - 1) * 100 if flen >= 5 else np.nan
    ret_10d_open = (future['Close'].iloc[10] / next_open - 1) * 100 if flen >= 10 else np.nan
    ret_20d_open = (future['Close'].iloc[20] / next_open - 1) * 100 if flen >= 20 else np.nan
    ret_40d_open = (future['Close'].iloc[40] / next_open - 1) * 100 if flen >= 40 else np.nan
    ret_60d_open = (future['Close'].iloc[60] / next_open - 1) * 100 if flen >= 60 else np.nan

    # Excursions (MFE/MAE over 20 days)
    f20 = future.iloc[1:min(21, len(future))]
    mfe_20 = ((f20['High'].max() / close_t) - 1) * 100 if not f20.empty else np.nan
    mae_20 = ((f20['Low'].min() / close_t) - 1) * 100 if not f20.empty else np.nan

    # Excursions over 60 days
    f60 = future.iloc[1:min(61, len(future))]
    mfe_60 = ((f60['High'].max() / close_t) - 1) * 100 if not f60.empty else np.nan
    mae_60 = ((f60['Low'].min() / close_t) - 1) * 100 if not f60.empty else np.nan

    raw_results.append({
        'symbol': s,
        'trigger_date': actual_t_date.strftime('%Y-%m-%d'),
        'close_t': close_t,
        'next_open': next_open,
        'ret_1d_close': ret_1d_close,
        'ret_3d_close': ret_3d_close,
        'ret_5d_close': ret_5d_close,
        'ret_10d_close': ret_10d_close,
        'ret_20d_close': ret_20d_close,
        'ret_40d_close': ret_40d_close,
        'ret_60d_close': ret_60d_close,
        'ret_1d_open': ret_1d_open,
        'ret_3d_open': ret_3d_open,
        'ret_5d_open': ret_5d_open,
        'ret_10d_open': ret_10d_open,
        'ret_20d_open': ret_20d_open,
        'ret_40d_open': ret_40d_open,
        'ret_60d_open': ret_60d_open,
        'mfe_20': mfe_20,
        'mae_20': mae_20,
        'mfe_60': mfe_60,
        'mae_60': mae_60,
        'cap': row.get('cap', ''),
        'sector': row.get('sector', '')
    })

df_raw = pd.DataFrame(raw_results)
df_raw.to_csv('retester_raw_forward_returns.csv', index=False)
print(f"Evaluated {len(df_raw)} raw forward return signals.")

# -------------------------------------------------------------
# Part 2: Strategy Simulations
# -------------------------------------------------------------

def simulate_strategy_eod_blind(signals_df, p_data):
    """Buy EOD on -4% dip day. Stop: 7% or low of dip. Target: +20% / 20-EMA trail."""
    trades = []
    for idx, row in signals_df.iterrows():
        s = row['symbol']
        t_date = pd.to_datetime(row['trigger_date'])
        df_p = p_data[s]
        t_idx = df_p.index.get_loc(t_date)
        
        entry_price = df_p['Close'].iloc[t_idx]
        entry_date = t_date
        
        # Stop loss: 7% below entry, or 0.5% below trigger low (whichever is closer/safer, cap max 7%)
        sl_price = max(entry_price * 0.93, df_p['Low'].iloc[t_idx] * 0.995)
        risk_pct = (entry_price - sl_price) / entry_price * 100
        target_price = entry_price * (1 + 2 * (risk_pct / 100)) # 2R target
        target_price = max(target_price, entry_price * 1.15) # min 15% target
        
        # Evaluate future candles up to 60 trading days
        future = df_p.iloc[t_idx + 1 : min(t_idx + 61, len(df_p))]
        if future.empty:
            continue
            
        ema20 = df_p['Close'].ewm(span=20, adjust=False).mean()
        
        exit_price = None
        exit_date = None
        exit_reason = None
        days = 0
        
        for f_idx, (f_date, f_row) in enumerate(future.iterrows()):
            days = f_idx + 1
            # 1. Check Stop Loss hit
            if f_row['Low'] <= sl_price:
                exit_price = min(f_row['Open'], sl_price) if f_row['Open'] < sl_price else sl_price
                exit_date = f_date
                exit_reason = 'STOP_LOSS'
                break
            
            # 2. Check Target hit
            if f_row['High'] >= target_price:
                exit_price = max(f_row['Open'], target_price) if f_row['Open'] > target_price else target_price
                exit_date = f_date
                exit_reason = 'TARGET_HIT'
                break
                
            # 3. Trailing Stop: If gained > 8%, trail with 20 EMA
            if f_row['Close'] > entry_price * 1.08:
                trail_level = ema20.loc[f_date]
                if trail_level > sl_price:
                    sl_price = trail_level
            
            # End of horizon (60 days)
            if days >= 60 or f_idx == len(future) - 1:
                # If still holding and at recent edge (< 5 days from latest data), it's active
                if (df_p.index[-1] - f_date).days <= 3 and days < 50:
                    exit_reason = 'ACTIVE'
                    exit_price = f_row['Close']
                    exit_date = f_date
                else:
                    exit_reason = 'TIME_EXIT_60D'
                    exit_price = f_row['Close']
                    exit_date = f_date
                break
                
        pnl_pct = ((exit_price / entry_price) - 1) * 100
        trades.append({
            'strategy': 'Blind EOD Entry',
            'symbol': s,
            'entry_date': entry_date.strftime('%Y-%m-%d'),
            'exit_date': exit_date.strftime('%Y-%m-%d') if exit_date is not None else '',
            'entry_price': round(entry_price, 2),
            'exit_price': round(exit_price, 2) if exit_price is not None else 0,
            'pnl_pct': round(pnl_pct, 2),
            'days_held': days,
            'exit_reason': exit_reason,
            'status': 'OPEN' if exit_reason == 'ACTIVE' else 'CLOSED'
        })
    return pd.DataFrame(trades)

def simulate_strategy_confirmed_reversal(signals_df, p_data):
    """Wait up to 5 days after -4% dip for a Confirmed Green Reversal Candle."""
    trades = []
    
    for idx, row in signals_df.iterrows():
        s = row['symbol']
        t_date = pd.to_datetime(row['trigger_date'])
        df_p = p_data[s]
        t_idx = df_p.index.get_loc(t_date)
        
        # Look ahead up to 5 days for green confirmation
        window = df_p.iloc[t_idx + 1 : min(t_idx + 6, len(df_p))]
        if window.empty:
            continue
            
        confirmed_idx = None
        pullback_low = df_p['Low'].iloc[t_idx]
        
        for w_i, (w_date, w_row) in enumerate(window.iterrows()):
            pullback_low = min(pullback_low, w_row['Low'])
            # Green reversal condition: Close > Open AND (Close > Prev Close)
            prev_close = df_p['Close'].iloc[t_idx + w_i]
            if w_row['Close'] > w_row['Open'] and w_row['Close'] > prev_close:
                confirmed_idx = t_idx + 1 + w_i
                break
                
        if confirmed_idx is None:
            # No confirmation within 5 days -> strategy avoids catching the falling knife!
            continue
            
        entry_date = df_p.index[confirmed_idx]
        entry_price = df_p['Close'].iloc[confirmed_idx]
        
        sl_price = max(entry_price * 0.93, pullback_low * 0.995)
        risk_pct = (entry_price - sl_price) / entry_price * 100
        target_price = entry_price * (1 + 2 * (risk_pct / 100))
        target_price = max(target_price, entry_price * 1.15)
        
        future = df_p.iloc[confirmed_idx + 1 : min(confirmed_idx + 61, len(df_p))]
        if future.empty:
            continue
            
        ema20 = df_p['Close'].ewm(span=20, adjust=False).mean()
        
        exit_price = None
        exit_date = None
        exit_reason = None
        days = 0
        
        for f_idx, (f_date, f_row) in enumerate(future.iterrows()):
            days = f_idx + 1
            if f_row['Low'] <= sl_price:
                exit_price = min(f_row['Open'], sl_price) if f_row['Open'] < sl_price else sl_price
                exit_date = f_date
                exit_reason = 'STOP_LOSS'
                break
                
            if f_row['High'] >= target_price:
                exit_price = max(f_row['Open'], target_price) if f_row['Open'] > target_price else target_price
                exit_date = f_date
                exit_reason = 'TARGET_HIT'
                break
                
            if f_row['Close'] > entry_price * 1.08:
                trail_level = ema20.loc[f_date]
                if trail_level > sl_price:
                    sl_price = trail_level
                    
            if days >= 60 or f_idx == len(future) - 1:
                if (df_p.index[-1] - f_date).days <= 3 and days < 50:
                    exit_reason = 'ACTIVE'
                    exit_price = f_row['Close']
                    exit_date = f_date
                else:
                    exit_reason = 'TIME_EXIT_60D'
                    exit_price = f_row['Close']
                    exit_date = f_date
                break
                
        pnl_pct = ((exit_price / entry_price) - 1) * 100
        trades.append({
            'strategy': 'Confirmed Green Reversal',
            'symbol': s,
            'entry_date': entry_date.strftime('%Y-%m-%d'),
            'exit_date': exit_date.strftime('%Y-%m-%d') if exit_date is not None else '',
            'entry_price': round(entry_price, 2),
            'exit_price': round(exit_price, 2) if exit_price is not None else 0,
            'pnl_pct': round(pnl_pct, 2),
            'days_held': days,
            'exit_reason': exit_reason,
            'status': 'OPEN' if exit_reason == 'ACTIVE' else 'CLOSED'
        })
    return pd.DataFrame(trades)

# Run simulations
df_blind = simulate_strategy_eod_blind(df_raw, price_data)
df_conf = simulate_strategy_confirmed_reversal(df_raw, price_data)

df_blind.to_csv('retester_trades_blind_eod.csv', index=False)
df_conf.to_csv('retester_trades_confirmed_reversal.csv', index=False)

print(f"Blind EOD trades generated: {len(df_blind)}")
print(f"Confirmed Reversal trades generated: {len(df_conf)}")

# Compute metrics
def calc_metrics(df_t, name):
    closed = df_t[df_t['status'] == 'CLOSED']
    if len(closed) == 0:
        return {'Strategy': name, 'Total Trades': 0}
    
    wins = closed[closed['pnl_pct'] > 0]
    losses = closed[closed['pnl_pct'] <= 0]
    
    win_rate = (len(wins) / len(closed)) * 100
    avg_win = wins['pnl_pct'].mean() if len(wins) > 0 else 0
    avg_loss = abs(losses['pnl_pct'].mean()) if len(losses) > 0 else 0
    
    total_gain = wins['pnl_pct'].sum() if len(wins) > 0 else 0
    total_loss = abs(losses['pnl_pct'].sum()) if len(losses) > 0 else 0
    profit_factor = (total_gain / total_loss) if total_loss > 0 else np.nan
    payoff = (avg_win / avg_loss) if avg_loss > 0 else np.nan
    expectancy = (win_rate / 100 * avg_win) - ((100 - win_rate) / 100 * avg_loss)
    
    return {
        'Strategy': name,
        'Total Trades': len(closed),
        'Wins': len(wins),
        'Losses': len(losses),
        'Win Rate (%)': round(win_rate, 1),
        'Avg Win (%)': round(avg_win, 2),
        'Avg Loss (%)': round(avg_loss, 2),
        'Payoff Ratio': round(payoff, 2),
        'Profit Factor': round(profit_factor, 2),
        'Expectancy (%)': round(expectancy, 2),
        'Avg Days Held': round(closed['days_held'].mean(), 1),
        'Target Exits': len(closed[closed['exit_reason'] == 'TARGET_HIT']),
        'Stop Exits': len(closed[closed['exit_reason'] == 'STOP_LOSS']),
        'Time Exits': len(closed[closed['exit_reason'] == 'TIME_EXIT_60D'])
    }

m1 = calc_metrics(df_blind, 'Blind EOD Entry (on -4% dip)')
m2 = calc_metrics(df_conf, 'Retest Green Confirmation')

summary_df = pd.DataFrame([m1, m2])
print("\n=== PERFORMANCE COMPARISON ===")
print(summary_df.to_string(index=False))

with open('scratch/retester_metrics.json', 'w') as f:
    json.dump({'comparison': [m1, m2]}, f, indent=2)
