import pandas as pd
import numpy as np

df1 = pd.read_csv('scratch/strat1_blind.csv')
df4 = pd.read_csv('scratch/strat4_ema20.csv')
df_raw = pd.read_csv('retester_raw_forward_returns.csv')

df_raw['month'] = pd.to_datetime(df_raw['trigger_date']).dt.to_period('M')

print("Top 10 raw 20-day gainers after trigger:")
print(df_raw.sort_values(by='mfe_20', ascending=False)[['symbol', 'trigger_date', 'close_t', 'mfe_20', 'ret_20d_close', 'sector']].head(10).to_string(index=False))

print("\nWorst 10 raw 20-day drawdowns after trigger:")
print(df_raw.sort_values(by='mae_20', ascending=True)[['symbol', 'trigger_date', 'close_t', 'mae_20', 'ret_20d_close', 'sector']].head(10).to_string(index=False))

monthly = df_raw.groupby('month').agg(
    signals=('symbol', 'count'),
    avg_ret_20=('ret_20d_close', 'mean'),
    win_rate=('ret_20d_close', lambda x: (x > 0).mean() * 100),
    avg_mfe=('mfe_20', 'mean'),
    avg_mae=('mae_20', 'mean')
).reset_index()

print("\n--- MONTHLY BREAKDOWN (20-DAY HOLD) ---")
print(monthly.to_string(index=False))

# Sector breakdown
sector_agg = df_raw.groupby('sector').agg(
    signals=('symbol', 'count'),
    avg_ret_20=('ret_20d_close', 'mean'),
    win_rate=('ret_20d_close', lambda x: (x > 0).mean() * 100)
).sort_values(by='signals', ascending=False).head(10).reset_index()

print("\n--- TOP SECTORS BREAKDOWN ---")
print(sector_agg.to_string(index=False))
