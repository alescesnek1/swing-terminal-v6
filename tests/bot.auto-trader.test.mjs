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
function workerReq(path, body, token = process.env.BOT_WORKER_TOKEN) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (token) headers['X-BOT-WORKER-TOKEN'] = token;
  return new Request(`https://ctl.example${path}`, { method: 'POST', headers, body: JSON.stringify(body || {}) });
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
  fleet.autoTrader = {
    ...(fleet.autoTrader || {}),
    shadowEvaluations: 20,
    autoPaperRoundTrips: 5,
    failedCloses: 0,
    duplicateIntentBlocks: 0,
    safetyLockEvents: 0,
    dailyCapRespected: true,
    oneOpenPositionRespected: true,
    passed: true,
  };
  await fleetStore.saveFleet(fleet);

  const missingPhrase = await call(adminReq('POST', '/api/bot/auto-trader/mode', { mode: 'live_spot', confirmLive: true }));
  assert.equal(missingPhrase.status, 409);
  assert.match(missingPhrase.json.error, /confirmation phrase required/i);

  const ok = await call(adminReq('POST', '/api/bot/auto-trader/mode', {
    mode: 'live_spot',
    confirmLivePhrase: 'I UNDERSTAND AUTONOMOUS LIVE SPOT CAN PLACE REAL ORDERS',
  }));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.autoTrader.status, 'LIVE ACTIVE');
});

test('live promotion is blocked without passing shadow/paper evidence', async () => {
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'live_spot';
  process.env.AUTO_LIVE_TRADING_ENABLED = 'true';
  process.env.BOT_LIVE_TRADING_ENABLED = 'true';
  process.env.BOT_ALLOW_REAL_ORDERS = 'true';
  process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
  process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';

  const fleet = await fleetStore.loadFleet();
  fleet.autoTrader = {
    ...(fleet.autoTrader || {}),
    shadowEvaluations: 0,
    autoPaperRoundTrips: 0,
    failedCloses: 0,
    duplicateIntentBlocks: 0,
    safetyLockEvents: 0,
    dailyCapRespected: true,
    oneOpenPositionRespected: true,
    passed: false,
  };
  await fleetStore.saveFleet(fleet);

  const res = await call(adminReq('POST', '/api/bot/auto-trader/mode', {
    mode: 'live_spot',
    confirmLivePhrase: 'I UNDERSTAND AUTONOMOUS LIVE SPOT CAN PLACE REAL ORDERS',
  }));
  assert.equal(res.status, 409);
  assert.equal(res.json.error, 'Promotion to live requires passing shadow/paper evidence first.');
});

test('live promotion is blocked without evidence and when AUTO_LIVE_TRADING_ENABLED=false', async () => {
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'live_spot';
  delete process.env.AUTO_LIVE_TRADING_ENABLED;
  process.env.BOT_LIVE_TRADING_ENABLED = 'true';
  process.env.BOT_ALLOW_REAL_ORDERS = 'true';
  process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
  process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
  const fleet = await fleetStore.loadFleet();
  fleet.autoTrader = { shadowEvaluations: 0, autoPaperRoundTrips: 0 };
  await fleetStore.saveFleet(fleet);
  const res = await call(adminReq('POST', '/api/bot/auto-trader/mode', {
    mode: 'live_spot',
    confirmLivePhrase: 'I UNDERSTAND AUTONOMOUS LIVE SPOT CAN PLACE REAL ORDERS',
  }));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /gate not satisfied/i);
  assert.ok(res.json.autoTrader.liveGateMissing.includes('AUTO_LIVE_TRADING_ENABLED'));
});

test('auto-decision stores runtime state and shadow creates zero intents', async () => {
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'shadow';
  const res = await call(workerReq('/api/bot/auto-decision', {
    sessionId: 'session_auto_shadow',
    mode: 'shadow',
    effectiveMode: 'shadow',
    action: 'SHADOW_BUY',
    decision: 'SHADOW_BUY',
    candidate: { symbol: 'BTCUSDC', score: 72, reasons: ['liquid'] },
    score: 72,
    reasons: ['score 72 >= threshold 60'],
    riskBlocks: [],
    liveRiskBlocks: [],
    dataSource: 'local_worker_binance_public',
    snapshotAgeMs: 1000,
    strategyVersion: 'auto-loop-v1',
  }));
  assert.equal(res.status, 200);
  assert.equal(res.json.autoTrader.action, 'SHADOW_BUY');
  assert.equal(res.json.autoTrader.dataSource, 'local_worker_binance_public');
  assert.equal(res.json.autoTrader.evidence.shadowEvaluations >= 1, true);
  const fleet = await fleetStore.loadFleet();
  assert.equal(Object.values(fleet.executionIntents || {}).filter(Boolean).length, 0);
  assert.ok((fleet.events || []).some((e) => e.type === 'AUTO_SHADOW_DECISION'));
});

test('auto-intent-request creates paper/testnet intent only and rejects duplicate idempotency', async () => {
  process.env.BINANCE_ENV = 'testnet';
  process.env.BOT_ALLOW_TESTNET_ORDERS = 'true';
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'paper';
  delete process.env.AUTO_LIVE_TRADING_ENABLED;
  const fleet = await fleetStore.loadFleet();
  const sessionId = 'session_auto_paper';
  fleet.botSessions[sessionId] = {
    sessionId, ownerUserId: 'user-admin@example.com', ownerEmail: 'admin@example.com', orgId: 'default',
    mode: 'testnet', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(), stopRequested: false, pauseRequested: false,
    closePositionsOnStop: true, config: { minTradeUsd: 5, maxTradeUsd: 10, maxOpenPositions: 1, maxDailyLossUsd: 3, maxDailyTrades: 3, allowTestnet: true, allowLive: false },
  };
  fleet.workerStatuses.worker_auto_paper = { workerId: 'worker_auto_paper', sessionId, status: 'online', lastSeenAt: new Date().toISOString() };
  fleet.executionIntents[sessionId] = null;
  fleet.usedIdempotencyKeys[sessionId] = [];
  await fleetStore.saveFleet(fleet);

  const body = { sessionId, mode: 'paper', autoMode: 'paper', intentSource: 'auto_trader', action: 'BUY', side: 'BUY', symbol: 'BTCUSDC', positionUsd: 6, idempotencyKey: 'auto:paper:BTCUSDC:BUY:1' };
  const res = await call(workerReq('/api/bot/auto-intent-request', body));
  assert.equal(res.status, 200);
  assert.equal(res.json.intent.mode, 'testnet');
  assert.equal(res.json.intent.testnet, true);
  assert.equal(res.json.intent.realProductionOrder, false);
  assert.equal(res.json.stored, true);

  // Same key again while pending → returns existing intent (not 409)
  const dup = await call(workerReq('/api/bot/auto-intent-request', body));
  assert.equal(dup.status, 200);
  assert.equal(dup.json.existing, true);
  assert.ok(dup.json.intent);
  assert.equal(dup.json.intent.id, res.json.intent.id);

  // worker-session must return hasIntent=true with the stored intent
  const ws = await call(new Request(`https://ctl.example/api/bot/worker-session?sessionId=${sessionId}&workerId=worker_auto_paper`, {
    method: 'GET', headers: { 'X-BOT-WORKER-TOKEN': process.env.BOT_WORKER_TOKEN, Accept: 'application/json' },
  }));
  assert.equal(ws.status, 200);
  assert.ok(ws.json.intent, 'worker-session must return the pending intent');
  assert.equal(ws.json.intent.id, res.json.intent.id);

  // After claiming, simulate execution-result to consume the intent
  const execRes = await call(workerReq('/api/bot/execution-result', {
    sessionId, workerId: 'worker_auto_paper', id: res.json.intent.id,
    idempotencyKey: res.json.intent.idempotencyKey, status: 'submitted',
    symbol: 'BTCUSDC', executedQty: '0.0001', mode: 'testnet', testnet: true, realProductionOrder: false,
  }));
  assert.equal(execRes.status, 200);

  // Now the same key must be rejected as consumed
  const dup2 = await call(workerReq('/api/bot/auto-intent-request', body));
  assert.equal(dup2.status, 409);
  assert.equal(dup2.json.duplicate, true);
});

test('auto live intent is blocked by default and by daily cap', async () => {
  delete process.env.AUTO_LIVE_TRADING_ENABLED;
  process.env.AUTO_TRADER_ENABLED = 'true';
  process.env.AUTO_TRADER_MODE = 'live_spot';
  const fleet = await fleetStore.loadFleet();
  const sessionId = 'session_auto_live_blocked';
  fleet.botSessions[sessionId] = {
    sessionId, ownerUserId: 'user-admin@example.com', ownerEmail: 'admin@example.com', orgId: 'default',
    mode: 'live_spot', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600000).toISOString(), stopRequested: false, pauseRequested: false,
    closePositionsOnStop: true, liveModeConfirmed: true,
    config: { minTradeUsd: 5, maxTradeUsd: 6, maxOpenPositions: 1, maxDailyLossUsd: 3, maxDailyTrades: 0, allowTestnet: true, allowLive: true },
  };
  fleet.workerStatuses.worker_auto_live = { workerId: 'worker_auto_live', sessionId, status: 'online', lastSeenAt: new Date().toISOString() };
  fleet.autoTrader = { shadowEvaluations: 20, autoPaperRoundTrips: 5, dailyCapRespected: true, oneOpenPositionRespected: true };
  await fleetStore.saveFleet(fleet);
  const res = await call(workerReq('/api/bot/auto-intent-request', {
    sessionId, mode: 'live_spot', action: 'BUY', side: 'BUY', symbol: 'BTCUSDC', positionUsd: 6, idempotencyKey: 'auto:live:BTCUSDC:BUY:1',
  }));
  assert.equal(res.status, 409);
  assert.match(res.json.error, /locked|gate|missing/i);
});

test('autoTraderEvidence strict counting', async () => {
  const fleet = await fleetStore.loadFleet();
  const sid = 'session_test_evidence';
  fleet.botSessions[sid] = {
    sessionId: sid,
    mode: 'testnet',
  };
  
  fleet.positionResults = fleet.positionResults || {};
  fleet.positionResults[sid] = [
    // 1. manual testnet smoke trade (no intentSource)
    {
      symbol: 'BTCUSDT', status: 'closed', mode: 'testnet',
      orderId: 'm1', executedQty: '1', realizedPnl: '10',
      source: null, intentSource: null, autoMode: null,
      realProductionOrder: false,
    },
    // 2. legacy paper trade without intentSource (excluded)
    {
      symbol: 'ETHUSDT', status: 'closed', mode: 'testnet',
      orderId: 'l1', executedQty: '1', realizedPnl: '10',
      source: 'auto-trader', intentSource: null, autoMode: null,
      realProductionOrder: false,
    },
    // 3. auto paper closed trade (counts!)
    {
      symbol: 'ADAUSDT', status: 'closed', mode: 'testnet',
      orderId: 'a1', executedQty: '1', realizedPnl: '10',
      source: 'auto-trader', intentSource: 'auto_trader', autoMode: 'paper',
      realProductionOrder: false,
    },
    // 4. CLOSED_WITH_DUST auto paper trade (counts!)
    {
      symbol: 'SOLUSDT', status: 'CLOSED_WITH_DUST', mode: 'testnet',
      orderId: 'a2', executedQty: '1', realizedPnl: '0',
      source: 'auto-trader', intentSource: 'auto_trader', autoMode: 'paper',
      realProductionOrder: false,
    },
    // 5. realProductionOrder true (never counts as paper)
    {
      symbol: 'XRPUSDT', status: 'closed', mode: 'testnet',
      orderId: 'r1', executedQty: '1', realizedPnl: '10',
      source: 'auto-trader', intentSource: 'auto_trader', autoMode: 'paper',
      realProductionOrder: true,
    },
  ];
  
  fleet.autoTrader = {
    shadowEvaluations: 20,
  };
  
  await fleetStore.saveFleet(fleet);

  // Trigger an endpoint that calls autoTraderStatus which returns the evidence
  const res = await call(workerReq('/api/bot/auto-decision', {
    sessionId: 'session_auto_shadow_test2',
    mode: 'shadow', effectiveMode: 'shadow', action: 'SHADOW_HOLD', decision: 'SHADOW_HOLD',
    candidate: { symbol: 'BTCUSDC', score: 40 }, score: 40, reasons: [], riskBlocks: [], liveRiskBlocks: [],
    dataSource: 'local_worker_binance_public', snapshotAgeMs: 1000, strategyVersion: 'auto-loop-v1',
  }));
  
  assert.equal(res.status, 200);
  const evidence = res.json.autoTrader.evidence;
  assert.equal(evidence.autoShadowEvaluations >= 20, true);
  assert.equal(evidence.autoPaperRoundTrips, 2); // ADAUSDT and SOLUSDT
  assert.equal(evidence.manualPaperRoundTrips, 2); // BTCUSDT, ETHUSDT
  assert.equal(evidence.rejectedEvidenceSamples, 2);
});
