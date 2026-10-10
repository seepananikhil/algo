#!/usr/bin/env bash
set -e
python -m pip install --no-cache-dir -r requirements.txt
python app_server.py
