#!/bin/bash
set -e

echo "=== Setup Local Binance Worker for macOS ==="

if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "[ERROR] This setup script is only for macOS."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is not installed or not in PATH."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm is not installed or not in PATH."
  exit 1
fi

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_ROOT="$DIR/.."
cd "$REPO_ROOT"

if [ ! -f .env.worker ]; then
  echo "Copying .env.worker.example to .env.worker..."
  cp .env.worker.example .env.worker
  chmod 600 .env.worker
  echo ""
  echo ">>> ACTION REQUIRED <<<"
  echo "Open .env.worker and fill BOT_WORKER_TOKEN, BINANCE_API_KEY, BINANCE_API_SECRET"
  echo "Press Enter when you are done to continue setup, or Ctrl+C to abort."
  read -r
fi

# Ensure permissions on .env.worker
chmod 600 .env.worker

PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST_PATH="$PLIST_DIR/com.swingterminal.paperbot.worker.plist"

echo "Creating LaunchAgent plist at $PLIST_PATH..."

cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.swingterminal.paperbot.worker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$REPO_ROOT/scripts/run-local-worker.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$REPO_ROOT</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$REPO_ROOT/logs/local-binance-worker.log</string>
    <key>StandardErrorPath</key>
    <string>$REPO_ROOT/logs/local-binance-worker.err.log</string>
</dict>
</plist>
EOF

echo "Loading LaunchAgent..."
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"
launchctl start com.swingterminal.paperbot.worker

echo ""
echo "=== Setup Complete ==="
echo "The worker should now be running in the background."
echo ""
echo "To check status:"
echo "  launchctl list | grep com.swingterminal.paperbot.worker"
echo "  tail -f logs/local-binance-worker.log logs/local-binance-worker.err.log"
echo ""
