#!/usr/bin/env bash
# ===== JobPilot Desktop — one-command launcher (macOS / Linux) =====
# Run:  ./start-jobpilot.sh
# First run installs what it needs and asks for your connect code once.
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is not installed. Get it once from https://nodejs.org (the LTS button),"
  echo "  install it, then run this again."
  echo
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "  First-time setup: installing JobPilot Desktop (one minute)…"
  npm install
fi

node src/index.js
