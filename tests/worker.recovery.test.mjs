// Worker recovery + close-path unit tests.
//
// Imports the worker module with the run-guard disabled (main() only runs when the
// file is the entry point), exercising the pure recovery/close functions. Binance
// is fully stubbed via global.fetch — no network, no real testnet, no secrets.
// Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

// Required worker env — set BEFORE import so the module's hard gates pass.
process.env.WORKER_MODE = 'testnet';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.WORKER_SESSION_ID = `session_test_${Date.now()}`;
process.env.BINANCE_TESTNET_BASE_OVERRIDE = 'http://127.0.0.1:9/api'; // localhost; never real testnet

import fs from 'node:fs';

const worker = await import('../scripts/local-binance-worker.mjs');
const {
  workerState, getOpenPositions, hydrateOpenPositionsFromBackend, closeAllPositions,
  executeIntent, handleMissingSession, runStopSequence, STATE_FILE, LOG_FILE,
} = worker;

function reset() { workerState.positions.length = 0; }

// A Binance + control-plane fetch stub. `orderResult(side)` lets callers force
// a SELL failure. `onPositionReport` observes report ordering.
function makeFetchStub(opts = {}) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes('/v3/exchangeInfo')) {
      return { ok: true, status: 200, json: async () => ({ symbols: [{ baseAsset: 'BTC', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '1' },
      ] }] }) };
    }
    if (u.includes('/v3/ticker/price')) return { ok: true, status: 200, json: async () => ({ price: '50000' }) };
    if (u.includes('/v3/order')) {
      const params = new URL(u).searchParams;
      const side = params.get('side');
      if (opts.failOrder) return { ok: false, status: 400, json: async () => ({ msg: 'forced failure' }) };
      return { ok: true, status: 200, json: async () => ({ orderId: side === 'SELL' ? 'close-x' : 'open-x', status: 'FILLED', executedQty: '0.00010000', cummulativeQuoteQty: '5' }) };
    }
    if (u.includes('/api/bot/position-result') && opts.onPositionReport) opts.onPositionReport();
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
}

test('worker-1/2: hydrates backend openPositions when local state is empty, marks backend-recovered', () => {
  reset();
  assert.equal(getOpenPositions().length, 0);
  const added = hydrateOpenPositionsFromBackend([
    { symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId: '2011533', status: 'open' },
  ]);
  assert.equal(added, true);
  const open = getOpenPositions();
  assert.equal(open.length, 1);
  assert.equal(open[0].symbol, 'BTCUSDT');
  assert.equal(open[0].source, 'backend-recovered');
});

test('worker-2: hydration is a no-op when a local open position already exists', () => {
  reset();
  workerState.positions.push({ symbol: 'BTCUSDT', orderId: 'local-1', status: 'open', executedQty: '0.001' });
  const added = hydrateOpenPositionsFromBackend([
    { symbol: 'ETHUSDT', orderId: 'backend-2', status: 'open', executedQty: '0.01' },
  ]);
  assert.equal(added, false);
  assert.equal(getOpenPositions().length, 1);
  assert.equal(getOpenPositions()[0].orderId, 'local-1'); // local state wins
});

test('worker-3/4: emergency close sells a hydrated BTCUSDT via MARKET SELL and moves it to closed', async () => {
  reset();
  hydrateOpenPositionsFromBackend([
    { symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId: '2011533', status: 'open', stepSize: '0.00001000' },
  ]);
  assert.equal(getOpenPositions().length, 1);

  const sells = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/v3/order')) {
      const params = new URL(u).searchParams;
      sells.push({ symbol: params.get('symbol'), side: params.get('side'), type: params.get('type') });
      return { ok: true, status: 200, json: async () => ({ orderId: 'close-1', status: 'FILLED', executedQty: '0.00015000' }) };
    }
    // control-plane reports (position-result) — accept everything.
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    const allClosed = await closeAllPositions('EMERGENCY');
    assert.equal(allClosed, true);
  } finally {
    global.fetch = origFetch;
  }

  assert.equal(sells.length, 1);
  assert.equal(sells[0].symbol, 'BTCUSDT');
  assert.equal(sells[0].side, 'SELL');
  assert.equal(sells[0].type, 'MARKET');
  assert.equal(getOpenPositions().length, 0); // moved open -> closed
  assert.equal(workerState.positions[0].status, 'closed');
});

test('worker-5: a failed close keeps the worker position open and reports not-all-closed', async () => {
  reset();
  hydrateOpenPositionsFromBackend([
    { symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId: '2011599', status: 'open', stepSize: '0.00001000' },
  ]);
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/v3/order')) {
      return { ok: false, status: 400, json: async () => ({ msg: 'insufficient balance' }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    const allClosed = await closeAllPositions('EMERGENCY');
    assert.equal(allClosed, false); // worker stays alive, position remains
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(getOpenPositions().length, 1);
});

test('worker-1/2: a BUY persists local open state BEFORE reporting to the backend, and the worker keeps the position', async () => {
  reset();
  let persistedBeforeReport = false;
  const origFetch = global.fetch;
  global.fetch = makeFetchStub({ onPositionReport: () => { persistedBeforeReport = getOpenPositions().length > 0; } });
  try {
    await executeIntent(
      { id: 'i-1', idempotencyKey: `k-${Date.now()}`, mode: 'testnet', side: 'BUY', type: 'MARKET', symbol: 'BTCUSDT', positionUsd: 5 },
      { minTradeUsd: 1, maxTradeUsd: 10, maxOpenPositions: 1 },
      null,
    );
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(persistedBeforeReport, true); // state written before the position-result POST
  assert.equal(getOpenPositions().length, 1); // worker continues holding the position after BUY
  assert.equal(getOpenPositions()[0].symbol, 'BTCUSDT');
});

test('worker-4: a hydrated/open position refuses a new BUY intent', async () => {
  reset();
  hydrateOpenPositionsFromBackend([{ symbol: 'BTCUSDT', executedQty: '0.0001', orderId: 'held-1', status: 'open', stepSize: '0.00001000' }]);
  let orderAttempted = false;
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('/v3/order')) orderAttempted = true;
    return makeFetchStub()(url, init);
  };
  try {
    await executeIntent(
      { id: 'i-2', idempotencyKey: `k2-${Date.now()}`, mode: 'testnet', side: 'BUY', type: 'MARKET', symbol: 'ETHUSDT', positionUsd: 5 },
      { minTradeUsd: 1, maxTradeUsd: 10, maxOpenPositions: 1 },
      null,
    );
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(orderAttempted, false); // max-open-positions gate blocked the BUY
  assert.equal(getOpenPositions().length, 1);
});

test('worker-8: worker-session missing WITH an open position enters recovery and does not fatally exit', async () => {
  reset();
  hydrateOpenPositionsFromBackend([{ symbol: 'BTCUSDT', executedQty: '0.0001', orderId: 'held-2', status: 'open', stepSize: '0.00001000' }]);
  const prevExit = process.exitCode;
  process.exitCode = undefined;
  const origFetch = global.fetch;
  global.fetch = makeFetchStub();
  try {
    await handleMissingSession({ sessionMissing: true, stopRequested: false });
  } finally {
    global.fetch = origFetch;
  }
  assert.notEqual(process.exitCode, 0); // did NOT clean-exit while holding a position
  assert.equal(getOpenPositions().length, 1);
  process.exitCode = prevExit;
});

test('worker-6: STOP closes the open position via MARKET SELL before exiting (exit code 0)', async () => {
  reset();
  hydrateOpenPositionsFromBackend([{ symbol: 'BTCUSDT', executedQty: '0.00010000', orderId: 'held-3', status: 'open', stepSize: '0.00001000' }]);
  const prevExit = process.exitCode;
  const sells = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('/v3/order') && new URL(String(url)).searchParams.get('side') === 'SELL') sells.push(1);
    return makeFetchStub()(url, init);
  };
  try {
    await runStopSequence();
  } finally {
    global.fetch = origFetch;
  }
  assert.ok(sells.length >= 1);
  assert.equal(getOpenPositions().length, 0);
  assert.equal(process.exitCode, 0); // clean exit after all positions closed
  process.exitCode = prevExit;
});

test('worker-G2: emergencyCloseRequested closes a backend-hydrated open position via MARKET SELL', async () => {
  reset();
  hydrateOpenPositionsFromBackend([{ symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId: 'hg2', status: 'open', stepSize: '0.00001000' }]);
  const sells = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes('/v3/order') && new URL(String(url)).searchParams.get('side') === 'SELL') sells.push(1);
    return makeFetchStub()(url, init);
  };
  try { await closeAllPositions('EMERGENCY'); } finally { global.fetch = origFetch; }
  assert.ok(sells.length >= 1);
  assert.equal(getOpenPositions().length, 0);
});

test('worker-G4: a failed close keeps the command actionable (position stays open, worker alive)', async () => {
  reset();
  hydrateOpenPositionsFromBackend([{ symbol: 'BTCUSDT', executedQty: '0.00015000', orderId: 'hg4', status: 'open', stepSize: '0.00001000' }]);
  const origFetch = global.fetch;
  global.fetch = makeFetchStub({ failOrder: true });
  let allClosed;
  try { allClosed = await closeAllPositions('EMERGENCY'); } finally { global.fetch = origFetch; }
  assert.equal(allClosed, false);
  assert.equal(getOpenPositions().length, 1); // remains so the close command stays relevant on the next poll
});

test('worker-9/10: importing/starting the worker creates its log file and per-session state file', () => {
  assert.ok(fs.existsSync(LOG_FILE), 'worker log file should exist');
  assert.ok(fs.existsSync(STATE_FILE), 'per-session state file should exist');
});
