# 🚀 AlgoNeo — Cloud VM Deployment & Operations Guide

This guide walks you step-by-step through deploying and managing the **AlgoNeo Trading Platform** on your remote Linux Cloud VM (Ubuntu / Debian VPS, AWS EC2, GCP, Azure, or Hetzner).

---

## 📋 Quick Specs & Requirements

- **OS**: Ubuntu 22.04 LTS / 24.04 LTS (Recommended) or Debian
- **Server Ports Required**: 
  - `22` (SSH Access)
  - `8090` (AlgoNeo Web Dashboard & API)
- **Runtime Dependencies**: Python 3.10+, Node.js 18+ (Node 20 LTS recommended), Git, PM2

---

## Step 1: Connect to Your VM via SSH

Open PowerShell (Windows) or Terminal (Mac/Linux) on your computer and connect to your VM:

### A. Using SSH Key (Standard Cloud VMs / AWS / GCP)
```bash
ssh -i /path/to/your-key.pem ubuntu@YOUR_VM_IP
```

### B. Using Password Authentication
```bash
ssh ubuntu@YOUR_VM_IP
```
*(Replace `YOUR_VM_IP` with your actual server IP, e.g., `137.23.58.183`)*

---

## Step 2: First-Time Server Setup (Run once on VM)

Once logged into your VM terminal, install the necessary tools:

```bash
# 1. Update package lists
sudo apt update && sudo apt upgrade -y

# 2. Install Git, Python3, and venv tooling
sudo apt install -y git python3 python3-pip python3-venv curl build-essential

# 3. Install Node.js 20 LTS & npm
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 4. Install PM2 (Process Manager for 24/7 reliability & auto-restart)
sudo npm install -g pm2

# 5. Open Port 8090 in Ubuntu firewall (if UFW is active)
sudo ufw allow 8090/tcp
sudo ufw allow 22/tcp
```

> [!NOTE]
> If your VM is hosted on AWS, Azure, GCP, or Oracle Cloud, remember to also allow inbound **TCP Port 8090** in your Cloud Provider's **Security Group / Firewall Rules**.

---

## Step 3: Clone the Repository & Configure Broker Keys

### 1. Clone the Codebase
```bash
cd ~
git clone https://github.com/your-username/algo.git algo
cd algo
```
*(If already cloned, simply run `cd ~/algo`)*

### 2. Configure Kotak Neo API Credentials
Create your private `neo_config.json`:
```bash
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
*Press `Ctrl + O` then `Enter` to save, and `Ctrl + X` to exit `nano`.*

---

## Step 4: One-Click Production Deployment

We have included an automated deployment script [`deploy.sh`](file:///d:/nikhil/algo/deploy.sh) that:
1. Creates the Python virtual environment (`./venv`)
2. Installs all Python dependencies from `requirements.txt`
3. Installs frontend packages and builds the production React assets (`npm run build`)
4. Starts the server with **PM2** so it stays online 24/7 and auto-restarts if rebooted.

Run:
```bash
chmod +x deploy.sh update.sh
./deploy.sh
```

### Enable Auto-Start on System Boot
To ensure AlgoNeo starts automatically if the server reboots:
```bash
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

---

## Step 5: Access the Web Dashboard

Open your browser on your laptop or phone:
```text
http://YOUR_VM_IP:8090
```
*(Example: `http://137.23.58.183:8090`)*

You will see the full AlgoNeo Dashboard:
- **Strategy Tab**: Switch between Paper / Live mode, configure Sizing (Fixed 1 Lot vs Dynamic Pyramiding), and inspect the Capital Guardian.
- **Broker Tab**: Verify your live Kotak Neo / Fyers broker connectivity and token status.

---

## 🔄 Day-to-Day Operations & Updates

### 1. Updating to Latest Code from GitHub
Whenever you push new changes or strategy fixes from your local machine to GitHub, update your VM with a single command:
```bash
cd ~/algo
./update.sh
```
`update.sh` will automatically pull the newest commits, rebuild the frontend bundle, and reload the PM2 service with zero downtime.

---

### 2. Monitoring & Useful Commands

| Task | Command |
| :--- | :--- |
| **View Live Real-Time Logs** | `pm2 logs algoneo` |
| **Check Process Status** | `pm2 status` |
| **Restart Platform** | `pm2 restart algoneo` |
| **Stop Platform** | `pm2 stop algoneo` |
| **View System Resource Usage** | `pm2 monit` |

---

## 🛠️ Troubleshooting

### 1. Dashboard not opening at `http://YOUR_VM_IP:8090`?
- Verify the server is running: `pm2 status`
- Check firewall status: `sudo ufw status`
- Check your cloud provider security group (ensure TCP `8090` is open for `0.0.0.0/0`).
- Test locally on the VM: `curl -I http://localhost:8090`

### 2. Node or NPM Build Memory Limit on Small 1GB RAM VPS
If your VM has 1GB RAM, create a swap file so frontend build never runs out of memory:
```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
```
