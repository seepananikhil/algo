#!/usr/bin/env python3
"""Fyers daily login helper.

Usage:
  python3 fyers_daily_login.py auto
  python3 fyers_daily_login.py refresh
  python3 fyers_daily_login.py login-url
  python3 fyers_daily_login.py exchange --redirect-url "http://127.0.0.1:8080/callback?auth_code=..."
  python3 fyers_daily_login.py exchange --auth-code "..."

Notes:
- Reads credentials from fyers_config.json by default.
- You can override with env vars: FYERS_APP_ID, FYERS_SECRET_KEY, FYERS_REDIRECT_URI.
- Stores access token to captured_data/fyers/fyers_access_token.json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional
from urllib.parse import parse_qs, urlparse

try:
    from fyers_apiv3 import fyersModel
except Exception as exc:  # pragma: no cover - import guard for local setup
    print("Missing dependency: fyers-apiv3")
    print("Install with: python3 -m pip install fyers-apiv3")
    print(f"Import error: {exc}")
    sys.exit(1)


ROOT = Path(__file__).resolve().parent
DEFAULT_CONFIG = ROOT / "fyers_config.json"
DEFAULT_TOKEN_FILE = ROOT / "captured_data" / "fyers" / "fyers_access_token.json"
REFRESH_URL = "https://api-t1.fyers.in/api/v3/validate-refresh-token"
KEYCHAIN_SERVICE = "fyers_pin"


def load_config(config_path: Path) -> Dict[str, str]:
    config: Dict[str, str] = {}
    if config_path.exists():
        with config_path.open("r", encoding="utf-8") as f:
            raw = json.load(f)
        if not isinstance(raw, dict):
            raise ValueError("Config file must be a JSON object")
        config = {str(k): str(v) for k, v in raw.items()}

    app_id = os.getenv("FYERS_APP_ID", config.get("app_id", "")).strip()
    secret_key = os.getenv("FYERS_SECRET_KEY", config.get("secret_key", "")).strip()
    redirect_uri = os.getenv("FYERS_REDIRECT_URI", config.get("redirect_uri", "")).strip()

    missing = []
    if not app_id:
        missing.append("app_id / FYERS_APP_ID")
    if not secret_key:
        missing.append("secret_key / FYERS_SECRET_KEY")
    if not redirect_uri:
        missing.append("redirect_uri / FYERS_REDIRECT_URI")
    if missing:
        raise ValueError(f"Missing config values: {', '.join(missing)}")

    return {
        "app_id": app_id,
        "secret_key": secret_key,
        "redirect_uri": redirect_uri,
    }


def build_session(config: Dict[str, str], state: Optional[str] = None):
    return fyersModel.SessionModel(
        client_id=config["app_id"],
        secret_key=config["secret_key"],
        redirect_uri=config["redirect_uri"],
        response_type="code",
        grant_type="authorization_code",
        state=state,
    )


def extract_auth_code(redirect_url: str) -> Optional[str]:
    parsed = urlparse(redirect_url)
    params = parse_qs(parsed.query)
    auth_code = params.get("auth_code", [None])[0]
    if auth_code:
        return auth_code
    code = params.get("code", [None])[0]
    return code


def cmd_login_url(config: Dict[str, str]) -> int:
    session = build_session(config)
    login_url = session.generate_authcode()
    print("Open this URL in browser and complete login:")
    print(login_url)
    return 0


def cmd_exchange(config: Dict[str, str], auth_code: Optional[str], redirect_url: Optional[str], token_file: Path) -> int:
    if not auth_code and redirect_url:
        auth_code = extract_auth_code(redirect_url)
    if not auth_code:
        print("Could not find auth code. Pass --auth-code or --redirect-url containing auth_code.")
        return 2

    session = build_session(config)
    session.set_token(auth_code)
    response = session.generate_token()

    if not isinstance(response, dict):
        print(f"Unexpected token response: {response}")
        return 3

    access_token = response.get("access_token")
    if not access_token:
        print("Token exchange failed.")
        print(json.dumps(response, indent=2))
        return 4

    save_tokens(token_file, config, access_token, response.get("refresh_token"), response)
    return 0


def save_tokens(
    token_file: Path,
    config: Dict[str, str],
    access_token: str,
    refresh_token: Optional[str],
    response: dict,
) -> None:
    token_file.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "app_id": config["app_id"],
        "redirect_uri": config["redirect_uri"],
        "access_token": access_token,
        "refresh_token": refresh_token,
        "raw_response": response,
    }
    with token_file.open("w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)
    os.chmod(token_file, 0o600)

    masked = access_token[:16] + "..." if len(access_token) > 16 else access_token
    print(f"Access token saved to: {token_file}")
    print(f"Token preview: {masked}")


def read_pin(app_id: str) -> Optional[str]:
    pin = os.getenv("FYERS_PIN", "").strip()
    if pin:
        return pin
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", app_id, "-w"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def cmd_refresh(config: Dict[str, str], token_file: Path) -> int:
    import requests

    if not token_file.exists():
        print("No token file found. Run: python3 fyers_daily_login.py auto")
        return 7
    with token_file.open("r", encoding="utf-8") as f:
        stored = json.load(f)
    # Older token files only kept refresh_token inside raw_response.
    refresh_token = stored.get("refresh_token") or (stored.get("raw_response") or {}).get("refresh_token")
    if not refresh_token:
        print("No refresh_token stored. Run: python3 fyers_daily_login.py auto")
        return 8

    pin = read_pin(config["app_id"])
    if not pin:
        print(f"PIN not found. Set FYERS_PIN or store it in Keychain (service '{KEYCHAIN_SERVICE}', account '{config['app_id']}').")
        return 9

    app_id_hash = hashlib.sha256(f"{config['app_id']}:{config['secret_key']}".encode("utf-8")).hexdigest()
    resp = requests.post(
        REFRESH_URL,
        json={
            "grant_type": "refresh_token",
            "appIdHash": app_id_hash,
            "refresh_token": refresh_token,
            "pin": pin,
        },
        timeout=30,
    )
    try:
        data = resp.json()
    except ValueError:
        print(f"Refresh failed: HTTP {resp.status_code}")
        return 10

    access_token = data.get("access_token")
    if data.get("s") != "ok" or not access_token:
        print(f"Refresh failed: {data.get('code')} {data.get('message')}")
        print("Fall back to: python3 fyers_daily_login.py auto")
        return 11

    save_tokens(token_file, config, access_token, refresh_token, data)
    return 0


def cmd_auto(config: Dict[str, str], token_file: Path, timeout_sec: int) -> int:
    import webbrowser
    from http.server import BaseHTTPRequestHandler, HTTPServer

    redirect = urlparse(config["redirect_uri"])
    host = redirect.hostname or "127.0.0.1"
    port = redirect.port or 80
    callback_path = redirect.path or "/"
    captured: Dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != callback_path:
                self.send_response(404)
                self.end_headers()
                return
            code = extract_auth_code(f"http://{host}{self.path}")
            if code:
                captured["auth_code"] = code
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            msg = "Login captured. You can close this tab." if code else "No auth_code in callback."
            self.wfile.write(f"<h3>{msg}</h3>".encode("utf-8"))

        def log_message(self, *_args):
            return

    try:
        server = HTTPServer((host, port), Handler)
    except OSError:
        print(f"Port {port} is busy (login UI running?). Use http://{host}:{port}/ to log in.")
        return 12
    server.timeout = 1

    login_url = build_session(config).generate_authcode()
    print("Opening Fyers login in browser:")
    print(login_url)
    webbrowser.open(login_url)
    print(f"Waiting for callback on {config['redirect_uri']} (timeout {timeout_sec}s)...")

    deadline = datetime.now(timezone.utc).timestamp() + timeout_sec
    try:
        while "auth_code" not in captured and datetime.now(timezone.utc).timestamp() < deadline:
            server.handle_request()
    finally:
        server.server_close()

    if "auth_code" not in captured:
        print("Timed out waiting for login callback.")
        return 6

    print("Auth code received. Exchanging for access token...")
    return cmd_exchange(config, auth_code=captured["auth_code"], redirect_url=None, token_file=token_file)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fyers daily login helper")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help="Path to config JSON")
    parser.add_argument(
        "--token-file",
        default=str(DEFAULT_TOKEN_FILE),
        help="Path to write token JSON",
    )

    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("login-url", help="Generate Fyers login URL")

    subparsers.add_parser("refresh", help="Get a new access token using the stored refresh token")

    auto = subparsers.add_parser("auto", help="Open login, capture callback locally, and save token")
    auto.add_argument("--timeout", type=int, default=300, help="Seconds to wait for callback")

    exchange = subparsers.add_parser("exchange", help="Exchange auth code for access token")
    exchange.add_argument("--auth-code", default=None, help="Auth code from callback URL")
    exchange.add_argument(
        "--redirect-url",
        default=None,
        help="Full redirect URL received after login, containing auth_code",
    )

    args = parser.parse_args()

    try:
        config = load_config(Path(args.config))
    except Exception as exc:
        print(f"Config error: {exc}")
        return 1

    token_file = Path(args.token_file)

    if args.command == "login-url":
        return cmd_login_url(config)

    if args.command == "refresh":
        return cmd_refresh(config, token_file=token_file)

    if args.command == "auto":
        return cmd_auto(config, token_file=token_file, timeout_sec=args.timeout)

    if args.command == "exchange":
        return cmd_exchange(
            config,
            auth_code=args.auth_code,
            redirect_url=args.redirect_url,
            token_file=token_file,
        )

    print(f"Unknown command: {args.command}")
    return 5


if __name__ == "__main__":
    raise SystemExit(main())
