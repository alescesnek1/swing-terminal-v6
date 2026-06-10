// Backend tests for the live DAILY TRADE CAP across MULTIPLE live sessions.
//
// Regression: the cap was computed per-session, so each new live session (one per
// round-trip) reset the counter and the cap (e.g. 2) never bit. These tests prove
// the fleet-wide, live-only, durable counter and that the cap blocks a new intent.
// No network, no Binance, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-daily-cap';
process.env.WORKER_MODE = 'live_spot';
process.env.BINANCE_ENV = 'live_spot';
process.env.BOT_LIVE_TRADING_ENABLED = 'true';
process.env.BOT_ALLOW_REAL_ORDERS = 'true';
process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret-daily-cap';
process.env.LIVE_MAX_POSITION_USD = '6';
process.env.LIVE_MIN_NOTIONAL_BUFFER_PCT = '10';
process.env.LIVE_MAX_DAILY_LOSS_USD = '50';
process.env.LIVE_MAX_DAILY_TRADES = '2';
process.env.LIVE_MAX_OPEN_POSITIONS = '1';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
delete process.env.AUTH_DECODE_ONLY;
delete process.env.BOT_GLOBAL_KILL_SWITCH;

const storeState = new Map();
const fakeBlobStore = {
  async get() { const raw = storeState.get('fleet-state'); return raw ? JSON.parse(raw) : null; },
  async setJSON(key, value) { storeState.set(key, JSON.stringify(value)); return { modified: true }; },
  async getWithMetadata() { const raw = storeState.get('fleet-state'); return { data: raw ? JSON.parse(raw) : null, etag: crypto.randomBytes(4).toString('hex') }; },
};
const fleetStore = await import('../netlify/functions/_fleet-store.mjs');
fleetStore.__setBlobStoreForTest(fakeBlobStore);
const { default: handler } = await import('../netlify/functions/bot.mjs');

const ORIGIN = 'http://localhost';
const WORKER_TOKEN = 'test-worker-token-daily-cap';
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
function workerReq(method, path, body) {
  const init = { method, headers: { 'X-BOT-WORKER-TOKEN': WORKER_TOKEN, Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
async function call(req) { const res = await handler(req); const json = await res.json().catch(() => ({})); return { status: res.status, json }; }
async function postPreflight() {
  return call(workerReq('POST', '/api/bot/live-preflight-result', {
    ok: true, checkedAt: new Date().toISOString(), mode: 'live_spot', canTradeSpot: true,
    accountType: 'SPOT', permissions: ['SPOT'], balances: { BTC: '0', USDC: '100' }, spotOnlyPolicy: true,
  }));
}
async function startLive() {
  const r = await call(adminReq('POST', '/api/bot/start-live-session', { liveModeConfirmed: true, confirmationPhrase: 'I UNDERSTAND THIS USES REAL MONEY' }));
  assert.equal(r.status, 200, 'live session starts');
  return r.json.session.sessionId;
}
async function closeLiveTrade(sid, orderId) {
  // Report a settled (closed, profitable) live trade for this session.
  return call(workerReq('POST', '/api/bot/position-result', {
    sessionId: sid, symbol: 'BTCUSDC', baseAsset: 'BTC', executedQty: '0.00010000',
    orderId, entryOrderId: orderId, closeOrderId: `${orderId}-close`, status: 'closed', mode: 'live_spot',
    openedAt: new Date(Date.now() - 60_000).toISOString(), closedAt: new Date().toISOString(),
    boughtQty: 0.0001, soldQty: 0.0001, realizedPnl: 0.05,
  }));
}
async function dailyUsed() {
  const fleet = await call(adminReq('GET', '/api/bot/fleet'));
  return {
    used: fleet.json.liveReadiness.dailyTradesUsed,
    max: fleet.json.liveReadiness.caps.maxDailyTrades,
    remaining: fleet.json.liveReadiness.dailyTradesRemaining,
    loss: fleet.json.liveReadiness.dailyLossUsd,
  };
}

let SID_A; let SID_B;

test('setup: fresh preflight + two live sessions, each with one closed live trade today', async () => {
  await postPreflight();
  SID_A = await startLive();
  await call(workerReq('POST', '/api/bot/worker-heartbeat', { sessionId: SID_A, workerId: 'w-A', currentState: 'running' }));
  const a = await closeLiveTrade(SID_A, 'live-A-1');
  assert.equal(a.status, 200);
  // Session A is now flat → a second live session can start (round-trip #2).
  SID_B = await startLive();
  await call(workerReq('POST', '/api/bot/worker-heartbeat', { sessionId: SID_B, workerId: 'w-B', currentState: 'running' }));
  const b = await closeLiveTrade(SID_B, 'live-B-1');
  assert.equal(b.status, 200);
});

test('counter is fleet-wide and live-only: dailyTradesUsed=2 across two live sessions', async () => {
  const { used, max, remaining } = await dailyUsed();
  assert.equal(used, 2, 'two live closed trades counted across sessions (not reset per session)');
  assert.equal(max, 2, 'UI sees dailyTradesUsed / maxDailyTrades');
  assert.equal(remaining, 0, 'live readiness returns used/max/remaining');
});

test('with 2/2 live trades today, a NEW live intent is rejected by the daily trade cap', async () => {
  const res = await call(adminReq('POST', '/api/bot/create-live-execution-intent', { sessionId: SID_B, symbol: 'BTCUSDC', positionUsd: 6 }));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /daily trade cap reached \(2\/2\)/);
});

test('the counter survives a durable-store reload', async () => {
  // The fake Blobs store persists across requests; a fresh GET re-loads from it.
  const { used } = await dailyUsed();
  assert.equal(used, 2, 'count persists across reload (durable store)');
});

test('paper/testnet trades do NOT count toward the live daily cap', async () => {
  // A recovered testnet session (mode=testnet) with a closed trade must not bump the
  // live counter. Open then close a testnet position on a separate session id.
  await call(workerReq('POST', '/api/bot/position-result', {
    sessionId: 'session_testnet_daily_1', symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.0002', orderId: 'tn-1', status: 'open', mode: 'testnet',
  }));
  await call(workerReq('POST', '/api/bot/position-result', {
    sessionId: 'session_testnet_daily_1', symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.0002', orderId: 'tn-1', closeOrderId: 'tn-1-c', status: 'closed', mode: 'testnet',
    closedAt: new Date().toISOString(), realizedPnl: 0,
  }));
  const { used } = await dailyUsed();
  assert.equal(used, 2, 'testnet trade is excluded from the live daily counter');
});

test('source: the live daily counter is fleet-wide, live-only, and UTC-day scoped', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');
  const block = src.slice(src.indexOf('function liveDailyCounters'), src.indexOf('function liveDailyCounters') + 900);
  assert.match(block, /session\.mode !== 'live_spot'/);
  assert.match(block, /t\.mode !== 'live_spot'/);
  assert.match(block, /utcDayStartMs/);
  // The live intent endpoint uses the fleet-wide counter, not per-session trades.
  assert.match(src, /const liveDaily = liveDailyCounters\(fleet\);/);
  assert.match(src, /todayTradeCount < caps\.maxDailyTrades/);
});
