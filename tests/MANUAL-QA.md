# Bot Feed — Manual QA checklist (button-only lifecycle)

`terminal.js` is a classic browser script (no module exports), so the UI behaviours
below are verified manually. The backend + worker contracts they depend on are
covered by the automated suites (`npm test`). Run through this once after any
Bot Feed change. **No PowerShell, no console fetch, no session-ID copying, no
process kills, no state-file edits are required at any step.**

## Happy-path lifecycle
1. Open Bot Feed with no session → top shows **READY / NO SESSION**, `LOCAL WORKER OFFLINE`, **START BOT** enabled.
2. Click **Install Worker** (first time only) → copy one command, run once on this PC.
3. Click **START BOT** → browser opens `swingworker://` → worker launches.
4. Within ~5s the selected session shows **LOCAL WORKER ONLINE — BOT RUNNING** (green).
5. **CREATE TESTNET SMOKE ORDER** is visible → click it.
6. Worker submits BTCUSDT testnet MARKET BUY; event feed shows `TESTNET_ORDER_SUBMITTED`, `WORKER_POSITION_OPEN`.
7. UI shows **OPEN POSITION EXISTS — WORKER ONLINE**, Open positions = 1, BTCUSDT qty shown.
8. **START BOT is disabled** and **smoke order is hidden** globally (banner explains why).
9. Click **STOP BOT** (graceful) *or* **EMERGENCY CLOSE TESTNET** → progress line advances:
   `CLOSE REQUESTED → WORKER ONLINE → SELL SUBMITTED → CLOSED (→ EXITED for STOP)`.
10. UI shows position closed (Open positions = 0), event feed shows `WORKER_POSITION_CLOSED`.
11. Worker exits (STOP) or returns to idle (EMERGENCY keeps it alive).
12. **START BOT** becomes enabled again; no open-position banner.
13. No stale/orphan/flicker state remains.

## Specific UI assertions (spec I — frontend)
- [ ] **F1** START BOT disabled while any session has openPositions > 0.
- [ ] **F2** "Reconnect Worker to Position Session" launches `swingworker://start?session=<OPEN_POSITION_ID>` (full id, never shortened).
- [ ] **F3** "Emergency Close Testnet" / "Stop Bot and Close Position" POST to `/api/bot/session/<OPEN_POSITION_ID>/...`.
- [ ] **F4** Smoke order hidden whenever openPositions > 0 (any session).
- [ ] **F5** When a worker is online on a different session than the open-position one, the red
      **WORKER CONNECTED TO DIFFERENT SESSION — RECONNECT REQUIRED** banner appears.
- [ ] **F6 (flicker)** Trigger a transient empty `/api/bot/fleet` (e.g. throttle network / cold function).
      The open-position card must NOT disappear; a "Reconnecting to control state…" notice shows and
      the position view is preserved.

## State-hierarchy contradictions that must NOT appear
- [ ] START BOT enabled while an open position exists.
- [ ] Top "LOCAL WORKER OFFLINE" while the selected detail says the worker is running.
- [ ] Smoke intent card actionable while openPositions > 0.
- [ ] "Clear stale" offered while an open position exists.
- [ ] Two different sessions shown as active with no mismatch warning.

## Durability (spec A/E)
- [ ] When the store is `memory_fallback` (not allowed), a red
      **CONTROL STATE NOT DURABLE — ONLY CLOSE EXISTING POSITIONS ALLOWED** banner shows, with the
      `storeError` reason, and the connection row reads `in-memory store (memory_fallback)`.
- [ ] START BOT and CREATE TESTNET SMOKE ORDER are disabled while non-durable; close/reconnect remain available.
- [ ] Backend returns `409 { code: 'not_durable' }` for start-session / create-*-intent in this mode
      (verified by automated test `G-1`).
- [ ] Fix: enable Netlify Blobs on the site (or set `NETLIFY_SITE_ID` + `NETLIFY_API_TOKEN`); the fleet
      response then reports `storeMode: durable_blobs`, `durable: true`, `newEntriesAllowed: true`.

## Automated end-to-end proof
- [ ] `npm run e2e` drives START → ONLINE → SMOKE BUY → OPEN → EMERGENCY CLOSE → SELL → CLOSED →
      START-available against the real worker process + real backend handler + mock Binance, and prints
      the worker BUY/SELL log lines and fleet before/after.

## Closing the CURRENT orphan BTCUSDT (order 2358967) via UI only
1. Open Bot Feed. The open-position banner appears for the session holding BTCUSDT.
2. If its worker is offline → click **Reconnect Worker to Position Session** (relaunches the SAME session id).
3. Click **Emergency Close Testnet** (or **Stop Bot and Close Position**).
4. Worker hydrates the position from backend `openPositions` if local state is missing, then MARKET SELLs.
5. Watch the progress line reach **CLOSED**; Open positions → 0; START BOT re-enables.
6. If the close fails, the banner shows **CLOSE FAILED — MANUAL ATTENTION REQUIRED** with the last error
   and a retry; the session is NOT cleared.
