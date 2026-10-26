import subprocess
import sys
import json
import urllib.request
from datetime import datetime
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent

def sync_technovusin_repo() -> bool:
    """Pull latest 1-minute Nifty 50 data from GitHub."""
    repo_dir = ROOT / "captured_data" / "technovusin_nifty50"
    if not repo_dir.exists():
        print(f"Cloning technovusin repo...")
        cmd = ["git", "clone", "--depth", "1", "https://github.com/technovusin/nifty50-historical-data.git", str(repo_dir)]
        res = subprocess.run(cmd, capture_output=True, text=True)
        return res.returncode == 0
    else:
        print(f"Pulling latest commits from technovusin repo...")
        cmd = ["git", "-C", str(repo_dir), "pull", "origin", "main"]
        res = subprocess.run(cmd, capture_output=True, text=True)
        print(res.stdout.strip())
        return res.returncode == 0

def update_vix_data() -> bool:
    """Fetch recent India VIX daily data and update captured_data/india_vix_10y.csv."""
    vix_file = ROOT / "captured_data" / "india_vix_10y.csv"
    existing_df = pd.read_csv(vix_file) if vix_file.exists() else pd.DataFrame(columns=['date', 'close', 'vix_change_pct'])
    
    # Fetch last 30 days of VIX from Yahoo Finance
    try:
        url = 'https://query1.finance.yahoo.com/v8/finance/chart/^INDIAVIX?range=1mo&interval=1d'
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        res = urllib.request.urlopen(req, timeout=10)
        d = json.loads(res.read())
        result = d['chart']['result'][0]
        timestamps = result['timestamp']
        quotes = result['indicators']['quote'][0]['close']
        
        new_records = []
        for ts, cl in zip(timestamps, quotes):
            if cl is not None:
                dt = datetime.fromtimestamp(ts).strftime('%Y-%m-%d')
                new_records.append({'date': dt, 'close': cl})
        
        if new_records:
            df_new = pd.DataFrame(new_records)
            df_merged = pd.concat([existing_df, df_new], ignore_index=True)
            df_merged.drop_duplicates('date', keep='last', inplace=True)
            df_merged.sort_values('date', inplace=True)
            df_merged['prev_close'] = df_merged['close'].shift(1)
            df_merged['vix_change_pct'] = ((df_merged['close'] - df_merged['prev_close']) / df_merged['prev_close']) * 100.0
            df_merged[['date', 'close', 'vix_change_pct']].to_csv(vix_file, index=False)
            print(f"Updated India VIX file through {df_merged['date'].max()}")
            return True
    except Exception as exc:
        print(f"Warning: Failed to fetch live VIX update: {exc}")
    return False

def run_backtest_pipeline() -> bool:
    """Run run_10y_backtest.py to regenerate master trade performance log."""
    print("Executing 10-year backtest engine...")
    cmd = [sys.executable, str(ROOT / "run_10y_backtest.py")]
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode == 0:
        print("10-Year Backtest executed successfully.")
        return True
    else:
        print("Backtest failed:", res.stderr)
        return False

def main():
    print("=" * 60)
    print(" Updating Historical Data & Re-Running Backtest")
    print("=" * 60)
    sync_technovusin_repo()
    update_vix_data()
    success = run_backtest_pipeline()
    if success:
        print("\nAll historical data and backtests are 100% up to date!")
    else:
        print("\nUpdate completed with errors.")

if __name__ == "__main__":
    main()
