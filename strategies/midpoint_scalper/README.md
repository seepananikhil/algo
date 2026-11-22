# Midpoint Scalper Strategy

1-Minute & 5-Minute Midpoint Range Breakout & Scalping for NIFTY Index Options.

## Core Rules
- **Breakout Detection**: 15-Minute Opening Range Midpoint crossing with momentum
- **Target / SL**: Dynamic ATR multiples with trailing stop lock
- **Backtest Dataset**: 10-Year historical 1-minute NIFTY candles

## File References
- **Strategy**: [midpoint_strategy.py](file:///d:/nikhil/algo/midpoint_strategy.py)
- **Backtest**: [backtest_midpoint_strategy.py](file:///d:/nikhil/algo/backtest_midpoint_strategy.py)
- **10Y Simulator**: [run_10y_midpoint_backtest.py](file:///d:/nikhil/algo/run_10y_midpoint_backtest.py)
- **Trade Records**: `performance/the_scalper_nifty_trades.csv`
