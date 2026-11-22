# AlgoNeo Strategy Registry

Modular strategy index for AlgoNeo quantitative and paper-trading systems.

---

## 1. Production Live Strategies

| Strategy | Index / Asset | Execution | Description |
| :--- | :--- | :--- | :--- |
| **[Phoenix Swinger 2.0](file:///d:/nikhil/algo/strategies/phoenix_swinger/README.md)** | Equities (Mcap ≥ ₹2k Cr) | Swing Paper | Dual-leg deep base breakouts with -15% SL, +15% Cost Shield, and 25% trailing runner lock. |
| **[Trend Runner](file:///d:/nikhil/algo/strategies/trend_runner/README.md)** | NIFTY & SENSEX | Intraday Options | Multi-timeframe trend following with VIX regime filtering. |
| **[Midpoint Scalper](file:///d:/nikhil/algo/strategies/midpoint_scalper/README.md)** | NIFTY Options | Intraday Options | 1-min & 5-min opening range midpoint breakout & scalping. |
| **[Key Levels Breakout](file:///d:/nikhil/algo/strategies/key_levels/README.md)** | NIFTY & SENSEX | Intraday Options | Institutional daily/weekly S&R levels breakout & retest system. |

---

## 2. Research & Prototype Strategies (`strategies/research/`)

| Strategy Prototype | Directory | Description |
| :--- | :--- | :--- |
| **MTF ORB** | `strategies/research/mtf_orb/` | 5-Year Multi-Timeframe Opening Range Breakout tests & optimizer. |
| **Momentum Retester** | `strategies/research/momentum_retester/` | Scanner & backtests for retests following momentum surges. |
| **Dynamic Volatility Box** | `strategies/research/dynamic_volatility_box/` | Multi-timeframe adaptive box engine and volatility breakout simulator. |
| **Hourly Trend** | `strategies/research/hourly_trend/` | Hourly candle trend follower & equilibrium runner. |
| **PDC Retest Scalp** | `strategies/research/pdc_retest_scalp/` | Previous Day Close (PDC) retest scalper & 3-touch tests. |
| **VIX Divergence** | `strategies/research/vix_divergence/` | India VIX vs Index divergence confluence models. |
| **Compression Scalper** | `strategies/research/compression_scalper/` | Volatility compression and liquidity sweep scalp setups. |
