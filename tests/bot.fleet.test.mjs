// Backend per-session integrity tests for the Bot Fleet Manager.
//
// Drives the real `handler` export with the in-memory fleet store (Netlify Blobs
// is unavailable outside Netlify, so _fleet-store falls back to memory). No
// network, no Binance, no secrets. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

// Env must be set BEFORE importing the handler-adjacent modules.
process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_ALLOW_TESTNET_ORDERS = 'true';
process.env.BOT_ALLOW_MEMORY_STORE = 'true'; // permit the in-memory store for tests (prod uses durable blobs)
process.env.AUTH_DECODE_ONLY = 'true'; // decode-only identity for browser routes (test only)
delete process.env.BOT_LIVE_TRADING_ENABLED;
delete process.env.BOT_ALLOW_REAL_ORDERS;

const { default: handler } = await import('../netlify/functions/bot.mjs');

const ORIGIN = 'http://localhost';
const WORKER_TOKEN = 'test-worker-token';
let _uid = 0;

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}
// A decode-only (unsigned) JWT — accepted only because AUTH_DECODE_ONLY=true.
function jwtFor(sub, email) {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub, email })}.sig`;
}
function freshUser() {
  _uid += 1;
  const sub = `user-${Date.now()}-${_uid}`;
  return { sub, email: `${sub}@example.com`, token: jwtFor(sub, `${sub}@example.com`) };
}

function workerReq(method, path, body) {
  const init = { method, headers: { 'X-BOT-WORKER-TOKEN': WORKER_TOKEN, Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
function browserReq(method, path, user, body) {
  const init = { method, headers: { Origin: ORIGIN, Authorization: `Bearer ${user.token}`, Accept: 'application/json' } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return new Request(`https://ctl.example${path}`, init);
}
async function call(req) {
  const res = await handler(req);
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// Report an OPEN position for sessionId via the worker position-result route. With
// no pre-existing session this recovers an (unowned) visible session holding it.
async function openPosition(sessionId, orderId = 'ord-1') {
  return call(workerReq('POST', '/api/bot/position-result', {
    sessionId, symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId, status: 'open',
  }));
}
async function closePosition(sessionId, orderId = 'ord-1') {
  return call(workerReq('POST', '/api/bot/position-result', {
    sessionId, symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId, closeOrderId: 'c-1', status: 'closed',
  }));
}

test('A/H/I-1: start-session with an open-position session does NOT create a new session and returns a reconnect conflict', async () => {
  const user = freshUser();
  const openSid = `session_open_${Date.now()}_a`;
  await openPosition(openSid);

  const { status, json } = await call(browserReq('POST', '/api/bot/start-session', user, {}));
  assert.equal(status, 409);
  assert.equal(json.ok, false);
  assert.equal(json.conflict, 'open_position');
  assert.equal(json.openPositionSessionId, openSid);
  // I-2: the reconnect launch URL targets the EXACT open-position sessionId.
  assert.ok(typeof json.launchUrl === 'string' && json.launchUrl.includes(encodeURIComponent(openSid)));
  assert.equal(json.sessionId, openSid);
  await closePosition(openSid); // cleanup: an unowned open position blocks everyone globally
});

test('I-5: worker-session for the open-position session includes openPositions for recovery', async () => {
  const openSid = `session_open_${Date.now()}_b`;
  await openPosition(openSid);
  const { status, json } = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${openSid}&workerId=w1`));
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.openPositions));
  assert.equal(json.openPositionsCount, 1);
  assert.equal(json.openPositions[0].symbol, 'BTCUSDT');
  // Strict per-session debug fields are present.
  assert.equal(json.sessionId, openSid);
  assert.equal(json.commandSessionId, openSid);
  assert.equal(json.workerId, 'w1');
  await closePosition(openSid); // cleanup
});

test('I-3/I-4: pause + emergency-close for session A are NOT visible to worker-session for session B', async () => {
  const a = freshUser();
  const b = freshUser();
  const ra = await call(browserReq('POST', '/api/bot/start-session', a, {}));
  const rb = await call(browserReq('POST', '/api/bot/start-session', b, {}));
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 200);
  const sidA = ra.json.sessionId;
  const sidB = rb.json.sessionId;

  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sidA)}/pause`, a, {}));
  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sidA)}/emergency-close`, a, {}));

  const wsA = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sidA}&workerId=wa`));
  const wsB = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sidB}&workerId=wb`));

  // Session A sees its own pause + emergency-close.
  assert.equal(wsA.json.pauseRequested, true);
  assert.equal(wsA.json.emergencyCloseRequested, true);
  assert.ok(wsA.json.commands.some((c) => c.type === 'EMERGENCY_CLOSE'));

  // Session B is unaffected — no leakage of A's pause/emergency.
  assert.equal(wsB.json.pauseRequested, false);
  assert.equal(wsB.json.emergencyCloseRequested, false);
  assert.equal(wsB.json.commands.length, 0);
  assert.equal(wsB.json.commandSessionId, sidB);
});

test('root cause: worker-session for an UNKNOWN session with no open positions never forces pauseRequested', async () => {
  const sid = `session_clean_${Date.now()}_z`;
  const { status, json } = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=wz`));
  assert.equal(status, 200);
  assert.equal(json.session, null);
  assert.equal(json.sessionMissing, true);
  assert.equal(json.pauseRequested, false); // previously leaked true onto clean workers
  assert.equal(json.emergencyCloseRequested, false);
  assert.equal(json.openPositionsCount, 0);
});

test('I-6: clear-stale refuses an open-position session', async () => {
  const openSid = `session_open_${Date.now()}_c`;
  await openPosition(openSid);
  const u = freshUser();
  const { status, json } = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(openSid)}/clear-stale`, u, {}));
  assert.equal(status, 409);
  assert.equal(json.ok, false);
  await closePosition(openSid); // cleanup
});

test('I-2: start-session without any open position creates a fresh session', async () => {
  const u = freshUser();
  const { status, json } = await call(browserReq('POST', '/api/bot/start-session', u, {}));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.ok(typeof json.sessionId === 'string' && json.sessionId.startsWith('session_'));
  assert.ok(typeof json.launchUrl === 'string' && json.launchUrl.includes(encodeURIComponent(json.sessionId)));
});

test('I-8: stop-session with an open position queues a STOP close command (does NOT clear the session)', async () => {
  const openSid = `session_open_${Date.now()}_e`;
  await openPosition(openSid, 'ord-e');
  const u = freshUser();
  const { status, json } = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(openSid)}/stop`, u, {}));
  assert.equal(status, 200);
  assert.notEqual(json.cleared, true); // must not clear a session holding a position
  // The worker now sees a STOP command + stopRequested for this exact session.
  const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${openSid}&workerId=we`));
  assert.equal(ws.json.stopRequested, true);
  assert.ok(ws.json.commands.some((c) => c.type === 'STOP'));
  // Position still tracked (not lost by the stop request).
  assert.equal(ws.json.openPositionsCount, 1);
  await closePosition(openSid, 'ord-e'); // cleanup
});

test('I-10: fleet response never hides an open-position session and reports durability', async () => {
  const openSid = `session_open_${Date.now()}_f`;
  await openPosition(openSid, 'ord-f');
  const u = freshUser();
  const { status, json } = await call(browserReq('GET', '/api/bot/fleet', u));
  assert.equal(status, 200);
  const ids = (json.sessions || []).map((s) => s.sessionId);
  assert.ok(ids.includes(openSid), 'open-position session must be visible in fleet');
  assert.ok(Array.isArray(json.openPositionSessionIds) && json.openPositionSessionIds.includes(openSid));
  assert.equal(typeof json.durable, 'boolean');
  assert.ok(json.storeMode === 'durable_blobs' || json.storeMode === 'memory_fallback');
  await closePosition(openSid, 'ord-f'); // cleanup
});

test('I-7/G-6: after the position is closed, openPositionSessionIds empties and start-session is allowed again', async () => {
  const openSid = `session_open_${Date.now()}_d`;
  const user = freshUser();
  await openPosition(openSid, 'ord-d');
  // Blocked while open.
  const blocked = await call(browserReq('POST', '/api/bot/start-session', user, {}));
  assert.equal(blocked.status, 409);
  // Close it.
  await closePosition(openSid, 'ord-d');
  const fleetAfter = await call(browserReq('GET', '/api/bot/fleet', user));
  assert.ok(!(fleetAfter.json.openPositionSessionIds || []).includes(openSid));
  // Now allowed.
  const ok = await call(browserReq('POST', '/api/bot/start-session', user, {}));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.ok, true);
  assert.ok(typeof ok.json.sessionId === 'string');
});

test('G-1: a non-durable store blocks START + smoke but still allows closing an existing position', async () => {
  const prev = process.env.BOT_ALLOW_MEMORY_STORE;
  delete process.env.BOT_ALLOW_MEMORY_STORE; // simulate production memory_fallback (not allowed)
  const openSid = `session_open_${Date.now()}_g`;
  try {
    const u = freshUser();
    // START blocked with the explicit not_durable contract (no open position present).
    const start = await call(browserReq('POST', '/api/bot/start-session', u, {}));
    assert.equal(start.status, 409);
    assert.equal(start.json.code, 'not_durable');
    // Now create an open position; smoke must still be blocked by durability.
    await openPosition(openSid, 'ord-g');
    const smoke = await call(browserReq('POST', '/api/bot/create-smoke-execution-intent', u, { sessionId: openSid }));
    assert.equal(smoke.status, 409);
    assert.equal(smoke.json.code, 'not_durable');
    // Closing the existing position is STILL allowed (no durability gate on close).
    const emc = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(openSid)}/emergency-close`, u, {}));
    assert.equal(emc.status, 200);
    const stop = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(openSid)}/stop`, u, {}));
    assert.equal(stop.status, 200);
    // Fleet read still works and reports the non-durable mode.
    const fleet = await call(browserReq('GET', '/api/bot/fleet', u));
    assert.equal(fleet.json.newEntriesAllowed, false);
    assert.equal(fleet.json.storeMode, 'memory_fallback');
  } finally {
    if (prev === undefined) process.env.BOT_ALLOW_MEMORY_STORE = 'true'; else process.env.BOT_ALLOW_MEMORY_STORE = prev;
  }
  await closePosition(openSid, 'ord-g'); // cleanup
});
