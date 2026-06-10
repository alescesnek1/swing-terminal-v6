import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-auto-trader';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret-auto-trader';
process.env.LIVE_MAX_DAILY_TRADES = '3';
process.env.LIVE_MAX_POSITION_USD = '6';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
delete process.env.AUTO_TRADER_ENABLED;
delete process.env.AUTO_TRADER_MODE;
delete process.env.AUTO_LIVE_TRADING_ENABLED;
delete process.env.BOT_LIVE_TRADING_ENABLED;
delete process.env.BOT_ALLOW_REAL_ORDERS;
delete process.env.LOCAL_WORKER_LIVE_CONFIRM;
delete process.env.LIVE_SPOT_ACK;

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
async function call(req) { const res = await handler(req); const json = await res.json().catch(() => ({})); return { status: res.status, json }; }

test('default auto trader is off/shadow and live locked', async () => {
  const res = await call(adminReq('GET', '/api/bot/fleet'));
  assert.equal(res.status, 200);
  assert.equal(res.json.autoTrader.enabled, false);
  assert.equal(res.json.autoTrader.mode, 'shadow');
  assert.equal(res.json.autoTrader.status, 'OFF');
  assert.equal(res.json.autoTrader.liveExecutionAllowed, false);
  assert.ok(res.json.autoTrader.liveGateMissing.includes('AUTO_TRADER_ENABLED'));
});

test('shadow mode request persists through normalized fleet reload', async () => {
  const set = await call(adminReq('POST', '/api/bot/auto-trader/mode', { mode: 'shadow' }));
  assert.equal(set.status, 200);
  assert.equal(set.json.autoTrader.status, 'SHADOW');

  const reloaded = await call(adminReq('GET', '/api/bot/fleet'));
  assert.equal(reloaded.json.autoTrader.status, 'SHADOW');
  assert.equal(reloaded.json.autoTrader.requestedMode, 'shadow');
});

test('live promotion requires the explicit phrase even when env gates and paper evidence pass', async () => {
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'live_spot';
  process.env.AUTO_LIVE_TRADING_ENABLED = 'true';
  process.env.BOT_LIVE_TRADING_ENABLED = 'true';
  process.env.BOT_ALLOW_REAL_ORDERS = 'true';
  process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
  process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';

  const fleet = await fleetStore.loadFleet();
  fleet.autoTrader = { ...(fleet.autoTrader || {}), paperTradeCount: 1 };
  await fleetStore.saveFleet(fleet);

  const missingPhrase = await call(adminReq('POST', '/api/bot/auto-trader/mode', { mode: 'live_spot', confirmLive: true }));
  assert.equal(missingPhrase.status, 409);
  assert.match(missingPhrase.json.error, /confirmation phrase required/i);

  const ok = await call(adminReq('POST', '/api/bot/auto-trader/mode', {
    mode: 'live_spot',
    confirmLivePhrase: 'I UNDERSTAND AUTONOMOUS LIVE SPOT USES REAL MONEY',
  }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.autoTrader.status, 'LIVE ACTIVE');
});
