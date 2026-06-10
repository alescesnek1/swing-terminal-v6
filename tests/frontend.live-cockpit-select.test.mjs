import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

function extractFunctionSource(name) {
  const start = terminalJs.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const brace = terminalJs.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < terminalJs.length; i += 1) {
    if (terminalJs[i] === '{') depth += 1;
    else if (terminalJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return terminalJs.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function loadSelectors() {
  const ctx = { console };
  vm.createContext(ctx);
  const names = [
    '_fleetSessionIsLive', '_fleetWorkerOnline', '_fleetOpenPositionCount', '_fleetSessionTs',
    '_fleetLiveModeActive', '_fleetDefaultLiveSelectedId', '_fleetResolveSelectedId',
  ];
  vm.runInContext(names.map(extractFunctionSource).join('\n'), ctx);
  return ctx;
}

function loadClosedCard() {
  const ctx = {
    console,
    _esc: (v) => String(v == null ? '' : v),
  };
  vm.createContext(ctx);
  const names = [
    '_fmtPnlUsd', '_fmtPnlPct', '_fmtPrice', '_fmtQty', '_fleetFmtDuration', '_fleetClosedTradeCardHtml',
  ];
  vm.runInContext(names.map(extractFunctionSource).join('\n'), ctx);
  return ctx;
}

const testnetStale = { sessionId: 'sess_testnet_old', mode: 'testnet', updatedAt: '2026-06-10T12:00:00.000Z', worker: { online: false }, openPositions: [{ symbol: 'BTCUSDT' }] };
const testnetFlat = { sessionId: 'sess_testnet_flat', mode: 'testnet', updatedAt: '2026-06-10T12:30:00.000Z', worker: { online: false }, openPositions: [] };
const liveOld = { sessionId: 'live_old', mode: 'live_spot', updatedAt: '2026-06-10T10:00:00.000Z', worker: { online: false }, openPositions: [] };
const liveNew = { sessionId: 'live_new', mode: 'live_spot', updatedAt: '2026-06-10T11:00:00.000Z', worker: { online: false }, openPositions: [] };
const liveOnline = { sessionId: 'live_online', mode: 'live_spot', updatedAt: '2026-06-10T09:00:00.000Z', worker: { online: true }, openPositions: [] };
const liveOpen = { sessionId: 'live_open', mode: 'live_spot', updatedAt: '2026-06-10T08:00:00.000Z', worker: { online: true }, openPositions: [{ symbol: 'BTCUSDC' }] };

// ── Spec 8.1: live mode defaults to latest live_spot, never an old testnet ──
test('live mode defaults selection to the latest live_spot, not a more-recent testnet', () => {
  const ctx = loadSelectors();
  const sessions = [testnetFlat, liveOld, liveNew]; // testnet has the newest timestamp
  // No explicit selection: must land on the most recent LIVE session, not testnet.
  assert.equal(ctx._fleetResolveSelectedId(sessions, null, false), 'live_new');
  // A stale prior testnet selection is dropped in favor of the live default.
  assert.equal(ctx._fleetResolveSelectedId(sessions, 'sess_testnet_flat', false), 'live_new');
});

test('live default selection priority: open position > worker online > most recent', () => {
  const ctx = loadSelectors();
  assert.equal(ctx._fleetDefaultLiveSelectedId([liveOld, liveOnline, liveNew]), 'live_online', 'online beats recency');
  assert.equal(ctx._fleetDefaultLiveSelectedId([liveOld, liveOnline, liveOpen]), 'live_open', 'open position wins outright');
  assert.equal(ctx._fleetDefaultLiveSelectedId([liveOld, liveNew]), 'live_new', 'else most recent');
  assert.equal(ctx._fleetDefaultLiveSelectedId([testnetFlat]), null, 'no live session → null (cockpit summary)');
});

// ── Spec 8.5: BTCUSDT testnet stale positions are not the default cockpit view ──
test('a stale BTCUSDT testnet session is never the default selection in live mode', () => {
  const ctx = loadSelectors();
  const sessions = [testnetStale, liveNew];
  assert.equal(ctx._fleetResolveSelectedId(sessions, 'sess_testnet_old', false), 'live_new');
  assert.equal(ctx._fleetLiveModeActive(sessions), true);
});

// ── Spec 8.3: archived testnet/paper can be explicitly opened (selection honored) ──
test('an explicit operator selection of a testnet session is honored in live mode', () => {
  const ctx = loadSelectors();
  const sessions = [testnetFlat, liveNew];
  // userSelected=true mirrors selectFleetSession() — the archive item opens.
  assert.equal(ctx._fleetResolveSelectedId(sessions, 'sess_testnet_flat', true), 'sess_testnet_flat');
});

// ── Non-live mode keeps the legacy behavior ──
test('non-live mode keeps current selection, else open-position-first, else first', () => {
  const ctx = loadSelectors();
  const sessions = [testnetFlat, testnetStale];
  assert.equal(ctx._fleetLiveModeActive(sessions), false);
  assert.equal(ctx._fleetResolveSelectedId(sessions, 'sess_testnet_flat', false), 'sess_testnet_flat', 'keeps a valid current');
  assert.equal(ctx._fleetResolveSelectedId(sessions, null, false), 'sess_testnet_old', 'open-position-first when none selected');
});

// ── Spec 8.4: live closed card never offers "START BOT AGAIN" (that starts testnet) ──
test('closed card in live mode shows START LIVE SPOT (or nothing), never START BOT AGAIN', () => {
  const ctx = loadClosedCard();
  const trade = { symbol: 'BTCUSDC', realizedPnl: 0.12, realizedPnlPct: 1.2, status: 'CLOSED', residualDust: 0 };
  const liveSafe = ctx._fleetClosedTradeCardHtml(trade, ctx._esc, { showStartAgain: true, liveMode: true, canStartLive: true });
  assert.match(liveSafe, /START LIVE SPOT/);
  assert.match(liveSafe, /openStartLiveSpotModal\(\)/);
  assert.doesNotMatch(liveSafe, /START BOT AGAIN/);

  const liveLocked = ctx._fleetClosedTradeCardHtml(trade, ctx._esc, { showStartAgain: true, liveMode: true, canStartLive: false });
  assert.doesNotMatch(liveLocked, /START BOT AGAIN/);
  assert.doesNotMatch(liveLocked, /START LIVE SPOT/, 'hidden when live start is not safe');

  const testnetCard = ctx._fleetClosedTradeCardHtml(trade, ctx._esc, { showStartAgain: true, liveMode: false });
  assert.match(testnetCard, /START BOT AGAIN/, 'non-live keeps the testnet restart action');
});

// ── Source-level guarantees for the render branches (spec 2/4/6) ──
test('detail panel renders a live cockpit summary instead of a testnet detail by default', () => {
  assert.match(terminalJs, /Fleet\.selectedId = _fleetResolveSelectedId\(visibleSessions, Fleet\.selectedId, Fleet\.userSelected === true\);/);
  assert.match(terminalJs, /Live cockpit active\./);
});

test('explicitly opened testnet/paper session shows the archive banner with a back action', () => {
  assert.match(terminalJs, /ARCHIVED TESTNET\/PAPER SESSION — not live\./);
  assert.match(terminalJs, /onclick="_fleetClearUserSelection\(\)"/);
  assert.match(terminalJs, /function selectFleetSession\(id\) \{ Fleet\.selectedId = id; Fleet\.userSelected = true;/);
});

test('the live closed card scopes to live sessions and passes live-mode opts', () => {
  assert.match(terminalJs, /const closedScope = liveModeActive \? sessions\.filter\(_fleetSessionIsLive\) : sessions;/);
  assert.match(terminalJs, /liveMode: liveModeActive,/);
  assert.match(terminalJs, /canStartLive: !!liveCanStartEntry,/);
});
