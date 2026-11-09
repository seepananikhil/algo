# 🚀 AlgoNeo — Algorithmic Trading Platform

AlgoNeo is an automated trading platform engineered for **NIFTY 50** and **SENSEX** index derivatives (Options & Futures), integrated directly with **Kotak Neo API** and **Fyers API**.

It features real-time momentum detection, volatility divergence filtering, multi-tier spot profit ratchets, dynamic pyramiding sizing, and an institutional **Capital Guardian** circuit breaker with a modern web dashboard.

---

## 📑 Table of Contents
1. [Core Features & Architecture](#-core-features--architecture)
2. [Cloud VM Deployment (SSH & One-Click Setup)](#-cloud-vm-deployment-ssh--one-click-setup)
3. [Day-to-Day VM Operations](#-day-to-day-vm-operations)
4. [Local Development](#-local-development)
5. [Configuration Reference](#-configuration-reference)
6. [Troubleshooting](#-troubleshooting)

---

## 🎯 Core Features & Architecture

- **High-Conviction Strategy Engines:**
  - **Trend Runner (15m ORB):** Captures 09:30–11:30 breakout expansion with VIX momentum confirmation.
  - **VIX Trap:** Liquidity trap & volatility divergence reversal engine.
  - **Spot Ratchet Ladder:** Protects profits across 8 defensive tiers (Breakeven at +55 pts, locks up to +340 pts).
- **Capital Guardian Circuit Breaker:**
  - Hard daily loss limits (Auto-calibrated: ₹2,500 for Fixed 1 Lot, ₹4,500 for Dynamic Pyramiding).
  - Max 2 trades/day discipline.
  - Auto-clearing of stale session locks at midnight for next day's market open.
- **Modern Web Dashboard (Port 8090):**
  - **Strategy Tab:** Paper vs Live execution switch (with safety confirmation dialog), Sizing Strategy selector, and Strategy Handbook.
  - **Broker Tab:** Real-time Kotak Neo / Fyers broker telemetry, token generation, and account margins.

---

## ☁️ Cloud VM Deployment (SSH & One-Click Setup)

Deploying to an Ubuntu/Debian Cloud VPS (AWS EC2, GCP Compute Engine, Azure VM, Hetzner, or DigitalOcean):

### Step 1: Connect to Your VM via SSH
Open PowerShell (Windows) or Terminal (Mac/Linux):
```bash
# Using SSH Key:
ssh -i /path/to/your-key.pem ubuntu@YOUR_VM_IP

# Or with password:
ssh ubuntu@YOUR_VM_IP
```
*(Example: `ssh ubuntu@YOUR_VM_IP`)*

---

### Step 2: One-Time System Preparation (Run once on VM)
In your VM terminal, install Python, Node.js, and PM2:
```bash
# 1. Update packages & install Python tools
sudo apt update && sudo apt install -y git python3 python3-pip python3-venv curl build-essential

# 2. Install Node.js 20 LTS & PM2 process manager
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2

# 3. Allow port 8090 in Ubuntu firewall (if UFW is active)
sudo ufw allow 8090/tcp
sudo ufw allow 22/tcp
```
> [!NOTE]
> If hosted on AWS, Azure, GCP, or Oracle Cloud, ensure you allow inbound **TCP Port 8090** in your Cloud Provider's **Security Group / Firewall Rules**.

---

### Step 3: Clone Code & Configure Broker Credentials
```bash
cd ~
git clone https://github.com/seepananikhil/algo.git algo
cd algo

# Configure your Kotak Neo API keys:
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
  "mpin": "YOUR_6_DIGIT_MPIN"
}
```
*Save with `Ctrl+O`, `Enter`, then exit with `Ctrl+X`.*

---

### Step 4: Run One-Click Deployment
```bash
chmod +x deploy.sh update.sh
./deploy.sh
```
This automated script:
1. Creates the Python virtual environment (`./venv`) and installs `requirements.txt`.
2. Builds the optimized React frontend bundle (`npm run build`).
3. Launches the server under **PM2** so it stays running 24/7.

To ensure AlgoNeo starts automatically if the server reboots:
```bash
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

---

### Step 5: Access the Dashboard
Open your browser on your computer or mobile:
```text
http://YOUR_VM_IP:8090
```
*(Example: `http://YOUR_VM_IP:8090`)*

---

## 🔄 Day-to-Day VM Operations

### Updating to Latest GitHub Commits
Whenever you push new changes or strategy fixes from your laptop, update the VM with a single command:
```bash
cd ~/algo
./update.sh
```
`update.sh` will auto-pull commits, rebuild frontend assets, and restart the PM2 service with zero downtime.

### Useful PM2 Management Commands
| Task | Command |
| :--- | :--- |
| **View Live Real-Time Logs** | `pm2 logs algoneo` |
| **Check Process Health & Status** | `pm2 status` |
| **Restart Platform** | `pm2 restart algoneo` |
| **Stop Platform** | `pm2 stop algoneo` |
| **Monitor CPU / Memory Live** | `pm2 monit` |

---

## 💻 Local Development

To run the project locally on your development machine:

```bash
# 1. Create and activate Python virtual environment
python -m venv venv
venv\Scripts\activate   # Windows
# source venv/bin/activate # Linux/Mac

# 2. Install backend dependencies
pip install -r requirements.txt

# 3. Install frontend & build
npm --prefix web install
npm --prefix web run build

# 4. Start app server
python app_server.py
```
Access dashboard locally at: `http://localhost:8090`

---

## ⚙️ Configuration Reference

- `master_portfolio_config.json`: Multi-tier spot profit ratchets, trade limits, and strategy engine triggers.
- `neo_config.json`: Kotak Neo API keys, client code, and MPIN (kept private in `.gitignore`).
- `risk_guardian.py`: Daily loss limits, hard circuit breaker, and automatic stale lock cleanup.

---

## 🛠️ Troubleshooting

- **Web Dashboard not reachable at `http://<VM_IP>:8090`?**
  - Verify process is online: `pm2 status`
  - Check Ubuntu firewall: `sudo ufw status`
  - Ensure cloud provider security group permits inbound TCP traffic on port `8090` from `0.0.0.0/0`.
- **Node build memory error on 1GB VPS?**
  - Add a 2GB swap file to prevent out-of-memory errors:
    ```bash
    sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
    ```
