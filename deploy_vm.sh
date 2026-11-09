#!/usr/bin/env bash
# ==============================================================================
# Remote VM Deployer: Run from your local terminal or Cloud Shell
# ==============================================================================

VM_HOST="${VM_HOST:-137.23.58.183}"
VM_USER="${VM_USER:-ubuntu}"
SSH_KEY="${SSH_KEY:-}"

SSH_CMD="ssh"
if [ -n "$SSH_KEY" ]; then
    SSH_CMD="ssh -i $SSH_KEY"
fi

echo "Connecting to $VM_USER@$VM_HOST and triggering update..."
$SSH_CMD "$VM_USER@$VM_HOST" "bash -c 'cd ~/algo && chmod +x update.sh && ./update.sh'"
