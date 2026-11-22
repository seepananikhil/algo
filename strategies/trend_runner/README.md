# Trend Runner Strategy

Multi-Timeframe Trend Following & Breakout Execution on NIFTY & SENSEX Index Options.

## Core Rules
- **Timeframe**: 5-Minute Candle Breakout with 1-Minute Tick Confirmation
- **Indices**: NIFTY 50 (ITM-150 / Dynamic Strike) & SENSEX (ATM / Dynamic Strike)
- **Filters**: India VIX regime filter, Opening Range (09:15-09:30) Breakout
- **Execution**: Paper orders with real-time Kotak tick prices

## File References
- **Runner**: [trend_runner_paper.py](file:///d:/nikhil/algo/trend_runner_paper.py)
- **Live Paper CSV**: `captured_data/fyers/live/trend_runner_live_paper.csv`
- **Signals CSV**: `performance/trend_runner_signals.csv`
- **Sensex Signals CSV**: `performance/trend_runner_sensex_signals.csv`
