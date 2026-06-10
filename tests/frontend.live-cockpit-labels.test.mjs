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

// Evaluate the real liveStopping/liveDisplayState slice from renderFleet so the
// header label is tested against the shipping logic, not a re-implementation.
function computeLiveDisplayState({ sessions, globalKillActive = false, liveRunning, liveOpen, liveState = 'LIVE READY - MICRO CAPS' }) {
  const startMarker = "  // \"LIVE STOPPING / CLOSING\" only applies";
  const endMarker = ': liveState;';
  const start = terminalJs.indexOf(startMarker);
  assert.notEqual(start, -1, 'liveDisplayState slice exists');
  const end = terminalJs.indexOf(endMarker, start) + endMarker.length;
  const slice = terminalJs.slice(start, end);
  const ctx = {
    sessions,
    globalKillActive,
    liveRunning,
    liveOpen,
    liveModeActive: sessions.some((s) => s.mode === 'live_spot'),
    liveState,
    _fleetOpenPositionCount: (s) => (Array.isArray(s && s.openPositions) ? s.openPositions.length : 0),
  };
  vm.createContext(ctx);
  vm.runInContext(slice + '; this.liveDisplayState = liveDisplayState;', ctx);
  return ctx.liveDisplayState;
}

// ── Spec 1: stopped flat live session is NOT "LIVE STOPPING / CLOSING" ──
test('a stopped, flat live session shows LIVE IDLE / READY, not LIVE STOPPING / CLOSING', () => {
  const state = computeLiveDisplayState({
    sessions: [{ mode: 'live_spot', status: 'stopped', stopRequested: true, openPositions: [] }],
    liveRunning: false,
    liveOpen: false,
  });
  assert.equal(state, 'LIVE IDLE / READY');
  assert.notEqual(state, 'LIVE STOPPING / CLOSING');
});

test('LIVE STOPPING / CLOSING shows only while an open live position is being closed', () => {
  const closing = computeLiveDisplayState({
    sessions: [{ mode: 'live_spot', status: 'stopping', stopRequested: true, openPositions: [{ symbol: 'BTCUSDC' }] }],
    liveRunning: true,
    liveOpen: true,
  });
  assert.equal(closing, 'LIVE STOPPING / CLOSING');
});

test('a running live session with an open position reads LIVE RUNNING - REAL MONEY', () => {
  const running = computeLiveDisplayState({
    sessions: [{ mode: 'live_spot', openPositions: [{ symbol: 'BTCUSDC' }], worker: { online: true } }],
    liveRunning: true,
    liveOpen: true,
  });
  assert.equal(running, 'LIVE RUNNING - REAL MONEY');
});

test('global kill switch overrides to LIVE PAUSED', () => {
  const paused = computeLiveDisplayState({
    sessions: [{ mode: 'live_spot', status: 'stopped', openPositions: [] }],
    globalKillActive: true,
    liveRunning: false,
    liveOpen: false,
  });
  assert.equal(paused, 'LIVE PAUSED');
});

// ── Spec 2: config header/note avoid TESTNET wording in live mode ──
function fakeConfigDoc() {
  const els = {
    'fleet-cfg-title': { textContent: 'BOT CONFIG (TESTNET, max trade ≤ $10)' },
    'fleet-cfg-note': { textContent: 'This form sets testnet caps only.' },
  };
  return { getElementById: (id) => els[id] || null, _els: els };
}

function loadUpdateLabels(document) {
  const ctx = { document, console };
  vm.createContext(ctx);
  vm.runInContext(extractFunctionSource('_fleetUpdateConfigLabels'), ctx);
  return ctx._fleetUpdateConfigLabels;
}

test('live cockpit config header is "BOT CONFIG / LIVE CAPS", never "BOT CONFIG (TESTNET...)"', () => {
  const document = fakeConfigDoc();
  const update = loadUpdateLabels(document);
  update(true);
  assert.equal(document._els['fleet-cfg-title'].textContent, 'BOT CONFIG / LIVE CAPS');
  assert.doesNotMatch(document._els['fleet-cfg-title'].textContent, /TESTNET/i);
  assert.doesNotMatch(document._els['fleet-cfg-note'].textContent, /testnet/i);
});

test('testnet mode keeps the original config header', () => {
  const document = fakeConfigDoc();
  const update = loadUpdateLabels(document);
  update(false);
  assert.equal(document._els['fleet-cfg-title'].textContent, 'BOT CONFIG (TESTNET, max trade ≤ $10)');
});

test('renderFleet syncs the config labels with live mode on every poll', () => {
  assert.match(terminalJs, /_fleetUpdateConfigLabels\(liveModeActive\);/);
  // The build-once form carries ids the updater targets.
  assert.match(terminalJs, /id="fleet-cfg-title"/);
  assert.match(terminalJs, /id="fleet-cfg-note"/);
});
