#!/bin/bash
set -e

# Change to repo root
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR/.."

# Ensure logs directory exists
mkdir -p logs

# Redirect all subsequent output (stdout and stderr) to log files
# using exec to tee output. Or simpler: just run the node process with redirect
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting run-local-worker.sh" >> logs/local-binance-worker.log

if [ ! -f .env.worker ]; then
  echo "[ERROR] .env.worker not found. Please run setup first." >> logs/local-binance-worker.err.log
  exit 1
fi

# Load env variables safely without printing them
set -a
source .env.worker
set +a

# Verify Node
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed or not in PATH" >> logs/local-binance-worker.err.log
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm is not installed or not in PATH" >> logs/local-binance-worker.err.log
  exit 1
fi

# Execute worker
echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] Starting bot:worker via npm" >> logs/local-binance-worker.log
npm run bot:worker >> logs/local-binance-worker.log 2>> logs/local-binance-worker.err.log
