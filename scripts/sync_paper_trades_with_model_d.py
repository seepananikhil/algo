import pandas as pd
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def sync_sensex():
    bt_path = ROOT / "performance" / "sensex_backtest_trades.csv"
    if not bt_path.exists():
        print("sensex_backtest_trades.csv not found")
        return
    df_bt = pd.read_csv(bt_path)
    # Target dates to sync
    sync_dates = ["2026-11-17", "2026-11-18", "2026-11-23"]
    new_rows = df_bt[df_bt["date"].isin(sync_dates)].copy()
    
    # Paper CSV targets
    targets = [
        ROOT / "performance" / "trend_runner_sensex_paper_trades.csv",
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_sensex_live_paper.csv",
    ]
    
    for t in targets:
        if not t.exists():
            continue
        df_target = pd.read_csv(t)
        # Keep rows not in sync_dates
        df_kept = df_target[~df_target["date"].isin(sync_dates)]
        # Re-align columns
        aligned_new = pd.DataFrame(columns=df_target.columns)
        for col in df_target.columns:
            if col in new_rows.columns:
                aligned_new[col] = new_rows[col]
            else:
                aligned_new[col] = ""
        combined = pd.concat([df_kept, aligned_new], ignore_index=True)
        combined.sort_values(by=["date", "entry_time"], inplace=True)
        combined.to_csv(t, index=False)
        print(f"Updated {t} with {len(aligned_new)} Model D rows.")

def sync_nifty():
    bt_path = ROOT / "performance" / "nifty_10y_backtest_trades.csv"
    if not bt_path.exists():
        print("nifty_10y_backtest_trades.csv not found")
        return
    df_bt = pd.read_csv(bt_path)
    sync_dates = ["2026-11-17", "2026-11-18", "2026-11-23"]
    new_rows = df_bt[df_bt["date"].isin(sync_dates)].copy()
    
    targets = [
        ROOT / "performance" / "trend_runner_paper_trades.csv",
        ROOT / "captured_data" / "fyers" / "live" / "trend_runner_live_paper.csv",
    ]
    
    for t in targets:
        if not t.exists():
            continue
        df_target = pd.read_csv(t)
        df_kept = df_target[~df_target["date"].isin(sync_dates)]
        aligned_new = pd.DataFrame(columns=df_target.columns)
        for col in df_target.columns:
            if col in new_rows.columns:
                aligned_new[col] = new_rows[col]
            else:
                aligned_new[col] = ""
        combined = pd.concat([df_kept, aligned_new], ignore_index=True)
        combined.sort_values(by=["date", "entry_time"], inplace=True)
        combined.to_csv(t, index=False)
        print(f"Updated {t} with {len(aligned_new)} Model D rows.")

if __name__ == "__main__":
    sync_sensex()
    sync_nifty()
