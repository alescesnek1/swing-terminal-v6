# Live Spot Runbook

This codebase is live-ready but live trading is disabled by default. Netlify never
holds Binance secrets and never signs Binance orders. The local worker is the only
process that may sign Spot orders.

## Scope

- Spot only.
- No futures, margin, leverage, borrow/repay, SAPI, DAPI, FAPI, or withdrawals.
- Initial live caps are micro caps:
  - `LIVE_MAX_POSITION_USD=10`
  - `LIVE_MAX_DAILY_LOSS_USD=5`
  - `LIVE_MAX_DAILY_TRADES=3`
  - `LIVE_MAX_OPEN_POSITIONS=1`
  - `LIVE_MAX_SYMBOLS=1`
  - `LIVE_ALLOWED_SYMBOLS=BTCUSDT` (USDT-quoted) **or** `LIVE_ALLOWED_SYMBOLS=BTCUSDC`
    (USDC-quoted — keep funds in USDC and trade BTCUSDC)

### Single-symbol live policy

A live run trades exactly one symbol. `LIVE_ALLOWED_SYMBOLS` must be **exactly**
`BTCUSDT` or **exactly** `BTCUSDC`. Any multi-symbol list (e.g. `BTCUSDT,BTCUSDC`) or
any other symbol (e.g. `ETHUSDC`) fails preflight. For `BTCUSDC` the quote asset is
USDC: the preflight shows the USDC balance and market BUY sizing spends the USDC quote
amount. For `BTCUSDT` the quote asset is USDT. No other gate is relaxed.

## Binance API Key

Create a Binance API key with Spot trading only. Do not enable withdrawals. Use an
IP whitelist for the local worker machine whenever possible.

The API key and secret go only into the local worker environment, for example
`.env.worker` on that machine. They must not be placed in Netlify, the frontend,
or a URL.

## Required Live Env

Local worker:

```text
WORKER_MODE=live_spot
BINANCE_ENV=live_spot
BOT_CONTROL_URL=https://<your-site>/api/bot
BOT_WORKER_TOKEN=<worker token>
BINANCE_API_KEY=<local only>
BINANCE_API_SECRET=<local only>
BOT_LIVE_TRADING_ENABLED=true
BOT_ALLOW_REAL_ORDERS=true
LIVE_SPOT_ACK=I_UNDERSTAND_REAL_MONEY_RISK
LOCAL_WORKER_LIVE_CONFIRM=true
# Ceiling is 10; start at 5 for the first live runs.
LIVE_MAX_POSITION_USD=5
LIVE_MAX_DAILY_LOSS_USD=5
LIVE_MAX_DAILY_TRADES=3
LIVE_MAX_OPEN_POSITIONS=1
LIVE_MAX_SYMBOLS=1
# Exactly one symbol: BTCUSDT (USDT-quoted) or BTCUSDC (USDC-quoted).
LIVE_ALLOWED_SYMBOLS=BTCUSDC
LIVE_ALLOW_MARKET_BUY=true
LIVE_ALLOW_MARKET_SELL=true
LIVE_ALLOW_LIMIT_ORDERS=false
```

Control plane:

```text
WORKER_MODE=live_spot
BINANCE_ENV=live_spot
BOT_LIVE_TRADING_ENABLED=true
BOT_ALLOW_REAL_ORDERS=true
LIVE_SPOT_ACK=I_UNDERSTAND_REAL_MONEY_RISK
LOCAL_WORKER_LIVE_CONFIRM=true
BOT_ADMIN_EMAILS=<verified admin email>
```

Durable Netlify Blobs must be active. Memory fallback is close-only and cannot
start live sessions.

## Live Preflight

Run from the local worker machine:

```powershell
npm run bot:worker:live-preflight
```

Expected output includes:

- `LIVE PREFLIGHT PASS` or `LIVE PREFLIGHT FAIL`
- `canTradeSpot`
- `accountType`
- `permissions`
- balances only for relevant base/quote assets
- risk caps
- `spotOnlyPolicy=true`

The preflight writes `.paperbot-live-spot-preflight.json` locally and posts only a
sanitized result to the control plane. It never prints API keys, secrets,
signatures, or full headers.

## Starting Live With Micro Caps

1. Confirm the Bot Feed live readiness panel shows `LIVE READY - MICRO CAPS`.
   If the panel reads `Live locked: confirmation required`, that is expected —
   it means readiness is met but `allowLive` is still false; the modal below
   enables it.
2. Use an admin account.
3. Click `START LIVE SPOT`. A confirmation modal ("Start Live Spot Trading")
   opens showing the symbol allowlist, max trade, max daily loss, max daily
   trades, and current live preflight status. You do **not** need to set
   `allowLive=true` manually first.
4. Tick the checkbox `I understand this uses real money` and click
   `Enable live trading & start` (or `Start live spot` if live trading is
   already enabled). The confirmed checkbox + the exact backend confirmation
   phrase `I UNDERSTAND THIS USES REAL MONEY` (sent programmatically) atomically
   flip `allowLive=true` (clamped to the live caps) and create the live session
   in one fully-gated request. The API contract is unchanged.

The live session is separate from testnet sessions and uses `mode=live_spot`.

## Emergency Stop

Click `EMERGENCY STOP ALL LIVE SPOT` as admin. This sets the global live kill
switch, blocks new entries, queues close commands for live sessions, and asks
workers to close live Spot positions.

You can also set:

```text
BOT_GLOBAL_KILL_SWITCH=true
```

When active, entries are blocked. Workers may only close positions.

## Verifying No Futures Or Margin

Run:

```powershell
Select-String -Path .\scripts\local-binance-worker.mjs,.\netlify\functions\bot.mjs,.\apps\edge\public\js\terminal.js -Pattern "https://fapi\.binance\.com|https://dapi\.binance\.com|/fapi|/dapi|/sapi|withdraw|borrow|repay|leverage|marginType|isolated|cross|futures|margin|createOrder|cancelOrder|BINANCE_API_SECRET|X-MBX-APIKEY|signature|/api/v3/order|window\.prompt" -CaseSensitive:$false
```

Expected interpretation:

- Binance signing terms appear only in the local worker.
- No `/fapi`, `/dapi`, or `/sapi` execution paths exist.
- No leverage, margin, borrow, repay, or withdrawal execution exists.
- Netlify has no Binance signing code.
- The frontend has no Binance secrets and does not use `window.prompt` for live activation.

## Rollback

1. Set `BOT_GLOBAL_KILL_SWITCH=true`.
2. Use `EMERGENCY STOP ALL LIVE SPOT`.
3. Wait for live positions to close or investigate any `WORKER_CLOSE_FAILED`.
4. Set `BOT_LIVE_TRADING_ENABLED=false` and `BOT_ALLOW_REAL_ORDERS=false`.
5. Return worker env to `WORKER_MODE=testnet` and `BINANCE_ENV=testnet`.

