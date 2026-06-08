# First-time Worker Bootstrap Install

This document explains how a brand-new computer goes from "nothing installed" to
a one-click **START BOT** experience, using the web **Install Worker** flow.

The local worker trades **Binance Spot TESTNET only**. There is no live trading,
no production Binance order, and no withdraw capability anywhere in this flow.

---

## Why a first-time install is needed

A fresh machine does not have the repo, `node_modules`, a `.env.worker`, or the
`swingworker://` protocol registered. A browser cannot run terminal commands on
its own, so the **first** install is a single copy-paste command. After that,
**START BOT** works one-click via the `swingworker://` protocol.

---

## The flow at a glance

1. In the web app, when the local worker is offline you'll see
   **LOCAL WORKER OFFLINE** and a button: **Install Worker on this computer**.
2. Click it. The browser asks the control server to mint a **short-lived,
   single-use pairing code** (valid 10 minutes) and shows **one** copy-paste
   command per OS (Windows / macOS), with a copy button and an expiry countdown.
3. Paste the command into a terminal **on the computer that will run the bot**.
4. The installer clones the repo, installs dependencies, exchanges the pairing
   code for the worker token, prompts you **locally** for your Binance Spot
   Testnet API key/secret, registers `swingworker://`, and runs a preflight.
5. Return to the web app and click **I installed it — refresh worker status**,
   then **START BOT**. The worker comes **ONLINE**.

---

## Windows steps

1. Click **Install Worker on this computer** → **Windows** tab → **Copy command**.
2. Open **PowerShell** and paste:

   ```powershell
   powershell -ExecutionPolicy Bypass -Command "irm https://swing-terminal-v6.netlify.app/api/bot/install/windows?pair=<PAIR_CODE> | iex"
   ```

3. If prompted, install **Git for Windows** and **Node.js LTS**, then re-run.
4. When asked, paste your **Binance Spot Testnet** API key, then the secret
   (the secret is typed hidden — it is not echoed).
5. Wait for **"Worker installed. Return to the web and click START BOT."**

## macOS steps

1. Click **Install Worker on this computer** → **macOS** tab → **Copy command**.
2. Open **Terminal** and paste:

   ```bash
   curl -fsSL "https://swing-terminal-v6.netlify.app/api/bot/install/macos?pair=<PAIR_CODE>" | bash
   ```

3. If prompted, install **git** (`xcode-select --install`) and **Node.js LTS**,
   then re-run.
4. When asked, paste your **Binance Spot Testnet** API key, then the secret
   (the secret is typed hidden — it is not echoed).
5. Wait for **"Worker installed. Return to the web and click START BOT."**

---

## Where files are installed

| Item | Windows | macOS |
| --- | --- | --- |
| Repo / worker | `%USERPROFILE%\SwingTerminalWorker` | `~/SwingTerminalWorker` |
| Local secrets | `…\SwingTerminalWorker\.env.worker` | `~/SwingTerminalWorker/.env.worker` (chmod 600) |
| Protocol handler | `HKCU\Software\Classes\swingworker` (registry, **no secrets**) | `~/Applications/SwingWorkerLauncher.app` (plist, **no secrets**) |
| Logs | `…\SwingTerminalWorker\logs\` | `~/SwingTerminalWorker/logs/` |

`.env.worker` contains (testnet only):

```
WORKER_MODE=testnet
BOT_CONTROL_URL=<control server origin>
BOT_WORKER_TOKEN=<fetched from the pair endpoint>
BINANCE_ENV=testnet
BINANCE_API_KEY=<entered locally>
BINANCE_API_SECRET=<entered locally>
MAX_POSITION_USD=10
POLL_INTERVAL_MS=5000
```

---

## How to uninstall

**Windows**

```powershell
cd $env:USERPROFILE\SwingTerminalWorker
npm run worker:unregister:windows
Remove-Item -Recurse -Force $env:USERPROFILE\SwingTerminalWorker
```

**macOS**

```bash
cd ~/SwingTerminalWorker
npm run worker:unregister:macos
rm -rf ~/SwingTerminalWorker
```

Removing the folder deletes `.env.worker` and your local testnet keys with it.

---

## Security model

- **Pairing code**: random high-entropy, **expires in 10 minutes**, **single
  use**. It carries no secrets and is bound to the signed-in owner.
- **No Binance key/secret in the frontend.** They are prompted for locally by the
  installer and written only to `.env.worker`. They are never sent to the web app
  and never reach Netlify.
- **No Binance signing in Netlify.** The control server never holds or uses
  Binance keys; all signing happens in the local worker against the testnet API.
- **No worker token in frontend JS.** The browser never sees `BOT_WORKER_TOKEN`.
  The installer obtains it from `POST /api/bot/worker-pair` after presenting a
  valid pairing code. It is never placed in any URL.
- **`.env.worker` is gitignored** and `chmod 600` on macOS. It is never committed.
- **Registry / plist contain only paths**, never secrets.
- **No live trading.** `BINANCE_ENV=testnet`, `WORKER_MODE=testnet`,
  `MAX_POSITION_USD=10`. Live flags hard-block pairing and execution.

### What secrets live where

| Secret | Location | Reaches the web? |
| --- | --- | --- |
| Binance API key/secret (testnet) | local `.env.worker` only | **No** |
| `BOT_WORKER_TOKEN` | Netlify env + local `.env.worker` | **No** (never in frontend/URL) |
| Pairing code | short-lived, single-use | Only inside the install command |

---

## Endpoints used by this flow

| Endpoint | Caller | Auth | Purpose |
| --- | --- | --- | --- |
| `POST /api/bot/create-worker-pairing-code` | browser | signed-in owner | mint pairing code + install commands |
| `GET /api/bot/install/windows?pair=` | installer | public | return Windows bootstrap (pair code only) |
| `GET /api/bot/install/macos?pair=` | installer | public | return macOS bootstrap (pair code only) |
| `POST /api/bot/worker-pair` | installer | pairing code | redeem code → `{ controlUrl, workerToken, ownerEmail, mode:"testnet" }` |

---

## Troubleshooting

- **"Worker did not connect"** after START BOT: use **Retry Open Worker
  Terminal**, **Install Worker**, or **Clear stale session** from the cockpit.
- **Pairing code expired / already used**: generate a fresh one with **Install
  Worker** — codes are single-use and last 10 minutes.
- **Preflight failed**: re-check the Binance Spot Testnet key/secret in
  `.env.worker`. Get testnet keys at <https://testnet.binance.vision>.
