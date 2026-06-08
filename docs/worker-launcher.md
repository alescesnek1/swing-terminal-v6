# On-demand Local Worker Launcher

The bot no longer runs as a persistent daemon / LaunchAgent. Instead, the web
**START BOT** button launches a local worker on demand through a custom URL
protocol (`swingworker://`). The worker trades **Binance Spot Testnet only**,
reports heartbeat / positions / results to the Netlify control server, and on
**STOP BOT** it closes open testnet positions and exits.

```
Browser (START BOT)
  └─ POST /api/bot/start-session  ──► { sessionId, launchUrl }
  └─ window.location = swingworker://start?session=…&control=…
       └─ OS protocol handler ──► local launcher script
            └─ node scripts/local-binance-worker.mjs --session <id>
                 ├─ POST /api/bot/worker-heartbeat   (every 5s)
                 ├─ GET  /api/bot/worker-session      (poll for stopRequested)
                 ├─ GET  /api/bot/execution-intent    (BUY MARKET testnet)
                 ├─ POST /api/bot/execution-result
                 └─ POST /api/bot/position-result

Browser (STOP BOT)
  └─ POST /api/bot/stop-session  ──► sets stopRequested=true
       └─ worker sees stopRequested, MARKET SELLs open positions, exits 0
```

## Security model

- The **browser never sees** Binance keys or the worker token.
- **Netlify never signs** Binance orders and never holds Binance secrets used for
  signing. Only the local worker signs orders (HMAC) against the testnet API.
- The **registry / Info.plist contain no secrets** — only the path to the local
  launcher script.
- Secrets live only in `.env.worker` (gitignored).
- `swingworker://` URLs carry only a `session` id and the `control` URL — **no
  secrets**.
- **STOP never kills the process before attempting to close positions.** A failed
  close reports `WORKER_CLOSE_FAILED` and the worker stays alive (manual attention)
  rather than abandoning an open position.

## Hard gates (this phase)

- Testnet only (`WORKER_MODE=testnet`, `BINANCE_ENV=testnet`).
- Spot long only.
- `MARKET` `BUY` / `SELL` only.
- `MAX_POSITION_USD <= 10`.
- Live / production trading is locked. No `/sapi`, no withdraw, no proxies.

## One-time setup

1. Copy the env template and fill in **Binance Spot Testnet** keys
   (https://testnet.binance.vision) plus the `BOT_WORKER_TOKEN` that matches the
   Netlify `BOT_WORKER_TOKEN` environment variable:

   ```
   cp .env.worker.example .env.worker
   ```

2. Register the `swingworker://` protocol handler:

   ### Windows

   ```powershell
   npm run worker:register:windows
   # or:
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\register-windows-worker-protocol.ps1
   ```

   This writes `HKCU:\Software\Classes\swingworker` (per-user, no admin needed).
   Remove it later with `npm run worker:unregister:windows`.

   ### macOS

   ```bash
   npm run worker:register:macos
   # or:
   bash scripts/register-macos-worker-protocol.sh
   ```

   This creates `~/Applications/SwingWorkerLauncher.app` whose `Info.plist`
   declares the `swingworker` URL scheme. Remove it later with
   `npm run worker:unregister:macos`.

3. (Optional) Verify the worker can reach testnet before using the UI:

   ```bash
   # load .env.worker into your shell first, then:
   npm run bot:worker:preflight
   ```

## Daily use

1. Open the **BOT FEED** tab.
2. Click **START BOT**. The browser asks the backend for a session and then opens
   `swingworker://start?...`, which launches the local worker in a visible
   terminal window. The UI shows `LAUNCHING LOCAL WORKER` until the first
   heartbeat, then `LOCAL WORKER ONLINE — BOT RUNNING`.
3. Create a testnet execution intent (existing flow). The worker picks it up and
   submits a `BUY MARKET` testnet order, tracking the open position locally in
   `.paperbot-worker-state.json`.
4. Click **STOP BOT**. The UI shows `STOPPING — CLOSING POSITIONS`. The worker
   `MARKET SELL`s each open testnet position, reports the close, and exits. The UI
   then shows `BOT STOPPED`. If a close fails, the UI shows
   `CLOSE FAILED — MANUAL ATTENTION REQUIRED` and the worker keeps retrying.

## Logs

- Windows / macOS: `logs/local-binance-worker.log` (the launcher tees worker
  output here and also shows a live terminal window).
- Local position state: `.paperbot-worker-state.json` (gitignored).

## Backend session endpoints

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/bot/start-session` | browser (Origin + auth) | create session, return `launchUrl` |
| `POST /api/bot/stop-session` | browser (Origin + auth) | set `stopRequested`, close-on-stop |
| `GET /api/bot/worker-session` | worker (`X-BOT-WORKER-TOKEN`) | session state + current intent |
| `POST /api/bot/worker-heartbeat` | worker | liveness + lifecycle state |
| `POST /api/bot/execution-result` | worker | order result (now carries `sessionId`) |
| `POST /api/bot/position-result` | worker | open / closed position reports |
