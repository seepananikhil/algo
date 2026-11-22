import pandas as pd
import numpy as np
import pickle
import os

with open('scratch/retester_prices.pkl', 'rb') as f:
    price_data = pickle.load(f)

df_signals = pd.read_csv('momentum_retester_signals.csv')

def run_strategy_variations(df_signals, price_data):
    results = []
    
    # -------------------------------------------------------------
    # 1. Blind EOD with 10% Stop Loss & 25% Target (or 20 EMA trail)
    # -------------------------------------------------------------
    t1 = []
    for idx, row in df_signals.iterrows():
        s = row['symbol']
        t_date = pd.to_datetime(row['date'])
        if s not in price_data: continue
        df_p = price_data[s]
        sub = df_p[df_p.index <= t_date]
        if sub.empty: continue
        t_idx = df_p.index.get_loc(sub.index[-1])
        if abs((sub.index[-1] - t_date).days) > 4: continue
        
        entry_price = df_p['Close'].iloc[t_idx]
        entry_date = sub.index[-1]
        sl_price = entry_price * 0.90 # 10% stop loss
        tp_price = entry_price * 1.25 # 25% target
        
        future = df_p.iloc[t_idx + 1 : min(t_idx + 61, len(df_p))]
        if future.empty: continue
        
        ema20 = df_p['Close'].ewm(span=20, adjust=False).mean()
        exit_p, exit_d, exit_r, days = None, None, None, 0
        
        for f_i, (f_d, f_r) in enumerate(future.iterrows()):
            days = f_i + 1
            if f_r['Low'] <= sl_price:
                exit_p = min(f_r['Open'], sl_price) if f_r['Open'] < sl_price else sl_price
                exit_d = f_d
                exit_r = 'STOP_LOSS'
                break
            if f_r['High'] >= tp_price:
                exit_p = max(f_r['Open'], tp_price) if f_r['Open'] > tp_price else tp_price
                exit_d = f_d
                exit_r = 'TARGET_HIT'
                break
            # Trail 20 EMA once > 10% in profit
            if f_r['Close'] > entry_price * 1.10:
                cur_ema = ema20.loc[f_d]
                if cur_ema > sl_price:
                    sl_price = cur_ema
            if days >= 60 or f_i == len(future) - 1:
                exit_p = f_r['Close']
                exit_d = f_d
                exit_r = 'TIME_EXIT'
                break
                
        pnl = (exit_p / entry_price - 1) * 100
        t1.append({'strategy': '1. Blind EOD (10% SL, 25% TP, EMA Trail)', 'pnl': pnl, 'days': days, 'exit': exit_r})

    # -------------------------------------------------------------
    # 2. Retest Confirmation (Wait for Bullish Pivot / Green Candle)
    #    Look up to 7 days for Close > Open AND Close > Prev Close
    #    Stop placed at the swing low of the dip (capped at 8% max)
    #    Target: 2R / 25%, EMA trailing
    # -------------------------------------------------------------
    t2 = []
    for idx, row in df_signals.iterrows():
        s = row['symbol']
        t_date = pd.to_datetime(row['date'])
        if s not in price_data: continue
        df_p = price_data[s]
        sub = df_p[df_p.index <= t_date]
        if sub.empty: continue
        t_idx = df_p.index.get_loc(sub.index[-1])
        if abs((sub.index[-1] - t_date).days) > 4: continue
        
        window = df_p.iloc[t_idx + 1 : min(t_idx + 8, len(df_p))]
        if window.empty: continue
        
        confirmed_idx = None
        pullback_low = df_p['Low'].iloc[t_idx]
        
        for w_i, (w_d, w_r) in enumerate(window.iterrows()):
            pullback_low = min(pullback_low, w_r['Low'])
            prev_close = df_p['Close'].iloc[t_idx + w_i]
            # Bullish confirmation: Green day closing higher than previous close
            if w_r['Close'] > w_r['Open'] and w_r['Close'] > prev_close:
                confirmed_idx = t_idx + 1 + w_i
                break
                
        if confirmed_idx is None:
            continue # Skipped! Aoided non-reversing knife!
            
        entry_price = df_p['Close'].iloc[confirmed_idx]
        entry_date = df_p.index[confirmed_idx]
        
        # Stop loss at swing low of dip minus 0.5%, max 8% stop
        sl_price = max(entry_price * 0.92, pullback_low * 0.995)
        risk = (entry_price - sl_price) / entry_price
        tp_price = entry_price * (1 + max(0.18, 2.5 * risk)) # 2.5R or 18% min
        
        future = df_p.iloc[confirmed_idx + 1 : min(confirmed_idx + 61, len(df_p))]
        if future.empty: continue
        
        ema20 = df_p['Close'].ewm(span=20, adjust=False).mean()
        exit_p, exit_d, exit_r, days = None, None, None, 0
        
        for f_i, (f_d, f_r) in enumerate(future.iterrows()):
            days = f_i + 1
            if f_r['Low'] <= sl_price:
                exit_p = min(f_r['Open'], sl_price) if f_r['Open'] < sl_price else sl_price
                exit_d = f_d
                exit_r = 'STOP_LOSS'
                break
            if f_r['High'] >= tp_price:
                exit_p = max(f_r['Open'], tp_price) if f_r['Open'] > tp_price else tp_price
                exit_d = f_d
                exit_r = 'TARGET_HIT'
                break
            if f_r['Close'] > entry_price * 1.08:
                cur_ema = ema20.loc[f_d]
                if cur_ema > sl_price:
                    sl_price = cur_ema
            if days >= 60 or f_i == len(future) - 1:
                exit_p = f_r['Close']
                exit_d = f_d
                exit_r = 'TIME_EXIT'
                break
                
        pnl = (exit_p / entry_price - 1) * 100
        t2.append({'strategy': '2. Retest Green Confirmation (Pivot Entry)', 'pnl': pnl, 'days': days, 'exit': exit_r})

    # -------------------------------------------------------------
    # 3. High Break Confirmation (Momentum Resumption)
    #    Enter only when price breaks above trigger day High within 5 days
    #    Stop placed at lowest low of the dip
    # -------------------------------------------------------------
    t3 = []
    for idx, row in df_signals.iterrows():
        s = row['symbol']
        t_date = pd.to_datetime(row['date'])
        if s not in price_data: continue
        df_p = price_data[s]
        sub = df_p[df_p.index <= t_date]
        if sub.empty: continue
        t_idx = df_p.index.get_loc(sub.index[-1])
        if abs((sub.index[-1] - t_date).days) > 4: continue
        
        trigger_high = df_p['High'].iloc[t_idx]
        window = df_p.iloc[t_idx + 1 : min(t_idx + 6, len(df_p))]
        if window.empty: continue
        
        break_idx = None
        dip_low = df_p['Low'].iloc[t_idx]
        
        for w_i, (w_d, w_r) in enumerate(window.iterrows()):
            dip_low = min(dip_low, w_r['Low'])
            if w_r['High'] >= trigger_high:
                break_idx = t_idx + 1 + w_i
                break
                
        if break_idx is None:
            continue
            
        entry_price = trigger_high # buy on break
        sl_price = max(entry_price * 0.92, dip_low * 0.995)
        risk = (entry_price - sl_price) / entry_price
        tp_price = entry_price * (1 + max(0.20, 2.5 * risk))
        
        future = df_p.iloc[break_idx + 1 : min(break_idx + 61, len(df_p))]
        if future.empty: continue
        
        ema20 = df_p['Close'].ewm(span=20, adjust=False).mean()
        exit_p, exit_d, exit_r, days = None, None, None, 0
        
        for f_i, (f_d, f_r) in enumerate(future.iterrows()):
            days = f_i + 1
            if f_r['Low'] <= sl_price:
                exit_p = min(f_r['Open'], sl_price) if f_r['Open'] < sl_price else sl_price
                exit_d = f_d
                exit_r = 'STOP_LOSS'
                break
            if f_r['High'] >= tp_price:
                exit_p = max(f_r['Open'], tp_price) if f_r['Open'] > tp_price else tp_price
                exit_d = f_d
                exit_r = 'TARGET_HIT'
                break
            if f_r['Close'] > entry_price * 1.08:
                cur_ema = ema20.loc[f_d]
                if cur_ema > sl_price:
                    sl_price = cur_ema
            if days >= 60 or f_i == len(future) - 1:
                exit_p = f_r['Close']
                exit_d = f_d
                exit_r = 'TIME_EXIT'
                break
                
        pnl = (exit_p / entry_price - 1) * 100
        t3.append({'strategy': '3. High Break Confirmation (Above Dip High)', 'pnl': pnl, 'days': days, 'exit': exit_r})

    # -------------------------------------------------------------
    # 4. Pure 20-EMA Touch Entry (Limit order at 20-EMA)
    #    Since this is a momentum retest, buy when price touches 20 EMA within 5 days
    # -------------------------------------------------------------
    t4 = []
    for idx, row in df_signals.iterrows():
        s = row['symbol']
        t_date = pd.to_datetime(row['date'])
        if s not in price_data: continue
        df_p = price_data[s]
        sub = df_p[df_p.index <= t_date]
        if sub.empty: continue
        t_idx = df_p.index.get_loc(sub.index[-1])
        if abs((sub.index[-1] - t_date).days) > 4: continue
        
        ema20 = df_p['Close'].ewm(span=20, adjust=False).mean()
        window = df_p.iloc[t_idx + 1 : min(t_idx + 6, len(df_p))]
        if window.empty: continue
        
        touch_idx = None
        for w_i, (w_d, w_r) in enumerate(window.iterrows()):
            cur_ema = ema20.loc[w_d]
            if w_r['Low'] <= cur_ema <= w_r['High']:
                touch_idx = t_idx + 1 + w_i
                break
                
        if touch_idx is None:
            continue
            
        entry_price = ema20.iloc[touch_idx]
        sl_price = entry_price * 0.92 # 8% stop below 20 EMA
        tp_price = entry_price * 1.25 # 25% target
        
        future = df_p.iloc[touch_idx + 1 : min(touch_idx + 61, len(df_p))]
        if future.empty: continue
        
        exit_p, exit_d, exit_r, days = None, None, None, 0
        for f_i, (f_d, f_r) in enumerate(future.iterrows()):
            days = f_i + 1
            if f_r['Low'] <= sl_price:
                exit_p = min(f_r['Open'], sl_price) if f_r['Open'] < sl_price else sl_price
                exit_d = f_d
                exit_r = 'STOP_LOSS'
                break
            if f_r['High'] >= tp_price:
                exit_p = max(f_r['Open'], tp_price) if f_r['Open'] > tp_price else tp_price
                exit_d = f_d
                exit_r = 'TARGET_HIT'
                break
            if f_r['Close'] > entry_price * 1.10:
                cur_e = ema20.loc[f_d]
                if cur_e > sl_price:
                    sl_price = cur_e
            if days >= 60 or f_i == len(future) - 1:
                exit_p = f_r['Close']
                exit_d = f_d
                exit_r = 'TIME_EXIT'
                break
                
        pnl = (exit_p / entry_price - 1) * 100
        t4.append({'strategy': '4. 20-EMA Retest Touch (Limit Order)', 'pnl': pnl, 'days': days, 'exit': exit_r})

    return pd.DataFrame(t1), pd.DataFrame(t2), pd.DataFrame(t3), pd.DataFrame(t4)

df1, df2, df3, df4 = run_strategy_variations(df_signals, price_data)

def summarize(df_res, label):
    wins = df_res[df_res['pnl'] > 0]
    losses = df_res[df_res['pnl'] <= 0]
    wr = len(wins) / len(df_res) * 100 if len(df_res) > 0 else 0
    avg_w = wins['pnl'].mean() if len(wins) > 0 else 0
    avg_l = abs(losses['pnl'].mean()) if len(losses) > 0 else 0
    tot_w = wins['pnl'].sum() if len(wins) > 0 else 0
    tot_l = abs(losses['pnl'].sum()) if len(losses) > 0 else 0
    pf = (tot_w / tot_l) if tot_l > 0 else np.nan
    payoff = (avg_w / avg_l) if avg_l > 0 else np.nan
    exp = (wr / 100 * avg_w) - ((100 - wr) / 100 * avg_l)
    return {
        'Strategy': label,
        'Trades': len(df_res),
        'Win Rate (%)': round(wr, 1),
        'Avg Win (%)': round(avg_w, 2),
        'Avg Loss (%)': round(avg_l, 2),
        'Payoff': round(payoff, 2),
        'Profit Factor': round(pf, 2),
        'Expectancy (%)': round(exp, 2),
        'Avg Days': round(df_res['days'].mean(), 1),
        'Target Hits': (df_res['exit'] == 'TARGET_HIT').sum(),
        'Stop Losses': (df_res['exit'] == 'STOP_LOSS').sum(),
        'Time Exits': (df_res['exit'] == 'TIME_EXIT').sum()
    }

metrics = [
    summarize(df1, '1. Blind EOD (10% SL, 25% TP, EMA Trail)'),
    summarize(df2, '2. Retest Green Confirmation (Pivot Entry)'),
    summarize(df3, '3. High Break Confirmation (Above Dip High)'),
    summarize(df4, '4. 20-EMA Retest Touch (Limit Order)')
]

summary_table = pd.DataFrame(metrics)
print("\n" + "="*80)
print("COMPREHENSIVE BACKTEST SUMMARY FOR 'momentum-retester'")
print("="*80)
print(summary_table.to_string(index=False))

df1.to_csv('scratch/strat1_blind.csv', index=False)
df2.to_csv('scratch/strat2_confirmed.csv', index=False)
df3.to_csv('scratch/strat3_highbreak.csv', index=False)
df4.to_csv('scratch/strat4_ema20.csv', index=False)
