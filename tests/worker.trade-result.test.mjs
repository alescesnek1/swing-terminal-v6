// Worker trade-result math + CLOSED_WITH_DUST reporting tests.
//
// Exercises the pure metrics helpers (avg price from fills, PnL, residual dust,
// sellable threshold) and the close path's CLOSED_WITH_DUST classification. Binance
// is fully stubbed via global.fetch — no network, no secrets. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

function approx(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(Number(actual) - Number(expected)) < eps, `expected ~${expected}, got ${actual}`);
}

// Required worker env — set BEFORE import so the module's hard gates pass.
process.env.WORKER_MODE = 'testnet';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.WORKER_SESSION_ID = `session_tr_${Date.now()}`;
process.env.BINANCE_TESTNET_BASE_OVERRIDE = 'http://127.0.0.1:9/api'; // localhost; never real testnet

const worker = await import('../scripts/local-binance-worker.mjs');
const {
  workerState, getOpenPositions, hydrateOpenPositionsFromBackend, closeAllPositions,
  avgPriceFromFills, residualDustQty, isResidualSellable, computeCloseMetrics,
} = worker;

function reset() { workerState.positions.length = 0; }

test('worker-1: avg price is computed from fills (qty-weighted), with summary fallback', () => {
  // Weighted: (100*1 + 200*3) / (1+3) = 700/4 = 175
  assert.equal(avgPriceFromFills([{ price: '100', qty: '1' }, { price: '200', qty: '3' }], '4', null), 175);
  // Fallback to cummulativeQuoteQty / executedQty when no fills.
  assert.equal(avgPriceFromFills(null, '0.00015000', '7.5'), 7.5 / 0.00015);
  assert.equal(avgPriceFromFills([], 'x', 'y'), null);
});

test('worker-3: residual dust is bought minus sold, never negative', () => {
  approx(residualDustQty('0.00015000', '0.00014000'), 0.00001);
  assert.equal(residualDustQty('0.00010000', '0.00010000'), 0);
  assert.equal(residualDustQty('0.0001', '0.0002'), 0); // clamps at 0
});

test('worker-4: residual below LOT_SIZE/MIN_NOTIONAL is not sellable', () => {
  // Below minQty.
  assert.equal(isResidualSellable(0.00001, 0.0001, 1, 50000), false);
  // Clears minQty but below minNotional (0.00001 * 50000 = 0.5 < 1).
  assert.equal(isResidualSellable(0.00001, 0.00001, 1, 50000), false);
  // Clears both floors.
  assert.equal(isResidualSellable(0.01, 0.00001, 1, 50000), true);
  // Zero/!finite is never sellable.
  assert.equal(isResidualSellable(0, 0.00001, 1, 50000), false);
});

test('worker-2/3: computeCloseMetrics derives PnL from cost basis of the SOLD portion', () => {
  const pos = { executedQty: '0.00015000', entryAvgPrice: 50000 }; // cost basis 50000/unit
  const close = { executedQty: '0.00015000', cummulativeQuoteQty: '8.25' }; // proceeds 8.25, avg 55000
  const m = computeCloseMetrics(pos, close, { minQty: '0.00001', minNotional: '1' });
  assert.equal(m.status, 'closed'); // no dust
  assert.equal(m.boughtQty, 0.00015);
  assert.equal(m.soldQty, 0.00015);
  assert.equal(m.residualDust, 0);
  approx(m.closeAvgPrice, 55000, 1e-6);
  // cost of sold = 50000 * 0.00015 = 7.5; proceeds 8.25; pnl = 0.75
  assert.ok(Math.abs(m.realizedPnl - 0.75) < 1e-9);
  assert.ok(Math.abs(m.realizedPnlPct - 10) < 1e-9); // 0.75 / 7.5 = 10%
  assert.equal(m.feesAvailable, false);
});

test('worker-4: computeCloseMetrics flags CLOSED_WITH_DUST when an unsellable remainder is left', () => {
  const pos = { executedQty: '0.00015000', entryAvgPrice: 50000 };
  const close = { executedQty: '0.00014000', cummulativeQuoteQty: '7.0' }; // sold less than bought
  const m = computeCloseMetrics(pos, close, { minQty: '0.00001', minNotional: '1' });
  assert.equal(m.status, 'CLOSED_WITH_DUST');
  approx(m.residualDust, 0.00001);
  assert.equal(m.residualSellable, false);
});

test('worker-4 (integration): closeAllPositions reports status CLOSED_WITH_DUST when SELL fills less than bought', async () => {
  reset();
  // No stepSize on the hydrated record → closeAllPositions fetches exchangeInfo and
  // picks up minQty + minNotional, so the sub-minNotional remainder is real dust.
  hydrateOpenPositionsFromBackend([
    { symbol: 'BTCUSDT', baseAsset: 'BTC', executedQty: '0.00015000', orderId: 'dust-1', status: 'open' },
  ]);
  // Set an entry avg so PnL is computable.
  getOpenPositions()[0].entryAvgPrice = 50000;
  getOpenPositions()[0].entryQuoteQty = '7.5';

  const reports = [];
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/v3/exchangeInfo')) {
      return { ok: true, status: 200, json: async () => ({ symbols: [{ baseAsset: 'BTC', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
        { filterType: 'NOTIONAL', minNotional: '1' },
      ] }] }) };
    }
    if (u.includes('/v3/order')) {
      // SELL fills 0.00014 of the 0.00015 bought → 0.00001 dust, worth 0.5 USDT (< minNotional 1).
      return { ok: true, status: 200, json: async () => ({ orderId: 'close-dust', status: 'FILLED', executedQty: '0.00014000', cummulativeQuoteQty: '7.0' }) };
    }
    if (u.includes('/api/bot/position-result')) {
      try { reports.push(JSON.parse(init.body)); } catch { /* ignore */ }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  let allClosed;
  try { allClosed = await closeAllPositions('STOP'); } finally { global.fetch = origFetch; }

  assert.equal(allClosed, true);
  assert.equal(getOpenPositions().length, 0); // flat for risk despite dust
  const closeReport = reports.find((r) => r.status === 'CLOSED_WITH_DUST');
  assert.ok(closeReport, 'a CLOSED_WITH_DUST position-result was reported');
  approx(closeReport.residualDust, 0.00001);
  assert.equal(closeReport.boughtQty, 0.00015);
  assert.equal(closeReport.soldQty, 0.00014);
  assert.ok(Number.isFinite(closeReport.realizedPnl));
  assert.equal(closeReport.closeOrderId, 'close-dust');
});
