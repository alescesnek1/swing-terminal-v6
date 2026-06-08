#!/usr/bin/env bash
#
# First-time SwingTerminal local worker installer for macOS (TESTNET only).
#
# Bootstraps a brand-new machine so the web "START BOT" button works one-click:
#   1. clones (or pulls) the repo into ~/SwingTerminalWorker
#   2. runs npm install
#   3. exchanges the short-lived pairing code at POST /api/bot/worker-pair for
#      the worker bootstrap config (control URL + shared worker token)
#   4. prompts LOCALLY for Binance Spot Testnet API key/secret and writes them,
#      together with the worker token, to a gitignored .env.worker (chmod 600)
#   5. registers the swingworker:// protocol and runs a testnet preflight
#
# SECURITY:
#   - The pairing code is short-lived and single-use; it carries NO secrets.
#   - The worker token is fetched from the control server, never embedded in any
#     URL and never shown in the browser.
#   - Binance keys are read locally (secret with echo disabled), written only to
#     .env.worker (chmod 600), and never logged or committed.
#   - .env.worker is gitignored. No secrets are written to the LaunchServices app.
#
set -euo pipefail

PAIR_CODE=""
CONTROL_URL="https://swing-terminal-v6.netlify.app"
REPO="https://github.com/alescesnek1/swing-terminal-v6.git"

usage() {
  cat <<'USAGE'
SwingTerminal Worker installer (macOS, TESTNET only)

Usage:
  install-worker-macos.sh --pair <CODE> [--control <url>] [--repo <git url>]

What it does:
  - clones/pulls the repo into ~/SwingTerminalWorker
  - npm install
  - redeems the pairing code for the worker token (no secrets in the URL)
  - prompts locally for Binance Spot Testnet API key/secret (not sent to the web)
  - writes a gitignored .env.worker (chmod 600), registers swingworker://, preflight

After it finishes: return to the web app and click START BOT.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --pair)    PAIR_CODE="${2:-}"; shift 2 ;;
    --control) CONTROL_URL="${2:-}"; shift 2 ;;
    --repo)    REPO="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[WARN] Unknown argument: $1" >&2; shift ;;
  esac
done

step() { printf '\033[36m[INSTALL]\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m[OK]\033[0m %s\n' "$1"; }
warn() { printf '\033[33m[WARN]\033[0m %s\n' "$1"; }

if [ -z "${PAIR_CODE}" ]; then
  warn "No --pair code provided. Generate one from the web app (Install Worker on this computer)."
  usage
  exit 1
fi

CONTROL_URL="${CONTROL_URL%/}"
INSTALL_DIR="${HOME}/SwingTerminalWorker"
step "Install directory: ${INSTALL_DIR}"

# --- 1. Require git and node/npm ---
MISSING=()
command -v git  >/dev/null 2>&1 || MISSING+=("git")
command -v node >/dev/null 2>&1 || MISSING+=("node")
command -v npm  >/dev/null 2>&1 || MISSING+=("npm")
if [ "${#MISSING[@]}" -gt 0 ]; then
  warn "Missing required tools: ${MISSING[*]}"
  echo ""
  echo "Please install the following, then re-run this installer:"
  for m in "${MISSING[@]}"; do
    case "$m" in
      git)  echo "  - Git:    xcode-select --install   (or https://git-scm.com/download/mac)" ;;
      node) echo "  - Node.js LTS (includes npm): https://nodejs.org/en/download  (or 'brew install node')" ;;
      npm)  echo "  - npm ships with Node.js LTS: https://nodejs.org/en/download" ;;
    esac
  done
  echo ""
  exit 1
fi

# --- 2. Clone or pull the repo ---
mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"
if [ -d "${INSTALL_DIR}/.git" ]; then
  step "Existing checkout found. Pulling latest..."
  git pull --ff-only
else
  step "Cloning ${REPO} ..."
  git clone "${REPO}" .
fi
ok "Repository ready."

# --- 3. npm install ---
step "Installing npm dependencies (this can take a minute)..."
npm install
ok "Dependencies installed."

# --- 4. Redeem the pairing code for the worker bootstrap config ---
step "Pairing this worker with the control server..."
HOSTNAME_SHORT="$(hostname -s 2>/dev/null || hostname)"
PAIR_RESPONSE="$(curl -fsS -X POST "${CONTROL_URL}/api/bot/worker-pair" \
  -H 'Content-Type: application/json' \
  -d "{\"pairingCode\":\"${PAIR_CODE}\",\"platform\":\"macos\",\"hostname\":\"${HOSTNAME_SHORT}\"}")" || {
  warn "Pairing failed. The code may be expired or already used. Generate a new one from the web app."
  exit 1
}

json_field() { printf '%s' "$1" | sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\".*/\1/p"; }
WORKER_TOKEN="$(json_field "${PAIR_RESPONSE}" 'workerToken')"
PAIR_CONTROL_URL="$(json_field "${PAIR_RESPONSE}" 'controlUrl')"
OWNER_EMAIL="$(json_field "${PAIR_RESPONSE}" 'ownerEmail')"
if [ -z "${WORKER_TOKEN}" ]; then
  warn "Pairing response did not include a worker token. Generate a new pairing code and retry."
  exit 1
fi
EFFECTIVE_CONTROL_URL="${PAIR_CONTROL_URL:-$CONTROL_URL}"
EFFECTIVE_CONTROL_URL="${EFFECTIVE_CONTROL_URL%/}"
ok "Paired. Owner: ${OWNER_EMAIL:-unknown}"

# --- 5. Prompt locally for Binance Spot Testnet API key/secret ---
echo ""
echo "Enter your Binance SPOT TESTNET API credentials."
echo "Get them at https://testnet.binance.vision (these are NOT your real keys)."
echo "They are stored only on this computer in .env.worker and never sent to the web."
printf 'Binance Spot Testnet API KEY: '
read -r BINANCE_API_KEY
printf 'Binance Spot Testnet API SECRET (hidden): '
# Disable echo so the secret is never shown or logged.
stty -echo 2>/dev/null || true
read -r BINANCE_API_SECRET
stty echo 2>/dev/null || true
echo ""
if [ -z "${BINANCE_API_KEY}" ] || [ -z "${BINANCE_API_SECRET}" ]; then
  warn "API key and secret are required. Re-run the installer."
  exit 1
fi

# --- 6. Write .env.worker (chmod 600, gitignored, never logged/committed) ---
ENV_PATH="${INSTALL_DIR}/.env.worker"
umask 077
cat > "${ENV_PATH}" <<ENV_EOF
WORKER_MODE=testnet
BOT_CONTROL_URL=${EFFECTIVE_CONTROL_URL}
BOT_WORKER_TOKEN=${WORKER_TOKEN}
BINANCE_ENV=testnet
BINANCE_API_KEY=${BINANCE_API_KEY}
BINANCE_API_SECRET=${BINANCE_API_SECRET}
MAX_POSITION_USD=10
POLL_INTERVAL_MS=5000
ENV_EOF
chmod 600 "${ENV_PATH}"
unset BINANCE_API_SECRET
ok ".env.worker written (chmod 600, local, gitignored)."

# --- 7. Register swingworker:// protocol + testnet preflight ---
step "Registering swingworker:// protocol..."
npm run worker:register:macos || warn "Protocol registration reported an error. You can re-run: npm run worker:register:macos"

step "Running Binance Spot Testnet preflight..."
set -a
# shellcheck disable=SC1090
. "${ENV_PATH}"
set +a
npm run bot:worker:preflight || warn "Preflight failed. Check your testnet API key/secret in .env.worker."

echo ""
ok "Worker installed. Return to the web and click START BOT."
echo ""
exit 0
