import pandas as pd
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

for name, fname in [("Sensex", "sensex_backtest_trades.csv"), ("Nifty", "nifty_10y_backtest_trades.csv")]:
    p = ROOT / "performance" / fname
    if not p.exists():
        continue
    df = pd.read_csv(p)
    print("=" * 60)
    print(f"=== {name.upper()} PYRAMIDING & STAGING ANALYSIS ===")
    print("=" * 60)
    print(f"Total Trades: {len(df)}")
    
    # Check pyramided column
    if "pyramided" in df.columns:
        pyr = df[df["pyramided"] == True]
        non_pyr = df[df["pyramided"] == False]
        pyr_wins = (pyr["pnl_points"] > 0).sum()
        pyr_losses = (pyr["pnl_points"] < 0).sum()
        pyr_wr = (pyr_wins / len(pyr) * 100) if len(pyr) else 0
        
        non_pyr_wins = (non_pyr["pnl_points"] > 0).sum()
        non_pyr_wr = (non_pyr_wins / len(non_pyr) * 100) if len(non_pyr) else 0
        
        print(f"Pyramided Trades Count:     {len(pyr)} ({len(pyr)/len(df)*100:.1f}% of all trades)")
        print(f"Pyramided Win Rate:         {pyr_wr:.1f}% ({pyr_wins}W / {pyr_losses}L)")
        print(f"Pyramided Total Points:     {pyr['pnl_points'].sum():.1f} pts (Avg: {pyr['pnl_points'].mean():.1f} pts/trade)")
        print(f"Non-Pyramided Win Rate:     {non_pyr_wr:.1f}%")
        print(f"Non-Pyramided Total Points: {non_pyr['pnl_points'].sum():.1f} pts (Avg: {non_pyr['pnl_points'].mean():.1f} pts/trade)")
        
        if "weighted_pnl_points" in df.columns:
            base_pts = df["pnl_points"].sum()
            w_pts = df["weighted_pnl_points"].sum()
            extra_pts = w_pts - base_pts
            pct_boost = (extra_pts / base_pts) * 100 if base_pts != 0 else 0
            print(f"\nNet Points Comparison:")
            print(f"  * 1-Lot Flat Baseline:       {base_pts:,.1f} pts")
            print(f"  * Pyramided Weighted Total:  {w_pts:,.1f} pts")
            print(f"  * Pyramiding Boost:          +{extra_pts:,.1f} pts (+{pct_boost:.1f}%)")
            
    if "stage" in df.columns:
        print(f"\nStage Breakdown:")
        for stage, grp in df.groupby("stage"):
            w = (grp["pnl_points"] > 0).sum()
            wr = (w / len(grp)) * 100
            print(f"  * {stage:20s}: {len(grp):4d} trades | WR: {wr:4.1f}% | Total: {grp['pnl_points'].sum():8.1f} pts | Avg: {grp['pnl_points'].mean():5.1f} pts")
    print()
