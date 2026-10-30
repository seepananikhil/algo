#!/usr/bin/env python3
"""Headless Fyers authentication for local and GitHub Actions runners.

Checks if an existing token in captured_data/fyers/fyers_access_token.json is valid.
If invalid or missing, it authenticates automatically using environment variables:
  - FYERS_APP_ID
  - FYERS_SECRET_KEY
  - FYERS_CLIENT_ID
  - FYERS_PIN
  - FYERS_TOTP_KEY
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import requests

try:
    from fyers_apiv3 import fyersModel
except ImportError:
    print("fyers_apiv3 not installed. Please run: pip install fyers-apiv3")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"


def get_authenticated_client() -> fyersModel.FyersModel:
    """Return a working FyersModel client, authenticating headlessly if needed."""
    if TOKEN_FILE.exists():
        try:
            stored = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
            app_id = stored.get("app_id") or os.getenv("FYERS_APP_ID")
            token = stored.get("access_token")
            if app_id and token:
                client = fyersModel.FyersModel(client_id=app_id, token=token, is_async=False, log_path="/tmp")
                profile = client.get_profile()
                if profile.get("s") == "ok":
                    return client
        except Exception:
            pass

    # Needs re-authentication
    app_id = os.getenv("FYERS_APP_ID")
    secret_key = os.getenv("FYERS_SECRET_KEY")
    client_id = os.getenv("FYERS_CLIENT_ID")
    pin = os.getenv("FYERS_PIN")
    totp_key = os.getenv("FYERS_TOTP_KEY")

    # If env vars are missing, try reading fyers_config.json
    config_file = ROOT / "fyers_config.json"
    if config_file.exists():
        cfg = json.loads(config_file.read_text(encoding="utf-8"))
        app_id = app_id or cfg.get("app_id")
        secret_key = secret_key or cfg.get("secret_key")
        client_id = client_id or cfg.get("client_id")
        pin = pin or cfg.get("pin")
        totp_key = totp_key or cfg.get("totp_key")

    if not (app_id and secret_key and client_id and pin and totp_key):
        raise RuntimeError(
            "Valid access token not found and credentials missing. "
            "Set FYERS_APP_ID, FYERS_SECRET_KEY, FYERS_CLIENT_ID, FYERS_PIN, and FYERS_TOTP_KEY."
        )

    try:
        import pyotp
    except ImportError:
        raise RuntimeError("pyotp is required for headless TOTP login. Run: pip install pyotp")

    totp = pyotp.TOTP(totp_key.strip().replace(" ", ""))
    current_otp = totp.now()

    # Step 1: Send login OTP
    session = requests.Session()
    headers = {"User-Agent": "Mozilla/5.0"}

    app_id_type = "2"
    send_otp_payload = {
        "fy_id": client_id,
        "app_id": app_id_type
    }
    r1 = session.post("https://api-t1.fyers.in/api/v3/generate-authcode", json=send_otp_payload, headers=headers)
    r1_json = r1.json()
    if r1_json.get("s") != "ok":
        # Fallback to direct auth code if already authenticated
        pass

    request_key = r1_json.get("request_key")

    # Step 2: Verify TOTP
    verify_otp_payload = {
        "request_key": request_key,
        "otp": current_otp
    }
    r2 = session.post("https://api-t1.fyers.in/api/v3/validate-authcode", json=verify_otp_payload, headers=headers)
    r2_json = r2.json()
    request_key_2 = r2_json.get("request_key")

    # Step 3: Verify PIN
    verify_pin_payload = {
        "request_key": request_key_2,
        "identity_type": "pin",
        "identifier": pin
    }
    r3 = session.post("https://api-t1.fyers.in/api/v3/verify-pin", json=verify_pin_payload, headers=headers)
    r3_json = r3.json()
    token_url = r3_json.get("data", {}).get("token")
    if not token_url:
        raise RuntimeError(f"Headless authentication failed during PIN verification: {r3_json}")

    auth_code = token_url

    # Step 4: Exchange auth code for access_token
    app_id_hash = hashlib.sha256(f"{app_id}:{secret_key}".encode("utf-8")).hexdigest()
    session_model = fyersModel.SessionModel(
        client_id=app_id,
        secret_key=secret_key,
        redirect_uri="https://trade.fyers.in/api-login/redirect-uri/index.html",
        response_type="code",
        grant_type="authorization_code"
    )
    session_model.set_token(auth_code)
    response = session_model.generate_token()

    access_token = response.get("access_token")
    if not access_token:
        raise RuntimeError(f"Failed to generate access token: {response}")

    TOKEN_FILE.parent.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(json.dumps({
        "app_id": app_id,
        "access_token": access_token,
        "updated_at": time.time()
    }, indent=2), encoding="utf-8")

    return fyersModel.FyersModel(client_id=app_id, token=access_token, is_async=False, log_path="/tmp")


if __name__ == "__main__":
    try:
        c = get_authenticated_client()
        print("Fyers authentication verified:", c.get_profile().get("data", {}).get("name"))
    except Exception as exc:
        print(f"Auth check result: {exc}")
