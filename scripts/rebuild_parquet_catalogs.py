#!/usr/bin/env python3
"""
Rebuild DuckDB Parquet Catalogs for NIFTY and SENSEX Options Data.
Can be executed standalone, as part of the daily sync pipeline, or in GitHub Actions.
"""

import sys
import os
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def rebuild_nifty_parquet() -> bool:
    print("[PARQUET] Rebuilding NIFTY options parquet catalog...", flush=True)
    t0 = time.time()
    nifty_dir = ROOT / "options_data" / "nifty"
    sql_file = nifty_dir / "scripts" / "build_parquet.sql"
    out_parquet = nifty_dir / "parquet" / "NIFTY_options_master.parquet"
    out_parquet.parent.mkdir(parents=True, exist_ok=True)
    
    if not sql_file.exists():
        print(f"[PARQUET ERROR] SQL script missing: {sql_file}")
        return False

    orig_cwd = os.getcwd()
    try:
        import duckdb
        os.chdir(str(nifty_dir))
        sql = sql_file.read_text(encoding="utf-8")
        con = duckdb.connect()
        con.execute(sql)
        con.close()
        sz_mb = out_parquet.stat().st_size / (1024 * 1024) if out_parquet.exists() else 0
        elapsed = time.time() - t0
        print(f"[PARQUET SUCCESS] NIFTY parquet built in {elapsed:.1f}s ({sz_mb:.1f} MB): {out_parquet}")
        return True
    except Exception as exc:
        print(f"[PARQUET ERROR] Failed building NIFTY parquet: {exc}")
        return False
    finally:
        os.chdir(orig_cwd)

def rebuild_sensex_parquet() -> bool:
    print("[PARQUET] Rebuilding SENSEX options parquet catalog...", flush=True)
    t0 = time.time()
    sensex_dir = ROOT / "options_data" / "sensex"
    sql_file = sensex_dir / "scripts" / "build_parquet.sql"
    out_parquet = sensex_dir / "parquet" / "SENSEX_options_master.parquet"
    out_parquet.parent.mkdir(parents=True, exist_ok=True)
    
    if not sql_file.exists():
        print(f"[PARQUET ERROR] SQL script missing: {sql_file}")
        return False

    orig_cwd = os.getcwd()
    try:
        import duckdb
        os.chdir(str(sensex_dir))
        sql = sql_file.read_text(encoding="utf-8")
        con = duckdb.connect()
        con.execute(sql)
        con.close()
        sz_mb = out_parquet.stat().st_size / (1024 * 1024) if out_parquet.exists() else 0
        elapsed = time.time() - t0
        print(f"[PARQUET SUCCESS] SENSEX parquet built in {elapsed:.1f}s ({sz_mb:.1f} MB): {out_parquet}")
        return True
    except Exception as exc:
        print(f"[PARQUET ERROR] Failed building SENSEX parquet: {exc}")
        return False
    finally:
        os.chdir(orig_cwd)

def main():
    print("=" * 60)
    print(" DuckDB Options Parquet Catalog Builder")
    print("=" * 60)
    ok_n = rebuild_nifty_parquet()
    ok_s = rebuild_sensex_parquet()
    if ok_n and ok_s:
        print("\nAll options parquet catalogs updated successfully!")
        sys.exit(0)
    else:
        print("\nCompleted with errors.")
        sys.exit(1)

if __name__ == "__main__":
    main()
