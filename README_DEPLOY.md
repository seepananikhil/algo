# 🚀 AlgoNeo — Cloud VM Deployment & Operations Guide

This guide walks you step-by-step through deploying and managing the **AlgoNeo Trading Platform** on your remote Linux Cloud VM (Ubuntu / Debian VPS, AWS EC2, GCP Compute Engine, Azure VM, Hetzner, or DigitalOcean).

---

## 📋 Quick Specs & Requirements

- **OS**: Ubuntu 22.04 LTS / 24.04 LTS (Recommended) or Debian
- **Server Ports Required**: 
  - `22` (SSH Access)
  - `8090` (AlgoNeo Web Dashboard & REST API)
- **Runtime Dependencies**: Python 3.10+, Node.js 20 LTS, Git

---

## Step 1: Connect to Your VM via SSH

Open PowerShell (Windows) or Terminal (Mac/Linux) on your computer:

### A. Using SSH Key (AWS / GCP / Cloud VPS)
```bash
ssh -i /path/to/your-key.pem ubuntu@YOUR_VM_IP
```

### B. Using Password Authentication
```bash
ssh ubuntu@YOUR_VM_IP
```
*(Replace `YOUR_VM_IP` with your actual server IP).*

---

## Step 2: System Preparation (Run once on VM)

Once logged into your VM terminal, install the runtime tools:

```bash
# 1. Update package lists & install build tools
sudo apt update && sudo apt install -y git python3 python3-pip python3-venv curl build-essential

# 2. Install Node.js 20 LTS & npm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 3. Allow port 8090 in Ubuntu firewall (if UFW is active)
sudo ufw allow 8090/tcp
sudo ufw allow 22/tcp
```

> [!NOTE]
> If your VM is hosted on AWS, Azure, GCP, or Oracle Cloud, remember to also allow inbound **TCP Port 8090** in your Cloud Provider's **Security Group / Firewall Rules**.

---

## Step 3: Clone Code & Configure Broker Credentials

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
  "totp_secret": "YOUR_TOTP_SECRET_FOR_AUTOLOGIN",
  "mpin": "YOUR_6_DIGIT_MPIN"
}
```
*Press `Ctrl + O` then `Enter` to save, and `Ctrl + X` to exit `nano`.*

---

## Step 4: Start Platform & Auto-Configure Services

Run a single command:

```bash
npm start
```

### What `npm start` Does Automatically:
1. Installs `/etc/systemd/system/algo.service` with `Restart=always` (auto-recovers from crashes in 5 seconds).
2. Enables systemd boot persistence (`WantedBy=multi-user.target`) so **all services automatically start upon server reboot or power cycle**.
3. Configures `algo-sync.timer` to backup your trades to GitHub daily at **15:35 & 16:35 IST**.
4. Starts the master trading engine 24/7 in the background (survives SSH disconnect).
5. Runs the post-start preflight check and displays the health diagnostic table in your terminal.
6. Prints your direct Dashboard URL (`http://YOUR_VM_IP:8090`).

---

## Step 5: (Optional) Connect GitHub Actions Runner

To run daily post-market historical updates and backtests directly on your VM:
1. Open your browser: `https://github.com/seepananikhil/algo/settings/actions/runners/new`
2. Copy the token string shown after `--token`.
3. In your VM terminal, run:
   ```bash
   npm run setup:runner <PASTE_YOUR_TOKEN>
   ```

---

## 🔄 Day-to-Day VM Operations

| Task | Command | What It Does |
| :--- | :--- | :--- |
| **Pull Updates** | `npm run update` | Pulls latest code and restarts platform in < 2 seconds. |
| **Verify Health** | `npm run check` | Checks broker session, margin balance, feed freshness, and services. |
| **Live Logs** | `npm run logs` | Streams live console telemetry and strategy decisions via `journalctl`. |
| **Sync Trades** | `npm run sync` | Immediately commits and pushes trade logs & signals to GitHub. |
| **Restart Platform** | `npm run restart` | Restarts the background trading daemon. |
| **Check Status** | `npm run status` | Displays systemd daemon status and memory usage. |
| **Stop Platform** | `npm run stop` | Safely halts trading engine and background processes. |

---

## 🛠️ Troubleshooting

- **Web Dashboard not reachable at `http://YOUR_VM_IP:8090`?**
  - Run `npm run check` to verify port 8090 is listening and broker token is valid.
  - Verify service status: `npm run status`
  - Check firewall: `sudo ufw status`
  - Ensure cloud provider security group permits inbound TCP traffic on port `8090` from `0.0.0.0/0`.
- **View Recent Errors in Logs:**
  ```bash
  npm run logs
  ```
- **Force Restart All Services:**
  ```bash
  npm run restart
  ```
