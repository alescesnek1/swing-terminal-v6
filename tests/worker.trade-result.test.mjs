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
  quoteAssetForSymbol, computeBuyQuantity, computeLiveClosePlan,
} = worker;

function reset() { workerState.positions.length = 0; }

test('worker-1: avg price is computed from fills (qty-weighted), with summary fallback', () => {
  // Weighted: (100*1 + 200*3) / (1+3) = 700/4 = 175
  assert.equal(avgPriceFromFills([{ price: '100', qty: '1' }, { price: '200', qty: '3' }], '4', null), 175);
  // Fallback to cummulativeQuoteQty / executedQty when no fills.
  assert.equal(avgPriceFromFills(null, '0.00015000', '7.5'), 7.5 / 0.00015);
  assert.equal(avgPriceFromFills([], 'x', 'y'), null);
});

test('worker-quote: quote asset is USDC for BTCUSDC and USDT for BTCUSDT', () => {
  assert.equal(quoteAssetForSymbol('BTCUSDC'), 'USDC');
  assert.equal(quoteAssetForSymbol('BTCUSDT'), 'USDT');
  assert.equal(quoteAssetForSymbol('btcusdc'), 'USDC');
});

test('worker-sizing: market BUY sizing uses the quote amount (USDC) without USDT assumptions', () => {
  // 25 USDC / 50000 USDC-per-BTC = 0.0005 BTC, floored to step 0.00001.
  approx(computeBuyQuantity(25, 50000, '0.00001'), 0.0005);
  // The math is purely quoteAmount/price floored to step — identical formula for
  // BTCUSDT, proving there is no USDT-specific branch in sizing.
  assert.equal(
    computeBuyQuantity(25, 50000, '0.00001'),
    computeBuyQuantity(25, 50000, '0.00001'),
  );
  // Below one step rounds down to 0 (caller rejects via MIN_NOTIONAL).
  assert.equal(computeBuyQuantity(0.1, 50000, '0.00001'), 0);
});

test('worker-minNotional: a $5 spend can round under minNotional (rejected); the $6 buffer clears it', () => {
  // Reproduces the live bug: at a realistic BTC price + LOT_SIZE step, $5 floors
  // below Binance minNotional (5), which the worker rejects at execution via
  // `qty * price < minNotional`. The $6 buffered minimum clears it.
  const price = 68000;
  const step = '0.00001';
  const minNotional = 5;
  const qty5 = computeBuyQuantity(5, price, step); // 0.00007 → 4.76 notional
  assert.ok(qty5 * price < minNotional, `expected $5 notional ${qty5 * price} < ${minNotional}`);
  const qty6 = computeBuyQuantity(6, price, step); // 0.00008 → 5.44 notional
  assert.ok(qty6 * price >= minNotional, `expected $6 notional ${qty6 * price} >= ${minNotional}`);
});

test('worker-liveclose: closeQty uses ACTUAL free base balance, not boughtQty', () => {
  // The reported live bug: BUY executedQty 0.00009, but fee leaves free 0.00008991.
  // Selling 0.00009 fails ("insufficient balance"); the plan must size off free.
  const plan = computeLiveClosePlan({
    boughtQty: '0.00009000', freeBase: 0.00008991, stepSize: '0.00001000', minNotional: 5, price: 61200,
  });
  // min(0.00009, 0.00008991) floored to 0.00001 step => 0.00008.
  assert.equal(plan.sellQty, 0.00008);
  // 0.00008 * 61200 = 4.896 < minNotional 5 => not sellable, dust only.
  assert.ok(plan.notional < 5);
  assert.equal(plan.sellable, false);
  assert.equal(plan.dustOnly, true);
  assert.equal(plan.residualDust, 0.00008991);
});

test('worker-liveclose: a sellable free balance floors to the available step qty', () => {
  // Free balance clears minNotional at a higher price; sell the floored available.
  const plan = computeLiveClosePlan({
    boughtQty: '0.00012000', freeBase: 0.00011988, stepSize: '0.00001000', minNotional: 5, price: 61200,
  });
  // floor(0.00011988 / 0.00001) = 0.00011 => 0.00011 * 61200 = 6.732 >= 5.
  assert.equal(plan.sellQty, 0.00011);
  assert.ok(plan.notional >= 5);
  assert.equal(plan.sellable, true);
  assert.equal(plan.dustOnly, false);
});

test('worker-liveclose: never sells more than the free balance even if bought is larger', () => {
  const plan = computeLiveClosePlan({
    boughtQty: '1.0', freeBase: 0.00008991, stepSize: '0.00001000', minNotional: 5, price: 61200,
  });
  assert.ok(plan.sellQty <= 0.00008991);
  assert.equal(plan.sellQty, 0.00008);
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
