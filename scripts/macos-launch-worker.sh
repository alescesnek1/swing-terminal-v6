#!/usr/bin/env bash
#
# swingworker:// protocol handler for macOS. Invoked by SwingWorkerLauncher.app
# with the full URL as $1:
#   swingworker://start?session=<id>&control=<encoded control url>
#   swingworker://stop?session=<id>&control=<encoded control url>
#
# start -> loads .env.worker, sets session env, launches the worker in a new
#          Terminal window so the user can watch logs; also tees to logs/.
# stop  -> no-op. The running worker polls the control server, sees stopRequested,
#          closes testnet positions, and exits on its own.
#
# SECURITY: Secrets are read only from .env.worker (gitignored). They are never
# stored in the .app, the Info.plist, or logged.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${REPO_ROOT}/logs"
LOG_FILE="${LOG_DIR}/local-binance-worker.log"
mkdir -p "${LOG_DIR}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "${LOG_FILE}"; }

URL="${1:-}"
if [ -z "${URL}" ]; then
  log "No URL provided."
  exit 1
fi

# --- Parse swingworker://<action>?<query> ---
ACTION="$(printf '%s' "${URL}" | sed -E 's#^swingworker://([^/?]+).*#\1#')"
QUERY="$(printf '%s' "${URL}" | sed -E 's#^[^?]*\??##')"

urldecode() { printf '%b' "${1//%/\\x}"; }

SESSION_ID=""
CONTROL=""
IFS='&' read -ra PAIRS <<< "${QUERY}"
for pair in "${PAIRS[@]}"; do
  [ -z "${pair}" ] && continue
  key="${pair%%=*}"
  val="${pair#*=}"
  case "${key}" in
    session) SESSION_ID="$(urldecode "${val}")" ;;
    control) CONTROL="$(urldecode "${val}")" ;;
  esac
done

log "Protocol invoked: action=${ACTION} session=${SESSION_ID}"

if [ "${ACTION}" = "stop" ]; then
  log "Stop signal received. Running worker will close testnet positions via control polling and exit."
  exit 0
fi

if [ "${ACTION}" != "start" ]; then
  log "Unknown action '${ACTION}'. Expected start or stop."
  exit 1
fi

ENV_FILE="${REPO_ROOT}/.env.worker"
if [ ! -f "${ENV_FILE}" ]; then
  log ".env.worker not found at ${ENV_FILE}."
  osascript -e 'display alert "SwingWorker setup required" message "Copy .env.worker.example to .env.worker and fill in your Binance TESTNET keys and BOT_WORKER_TOKEN."' >/dev/null 2>&1 || true
  exit 1
fi

# Build a command that loads .env.worker, applies session overrides, and runs the
# worker with output teed to the log. Runs in a fresh Terminal window.
RUN_CMD="cd $(printf '%q' "${REPO_ROOT}") \
&& set -a && . ./.env.worker && set +a \
&& export WORKER_LAUNCHED_BY_PROTOCOL=true \
&& export WORKER_SESSION_ID=$(printf '%q' "${SESSION_ID}")"

if [ -n "${CONTROL}" ]; then
  RUN_CMD="${RUN_CMD} && export BOT_CONTROL_URL=$(printf '%q' "${CONTROL}")"
fi

RUN_CMD="${RUN_CMD} && node scripts/local-binance-worker.mjs --session $(printf '%q' "${SESSION_ID}") 2>&1 | tee -a $(printf '%q' "${LOG_FILE}")"

log "Launching worker (control=${CONTROL:-from .env.worker})"

# Open a new Terminal window so the user can watch the worker logs live.
osascript <<OSA >/dev/null 2>&1 || node scripts/local-binance-worker.mjs --session "${SESSION_ID}"
tell application "Terminal"
    activate
    do script "${RUN_CMD}"
end tell
OSA

log "Worker launch dispatched."
exit 0
