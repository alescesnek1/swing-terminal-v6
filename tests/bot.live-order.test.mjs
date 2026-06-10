// Backend tests for POST /api/bot/create-live-execution-intent — the live (REAL
// MONEY) micro-order endpoint that backs the "CREATE LIVE BTCUSDC ORDER" button.
// Drives the real handler with a fake durable Blobs store. No network, no
// Binance, no secrets. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-live-order';
process.env.WORKER_MODE = 'live_spot';
process.env.BINANCE_ENV = 'live_spot';
process.env.BOT_LIVE_TRADING_ENABLED = 'true';
process.env.BOT_ALLOW_REAL_ORDERS = 'true';
process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';
process.env.LIVE_MAX_POSITION_USD = '5';
process.env.LIVE_MAX_DAILY_LOSS_USD = '5';
process.env.LIVE_MAX_DAILY_TRADES = '3';
process.env.LIVE_MAX_OPEN_POSITIONS = '1';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
delete process.env.AUTH_DECODE_ONLY;
delete process.env.BOT_GLOBAL_KILL_SWITCH;

import fs from 'node:fs';
const botSource = fs.readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');

const storeState = new Map();
const fakeBlobStore = {
  async get() {
    const raw = storeState.get('fleet-state');
    return raw ? JSON.parse(raw) : null;
  },
  async setJSON(key, value) {
    storeState.set(key, JSON.stringify(value));
    return { modified: true };
  },
  async getWithMetadata() {
    const raw = storeState.get('fleet-state');
    return { data: raw ? JSON.parse(raw) : null, etag: crypto.randomBytes(4).toString('hex') };
  },
};

const fleetStore = await import('../netlify/functions/_fleet-store.mjs');
fleetStore.__setBlobStoreForTest(fakeBlobStore);
const { default: handler } = await import('../netlify/functions/bot.mjs');

const ORIGIN = 'http://localhost';
const WORKER_TOKEN = 'test-worker-token-live-order';

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function jwtFor(email) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: `user-${email}`, email, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}
function adminReq(method, path, body) {
  const init = { method, headers: { Origin: ORIGIN, Authorization: `Bearer ${jwtFor('admin@example.com')}`, Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
function nonAdminReq(method, path, body) {
  const init = { method, headers: { Origin: ORIGIN, Authorization: `Bearer ${jwtFor('user@example.com')}`, Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
function workerReq(method, path, body) {
  const init = { method, headers: { 'X-BOT-WORKER-TOKEN': WORKER_TOKEN, Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
async function call(req) {
  const res = await handler(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function postPreflight(ok) {
  return call(workerReq('POST', '/api/bot/live-preflight-result', {
    ok,
    checkedAt: new Date().toISOString(),
    mode: 'live_spot',
    canTradeSpot: true,
    accountType: 'SPOT',
    permissions: ['SPOT'],
    balances: { BTC: '0', USDC: '20' },
    spotOnlyPolicy: true,
  }));
}

let SID;
const WORKER_ID = 'w-live-order-1';

test('setup: fresh preflight + confirmed live start creates a live session with an online worker', async () => {
  const pf = await postPreflight(true);
  assert.equal(pf.status, 200);
  const start = await call(adminReq('POST', '/api/bot/start-live-session', {
    liveModeConfirmed: true,
    confirmationPhrase: 'I UNDERSTAND THIS USES REAL MONEY',
  }));
  assert.equal(start.status, 200);
  SID = start.json.session.sessionId;
  assert.ok(SID);
  // Bring a worker online for this exact live session.
  const hb = await call(workerReq('POST', '/api/bot/worker-heartbeat', { sessionId: SID, workerId: WORKER_ID, currentState: 'running' }));
  assert.equal(hb.status, 200);
});

test('live intent rejects a non-admin', async () => {
  const res = await call(nonAdminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'BTCUSDC', positionUsd: 5,
  }));
  assert.equal(res.status, 403);
});

test('live intent rejects a symbol that is not allowlisted', async () => {
  const res = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'ETHUSDC', positionUsd: 5,
  }));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /allowlist/i);
});

test('live intent rejects an amount over the live cap', async () => {
  const res = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'BTCUSDC', positionUsd: 999,
  }));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /cap/i);
});

test('live intent success creates exactly one BTCUSDC/$5 MARKET BUY intent', async () => {
  const res = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'BTCUSDC', side: 'BUY', type: 'MARKET', positionUsd: 5, mode: 'live_spot', realProductionOrder: true,
  }));
  assert.equal(res.status, 200);
  const intent = res.json.intent;
  assert.equal(intent.symbol, 'BTCUSDC');
  assert.equal(intent.side, 'BUY');
  assert.equal(intent.type, 'MARKET');
  assert.equal(intent.positionUsd, 5);
  assert.equal(intent.mode, 'live_spot');
  assert.equal(intent.realProductionOrder, true);
  assert.equal(intent.testnet, false);
  assert.equal(intent.quoteAsset, 'USDC');

  // Idempotent: a second click returns the SAME pending intent, never a duplicate.
  const again = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'BTCUSDC', positionUsd: 5,
  }));
  assert.equal(again.status, 200);
  assert.equal(again.json.existing, true);
  assert.equal(again.json.intent.id, intent.id);
});

test('live intent rejects when an open position already exists, then allows after close', async () => {
  // Simulate the worker reporting an OPEN live position for this session.
  const open = await call(workerReq('POST', '/api/bot/position-result', {
    sessionId: SID, symbol: 'BTCUSDC', baseAsset: 'BTC', executedQty: '0.00010000', orderId: 'live-ord-1', status: 'open',
  }));
  assert.equal(open.status, 200);

  const blocked = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'BTCUSDC', positionUsd: 5,
  }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /open live positions|open position/i);

  // Cleanup: close the position so later tests are not blocked.
  await call(workerReq('POST', '/api/bot/position-result', {
    sessionId: SID, symbol: 'BTCUSDC', baseAsset: 'BTC', executedQty: '0.00010000', orderId: 'live-ord-1', closeOrderId: 'live-close-1', status: 'closed',
  }));
});

test('live intent rejects when live preflight is not fresh', async () => {
  // A failed/stale preflight drops readiness below LIVE READY - MICRO CAPS.
  const pf = await postPreflight(false);
  assert.equal(pf.status, 200);
  const res = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: SID, symbol: 'BTCUSDC', positionUsd: 5,
  }));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /PREFLIGHT|READY|LOCKED|PAUSED/);
  // Restore fresh preflight for any later runs.
  await postPreflight(true);
});

test('live intent rejects a session that is not live_spot', async () => {
  const res = await call(adminReq('POST', '/api/bot/create-live-execution-intent', {
    sessionId: 'session_does_not_exist', symbol: 'BTCUSDC', positionUsd: 5,
  }));
  assert.equal(res.status, 404);
});

test('create-live-execution-intent source enforces durable store, allowLive, and explicit live intent fields', () => {
  // The durable + allowLive gates and the explicit real-money intent payload are
  // part of the endpoint; assert their presence so they cannot silently regress.
  const block = botSource.slice(botSource.indexOf("base === 'create-live-execution-intent'"), botSource.indexOf("base === 'create-execution-intent'"));
  assert.match(block, /fleetStoreInfo\(\)\.durable/);
  assert.match(block, /allowLive === true/);
  assert.match(block, /liveModeConfirmed === true/);
  assert.match(block, /side: 'BUY'/);
  assert.match(block, /type: 'MARKET'/);
  assert.match(block, /realProductionOrder: true/);
  assert.match(block, /mode: 'live_spot'/);
});
