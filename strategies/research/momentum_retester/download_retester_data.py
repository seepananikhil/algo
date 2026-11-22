import pandas as pd
import numpy as np
import yfinance as yf
import os
import pickle
from datetime import datetime

# 1. Load signals
df_signals = pd.read_csv('momentum_retester_signals.csv')
print(f"Total signals loaded: {len(df_signals)}")
symbols = sorted(df_signals['symbol'].unique())
print(f"Unique symbols: {len(symbols)}")

os.makedirs('scratch', exist_ok=True)
cache_file = 'scratch/retester_prices.pkl'

price_data = {}
if os.path.exists(cache_file):
    try:
        with open(cache_file, 'rb') as f:
            price_data = pickle.load(f)
        print(f"Loaded {len(price_data)} cached symbols from {cache_file}")
    except Exception as e:
        print(f"Cache load error: {e}")
        price_data = {}

# Check which symbols need downloading
missing_symbols = [s for s in symbols if s not in price_data]
print(f"Symbols needing download: {len(missing_symbols)}")

if missing_symbols:
    for i, s in enumerate(missing_symbols):
        if (i + 1) % 20 == 0 or i == len(missing_symbols) - 1:
            print(f"Downloading {i+1}/{len(missing_symbols)}: {s}")
        ticker = f"{s}.NS"
        try:
            df_t = yf.download(ticker, period="2y", interval="1d", progress=False, auto_adjust=False)
            if df_t.empty or len(df_t) < 30:
                ticker_bse = f"{s}.BO"
                df_t = yf.download(ticker_bse, period="2y", interval="1d", progress=False, auto_adjust=False)
            if not df_t.empty and len(df_t) >= 10:
                if isinstance(df_t.columns, pd.MultiIndex):
                    df_t.columns = [c[0] for c in df_t.columns]
                df_t.index = pd.to_datetime(df_t.index).tz_localize(None)
                price_data[s] = df_t
        except Exception as e:
            pass

    with open(cache_file, 'wb') as f:
        pickle.dump(price_data, f)
    print(f"Saved total {len(price_data)} symbols to {cache_file}")

print(f"Price data available for {len(price_data)} symbols.")
