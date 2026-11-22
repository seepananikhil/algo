import requests
from bs4 import BeautifulSoup
import json
from datetime import datetime
import pandas as pd

session = requests.Session()
headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
}

r = session.get('https://chartink.com/screener/momentum-retester', headers=headers)
soup = BeautifulSoup(r.text, 'html.parser')
csrf = soup.find('meta', {'name': 'csrf-token'})['content']

scanner_tag = soup.find('scanner')
query = json.loads(scanner_tag.get(':scan-json'))['atlas_query']
print("Atlas query:", query)

post_headers = {
    'User-Agent': headers['User-Agent'],
    'X-CSRF-TOKEN': csrf,
    'Referer': 'https://chartink.com/screener/momentum-retester',
    'X-Requested-With': 'XMLHttpRequest'
}

# 1. Live scan
res_live = session.post('https://chartink.com/screener/process', headers=post_headers, data={'scan_clause': query})
print("Live status:", res_live.status_code)
live_data = res_live.json()
print("Live triggers today:", live_data.get('recordsTotal', 0))
for s in live_data.get('data', []):
    print(" ", s.get('nsecode'), "Close:", s.get('close'), "Change:", s.get('per_chg'), "% Vol:", s.get('volume'))

# 2. Backtest endpoint
res_bt = session.post('https://chartink.com/backtest/process', headers=post_headers, data={'scan_clause': query, 'max_rows': '160'})
print("Backtest status:", res_bt.status_code)
bt_data = res_bt.json()
with open('momentum_retester_bt_resp.json', 'w') as f:
    json.dump(bt_data, f, indent=2)

trade_times = bt_data['metaData'][0]['tradeTimes']
aggregated = bt_data['aggregatedStockList']

signals = []
for t_ms, items in zip(trade_times, aggregated):
    date_str = datetime.fromtimestamp(t_ms / 1000).strftime('%Y-%m-%d')
    for i in range(0, len(items), 3):
        symbol = items[i]
        cap = items[i+1] if i+1 < len(items) else ''
        sector = items[i+2] if i+2 < len(items) else ''
        signals.append({'date': date_str, 'symbol': symbol, 'cap': cap, 'sector': sector})

df_sig = pd.DataFrame(signals)
print(f"Total historical signals extracted: {len(df_sig)}")
print(f"Unique symbols: {df_sig['symbol'].nunique()}")
print(df_sig.head(15))
df_sig.to_csv('momentum_retester_signals.csv', index=False)
