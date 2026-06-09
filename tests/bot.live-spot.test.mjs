import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-live';
process.env.WORKER_MODE = 'live_spot';
process.env.BINANCE_ENV = 'live_spot';
process.env.BOT_LIVE_TRADING_ENABLED = 'true';
process.env.BOT_ALLOW_REAL_ORDERS = 'true';
process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';
process.env.LIVE_MAX_POSITION_USD = '10';
process.env.LIVE_MAX_DAILY_LOSS_USD = '5';
process.env.LIVE_MAX_DAILY_TRADES = '3';
process.env.LIVE_MAX_OPEN_POSITIONS = '1';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDT';
delete process.env.AUTH_DECODE_ONLY;
delete process.env.BOT_GLOBAL_KILL_SWITCH;

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
const WORKER_TOKEN = 'test-worker-token-live';

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function jwtFor(email) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: `user-${email}`, email, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}

function browserReq(method, path, body) {
  const init = { method, headers: { Origin: ORIGIN, Authorization: `Bearer ${jwtFor('admin@example.com')}`, Accept: 'application/json' } };
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

test('live start is blocked until user config allowLive and preflight pass exist', async () => {
  const blocked = await call(browserReq('POST', '/api/bot/start-live-session', {
    liveModeConfirmed: true,
    confirmationPhrase: 'I UNDERSTAND THIS USES REAL MONEY',
  }));
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /PREFLIGHT|LOCKED|READY/);

  const cfg = await call(browserReq('POST', '/api/bot/config', { maxTradeUsd: 10, maxDailyLossUsd: 5, maxDailyTrades: 3, maxOpenPositions: 1, allowLive: true }));
  assert.equal(cfg.status, 200);

  const stillBlocked = await call(browserReq('POST', '/api/bot/start-live-session', {
    liveModeConfirmed: true,
    confirmationPhrase: 'I UNDERSTAND THIS USES REAL MONEY',
  }));
  assert.equal(stillBlocked.status, 409);
  assert.equal(stillBlocked.json.error, 'LIVE PREFLIGHT REQUIRED');
});

test('live preflight pass plus exact confirmation creates a live_spot session', async () => {
  const pf = await call(workerReq('POST', '/api/bot/live-preflight-result', {
    ok: true,
    checkedAt: new Date().toISOString(),
    mode: 'live_spot',
    canTradeSpot: true,
    accountType: 'SPOT',
    permissions: ['SPOT'],
    balances: { BTC: '0', USDT: '20' },
    spotOnlyPolicy: true,
  }));
  assert.equal(pf.status, 200);

  const wrongPhrase = await call(browserReq('POST', '/api/bot/start-live-session', {
    liveModeConfirmed: true,
    confirmationPhrase: 'wrong',
  }));
  assert.equal(wrongPhrase.status, 403);

  const start = await call(browserReq('POST', '/api/bot/start-live-session', {
    liveModeConfirmed: true,
    confirmationPhrase: 'I UNDERSTAND THIS USES REAL MONEY',
  }));
  assert.equal(start.status, 200);
  assert.equal(start.json.session.mode, 'live_spot');
  assert.equal(start.json.session.liveModeConfirmed, true);
});

test('global live emergency stop sets kill switch and queues close-only commands', async () => {
  const stopped = await call(browserReq('POST', '/api/bot/live-emergency-stop', {}));
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.globalKillSwitchActive, true);
  const fleet = await call(browserReq('GET', '/api/bot/fleet'));
  assert.equal(fleet.json.globalKillSwitchActive, true);
  assert.equal(fleet.json.liveReadiness.state, 'LIVE PAUSED');
});
