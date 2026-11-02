# Paper Trading Directory

Starting fresh for November 2026.

## Structure
All live paper trades and execution signals are logged by session:
```text
paper/
├── hero_zero/
│   └── YYYY/MM/DD/
│       ├── hero_zero_candidates_YYYY-MM-DD.csv
│       ├── hero_zero_trades_YYYY-MM-DD.csv
│       └── hero_zero_status_YYYY-MM-DD.json
├── midpoint/
│   └── YYYY/MM/DD/
│       ├── strategy_trades_YYYY-MM-DD.csv
│       ├── signals_YYYY-MM-DD.csv
│       └── live_orders_YYYY-MM-DD.csv
├── key_levels/
│   └── YYYY/MM/DD/
├── scalper/
│   └── YYYY/MM/DD/
└── trend_runner/
    └── YYYY/MM/DD/
```
