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
ERR_LOG="${LOG_DIR}/local-binance-worker.err.log"
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

SAFE_SESSION="$(printf '%s' "${SESSION_ID:-missing-session}" | sed -E 's/[^A-Za-z0-9_.-]/_/g')"
RUNNER="${LOG_DIR}/run-worker-session-${SAFE_SESSION}.sh"
REPO_Q="$(printf '%q' "${REPO_ROOT}")"
LOG_Q="$(printf '%q' "${LOG_FILE}")"
ERR_Q="$(printf '%q' "${ERR_LOG}")"
SESSION_Q="$(printf '%q' "${SESSION_ID}")"
CONTROL_Q="$(printf '%q' "${CONTROL}")"

cat > "${RUNNER}" <<RUNNER_EOF
#!/usr/bin/env bash
set -euo pipefail
REPO_ROOT=${REPO_Q}
LOG_FILE=${LOG_Q}
ERR_LOG=${ERR_Q}
SESSION_ID=${SESSION_Q}
CONTROL=${CONTROL_Q}
cd "\${REPO_ROOT}"
printf '[LAUNCHER] Repo root: %s\\n' "\${REPO_ROOT}"
printf '[LAUNCHER] Session: %s\\n' "\${SESSION_ID}"
printf '[LAUNCHER] Log: %s\\n' "\${LOG_FILE}"
set -a
. "\${REPO_ROOT}/.env.worker"
set +a
export WORKER_LAUNCHED_BY_PROTOCOL=true
export WORKER_SESSION_ID="\${SESSION_ID}"
if [ -n "\${CONTROL}" ]; then
  export BOT_CONTROL_URL="\${CONTROL}"
fi
npm run bot:worker -- --session "\${SESSION_ID}" 2>&1 | tee -a "\${LOG_FILE}" || {
  status=\$?
  printf '[LAUNCHER] Worker exited with status %s\\n' "\${status}" >> "\${ERR_LOG}"
  exit "\${status}"
}
RUNNER_EOF
chmod +x "${RUNNER}"

log "[LAUNCHER] Repo root: ${REPO_ROOT}"
log "[LAUNCHER] Session: ${SESSION_ID}"
log "[LAUNCHER] Log: ${LOG_FILE}"
log "Launching worker (control=${CONTROL:-from .env.worker})"

# Open a new Terminal window so the user can watch the worker logs live.
osascript - "${RUNNER}" <<'OSA' >/dev/null 2>&1 || "${RUNNER}"
on run argv
    set runnerPath to item 1 of argv
    tell application "Terminal"
        activate
        do script quoted form of runnerPath
    end tell
end run
OSA

log "Worker launch dispatched."
exit 0
