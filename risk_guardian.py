"""
Risk Guardian & Hard Stop-Loss Watcher
======================================
Monitors real-time account P&L (Kotak Neo and/or Paper) and enforces strict loss limits:
1. Max Daily Loss Limit: Configurable (default Rs. 2,000).
2. Breach Action:
   - Immediately fires MARKET exit orders to square off ALL open positions.
   - Cancels all open/trigger-pending SL/limit orders in Kotak Neo.
   - Locks trading for the rest of the day via RISK_LOCK.json and STOP_TRADING.
3. Post-Breach Safeguard:
   - Blocks any new manual or scalper order via API (409 Conflict).
   - Watcher actively scans broker positions every 1-2 seconds.
   - If ANY new position is opened externally (e.g. from mobile app), it IMMEDIATELY auto-closes it at market!
4. Daily Auto-Reset:
   - Resets automatically at the start of each new trading session (next calendar day).
"""

import json
import logging
import os
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

IST = ZoneInfo("Asia/Kolkata")
ROOT = Path(__file__).resolve().parent
CONFIG_FILE = ROOT / "fyers_config.json"
RISK_LOCK_FILE = ROOT / "RISK_LOCK.json"
STOP_FILE = ROOT / "STOP_TRADING"
RISK_RESET_FILE = ROOT / "RISK_RESET.json"
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "risk_guardian.log"

logger = logging.getLogger("risk_guardian")
logger.setLevel(logging.INFO)
if not logger.handlers:
    _fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    _fh.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    logger.addHandler(_fh)
    _sh = logging.StreamHandler(sys.stdout)
    _sh.setFormatter(logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s"))
    # Ensure Windows console doesn't fail on special characters
    if hasattr(sys.stdout, "reconfigure"):
        try:
            sys.stdout.reconfigure(errors="replace")
        except Exception:
            pass
    logger.addHandler(_sh)


def today_str() -> str:
    return datetime.now(IST).strftime("%Y-%m-%d")


def read_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        return json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def get_guardian_config() -> dict:
    cfg = read_config()
    limit = float(cfg.get("daily_loss_limit", 2000.0) or 2000.0)
    enabled = bool(cfg.get("risk_guardian_enabled", True))
    auto_close = bool(cfg.get("risk_guardian_auto_close", True))
    per_trade_loss = float(cfg.get("per_trade_loss_limit", 650.0) or 650.0)
    per_trade_pct = float(cfg.get("per_trade_loss_pct", 20.0) or 20.0)
    per_trade_cut = bool(cfg.get("per_trade_auto_cut", True))
    return {
        "enabled": enabled,
        "daily_loss_limit": limit,
        "auto_close_on_breach": auto_close,
        "per_trade_loss_limit": per_trade_loss,
        "per_trade_loss_pct": per_trade_pct,
        "per_trade_auto_cut": per_trade_cut,
    }


def is_risk_locked() -> tuple[bool, dict | None]:
    """Return (True, lock_data) if daily loss limit was breached today."""
    today = today_str()
    # Auto-clear any stale STOP_TRADING file from a previous session
    if STOP_FILE.exists():
        try:
            mtime = datetime.fromtimestamp(STOP_FILE.stat().st_mtime, tz=IST)
            if mtime.strftime("%Y-%m-%d") < today:
                STOP_FILE.unlink(missing_ok=True)
                logger.info(f"🛡️ Auto-cleared stale STOP_TRADING file from {mtime.strftime('%Y-%m-%d')} for new trading day {today}")
        except Exception:
            pass

    if not RISK_LOCK_FILE.exists():
        return False, None
    try:
        data = json.loads(RISK_LOCK_FILE.read_text(encoding="utf-8"))
        if str(data.get("date")) == today:
            return True, data
        else:
            # Stale lock from previous day, auto-clear
            RISK_LOCK_FILE.unlink(missing_ok=True)
            if STOP_FILE.exists():
                STOP_FILE.unlink(missing_ok=True)
            logger.info(f"🛡️ Auto-cleared stale RISK_LOCK from {data.get('date')} for new trading day {today}")
            return False, None
    except Exception:
        return False, None


def lock_risk(limit: float, pnl: float, reason: str = "") -> dict:
    """Create RISK_LOCK.json and STOP_TRADING to halt trading."""
    now_ist = datetime.now(IST)
    lock_data = {
        "date": today_str(),
        "breached_at": now_ist.strftime("%Y-%m-%d %H:%M:%S"),
        "limit": float(limit),
        "pnl": float(pnl),
        "reason": reason or f"Max daily loss limit of Rs. {limit:,.0f} breached (P&L: Rs. {pnl:,.2f})",
    }
    try:
        RISK_LOCK_FILE.write_text(json.dumps(lock_data, indent=2), encoding="utf-8")
        STOP_FILE.write_text(f"risk_guardian_halt at {now_ist:%H:%M:%S}: {lock_data['reason']}\n", encoding="utf-8")
        logger.warning(f"🛡️ [RISK GUARDIAN] RISK LOCK ACTIVATED: {lock_data['reason']}")
    except Exception as exc:
        logger.error(f"Error writing risk lock: {exc}")
    return lock_data


_MANUAL_RESET_TIMESTAMP: float = 0.0


def get_reset_baseline() -> float:
    """Get the P&L baseline from a manual circuit breaker reset today."""
    today = today_str()
    if not RISK_RESET_FILE.exists():
        return 0.0
    try:
        data = json.loads(RISK_RESET_FILE.read_text(encoding="utf-8"))
        if str(data.get("date")) == today:
            return float(data.get("baseline_pnl", 0.0) or 0.0)
        else:
            RISK_RESET_FILE.unlink(missing_ok=True)
    except Exception:
        pass
    return 0.0


def reset_risk_lock() -> dict:
    """Manually clear the risk lock, reset the baseline P&L to current P&L, and clear halts."""
    global _MANUAL_RESET_TIMESTAMP
    try:
        _MANUAL_RESET_TIMESTAMP = time.time()
        today = today_str()
        metrics = get_current_metrics()
        curr_pnl = float(metrics.get("net_pnl", 0.0) or 0.0)

        # Persist manual reset with current P&L as baseline
        reset_data = {
            "date": today,
            "reset_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
            "baseline_pnl": curr_pnl,
        }
        RISK_RESET_FILE.write_text(json.dumps(reset_data, indent=2), encoding="utf-8")

        if RISK_LOCK_FILE.exists():
            RISK_LOCK_FILE.unlink(missing_ok=True)
        if STOP_FILE.exists():
            STOP_FILE.unlink(missing_ok=True)
        logger.info(f"🛡️ [RISK GUARDIAN] Circuit breaker manually reset! New baseline P&L: Rs. {curr_pnl:+,.2f}. Fresh buffer allocated.")
        return {"ok": True, "baseline_pnl": curr_pnl}
    except Exception as exc:
        logger.error(f"Failed to reset risk lock: {exc}")
        return {"ok": False, "error": str(exc)}


def cancel_all_pending_orders() -> list:
    """Cancel all pending / trigger-pending orders in Kotak Neo."""
    cancelled = []
    try:
        from kotak_orders import get_kotak_client
        client = get_kotak_client()
        if not client:
            return []
        report = client.order_report()
        if isinstance(report, dict) and report.get("data"):
            for o in report["data"]:
                st = str(o.get("ordSt", "")).lower()
                if st in ("open", "trigger pending", "pending", "trig_pend", "trigger_pending"):
                    oid = str(o.get("nOrdNo", ""))
                    sym = str(o.get("trdSym", ""))
                    try:
                        client.cancel_order(order_id=oid)
                        cancelled.append({"order_id": oid, "symbol": sym})
                        logger.info(f"🛡️ [RISK GUARDIAN] Cancelled pending order {oid} ({sym})")
                    except Exception as ce:
                        logger.error(f"Failed to cancel order {oid}: {ce}")
    except Exception as exc:
        logger.error(f"Error cancelling pending orders: {exc}")
    return cancelled


def square_off_all_positions(reason: str = "daily_loss_breach") -> list:
    """Square off all open positions immediately at market."""
    closed = []
    try:
        from broker import get_positions
        from app_server import exit_position

        pos_resp = get_positions()
        open_pos = pos_resp.get("open_positions", [])
        if not open_pos:
            return []

        logger.warning(f"🛡️ [RISK GUARDIAN] Square-off triggered ({reason}): {len(open_pos)} open position(s) found.")
        for p in open_pos:
            sym = p.get("symbol", "")
            qty = abs(int(p.get("net_qty", 0)))
            prod = str(p.get("product", "MIS"))
            ex = str(p.get("exchange", "nse_fo"))
            side = "BUY" if (int(p.get("net_qty", 0)) < 0) else "SELL"
            if qty <= 0:
                continue
            try:
                logger.info(f"🛡️ [RISK GUARDIAN] Executing Market Exit for {sym} (Qty: {qty}, Side: {side})...")
                res = exit_position({"symbol": sym, "qty": qty, "product": prod, "exchange": ex, "side": side})
                closed.append({"symbol": sym, "qty": qty, "status": "success", "order_id": res.get("order_id")})
                logger.warning(f"🛡️ [RISK GUARDIAN] Successfully squared off {sym} (Order ID: {res.get('order_id')})")
            except Exception as exc:
                closed.append({"symbol": sym, "qty": qty, "status": "failed", "error": str(exc)})
                logger.error(f"🛡️ [RISK GUARDIAN] FAILED to square off {sym}: {exc}")
    except Exception as exc:
        logger.error(f"Error in square_off_all_positions: {exc}")

    # Also clean up any open paper scalper trades in CSV
    try:
        from app_server import LIVE_DIR, read_csv_rows
        pfile = LIVE_DIR / "scalper_live_paper.csv"
        if pfile.exists():
            rows = read_csv_rows(pfile)
            changed = False
            for r in rows:
                if not r.get("exit_time") or str(r.get("exit_time")).strip() in ("", "open"):
                    r["exit_time"] = datetime.now(IST).strftime("%H:%M")
                    r["exit_reason"] = "risk_guardian_halt"
                    changed = True
            if changed and rows:
                import csv
                with pfile.open("w", newline="", encoding="utf-8") as f:
                    writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
                    writer.writeheader()
                    writer.writerows(rows)
    except Exception:
        pass

    return closed


def get_current_metrics() -> dict:
    """Get current day session P&L and open positions count."""
    try:
        from broker import get_positions
        pos_resp = get_positions()
        summary = pos_resp.get("summary") or {}
        realized = float(summary.get("realized_pnl", 0.0) or 0.0)
        unrealized = float(summary.get("unrealized_pnl", 0.0) or 0.0)
        net_pnl = float(summary.get("net_pnl", realized + unrealized) or 0.0)
        open_pos = pos_resp.get("open_positions") or []
        return {
            "ok": True,
            "realized_pnl": realized,
            "unrealized_pnl": unrealized,
            "net_pnl": net_pnl,
            "open_count": len(open_pos),
            "open_positions": open_pos,
        }
    except Exception as exc:
        return {
            "ok": False,
            "realized_pnl": 0.0,
            "unrealized_pnl": 0.0,
            "net_pnl": 0.0,
            "open_count": 0,
            "open_positions": [],
            "error": str(exc),
        }


def enforce_per_trade_stops(open_positions: list, cfg: dict) -> list:
    """
    Inspect individual open positions.
    If any position breaches per_trade_loss_limit (in Rs) or per_trade_loss_pct (in %),
    auto-square off that specific position immediately so the user never holds a losing trade.
    """
    if not cfg.get("per_trade_auto_cut", True):
        return []

    base_loss_rs = float(cfg.get("per_trade_loss_limit", 650.0) or 650.0)
    max_loss_pct = float(cfg.get("per_trade_loss_pct", 20.0) or 20.0)

    auto_cut_actions = []
    for pos in open_positions:
        try:
            sym = str(pos.get("symbol", "")).strip()
            qty = abs(int(pos.get("net_qty", 0)))
            if not sym or qty <= 0:
                continue

            # Determine lot size dynamically: SENSEX = 20, NIFTY = 65 (or pos['lot_size'])
            pos_lot_size = int(pos.get("lot_size") or (20 if "SENSEX" in sym.upper() else 65))
            lots = max(1.0, round(float(qty) / float(pos_lot_size), 2)) if pos_lot_size > 0 else 1.0

            # Dynamic Rupee limit scales automatically with lot size (e.g. Rs 650 for 1 lot, Rs 1300 for 2 lots)
            max_loss_rs = base_loss_rs * lots

            unrealized = float(pos.get("unrealized_pnl", 0.0) or 0.0)
            pnl_pct = float(pos.get("pnl_pct", 0.0) or 0.0)

            # Check if either Rupee loss limit (scaled by lots) or percentage loss limit is breached
            breached_rs = (max_loss_rs > 0 and unrealized <= -max_loss_rs)
            breached_pct = (max_loss_pct > 0 and pnl_pct <= -max_loss_pct)

            if breached_rs or breached_pct:
                reason_str = f"Per-trade SL hit! Unrealized: Rs. {unrealized:+,.2f} ({pnl_pct:+.1f}%) [Dynamic SL: -Rs. {max_loss_rs:,.0f} ({lots:.1f} lot{'s' if lots > 1 else ''}) / -{max_loss_pct:.0f}%]"
                logger.warning(f"🚨 [RISK GUARDIAN PER-TRADE AUTO-CUT] Auto-cutting {sym}! {reason_str}")

                from app_server import exit_position
                exit_res = exit_position({"symbol": sym, "qty": qty})
                action = {
                    "symbol": sym,
                    "qty": qty,
                    "unrealized_pnl": unrealized,
                    "pnl_pct": pnl_pct,
                    "reason": reason_str,
                    "exit_result": exit_res,
                    "timestamp": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
                }
                auto_cut_actions.append(action)

                # Notify via Telegram if configured
                try:
                    from trend_runner_paper import notify_trade_exit
                    notify_trade_exit(
                        symbol=sym,
                        side=str(pos.get("side", "LONG")),
                        option_str=sym,
                        pnl_pts=0.0,
                        option_pnl_pts=0.0,
                        pnl_rupees=unrealized,
                        exit_reason="PER_TRADE_SL_AUTOCUT",
                        exit_price=float(pos.get("ltp") or 0.0),
                        exit_time=datetime.now(IST).strftime("%H:%M:%S"),
                        total_lots=max(1, qty // int(pos.get("lot_size", 1) or 1)),
                        qty=qty,
                    )
                except Exception:
                    pass
        except Exception as exc:
            logger.error(f"Error in enforce_per_trade_stops for {pos.get('symbol')}: {exc}")

    return auto_cut_actions


def check_and_enforce_guardian() -> dict:
    """
    Main enforcement routine called periodically by the watcher.
    1. If already locked:
       - Check if ANY position is open; if so, AUTO-CLOSE IMMEDIATELY!
       - Cancel any pending orders.
    2. If not locked:
       - Check if net_pnl <= -daily_loss_limit.
       - If breached:
         - Activate lock.
         - Square off all positions.
         - Cancel all pending orders.
    """
    cfg = get_guardian_config()
    limit = cfg["daily_loss_limit"]
    auto_close = cfg["auto_close_on_breach"]
    locked, lock_data = is_risk_locked()

    metrics = get_current_metrics()
    net_pnl = metrics.get("net_pnl", 0.0)
    open_count = metrics.get("open_count", 0)
    open_pos = metrics.get("open_positions", [])

    # Effective P&L relative to manual reset baseline (if reset today)
    baseline_pnl = get_reset_baseline()
    effective_pnl = net_pnl - baseline_pnl
    remaining_buffer = max(0.0, limit + effective_pnl)

    # 1. POST-BREACH ENFORCEMENT: Locked mode
    if locked:
        closed_actions = []
        cancelled_actions = []
        if open_count > 0 and auto_close:
            logger.warning(f"🛡️ [RISK GUARDIAN AUTO-CLOSE] Position detected while locked! ({open_count} open). Closing now...")
            closed_actions = square_off_all_positions(reason="post_breach_enforcement")
            cancelled_actions = cancel_all_pending_orders()

        return {
            "status": "LOCKED",
            "is_locked": True,
            "enabled": cfg["enabled"],
            "daily_loss_limit": limit,
            "per_trade_loss_limit": cfg["per_trade_loss_limit"],
            "per_trade_loss_pct": cfg["per_trade_loss_pct"],
            "per_trade_auto_cut": cfg["per_trade_auto_cut"],
            "current_pnl": net_pnl,
            "effective_pnl": round(effective_pnl, 2),
            "baseline_pnl": round(baseline_pnl, 2),
            "remaining_buffer": 0.0,
            "open_count": open_count,
            "lock_info": lock_data,
            "auto_closed": closed_actions,
            "cancelled_orders": cancelled_actions,
            "checked_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        }

    # 2. NORMAL MONITORING: Check if limit is breached
    if not cfg["enabled"]:
        return {
            "status": "DISABLED",
            "is_locked": False,
            "enabled": False,
            "daily_loss_limit": limit,
            "per_trade_loss_limit": cfg["per_trade_loss_limit"],
            "per_trade_loss_pct": cfg["per_trade_loss_pct"],
            "per_trade_auto_cut": cfg["per_trade_auto_cut"],
            "current_pnl": net_pnl,
            "effective_pnl": round(effective_pnl, 2),
            "baseline_pnl": round(baseline_pnl, 2),
            "remaining_buffer": round(remaining_buffer, 2),
            "open_count": open_count,
            "checked_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        }

    # First, enforce per-trade stops on all open positions!
    per_trade_cuts = []
    if open_count > 0 and open_pos:
        per_trade_cuts = enforce_per_trade_stops(open_pos, cfg)
        if per_trade_cuts:
            # Re-fetch metrics if any trade was cut
            metrics = get_current_metrics()
            net_pnl = metrics.get("net_pnl", 0.0)
            open_count = metrics.get("open_count", 0)
            effective_pnl = net_pnl - baseline_pnl
            remaining_buffer = max(0.0, limit + effective_pnl)

    # Check loss limit breach against effective P&L (post-reset or intraday)
    if effective_pnl <= -limit:
        logger.critical(
            f"🚨 [RISK GUARDIAN] LOSS LIMIT BREACH DETECTED! Effective Loss: Rs. {effective_pnl:+,.2f} <= Limit: -Rs. {limit:,.2f} (Net P&L: Rs. {net_pnl:+,.2f})"
        )
        reason = f"Max daily loss limit of Rs. {limit:,.0f} breached (Net P&L: Rs. {net_pnl:,.2f}, Post-Reset: Rs. {effective_pnl:,.2f})"
        lock_info = lock_risk(limit=limit, pnl=net_pnl, reason=reason)

        closed_actions = []
        cancelled_actions = []
        if auto_close:
            closed_actions = square_off_all_positions(reason="daily_loss_limit_breach")
            cancelled_actions = cancel_all_pending_orders()

        return {
            "status": "BREACHED_JUST_NOW",
            "is_locked": True,
            "enabled": True,
            "daily_loss_limit": limit,
            "per_trade_loss_limit": cfg["per_trade_loss_limit"],
            "per_trade_loss_pct": cfg["per_trade_loss_pct"],
            "per_trade_auto_cut": cfg["per_trade_auto_cut"],
            "current_pnl": net_pnl,
            "effective_pnl": round(effective_pnl, 2),
            "baseline_pnl": round(baseline_pnl, 2),
            "remaining_buffer": 0.0,
            "open_count": open_count,
            "lock_info": lock_info,
            "auto_closed": closed_actions,
            "cancelled_orders": cancelled_actions,
            "per_trade_cuts": per_trade_cuts,
            "checked_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
        }

    # Safe / Normal state
    return {
        "status": "ACTIVE",
        "is_locked": False,
        "enabled": True,
        "daily_loss_limit": limit,
        "per_trade_loss_limit": cfg["per_trade_loss_limit"],
        "per_trade_loss_pct": cfg["per_trade_loss_pct"],
        "per_trade_auto_cut": cfg["per_trade_auto_cut"],
        "current_pnl": net_pnl,
        "effective_pnl": round(effective_pnl, 2),
        "baseline_pnl": round(baseline_pnl, 2),
        "remaining_buffer": round(remaining_buffer, 2),
        "open_count": open_count,
        "per_trade_cuts": per_trade_cuts,
        "checked_at": datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S"),
    }


_guardian_thread = None
_guardian_running = False


def _guardian_loop():
    global _guardian_running
    logger.info("🛡️ [RISK GUARDIAN] Watcher loop running.")
    while _guardian_running:
        had_error = False
        try:
            res = check_and_enforce_guardian()
            if isinstance(res, dict) and not res.get("enabled", True):
                time.sleep(5.0)
                continue
        except Exception as exc:
            had_error = True
            logger.error(f"Error in Risk Guardian loop: {exc}")

        # If broker had an error, backoff 8 seconds to prevent high-frequency loop choking
        if had_error:
            time.sleep(8.0)
            continue

        # Poll during market hours (every 3.0 seconds is plenty fast and prevents connection starvation)
        now_t = datetime.now(IST).time()
        market_open = datetime.strptime("09:14", "%H:%M").time()
        market_close = datetime.strptime("15:35", "%H:%M").time()
        if market_open <= now_t <= market_close:
            time.sleep(3.0)
        else:
            time.sleep(10.0)


def start_risk_guardian():
    """Start the Risk Guardian as a background daemon thread."""
    global _guardian_thread, _guardian_running
    if _guardian_running and _guardian_thread and _guardian_thread.is_alive():
        return
    _guardian_running = True
    _guardian_thread = threading.Thread(target=_guardian_loop, daemon=True, name="RiskGuardianWatcher")
    _guardian_thread.start()
    logger.info("🛡️ [RISK GUARDIAN] Daemon thread launched successfully.")


def stop_risk_guardian():
    global _guardian_running
    _guardian_running = False


if __name__ == "__main__":
    print("=" * 60)
    print("[RISK GUARDIAN & HARD STOP WATCHER]")
    print("=" * 60)
    cfg = get_guardian_config()
    print(f"Daily Loss Limit   : Rs. {cfg['daily_loss_limit']:,.0f}")
    print(f"Guardian Enabled   : {cfg['enabled']}")
    print(f"Auto-Close Active  : {cfg['auto_close_on_breach']}")

    res = check_and_enforce_guardian()
    print(f"Current Status     : {res['status']}")
    print(f"Current Day P&L    : Rs. {res['current_pnl']:+,.2f}")
    print(f"Remaining Buffer   : Rs. {res.get('remaining_buffer', 0):,.2f}")
    print(f"Is Locked Today    : {res['is_locked']}")
    if res.get("lock_info"):
        print(f"Lock Info          : {res['lock_info']}")
    print("=" * 60)
