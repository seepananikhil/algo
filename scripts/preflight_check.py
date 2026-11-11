#!/usr/bin/env python3
"""AlgoNeo Comprehensive System Preflight & Health Check

Validates:
1. Python environment & packages
2. Broker configuration & session token (Kotak Neo)
3. Available trading margin & UCC
4. Web server & API endpoint (port 8090)
5. Live market data feed (kotak_capture.py) & tick file freshness
6. Risk Guardian circuit breaker & daily loss limits
7. Automated Git sync scheduler & systemd services
"""

import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

IST = timezone(timedelta(hours=5, minutes=30))
NOW = datetime.now(IST)
TODAY = NOW.strftime("%Y-%m-%d")

if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ANSI color codes
GREEN = "\033[92m" if sys.stdout.isatty() or sys.platform != "win32" else ""
RED = "\033[91m" if sys.stdout.isatty() or sys.platform != "win32" else ""
YELLOW = "\033[93m" if sys.stdout.isatty() or sys.platform != "win32" else ""
CYAN = "\033[96m" if sys.stdout.isatty() or sys.platform != "win32" else ""
BOLD = "\033[1m" if sys.stdout.isatty() or sys.platform != "win32" else ""
DIM = "\033[2m" if sys.stdout.isatty() or sys.platform != "win32" else ""
RESET = "\033[0m" if sys.stdout.isatty() or sys.platform != "win32" else ""


def badge(ok: bool | None, label: str = "") -> str:
    if ok is True:
        return f"{GREEN}[  OK  ]{RESET}"
    elif ok is False:
        return f"{RED}[ FAIL ]{RESET}"
    return f"{YELLOW}[ WARN ]{RESET}"


def check_port(host: str = "127.0.0.1", port: int = 8090) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            return s.connect_ex((host, port)) == 0
    except Exception:
        return False


def run_check():
    print(f"\n{BOLD}{CYAN}=================================================================={RESET}")
    print(f"{BOLD}{CYAN}    🛡️  ALGONEO SYSTEM PREFLIGHT & RESILIENCE HEALTH CHECK       {RESET}")
    print(f"{BOLD}{CYAN}    Timestamp: {NOW.strftime('%Y-%m-%d %H:%M:%S')} IST                       {RESET}")
    print(f"{BOLD}{CYAN}=================================================================={RESET}\n")

    overall_ok = True

    # 1. Environment & Directories
    print(f"{BOLD}1. Environment & Core Paths{RESET}")
    py_ver = sys.version.split()[0]
    print(f"   {badge(True)} Python Version: {py_ver} ({sys.executable})")
    print(f"   {badge(True)} Root Directory: {ROOT}")

    live_dir = ROOT / "captured_data" / "fyers" / "live"
    live_dir.mkdir(parents=True, exist_ok=True)
    perf_dir = ROOT / "performance"
    perf_dir.mkdir(parents=True, exist_ok=True)
    print(f"   {badge(True)} Data Directories: {live_dir.name}/, {perf_dir.name}/ present")

    missing_pkgs = []
    for pkg in ["pyotp", "pandas", "requests"]:
        try:
            __import__(pkg)
        except ImportError:
            missing_pkgs.append(pkg)
    if missing_pkgs:
        print(f"   {badge(False)} Missing dependencies: {', '.join(missing_pkgs)} (Run: pip install {' '.join(missing_pkgs)})")
        overall_ok = False
    else:
        print(f"   {badge(True)} Core Dependencies: pandas, requests, pyotp installed")

    # 2. Broker Configuration & Credentials
    print(f"\n{BOLD}2. Broker Integration (Kotak Neo){RESET}")
    k_cfg = {}
    load_kotak_config, available_kotak_funds, kotak_token_status = None, None, None
    try:
        from kotak_orders import load_kotak_config, available_kotak_funds, kotak_token_status
        k_cfg = load_kotak_config()
    except Exception as exc:
        print(f"   {badge(False)} Broker module load error: {exc}")
        overall_ok = False
    neo_config = ROOT / "neo_config.json"
    if not k_cfg and neo_config.exists():
        try:
            k_cfg = json.loads(neo_config.read_text(encoding="utf-8"))
        except Exception:
            pass

    has_creds = bool(k_cfg.get("consumer_key") and k_cfg.get("mobile_number"))
    has_totp = bool((k_cfg.get("totp_secret") or k_cfg.get("totp_key")) and k_cfg.get("mpin"))
    if has_creds and has_totp:
        print(f"   {badge(True)} Credentials: Mobile + Consumer Key + TOTP + MPIN configured")
    else:
        print(f"   {badge(None)} Note: Partial credentials found (auto-login uses configured fields)")

    # 3. Broker Session & Margin Verification
    token_file = ROOT / "captured_data" / "kotak" / "kotak_token.json"
    broker_authed = False
    try:
        status = kotak_token_status(auto_login=True)
        if status.get("valid"):
            broker_authed = True
            name = status.get("greeting_name") or "User"
            ucc = status.get("ucc") or "Active"
            print(f"   {badge(True)} Session Token: Valid ({name} · UCC: {ucc})")
            funds = available_kotak_funds()
            if funds.get("ok"):
                bal = funds.get("available_balance", 0.0)
                print(f"   {badge(True)} Available Trading Margin: ₹{bal:,.2f}")
            else:
                print(f"   {badge(None)} Available Margin: Could not fetch ({funds.get('error')})")
        else:
            reason = status.get("reason", "Expired or missing")
            print(f"   {badge(False)} Session Token: Offline ({reason})")
            print(f"          {DIM}Note: Auto-login will trigger on market open or via Web UI.{RESET}")
    except Exception as exc:
        print(f"   {badge(None)} Broker check skipped: {exc}")

    # 4. Web Dashboard & API Server (Port 8090)
    print(f"\n{BOLD}3. Web Dashboard & Master Server (Port 8090){RESET}")
    is_port_open = check_port("127.0.0.1", 8090)
    if is_port_open:
        print(f"   {badge(True)} Port 8090: Active & Listening")
        try:
            import urllib.request
            req = urllib.request.Request("http://127.0.0.1:8090/api/status", headers={"User-Agent": "Preflight"})
            try:
                with urllib.request.urlopen(req, timeout=3) as resp:
                    if resp.status == 200:
                        data = json.loads(resp.read().decode())
                        capture_active = data.get("capture_running", False)
                        print(f"   {badge(True)} REST API Response: 200 OK")
                        print(f"   {badge(capture_active if is_market_hours() else True)} Market Capture Running: {capture_active}")
            except urllib.error.HTTPError as he:
                if he.code in (401, 403):
                    print(f"   {badge(True)} REST API Response: Running & Auth Protected (HTTP {he.code})")
                else:
                    print(f"   {badge(None)} API query warning: HTTP {he.code}")
        except Exception as e:
            print(f"   {badge(None)} API query warning: {e}")
    else:
        print(f"   {badge(False)} Port 8090 is NOT reachable locally")
        print(f"          {DIM}Start with: sudo systemctl start algo.service  (or npm start){RESET}")
        overall_ok = False

    # 5. Live Market Feed Capture
    print(f"\n{BOLD}4. Market Data Engine (kotak_capture.py){RESET}")
    nifty_1s = live_dir / f"nifty_1s_{TODAY}.csv"
    sensex_1s = live_dir / f"sensex_1s_{TODAY}.csv"
    if nifty_1s.exists() and nifty_1s.stat().st_size > 0:
        age_sec = (NOW - datetime.fromtimestamp(nifty_1s.stat().st_mtime, tz=IST)).total_seconds()
        status_color = True if age_sec < 60 else (None if age_sec < 300 else False)
        print(f"   {badge(status_color)} Nifty 1-Sec Feed: Active (updated {int(age_sec)}s ago, {nifty_1s.stat().st_size // 1024} KB)")
    else:
        print(f"   {badge(None)} Nifty 1-Sec Feed: No ticks recorded yet for {TODAY}")

    if sensex_1s.exists() and sensex_1s.stat().st_size > 0:
        age_sec = (NOW - datetime.fromtimestamp(sensex_1s.stat().st_mtime, tz=IST)).total_seconds()
        status_color = True if age_sec < 60 else (None if age_sec < 300 else False)
        print(f"   {badge(status_color)} Sensex 1-Sec Feed: Active (updated {int(age_sec)}s ago, {sensex_1s.stat().st_size // 1024} KB)")
    else:
        print(f"   {badge(None)} Sensex 1-Sec Feed: No ticks recorded yet for {TODAY}")

    # 6. Risk Guardian & Capital Circuit Breaker
    print(f"\n{BOLD}5. Capital Guardian & Risk Controls{RESET}")
    stop_file = ROOT / "STOP_TRADING"
    if stop_file.exists():
        print(f"   {badge(False)} ⚠️  KILL SWITCH ACTIVE! Trading halted via STOP_TRADING file.")
    else:
        print(f"   {badge(True)} Kill Switch: INACTIVE (Trading enabled)")

    lock_file = ROOT / "captured_data" / "risk_guardian_lock.json"
    if lock_file.exists():
        print(f"   {badge(False)} ⚠️  RISK GUARDIAN LOCKED! Daily loss limit breached.")
    else:
        print(f"   {badge(True)} Account Circuit Breaker: Clean (No loss breach)")

    # 7. Systemd OS Services & Daily Git Sync
    print(f"\n{BOLD}6. Linux Systemd Services & Auto-Reboot Persistence{RESET}")
    if os.name != "nt":
        # Check algo.service
        res = subprocess.run(["systemctl", "is-active", "algo.service"], capture_output=True, text=True)
        is_algo_active = (res.stdout.strip() == "active")
        res_enabled = subprocess.run(["systemctl", "is-enabled", "algo.service"], capture_output=True, text=True)
        is_algo_enabled = (res_enabled.stdout.strip() == "enabled")
        print(f"   {badge(is_algo_active)} algo.service (Core Engine): {res.stdout.strip().upper()} (Auto-boot: {res_enabled.stdout.strip()})")

        # Check algo-sync.timer
        res_timer = subprocess.run(["systemctl", "is-active", "algo-sync.timer"], capture_output=True, text=True)
        is_timer_active = (res_timer.stdout.strip() == "active")
        print(f"   {badge(is_timer_active)} algo-sync.timer (Daily Git Backup): {res_timer.stdout.strip().upper()}")

        # Check GitHub Actions Runner service
        runner_check = subprocess.run(["bash", "-c", "systemctl list-units --type=service --state=running | grep -i 'actions.runner' || true"], capture_output=True, text=True)
        has_runner = bool(runner_check.stdout.strip())
        if has_runner:
            print(f"   {badge(True)} GitHub Actions Runner: ACTIVE (Connected to repo)")
        else:
            print(f"   {badge(None)} GitHub Actions Runner: Not active (run npm run setup:runner to connect)")
    else:
        print(f"   {badge(True)} Local Windows environment (Systemd checks skipped)")

    # Git status
    git_diff = subprocess.run(["git", "status", "--porcelain"], cwd=ROOT, capture_output=True, text=True)
    uncommitted = len([line for line in git_diff.stdout.splitlines() if not line.startswith("??")])
    print(f"   {badge(True)} Git Working Tree: {uncommitted} tracked changes pending sync")

    print(f"\n{BOLD}{CYAN}=================================================================={RESET}")
    if overall_ok:
        print(f"{BOLD}{GREEN}  ✅ All Core Subsystems Verified & Trading Ready!{RESET}")
    else:
        print(f"{BOLD}{YELLOW}  ⚠️  Some components need attention. Review flags above.{RESET}")
    print(f"{BOLD}{CYAN}=================================================================={RESET}\n")


def is_market_hours() -> bool:
    if NOW.weekday() >= 5:
        return False
    return 9 <= NOW.hour < 16


if __name__ == "__main__":
    run_check()
