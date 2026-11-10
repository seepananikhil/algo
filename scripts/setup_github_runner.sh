#!/usr/bin/env bash
# ==============================================================================
# AlgoNeo — GitHub Actions Self-Hosted Runner Installer & Auto-Boot Service
# Usage:
#   npm run setup:runner
#   or: bash scripts/setup_github_runner.sh [TOKEN]
# ==============================================================================
set -e

REPO_URL="https://github.com/seepananikhil/algo"
RUNNER_DIR="$HOME/actions-runner"
TOKEN="$1"

echo "=================================================================="
echo "  🚀 Setting up GitHub Actions Self-Hosted Runner on VM"
echo "  Target Repo: $REPO_URL"
echo "=================================================================="

# 1. Prompt for registration token if not provided as argument
if [ -z "$TOKEN" ]; then
    echo ""
    echo "  To register this VM with GitHub Actions:"
    echo "  1. Open: $REPO_URL/settings/actions/runners/new"
    echo "  2. Copy the token shown after '--token' (e.g., AXXXXXXXX...)"
    echo ""
    read -rp "  Enter GitHub Runner Registration Token: " TOKEN
fi

if [ -z "$TOKEN" ]; then
    echo "❌ Error: Token is required to connect the runner."
    exit 1
fi

# 2. Prepare directory
mkdir -p "$RUNNER_DIR"
cd "$RUNNER_DIR"

# 3. Detect architecture
ARCH=$(uname -m)
if [ "$ARCH" = "aarch64" ] || [ "$ARCH" = "arm64" ]; then
    RUNNER_ARCH="arm64"
else
    RUNNER_ARCH="x64"
fi

# 4. Fetch latest runner binary package if not already downloaded
if [ ! -f "config.sh" ]; then
    echo "  📦 Fetching latest GitHub Actions runner package..."
    LATEST_TAG=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | grep '"tag_name":' | sed -E 's/.*"v([^"]+)".*/\1/' || true)
    if [ -z "$LATEST_TAG" ]; then
        LATEST_TAG="2.322.0"
    fi
    TAR_NAME="actions-runner-linux-${RUNNER_ARCH}-${LATEST_TAG}.tar.gz"
    DOWNLOAD_URL="https://github.com/actions/runner/releases/download/v${LATEST_TAG}/${TAR_NAME}"
    echo "  Downloading from $DOWNLOAD_URL ..."
    curl -o "$TAR_NAME" -L "$DOWNLOAD_URL"
    tar xzf "./$TAR_NAME"
    rm -f "$TAR_NAME"
fi

# 5. Stop any existing service before reconfiguring
if [ -f "./svc.sh" ]; then
    sudo ./svc.sh stop 2>/dev/null || true
    sudo ./svc.sh uninstall 2>/dev/null || true
fi

# 6. Configure runner
echo "  ⚙️  Registering runner for $REPO_URL..."
RUNNER_NAME="algo-vm-$(hostname 2>/dev/null || echo 'server')"
./config.sh --url "$REPO_URL" --token "$TOKEN" --name "$RUNNER_NAME" --labels "self-hosted,Linux,${RUNNER_ARCH}" --unattended --replace

# 7. Install and start as a systemd service (auto-reboots on power cycle)
echo "  🔧 Installing systemd service (auto-starts on boot)..."
sudo ./svc.sh install
sudo ./svc.sh start

echo ""
echo "=================================================================="
echo "  ✅ GitHub Actions Runner is ACTIVE & Scheduled to Run on Boot!"
echo "  View in GitHub: $REPO_URL/settings/actions/runners"
echo "=================================================================="
sudo ./svc.sh status
