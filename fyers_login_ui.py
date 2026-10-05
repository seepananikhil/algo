#!/usr/bin/env python3
"""Local Fyers login page: shows token status and re-logs in when expired.

Run: python3 fyers_login_ui.py  ->  open http://127.0.0.1:8080/
"""

from __future__ import annotations

import base64
import html
import json
import secrets
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional, Tuple
from urllib.parse import parse_qs, urlparse

from fyers_daily_login import (
    DEFAULT_CONFIG,
    DEFAULT_TOKEN_FILE,
    build_session,
    cmd_exchange,
    load_config,
)

CONFIG = load_config(DEFAULT_CONFIG)
TOKEN_FILE: Path = DEFAULT_TOKEN_FILE
REDIRECT = urlparse(CONFIG["redirect_uri"])
HOST = REDIRECT.hostname or "127.0.0.1"
PORT = REDIRECT.port or 8080
CALLBACK_PATH = REDIRECT.path or "/callback"
pending_states: set = set()


def token_status() -> Tuple[str, str, Optional[datetime]]:
    if not TOKEN_FILE.exists():
        return "missing", "No token saved yet.", None
    try:
        data = json.loads(TOKEN_FILE.read_text(encoding="utf-8"))
        payload_b64 = data["access_token"].split(".")[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)
        exp = json.loads(base64.urlsafe_b64decode(payload_b64))["exp"]
    except Exception:
        return "unknown", "Token file unreadable.", None
    exp_dt = datetime.fromtimestamp(exp, tz=timezone.utc)
    if exp_dt <= datetime.now(timezone.utc):
        return "expired", "Token expired.", exp_dt
    return "valid", "Token is valid.", exp_dt


def render(message: str = "") -> bytes:
    state, text, exp_dt = token_status()
    color = {"valid": "#2e7d32", "expired": "#c62828"}.get(state, "#ef6c00")
    exp_text = exp_dt.astimezone().strftime("%Y-%m-%d %H:%M %Z") if exp_dt else "-"
    msg_html = f"<p class='msg'>{html.escape(message)}</p>" if message else ""
    page = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Fyers Login</title>
<style>
 body {{ font-family: -apple-system, Helvetica, Arial, sans-serif; background:#f6f6f2; display:flex; justify-content:center; padding-top:80px; }}
 .card {{ background:#fff; border:1px solid #ddd; border-radius:10px; padding:28px 36px; min-width:340px; text-align:center; }}
 .badge {{ display:inline-block; padding:4px 12px; border-radius:12px; color:#fff; background:{color}; font-weight:600; }}
 a.btn {{ display:inline-block; margin-top:18px; padding:10px 22px; background:#1d4ed8; color:#fff; border-radius:6px; text-decoration:none; font-weight:600; }}
 .msg {{ margin-top:14px; color:#333; }}
 .muted {{ color:#666; font-size:13px; }}
</style></head><body><div class="card">
 <h2>Fyers Token</h2>
 <span class="badge">{html.escape(state.upper())}</span>
 <p>{html.escape(text)}</p>
 <p class="muted">Expires: {html.escape(exp_text)}</p>
 {msg_html}
 <a class="btn" href="/login">Login with Fyers</a>
</div></body></html>"""
    return page.encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    def _send(self, body: bytes, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _redirect(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        params = parse_qs(parsed.query)

        if parsed.path == "/":
            self._send(render(params.get("msg", [""])[0]))
        elif parsed.path == "/login":
            state = secrets.token_urlsafe(16)
            pending_states.add(state)
            self._redirect(build_session(CONFIG, state=state).generate_authcode())
        elif parsed.path == CALLBACK_PATH:
            state = params.get("state", [""])[0]
            code = params.get("auth_code", [None])[0] or params.get("code", [None])[0]
            if state not in pending_states:
                self._redirect("/?msg=Login+rejected:+invalid+state.+Try+again.")
                return
            pending_states.discard(state)
            if not code:
                self._redirect("/?msg=No+auth+code+returned.")
                return
            rc = cmd_exchange(CONFIG, auth_code=code, redirect_url=None, token_file=TOKEN_FILE)
            self._redirect("/?msg=Login+successful.+Token+saved." if rc == 0 else "/?msg=Token+exchange+failed.+See+terminal.")
        else:
            self._send(b"Not found", 404)

    def log_message(self, *_args):
        return


def main() -> None:
    server = HTTPServer((HOST, PORT), Handler)
    print(f"Fyers login UI: http://{HOST}:{PORT}/  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
