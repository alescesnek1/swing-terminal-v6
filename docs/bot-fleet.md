# Bot Fleet Manager

Multi-user, multi-session control plane on top of the on-demand local worker
(see [worker-launcher.md](worker-launcher.md)). Each user runs their own worker
sessions; admins can view/control every session in the org. **Testnet only** —
live trading is hard-locked.

## Roles & identity

Identity comes from the Supabase JWT (`Authorization: Bearer <token>`), verified
with Node's built-in `crypto` in `_auth.mjs`. The header `alg` selects the path:

- **HS256** (legacy/symmetric projects) → verified with `SUPABASE_JWT_SECRET`.
- **ES256 / RS256** (modern Supabase, asymmetric) → verified against the project's
  public **JWKS** at `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`. JWKS is fetched
  by `kid`, cached in memory per warm instance (10 min TTL). `exp` is always
  checked; `iss`/`aud` are validated on verified tokens.

`getIdentity()` returns `{ ok, verified, authMode, userId, email, orgId, reason }`
where `authMode ∈ { verified_hs256, verified_jwks_es256, verified_jwks_rs256,
decode_only }`. Raw tokens are never logged or returned.

- **decode-only mode** is allowed **only** when `AUTH_DECODE_ONLY=true` (local/dev
  skeleton). It logs `AUTH_DECODE_ONLY=true; auth is decode-only skeleton mode (NOT
  production-safe).` In production (`AUTH_DECODE_ONLY=false`/unset) any token that
  cannot be cryptographically verified is rejected with **401**.
- **Admins:** `BOT_ADMIN_EMAILS` (comma-separated allowlist). Admin control over
  *another user's* session (stop/pause/resume/emergency-close) and org-wide
  visibility **require `verified === true`** — never available in decode-only mode.
- **Users:** can only view/control sessions they own. `ownerUserId` comes from the
  token, never from the request body.

### Required production env

| Env | Purpose |
| --- | --- |
| `SUPABASE_URL` | JWKS endpoint for ES256/RS256 verification |
| `BOT_ADMIN_EMAILS` | admin allowlist |
| `BOT_WORKER_TOKEN` | worker endpoint shared secret |
| `AUTH_DECODE_ONLY=false` | must be false/unset in production |
| `SUPABASE_JWT_SECRET` | optional, only for legacy HS256 projects |

> ⚠️ decode-only mode (`AUTH_DECODE_ONLY=true`) is **not production-safe**: it does
> no signature check and cannot authorize admin control. Use only for local dev.

## Durable store

State lives in **Netlify Blobs** (`fleetBackend()` → `blobs`) so sessions survive
across serverless instances. If `@netlify/blobs` can't load (local/dev) it falls
back to an in-memory map (`fleetBackend()` → `memory`). The whole fleet is one
JSON document; read-modify-write per request keeps per-session idempotency.

## Data model

```
botSessions      { [sessionId]: Session }
workerStatuses   { [workerId]:  WorkerStatus }
executionIntents { [sessionId]: Intent | null }   // ≤1 active per session
executionResults { [sessionId]: Result[] }
positionResults  { [sessionId]: PositionRecord[] }
botConfigs       { [ownerUserId]: BotConfig }
commandQueue     { [sessionId]: Command[] }
usedIdempotencyKeys { [sessionId]: string[] }       // per-session, never global
events[], lastRegime
```

`Session` = `{ sessionId, ownerUserId, ownerEmail, orgId, workerId, mode:'testnet',
status, createdAt, updatedAt, stopRequested, pauseRequested, closePositionsOnStop,
riskState, config }`. `online` is always derived from `lastSeenAt` (< 20s).

## Routes

**Browser (Origin + JWT identity; owner/admin authz):**

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/bot/fleet` | sessions visible to caller + regime + events |
| GET | `/api/bot/config` · POST | per-user config (hard-validated) |
| POST | `/api/bot/start-session` | create session, returns `launchUrl` |
| GET | `/api/bot/session/:id` | session detail |
| POST | `/api/bot/session/:id/stop` | close positions + exit |
| POST | `/api/bot/session/:id/pause` | stop new entries, keep alive |
| POST | `/api/bot/session/:id/resume` | allow entries again |
| POST | `/api/bot/session/:id/emergency-close` | close all positions, keep alive |
| POST | `/api/bot/create-execution-intent` | session-scoped, config + regime gated |
| POST | `/api/bot/create-smoke-execution-intent` | BTCUSDT smoke, gated |

**Worker (`X-BOT-WORKER-TOKEN` + `sessionId` required; `workerId` where relevant):**

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/bot/worker-heartbeat` | bind worker, liveness, control flags |
| GET | `/api/bot/worker-session?sessionId=&workerId=` | **only** place a worker gets its intent |
| POST | `/api/bot/execution-result` | per-session idempotency |
| POST | `/api/bot/position-result` | open/close reports |
| POST | `/api/bot/worker-command-ack` | drain command queue |

`GET /api/bot/execution-intent` is **deprecated** and always returns `intent:null`
(global pickup removed).

## Config (hard validation)

`minTradeUsd ≥ 1`, `maxTradeUsd ≤ 10` (testnet phase), `minTradeUsd ≤ maxTradeUsd`,
`maxOpenPositions ∈ [1,5]`, `allowLive` forced `false`. The worker re-validates the
config snapshot before every order (defense in depth).

## Risk regime

`computeMarketRegime(markets)` → `RISK_ON | NEUTRAL | RISK_OFF | CRASH` using top-100
breadth (% red), median 24h/1h, BTC/ETH moves, flush count, volatility proxy.

- **CRASH** hard-blocks entries (`entriesAllowed:false`). With
  `config.pauseOnMarketCrash`, intent creation returns 409 and emits
  `MARKET_REGIME_CHANGED` / `ENTRIES_PAUSED_MARKET_CRASH`.
- **RISK_OFF** is advisory this phase (entries still allowed, UI warns).

Thresholds live in `REGIME_THRESHOLDS` (`_market-regime.mjs`).

## Lifecycle semantics

- **STOP** = stop entries + close positions + exit worker.
- **PAUSE** = stop new entries, worker stays alive.
- **RESUME** = allow entries again (subject to regime).
- **EMERGENCY CLOSE TESTNET** = close all open positions, worker stays alive.
- A failed close reports `WORKER_CLOSE_FAILED` and the worker never exits while a
  position remains open.

## Security

No Binance secrets in the browser or Netlify; no Netlify signing; no `/sapi`, no
withdraw, no production Binance URL; worker token required; `sessionId` required on
worker endpoints; no global intent pickup; per-session idempotency;
`realOrderSubmitted:false`, `productionReady:false`, live disabled.
