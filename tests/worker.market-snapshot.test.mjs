// Worker public market snapshot loop tests.
//
// Proves: the worker's snapshot fetch touches ONLY allowed public spot endpoints
// (no /order, /fapi, /dapi, /sapi), sends NO API key/secret anywhere (Binance or
// control plane), posts the sanitized snapshot to /api/bot/auto-market-snapshot,
// and NEVER throws — a total failure resolves quietly with diagnostics so the
// close/stop flow can never be blocked by market data. Binance and the control
// plane are fully stubbed via global.fetch. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';

// Required worker env — set BEFORE import so the module's hard gates pass.
process.env.WORKER_MODE = 'testnet';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_API_KEY = 'test-api-key-must-never-leak';
process.env.BINANCE_API_SECRET = 'test-api-secret-must-never-leak';
process.env.WORKER_SESSION_ID = `session_snap_${Date.now()}`;
process.env.BINANCE_TESTNET_BASE_OVERRIDE = 'http://127.0.0.1:9/api'; // localhost; never real testnet

const worker = await import('../scripts/local-binance-worker.mjs');
const { fetchAndPostMarketSnapshot } = worker;

function binanceOk(url) {
  const u = String(url);
  if (u.includes('exchangeInfo')) {
    return { ok: true, json: async () => ({ symbols: [
      { symbol: 'BTCUSDC', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDC' },
      { symbol: 'ETHUSDC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDC' },
    ] }) };
  }
  if (u.includes('ticker/24hr')) {
    return { ok: true, json: async () => ([
      { symbol: 'BTCUSDC', priceChangePercent: '5.0', quoteVolume: '10000000', volume: '100' },
      { symbol: 'ETHUSDC', priceChangePercent: '-1.0', quoteVolume: '5000000', volume: '1000' },
    ]) };
  }
  if (u.includes('ticker/bookTicker')) {
    return { ok: true, json: async () => ([
      { symbol: 'BTCUSDC', bidPrice: '100', askPrice: '101' },
      { symbol: 'ETHUSDC', bidPrice: '10', askPrice: '11' },
    ]) };
  }
  return null;
}

test('worker snapshot fetch uses only public endpoints, leaks no credentials, posts sanitized markets', async () => {
  const originalFetch = global.fetch;
  const binanceCalls = [];
  const controlPosts = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('binance')) {
      binanceCalls.push({ url: u, headers: options.headers || {} });
      const res = binanceOk(u);
      if (res) return res;
      throw new Error('unexpected binance endpoint: ' + u);
    }
    if (u.includes('/api/bot/auto-market-snapshot')) {
      controlPosts.push({ url: u, headers: options.headers || {}, body: options.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const result = await fetchAndPostMarketSnapshot();
    assert.equal(result.ok, true);
    assert.equal(result.count, 2);

    // Spec test 1: only allowed public spot endpoints, never /order //fapi //dapi //sapi.
    assert.equal(binanceCalls.length, 3);
    const allowed = ['/api/v3/exchangeInfo', '/api/v3/ticker/24hr', '/api/v3/ticker/bookTicker'];
    for (const c of binanceCalls) {
      const u = new URL(c.url);
      assert.ok(allowed.includes(u.pathname), `${u.pathname} must be an allowed public endpoint`);
      assert.doesNotMatch(c.url, /\/order|fapi|dapi|sapi|signature|timestamp|margin|leverage/i);
      // Spec test 2: no API key/secret on the public fetch.
      assert.ok(!c.headers['X-MBX-APIKEY'], 'no API key header on public fetch');
      assert.equal(JSON.stringify(c).includes('test-api-key-must-never-leak'), false);
      assert.equal(JSON.stringify(c).includes('test-api-secret-must-never-leak'), false);
    }

    // The control-plane post carries the worker token (endpoint auth) but NEVER the
    // Binance credentials, and the payload is the sanitized snapshot shape.
    assert.equal(controlPosts.length, 1);
    const post = controlPosts[0];
    assert.equal(post.headers['X-BOT-WORKER-TOKEN'], 'test-worker-token');
    assert.equal(String(post.body).includes('test-api-key-must-never-leak'), false);
    assert.equal(String(post.body).includes('test-api-secret-must-never-leak'), false);
    const body = JSON.parse(post.body);
    assert.equal(body.source, 'local_worker_binance_public');
    assert.ok(body.workerId);
    assert.ok(body.fetchedAt);
    assert.equal(body.markets.length, 2);
    assert.equal(body.markets[0].symbol, 'BTCUSDC');
    assert.equal(body.markets[0].source, 'local_worker_binance_public');
  } finally {
    global.fetch = originalFetch;
  }
});

// Spec test 11: the snapshot post must never block (or crash) the stop/close flow.
// Worst case — Binance unreachable AND the control plane unreachable — the function
// still resolves; it never throws and never retries in a loop.
test('worker snapshot failure resolves quietly with diagnostics and never throws', async () => {
  const originalFetch = global.fetch;
  const controlPosts = [];
  global.fetch = async (url, options = {}) => {
    const u = String(url);
    if (u.includes('binance')) throw new Error('HTTP 451');
    if (u.includes('/api/bot/auto-market-snapshot')) {
      controlPosts.push({ body: options.body });
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    throw new Error('unexpected fetch: ' + u);
  };
  try {
    const result = await fetchAndPostMarketSnapshot(); // must not throw
    assert.equal(result.ok, false);
    assert.match(result.error, /451/);
    // Diagnostics-only post: empty markets + the error message.
    assert.equal(controlPosts.length, 1);
    const body = JSON.parse(controlPosts[0].body);
    assert.deepEqual(body.markets, []);
    assert.match(body.diagnostics.error, /451/);
  } finally {
    global.fetch = originalFetch;
  }

  // Total blackout: even the diagnostics post fails — still resolves, no throw.
  global.fetch = async () => { throw new Error('network down'); };
  try {
    const result = await fetchAndPostMarketSnapshot();
    assert.equal(result.ok, false);
  } finally {
    global.fetch = originalFetch;
  }
});
