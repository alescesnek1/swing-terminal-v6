// POST /api/bot/auto-market-snapshot + shadow evaluation data-source priority.
//
// Proves: the endpoint requires the worker token, validates source and bounds,
// stores the sanitized snapshot under fleet.autoMarketSnapshot (which survives a
// normalized reload), and the opportunistic shadow tick prefers a FRESH local
// worker snapshot over the Netlify-side Binance public fetch — falling back to the
// allowlist with publicFetchError surfaced when the snapshot is stale and Netlify
// egress is 451-blocked. Shadow never creates intents. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.BOT_WORKER_TOKEN = 'test-worker-token-snapshot';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret-snapshot';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
delete process.env.AUTO_TRADER_ENABLED;
delete process.env.AUTO_TRADER_MODE;

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
function workerReq(body, token = process.env.BOT_WORKER_TOKEN) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['X-BOT-WORKER-TOKEN'] = token;
  return new Request('https://ctl.example/api/bot/auto-market-snapshot', { method: 'POST', headers, body: JSON.stringify(body) });
}
async function call(req) { const res = await handler(req); const json = await res.json().catch(() => ({})); return { status: res.status, json }; }

const SOURCE = 'local_worker_binance_public';
function snapMarket(over = {}) {
  return {
    symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', status: 'TRADING',
    quoteVolume: 5e8, volume: 1e4, bidPrice: 100000, askPrice: 100010,
    spreadPct: 0.01, priceChangePercent: 4, source: SOURCE,
    ...over,
  };
}
function validPayload(over = {}) {
  return {
    workerId: 'worker_snaptest',
    sessionId: 'session_snaptest',
    source: SOURCE,
    fetchedAt: new Date().toISOString(),
    markets: [snapMarket(), snapMarket({ symbol: 'ETHUSDC', baseAsset: 'ETH', quoteVolume: 2e8, priceChangePercent: 2 })],
    diagnostics: { fetchedSymbols: 5, eligibleSymbols: 2, postedSymbols: 2 },
    ...over,
  };
}

// ── emptyFleet / normalize keep the snapshot field (spec test 4) ─────────────
test('emptyFleet declares autoMarketSnapshot and a saved snapshot survives a normalized reload', async () => {
  assert.ok(Object.prototype.hasOwnProperty.call(fleetStore.emptyFleet(), 'autoMarketSnapshot'),
    'autoMarketSnapshot must be declared in emptyFleet() or it vanishes on reload');
  const fleet = await fleetStore.loadFleet();
  fleet.autoMarketSnapshot = { source: SOURCE, fetchedAt: new Date().toISOString(), markets: [snapMarket()] };
  await fleetStore.saveFleet(fleet);
  const reloaded = await fleetStore.loadFleet(); // load → normalize round-trip
  assert.ok(reloaded.autoMarketSnapshot, 'snapshot survived normalize');
  assert.equal(reloaded.autoMarketSnapshot.markets[0].symbol, 'BTCUSDC');
});

// ── Endpoint auth + validation ────────────────────────────────────────────────
test('auto-market-snapshot requires the worker token', async () => {
  const noToken = await call(workerReq(validPayload(), null));
  assert.equal(noToken.status, 403);
  const badToken = await call(workerReq(validPayload(), 'wrong-token'));
  assert.equal(badToken.status, 403);
});

test('auto-market-snapshot validates source, markets shape and size bounds', async () => {
  const badSource = await call(workerReq(validPayload({ source: 'evil_feed' })));
  assert.equal(badSource.status, 400);
  assert.match(badSource.json.error, /source/);

  const badMarkets = await call(workerReq(validPayload({ markets: 'not-an-array' })));
  assert.equal(badMarkets.status, 400);
  assert.match(badMarkets.json.error, /array/);

  const tooLarge = await call(workerReq(validPayload({ markets: Array.from({ length: 1001 }, (_, i) => snapMarket({ symbol: `S${i}USDC` })) })));
  assert.equal(tooLarge.status, 400);
  assert.match(tooLarge.json.error, /too large/);

  const noWorker = await call(workerReq(validPayload({ workerId: undefined })));
  assert.equal(noWorker.status, 400);
  assert.match(noWorker.json.error, /workerId/);
});

// ── Endpoint stores the snapshot (spec test 3) ───────────────────────────────
test('a valid worker snapshot is stored under fleet.autoMarketSnapshot with an UPDATED event', async () => {
  // Start from "no snapshot" so the UPDATED transition event fires.
  const fleet0 = await fleetStore.loadFleet();
  fleet0.autoMarketSnapshot = null;
  fleet0.events = [];
  await fleetStore.saveFleet(fleet0);

  const res = await call(workerReq(validPayload()));
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.stored, 2);

  const fleet = await fleetStore.loadFleet();
  const snap = fleet.autoMarketSnapshot;
  assert.ok(snap);
  assert.equal(snap.source, SOURCE);
  assert.equal(snap.workerId, 'worker_snaptest');
  assert.equal(snap.sessionId, 'session_snaptest');
  assert.equal(snap.markets.length, 2);
  assert.equal(snap.markets[0].symbol, 'BTCUSDC');
  assert.equal(snap.markets[0].quoteVolume, 5e8);
  assert.ok(snap.receivedAt);
  assert.ok(fleet.events.some((e) => e.type === 'AUTO_MARKET_SNAPSHOT_UPDATED'));
  // No secret-shaped fields can land in the stored snapshot (field whitelist).
  assert.equal(JSON.stringify(snap).includes('apiKey'), false);
});

test('a failed snapshot (no markets) stores diagnostics and emits AUTO_MARKET_SNAPSHOT_FAILED', async () => {
  const res = await call(workerReq(validPayload({ markets: [], diagnostics: { error: 'exchangeInfo failed: Error: HTTP 451' } })));
  assert.equal(res.status, 200);
  assert.equal(res.json.failed, true);
  const fleet = await fleetStore.loadFleet();
  assert.equal(fleet.autoMarketSnapshot.markets.length, 0);
  assert.match(fleet.autoMarketSnapshot.diagnostics.error, /451/);
  assert.ok(fleet.events.some((e) => e.type === 'AUTO_MARKET_SNAPSHOT_FAILED'));
});

// ── Shadow tick priority (spec tests 5/6/7/8/9) ───────────────────────────────
async function primeShadowEvaluation() {
  // The evaluation itself reads process.env (mirrors the Netlify env in
  // production where AUTO_TRADER_ENABLED/MODE are set as site env vars).
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'shadow';
  // Request shadow mode and force the next evaluation to be due.
  const set = await call(adminReq('POST', '/api/bot/auto-trader/mode', { mode: 'shadow' }));
  assert.equal(set.status, 200);
  const fleet = await fleetStore.loadFleet();
  fleet.autoTrader = { ...(fleet.autoTrader || {}), nextEvaluationAt: new Date(Date.now() - 1000).toISOString() };
  await fleetStore.saveFleet(fleet);
}

test('shadow evaluation uses a FRESH local worker snapshot before any Netlify Binance fetch', async () => {
  await call(workerReq(validPayload({ fetchedAt: new Date().toISOString() })));
  await primeShadowEvaluation();

  const originalFetch = global.fetch;
  let binanceCalled = false;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/api/markets')) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('binance')) { binanceCalled = true; throw new Error('HTTP 451'); }
    return originalFetch(url, options);
  };
  try {
    const res = await call(adminReq('GET', '/api/bot/fleet'));
    assert.equal(res.status, 200);
    const ud = res.json.autoTrader.universeDiagnostics;
    assert.ok(ud, 'diagnostics persisted');
    assert.equal(ud.dataSource, 'local_worker_binance_public');
    assert.equal(ud.snapshotUsed, true);
    assert.equal(ud.fallbackUsed, false);
    assert.ok(ud.snapshotAgeMs <= 120000, 'snapshot age within freshness window');
    assert.equal(ud.publicFetchAttempted, false);
    assert.equal(binanceCalled, false, 'Netlify-side Binance fetch must not run with a fresh snapshot');
    assert.ok(res.json.autoTrader.candidate, 'candidate from the real USDC universe');
    assert.ok(['BTCUSDC', 'ETHUSDC'].includes(res.json.autoTrader.candidate.symbol));

    // Shadow creates zero live/testnet intents (spec test 9).
    const fleet = await fleetStore.loadFleet();
    const intents = Object.values(fleet.executionIntents || {}).filter(Boolean);
    assert.equal(intents.length, 0, 'no execution intent of any kind from shadow');
  } finally {
    global.fetch = originalFetch;
  }
});

test('a STALE snapshot is ignored; Netlify 451 surfaces publicFetchError and falls back to BTCUSDC', async () => {
  // Make the stored snapshot stale (10 minutes old).
  const fleet0 = await fleetStore.loadFleet();
  fleet0.autoMarketSnapshot.fetchedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await fleetStore.saveFleet(fleet0);
  await primeShadowEvaluation();

  const originalFetch = global.fetch;
  let binanceCalls = 0;
  global.fetch = async (url, options) => {
    const u = String(url);
    if (u.includes('/api/markets')) return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('binance')) { binanceCalls++; throw new Error('HTTP 451'); }
    return originalFetch(url, options);
  };
  try {
    const res = await call(adminReq('GET', '/api/bot/fleet'));
    assert.equal(res.status, 200);
    const ud = res.json.autoTrader.universeDiagnostics;
    assert.equal(ud.snapshotUsed, false);
    assert.ok(ud.snapshotAgeMs >= 10 * 60 * 1000, 'stale snapshot age reported');
    assert.equal(ud.publicFetchAttempted, true);
    assert.equal(ud.publicFetchOk, false);
    assert.match(ud.publicFetchError, /451/);
    assert.equal(ud.fallbackUsed, true);
    assert.equal(ud.dataSource, 'fallback');
    assert.ok(binanceCalls > 0, 'Netlify public fetch ran because the snapshot was stale');
    assert.equal(res.json.autoTrader.candidate.symbol, 'BTCUSDC', 'allowlist fallback candidate');

    // Events are snapshotted into the response BEFORE the tick runs, so assert on
    // the stored fleet instead.
    const fleet1 = await fleetStore.loadFleet();
    const failEvents = (fleet1.events || []).filter((e) => e.type === 'AUTO_PUBLIC_FETCH_FAILED');
    assert.equal(failEvents.length, 1, 'public fetch failure logged');

    // Re-running within the suppression window must NOT add another FAILED event.
    await primeShadowEvaluation();
    const res2 = await call(adminReq('GET', '/api/bot/fleet'));
    const fleet2 = await fleetStore.loadFleet();
    const failEvents2 = (fleet2.events || []).filter((e) => e.type === 'AUTO_PUBLIC_FETCH_FAILED');
    assert.equal(failEvents2.length, 1, 'repeated 451 is throttled, not logged every poll');
    assert.match(res2.json.autoTrader.universeDiagnostics.publicFetchError, /451/, 'diagnostics stay current even when the event is throttled');

    // Still zero intents.
    const intents = Object.values(fleet2.executionIntents || {}).filter(Boolean);
    assert.equal(intents.length, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
