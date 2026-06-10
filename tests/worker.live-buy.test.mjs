// LIVE BUY-path tests (REAL MONEY safety). Imports the worker in live_spot mode and
// stubs Binance + control plane via global.fetch. Proves the worker independently
// re-checks the ACTUAL free quote balance (USDC) against the spend BEFORE submitting
// a real BUY order: an underfunded account is rejected cleanly with NO order placed,
// while a funded account proceeds. No network, no secrets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.WORKER_MODE = 'live_spot';
process.env.BINANCE_ENV = 'live_spot';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token-live-buy';
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.WORKER_SESSION_ID = `live_session_buy_${Date.now()}`;
process.env.BOT_LIVE_TRADING_ENABLED = 'true';
process.env.BOT_ALLOW_REAL_ORDERS = 'true';
process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
process.env.LIVE_MAX_POSITION_USD = '6';
delete process.env.BOT_GLOBAL_KILL_SWITCH;

const worker = await import('../scripts/local-binance-worker.mjs');
const { workerState, getOpenPositions, executeIntent, LIVE_PREFLIGHT_FILE } = worker;

// A fresh live preflight marker on disk so validateLiveIntentGate passes (the gate
// reads this file, not the control plane).
fs.writeFileSync(LIVE_PREFLIGHT_FILE, JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), accountType: 'SPOT' }));

const CONFIG = { minTradeUsd: 1, maxTradeUsd: 6, maxOpenPositions: 1, allowLive: true, pauseOnMarketCrash: true };
const SESSION = { liveModeConfirmed: true };
const CONTROL = { durable: true };

function reset() { workerState.positions.length = 0; workerState.usedKeys.length = 0; }

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

// `usdc` is the free USDC balance the live account reports on GET /v3/account.
function installFetch({ usdc = '20', price = '61200' }) {
  const calls = { buyOrders: 0, accountReads: 0, execResults: [], positionPosts: [] };
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/v3/order') && method === 'POST') {
      calls.buyOrders += 1;
      return jsonRes({ orderId: 'BUY-1', status: 'FILLED', executedQty: '0.00009000', cummulativeQuoteQty: '5.508', fills: [{ price, qty: '0.00009000', commission: '0', commissionAsset: 'BTC' }] });
    }
    if (u.includes('/v3/account')) {
      calls.accountReads += 1;
      return jsonRes({ balances: [{ asset: 'BTC', free: '0', locked: '0' }, { asset: 'USDC', free: String(usdc), locked: '0' }] });
    }
    if (u.includes('/v3/ticker/price')) return jsonRes({ symbol: 'BTCUSDC', price });
    if (u.includes('/v3/exchangeInfo')) {
      return jsonRes({ symbols: [{ symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
        { filterType: 'NOTIONAL', minNotional: '5' },
      ] }] });
    }
    if (u.includes('/api/bot/position-result')) { calls.positionPosts.push(JSON.parse(opts.body)); return jsonRes({ ok: true }); }
    if (u.includes('/api/bot/execution-result')) { calls.execResults.push(JSON.parse(opts.body)); return jsonRes({ ok: true }); }
    return jsonRes({ ok: true });
  };
  return calls;
}

function liveBuyIntent() {
  return { id: 'buy-i-1', idempotencyKey: `buy-k-${Date.now()}-${Math.random()}`, mode: 'live_spot', side: 'BUY', type: 'MARKET', symbol: 'BTCUSDC', positionUsd: 6 };
}

test('live BUY is REJECTED with NO order when free USDC (4.49) is below the spend', async () => {
  reset();
  const origFetch = global.fetch;
  const calls = installFetch({ usdc: '4.49147530' });
  try {
    await executeIntent(liveBuyIntent(), CONFIG, null, SESSION, CONTROL);
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(calls.buyOrders, 0, 'no real BUY order is submitted on an underfunded account');
  assert.equal(getOpenPositions().length, 0, 'no position is opened');
  const failed = calls.execResults.find((r) => r.status === 'failed');
  assert.ok(failed, 'reported a failed execution result');
  // The worker compares the parsed numeric balance (4.4914753) — defense in depth.
  assert.match(failed.error, /^Insufficient USDC balance\. Required 6, available 4\.4914753\.?$/);
});

test('live BUY proceeds when free USDC (20) covers the spend', async () => {
  reset();
  const origFetch = global.fetch;
  const calls = installFetch({ usdc: '20' });
  try {
    await executeIntent(liveBuyIntent(), CONFIG, null, SESSION, CONTROL);
  } finally {
    global.fetch = origFetch;
  }
  assert.equal(calls.buyOrders, 1, 'submits exactly one real BUY order when funded');
  assert.equal(getOpenPositions().length, 1, 'position opened after a funded BUY');
  assert.equal(getOpenPositions()[0].symbol, 'BTCUSDC');
});
