#!/usr/bin/env bash
set -e
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"

if [ -n "$VIRTUAL_ENV" ] && [ -f "$VIRTUAL_ENV/bin/python" ]; then
    PYTHON_BIN="$VIRTUAL_ENV/bin/python"
elif [ -f "${APP_DIR}/venv/bin/python" ]; then
    PYTHON_BIN="${APP_DIR}/venv/bin/python"
elif [ -f "${APP_DIR}/.venv/bin/python" ]; then
    PYTHON_BIN="${APP_DIR}/.venv/bin/python"
elif [ -f "$HOME/algo_venv/bin/python" ]; then
    PYTHON_BIN="$HOME/algo_venv/bin/python"
else
    PYTHON_BIN=$(which python3 || which python || echo "python3")
fi

exec "$PYTHON_BIN" scripts/preflight_check.py "$@"
