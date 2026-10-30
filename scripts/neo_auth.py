#!/usr/bin/env python3
"""Kotak Neo authentication helper for local development and GitHub Actions.

Authenticates headlessly using:
  - NEO_CONSUMER_KEY
  - NEO_MOBILE_NUMBER
  - NEO_UCC
  - NEO_TOTP_KEY
  - NEO_MPIN
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

try:
    from neo_api_client import NeoAPI
except ImportError:
    print("kotakneoapi is not installed. Install with: pip install kotakneoapi")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILE = ROOT / "neo_config.json"


def get_neo_client() -> NeoAPI:
    """Return an authenticated Kotak Neo NeoAPI client instance."""
    consumer_key = os.getenv("NEO_CONSUMER_KEY")
    mobile_number = os.getenv("NEO_MOBILE_NUMBER")
    ucc = os.getenv("NEO_UCC")
    totp_key = os.getenv("NEO_TOTP_KEY")
    mpin = os.getenv("NEO_MPIN")

    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            consumer_key = consumer_key or cfg.get("consumer_key")
            mobile_number = mobile_number or cfg.get("mobile_number")
            ucc = ucc or cfg.get("ucc")
            totp_key = totp_key or cfg.get("totp_key")
            mpin = mpin or cfg.get("mpin")
        except Exception:
            pass

    if not consumer_key or consumer_key == "dummy_consumer_key":
        print("[NOTICE] Dummy Kotak Neo credentials detected. Update secrets in GitHub to enable live market data fetching.")
        return None

    client = NeoAPI(consumer_key=consumer_key, environment="prod")

    # If full credentials are provided, perform TOTP login and MPIN validation
    if mobile_number and ucc and totp_key and mpin:
        try:
            import pyotp
            totp_code = pyotp.TOTP(totp_key.strip().replace(" ", "")).now()
        except ImportError:
            raise RuntimeError("pyotp is required for automated TOTP generation. Run: pip install pyotp")

        # Step 1: Login with TOTP
        login_res = client.totp_login(
            mobile_number=mobile_number,
            ucc=ucc,
            totp=totp_code
        )

        # Step 2: Validate MPIN
        validate_res = client.totp_validate(mpin=mpin)
        return client

    # For market data queries (historical_data, quotes, scrip_master), consumer_key alone is sufficient
    return client


if __name__ == "__main__":
    try:
        c = get_neo_client()
        print("Kotak Neo client initialized successfully.")
    except Exception as exc:
        print(f"Auth error: {exc}")
