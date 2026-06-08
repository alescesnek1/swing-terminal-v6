#!/bin/bash
set -e

echo "=== Uninstall Local Binance Worker for macOS ==="

if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "[ERROR] This script is only for macOS."
  exit 1
fi

PLIST_PATH="$HOME/Library/LaunchAgents/com.swingterminal.paperbot.worker.plist"

echo "Stopping and unloading LaunchAgent..."
launchctl stop com.swingterminal.paperbot.worker 2>/dev/null || true
launchctl unload "$PLIST_PATH" 2>/dev/null || true

if [ -f "$PLIST_PATH" ]; then
  echo "Deleting plist file..."
  rm "$PLIST_PATH"
fi

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$DIR/.."

echo ""
echo "=== Uninstall Complete ==="
echo "The worker background service has been stopped and removed."
echo ""
echo "NOTE: The following files were NOT deleted automatically:"
echo "- Configuration: $REPO_ROOT/.env.worker"
echo "- Local State: $REPO_ROOT/.paperbot-worker-state.json"
echo "- Logs: $REPO_ROOT/logs/"
echo ""
echo "You may delete them manually if you no longer need them."
