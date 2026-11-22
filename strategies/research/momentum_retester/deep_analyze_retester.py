import pandas as pd
import numpy as np
import pickle
import json

# 1. Load raw returns
df_raw = pd.read_csv('retester_raw_forward_returns.csv')
print(f"Total raw records: {len(df_raw)}")

# Analyze unmanaged forward returns
horizons = ['1d', '3d', '5d', '10d', '20d', '40d', '60d']

print("\n--- UNMANAGED FORWARD RETURNS (BUY AT EOD OF -4% DIP) ---")
res_eod = []
for h in horizons:
    col = f'ret_{h}_close'
    valid = df_raw[col].dropna()
    wins = valid[valid > 0]
    wr = len(wins) / len(valid) * 100
    avg = valid.mean()
    med = valid.median()
    avg_w = wins.mean() if len(wins) > 0 else 0
    avg_l = abs(valid[valid <= 0].mean()) if len(valid[valid <= 0]) > 0 else 0
    pf = (wins.sum() / abs(valid[valid <= 0].sum())) if abs(valid[valid <= 0].sum()) > 0 else np.nan
    res_eod.append({
        'Horizon': f"+{h}",
        'Samples': len(valid),
        'Win Rate (%)': round(wr, 1),
        'Avg Return (%)': round(avg, 2),
        'Median Return (%)': round(med, 2),
        'Avg Win (%)': round(avg_w, 2),
        'Avg Loss (%)': round(avg_l, 2),
        'Profit Factor': round(pf, 2)
    })

df_res_eod = pd.DataFrame(res_eod)
print(df_res_eod.to_string(index=False))

print("\n--- UNMANAGED FORWARD RETURNS (BUY AT NEXT DAY OPEN) ---")
res_open = []
for h in horizons:
    col = f'ret_{h}_open'
    valid = df_raw[col].dropna()
    wins = valid[valid > 0]
    wr = len(wins) / len(valid) * 100
    avg = valid.mean()
    med = valid.median()
    avg_w = wins.mean() if len(wins) > 0 else 0
    avg_l = abs(valid[valid <= 0].mean()) if len(valid[valid <= 0]) > 0 else 0
    pf = (wins.sum() / abs(valid[valid <= 0].sum())) if abs(valid[valid <= 0].sum()) > 0 else np.nan
    res_open.append({
        'Horizon': f"+{h}",
        'Samples': len(valid),
        'Win Rate (%)': round(wr, 1),
        'Avg Return (%)': round(avg, 2),
        'Median Return (%)': round(med, 2),
        'Avg Win (%)': round(avg_w, 2),
        'Avg Loss (%)': round(avg_l, 2),
        'Profit Factor': round(pf, 2)
    })

df_res_open = pd.DataFrame(res_open)
print(df_res_open.to_string(index=False))

print("\n--- EXCURSION ANALYSIS (MFE = Max Peak, MAE = Max Drawdown) ---")
print(f"20-Day MFE (Avg Peak Gain): {df_raw['mfe_20'].mean():.2f}% | Median: {df_raw['mfe_20'].median():.2f}%")
print(f"20-Day MAE (Avg Max Dip)  : {df_raw['mae_20'].mean():.2f}% | Median: {df_raw['mae_20'].median():.2f}%")
print(f"60-Day MFE (Avg Peak Gain): {df_raw['mfe_60'].mean():.2f}% | Median: {df_raw['mfe_60'].median():.2f}%")
print(f"60-Day MAE (Avg Max Dip)  : {df_raw['mae_60'].mean():.2f}% | Median: {df_raw['mae_60'].median():.2f}%")

# Percentage of trades that dip further after the -4% trigger:
dip_more_5 = (df_raw['mae_20'] < -5).mean() * 100
dip_more_10 = (df_raw['mae_20'] < -10).mean() * 100
peak_more_10 = (df_raw['mfe_20'] > 10).mean() * 100
peak_more_20 = (df_raw['mfe_20'] > 20).mean() * 100
print(f"\n% of stocks dipping >5% further within 20 days: {dip_more_5:.1f}%")
print(f"% of stocks dipping >10% further within 20 days: {dip_more_10:.1f}%")
print(f"% of stocks surging >10% within 20 days: {peak_more_10:.1f}%")
print(f"% of stocks surging >20% within 20 days: {peak_more_20:.1f}%")
