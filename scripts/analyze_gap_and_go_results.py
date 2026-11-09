#!/usr/bin/env python3
"""
Performance & Edge Analyzer for NIFTY Gap-and-Go -> Williams Chain
Generates rich tabular analysis, edge validation, and stress test metrics.
"""

import os
import pandas as pd
import numpy as np

def generate_report(csv_path='performance/gap_and_go_williams_official_trades.csv'):
    if not os.path.exists(csv_path):
        print(f"Error: {csv_path} does not exist.")
        return

    df = pd.read_csv(csv_path)
    total_trades = len(df)
    if total_trades == 0:
        print("No trades generated.")
        return

    print("=" * 95)
    print("      NIFTY GAP-AND-GO -> WILLIAMS CHAIN : EDGE & BACKTEST PERFORMANCE REPORT")
    print("      (Strategy Source: OptionsBuyer.in · Research Study)")
    print("=" * 95)

    # 1. High level metrics
    def get_stats(sub_df, name=""):
        n = len(sub_df)
        if n == 0:
            return {}
        wins = sub_df[sub_df['net_pts_base'] > 0]
        losses = sub_df[sub_df['net_pts_base'] <= 0]
        wr = len(wins) / n * 100.0
        
        sum_win = wins['net_pts_base'].sum()
        sum_loss = abs(losses['net_pts_base'].sum())
        pf = sum_win / sum_loss if sum_loss > 0 else np.nan
        
        avg_win = wins['net_pts_base'].mean() if len(wins) > 0 else 0.0
        avg_loss = abs(losses['net_pts_base'].mean()) if len(losses) > 0 else 0.0
        rr = avg_win / avg_loss if avg_loss > 0 else np.nan
        
        tot_pts_base = sub_df['net_pts_base'].sum()
        tot_pts_stress = sub_df['net_pts_stressed'].sum()
        avg_pts_base = sub_df['net_pts_base'].mean()
        avg_pts_stress = sub_df['net_pts_stressed'].mean()
        
        # Max drawdown in points
        sub_df = sub_df.copy()
        sub_df['cum_pts'] = sub_df['net_pts_base'].cumsum()
        peak = sub_df['cum_pts'].cummax()
        dd = sub_df['cum_pts'] - peak
        max_dd_pts = dd.min()

        # INR PnL
        tot_inr_base = sub_df['pnl_inr_base'].sum()
        tot_inr_stress = sub_df['pnl_inr_stressed'].sum()
        tot_inr_mod = sub_df['pnl_inr_modern'].sum()

        return {
            'Name': name,
            'Trades': n,
            'Win Rate %': wr,
            'Profit Factor': pf,
            'Realized RR': rr,
            'Avg Win (pts)': avg_win,
            'Avg Loss (pts)': avg_loss,
            'Net Pts (Base 0.1%)': tot_pts_base,
            'Net Pts (Stress 0.3%)': tot_pts_stress,
            'Expectancy / Trade': avg_pts_base,
            'Max DD (pts)': max_dd_pts,
            'Total PnL (Dynamic 5L)': tot_inr_base,
            'Total PnL (Stressed 5L)': tot_inr_stress,
            'Total PnL (Modern 125Q)': tot_inr_mod
        }

    overall_stats = get_stats(df, "Combined Strategy Chain")

    print(f"Total Sample Period:            {df['date'].min()} to {df['date'].max()} (~10 Years)")
    print(f"Total Executed Trades:          {overall_stats['Trades']}")
    print(f"Win Rate (Base Costs):          {overall_stats['Win Rate %']:.1f}%")
    print(f"Profit Factor (Base Costs):     {overall_stats['Profit Factor']:.2f}")
    print(f"Realized Win/Loss Ratio (RR):   1 : {overall_stats['Realized RR']:.2f}")
    print(f"Average Win:                    +{overall_stats['Avg Win (pts)']:.2f} pts")
    print(f"Average Loss:                   -{overall_stats['Avg Loss (pts)']:.2f} pts")
    print(f"Expectancy (Net Pts / Trade):   {overall_stats['Expectancy / Trade']:+.2f} pts")
    print(f"Total Net Points (0.1% cost):   {overall_stats['Net Pts (Base 0.1%)']:+.2f} pts")
    print(f"Total Net Points (0.3% stress): {overall_stats['Net Pts (Stress 0.3%)']:+.2f} pts")
    print(f"Max Drawdown (Points):          {overall_stats['Max DD (pts)']:.2f} pts")
    print("-" * 95)
    print(f"TOTAL REALIZED INR (Dynamic 5 Lots):  Rs. {overall_stats['Total PnL (Dynamic 5L)']:,.0f}")
    print(f"TOTAL REALIZED INR (Stressed 5 Lots): Rs. {overall_stats['Total PnL (Stressed 5L)']:,.0f}")
    print(f"TOTAL REALIZED INR (Modern 125 Qty):  Rs. {overall_stats['Total PnL (Modern 125Q)']:,.0f}")
    print("=" * 95)

    # 2. Stage Breakdown
    print("\n" + "=" * 95)
    print("                           BOT / STAGE ATTRIBUTION BREAKDOWN")
    print("=" * 95)
    stg_records = []
    for stg, grp in df.groupby('stage'):
        stg_records.append(get_stats(grp, stg))
    
    stg_df = pd.DataFrame(stg_records)
    print(f"{'Bot / Stage':<20} | {'Trades':<8} | {'Win Rate':<10} | {'PF':<6} | {'Avg Win':<10} | {'Avg Loss':<10} | {'Net Pts':<12} | {'Total INR (5L)':<16}")
    print("-" * 95)
    for idx, row in stg_df.iterrows():
        print(f"{row['Name']:<20} | {row['Trades']:<8} | {row['Win Rate %']:<9.1f}% | {row['Profit Factor']:<6.2f} | {row['Avg Win (pts)']:<+9.2f} | {row['Avg Loss (pts)']:<-9.2f} | {row['Net Pts (Base 0.1%)']:<+11.2f} | Rs. {row['Total PnL (Dynamic 5L)']:<14,.0f}")
    print("-" * 95)

    # 3. Exit Reason Analysis
    print("\n" + "=" * 95)
    print("                                EXIT REASON DISTRIBUTION")
    print("=" * 95)
    print(f"{'Exit Reason':<22} | {'Count':<7} | {'% of Total':<12} | {'Win Rate':<10} | {'Avg Net Pts':<14} | {'Total Net Pts':<14}")
    print("-" * 95)
    for reason, grp in df.groupby('exit_reason'):
        cnt = len(grp)
        pct = cnt / total_trades * 100.0
        w_cnt = len(grp[grp['net_pts_base'] > 0])
        wr = w_cnt / cnt * 100.0
        avg_pts = grp['net_pts_base'].mean()
        tot_pts = grp['net_pts_base'].sum()
        print(f"{reason:<22} | {cnt:<7} | {pct:<11.1f}% | {wr:<9.1f}% | {avg_pts:<+13.2f} | {tot_pts:<+13.2f}")
    print("-" * 95)

    # 4. Year by Year Breakdown
    print("\n" + "=" * 95)
    print("                               YEAR-BY-YEAR PERFORMANCE")
    print("=" * 95)
    print(f"{'Year':<6} | {'Trades':<7} | {'Win Rate':<9} | {'PF':<6} | {'Net Pts (0.1%)':<15} | {'Net Pts (0.3%)':<15} | {'Avg Pts':<9} | {'Year Total INR (5L)':<20}")
    print("-" * 95)
    for yr, grp in df.groupby('year'):
        s = get_stats(grp, str(yr))
        print(f"{yr:<6} | {s['Trades']:<7} | {s['Win Rate %']:<8.1f}% | {s['Profit Factor']:<6.2f} | {s['Net Pts (Base 0.1%)']:<+14.2f} | {s['Net Pts (Stress 0.3%)']:<+14.2f} | {s['Expectancy / Trade']:<+8.2f} | Rs. {s['Total PnL (Dynamic 5L)']:<18,.0f}")
    print("=" * 95)

    # 5. Long vs Short Bias
    print("\n" + "=" * 95)
    print("                             LONG (CE) VS SHORT (PE) BIAS")
    print("=" * 95)
    for opt_type, grp in df.groupby('type'):
        s = get_stats(grp, opt_type)
        print(f"Type: {opt_type:<4} | Trades: {s['Trades']:<5} | Win Rate: {s['Win Rate %']:<5.1f}% | PF: {s['Profit Factor']:<5.2f} | Net Pts: {s['Net Pts (Base 0.1%)']:<+10.2f} | Avg Pts: {s['Expectancy / Trade']:<+7.2f} | INR: Rs. {s['Total PnL (Dynamic 5L)']:,.0f}")
    print("=" * 95)

if __name__ == '__main__':
    generate_report()
