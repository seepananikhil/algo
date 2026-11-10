# 🚀 AlgoNeo — Automated Algorithmic Options Trading Platform

AlgoNeo is a production-grade algorithmic trading terminal engineered for **NIFTY 50** and **SENSEX** index derivatives (Options & Futures), integrated with **Kotak Neo API** (Zero Brokerage execution) and **Fyers API**.

It features automated price action momentum detection, multi-tier spot profit ratchets, dynamic sizing, an institutional **Capital Guardian** circuit breaker, and an interactive real-time web dashboard.

---

## 📑 Table of Contents
1. [Architecture & Services Overview](#-architecture--services-overview)
2. [Quick Start on Cloud VM](#-quick-start-on-cloud-vm)
3. [Day-to-Day VM Operations](#-day-to-day-vm-operations)
4. [Preflight & System Health Diagnostics](#-preflight--system-health-diagnostics)
5. [Automated Post-Market Trade Sync to GitHub](#-automated-post-market-trade-sync-to-github)
6. [GitHub Actions Self-Hosted Runner Setup](#-github-actions-self-hosted-runner-setup)
7. [Web Dashboard Guide](#-web-dashboard-guide)
8. [Local Development](#-local-development)
9. [Configuration & Safety Rules](#-configuration--safety-rules)

---

## 🛡️ Architecture & Services Overview

AlgoNeo runs as a single, coordinated master daemon under Linux `systemd`, eliminating fragile multi-terminal setups:

```text
Linux VM (OS Level / systemd)
 ├── 1. algo.service (Master Controller · Runs 24/7)
 │    │
 │    ├── 🌐 Web UI & REST API (:8090)
 │    ├── 📡 Live Market Feed (kotak_capture.py — auto-launches at 09:00 AM)
 │    ├── ⚡ Strategy Engines (Nifty & Sensex Trend Runner, Micro Scalper, Hero-Zero)
 │    ├── 🛡️ Risk Guardian (15s balance protection & account circuit breaker)
 │    ├── 🔐 Session Token Auto-Renewal (Auto-TOTP/MPIN login on startup)
 │    ├── 🩺 Post-Start Diagnostics (Executes preflight check 2s after boot)
 │    └── ⏰ Built-in Daily Trade Backup (Pushes to GitHub at 15:35 & 16:35 IST)
 │
 ├── 2. algo-sync.timer (Independent OS Timer)
 │    └── Daily fallback trigger for Git trade backup (15:35 & 16:35 IST)
 │
 └── 3. actions.runner.service (Optional GitHub Actions Self-Hosted Runner)
      └── Executes daily 16:15 IST historical data & options pipeline directly on VM
```

---

## ☁️ Quick Start on Cloud VM

### Step 1: Connect to Your VM via SSH
```bash
ssh -i /path/to/key.pem ubuntu@YOUR_VM_IP
# Or with password:
ssh ubuntu@YOUR_VM_IP
```

### Step 2: One-Time System Dependencies (Run once on VM)
```bash
# Update packages & install Python and Node 20 LTS
sudo apt update && sudo apt install -y git python3 python3-pip python3-venv curl build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Allow dashboard port in firewall (if UFW is active)
sudo ufw allow 8090/tcp
sudo ufw allow 22/tcp
```
> [!NOTE]
> If hosted on AWS, Azure, GCP, or Oracle Cloud, ensure inbound **TCP Port 8090** is allowed in your Cloud Provider's **Security Group / Firewall Rules**.

### Step 3: Clone Code & Configure Broker Credentials
```bash
cd ~
git clone https://github.com/seepananikhil/algo.git algo
cd algo

# Configure Kotak Neo API keys:
cp neo_config.example.json neo_config.json
nano neo_config.json
```
Fill in your credentials:
```json
{
  "consumer_key": "YOUR_KOTAK_CONSUMER_KEY",
  "consumer_secret": "YOUR_KOTAK_CONSUMER_SECRET",
  "neo_fin_key": "YOUR_KOTAK_FIN_KEY",
  "mobile_number": "+91XXXXXXXXXX",
  "ucc": "YOUR_UCC_CLIENT_CODE",
  "totp_secret": "YOUR_TOTP_SECRET_FOR_AUTOLOGIN",
  "mpin": "YOUR_6_DIGIT_MPIN"
}
```
*(Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`).*

### Step 4: Start Everything with One Command
```bash
npm start
```

#### What `npm start` does automatically:
1. Detects system environment and configures `/etc/systemd/system/algo.service`.
2. Sets `Restart=always` with `RestartSec=5s` so if any unexpected crash occurs, the system auto-recovers in 5 seconds.
3. Enables `algo.service` and `algo-sync.timer` with `WantedBy=multi-user.target` so **all services automatically start on server reboot or power cycle**.
4. Boots the master trading engine 24/7 in the background (survives SSH disconnect).
5. Runs the post-start preflight check and displays the health diagnostic table in your terminal.
6. Prints your direct Dashboard link (`http://YOUR_VM_IP:8090`).

---

## 🔄 Day-to-Day VM Operations

All routine maintenance is consolidated into simple `npm` commands:

| Task | Command | What It Does |
| :--- | :--- | :--- |
| **Start / Auto-Configure** | `npm start` | Configures systemd auto-reboot, starts platform, and runs preflight check. |
| **Instant Health Check** | `npm run check` | Verifies broker login, balance, market feed, port 8090, and services. |
| **Pull Code Updates** | `npm run update` | Pulls latest GitHub code and restarts platform in < 2 seconds. |
| **View Live Real-Time Logs** | `npm run logs` | Streams live console telemetry and strategy decisions via `journalctl`. |
| **Sync Trades to GitHub** | `npm run sync` | Immediately commits and pushes trade logs & signals to GitHub. |
| **Restart Platform** | `npm run restart` | Restarts the background trading daemon. |
| **Check Systemd Status** | `npm run status` | Displays systemd daemon status and memory usage. |
| **Stop Platform** | `npm run stop` | Safely halts trading engine and background processes. |

---

## 🩺 Preflight & System Health Diagnostics

To verify the operational status of every subsystem at any time, run:

```bash
npm run check
```

Output:
```text
==================================================================
    🛡️  ALGONEO SYSTEM PREFLIGHT & RESILIENCE HEALTH CHECK       
    Timestamp: 2026-11-10 10:10:00 IST                       
==================================================================

1. Environment & Core Paths
   [  OK  ] Python Version: 3.12 (venv active)
   [  OK  ] Root Directory: /home/ubuntu/algo
   [  OK  ] Data Directories: live/, performance/ present

2. Broker Integration (Kotak Neo)
   [  OK  ] Credentials: Mobile + Consumer Key + TOTP + MPIN configured
   [  OK  ] Session Token: Valid (NIKHILCHANDRA · UCC: Y4KQT)
   [  OK  ] Available Trading Margin: ₹XX,XXX.XX

3. Web Dashboard & Master Server (Port 8090)
   [  OK  ] Port 8090: Active & Listening
   [  OK  ] REST API Response: Running & Auth Protected (HTTP 401)

4. Market Data Engine (kotak_capture.py)
   [  OK  ] Nifty 1-Sec Feed: Active (updated 0s ago, 24 KB)
   [  OK  ] Sensex 1-Sec Feed: Active (updated 0s ago, 24 KB)

5. Capital Guardian & Risk Controls
   [  OK  ] Kill Switch: INACTIVE (Trading enabled)
   [  OK  ] Account Circuit Breaker: Clean (No loss breach)

6. Linux Systemd Services & Auto-Reboot Persistence
   [  OK  ] algo.service (Core Engine): ACTIVE (Auto-boot: enabled)
   [  OK  ] algo-sync.timer (Daily Git Backup): ACTIVE (Scheduled)
   [  OK  ] GitHub Actions Runner: ACTIVE (Connected to repo)

==================================================================
  ✅ All Core Subsystems Verified & Trading Ready!
==================================================================
```

---

## 📦 Automated Post-Market Trade Sync to GitHub

AlgoNeo keeps a tamper-proof audit trail of all trading performance directly on GitHub:

- **What gets synced:**
  - Forward-testing paper trades: `performance/*trades*.csv`, `*paper*.csv`
  - Real broker order executions: `captured_data/fyers/live/live_orders_*.csv`
  - Real-time intraday signal audits: `*signals*.csv`
- **Zero Secret Leakage:** Broker tokens, `.env`, and `neo_config.json` remain strictly excluded by `.gitignore`.
- **Automated Schedule:** Runs automatically at **15:35 IST** and **16:35 IST** every Monday through Friday.
- **Manual Trigger:** Run `npm run sync` on your terminal, or click the **`[Sync to GitHub]`** button on the Web UI.

---

## ⚡ GitHub Actions Self-Hosted Runner Setup

Your repository includes [`.github/workflows/daily_historical_and_options_update.yml`](.github/workflows/daily_historical_and_options_update.yml) which updates spot historical data, weekly options chains, and DuckDB parquet catalogs every weekday at 16:15 IST.

Connecting your VM as a GitHub Actions runner allows this to execute on your local server disk:

1. Open your repository settings in browser:  
   👉 **`https://github.com/seepananikhil/algo/settings/actions/runners/new`**
2. Copy the registration token string shown after `--token`.
3. In your VM terminal, run:
   ```bash
   npm run setup:runner <PASTE_YOUR_TOKEN_HERE>
   ```
*(Installs the runner as a background systemd service that auto-starts on boot).*

---

## 🖥️ Web Dashboard Guide

Open `http://YOUR_VM_IP:8090` in your browser:

### 1. Live Algo Tab (`/`)
- **Live Candlestick Chart:** Real-time 1-sec & 1-min NIFTY 50 and SENSEX price action.
- **Spot Ratchet Ladder:** Real-time trailing profit defense indicators.
- **Active & Closed Positions:** Filterable by `LIVE`, `ALL`, or `PAPER`. Every trade displays a color-coded badge:
  - `● LIVE` : Real Kotak Neo broker execution.
  - `PAPER` : Simulated forward-testing trade.
- **Live Terminal Audit Box:** Streams live engine evaluations every 2 seconds with badges (`[SIGNAL]`, `[ORDER]`, `[INFO]`, `[ERROR]`).

### 2. Trades & P&L Tab (`/paper`)
- **Performance Overview:** Consolidated Net P&L, Win Rate %, Profit Factor, Max Drawdown, and Streak summaries.
- **Audit Ledger:** Chronological trade history with entry/exit timestamps, strike details, and rupee returns.
- **`[Sync to GitHub]` Button:** One-click backup of trade logs directly to GitHub.

### 3. Strategy Configuration Tab (`/config`)
- **Live vs Paper Mode Switch:** Toggle real Kotak Neo order submission (with confirmation safety prompt).
- **Position Sizing:** Fixed 1-Lot mode or Dynamic Pyramiding.
- **Active Engines:** Toggle Trend Runner, VIX Trap, or Gap & Go setups.

### 4. Broker Telemetry Tab (`/settings`)
- Shows Kotak Neo connection status, UCC, client greeting name, and available trading margin.

---

## 💻 Local Development

To run locally on your laptop (Windows / Mac / Linux):

```bash
# 1. Setup virtual environment
python -m venv venv
venv\Scripts\activate      # Windows
# source venv/bin/activate # Mac / Linux

# 2. Install dependencies
pip install -r requirements.txt
npm --prefix web install
npm --prefix web run build

# 3. Start local development server
npm start
```
Open `http://localhost:8090` in your browser.

---

## ⚙️ Configuration & Safety Rules

- `neo_config.json`: Kotak Neo API credentials, TOTP secret, and MPIN (never committed).
- `master_portfolio_config.json`: Spot ratchet thresholds, sizing limits, and strategy flags.
- `STOP_TRADING`: Emergency kill switch file. Creating this file immediately halts all order execution.
- `captured_data/risk_guardian_lock.json`: Automated lock triggered if daily loss limit is breached. Auto-resets at midnight.
