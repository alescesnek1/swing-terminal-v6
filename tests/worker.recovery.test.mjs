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

const worker = await import('../scripts/local-binance-worker.mjs');
const { workerState, getOpenPositions, hydrateOpenPositionsFromBackend, closeAllPositions } = worker;

function reset() { workerState.positions.length = 0; }

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
