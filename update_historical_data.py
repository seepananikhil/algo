import subprocess
import sys
import json
import urllib.request
from datetime import datetime
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).resolve().parent

def sync_technovusin_repo() -> bool:
    """Pull latest 1-minute Nifty 50 and Sensex data from GitHub."""
    repos = [
        ("NIFTY 50", ROOT / "captured_data" / "technovusin_nifty50", "https://github.com/technovusin/nifty50-historical-data.git"),
        ("SENSEX", ROOT / "captured_data" / "technovusin_sensex", "https://github.com/technovusin/sensex-historical-data.git")
    ]
    all_ok = True
    for name, repo_dir, url in repos:
        if not repo_dir.exists():
            print(f"Cloning {name} technovusin repo...")
            cmd = ["git", "clone", "--depth", "1", url, str(repo_dir)]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode != 0:
                print(f"Failed to clone {name}:", res.stderr)
                all_ok = False
        else:
            print(f"Pulling latest commits from {name} technovusin repo...")
            cmd = ["git", "-C", str(repo_dir), "pull", "origin", "main"]
            res = subprocess.run(cmd, capture_output=True, text=True)
            print(f"[{name}] {res.stdout.strip()}")
            if res.returncode != 0:
                all_ok = False
    return all_ok

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

def update_trading_days_cache():
    """Update captured_data/trading_days.json quickly by checking latest year's data."""
    base = ROOT / "captured_data" / "technovusin_nifty50" / "1min"
    if not base.exists():
        return
    out_file = ROOT / "captured_data" / "trading_days.json"
    existing_days = []
    if out_file.exists():
        try:
            existing_days = json.loads(out_file.read_text())
        except Exception:
            existing_days = []
            
    days = set(existing_days)
    current_year = str(datetime.now().year)
    latest_dir = base / current_year
    if not latest_dir.exists():
        years = sorted([p for p in base.iterdir() if p.is_dir() and p.name.isdigit()], key=lambda p: int(p.name))
        latest_dir = years[-1] if years else base

    files_to_scan = list(latest_dir.glob("*.csv")) if latest_dir != base else list(base.rglob("*.csv"))
    for f in files_to_scan:
        try:
            col = 'Timestamp' if 'Timestamp' in pd.read_csv(f, nrows=1).columns else 'timestamp'
            df = pd.read_csv(f, usecols=[col])
            days.update(df[col].astype(str).str.slice(0, 10).unique())
        except Exception:
            continue
    days = sorted([d for d in days if len(d) == 10 and d[4] == '-' and d[7] == '-'], reverse=True)
    out_file.write_text(json.dumps(days))
    print(f"Updated trading days cache ({len(days)} days).")

def run_backtest_pipeline() -> bool:
    """Run Trend Runner (Nifty & Sensex) and Midpoint backtests to regenerate master trade performance logs."""
    print("Executing Nifty 10-year Trend Runner backtest engine...")
    cmd1 = [sys.executable, str(ROOT / "run_10y_backtest.py")]
    res1 = subprocess.run(cmd1, capture_output=True, text=True)
    if res1.returncode != 0:
        print("Nifty Trend Runner backtest failed:", res1.stderr)
        return False
    print("Nifty Trend Runner 10-Year Backtest completed.")

    print("Executing Sensex Multi-Year Trend Runner backtest engine...")
    cmd_s = [sys.executable, str(ROOT / "run_sensex_multiyear_trend_backtest.py")]
    res_s = subprocess.run(cmd_s, capture_output=True, text=True)
    if res_s.returncode != 0:
        print("Sensex Trend Runner backtest failed:", res_s.stderr)
        return False
    print("Sensex Trend Runner Multi-Year Backtest completed.")

    print("Executing 10-year Midpoint backtest engine...")
    cmd2 = [sys.executable, str(ROOT / "run_10y_midpoint_backtest.py")]
    res2 = subprocess.run(cmd2, capture_output=True, text=True)
    if res2.returncode != 0:
        print("Midpoint backtest failed:", res2.stderr)
        return False
    print("Midpoint Strategy 10-Year Backtest completed.")
    return True

def main():
    print("=" * 60)
    print(" Updating Historical Data & Re-Running Backtest Pipeline")
    print("=" * 60)
    sync_technovusin_repo()
    update_vix_data()
    update_trading_days_cache()
    success = run_backtest_pipeline()
    if success:
        print("\nAll historical data and 10-year backtests are 100% up to date!")
    else:
        print("\nUpdate completed with errors.")

if __name__ == "__main__":
    main()
