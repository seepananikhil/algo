#!/usr/bin/env bash
# Quick start script for Linux / Mac VM
if [ -d "venv" ]; then
    source venv/bin/activate
fi
npm --prefix web run build
python3 app_server.py
