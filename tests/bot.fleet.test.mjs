// Backend per-session integrity tests for the Bot Fleet Manager.
//
// Drives the real `handler` export with the in-memory fleet store (Netlify Blobs
// is unavailable outside Netlify, so _fleet-store falls back to memory). No
// network, no Binance, no secrets. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Env must be set BEFORE importing the handler-adjacent modules.
process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_ALLOW_TESTNET_ORDERS = 'true';
process.env.BOT_ALLOW_MEMORY_STORE = 'true'; // permit the in-memory store for tests (prod uses durable blobs)
process.env.AUTH_DECODE_ONLY = 'true'; // decode-only identity for browser routes (test only)
process.env.SUPABASE_JWT_SECRET = 'unit-test-secret';
process.env.BOT_ADMIN_EMAILS = 'admin@example.com';
delete process.env.BOT_LIVE_TRADING_ENABLED;
delete process.env.BOT_ALLOW_REAL_ORDERS;
delete process.env.BOT_GLOBAL_KILL_SWITCH;

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
function signedJwtFor(email) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: `admin-${email}`, email, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
  const signingInput = `${b64url(header)}.${b64url(payload)}`;
  const sig = crypto.createHmac('sha256', process.env.SUPABASE_JWT_SECRET).update(signingInput).digest('base64url');
  return `${signingInput}.${sig}`;
}
function freshUser() {
  _uid += 1;
  const sub = `user-${Date.now()}-${_uid}`;
  return { sub, email: `${sub}@example.com`, token: jwtFor(sub, `${sub}@example.com`) };
}
function adminUser() {
  return { sub: 'admin-admin@example.com', email: 'admin@example.com', token: signedJwtFor('admin@example.com') };
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

// Owned session that holds an open position (the real production scenario).
async function ownedSessionWithPosition(user, orderId) {
  const r = await call(browserReq('POST', '/api/bot/start-session', user, {}));
  assert.equal(r.status, 200);
  const sid = r.json.sessionId;
  await openPosition(sid, orderId);
  return sid;
}

test('G-2: stop-session with an open position returns commandQueued=true and the worker sees stopRequested=true', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-g2');
  const stop = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/stop`, u, {}));
  assert.equal(stop.status, 200);
  assert.equal(stop.json.commandQueued, true);
  assert.equal(stop.json.commandType, 'STOP');
  assert.equal(stop.json.commandSessionId, sid);
  assert.ok((stop.json.queuedCommandsForSession || []).some((c) => c.type === 'STOP'));
  // The very next worker-session poll for the SAME session sees it.
  const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=wg2`));
  assert.equal(ws.json.stopRequested, true);
  assert.ok((ws.json.commandsForThisSession || []).some((c) => c.type === 'STOP'));
  await closePosition(sid, 'ord-g2');
});

test('G-3: emergency-close returns commandQueued=true and the worker sees emergencyCloseRequested=true', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-g3');
  const emc = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/emergency-close`, u, {}));
  assert.equal(emc.status, 200);
  assert.equal(emc.json.commandQueued, true);
  assert.equal(emc.json.commandType, 'EMERGENCY_CLOSE');
  const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=wg3`));
  assert.equal(ws.json.emergencyCloseRequested, true);
  assert.ok((ws.json.commandsForThisSession || []).some((c) => c.type === 'EMERGENCY_CLOSE'));
  await closePosition(sid, 'ord-g3');
});

test('G-3b: a queued command STAYS until the worker acks it (survives repeated polls)', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-g3b');
  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/emergency-close`, u, {}));
  // Poll twice without acking — command must still be present both times.
  const ws1 = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=wg3b`));
  const cmd = (ws1.json.commandsForThisSession || []).find((c) => c.type === 'EMERGENCY_CLOSE');
  assert.ok(cmd, 'command present on first poll');
  const ws2 = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=wg3b`));
  assert.ok((ws2.json.commandsForThisSession || []).some((c) => c.id === cmd.id), 'command still present on second poll');
  // Now ack it → it disappears.
  await call(workerReq('POST', '/api/bot/worker-command-ack', { sessionId: sid, workerId: 'wg3b', commandIds: [cmd.id] }));
  const ws3 = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=wg3b`));
  assert.ok(!(ws3.json.commandsForThisSession || []).some((c) => c.id === cmd.id), 'command gone after ack');
  await closePosition(sid, 'ord-g3b');
});

test('G-debug: worker-session reports ignoredCommandsForOtherSessionsCount (per-session isolation visible)', async () => {
  const a = freshUser();
  const b = freshUser();
  const sidA = await ownedSessionWithPosition(a, 'ord-iga');
  const sidB = await ownedSessionWithPosition(b, 'ord-igb');
  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sidA)}/emergency-close`, a, {}));
  const wsB = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sidB}&workerId=wigb`));
  assert.equal((wsB.json.commandsForThisSession || []).length, 0);
  assert.ok(wsB.json.ignoredCommandsForOtherSessionsCount >= 1); // A's command is visible-as-ignored, never delivered
  await closePosition(sidA, 'ord-iga');
  await closePosition(sidB, 'ord-igb');
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

// ── Closed-trade ledger + final-state derivation (spec C/F/G) ────────────────

// Close a position with full PnL metrics (the rich worker close report).
async function closeWithMetrics(sessionId, orderId, overrides = {}) {
  return call(workerReq('POST', '/api/bot/position-result', Object.assign({
    sessionId, symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId,
    closeOrderId: 'c-' + orderId, status: 'closed',
    entryOrderId: orderId,
    openedAt: new Date(Date.now() - 60000).toISOString(), closedAt: new Date().toISOString(),
    entryAvgPrice: 50000, closeAvgPrice: 55000, boughtQty: 0.00015, soldQty: 0.00015,
    residualDust: 0, realizedPnl: 0.75, realizedPnlPct: 10, feesAvailable: false,
  }, overrides)));
}
function fleetSession(fleetJson, sid) {
  return (fleetJson.sessions || []).find((s) => s.sessionId === sid) || null;
}

test('CT-1/CT-5: OPEN then CLOSED yields openPositions=0, closedTrades=1 with PnL fields', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-ct1');
  await closeWithMetrics(sid, 'ord-ct1');
  const fleet = await call(browserReq('GET', '/api/bot/fleet', u));
  const s = fleetSession(fleet.json, sid);
  assert.ok(s, 'owned session visible in fleet');
  assert.equal(s.openPositions.length, 0);
  assert.equal(s.closedTrades.length, 1);
  const t = s.closedTrades[0];
  assert.equal(t.status, 'CLOSED');
  assert.equal(t.symbol, 'BTCUSDT');
  assert.equal(t.entryAvgPrice, 50000);
  assert.equal(t.closeAvgPrice, 55000);
  assert.equal(t.realizedPnl, 0.75);
  assert.equal(t.realizedPnlPct, 10);
  assert.equal(t.entryOrderId, 'ord-ct1');
  assert.equal(t.closeOrderId, 'c-ord-ct1');
  assert.ok(typeof t.durationMs === 'number' && t.durationMs > 0);
  assert.ok(Math.abs(s.realizedPnl - 0.75) < 1e-9);
  assert.ok(!(fleet.json.openPositionSessionIds || []).includes(sid));
});

test('CT-2: CLOSED_WITH_DUST yields openPositions=0 and START is allowed again', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-ct2');
  await closeWithMetrics(sid, 'ord-ct2', {
    status: 'CLOSED_WITH_DUST', executedQty: '0.00014000', soldQty: 0.00014, residualDust: 0.00001,
  });
  const fleet = await call(browserReq('GET', '/api/bot/fleet', u));
  const s = fleetSession(fleet.json, sid);
  assert.equal(s.openPositions.length, 0);
  assert.equal(s.closedTrades.length, 1);
  assert.equal(s.closedTrades[0].status, 'CLOSED_WITH_DUST');
  assert.equal(s.closedTrades[0].residualDust, 0.00001);
  assert.ok(!(fleet.json.openPositionSessionIds || []).includes(sid));
  // START is no longer blocked by an open position.
  const start = await call(browserReq('POST', '/api/bot/start-session', u, {}));
  assert.equal(start.json.ok, true);
  assert.notEqual(start.json.conflict, 'open_position');
});

test('CT-3: a stale OPEN report after CLOSED does NOT reopen the position', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-ct3');
  await closeWithMetrics(sid, 'ord-ct3');
  // A late/duplicate OPEN report for the SAME orderId arrives (worker heartbeat lag).
  await openPosition(sid, 'ord-ct3');
  const fleet = await call(browserReq('GET', '/api/bot/fleet', u));
  const s = fleetSession(fleet.json, sid);
  assert.equal(s.openPositions.length, 0, 'stale OPEN must not resurrect a closed position');
  assert.equal(s.closedTrades.length, 1);
  assert.ok(!(fleet.json.openPositionSessionIds || []).includes(sid));
});

test('CT-4: a close_failed keeps openPositions=1 and blocks START', async () => {
  const u = freshUser();
  const sid = await ownedSessionWithPosition(u, 'ord-ct4');
  await call(workerReq('POST', '/api/bot/position-result', {
    sessionId: sid, symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000',
    orderId: 'ord-ct4', status: 'WORKER_CLOSE_FAILED', error: 'insufficient balance',
  }));
  const fleet = await call(browserReq('GET', '/api/bot/fleet', u));
  const s = fleetSession(fleet.json, sid);
  assert.equal(s.openPositions.length, 1);
  assert.equal(s.closedTrades.length, 0); // a failed close is NOT a settled trade
  assert.ok((fleet.json.openPositionSessionIds || []).includes(sid));
  // START is blocked with a reconnect conflict.
  const start = await call(browserReq('POST', '/api/bot/start-session', u, {}));
  assert.equal(start.status, 409);
  assert.equal(start.json.conflict, 'open_position');
  // cleanup: a real close clears it.
  await closeWithMetrics(sid, 'ord-ct4');
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

test('PAUSE-1: create-smoke-execution-intent is rejected when session entries are paused', async () => {
  const u = freshUser();
  const r = await call(browserReq('POST', '/api/bot/start-session', u, {}));
  assert.equal(r.status, 200);
  const sid = r.json.sessionId;
  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/pause`, u, {}));

  const smoke = await call(browserReq('POST', '/api/bot/create-smoke-execution-intent', u, { sessionId: sid }));
  assert.equal(smoke.status, 409);
  assert.equal(smoke.json.code, 'ENTRIES_PAUSED');
  assert.equal(smoke.json.entryBlockedReason, 'session_paused');
  assert.equal(smoke.json.canAcceptEntryIntent, false);
});

test('PAUSE-2: create-smoke-execution-intent is rejected when global kill switch is active', async () => {
  const prev = process.env.BOT_GLOBAL_KILL_SWITCH;
  process.env.BOT_GLOBAL_KILL_SWITCH = 'true';
  try {
    const u = freshUser();
    const r = await call(browserReq('POST', '/api/bot/start-session', u, {}));
    assert.equal(r.status, 200);
    const smoke = await call(browserReq('POST', '/api/bot/create-smoke-execution-intent', u, { sessionId: r.json.sessionId }));
    assert.equal(smoke.status, 409);
    assert.equal(smoke.json.code, 'GLOBAL_KILL_SWITCH_ACTIVE');
    assert.equal(smoke.json.entryBlockedReason, 'global_kill_switch');
  } finally {
    if (prev === undefined) delete process.env.BOT_GLOBAL_KILL_SWITCH;
    else process.env.BOT_GLOBAL_KILL_SWITCH = prev;
  }
});

test('PAUSE-3: stop and emergency-close remain allowed when global kill switch is active', async () => {
  const prev = process.env.BOT_GLOBAL_KILL_SWITCH;
  process.env.BOT_GLOBAL_KILL_SWITCH = 'true';
  try {
    const u = freshUser();
    const sid = await ownedSessionWithPosition(u, 'ord-paused-close');
    const emc = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/emergency-close`, u, {}));
    assert.equal(emc.status, 200);
    assert.equal(emc.json.commandType, 'EMERGENCY_CLOSE');
    const stop = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/stop`, u, {}));
    assert.equal(stop.status, 200);
    assert.equal(stop.json.commandType, 'STOP');
    await closePosition(sid, 'ord-paused-close');
  } finally {
    if (prev === undefined) delete process.env.BOT_GLOBAL_KILL_SWITCH;
    else process.env.BOT_GLOBAL_KILL_SWITCH = prev;
  }
});

test('PAUSE-4: resume entries fails while global kill switch is active', async () => {
  const prev = process.env.BOT_GLOBAL_KILL_SWITCH;
  process.env.BOT_GLOBAL_KILL_SWITCH = 'true';
  try {
    const u = freshUser();
    const r = await call(browserReq('POST', '/api/bot/start-session', u, {}));
    assert.equal(r.status, 200);
    const resume = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(r.json.sessionId)}/resume`, u, {}));
    assert.equal(resume.status, 409);
    assert.equal(resume.json.code, 'GLOBAL_KILL_SWITCH_ACTIVE');
    assert.match(resume.json.message, /Clear global kill switch first/);
  } finally {
    if (prev === undefined) delete process.env.BOT_GLOBAL_KILL_SWITCH;
    else process.env.BOT_GLOBAL_KILL_SWITCH = prev;
  }
});

test('PAUSE-5: worker-session reports pause reason and does not claim intents while paused', async () => {
  const u = freshUser();
  const r = await call(browserReq('POST', '/api/bot/start-session', u, {}));
  assert.equal(r.status, 200);
  const sid = r.json.sessionId;
  await call(workerReq('POST', '/api/bot/worker-heartbeat', { sessionId: sid, workerId: 'w-paused-intent', status: 'online', currentState: 'running', openPositions: [] }));
  const smoke = await call(browserReq('POST', '/api/bot/create-smoke-execution-intent', u, { sessionId: sid }));
  assert.equal(smoke.status, 200);
  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/pause`, u, {}));

  const paused = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=w-paused-intent`));
  assert.equal(paused.status, 200);
  assert.equal(paused.json.pauseRequested, true);
  assert.equal(paused.json.globalKillSwitchActive, false);
  assert.equal(paused.json.entryBlockedReason, 'session_paused');
  assert.equal(paused.json.canAcceptEntryIntent, false);
  assert.equal(paused.json.intent, null);

  const resumed = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(sid)}/resume`, u, {}));
  assert.equal(resumed.status, 200);
  const next = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=w-paused-intent`));
  assert.equal(next.json.pauseRequested, false);
  assert.equal(next.json.entryBlockedReason, null);
  assert.equal(next.json.canAcceptEntryIntent, true);
  assert.equal(next.json.intent, null);

  const freshSmoke = await call(browserReq('POST', '/api/bot/create-smoke-execution-intent', u, { sessionId: sid }));
  assert.equal(freshSmoke.status, 200);
  const claimed = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${sid}&workerId=w-paused-intent`));
  assert.equal(claimed.json.canAcceptEntryIntent, true);
  assert.equal(claimed.json.intent.id, freshSmoke.json.intent.id);
});

test('PAUSE-6: clear global kill switch requires admin, no open positions, and emits audit event', async () => {
  const admin = adminUser();
  const nonAdmin = freshUser();
  const sid = await ownedSessionWithPosition(admin, 'ord-gks');

  const activate = await call(browserReq('POST', '/api/bot/global-kill-switch/activate', admin, {}));
  assert.equal(activate.status, 200);
  assert.equal(activate.json.globalKillSwitchActive, true);

  const nonAdminClear = await call(browserReq('POST', '/api/bot/global-kill-switch/clear', nonAdmin, { confirmation: 'CLEAR GLOBAL KILL SWITCH' }));
  assert.equal(nonAdminClear.status, 403);

  const blockedOpen = await call(browserReq('POST', '/api/bot/global-kill-switch/clear', admin, { confirmation: 'CLEAR GLOBAL KILL SWITCH' }));
  assert.equal(blockedOpen.status, 409);
  assert.equal(blockedOpen.json.code, 'OPEN_POSITIONS_EXIST');

  await closePosition(sid, 'ord-gks');
  const cleared = await call(browserReq('POST', '/api/bot/global-kill-switch/clear', admin, { confirmation: 'CLEAR GLOBAL KILL SWITCH' }));
  assert.equal(cleared.status, 200);
  assert.equal(cleared.json.globalKillSwitchActive, false);
  assert.equal(cleared.json.auditEvent.type, 'GLOBAL_KILL_SWITCH_CLEARED');
  assert.equal(cleared.json.auditEvent.by, 'admin@example.com');
  assert.ok(cleared.json.auditEvent.timestamp);

  const fresh = await call(browserReq('POST', '/api/bot/start-session', admin, {}));
  assert.equal(fresh.status, 200);
  const freshSid = fresh.json.sessionId;
  await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(freshSid)}/pause`, admin, {}));
  const resumed = await call(browserReq('POST', `/api/bot/session/${encodeURIComponent(freshSid)}/resume`, admin, {}));
  assert.equal(resumed.status, 200);
  const ws = await call(workerReq('GET', `/api/bot/worker-session?sessionId=${freshSid}&workerId=w-after-clear`));
  assert.equal(ws.json.pauseRequested, false);
  assert.equal(ws.json.canAcceptEntryIntent, true);
});
