#!/usr/bin/env bash
#
# Removes the swingworker:// launcher app installed by
# register-macos-worker-protocol.sh.
#
set -euo pipefail

APP_DIR="${HOME}/Applications/SwingWorkerLauncher.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"

if [ ! -d "${APP_DIR}" ]; then
  echo "SwingWorkerLauncher.app not found. Nothing to do."
  exit 0
fi

if [ -x "${LSREGISTER}" ]; then
  "${LSREGISTER}" -u "${APP_DIR}" || true
fi

rm -rf "${APP_DIR}"
echo "swingworker:// launcher removed (${APP_DIR})."
