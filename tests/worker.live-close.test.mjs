// LIVE close-path tests (REAL MONEY safety). Imports the worker in live_spot mode
// and stubs Binance + control plane via global.fetch. Proves the worker:
//   - reads the ACTUAL free base balance before a live close (never sells boughtQty)
//   - closes-with-dust (NO SELL) when the sellable qty is below minNotional
//   - sells the floored available qty when it clears minNotional
//   - reconciles a deterministic insufficient-balance error to dust without retrying
//   - drops openPositions to 0 on a dust close
// No network, no secrets, and NO extra live orders are placed.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.WORKER_MODE = 'live_spot';
process.env.BINANCE_ENV = 'live_spot';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token-live-close';
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.WORKER_SESSION_ID = `live_session_close_${Date.now()}`;
process.env.BOT_LIVE_TRADING_ENABLED = 'true';
process.env.BOT_ALLOW_REAL_ORDERS = 'true';
process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
process.env.LIVE_MAX_POSITION_USD = '6';

const worker = await import('../scripts/local-binance-worker.mjs');
const { workerState, getOpenPositions, closeAllPositions } = worker;

function reset() { workerState.positions.length = 0; }

function jsonRes(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

// Build a global.fetch stub. `accounts` is a list of balance-array snapshots; each
// successive /v3/account read returns the next one (the last one repeats), so a
// reconciliation test can show a different balance on the second read.
function installFetch({ price = '61200', accounts, sellResponse, sellThrows }) {
  const calls = { sellOrders: 0, accountReads: 0, positionPosts: [], execResults: [] };
  const accountSeq = accounts.slice();
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || 'GET').toUpperCase();
    if (u.includes('/v3/order') && method === 'POST') {
      calls.sellOrders += 1;
      if (sellThrows) return jsonRes({ msg: sellThrows }, 400);
      return jsonRes(sellResponse);
    }
    if (u.includes('/v3/account')) {
      calls.accountReads += 1;
      const bal = accountSeq.length > 1 ? accountSeq.shift() : accountSeq[0];
      return jsonRes({ balances: bal });
    }
    if (u.includes('/v3/ticker/price')) return jsonRes({ symbol: 'BTCUSDC', price });
    if (u.includes('/v3/exchangeInfo')) {
      return jsonRes({ symbols: [{ symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', filters: [
        { filterType: 'LOT_SIZE', stepSize: '0.00001000', minQty: '0.00001000' },
        { filterType: 'NOTIONAL', minNotional: '5' },
      ] }] });
    }
    if (u.includes('/api/bot/position-result')) {
      calls.positionPosts.push(JSON.parse(opts.body));
      return jsonRes({ ok: true });
    }
    if (u.includes('/api/bot/execution-result')) {
      calls.execResults.push(JSON.parse(opts.body));
      return jsonRes({ ok: true });
    }
    // heartbeat / ack / anything else
    return jsonRes({ ok: true });
  };
  return calls;
}

function openLivePosition(overrides = {}) {
  workerState.positions.push({
    symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC',
    executedQty: '0.00009000', orderId: '9535259531',
    sessionId: process.env.WORKER_SESSION_ID, status: 'open',
    openedAt: new Date().toISOString(),
    stepSize: '0.00001000', minQty: '0.00001000', minNotional: '5',
    entryAvgPrice: 61000,
    ...overrides,
  });
}

const BTC_BALANCE = (free) => [{ asset: 'BTC', free: String(free), locked: '0' }, { asset: 'USDC', free: '10', locked: '0' }];

test('live close with fee-reduced dust below minNotional closes WITH DUST and never SELLs', async () => {
  reset();
  worker._resetStoppingForTest?.();
  // Exact evidence from the incident: bought 0.00009, free 0.00008991, step 0.00001,
  // price ~61200 => sellable 0.00008 worth ~4.89 < minNotional 5.
  const calls = installFetch({ price: '61200', accounts: [BTC_BALANCE('0.00008991')] });
  openLivePosition();

  const allClosed = await closeAllPositions('STOP');

  assert.equal(calls.sellOrders, 0, 'no MARKET SELL is attempted for unsellable dust');
  assert.equal(allClosed, true, 'closeAllPositions reports done (nothing actionable left)');
  assert.equal(getOpenPositions().length, 0, 'openPositions drops to 0');
  assert.ok(calls.accountReads >= 1, 'read the real account balance before closing');

  const close = calls.positionPosts.find((p) => p.status === 'CLOSED_WITH_DUST');
  assert.ok(close, 'reported CLOSED_WITH_DUST');
  assert.equal(close.closeOrderId, null, 'no close order id (no SELL happened)');
  assert.equal(Number(close.soldQty), 0);
  assert.equal(Number(close.residualDust), 0.00008991, 'residual dust = free base balance');
  assert.equal(close.closeReason, 'DUST_ONLY_CLOSE_NOT_POSSIBLE');
});

test('live close with a sellable free balance SELLs the floored available qty', async () => {
  reset();
  worker._resetStoppingForTest?.();
  const calls = installFetch({
    price: '61200',
    accounts: [BTC_BALANCE('0.00011988')],
    sellResponse: { orderId: 'SELL-9', status: 'FILLED', executedQty: '0.00011000', cummulativeQuoteQty: '6.732', fills: [{ price: '61200', qty: '0.00011000', commission: '0', commissionAsset: 'USDC' }] },
  });
  openLivePosition({ executedQty: '0.00012000', orderId: 'ORD-SELLABLE' });

  const allClosed = await closeAllPositions('STOP');

  assert.equal(calls.sellOrders, 1, 'submits exactly one MARKET SELL');
  assert.equal(allClosed, true);
  assert.equal(getOpenPositions().length, 0);
  const close = calls.positionPosts.find((p) => p.closeOrderId === 'SELL-9');
  assert.ok(close, 'reported the close referencing the SELL order');
  // The order qty must be the floored AVAILABLE balance (0.00011), not bought 0.00012.
  assert.equal(Number(close.soldQty), 0.00011);
});

test('deterministic insufficient-balance error reconciles to dust without a retry loop', async () => {
  reset();
  worker._resetStoppingForTest?.();
  // Pre-check sees a sellable balance, but the SELL fails with insufficient balance;
  // reconciliation then reads dust and closes-with-dust — no repeated SELL attempts.
  const calls = installFetch({
    price: '61200',
    accounts: [BTC_BALANCE('0.00011988'), BTC_BALANCE('0.00008000')],
    sellThrows: 'Account has insufficient balance for requested action',
  });
  openLivePosition({ executedQty: '0.00012000', orderId: 'ORD-RACE' });

  const allClosed = await closeAllPositions('STOP');

  assert.equal(calls.sellOrders, 1, 'only ONE SELL attempt — no 5x retry on a deterministic error');
  assert.equal(allClosed, true, 'reconciled close lets the worker finish');
  assert.equal(getOpenPositions().length, 0);
  const close = calls.positionPosts.find((p) => p.status === 'CLOSED_WITH_DUST');
  assert.ok(close, 'reconciled to CLOSED_WITH_DUST');
  assert.equal(close.closeReason, 'DUST_ONLY_CLOSE_NOT_POSSIBLE');
});
