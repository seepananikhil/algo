-- Build DuckDB Parquet file for NIFTY weekly options
-- Run from options_data/nifty directory:
--   duckdb -c ".read scripts/build_parquet.sql"

COPY (
  SELECT DISTINCT ON (Epoch, Symbol)
    Epoch::BIGINT AS epoch,
    Timestamp::TIMESTAMP AS ts,
    InstrumentType AS instrument_type,
    Symbol AS symbol,
    Expiry::DATE AS expiry,
    OptionType AS option_type,
    Strike::DOUBLE AS strike,
    SpotRef::DOUBLE AS spot_ref,
    IndexClose::DOUBLE AS index_close,
    Open::DOUBLE AS open,
    High::DOUBLE AS high,
    Low::DOUBLE AS low,
    Close::DOUBLE AS close,
    Volume::BIGINT AS volume
  FROM read_csv('1min/*/*/*_options_1min_*.csv', union_by_name=true, header=true)
  ORDER BY Epoch, Strike, OptionType
) TO 'parquet/NIFTY_options_master.parquet' (FORMAT parquet, COMPRESSION zstd);
