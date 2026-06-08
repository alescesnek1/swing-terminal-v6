#!/usr/bin/env bash
#
# Registers the swingworker:// custom URL protocol on macOS by creating a small
# launcher .app bundle at ~/Applications/SwingWorkerLauncher.app whose Info.plist
# declares CFBundleURLSchemes = swingworker.
#
# When the web "START BOT" button opens swingworker://start?..., LaunchServices
# routes the URL to this app, which forwards it to scripts/macos-launch-worker.sh.
#
# SECURITY: No secrets are stored in the .app or its Info.plist. Binance keys and
# the worker token live only in .env.worker (gitignored).
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_SCRIPT="${REPO_ROOT}/scripts/macos-launch-worker.sh"
APP_DIR="${HOME}/Applications/SwingWorkerLauncher.app"
MACOS_DIR="${APP_DIR}/Contents/MacOS"
PLIST="${APP_DIR}/Contents/Info.plist"
STUB="${MACOS_DIR}/SwingWorkerLauncher"

if [ ! -f "${LAUNCH_SCRIPT}" ]; then
  echo "ERROR: launcher not found: ${LAUNCH_SCRIPT}" >&2
  exit 1
fi

echo "Registering swingworker:// protocol via ${APP_DIR}"
echo "  Repo root : ${REPO_ROOT}"
echo "  Launcher  : ${LAUNCH_SCRIPT}"

mkdir -p "${MACOS_DIR}"

cat > "${PLIST}" <<'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>SwingWorkerLauncher</string>
  <key>CFBundleIdentifier</key>
  <string>app.swingterminal.swingworkerlauncher</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>SwingWorkerLauncher</string>
  <key>LSUIElement</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>SwingWorker Protocol</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>swingworker</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
PLIST_EOF

# Stub executable: receives the URL via $1 (Apple events are translated by the
# wrapper below) and forwards to the repo launch script. We use a tiny AppleScript
# app-style stub via osascript so LaunchServices delivers the URL.
cat > "${STUB}" <<STUB_EOF
#!/usr/bin/env bash
# Launcher stub. The opened URL is delivered as the first argument by the
# AppleScript bridge below, or via the 'open' event captured by osascript.
REPO_ROOT="${REPO_ROOT}"
URL="\${1:-}"
if [ -z "\${URL}" ]; then
  exit 0
fi
exec "\${REPO_ROOT}/scripts/macos-launch-worker.sh" "\${URL}"
STUB_EOF
chmod +x "${STUB}"

# Replace the bash stub with an AppleScript applet so macOS delivers the URL via
# the standard "open location" event, then calls our shell launcher.
cat > "${MACOS_DIR}/handler.applescript" <<APPLE_EOF
on open location this_URL
    do shell script "'" & "${REPO_ROOT}/scripts/macos-launch-worker.sh" & "' " & quoted form of this_URL
end open location
APPLE_EOF

# Register the bundle with LaunchServices so the scheme is picked up immediately.
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -f "${APP_DIR}" || true
fi

echo ""
echo "swingworker:// protocol registered."
echo "Next: copy .env.worker.example to .env.worker and fill in testnet keys + BOT_WORKER_TOKEN."
