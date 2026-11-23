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
FYERS_CONFIG_FILE = ROOT / "fyers_config.json"
KOTAK_TOKEN_FILE = ROOT / "captured_data" / "kotak" / "kotak_token.json"


def get_neo_client() -> NeoAPI:
    """Return an authenticated Kotak Neo NeoAPI client instance."""
    consumer_key = os.getenv("NEO_CONSUMER_KEY")
    mobile_number = os.getenv("NEO_MOBILE_NUMBER")
    ucc = os.getenv("NEO_UCC")
    totp_key = os.getenv("NEO_TOTP_KEY") or os.getenv("NEO_TOTP_SECRET")
    mpin = os.getenv("NEO_MPIN")

    if CONFIG_FILE.exists():
        try:
            cfg = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            consumer_key = consumer_key or cfg.get("consumer_key")
            mobile_number = mobile_number or cfg.get("mobile_number")
            ucc = ucc or cfg.get("ucc")
            totp_key = totp_key or cfg.get("totp_key") or cfg.get("totp_secret")
            mpin = mpin or cfg.get("mpin")
        except Exception:
            pass

    # Fallback to fyers_config.json's kotak_neo block
    if not consumer_key and FYERS_CONFIG_FILE.exists():
        try:
            cfg = json.loads(FYERS_CONFIG_FILE.read_text(encoding="utf-8"))
            k_cfg = cfg.get("kotak_neo", {})
            consumer_key = consumer_key or k_cfg.get("consumer_key")
            mobile_number = mobile_number or k_cfg.get("mobile_number")
            ucc = ucc or k_cfg.get("ucc")
            totp_key = totp_key or k_cfg.get("totp_secret") or k_cfg.get("totp_key")
            mpin = mpin or k_cfg.get("mpin")
        except Exception:
            pass

    if not consumer_key or consumer_key == "dummy_consumer_key":
        print("[NOTICE] Dummy or missing Kotak Neo credentials detected. Update secrets in GitHub to enable live market data fetching.")
        return None

    # Try attaching saved session tokens if still valid
    token_data = None
    if KOTAK_TOKEN_FILE.exists():
        try:
            token_data = json.loads(KOTAK_TOKEN_FILE.read_text(encoding="utf-8"))
        except Exception:
            token_data = None

    client = NeoAPI(consumer_key=consumer_key, environment="prod")

    if token_data and "trade_token" in token_data:
        client.configuration.edit_token = token_data.get("trade_token")
        client.configuration.edit_sid = token_data.get("edit_sid") or token_data.get("sid")
        client.configuration.edit_rid = token_data.get("edit_rid") or token_data.get("rid")
        client.configuration.bearer_token = token_data.get("view_token")
        client.configuration.view_token = token_data.get("view_token")
        client.configuration.sid = token_data.get("view_sid") or token_data.get("sid")
        client.configuration.base_url = token_data.get("base_url")
        client.configuration.data_center = token_data.get("data_center")
        client.configuration.ucc = token_data.get("ucc")
        return client

    # If full credentials are provided, perform TOTP login and MPIN validation
    if mobile_number and ucc and totp_key and mpin:
        try:
            import pyotp
            clean_totp = totp_key.strip().replace(" ", "").upper()
            totp_code = pyotp.TOTP(clean_totp).now()
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

    return client


if __name__ == "__main__":
    try:
        c = get_neo_client()
        print("Kotak Neo client initialized successfully.")
    except Exception as exc:
        print(f"Auth error: {exc}")
