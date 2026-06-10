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

function loadFns(names) {
  const ctx = { console };
  vm.createContext(ctx);
  vm.runInContext(names.map(extractFunctionSource).join('\n'), ctx);
  return ctx;
}

// ── Spec 7.1: stopped + flat live session reads as CLOSED, not STOPPING ──
test('a stopped live session with no open positions renders LIVE SESSION CLOSED', () => {
  const ctx = loadFns(['_fleetSessionIsLive', '_fleetWorkerOnline', '_fleetOpenPositionCount', '_fleetPrimaryState']);
  const closed = ctx._fleetPrimaryState({
    mode: 'live_spot', status: 'stopped', stopRequested: true,
    worker: { online: false, currentState: 'stopped' },
    openPositions: [], positionResults: [{ symbol: 'BTCUSDC', status: 'closed', closeOrderId: 'x' }],
  });
  assert.equal(closed.text, 'LIVE SESSION CLOSED');
  assert.notEqual(closed.text, 'STOPPING — CLOSING POSITIONS');
});

test('a live session still holding a position while stopping still reads STOPPING', () => {
  const ctx = loadFns(['_fleetSessionIsLive', '_fleetWorkerOnline', '_fleetOpenPositionCount', '_fleetPrimaryState']);
  const stopping = ctx._fleetPrimaryState({
    mode: 'live_spot', status: 'stopping', stopRequested: true,
    worker: { online: true }, openPositions: [{ symbol: 'BTCUSDC' }], positionResults: [],
  });
  assert.equal(stopping.text, 'STOPPING — CLOSING POSITIONS');
});

test('a flat stopping session with a lingering stopRequested flag is not STOPPING', () => {
  const ctx = loadFns(['_fleetSessionIsLive', '_fleetWorkerOnline', '_fleetOpenPositionCount', '_fleetPrimaryState']);
  // testnet flavour: online worker, stop requested, but already flat → not "closing".
  const flat = ctx._fleetPrimaryState({
    mode: 'testnet', status: 'stop_requested', stopRequested: true,
    worker: { online: true }, openPositions: [], positionResults: [],
  });
  assert.equal(flat.text, 'WORKER STOPPED — NO OPEN POSITIONS');
  assert.notEqual(flat.text, 'STOPPING — CLOSING POSITIONS');
});

// ── Spec 7.2: no stale/duplicate "open" position row when the session is closed ──
test('a closed position with a duplicate open row hides the phantom open row', () => {
  const ctx = loadFns(['_fleetOpenPositionCount', '_fleetPositionRowClosed', '_fleetVisiblePositionRows']);
  const sel = {
    status: 'stopped', openPositions: [],
    positionResults: [
      { symbol: 'BTCUSDC', executedQty: '0.00016000', orderId: 111, status: 'closed', closeOrderId: 222 },
      { symbol: 'BTCUSDC', executedQty: '0.00016000', orderId: 111, status: 'open' },
    ],
  };
  const rows = ctx._fleetVisiblePositionRows(sel);
  assert.equal(rows.length, 1, 'the stale open duplicate is dropped');
  assert.equal(rows[0].status, 'closed');
  assert.equal(rows.filter((r) => r.status === 'open').length, 0, 'no open row survives a closed session');
});

test('backend openPositions=0 suppresses any open row even without a duplicate', () => {
  const ctx = loadFns(['_fleetOpenPositionCount', '_fleetPositionRowClosed', '_fleetVisiblePositionRows']);
  const rows = ctx._fleetVisiblePositionRows({
    status: 'stopped', openPositions: [],
    positionResults: [{ symbol: 'BTCUSDC', orderId: 9, status: 'open' }],
  });
  assert.equal(rows.length, 0);
});

test('a genuinely open running session keeps its open row', () => {
  const ctx = loadFns(['_fleetOpenPositionCount', '_fleetPositionRowClosed', '_fleetVisiblePositionRows']);
  const rows = ctx._fleetVisiblePositionRows({
    status: 'running', openPositions: [{ symbol: 'BTCUSDC', orderId: 333 }],
    positionResults: [{ symbol: 'BTCUSDC', orderId: 333, status: 'open' }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'open');
});

// ── Spec 7.3: generic START BOT hidden/replaced in live mode ──
test('live mode never offers a generic START BOT in the top actions', () => {
  // The default-start branch is gated on liveModeActive → START LIVE SPOT or nothing.
  assert.match(terminalJs, /: liveModeActive\s*\n\s*\/\/ Live cockpit \(spec 1\)/);
  assert.match(terminalJs, /\? \(liveCanStartEntry \? '<button type="button" class="paperbot-control-btn paperbot-control-btn--live" onclick="openStartLiveSpotModal\(\)">START LIVE SPOT<\/button>' : ''\)/);
  assert.match(terminalJs, /: '<button id="fleet-start-btn"[^>]*onclick="startBotSession\(\)">START BOT<\/button>'\)/);
});

// ── Spec 7.4 + 7.5: one latest closed card; detailed trade table collapsed ──
test('detailed per-session trade card + ledger table live in a collapsed Trade details drawer', () => {
  assert.match(terminalJs, /<details class="fleet-history fleet-trade-details"><summary>Trade details \(/);
  // The single visible latest-closed card is the top cockpit card (scoped to live).
  assert.match(terminalJs, /const closedScope = liveModeActive \? sessions\.filter\(_fleetSessionIsLive\) : sessions;/);
});

// ── Spec 7.6: full event feed collapsed by default (last 5 shown) ──
test('event feed shows the latest 5 and collapses the rest under Advanced event log', () => {
  assert.match(terminalJs, /const recent = events\.slice\(0, 5\);/);
  assert.match(terminalJs, /<details class="fleet-history fleet-event-log"><summary>Advanced event log \(/);
});

// ── Spec 7 (flat note): explicit "No open live position" line ──
test('the detail panel states "No open ... position" when nothing is open', () => {
  assert.match(terminalJs, /No open ' \+ \(selLive \? 'live' : ''\) \+ ' position\./);
});
