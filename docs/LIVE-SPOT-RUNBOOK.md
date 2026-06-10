# Live Spot Runbook

This codebase is live-ready but live trading is disabled by default. Netlify never
holds Binance secrets and never signs Binance orders. The local worker is the only
process that may sign Spot orders.

## Scope

- Spot only.
- No futures, margin, leverage, borrow/repay, SAPI, DAPI, FAPI, or withdrawals.
- Initial live caps are micro caps:
  - `LIVE_MAX_POSITION_USD=6` (and `BOT_MAX_POSITION_USD=6` as the deployed
    fallback) — see the minNotional buffer note below for why this is 6, not 5
  - `LIVE_MAX_DAILY_LOSS_USD=5`
  - `LIVE_MAX_DAILY_TRADES=3`
  - `LIVE_MAX_OPEN_POSITIONS=1`
  - `LIVE_MAX_SYMBOLS=1`
  - `LIVE_ALLOWED_SYMBOLS=BTCUSDT` (USDT-quoted) **or** `LIVE_ALLOWED_SYMBOLS=BTCUSDC`
    (USDC-quoted — keep funds in USDC and trade BTCUSDC)
  - `LIVE_MIN_NOTIONAL_BUFFER_PCT=10` (optional; default 10)

### minNotional safety buffer

Binance enforces a per-symbol `MIN_NOTIONAL` (≈ $5 for BTCUSDC/BTCUSDT spot). A
MARKET BUY sized at exactly $5 can round **down** through the `LOT_SIZE` step and
land just under minNotional (e.g. 4.87), which the worker rightly rejects
(`Order size 4.87 < minNotional 5`). The control plane has no exchangeInfo, so it
enforces a conservative floor instead: minimum live spend = `ceil(minNotional ×
(1 + LIVE_MIN_NOTIONAL_BUFFER_PCT/100))`. With the defaults (minNotional 5, buffer
10%) that is `ceil(5.50) = $6`. Set `BOT_MAX_POSITION_USD=6` / `LIVE_MAX_POSITION_USD=6`
so the single allowed spend ($6) clears the buffer. The worker still independently
re-checks the real minNotional at execution.

> ⚠️ **Round-trip warning — size for the SELL, not just the BUY.** The BUY fee is
> taken in the base asset, so the free BTC after the buy is slightly *less* than the
> filled quantity (e.g. buy 0.00009 BTC → free 0.00008991). On close, the worker
> sells `min(boughtQty, freeBaseBalance)` floored to `LOT_SIZE`, and that quantity's
> notional can fall below `MIN_NOTIONAL` — in which case it is **unsellable dust**:
> the position is closed as `CLOSED_WITH_DUST` (no SELL) and the dust stays in the
> account. To guarantee a clean full round-trip close, **prefer $8–$10 for BTCUSDC**
> so the post-fee, post-rounding sell quantity comfortably clears minNotional. $6 is
> the absolute minimum to *open*; it does not guarantee a sellable close.

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
# Ceiling is 10. Use 6 for the first live runs: $5 can round under Binance
# minNotional, so the minimum buffered spend is $6 (see minNotional safety buffer).
LIVE_MAX_POSITION_USD=6
LIVE_MAX_DAILY_LOSS_USD=5
LIVE_MAX_DAILY_TRADES=3
LIVE_MAX_OPEN_POSITIONS=1
LIVE_MAX_SYMBOLS=1
# Optional; default 10. Buffer over Binance minNotional for live order sizing.
LIVE_MIN_NOTIONAL_BUFFER_PCT=10
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
# Live caps (LIVE_* preferred; BOT_* are deployed fallbacks the readiness panel
# and gates also read). Keep $6 so the order clears the minNotional buffer.
LIVE_MAX_POSITION_USD=6
BOT_MAX_POSITION_USD=6
LIVE_ALLOWED_SYMBOLS=BTCUSDC
BOT_ALLOWED_SYMBOLS=BTCUSDC
LIVE_MIN_NOTIONAL_BUFFER_PCT=10
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

## Placing the First Live Micro Order

Live sessions never use the testnet smoke button. Once the live worker is online
for the live session, the session detail shows a dedicated **`CREATE LIVE BTCUSDC
ORDER`** button (it only appears when admin + durable + fresh preflight + a single
allowlisted symbol + a set live cap + no open position + entries not paused/killed).

1. Click `CREATE LIVE <symbol> ORDER`. The persistent **"Create Live Micro
   Order"** modal opens with the real-money warning, symbol, `BUY` / `MARKET`,
   max spend, quote asset, and the live session id.
2. Tick `I understand this will place a real-money market order` and click
   `Create live <symbol> order`. This POSTs an explicit intent
   (`symbol`, `side=BUY`, `type=MARKET`, `positionUsd`, `mode=live_spot`,
   `realProductionOrder=true`) to `/api/bot/create-live-execution-intent`.
3. The backend re-checks every live gate, and the local worker independently
   re-enforces `LIVE_ALLOWED_SYMBOLS`, `LIVE_MAX_POSITION_USD`, and the spot-only
   allowlist before it places the order. After the order fills, click **STOP** to
   close the position immediately.

Nothing is auto-placed on worker start, and multi-coin is not enabled — exactly
one allowlisted symbol is supported.

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

