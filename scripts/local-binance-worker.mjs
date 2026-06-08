import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CLI args ---
function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < process.argv.length) return process.argv[idx + 1];
  return undefined;
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

const HEARTBEAT_INTERVAL_MS = 5000;
const MAX_CLOSE_RETRIES = 5;
const TESTNET_MAX_TRADE_USD = 10;

const isPreflight = process.argv.includes('--preflight') || process.env.WORKER_PREFLIGHT === 'true';

// Per-session worker id; persisted so a restart rebinds to the same session.
const workerId = `worker_${crypto.randomBytes(4).toString('hex')}`;
const hostname = os.hostname();
const platform = `${os.platform()}-${os.arch()}`;
const startedAt = new Date().toISOString();
const WORKER_VERSION = '3.0.0';

// State file is namespaced per session so multiple workers on one machine don't collide.
const stateSuffix = sessionId ? `-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '').slice(-16)}` : '';
const STATE_FILE = path.join(__dirname, '..', `.paperbot-worker-state${stateSuffix}.json`);

// Hard gate: testnet only. Live/production trading is never reachable here.
if (workerMode !== 'testnet') { console.error('[ERROR] WORKER_MODE must be testnet'); process.exit(1); }
if (binanceEnv !== 'testnet') { console.error('[ERROR] BINANCE_ENV must be testnet'); process.exit(1); }
if (!controlUrl || !workerToken || !apiKey || !apiSecret) {
  console.error('[ERROR] Missing required env (BOT_CONTROL_URL, BOT_WORKER_TOKEN, BINANCE_API_KEY, BINANCE_API_SECRET).');
  process.exit(1);
}
if (!isPreflight && !sessionId) {
  console.error('[ERROR] sessionId is required. Launch with --session <id> (the START BOT button provides this).');
  process.exit(1);
}

const BINANCE_TESTNET_BASE = 'https://testnet.binance.vision/api';

// --- State ---
let workerState = { usedKeys: [], positions: [] };
try {
  if (fs.existsSync(STATE_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    workerState = { usedKeys: [], positions: [], ...loaded };
    if (!Array.isArray(workerState.usedKeys)) workerState.usedKeys = [];
    if (!Array.isArray(workerState.positions)) workerState.positions = [];
  }
} catch (err) {
  console.error('[WARN] Failed to load local state, starting fresh.', err.message);
}
function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(workerState, null, 2)); }
  catch (err) { console.error('[ERROR] Failed to save worker state.', err.message); }
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
function recordOpenPosition(pos) {
  workerState.positions.push(pos);
  workerState.positions = workerState.positions.slice(-50);
  saveState();
}
function markPositionClosed(orderId, closeOrderId) {
  const pos = workerState.positions.find((p) => p && p.orderId === orderId && p.status === 'open');
  if (pos) { pos.status = 'closed'; pos.closeOrderId = closeOrderId; pos.closedAt = new Date().toISOString(); saveState(); }
}

// --- Utils ---
function hmacSha256(qs, secret) { return crypto.createHmac('sha256', secret).update(qs).digest('hex'); }
function stepPrecision(stepSize) {
  const step = String(stepSize || '');
  if (!step.includes('.')) return 0;
  return step.split('.')[1].replace(/0+$/, '').length;
}

// Lifecycle: starting | running | paused | stopping | stopped
let currentState = 'starting';
let stopping = false;
const ackedCommands = new Set();

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
        pid: process.pid, mode: 'testnet', version: WORKER_VERSION,
        currentState, launchedByProtocol, realProductionOrder: false,
      }),
    });
    if (!res.ok) { console.warn(`[WARN] Heartbeat HTTP ${res.status}`); return null; }
    return await res.json().catch(() => null);
  } catch (err) { console.warn(`[WARN] Heartbeat error: ${err.message}`); return null; }
}

async function fetchSession() {
  try {
    const url = `${controlUrl}/api/bot/worker-session?sessionId=${encodeURIComponent(sessionId)}&workerId=${encodeURIComponent(workerId)}`;
    const res = await fetch(url, { headers: { 'X-BOT-WORKER-TOKEN': workerToken } });
    if (!res.ok) { console.warn(`[WARN] worker-session HTTP ${res.status}`); return null; }
    return await res.json().catch(() => null);
  } catch (err) { console.warn(`[WARN] Session poll error: ${err.message}`); return null; }
}

async function ackCommands(ids) {
  if (!ids.length) return;
  try {
    await fetch(`${controlUrl}/api/bot/worker-command-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ sessionId, workerId, commandIds: ids }),
    });
  } catch (err) { console.warn(`[WARN] command ack error: ${err.message}`); }
}

async function reportResult(body) {
  try {
    await fetch(`${controlUrl}/api/bot/execution-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ sessionId, workerId, ...body }),
    });
  } catch (err) { console.error(`[ERROR] reportResult: ${err.message}`); }
}

async function reportPosition(body) {
  try {
    await fetch(`${controlUrl}/api/bot/position-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BOT-WORKER-TOKEN': workerToken },
      body: JSON.stringify({ sessionId, workerId, testnet: true, realProductionOrder: false, ...body }),
    });
  } catch (err) { console.error(`[ERROR] reportPosition: ${err.message}`); }
}

// --- Binance (testnet only) ---
async function submitMarketOrder(symbol, side, quantity, precision) {
  const qp = new URLSearchParams();
  qp.append('symbol', symbol);
  qp.append('side', side);
  qp.append('type', 'MARKET');
  qp.append('quantity', Number(quantity).toFixed(precision));
  qp.append('timestamp', Date.now().toString());
  qp.append('recvWindow', '5000');
  const qs = qp.toString();
  const signature = hmacSha256(qs, apiSecret);
  const res = await fetch(`${BINANCE_TESTNET_BASE}/v3/order?${qs}&signature=${signature}`, {
    method: 'POST',
    headers: { 'X-MBX-APIKEY': apiKey, 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Binance error: ${data.msg || JSON.stringify(data)}`);
  return data;
}
async function getSymbolInfo(symbol) {
  const res = await fetch(`${BINANCE_TESTNET_BASE}/v3/exchangeInfo?symbol=${symbol}`);
  const data = await res.json();
  if (!data || !data.symbols || !data.symbols[0]) throw new Error(`Symbol ${symbol} not found in exchangeInfo`);
  return data.symbols[0];
}

// --- Intent execution (BUY MARKET only), gated by config snapshot ---
async function executeIntent(intent, config, riskState) {
  if (isKeyUsed(intent.idempotencyKey)) return;

  // ── Worker-side hard validation (defense in depth) ──
  const reject = async (reason) => {
    console.warn(`[GATE] Intent ${intent.id} rejected: ${reason}`);
    await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: reason, testnet: true, realProductionOrder: false });
    markKeyUsed(intent.idempotencyKey);
  };
  if (intent.mode !== 'testnet') return reject('Intent mode is not testnet');
  if (intent.side !== 'BUY' || intent.type !== 'MARKET') return reject('Only BUY MARKET supported');
  if (!/^[A-Z0-9]+(USDT|USDC)$/.test(intent.symbol)) return reject('Invalid symbol format');
  const posUsd = Number(intent.positionUsd);
  const minUsd = Number(config && config.minTradeUsd) || 1;
  const maxUsd = Math.min(Number(config && config.maxTradeUsd) || TESTNET_MAX_TRADE_USD, TESTNET_MAX_TRADE_USD, maxPositionUsd);
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

    const priceRes = await fetch(`${BINANCE_TESTNET_BASE}/v3/ticker/price?symbol=${intent.symbol}`);
    const priceData = await priceRes.json();
    if (!priceData || !priceData.price) throw new Error('Failed to fetch ticker price');
    const price = parseFloat(priceData.price);

    const precision = Math.max(0, -Math.floor(Math.log10(stepSize)));
    const stepPow = Math.pow(10, precision);
    const qty = Math.floor((posUsd / price) * stepPow) / stepPow;

    const notional = symbolInfo.filters.find((f) => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    if (notional) {
      const minNotional = parseFloat(notional.minNotional);
      if (qty * price < minNotional) throw new Error(`Order size ${qty * price} < minNotional ${minNotional}`);
    }

    console.log(`[INFO] TESTNET BUY MARKET ${qty} ${intent.symbol} (session ${sessionId.slice(0, 12)})`);
    const order = await submitMarketOrder(intent.symbol, 'BUY', qty, precision);
    console.log(`[INFO] Order OK. OrderID: ${order.orderId}`);

    recordOpenPosition({
      symbol: intent.symbol, baseAsset: symbolInfo.baseAsset, executedQty: order.executedQty,
      orderId: order.orderId, sessionId, status: 'open', openedAt: new Date().toISOString(), stepSize: lot.stepSize,
    });
    await reportResult({
      id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'submitted', exchange: 'binance_spot_testnet',
      symbol: intent.symbol, orderId: order.orderId, orderStatus: order.status, executedQty: order.executedQty,
      cummulativeQuoteQty: order.cummulativeQuoteQty, testnet: true, realProductionOrder: false,
    });
    await reportPosition({ symbol: intent.symbol, baseAsset: symbolInfo.baseAsset, executedQty: order.executedQty, orderId: order.orderId, status: 'open' });
    markKeyUsed(intent.idempotencyKey);
  } catch (err) {
    console.error(`[ERROR] Execution failed for ${intent.id}: ${err.message}`);
    await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: err.message, testnet: true, realProductionOrder: false });
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
      console.log(`[${context}] Closing ${pos.symbol} qty ${pos.executedQty}...`);
      let stepSize = pos.stepSize;
      if (!stepSize) {
        const info = await getSymbolInfo(pos.symbol);
        const lot = info.filters.find((f) => f.filterType === 'LOT_SIZE');
        stepSize = lot ? lot.stepSize : '0.00000001';
      }
      const precision = stepPrecision(stepSize);
      const stepNum = parseFloat(stepSize) || 0;
      let sellQty = parseFloat(pos.executedQty);
      if (stepNum > 0) sellQty = Math.floor(sellQty / stepNum) * stepNum;
      if (!(sellQty > 0)) throw new Error(`Computed sell qty not positive for ${pos.symbol}`);

      const close = await submitMarketOrder(pos.symbol, 'SELL', sellQty, precision);
      console.log(`[${context}] Closed ${pos.symbol}. CloseOrderID: ${close.orderId}`);
      markPositionClosed(pos.orderId, close.orderId);
      await reportPosition({ symbol: pos.symbol, baseAsset: pos.baseAsset, executedQty: close.executedQty, orderId: pos.orderId, closeOrderId: close.orderId, status: 'closed' });
    } catch (err) {
      allClosed = false;
      console.error(`[${context}][ERROR] Failed to close ${pos.symbol}: ${err.message}`);
      await reportPosition({ symbol: pos.symbol, baseAsset: pos.baseAsset, executedQty: pos.executedQty, orderId: pos.orderId, status: 'WORKER_CLOSE_FAILED', error: err.message });
    }
  }
  return allClosed;
}

// --- Graceful STOP: close positions, then exit. Never exit with open positions. ---
async function runStopSequence() {
  if (stopping) return;
  stopping = true;
  currentState = 'stopping';
  console.log('[STOP] Stop requested. Closing open testnet positions before exit.');
  await sendHeartbeat();
  let retries = 0;
  while (true) {
    const allClosed = await closeAllPositions('STOP');
    if (allClosed) {
      currentState = 'stopped';
      console.log('[STOP] All positions closed. Worker exiting.');
      await sendHeartbeat();
      process.exit(0);
    }
    retries++;
    if (retries >= MAX_CLOSE_RETRIES) {
      console.error(`[STOP][CRITICAL] CLOSE FAILED after ${retries} retries. Worker will NOT exit with open positions. Manual attention required.`);
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
      // Close everything but keep the worker alive (unless STOP also queued).
      await closeAllPositions('EMERGENCY');
    }
    // STOP/PAUSE/RESUME are also reflected via session flags; ack so they don't repeat.
    ackedCommands.add(cmd.id);
    toAck.push(cmd.id);
  }
  await ackCommands(toAck);
}

// --- Main loop ---
async function tick() {
  if (stopping) return;
  await sendHeartbeat();
  const data = await fetchSession();
  if (!data || !data.session) {
    // Unknown/missing session -> stop gracefully (orphan protection).
    if (data && data.stopRequested) return runStopSequence();
    return;
  }
  const session = data.session;
  const config = data.config || {};
  const riskState = session.riskState || data.session.riskState || null;

  await processCommands(data.commands);

  if (session.stopRequested === true || data.stopRequested === true) {
    return runStopSequence();
  }

  if (session.pauseRequested === true || data.pauseRequested === true) {
    currentState = 'paused';
    return; // no new entries while paused
  }

  currentState = 'running';
  if (data.intent) {
    await executeIntent(data.intent, config, riskState);
  }
}

async function runPreflight() {
  console.log('[PREFLIGHT] Binance Spot Testnet preflight...');
  try {
    const qp = new URLSearchParams();
    qp.append('timestamp', Date.now().toString());
    qp.append('recvWindow', '5000');
    const qs = qp.toString();
    const signature = hmacSha256(qs, apiSecret);
    const res = await fetch(`${BINANCE_TESTNET_BASE}/v3/account?${qs}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey, 'Accept': 'application/json' },
    });
    const data = await res.json();
    if (!res.ok) { console.error(`[PREFLIGHT ERROR] ${data.msg || res.status}`); return 1; }
    const balances = {};
    if (Array.isArray(data.balances)) for (const b of data.balances) if (['BTC', 'USDT', 'BNB', 'USDC'].includes(b.asset)) balances[b.asset] = b.free;
    console.log('[PREFLIGHT SUCCESS] ok: true, canReachBinance: true');
    if (data.accountType) console.log(`accountType: ${data.accountType}`);
    console.log('balances:', JSON.stringify(balances));
    return 0;
  } catch (err) { console.error(`[PREFLIGHT ERROR] ${err.message}`); return 1; }
}

async function main() {
  if (isPreflight) return await runPreflight();
  currentState = 'running';
  console.log(`[START] Local Binance Worker (Testnet, session=${sessionId}, workerId=${workerId})`);
  console.log(`[INFO] Control URL: ${controlUrl} | poll ${pollIntervalMs}ms | heartbeat ${HEARTBEAT_INTERVAL_MS}ms`);
  if (launchedByProtocol) console.log('[INFO] Launched via swingworker:// protocol handler.');

  await sendHeartbeat();
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
  setInterval(() => { tick().catch((err) => console.error('[ERROR] tick failed:', err.message)); }, pollIntervalMs);
  tick().catch((err) => console.error('[ERROR] tick failed:', err.message));
}

main()
  .then((code) => { if (code !== undefined) process.exitCode = code; })
  .catch((err) => { console.error('[FATAL]', err); process.exitCode = 1; });
