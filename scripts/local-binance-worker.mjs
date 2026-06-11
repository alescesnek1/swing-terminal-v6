import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
// Public spot market snapshot fetcher (no API keys, no signed/order endpoints).
// Shared with the Netlify auto-trader fallback; the worker is the PRIMARY source
// because serverless egress to Binance public endpoints can be blocked (HTTP 451).
import { fetchBinancePublicSnapshot, PUBLIC_SNAPSHOT_SOURCE } from './auto/binance-public.mjs';
import { createAutoLoop } from './auto/auto-loop.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Self-observability: the worker writes its own log file (not only via the
// launcher's Tee-Object). This guarantees logs exist even on a direct
// `node scripts/local-binance-worker.mjs` run with no protocol launcher. ──
const REPO_ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(REPO_ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'local-binance-worker.log');
const ERR_LOG_FILE = path.join(LOG_DIR, 'local-binance-worker.err.log');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* best effort */ }
try { fs.closeSync(fs.openSync(LOG_FILE, 'a')); fs.closeSync(fs.openSync(ERR_LOG_FILE, 'a')); } catch { /* best effort */ }
function _logTs() { return new Date().toISOString(); }
function _appendLog(file, line) { try { fs.appendFileSync(file, line + '\n'); } catch { /* never crash on logging */ } }
function _fmtArgs(args) {
  return args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}
const _origConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
console.log = (...a) => { const m = _fmtArgs(a); _origConsole.log(m); _appendLog(LOG_FILE, `[${_logTs()}] ${m}`); };
console.warn = (...a) => { const m = _fmtArgs(a); _origConsole.warn(m); _appendLog(LOG_FILE, `[${_logTs()}] ${m}`); };
console.error = (...a) => { const m = _fmtArgs(a); _origConsole.error(m); _appendLog(LOG_FILE, `[${_logTs()}] ${m}`); _appendLog(ERR_LOG_FILE, `[${_logTs()}] ${m}`); };
// Create the log file immediately so observability exists from the first instant.
console.log(`[BOOT] Local Binance Worker booting (pid ${process.pid}). Log: ${LOG_FILE}`);

// --- CLI args ---
function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
}

function loadDotEnvWorkerIfNeeded() {
  const required = ['WORKER_MODE', 'BOT_CONTROL_URL', 'BOT_WORKER_TOKEN', 'BINANCE_ENV', 'BINANCE_API_KEY', 'BINANCE_API_SECRET'];
  if (required.every((key) => process.env[key])) return { loaded: false, path: null, keysApplied: 0, reason: 'env_present' };
  const envPath = path.join(__dirname, '..', '.env.worker');
  if (!fs.existsSync(envPath)) return { loaded: false, path: envPath, keysApplied: 0, reason: 'missing_file' };
  let keysApplied = 0;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const row of raw.split(/\r?\n/)) {
    const line = row.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx < 1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key || process.env[key]) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
    keysApplied++;
  }
  return { loaded: true, path: envPath, keysApplied, reason: 'loaded_missing_keys' };
}

const dotEnvWorkerLoad = loadDotEnvWorkerIfNeeded();
if (dotEnvWorkerLoad.loaded) {
  console.log(`[ENV] Loaded .env.worker for missing worker env (${dotEnvWorkerLoad.keysApplied} keys applied).`);
} else if (dotEnvWorkerLoad.reason === 'missing_file') {
  console.log(`[ENV] .env.worker not found at ${dotEnvWorkerLoad.path}; using process environment only.`);
}

// --- Configuration ---
const workerMode = process.env.WORKER_MODE;
const binanceEnv = process.env.BINANCE_ENV;
const controlUrl = process.env.BOT_CONTROL_URL;
const workerToken = process.env.BOT_WORKER_TOKEN;
const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const maxPositionUsd = Number(process.env.MAX_POSITION_USD) || 10;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS) || 5000;
const sessionId = getArg('session') || process.env.WORKER_SESSION_ID || null;
const launchedByProtocol = process.env.WORKER_LAUNCHED_BY_PROTOCOL === 'true';
const WORKER_MODES = new Set(['testnet', 'live_spot']);
const BINANCE_ENVS = new Set(['testnet', 'live_spot']);
const isLiveSpot = workerMode === 'live_spot' || binanceEnv === 'live_spot';

const HEARTBEAT_INTERVAL_MS = 5000;
// Public market snapshot cadence. Deliberately 60s (NOT the 5s heartbeat) so the
// worker never spams Binance public endpoints. Disable with
// WORKER_MARKET_SNAPSHOT_ENABLED=false.
const MARKET_SNAPSHOT_INTERVAL_MS = Number(process.env.WORKER_MARKET_SNAPSHOT_INTERVAL_MS) || 60000;
const marketSnapshotEnabled = process.env.WORKER_MARKET_SNAPSHOT_ENABLED !== 'false';
const MAX_CLOSE_RETRIES = 5;
const TESTNET_MAX_TRADE_USD = 10;
const MISSING_SESSION_EXIT_MS = 60000;
const BINANCE_TESTNET_BASE_URL = 'https://testnet.binance.vision/api';
const BINANCE_LIVE_SPOT_BASE_URL = 'https://api.binance.com/api';
const LIVE_SPOT_ACK_TEXT = 'I_UNDERSTAND_REAL_MONEY_RISK';
// Hard live-preflight ceilings. These are independent assertions on the risk caps
// the worker actually enforces (liveRiskCaps reads the same LIVE_* env). Preflight
// FAILS if the configured caps exceed these, so a misconfigured machine can never
// pass preflight and then place oversized live orders.
const LIVE_PREFLIGHT_MAX_POSITION_USD = 10;
const LIVE_PREFLIGHT_MAX_DAILY_LOSS_USD = 5;
const LIVE_PREFLIGHT_DEFAULT_MAX_DAILY_TRADES_HARD_CAP = 10;
// A live run trades a SINGLE symbol. Two single-symbol configurations are valid:
// exactly BTCUSDT (USDT-quoted) or exactly BTCUSDC (USDC-quoted, keep funds in USDC).
// Any multi-symbol list, or any other symbol, FAILS preflight. This is intentionally
// an allowlist of exact strings, not a substring/prefix check.
const LIVE_PREFLIGHT_ALLOWED_SYMBOL = 'BTCUSDT';
const LIVE_PREFLIGHT_ALLOWED_SYMBOLS = ['BTCUSDT', 'BTCUSDC'];
const LIVE_PREFLIGHT_MAX_AGE_MS = Number(process.env.LIVE_PREFLIGHT_MAX_AGE_MS) || 60 * 60 * 1000;
const LIVE_PREFLIGHT_FILE = path.join(REPO_ROOT, '.paperbot-live-spot-preflight.json');
const SPOT_ONLY_FORBIDDEN_RE = /\/sapi|\/fapi|\/dapi|withdraw|margin|leverage|borrow|repay|marginType|isolated|cross/i;
const SPOT_ONLY_ALLOWED = new Set([
  'GET /v3/account',
  'POST /v3/order',
  'GET /v3/exchangeInfo',
  'GET /v3/ticker/price',
]);

// --live-preflight is a one-shot live readiness check. It must be parsed BEFORE
// session validation and before the main loop: it never requires --session, never
// sends a heartbeat, never polls worker-session, never starts a setInterval, and
// never submits an order. It only validates env gates + the live Spot account and
// exits 0 (PASS) or 1 (FAIL). It is a strict subset of preflight mode.
const isLivePreflight = process.argv.includes('--live-preflight') || process.env.WORKER_LIVE_PREFLIGHT === 'true';
const isPreflight = process.argv.includes('--preflight') || isLivePreflight || process.env.WORKER_PREFLIGHT === 'true';

// Terminal UX: after a CLEAN success (positions closed, exit 0) the worker should
// not leave the operator staring at a window that feels stuck. Default behaviour
// auto-closes; set WORKER_HOLD_TERMINAL_ON_EXIT=true to keep the window open.
const holdTerminalOnExit = process.env.WORKER_HOLD_TERMINAL_ON_EXIT === 'true';

// Per-session worker id; persisted so a restart rebinds to the same session.
const workerId = `worker_${crypto.randomBytes(4).toString('hex')}`;
const hostname = os.hostname();
const platform = `${os.platform()}-${os.arch()}`;
const startedAt = new Date().toISOString();
const WORKER_VERSION = '3.0.0';

// State file is namespaced by mode and session so testnet can never close a live
// position and live can never close a testnet position.
const stateModePrefix = workerMode === 'live_spot' ? 'live' : 'testnet';
const stateSession = sessionId ? sessionId.replace(/[^a-zA-Z0-9_-]/g, '') : 'none';
const STATE_FILE = path.join(REPO_ROOT, `.paperbot-worker-state-${stateModePrefix}-session_${stateSession}.json`);

if (!WORKER_MODES.has(workerMode)) { console.error('[ERROR] WORKER_MODE must be testnet or live_spot'); process.exit(1); }
if (!BINANCE_ENVS.has(binanceEnv)) { console.error('[ERROR] BINANCE_ENV must be testnet or live_spot'); process.exit(1); }
if ((workerMode === 'live_spot') !== (binanceEnv === 'live_spot')) {
  console.error('[ERROR] WORKER_MODE and BINANCE_ENV must match exactly for live_spot/testnet separation.');
  process.exit(1);
}
if (!controlUrl || !workerToken || !apiKey || !apiSecret) {
  console.error('[ERROR] Missing required env (BOT_CONTROL_URL, BOT_WORKER_TOKEN, BINANCE_API_KEY, BINANCE_API_SECRET).');
  process.exit(1);
}
if (!isPreflight && !sessionId) {
  console.error('[ERROR] sessionId is required. Launch with --session <id> (the START BOT button provides this).');
  process.exit(1);
}

function localhostOverride(name) {
  const o = process.env[name] || '';
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(o)) return o.replace(/\/$/, '');
  return null;
}

function getBinanceBaseUrl() {
  if (binanceEnv === 'live_spot') return BINANCE_LIVE_SPOT_BASE_URL;
  return localhostOverride('BINANCE_TESTNET_BASE_OVERRIDE') || BINANCE_TESTNET_BASE_URL;
}

const LEGACY_STATE_FILE = path.join(REPO_ROOT, `.paperbot-worker-state-session_${stateSession}.json`);

// --- State ---
let workerState = { usedKeys: [], positions: [], pendingReports: [] };
try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    workerState = { usedKeys: [], positions: [], pendingReports: [], ...loaded };
    if (!Array.isArray(workerState.usedKeys)) workerState.usedKeys = [];
    if (!Array.isArray(workerState.positions)) workerState.positions = [];
    if (!Array.isArray(workerState.pendingReports)) workerState.pendingReports = [];
  } else if (fs.existsSync(LEGACY_STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(LEGACY_STATE_FILE, 'utf8'));
    workerState = { usedKeys: [], positions: [], pendingReports: [], ...loaded };
    if (!Array.isArray(workerState.usedKeys)) workerState.usedKeys = [];
    if (!Array.isArray(workerState.positions)) workerState.positions = [];
    if (!Array.isArray(workerState.pendingReports)) workerState.pendingReports = [];
    if (workerState.positions.length > 0) {
      console.log(`[STATE] Migrating legacy state with open positions to canonical path: ${STATE_FILE}`);
      try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(workerState, null, 2));
      } catch (e) {
        console.log('[WARN] Failed to write migrated state file', e.message);
      }
    }
  }
} catch (err) {
  console.log('[WARN] Failed to load local state, starting fresh.', err.message);
}
function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(workerState, null, 2));
  } catch (err) { console.log('[ERROR] Failed to save worker state.', err.message); }
}
// Materialize the per-session state file up front so it always exists on disk
// (observability), independent of whether any order is ever placed.
if (!isPreflight && sessionId) {
  saveState();
  console.log(`[STATE] path=${STATE_FILE} openPositions=${getOpenPositions().length}`);
}
function markKeyUsed(key) {
  if (!workerState.usedKeys.includes(key)) {
    workerState.usedKeys.push(key);
    workerState.usedKeys = workerState.usedKeys.slice(-100);
    saveState();
  }
}
function isKeyUsed(key) { return workerState.usedKeys.includes(key); }
function getOpenPositions() { return workerState.positions.filter((p) => p && p.status === 'open'); }
function openPositionSummary() {
  return getOpenPositions().map((p) => ({
    symbol: p.symbol,
    baseAsset: p.baseAsset || null,
    executedQty: p.executedQty,
    orderId: p.orderId,
    sessionId: p.sessionId || sessionId,
    status: 'open',
    openedAt: p.openedAt || null,
  }));
}
function recordOpenPosition(pos) {
  workerState.positions.push(pos);
  workerState.positions = workerState.positions.slice(-50);
  saveState();
  console.log(`[STATE] saved open position ${pos.symbol} qty=${pos.executedQty}`);
}
function markPositionClosed(orderId, closeOrderId, metrics) {
  const pos = workerState.positions.find((p) => p && p.orderId === orderId && p.status === 'open');
  if (pos) {
    // Local state keeps the simple open/closed lifecycle flag; CLOSED_WITH_DUST is
    // a closed position (it no longer counts as open / no longer blocks START).
    pos.status = 'closed';
    pos.closeOrderId = closeOrderId;
    pos.closedAt = new Date().toISOString();
    if (metrics) {
      pos.closeStatus = metrics.status;
      pos.residualDust = metrics.residualDust;
      pos.realizedPnl = metrics.realizedPnl;
    }
    saveState();
  }
}

// --- Backend-driven recovery ---
// When the control plane reports open positions for this session but local state
// has none (e.g. a fresh worker reattached to an old open-position session, or
// the local state file was lost), hydrate local state from the backend so the
// worker refuses new BUY intents and can close the position on STOP/EMERGENCY.
function hydrateOpenPositionsFromBackend(backendOpen) {
  if (!Array.isArray(backendOpen) || backendOpen.length === 0) return false;
  if (getOpenPositions().length > 0) return false; // local state always wins
  let added = 0;
  for (const p of backendOpen) {
    if (!p || !p.symbol) continue;
    const symbol = String(p.symbol).toUpperCase();
    const orderId = p.orderId != null && String(p.orderId) ? String(p.orderId) : `backend_${symbol}`;
    if (workerState.positions.some((q) => q && q.orderId === orderId)) continue;
    workerState.positions.push({
      symbol,
      baseAsset: p.baseAsset || null,
      executedQty: p.executedQty != null ? String(p.executedQty) : null,
      orderId,
      sessionId,
      status: 'open',
      openedAt: p.openedAt || p.receivedAt || new Date().toISOString(),
      stepSize: p.stepSize || null, // closeAllPositions re-fetches LOT_SIZE when missing
      source: 'backend-recovered',
      testnet: p.testnet === true,
      autoMode: p.autoMode,
    });
    added++;
  }
  if (added > 0) {
    workerState.positions = workerState.positions.slice(-50);
    saveState();
    console.log(`[RECOVERY] Hydrated open position from backend (${added}) for session ${sessionId}. New BUY intents refused; STOP/EMERGENCY CLOSE will close it.`);
  }
  return added > 0;
}

// --- Utils ---
function hmacSha256(qs, secret) { return crypto.createHmac('sha256', secret).update(qs).digest('hex'); }
function stepPrecision(stepSize) {
  const step = String(stepSize || '');
  if (!step.includes('.')) return 0;
  return step.split('.')[1].replace(/0+$/, '').length;
}

// Quote asset for a Spot symbol. BTCUSDC is USDC-quoted; BTCUSDT is USDT-quoted.
// Used so sizing, balances and fee accounting never assume USDT for a USDC pair.
function quoteAssetForSymbol(symbol) {
  return String(symbol || '').toUpperCase().endsWith('USDC') ? 'USDC' : 'USDT';
}

// Market BUY sizing (pure). `quoteAmount` is the spend in the symbol's QUOTE asset
// (USDC for BTCUSDC, USDT for BTCUSDT); `price` is the base price in that same quote
// asset. Returns the base quantity floored to the LOT_SIZE step. There is no USDT
// assumption here: the quote amount and price are whatever the symbol's quote asset is.
function computeBuyQuantity(quoteAmount, price, stepSize) {
  const amt = Number(quoteAmount);
  const px = Number(price);
  const step = Number(stepSize);
  if (!(amt > 0) || !(px > 0) || !(step > 0)) return 0;
  const precision = Math.max(0, -Math.floor(Math.log10(step)));
  const stepPow = Math.pow(10, precision);
  return Math.floor((amt / px) * stepPow) / stepPow;
}

// ── Trade-result math (pure; exported for unit tests) ───────────────────────
// Average fill price. Prefer the per-fill array (price * qty weighted); fall back
// to cummulativeQuoteQty / executedQty (Binance MARKET order summary fields).
function avgPriceFromFills(fills, executedQty, cummulativeQuoteQty) {
  if (Array.isArray(fills) && fills.length) {
    let quote = 0;
    let qty = 0;
    for (const f of fills) {
      const price = Number(f && f.price);
      const fqty = Number(f && f.qty);
      if (Number.isFinite(price) && Number.isFinite(fqty) && fqty > 0) { quote += price * fqty; qty += fqty; }
    }
    if (qty > 0) return quote / qty;
  }
  const eq = Number(executedQty);
  const cq = Number(cummulativeQuoteQty);
  if (Number.isFinite(eq) && eq > 0 && Number.isFinite(cq) && cq > 0) return cq / eq;
  return null;
}

// Residual base-asset left after a close. A real testnet SELL can fill fewer base
// units than were bought (LOT_SIZE rounding, fee taken in base asset), leaving
// dust. Never negative.
function residualDustQty(boughtQty, soldQty) {
  const b = Number(boughtQty);
  const s = Number(soldQty);
  if (!Number.isFinite(b) || !Number.isFinite(s)) return 0;
  return Math.max(0, b - s);
}

// Is the leftover dust still sellable? It is only sellable when it clears BOTH the
// LOT_SIZE minQty and the MIN_NOTIONAL floors. Below either, it is permanent dust.
function isResidualSellable(residualQty, minQty, minNotional, price) {
  const r = Number(residualQty);
  if (!Number.isFinite(r) || r <= 0) return false;
  const mq = Number(minQty);
  if (Number.isFinite(mq) && mq > 0 && r < mq) return false;
  const mn = Number(minNotional);
  const px = Number(price);
  if (Number.isFinite(mn) && mn > 0 && Number.isFinite(px) && px > 0 && r * px < mn) return false;
  return true;
}

// Compute the closed-trade result from the stored open position and the SELL order
// response. realizedPnl is proceeds minus the cost basis of the *sold* portion, so
// unsold dust is never miscounted as a loss. Fees are testnet-unavailable and do
// not block the PnL display.
function computeCloseMetrics(pos, closeOrder, opts = {}) {
  const boughtQty = Number(pos && pos.executedQty) || 0;
  const soldQty = Number(closeOrder && closeOrder.executedQty) || 0;
  const entryAvgPrice = (pos && pos.entryAvgPrice != null && Number.isFinite(Number(pos.entryAvgPrice)))
    ? Number(pos.entryAvgPrice)
    : avgPriceFromFills(pos && pos.entryFills, pos && pos.executedQty, pos && pos.entryQuoteQty);
  const closeAvgPrice = avgPriceFromFills(closeOrder && closeOrder.fills, soldQty, closeOrder && closeOrder.cummulativeQuoteQty);
  const proceeds = Number(closeOrder && closeOrder.cummulativeQuoteQty);
  const proceedsUsd = Number.isFinite(proceeds) && proceeds > 0
    ? proceeds
    : (closeAvgPrice != null ? closeAvgPrice * soldQty : null);
  const costOfSold = entryAvgPrice != null ? entryAvgPrice * soldQty : Number(pos && pos.entryQuoteQty);
  let realizedPnl = null;
  let realizedPnlPct = null;
  if (proceedsUsd != null && Number.isFinite(costOfSold) && costOfSold > 0) {
    realizedPnl = proceedsUsd - costOfSold;
    realizedPnlPct = (realizedPnl / costOfSold) * 100;
  }
  const residualDust = residualDustQty(boughtQty, soldQty);
  const sellable = isResidualSellable(residualDust, opts.minQty, opts.minNotional, closeAvgPrice != null ? closeAvgPrice : entryAvgPrice);
  const status = residualDust > 0 && !sellable ? 'CLOSED_WITH_DUST' : 'closed';
  const fees = [
    ...feeSummaryFromFills(pos && pos.entryFills),
    ...feeSummaryFromFills(closeOrder && closeOrder.fills),
  ].reduce((acc, row) => {
    const found = acc.find((x) => x.asset === row.asset);
    if (found) found.amount += row.amount;
    else acc.push({ ...row });
    return acc;
  }, []);
  const quoteAsset = opts.quoteAsset || (pos && pos.quoteAsset) || (pos && pos.symbol && String(pos.symbol).endsWith('USDC') ? 'USDC' : 'USDT');
  const quoteFee = fees.find((f) => f.asset === quoteAsset);
  const netPnl = realizedPnl != null && quoteFee ? realizedPnl - quoteFee.amount : null;
  return {
    status,
    boughtQty,
    soldQty,
    residualDust,
    residualSellable: sellable,
    entryAvgPrice,
    closeAvgPrice,
    realizedPnl: realizedPnl != null ? Number(realizedPnl) : null,
    realizedPnlPct: realizedPnlPct != null ? Number(realizedPnlPct) : null,
    feesAvailable: fees.length > 0,
    fees,
    feeAsset: fees.length === 1 ? fees[0].asset : null,
    feeAmount: fees.length === 1 ? fees[0].amount : null,
    netPnl: netPnl != null ? Number(netPnl) : null,
    pnlIsNet: netPnl != null,
  };
}

// Live close planning (REAL MONEY).
//
// The BUY fee on a live Spot order is taken in the BASE asset, so the free base
// balance after a $6 BTCUSDC buy is LESS than the reported executedQty (e.g. buy
// 0.00009 BTC, fee leaves 0.00008991 free). Selling executedQty blindly fails
// with "insufficient balance". This computes the *actually sellable* quantity:
//   closeQty = floor(min(executedQty, freeBaseBalance) / stepSize) * stepSize
// and decides whether that quantity clears MIN_NOTIONAL at the current price. If
// not, the leftover is permanent dust and there is NO actionable sell — the
// caller must close-with-dust instead of retrying an impossible order.
function computeLiveClosePlan({ boughtQty, freeBase, stepSize, minNotional, price }) {
  const bought = Number(boughtQty);
  const free = Number(freeBase);
  const step = Number(stepSize) || 0;
  const mn = Number(minNotional);
  const px = Number(price);
  const cappedFree = Number.isFinite(free) && free > 0 ? free : 0;
  // Never sell more than the account actually holds free, and never more than
  // what was bought for this position.
  let sellQty = Math.min(Number.isFinite(bought) && bought > 0 ? bought : 0, cappedFree);
  if (!(sellQty > 0)) sellQty = 0;
  if (step > 0) sellQty = Math.floor(sellQty / step) * step;
  const precision = stepPrecision(stepSize);
  sellQty = Number(sellQty.toFixed(precision));
  const notional = (Number.isFinite(px) && px > 0 ? px : 0) * sellQty;
  const meetsNotional = !(Number.isFinite(mn) && mn > 0) || notional >= mn;
  const sellable = sellQty > 0 && meetsNotional;
  return {
    sellQty,
    notional,
    sellable,
    dustOnly: !sellable,
    // When unsellable, the whole free base balance is permanent dust.
    residualDust: cappedFree,
    precision,
  };
}

// Lifecycle: starting | running | paused | stopping | stopped
let currentState = 'starting';
let stopping = false;
const ackedCommands = new Set();
let heartbeatDiagnosticLogged = false;
let sessionPollDiagnosticLogged = false;
let missingSessionSince = 0;
let recovery404Logged = false;
let heartbeatTimer = null;
let pollTimer = null;
let marketSnapshotTimer = null;
let autoLoop = null;
let latestAutoControl = null;
let latestMarketSnapshot = null;
let hydratedSinceStart = false;
let lastBackendOkAt = 0;
let marketSnapshotRunning = false;
let marketSnapshotFailLogged = false;

function finishWorker(code) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (pollTimer) clearInterval(pollTimer);
  if (marketSnapshotTimer) clearInterval(marketSnapshotTimer);
  if (autoLoop) autoLoop.stop();
  heartbeatTimer = null;
  pollTimer = null;
  marketSnapshotTimer = null;
  autoLoop = null;
  process.exitCode = code;
}

export const _cleanExitState = { scheduled: false, code: null };

function scheduleCleanExit(code) {
  _cleanExitState.scheduled = true;
  _cleanExitState.code = code;
  setTimeout(() => {
    const open = getOpenPositions();
    if (open.length > 0) {
      console.log(`[CRITICAL] scheduleCleanExit aborted: ${open.length} positions still open.`);
      return;
    }
    process.exit(code);
  }, 350); // Allow logs to flush
}

// Friendly terminal close message. On a clean success the operator should never
// feel the window is "stuck" — print a plain instruction. The launcher decides
// whether to actually hold the window (WORKER_HOLD_TERMINAL_ON_EXIT), but the
// worker always prints the human-readable result line.
function terminalExitNotice(code, reason) {
  if (code === 0 && /closed/i.test(reason || '')) {
    console.log('[DONE] Trade closed successfully. You can close this window.');
    if (!holdTerminalOnExit) console.log('[DONE] (Window will not block on input — auto-close is safe after a clean close.)');
  } else if (code === 0) {
    console.log('[DONE] Worker exited cleanly. You can close this window.');
  } else {
    console.log(`[DONE] Worker exited with an error (${reason || 'see log above'}). Keep this window open for diagnostics.`);
  }
}

// --- Control plane I/O ---
async function sendHeartbeat() {
  try {
    const res = await fetch(`${controlUrl}/api/bot/worker-heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({
        workerId, sessionId, hostname, platform,
        status: currentState === 'stopped' ? 'offline' : 'online',
        startedAt, lastSeenAt: new Date().toISOString(),
        pid: process.pid, mode: workerMode, version: WORKER_VERSION,
        currentState, launchedByProtocol, realProductionOrder: isLiveSpot,
        livePreflight: isLiveSpot ? readLivePreflight() : null,
        openPositions: openPositionSummary(),
      }),
    });
    const payload = await res.json().catch(() => null);
    if (!heartbeatDiagnosticLogged) {
      console.log(`[DIAG] heartbeat endpoint attempt: HTTP ${res.status} ok=${res.ok} sessionKnown=${payload && payload.sessionKnown !== undefined ? payload.sessionKnown : 'unknown'}`);
      heartbeatDiagnosticLogged = true;
    }
    console.log(`[HEARTBEAT] sent state=${currentState} ok=${res.ok} openPositions=${getOpenPositions().length}`);
    if (!res.ok) {
      console.log(`[WARN] Heartbeat HTTP ${res.status}`);
      return { ok: false, status: res.status, is5xx: res.status >= 500, retriable: true };
    }
    return { ok: true, payload };
  } catch (err) {
    console.log(`[WARN] Heartbeat error: ${err.message}`);
    return { ok: false, status: 500, is5xx: true, retriable: true, error: err.message };
  }
}

async function fetchSession() {
  try {
    const url = `${controlUrl}/api/bot/worker-session?sessionId=${encodeURIComponent(sessionId)}&workerId=${encodeURIComponent(workerId)}`;
    const res = await fetch(url, { headers: { 'X-BOT-WORKER-TOKEN': workerToken } });
    const payload = await res.json().catch(() => null);
    if (!sessionPollDiagnosticLogged) {
      console.log(`[DIAG] worker-session poll result: HTTP ${res.status} ok=${res.ok} hasSession=${!!(payload && payload.session)} stopRequested=${payload && payload.stopRequested === true}`);
      sessionPollDiagnosticLogged = true;
    }
    console.log(`[POLL] worker-session HTTP ${res.status} hasIntent=${!!(payload && payload.intent)} stopRequested=${!!(payload && payload.stopRequested)} pauseRequested=${!!(payload && payload.pauseRequested)}`);
    if (res.status === 404) {
      if (!recovery404Logged) {
        console.log('[RECOVERY] worker-session 404; session missing from control plane.');
        recovery404Logged = true;
      } else {
        console.log('[WARN] worker-session HTTP 404');
      }
      return { ok: false, session: null, sessionMissing: true, recoveryMode: true, stopRequested: false, statusCode: 404, raw: payload, is5xx: false };
    }
    if (!res.ok) { 
      console.log(`[WARN] worker-session HTTP ${res.status}`); 
      return { ok: false, session: null, statusCode: res.status, raw: payload, is5xx: res.status >= 500 }; 
    }
    if (payload && payload.sessionMissing) {
      if (!recovery404Logged) {
        console.log('[RECOVERY] worker-session 404; session missing from control plane.');
        recovery404Logged = true;
      }
      return { ...payload, session: null, is5xx: false };
    }
    recovery404Logged = false;
    missingSessionSince = 0;
    lastBackendOkAt = Date.now();
    if (payload && payload.autoControl) {
      latestAutoControl = { ...payload.autoControl, receivedAt: lastBackendOkAt };
    }
    if (payload && payload.session) hydratedSinceStart = true;
    return { ...payload, is5xx: false };
  } catch (err) { 
    console.log(`[WARN] Session poll error: ${err.message}`); 
    return { ok: false, session: null, statusCode: 500, raw: null, is5xx: true }; 
  }
}

async function ackCommands(ids) {
  if (!ids.length) return;
  try {
    await fetch(`${controlUrl}/api/bot/worker-command-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ sessionId, workerId, commandIds: ids }),
    });
  } catch (err) { console.log(`[WARN] command ack error: ${err.message}`); }
}

async function flushPendingReports() {
  if (!workerState.pendingReports || workerState.pendingReports.length === 0) return;
  const pending = [...workerState.pendingReports];
  const stillPending = [];
  for (const req of pending) {
    try {
      const url = `${controlUrl}/api/bot/${req.endpoint}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
        body: JSON.stringify(req.body),
      });
      if (!res.ok) {
        if (res.status >= 500) {
          console.log(`[WARN] Pending report retry 5xx for ${req.endpoint}. Keeping in queue.`);
          stillPending.push(req);
        } else {
          console.log(`[WARN] Pending report retry HTTP ${res.status} for ${req.endpoint}. Dropping.`);
        }
      } else {
        console.log(`[INFO] Successfully flushed pending report to ${req.endpoint}.`);
      }
    } catch (err) {
      console.log(`[WARN] Pending report retry network error: ${err.message}. Keeping in queue.`);
      stillPending.push(req);
    }
  }
  if (workerState.pendingReports.length !== stillPending.length) {
    workerState.pendingReports = stillPending;
    saveState();
  }
}

async function queueReport(endpoint, body) {
  if (!workerState.pendingReports) workerState.pendingReports = [];
  workerState.pendingReports.push({ endpoint, body: { sessionId, workerId, ...body } });
  saveState();
}

async function reportResult(body) {
  try {
    const res = await fetch(`${controlUrl}/api/bot/execution-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ sessionId, workerId, ...body }),
    });
    if (!res.ok && res.status >= 500) {
      console.log(`[WARN] reportResult HTTP ${res.status}, queuing for retry.`);
      await queueReport('execution-result', body);
    }
  } catch (err) { 
    console.log(`[ERROR] reportResult: ${err.message}. Queuing for retry.`);
    await queueReport('execution-result', body);
  }
}

async function reportPosition(body) {
  const payload = { mode: workerMode, testnet: !isLiveSpot, realProductionOrder: isLiveSpot, ...body };
  try {
    const res = await fetch(`${controlUrl}/api/bot/position-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ sessionId, workerId, ...payload }),
    });
    if (!res.ok && res.status >= 500) {
      console.log(`[WARN] reportPosition HTTP ${res.status}, queuing for retry.`);
      await queueReport('position-result', payload);
    }
  } catch (err) { 
    console.log(`[ERROR] reportPosition: ${err.message}. Queuing for retry.`);
    await queueReport('position-result', payload);
  }
}

async function reportOpenPositions(reason) {
  const open = getOpenPositions();
  if (!open.length) return;
  console.log(`[RECOVER] Reporting ${open.length} open position(s) to backend (${reason}).`);
  for (const pos of open) {
    await reportPosition({ symbol: pos.symbol, baseAsset: pos.baseAsset, executedQty: pos.executedQty, orderId: pos.orderId, status: 'open' });
  }
}

// ── Public market snapshot (auto-trader shadow data feed) ───────────────────
// PUBLIC DATA ONLY: no API key, no signature, no order/futures/margin endpoints
// (enforced inside binance-public.mjs). Runs on its own 60s timer, fully
// fire-and-forget: any failure is swallowed and reported as diagnostics, so the
// close/stop flow is NEVER blocked or delayed by market data.
async function postAutoMarketSnapshot(payload) {
  const res = await fetch(`${controlUrl}/api/bot/auto-market-snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
    body: JSON.stringify({ workerId, sessionId, source: PUBLIC_SNAPSHOT_SOURCE, ...payload }),
  });
  return res;
}

async function fetchAndPostMarketSnapshot() {
  if (!marketSnapshotEnabled || stopping || marketSnapshotRunning) return { skipped: true };
  marketSnapshotRunning = true;
  try {
    let snapshot;
    try {
      snapshot = await fetchBinancePublicSnapshot({ baseUrl: process.env.BINANCE_BASE_URL });
    } catch (err) {
      // Fetch failed: post diagnostics only so the control plane can surface why
      // the snapshot is missing. Never throws past this function.
      if (!marketSnapshotFailLogged) {
        console.log(`[SNAPSHOT][WARN] Public market snapshot fetch failed: ${err.message}`);
        marketSnapshotFailLogged = true;
      }
      try {
        await postAutoMarketSnapshot({ fetchedAt: new Date().toISOString(), markets: [], diagnostics: { error: String(err.message || err).slice(0, 240) } });
      } catch { /* diagnostics post is best-effort */ }
      return { ok: false, error: err.message };
    }
    marketSnapshotFailLogged = false;
    latestMarketSnapshot = snapshot;
    try {
      const res = await postAutoMarketSnapshot({ fetchedAt: snapshot.fetchedAt, markets: snapshot.markets, diagnostics: snapshot.diagnostics });
      console.log(`[SNAPSHOT] Posted public market snapshot (${snapshot.markets.length} markets) ok=${res.ok}`);
      return { ok: res.ok, count: snapshot.markets.length };
    } catch (err) {
      console.log(`[SNAPSHOT][WARN] Snapshot post failed: ${err.message}`);
      return { ok: false, error: err.message };
    }
  } finally {
    marketSnapshotRunning = false;
  }
}

async function postAutoDecision(payload) {
  const res = await fetch(`${controlUrl}/api/bot/auto-decision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
    body: JSON.stringify({ workerId, sessionId, ...payload }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error((json && (json.error || json.reason)) || `auto-decision HTTP ${res.status}`);
  return json;
}

async function requestAutoIntent(payload) {
  const res = await fetch(`${controlUrl}/api/bot/auto-intent-request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
    body: JSON.stringify({ workerId, sessionId, ...payload }),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function latestSnapshotForAuto() {
  const snap = latestMarketSnapshot;
  if (!snap || !snap.fetchedAt) return null;
  const ageMs = Date.now() - new Date(snap.fetchedAt).getTime();
  return { snapshot: snap, ageMs: Number.isFinite(ageMs) ? Math.max(0, ageMs) : Infinity };
}

async function refreshSnapshotForAuto() {
  const res = await fetchAndPostMarketSnapshot();
  return res && latestMarketSnapshot ? latestMarketSnapshot : null;
}

function updateAutoPosition(pos) {
  saveState();
}

function startAutoRuntime() {
  if (autoLoop) return autoLoop;
  autoLoop = createAutoLoop({
    env: process.env,
    sessionId,
    log: (line) => console.log(line),
    getControl: () => latestAutoControl,
    isStopping: () => stopping || currentState === 'stopping' || currentState === 'stopped',
    isHydrated: () => hydratedSinceStart,
    backendHealthy: () => Date.now() - lastBackendOkAt < Math.max(45000, pollIntervalMs * 4),
    getOpenPositions,
    getSnapshot: latestSnapshotForAuto,
    refreshSnapshot: refreshSnapshotForAuto,
    getPrice: async (symbol) => getTickerPrice(symbol),
    updatePosition: updateAutoPosition,
    postDecision: postAutoDecision,
    requestIntent: requestAutoIntent,
    evalIntervalMs: Number(process.env.AUTO_EVAL_INTERVAL_MS) || undefined,
  });
  autoLoop.start();
  return autoLoop;
}

function liveEnvGateSnapshot() {
  return {
    workerMode,
    binanceEnv,
    liveTradingEnabled: process.env.BOT_LIVE_TRADING_ENABLED === 'true',
    allowRealOrders: process.env.BOT_ALLOW_REAL_ORDERS === 'true',
    liveSpotAck: process.env.LIVE_SPOT_ACK === LIVE_SPOT_ACK_TEXT,
    localConfirm: process.env.LOCAL_WORKER_LIVE_CONFIRM === 'true',
    globalKillSwitch: process.env.BOT_GLOBAL_KILL_SWITCH === 'true',
  };
}

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function liveMaxDailyTradesHardCap() {
  return positiveIntegerEnv('LIVE_MAX_DAILY_TRADES_HARD_CAP', LIVE_PREFLIGHT_DEFAULT_MAX_DAILY_TRADES_HARD_CAP);
}

function liveRiskCaps(config = null) {
  const maxSymbols = Number(process.env.LIVE_MAX_SYMBOLS) > 0 ? Math.floor(Number(process.env.LIVE_MAX_SYMBOLS)) : 1;
  const allowed = String(process.env.LIVE_ALLOWED_SYMBOLS || 'BTCUSDT')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, maxSymbols);
  const maxDailyTradesHardCap = liveMaxDailyTradesHardCap();
  const configuredMaxDailyTrades = Number(config && config.maxDailyTrades);
  const rawMaxDailyTrades = process.env.LIVE_MAX_DAILY_TRADES;
  const maxDailyTrades = Number.isInteger(configuredMaxDailyTrades) && configuredMaxDailyTrades > 0
    ? Math.min(configuredMaxDailyTrades, maxDailyTradesHardCap)
    : rawMaxDailyTrades === undefined || rawMaxDailyTrades === null || rawMaxDailyTrades === ''
      ? 3
      : Number(rawMaxDailyTrades);
  return {
    maxPositionUsd: Number(process.env.LIVE_MAX_POSITION_USD) > 0 ? Number(process.env.LIVE_MAX_POSITION_USD) : 10,
    maxDailyLossUsd: Number(process.env.LIVE_MAX_DAILY_LOSS_USD) > 0 ? Number(process.env.LIVE_MAX_DAILY_LOSS_USD) : 5,
    maxDailyTrades,
    maxDailyTradesHardCap,
    maxOpenPositions: Number(process.env.LIVE_MAX_OPEN_POSITIONS) > 0 ? Math.floor(Number(process.env.LIVE_MAX_OPEN_POSITIONS)) : 1,
    maxSymbols,
    allowedSymbols: allowed.length ? allowed : ['BTCUSDT'],
    allowMarketBuy: process.env.LIVE_ALLOW_MARKET_BUY !== 'false',
    allowMarketSell: process.env.LIVE_ALLOW_MARKET_SELL !== 'false',
    allowLimitOrders: process.env.LIVE_ALLOW_LIMIT_ORDERS === 'true',
  };
}

function readLivePreflight() {
  if (!fs.existsSync(LIVE_PREFLIGHT_FILE)) return { ok: false, reason: 'live preflight has not been run' };
  try {
    const data = JSON.parse(fs.readFileSync(LIVE_PREFLIGHT_FILE, 'utf8'));
    const at = new Date(data.checkedAt || 0).getTime();
    if (!data.ok) return { ok: false, reason: 'live preflight failed' };
    if (!Number.isFinite(at) || Date.now() - at > LIVE_PREFLIGHT_MAX_AGE_MS) return { ok: false, reason: 'live preflight is stale' };
    return { ok: true, checkedAt: data.checkedAt, accountType: data.accountType || null };
  } catch (err) {
    return { ok: false, reason: `live preflight marker unreadable: ${err.message}` };
  }
}

function dailyLiveStats() {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  let trades = 0;
  let realizedLoss = 0;
  for (const p of workerState.positions || []) {
    const closedAt = new Date(p.closedAt || 0).getTime();
    if (!Number.isFinite(closedAt) || closedAt < start.getTime()) continue;
    if (p.status === 'closed') trades++;
    const pnl = Number(p.realizedPnl);
    if (Number.isFinite(pnl) && pnl < 0) realizedLoss += Math.abs(pnl);
  }
  return { trades, realizedLoss };
}

function assertSpotOnlyRequest(method, url, params = {}) {
  const m = String(method || 'GET').toUpperCase();
  const raw = String(url || '');
  let parsed;
  try { parsed = new URL(raw, getBinanceBaseUrl()); } catch { throw new Error('SPOT_ONLY_BLOCKED: invalid Binance URL'); }
  const pathName = parsed.pathname.replace(/^\/api(?=\/v3\/)/, '');
  const haystack = [
    parsed.pathname,
    parsed.search,
    ...Object.keys(params || {}),
    ...Object.values(params || {}).map((v) => String(v)),
  ].join(' ');
  if (SPOT_ONLY_FORBIDDEN_RE.test(haystack)) {
    throw new Error(`SPOT_ONLY_BLOCKED: forbidden Binance endpoint or parameter (${pathName})`);
  }
  const key = `${m} ${pathName}`;
  if (!SPOT_ONLY_ALLOWED.has(key)) {
    throw new Error(`SPOT_ONLY_BLOCKED: ${key} is not in the Spot-only allowlist`);
  }
  if (binanceEnv === 'live_spot' && parsed.origin + '/api' !== BINANCE_LIVE_SPOT_BASE_URL) {
    throw new Error('SPOT_ONLY_BLOCKED: live_spot base URL must be exactly https://api.binance.com/api');
  }
  return true;
}

async function binanceFetch(pathName, { method = 'GET', params = {}, signed = false } = {}) {
  const base = getBinanceBaseUrl();
  const qp = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null) qp.append(key, String(value));
  }
  if (signed) {
    qp.append('timestamp', Date.now().toString());
    qp.append('recvWindow', '5000');
  }
  const qsBeforeSig = qp.toString();
  if (signed) qp.append('signature', hmacSha256(qsBeforeSig, apiSecret));
  const url = `${base}${pathName}${qp.toString() ? `?${qp.toString()}` : ''}`;
  assertSpotOnlyRequest(method, url, params);
  const headers = { Accept: 'application/json' };
  if (signed) headers['X-MBX-APIKEY'] = apiKey;
  if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  const res = await fetch(url, { method, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance error: ${data.msg || JSON.stringify(data)}`);
  return data;
}

function feeSummaryFromFills(fills) {
  const byAsset = {};
  if (Array.isArray(fills)) {
    for (const f of fills) {
      const asset = f && f.commissionAsset ? String(f.commissionAsset).toUpperCase() : '';
      const amount = Number(f && f.commission);
      if (!asset || !Number.isFinite(amount) || amount <= 0) continue;
      byAsset[asset] = (byAsset[asset] || 0) + amount;
    }
  }
  return Object.entries(byAsset).map(([asset, amount]) => ({ asset, amount }));
}

// --- Binance Spot adapter ---
async function submitMarketOrder(symbol, side, quantity, precision) {
  const caps = liveRiskCaps();
  if (isLiveSpot && side === 'BUY' && !caps.allowMarketBuy) throw new Error('Live MARKET BUY is disabled');
  if (isLiveSpot && side === 'SELL' && !caps.allowMarketSell) throw new Error('Live MARKET SELL is disabled');
  return await binanceFetch('/v3/order', {
    method: 'POST',
    signed: true,
    params: {
      symbol,
      side,
      type: 'MARKET',
      quantity: Number(quantity).toFixed(precision),
    },
  });
}
async function getSymbolInfo(symbol) {
  const data = await binanceFetch('/v3/exchangeInfo', { params: { symbol } });
  if (!data || !data.symbols || !data.symbols[0]) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
  return data.symbols[0];
}

async function getTickerPrice(symbol) {
  const data = await binanceFetch('/v3/ticker/price', { params: { symbol } });
  if (!data || !data.price) throw new Error('Failed to fetch ticker price');
  return parseFloat(data.price);
}

// Read the ACTUAL free balance of any asset from the live account. Used before a
// live close (base asset) so we never sell more than the account holds, and before
// a live BUY (quote asset) so we never submit an order the account cannot fund.
async function getFreeAssetBalance(asset) {
  const data = await binanceFetch('/v3/account', { signed: true });
  const bal = (data && Array.isArray(data.balances) ? data.balances : []).find((b) => b && b.asset === asset);
  const free = bal ? Number(bal.free) : 0;
  return Number.isFinite(free) && free > 0 ? free : 0;
}
// Base-asset balance for the live close path (the BUY fee is taken in base asset,
// leaving free < executedQty).
async function getFreeBaseBalance(baseAsset) {
  return getFreeAssetBalance(baseAsset);
}

// Deterministic close errors that must NOT trigger the retry loop: the same SELL
// will keep failing. Insufficient balance (fee ate the base) and minNotional are
// resolved by reconciling against the account and closing-with-dust instead.
function isDeterministicCloseError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('insufficient balance')
    || msg.includes('insufficient_balance')
    || msg.includes('min_notional')
    || msg.includes('minnotional')
    || msg.includes('notional');
}

function validateLiveIntentGate(intent, config, riskState, session, control) {
  const env = liveEnvGateSnapshot();
  const caps = liveRiskCaps(config);
  const preflight = readLivePreflight();
  const posUsd = Number(intent && intent.positionUsd);
  const userMax = Number(config && config.maxTradeUsd);
  const maxUsd = Math.min(Number.isFinite(userMax) && userMax > 0 ? userMax : caps.maxPositionUsd, caps.maxPositionUsd);
  const stats = dailyLiveStats();
  const checks = [
    { ok: workerMode === 'live_spot', reason: 'WORKER_MODE must be live_spot' },
    { ok: binanceEnv === 'live_spot', reason: 'BINANCE_ENV must be live_spot' },
    { ok: env.liveTradingEnabled, reason: 'BOT_LIVE_TRADING_ENABLED must be true' },
    { ok: env.allowRealOrders, reason: 'BOT_ALLOW_REAL_ORDERS must be true' },
    { ok: env.liveSpotAck, reason: 'LIVE_SPOT_ACK is missing or incorrect' },
    { ok: env.localConfirm, reason: 'LOCAL_WORKER_LIVE_CONFIRM must be true' },
    { ok: !env.globalKillSwitch, reason: 'BOT_GLOBAL_KILL_SWITCH active: entries blocked' },
    { ok: preflight.ok, reason: preflight.reason || 'live preflight failed' },
    { ok: control && control.durable === true, reason: 'durable store is required for live entries' },
    { ok: config && config.allowLive === true, reason: 'user config allowLive must be true' },
    { ok: session && session.liveModeConfirmed === true, reason: 'per-session liveModeConfirmed must be true' },
    { ok: intent && intent.mode === 'live_spot', reason: 'intent mode must be live_spot' },
    { ok: caps.allowedSymbols.includes(String(intent && intent.symbol || '').toUpperCase()), reason: 'symbol is not allowlisted for live Spot' },
    { ok: intent && intent.side === 'BUY' && intent.type === 'MARKET', reason: 'live entries support BUY MARKET only' },
    { ok: posUsd > 0 && posUsd <= maxUsd, reason: `positionUsd ${posUsd} exceeds live cap ${maxUsd}` },
    { ok: getOpenPositions().length < caps.maxOpenPositions, reason: `max open live positions (${caps.maxOpenPositions}) reached` },
    { ok: !(riskState && (riskState.regime === 'CRASH' || riskState.entriesAllowed === false) && config && config.pauseOnMarketCrash), reason: 'entries blocked by market regime (CRASH)' },
    { ok: stats.realizedLoss < caps.maxDailyLossUsd, reason: `daily realized loss cap reached (${stats.realizedLoss}/${caps.maxDailyLossUsd})` },
    { ok: stats.trades < caps.maxDailyTrades, reason: `daily trade cap reached (${stats.trades}/${caps.maxDailyTrades})` },
  ];
  const failed = checks.find((check) => !check.ok);
  return failed ? { ok: false, reason: failed.reason, caps, preflight } : { ok: true, caps, preflight, maxUsd };
}

// --- Intent execution (BUY MARKET only), gated by config snapshot ---
async function executeIntent(intent, config, riskState, session = null, control = {}) {
  if (isKeyUsed(intent.idempotencyKey)) return;

  // ── Worker-side hard validation (defense in depth) ──
  const reject = async (reason) => {
    console.log(`[GATE] Intent ${intent.id} rejected: ${reason}`);
    await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: reason, mode: workerMode, testnet: !isLiveSpot, realProductionOrder: isLiveSpot });
    markKeyUsed(intent.idempotencyKey);
  };
  if (isLiveSpot) {
    if (intent.mode !== 'testnet') {
      const gate = validateLiveIntentGate(intent, config, riskState, session, control);
      if (!gate.ok) return reject(`LIVE LOCKED: ${gate.reason}`);
    }
  } else if (intent.mode !== 'testnet') {
    return reject('Intent mode is not testnet');
  }
  if (intent.side !== 'BUY' || intent.type !== 'MARKET') return reject('Only BUY MARKET supported');
  if (!/^[A-Z0-9]+(USDT|USDC)$/.test(intent.symbol)) return reject('Invalid symbol format');
  const posUsd = Number(intent.positionUsd);
  const minUsd = Number(config && config.minTradeUsd) || 1;
  const maxUsd = isLiveSpot
    ? Math.min(Number(config && config.maxTradeUsd) || liveRiskCaps().maxPositionUsd, liveRiskCaps().maxPositionUsd)
    : Math.min(Number(config && config.maxTradeUsd) || TESTNET_MAX_TRADE_USD, TESTNET_MAX_TRADE_USD, maxPositionUsd);
  if (!(posUsd >= minUsd && posUsd <= maxUsd)) return reject(`positionUsd ${posUsd} outside config bounds [${minUsd}, ${maxUsd}]`);
  const maxOpen = Number(config && config.maxOpenPositions) || 1;
  if (getOpenPositions().length >= maxOpen) return reject(`max open positions (${maxOpen}) reached`);
  if (riskState && riskState.entriesAllowed === false && config && config.pauseOnMarketCrash) {
    return reject('entries blocked by market regime (CRASH)');
  }

  try {
    const symbolInfo = await getSymbolInfo(intent.symbol);
    const lot = symbolInfo.filters.find((f) => f.filterType === 'LOT_SIZE');
    if (!lot) throw new Error('LOT_SIZE filter not found');
    const stepSize = parseFloat(lot.stepSize);

    const price = await getTickerPrice(intent.symbol);

    // posUsd is the spend in the symbol's quote asset (USDC for BTCUSDC, USDT for
    // BTCUSDT). Size against that quote amount; never assume USDT.
    const quoteAsset = quoteAssetForSymbol(intent.symbol);
    const precision = Math.max(0, -Math.floor(Math.log10(stepSize)));
    const qty = computeBuyQuantity(posUsd, price, stepSize);

    const notional = symbolInfo.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    if (notional) {
      const minNotional = parseFloat(notional.minNotional);
      if (qty * price < minNotional) throw new Error(`Order size ${qty * price} < minNotional ${minNotional}`);
    }

    // LIVE: independently re-check the ACTUAL free quote balance against the spend
    // before submitting a real order (spec 3). The control plane already rejected on
    // its preflight snapshot, but the worker is the source of truth at order time and
    // must never submit a BUY the account cannot fund. Reject cleanly, no order.
    if (isLiveSpot) {
      const freeQuote = await getFreeAssetBalance(quoteAsset);
      if (!(freeQuote >= posUsd)) {
        await reject(`Insufficient ${quoteAsset} balance. Required ${posUsd}, available ${freeQuote}.`);
        return;
      }
    }

    const modeLabel = isLiveSpot && intent.mode !== 'testnet' ? 'LIVE SPOT REAL MONEY' : 'TESTNET SIMULATION';
    console.log(`[ORDER] Submitting ${modeLabel} BUY MARKET ${qty} ${intent.symbol} (session ${sessionId.slice(0, 12)})`);
    
    let order;
    if (isLiveSpot && intent.mode === 'testnet') {
      const simExecQty = qty.toFixed(precision);
      const simQuoteQty = (qty * price).toFixed(6);
      order = {
        orderId: `paper-buy-${Date.now()}`,
        status: 'FILLED',
        executedQty: simExecQty,
        cummulativeQuoteQty: simQuoteQty,
        fills: [{ price: price.toFixed(6), qty: simExecQty, commission: '0', commissionAsset: 'BNB' }]
      };
      // small sleep to simulate network
      await new Promise(r => setTimeout(r, 100));
    } else {
      order = await submitMarketOrder(intent.symbol, 'BUY', qty, precision);
    }
    console.log(`[ORDER] Order successful. OrderID: ${order.orderId} status=${order.status} executedQty=${order.executedQty}`);

    // Capture entry economics now so the eventual close can compute realized PnL
    // (entry avg price + cost basis) without re-querying Binance.
    const entryAvgPrice = avgPriceFromFills(order.fills, order.executedQty, order.cummulativeQuoteQty);

    // PERSIST FIRST: write the open position to local state BEFORE reporting to
    // the backend, so a crash between order and report can be recovered locally.
    recordOpenPosition({
      mode: workerMode, testnet: intent.mode === 'testnet', symbol: intent.symbol, baseAsset: symbolInfo.baseAsset, quoteAsset, executedQty: order.executedQty,
      orderId: order.orderId, sessionId, status: 'open', openedAt: new Date().toISOString(), stepSize: lot.stepSize,
      entryQuoteQty: order.cummulativeQuoteQty != null ? String(order.cummulativeQuoteQty) : null,
      entryAvgPrice: entryAvgPrice != null ? entryAvgPrice : null,
      entryFills: Array.isArray(order.fills) ? order.fills : null,
      minQty: lot.minQty != null ? String(lot.minQty) : null,
      minNotional: (() => { const n = symbolInfo.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL'); return n && n.minNotional != null ? String(n.minNotional) : null; })(),
      intentSource: intent.intentSource || intent.source,
      autoMode: intent.autoMode,
      autoStrategyVersion: intent.autoStrategyVersion,
      autoDecisionId: intent.autoDecisionId,
      autoIdempotencyKey: intent.autoIdempotencyKey,
    });
    console.log(`[POSITION] Open position persisted locally before backend report: ${intent.symbol} order ${order.orderId} -> ${STATE_FILE}`);

    await reportResult({
      id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'submitted', exchange: 'binance_spot_testnet',
      symbol: intent.symbol, orderId: order.orderId, orderStatus: order.status, executedQty: order.executedQty,
      cummulativeQuoteQty: order.cummulativeQuoteQty, mode: workerMode, testnet: intent.mode === 'testnet', realProductionOrder: isLiveSpot && intent.mode !== 'testnet',
    });
    await reportPosition({ symbol: intent.symbol, baseAsset: symbolInfo.baseAsset, executedQty: order.executedQty, orderId: order.orderId, status: 'open', openedAt: new Date().toISOString(), entryAvgPrice: entryAvgPrice != null ? entryAvgPrice : null, intentSource: intent.intentSource || intent.source, autoMode: intent.autoMode, autoStrategyVersion: intent.autoStrategyVersion, autoDecisionId: intent.autoDecisionId, autoIdempotencyKey: intent.autoIdempotencyKey });
    console.log(`[POSITION] Reported OPEN ${intent.symbol} to backend.`);
    markKeyUsed(intent.idempotencyKey);
    console.log(`[IDLE] Position open for ${intent.symbol}. Holding and refusing new BUY intents until it is closed (STOP/EMERGENCY closes it).`);
  } catch (err) {
    console.log(`[ERROR] Execution failed for ${intent.id}: ${err.message}`);
    await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: err.message, mode: workerMode, testnet: !isLiveSpot, realProductionOrder: isLiveSpot });
    markKeyUsed(intent.idempotencyKey);
  }
}

// --- Close positions ---
// Returns true if all currently-open positions are closed.
async function closeAllPositions(context) {
  const open = getOpenPositions();
  if (open.length === 0) return true;
  let allClosed = true;
  for (const pos of open) {
    try {
      let stepSize = pos.stepSize;
      let minQty = pos.minQty;
      let minNotional = pos.minNotional;
      let baseAsset = pos.baseAsset;
      // Hit the network when we lack the lot step OR (for live) any dust threshold
      // / base asset needed to size the close safely. Capture all of them at once.
      if (!stepSize || (isLiveSpot && (minNotional == null || !baseAsset))) {
        const info = await getSymbolInfo(pos.symbol);
        const lot = info.filters.find((f) => f.filterType === 'LOT_SIZE');
        if (!stepSize) stepSize = lot ? lot.stepSize : '0.00000001';
        if (minQty == null && lot) minQty = lot.minQty;
        if (minNotional == null) {
          const n = info.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
          if (n) minNotional = n.minNotional;
        }
        if (!baseAsset) baseAsset = info.baseAsset;
      }
      let precision = stepPrecision(stepSize);
      const stepNum = parseFloat(stepSize) || 0;
      let sellQty = parseFloat(pos.executedQty);

      if (isLiveSpot && !pos.testnet) {
        // LIVE: never sell executedQty blindly. Read the ACTUAL free base balance
        // (the BUY fee is taken in base asset) and only sell what is held and
        // clears minNotional after LOT_SIZE rounding.
        const freeBase = await getFreeBaseBalance(baseAsset);
        const price = await getTickerPrice(pos.symbol);
        const plan = computeLiveClosePlan({ boughtQty: pos.executedQty, freeBase, stepSize, minNotional, price });
        if (plan.dustOnly) {
          // Deterministic: nothing sellable. Close-with-dust, no SELL, no retry.
          await closeLivePositionAsDust(context, pos, { freeBase, price, minNotional, quoteAsset: pos.quoteAsset || quoteAssetForSymbol(pos.symbol) });
          continue;
        }
        sellQty = plan.sellQty;
        precision = plan.precision;
      } else {
        if (stepNum > 0) sellQty = Math.floor(sellQty / stepNum) * stepNum;
        if (!(sellQty > 0)) throw new Error(`Computed sell qty not positive for ${pos.symbol}`);
      }

      const modeLabel = isLiveSpot && !pos.testnet ? 'LIVE SPOT REAL MONEY' : 'TESTNET SIMULATION';
      console.log(`[${context}][CLOSE] Submitting ${modeLabel} SELL MARKET ${sellQty} ${pos.symbol} (close of order ${pos.orderId})...`);
      
      let close;
      if (isLiveSpot && pos.testnet) {
        const price = await getTickerPrice(pos.symbol);
        close = {
          orderId: `paper-close-${Date.now()}`,
          status: 'FILLED',
          executedQty: sellQty.toFixed(precision),
          cummulativeQuoteQty: (sellQty * price).toFixed(6),
          fills: [{ price: price.toFixed(6), qty: sellQty.toFixed(precision), commission: '0', commissionAsset: 'BNB' }]
        };
        await new Promise(r => setTimeout(r, 100));
      } else {
        close = await submitMarketOrder(pos.symbol, 'SELL', sellQty, precision);
      }
      console.log(`[${context}][CLOSE] Close result OK. ${pos.symbol} CloseOrderID: ${close.orderId} executedQty=${close.executedQty}`);

      // Compute the realized trade result (avg prices, PnL, residual dust) so the
      // operator sees a clean trade-result card instead of raw order JSON. When the
      // exchange minQty is unknown, the lot stepSize is the dust floor: a remainder
      // smaller than one step is never independently sellable.
      const quoteAsset = pos.quoteAsset || quoteAssetForSymbol(pos.symbol);
      const metrics = computeCloseMetrics(pos, close, { minQty: minQty != null ? minQty : stepSize, minNotional, quoteAsset });
      const closedAt = new Date().toISOString();
      markPositionClosed(pos.orderId, close.orderId, metrics);
      const pnlLog = metrics.realizedPnl != null ? `${metrics.realizedPnl >= 0 ? '+' : ''}${metrics.realizedPnl.toFixed(4)} (${metrics.realizedPnlPct != null ? metrics.realizedPnlPct.toFixed(2) : '—'}%)` : 'n/a';
      console.log(`[${context}][CLOSE] Result ${metrics.status} ${pos.symbol}: bought=${metrics.boughtQty} sold=${metrics.soldQty} dust=${metrics.residualDust} pnl=${pnlLog}`);
      await reportPosition({
        symbol: pos.symbol, baseAsset: pos.baseAsset, executedQty: close.executedQty,
        orderId: pos.orderId, closeOrderId: close.orderId, status: metrics.status,
        entryOrderId: pos.orderId, openedAt: pos.openedAt || null, closedAt,
        entryAvgPrice: metrics.entryAvgPrice, closeAvgPrice: metrics.closeAvgPrice,
        boughtQty: metrics.boughtQty, soldQty: metrics.soldQty, residualDust: metrics.residualDust,
        realizedPnl: metrics.realizedPnl, realizedPnlPct: metrics.realizedPnlPct,
        feesAvailable: metrics.feesAvailable, fees: metrics.fees, feeAsset: metrics.feeAsset,
        feeAmount: metrics.feeAmount, netPnl: metrics.netPnl, pnlIsNet: metrics.pnlIsNet,
        intentSource: pos.intentSource || pos.source,
        autoMode: pos.autoMode,
        autoStrategyVersion: pos.autoStrategyVersion,
        autoDecisionId: pos.autoDecisionId,
        autoIdempotencyKey: pos.autoIdempotencyKey,
      });
      console.log(`[${context}][CLOSE] Reported ${metrics.status} ${pos.symbol} to backend.`);
    } catch (err) {
      // Deterministic live close failures (fee-reduced balance / minNotional) must
      // NOT spin the retry loop with the same impossible SELL. Reconcile against the
      // account: if only unsellable dust remains, close-with-dust and move on.
      if (isLiveSpot && isDeterministicCloseError(err)) {
        try {
          const info = await getSymbolInfo(pos.symbol);
          const lot = info.filters.find((f) => f.filterType === 'LOT_SIZE');
          const notionalFilter = info.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
          const stepSize = pos.stepSize || (lot ? lot.stepSize : '0.00000001');
          const minNotional = pos.minNotional != null ? pos.minNotional : (notionalFilter ? notionalFilter.minNotional : null);
          const baseAsset = pos.baseAsset || info.baseAsset;
          const freeBase = await getFreeBaseBalance(baseAsset);
          const price = await getTickerPrice(pos.symbol);
          const plan = computeLiveClosePlan({ boughtQty: pos.executedQty, freeBase, stepSize, minNotional, price });
          if (plan.dustOnly) {
            console.log(`[${context}][CLOSE] Deterministic close error "${err.message}"; reconciled to unsellable dust (free ${freeBase}). Closing with dust, no retry.`);
            await closeLivePositionAsDust(context, pos, { freeBase, price, minNotional, quoteAsset: pos.quoteAsset || quoteAssetForSymbol(pos.symbol) });
            continue;
          }
        } catch (recErr) {
          console.log(`[${context}][CLOSE] Reconciliation after close error failed: ${recErr.message}.`);
        }
      }
      allClosed = false;
      console.log(`[${context}][ERROR] Close result FAILED for ${pos.symbol}: ${err.message}. Worker stays alive; position remains open.`);
      await reportPosition({ symbol: pos.symbol, baseAsset: pos.baseAsset, executedQty: pos.executedQty, orderId: pos.orderId, status: 'WORKER_CLOSE_FAILED', error: err.message });
    }
  }
  return allClosed;
}

// Close a live position that has only unsellable dust left (notional < minNotional
// after flooring the actual free balance). No SELL is placed; the position is
// recorded CLOSED_WITH_DUST so openPositions drops to 0, the closed-trade ledger
// keeps the residual dust, and STOP/EMERGENCY can exit 0 (nothing actionable).
async function closeLivePositionAsDust(context, pos, opts) {
  const { freeBase, price, minNotional, quoteAsset } = opts;
  const closedAt = new Date().toISOString();
  const dust = Number(freeBase) || 0;
  const notional = (Number(price) || 0) * dust;
  const entryAvgPrice = (pos.entryAvgPrice != null && Number.isFinite(Number(pos.entryAvgPrice))) ? Number(pos.entryAvgPrice) : null;
  console.log(`[${context}][CLOSE][DUST] ${pos.symbol}: free ${dust} ${pos.baseAsset || ''} (~${notional.toFixed(2)} ${quoteAsset}) < minNotional ${minNotional}. No sellable quantity — marking CLOSED_WITH_DUST without a SELL.`);
  markPositionClosed(pos.orderId, null, { status: 'CLOSED_WITH_DUST', residualDust: dust, realizedPnl: null });
  await reportPosition({
    symbol: pos.symbol, baseAsset: pos.baseAsset, executedQty: '0',
    orderId: pos.orderId, closeOrderId: null, status: 'CLOSED_WITH_DUST',
    entryOrderId: pos.orderId, openedAt: pos.openedAt || null, closedAt,
    entryAvgPrice, closeAvgPrice: null,
    boughtQty: Number(pos.executedQty) || 0, soldQty: 0, residualDust: dust,
    realizedPnl: null, realizedPnlPct: null,
    feesAvailable: false, fees: [], feeAsset: null, feeAmount: null, netPnl: null, pnlIsNet: false,
    closeReason: 'DUST_ONLY_CLOSE_NOT_POSSIBLE',
    intentSource: pos.intentSource || pos.source,
    autoMode: pos.autoMode,
    autoStrategyVersion: pos.autoStrategyVersion,
    autoDecisionId: pos.autoDecisionId,
    autoIdempotencyKey: pos.autoIdempotencyKey,
  });
  console.log(`[${context}][CLOSE][DUST] Reported CLOSED_WITH_DUST (dust ${dust}) — LIVE_POSITION_DUSTED. openPositions now ${getOpenPositions().length}.`);
}

async function emergencyReconcileAndClose() {
  if (isLiveSpot) {
    console.log('[RECONCILE] Live spot reconciliation not automated for safety.');
    return;
  }
  try {
    const symbol = 'BTCUSDT';
    console.log(`[RECONCILE] Attempting fallback account reconciliation for ${symbol}`);
    const data = await binanceFetch('/v3/account', { signed: true });
    const btcBalance = data.balances.find((b) => b.asset === 'BTC');
    if (!btcBalance) return;
    const freeBtc = Number(btcBalance.free);
    if (!(freeBtc > 0)) return;

    // Must not sell whole BTC balance, only min(accountFreeBtc, sessionExpectedQty) for session-bound order.
    // If no session-bound expected qty is known locally, we must not auto-sell arbitrary BTC.
    // However, if the control plane explicitly sent 'emergencyCloseRequested', the user pressed Emergency Close.
    // Since the original original state might be completely lost, we ask the user to clear it manually or wait.
    console.log('[RECONCILE][CRITICAL] Account holds BTC but no local session-bound quantity is known. Auto-sell of arbitrary BTC is UNSAFE.');
    await reportResult({ error: 'WORKER_RECONCILIATION_REQUIRED', message: `Worker holds ${freeBtc} BTC but lacks session-bound order size. Please manually sell dust or clear kill switch.` });
  } catch (err) {
    console.log(`[RECONCILE] Error: ${err.message}`);
  }
}

// --- Graceful STOP: close positions, then exit. Never exit with open positions. ---
async function runStopSequence(data) {
  if (stopping) return;

  // Final check: if backend thinks we have open positions but local state is 0, hydrate them!
  if (data && Array.isArray(data.openPositions) && data.openPositions.length > 0 && getOpenPositions().length === 0) {
    console.log('[STOP] Backend reports open positions but local state is empty. Hydrating before close.');
    hydrateOpenPositionsFromBackend(data.openPositions);
  }

  // If local is still 0 but backend reports open, hydration failed or backend is out of sync.
  if (data && Array.isArray(data.openPositions) && data.openPositions.length > 0 && getOpenPositions().length === 0) {
    console.log('[STOP][CRITICAL] Backend reports open positions but local hydration failed. Worker will NOT exit with 0 closures.');
    await reportResult({ error: 'WORKER_RECOVERY_REQUIRED', message: 'Backend has open positions but worker failed to hydrate.' });
    return; // Stay alive
  }

  stopping = true;
  currentState = 'stopping';
  console.log(`[STOP] Stop requested. Closing ${getOpenPositions().length} open ${isLiveSpot ? 'LIVE SPOT (REAL MONEY)' : 'testnet'} position(s) via MARKET SELL before exit.`);
  await sendHeartbeat();
  let retries = 0;
  while (true) {
    const allClosed = await closeAllPositions('STOP');
    if (allClosed) {
      currentState = 'stopped';
      console.log('[STOP] All positions closed. [EXIT] reason=stop_requested_all_closed code=0. Worker exiting.');
      await sendHeartbeat();
      terminalExitNotice(0, 'stop_requested_all_closed');
      finishWorker(0);
      scheduleCleanExit(0);
      return;
    }
    retries++;
    if (retries >= MAX_CLOSE_RETRIES) {
      console.log(`[STOP][CRITICAL] CLOSE FAILED after ${retries} retries. Worker will NOT exit with open positions. Manual attention required.`);
      await sendHeartbeat();
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      retries = 0;
    } else {
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}

// --- Process command queue ---
async function processCommands(commands) {
  if (!Array.isArray(commands) || !commands.length) return;
  const toAck = [];
  for (const cmd of commands) {
    if (!cmd || !cmd.id || ackedCommands.has(cmd.id)) continue;
    console.log(`[CMD] ${cmd.type} (${cmd.id})`);
    if (cmd.type === 'EMERGENCY_CLOSE') {
      if (getOpenPositions().length === 0) {
        await emergencyReconcileAndClose();
      } else {
        await closeAllPositions('EMERGENCY');
      }
    }
    // STOP/PAUSE/RESUME are also reflected via session flags; ack so they don't repeat.
    ackedCommands.add(cmd.id);
    toAck.push(cmd.id);
  }
  await ackCommands(toAck);
}

async function handleMissingSession(data) {
  if (data && data.is5xx) {
    console.log(`[POLL] Transient 5xx error (${data.statusCode}). Keeping worker alive...`);
    return;
  }
  const open = getOpenPositions();
  if (data && data.stopRequested) return runStopSequence(data);
  if (open.length > 0) {
    currentState = 'running';
    console.log(`[RECOVERY] Continuing after open position; session missing from control plane. openPositions=${open.length}`);
    await reportOpenPositions('missing-session');
    await sendHeartbeat();
    return;
  }
  if (!missingSessionSince) {
    missingSessionSince = Date.now();
    console.log(`[RECOVERY] worker-session missing without local open positions; retrying for ${Math.round(MISSING_SESSION_EXIT_MS / 1000)}s before clean exit.`);
    return;
  }
  if (Date.now() - missingSessionSince >= MISSING_SESSION_EXIT_MS) {
    currentState = 'stopped';
    console.log('[EXIT] reason=worker_session_missing_no_open_positions code=0. Worker exiting cleanly.');
    await sendHeartbeat();
    terminalExitNotice(0, 'worker_session_missing_no_open_positions');
    finishWorker(0);
    scheduleCleanExit(0);
    return;
  }
}

// --- Main loop ---
async function tick() {
  if (stopping) return;
  
  let heartbeatRes;
  try {
    heartbeatRes = await sendHeartbeat();
  } catch (err) {
    console.log(`[WARN] Exception in sendHeartbeat: ${err.message}`);
    heartbeatRes = { ok: false, is5xx: true };
  }

  if (heartbeatRes && heartbeatRes.is5xx && getOpenPositions().length > 0) {
    console.log(`[CONTROL][WARN] heartbeat failed HTTP ${heartbeatRes.status}; continuing because openPositions=${getOpenPositions().length}`);
  }

  try {
    await flushPendingReports();
  } catch (err) {
    console.log(`[WARN] Exception in flushPendingReports: ${err.message}`);
  }

  let data;
  try {
    data = await fetchSession();
  } catch (err) {
    console.log(`[WARN] Exception in fetchSession: ${err.message}`);
    data = { ok: false, session: null, is5xx: true, statusCode: 500 };
  }
  
  // Backend-driven recovery: hydrate before any session/null branching so an
  // orphan open position the control plane knows about is adopted locally.
  if (data && Array.isArray(data.openPositions) && data.openPositions.length > 0 && getOpenPositions().length === 0) {
    hydrateOpenPositionsFromBackend(data.openPositions);
  }
  
  if (data && data.is5xx) {
    console.log(`[POLL] Transient 5xx error (${data.statusCode}). Keeping worker alive...`);
    return;
  }

  if (!data || !data.session) {
    return handleMissingSession(data);
  }
  const session = data.session;
  const config = data.config || {};
  const riskState = session.riskState || data.session.riskState || null;

  await processCommands(data.commands);

  // Emergency close can also arrive as a session flag (in case the command was
  // already acked/consumed). Honour it even while paused, before stop handling.
  if (data.emergencyCloseRequested === true) {
    if (getOpenPositions().length > 0) {
      console.log(`[EMERGENCY] emergencyCloseRequested set by backend; closing open ${isLiveSpot ? 'LIVE SPOT (REAL MONEY)' : 'testnet'} position(s) via MARKET SELL.`);
      await closeAllPositions('EMERGENCY');
    } else {
      await emergencyReconcileAndClose();
    }
  }

  if (session.stopRequested === true || data.stopRequested === true) {
    return runStopSequence(data);
  }

  if (session.pauseRequested === true || data.pauseRequested === true) {
    currentState = 'paused';
    return; // no new entries while paused
  }

  currentState = 'running';

  // If we already hold an open position, stay alive and refuse new entries.
  if (getOpenPositions().length > 0) {
    if (data.intent) {
      console.log(`[IDLE] Holding open position(s); ignoring new intent ${data.intent.id} until the current position is closed.`);
    } else {
      console.log('[IDLE] Position open — heartbeat/poll continue, no new entries.');
    }
    return;
  }

  if (data.intent) {
    if (handledIntentIds.has(data.intent.id)) {
      console.log(`[INTENT][WARN] Suppressing already-handled intent ${data.intent.id}.`);
      return;
    }
    handledIntentIds.add(data.intent.id);
    console.log(`[INTENT] Claimed intent ${data.intent.id} ${data.intent.symbol} ${data.intent.side} ${data.intent.type} positionUsd=${data.intent.positionUsd}`);
    await executeIntent(data.intent, config, riskState, session, data);
  }
}

async function reportLivePreflightResult(result) {
  if (!isLiveSpot || !controlUrl || !workerToken) return;
  try {
    await fetch(`${controlUrl}/api/bot/live-preflight-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ workerId, hostname, platform, mode: 'live_spot', ...result }),
    });
  } catch (err) {
    console.log(`[PREFLIGHT] Control-plane live preflight report failed: ${err.message}`);
  }
}

async function runPreflight() {
  const livePreflight = isLiveSpot || isLivePreflight;
  const modeLabel = livePreflight ? 'Live Spot' : 'Spot Testnet';
  console.log(`[PREFLIGHT] Binance ${modeLabel} preflight...`);
  try {
    if (livePreflight) {
      const env = liveEnvGateSnapshot();
      const missing = [];
      if (env.workerMode !== 'live_spot') missing.push('WORKER_MODE=live_spot');
      if (env.binanceEnv !== 'live_spot') missing.push('BINANCE_ENV=live_spot');
      if (!env.liveTradingEnabled) missing.push('BOT_LIVE_TRADING_ENABLED=true');
      if (!env.allowRealOrders) missing.push('BOT_ALLOW_REAL_ORDERS=true');
      if (!env.liveSpotAck) missing.push(`LIVE_SPOT_ACK="${LIVE_SPOT_ACK_TEXT}"`);
      if (!env.localConfirm) missing.push('LOCAL_WORKER_LIVE_CONFIRM=true');
      if (getBinanceBaseUrl() !== BINANCE_LIVE_SPOT_BASE_URL) missing.push('live base URL mismatch');
      // Risk-cap ceilings: validate the *enforced* caps (liveRiskCaps reads the same
      // LIVE_* env that gates real orders). For the symbol allowlist, validate the
      // raw env so a longer list can't slip through the maxSymbols clamp.
      const caps = liveRiskCaps();
      const rawAllowedSymbols = String(process.env.LIVE_ALLOWED_SYMBOLS || LIVE_PREFLIGHT_ALLOWED_SYMBOL)
        .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (!(caps.maxPositionUsd > 0 && caps.maxPositionUsd <= LIVE_PREFLIGHT_MAX_POSITION_USD)) missing.push(`LIVE_MAX_POSITION_USD must be > 0 and <= ${LIVE_PREFLIGHT_MAX_POSITION_USD}`);
      if (!(caps.maxDailyLossUsd > 0 && caps.maxDailyLossUsd <= LIVE_PREFLIGHT_MAX_DAILY_LOSS_USD)) missing.push(`LIVE_MAX_DAILY_LOSS_USD must be > 0 and <= ${LIVE_PREFLIGHT_MAX_DAILY_LOSS_USD}`);
      if (!(Number.isInteger(caps.maxDailyTrades) && caps.maxDailyTrades > 0 && caps.maxDailyTrades <= caps.maxDailyTradesHardCap)) missing.push(`LIVE_MAX_DAILY_TRADES must be a positive integer <= ${caps.maxDailyTradesHardCap}`);
      if (!(rawAllowedSymbols.length === 1 && LIVE_PREFLIGHT_ALLOWED_SYMBOLS.includes(rawAllowedSymbols[0]))) missing.push(`LIVE_ALLOWED_SYMBOLS must be exactly one of ${LIVE_PREFLIGHT_ALLOWED_SYMBOLS.join(' or ')} (single symbol only)`);
      if (missing.length) {
        const fail = { ok: false, checkedAt: new Date().toISOString(), reason: missing.join('; '), spotOnlyPolicy: true };
        fs.writeFileSync(LIVE_PREFLIGHT_FILE, JSON.stringify(fail, null, 2));
        await reportLivePreflightResult(fail);
        console.log('LIVE PREFLIGHT FAIL');
        console.log(`reason: ${fail.reason}`);
        return 1;
      }
    }
    const data = await binanceFetch('/v3/account', { signed: true });
    const balances = {};
    const caps = liveRiskCaps();
    const relevantAssets = new Set(['USDT', 'USDC', 'BNB']);
    for (const sym of caps.allowedSymbols) {
      if (sym.endsWith('USDT')) relevantAssets.add(sym.replace(/USDT$/, ''));
      if (sym.endsWith('USDC')) relevantAssets.add(sym.replace(/USDC$/, ''));
    }
    if (Array.isArray(data.balances)) for (const b of data.balances) if (relevantAssets.has(b.asset)) balances[b.asset] = b.free;
    let exchangeInfoOk = false;
    for (const symbol of caps.allowedSymbols) {
      const info = await getSymbolInfo(symbol);
      const lot = info.filters && info.filters.find((f) => f.filterType === 'LOT_SIZE');
      const notional = info.filters && info.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
      if (lot && notional && info.isSpotTradingAllowed !== false) exchangeInfoOk = true;
    }
    const accountType = data.accountType || null;
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const canTradeSpot = data.canTrade === true && (accountType === 'SPOT' || permissions.includes('SPOT') || permissions.length === 0);
    const result = {
      ok: canTradeSpot && exchangeInfoOk,
      checkedAt: new Date().toISOString(),
      canTradeSpot,
      accountType,
      permissions,
      balances,
      riskCaps: caps,
      dailyTradeUsage: { used: null, max: caps.maxDailyTrades, remaining: null, hardCap: caps.maxDailyTradesHardCap },
      spotOnlyPolicy: true,
      baseUrl: getBinanceBaseUrl(),
    };
    if (livePreflight) {
      fs.writeFileSync(LIVE_PREFLIGHT_FILE, JSON.stringify(result, null, 2));
      await reportLivePreflightResult(result);
      console.log(result.ok ? 'LIVE PREFLIGHT PASS' : 'LIVE PREFLIGHT FAIL');
      console.log(`canTradeSpot: ${result.canTradeSpot}`);
      console.log(`accountType: ${accountType || 'unknown'}`);
      console.log('permissions:', JSON.stringify(permissions));
      console.log('balances:', JSON.stringify(balances));
      console.log('risk caps:', JSON.stringify(caps));
      console.log(`daily trades: used=n/a max=${caps.maxDailyTrades} remaining=n/a hardCap=${caps.maxDailyTradesHardCap}`);
      console.log('spotOnlyPolicy=true');
      return result.ok ? 0 : 1;
    }
    console.log('[PREFLIGHT SUCCESS] ok: true, canReachBinance: true');
    if (accountType) console.log(`accountType: ${accountType}`);
    console.log('balances:', JSON.stringify(balances));
    const btcFree = Number(balances.BTC);
    if (Number.isFinite(btcFree) && btcFree > 0) {
      console.log(`[PREFLIGHT WARNING] Non-zero BTC testnet balance detected: BTC=${balances.BTC}. Worker will not auto-sell arbitrary BTC unless the position is known in ${STATE_FILE} or the user clicks Emergency Close Testnet.`);
    }
    return 0;
  } catch (err) { console.log(`[PREFLIGHT ERROR] ${err.message}`); return 1; }
}

async function main() {
  if (isPreflight) return await runPreflight();
  currentState = 'running';
  console.log(`[START] Local Binance Worker (${isLiveSpot ? 'LIVE SPOT - REAL MONEY LOCKED BY GATES' : 'Testnet'}, session=${sessionId}, workerId=${workerId})`);
  console.log(`[INFO] Control URL: ${controlUrl} | poll ${pollIntervalMs}ms | heartbeat ${HEARTBEAT_INTERVAL_MS}ms`);
  console.log(`[INFO] Session ID: ${sessionId}`);
  console.log(`[INFO] workerId: ${workerId}`);
  if (launchedByProtocol) console.log('[INFO] Launched via swingworker:// protocol handler.');

  await sendHeartbeat();
  // Crash-recovery: if local state already holds an open position, re-report it to
  // the backend and refuse new BUY intents until it is closed.
  await reportOpenPositions('startup');
  heartbeatTimer = setInterval(() => {
    sendHeartbeat()
      .then((res) => {
        if (res && !res.ok) {
          console.log(`[CONTROL][WARN] heartbeat failed HTTP ${res.status}; continuing because openPositions=${getOpenPositions().length}`);
        }
      })
      .catch((err) => {
        console.log(`[CONTROL][WARN] heartbeat exception swallowed: ${err.message}; continuing because openPositions=${getOpenPositions().length}`);
      });
  }, HEARTBEAT_INTERVAL_MS);
  pollTimer = setInterval(() => { tick().catch((err) => console.log('[ERROR] tick failed:', err.message)); }, pollIntervalMs);
  tick().catch((err) => console.log('[ERROR] tick failed:', err.message));
  startAutoRuntime();
  // Public market snapshot feed: 60s cadence, never on the 5s heartbeat, and
  // strictly fire-and-forget so close/stop always takes priority.
  if (marketSnapshotEnabled) {
    console.log(`[SNAPSHOT] Public market snapshot feed enabled (every ${Math.round(MARKET_SNAPSHOT_INTERVAL_MS / 1000)}s, public endpoints only).`);
    marketSnapshotTimer = setInterval(() => {
      fetchAndPostMarketSnapshot().catch((err) => console.log(`[SNAPSHOT][WARN] snapshot tick failed: ${err.message}`));
    }, MARKET_SNAPSHOT_INTERVAL_MS);
    fetchAndPostMarketSnapshot().catch((err) => console.log(`[SNAPSHOT][WARN] snapshot tick failed: ${err.message}`));
  }
}

// Only run the worker when executed directly (`node scripts/local-binance-worker.mjs`).
// When imported by a test, skip main() so the pure functions can be exercised.
const isMainModule = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === __filename; } catch { return true; }
})();

function setupGlobalCrashGuard() {
  const handler = (err, type) => {
    const open = getOpenPositions().length;
    if (open > 0) {
      console.error(`[CRITICAL] ${type} caught: ${err ? err.message : 'unknown'}. Staying alive in degraded recovery mode due to open positions=${open}.`);
      console.error(err);
      // DO NOT EXIT!
    } else {
      console.error(`[FATAL] ${type} caught: ${err ? err.message : 'unknown'}. No open positions, exiting code 1.`);
      console.error(err);
      process.exit(1);
    }
  };
  process.on('uncaughtException', (err) => handler(err, 'uncaughtException'));
  process.on('unhandledRejection', (err) => handler(err, 'unhandledRejection'));
}

if (isMainModule) {
  setupGlobalCrashGuard();
  main()
    .then((code) => { if (code !== undefined) process.exitCode = code; })
    .catch((err) => { 
      const open = getOpenPositions().length;
      if (open > 0) {
        console.error(`[CRITICAL] main() failed: ${err.message}. Staying alive in degraded recovery mode due to openPositions=${open}.`);
      } else {
        console.error('[FATAL]', err); 
        process.exitCode = 1; 
      }
    });
}

// Exported for unit tests (recovery + close paths). No effect on direct runs.
function _resetStoppingForTest() { stopping = false; }

export {
  workerState,
  getOpenPositions,
  hydrateOpenPositionsFromBackend,
  closeAllPositions,
  recordOpenPosition,
  isKeyUsed,
  executeIntent,
  handleMissingSession,
  runStopSequence,
  quoteAssetForSymbol,
  computeBuyQuantity,
  avgPriceFromFills,
  residualDustQty,
  isResidualSellable,
  computeCloseMetrics,
  computeLiveClosePlan,
  assertSpotOnlyRequest,
  validateLiveIntentGate,
  liveRiskCaps,
  readLivePreflight,
  runPreflight,
  isLivePreflight,
  STATE_FILE,
  LIVE_PREFLIGHT_FILE,
  LOG_FILE,
  _resetStoppingForTest,
  sendHeartbeat,
  tick,
  fetchAndPostMarketSnapshot,
  startAutoRuntime,
};
