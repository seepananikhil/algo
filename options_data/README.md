# Options OHLC Data (NIFTY & SENSEX)

Historical Weekly Expiry Option Intraday OHLC data (1-minute candles) aligned with Spot Index candles, following the structure and design of [nifty50-historical-data](https://github.com/technovusin/nifty50-historical-data).

## Data Structure

```text
options_data/
├── nifty/
│   ├── 1min/
│   │   └── 2026/
│   │       ├── NIFTY_options_1min_2026-10-08.csv
│   │       └── NIFTY_options_1min_2026-10-15.csv
│   ├── parquet/               # Parquet files built with DuckDB (not in git)
│   │   └── NIFTY_options_master.parquet
│   ├── scripts/
│   │   └── build_parquet.sql  # DuckDB script to compile Parquet files
│   └── README.md
│
└── sensex/
    ├── 1min/
    │   └── 2026/
    │       └── SENSEX_options_1min_2026-10-08.csv
    ├── parquet/               # Parquet files built with DuckDB (not in git)
    │   └── SENSEX_options_master.parquet
    ├── scripts/
    │   └── build_parquet.sql
    └── README.md
```

## File Format

Each CSV file contains 1-minute candles for the spot index along with a strike ladder ($\pm 15$ strikes above and below the 09:15 open for both CE and PE):

| Column | Type | Description |
|---|---|---|
| `Epoch` | BIGINT | Unix timestamp (seconds since 1970-01-01) |
| `Timestamp` | TIMESTAMP | ISO 8601 format (`YYYY-MM-DDTHH:MM:SS`), IST |
| `InstrumentType` | VARCHAR | `INDEX` or `OPTION` |
| `Symbol` | VARCHAR | Full exchange symbol (e.g., `BSE:SENSEX24O0872500CE`) |
| `Expiry` | DATE | Expiry date (`YYYY-MM-DD`) |
| `OptionType` | VARCHAR | `CE`, `PE`, or empty for index |
| `Strike` | DOUBLE | Strike price |
| `SpotRef` | DOUBLE | 09:15 IST opening spot price used as anchor |
| `IndexClose` | DOUBLE | Simultaneous spot index close price for that minute |
| `Open` | DOUBLE | Candle open |
| `High` | DOUBLE | Candle high |
| `Low` | DOUBLE | Candle low |
| `Close` | DOUBLE | Candle close |
| `Volume` | BIGINT | Traded volume |
| `DuplicateCount`| INT | Duplicate resolution metric |

## Building Parquet for Fast Backtesting

Run from `options_data/nifty` or `options_data/sensex`:

```bash
duckdb -c ".read scripts/build_parquet.sql"
```

## Fast Backtesting Query Example (Python & DuckDB)

```python
import duckdb

# Query ATM and near-ATM calls on expiry day in milliseconds:
df = duckdb.query("""
    SELECT Timestamp, Symbol, Strike, OptionType, Close, IndexClose
    FROM 'options_data/sensex/parquet/SENSEX_options_master.parquet'
    WHERE Expiry = '2026-10-08'
      AND OptionType = 'CE'
      AND Strike BETWEEN 72000 AND 73000
    ORDER BY Epoch, Strike
""").df()

print(df.head())
```
