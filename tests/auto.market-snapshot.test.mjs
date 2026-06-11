// Local-worker public market snapshot — pure module tests.
//
// Proves: the snapshot fetcher only touches allowed PUBLIC spot endpoints with no
// API key/signature; base URL overrides are restricted to Binance hosts; the auto
// trader prefers a FRESH local snapshot over the Netlify public fetch; a stale
// snapshot is ignored; HTTP 451 on the Netlify path surfaces publicFetchError and
// falls back to the shadow allowlist; shadow still creates zero intents; live mode
// still restricts to LIVE_ALLOWED_SYMBOLS. No network, no secrets. Run: `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  fetchBinancePublicSnapshot,
  resolvePublicBaseUrl,
  PUBLIC_SNAPSHOT_SOURCE,
} from '../scripts/auto/binance-public.mjs';
import {
  evaluateAutoTrader,
  evaluateAutoTraderWithFallback,
  marketsFromSnapshot,
} from '../scripts/auto/auto-trader.mjs';

const ENV_SHADOW = { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'shadow' };
const FULL_LIVE_ENV = {
  AUTO_TRADER_ENABLED: 'true',
  AUTO_TRADER_MODE: 'live_spot',
  AUTO_LIVE_TRADING_ENABLED: 'true',
  BOT_LIVE_TRADING_ENABLED: 'true',
  BOT_ALLOW_REAL_ORDERS: 'true',
  LOCAL_WORKER_LIVE_CONFIRM: 'true',
  LIVE_SPOT_ACK: 'I_UNDERSTAND_REAL_MONEY_RISK',
};
const CAPS = { maxPositionUsd: 6, minPositionUsd: 6, maxDailyTrades: 2, maxDailyLossUsd: 5, maxOpenPositions: 1 };
const HEALTHY_FLEET = {
  durable: true, preflightFresh: true, workerOnline: true, openPositions: 0, pendingIntent: false,
  safetyLock: false, globalKill: false, sessionPaused: false, dailyTradesUsed: 0, dailyLossUsd: 0,
  freeQuote: 100, quoteAsset: 'USDC',
};

function snapshotMarket(over = {}) {
  return {
    symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', status: 'TRADING',
    quoteVolume: 5e8, volume: 1e4, bidPrice: 100000, askPrice: 100010,
    spreadPct: 0.01, priceChangePercent: 4, source: PUBLIC_SNAPSHOT_SOURCE,
    ...over,
  };
}
function freshSnapshot(markets, ageMs = 0) {
  return {
    source: PUBLIC_SNAPSHOT_SOURCE,
    fetchedAt: new Date(Date.now() - ageMs).toISOString(),
    markets,
  };
}

function fakeBinanceFetch(calls) {
  return async (url, options) => {
    calls.push({ url: String(url), headers: (options && options.headers) || {} });
    const u = String(url);
    if (u.includes('exchangeInfo')) {
      return { ok: true, json: async () => ({ symbols: [
        { symbol: 'BTCUSDC', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDC' },
        { symbol: 'ETHUSDC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDC' },
        { symbol: 'DOGEUSDT', status: 'TRADING', baseAsset: 'DOGE', quoteAsset: 'USDT' },
        { symbol: 'ETHBTC', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'BTC' },
        { symbol: 'BADUSDC', status: 'BREAK', baseAsset: 'BAD', quoteAsset: 'USDC' },
      ] }) };
    }
    if (u.includes('ticker/24hr')) {
      return { ok: true, json: async () => ([
        { symbol: 'BTCUSDC', priceChangePercent: '5.0', quoteVolume: '10000000', volume: '100' },
        { symbol: 'ETHUSDC', priceChangePercent: '-1.0', quoteVolume: '5000000', volume: '1000' },
        { symbol: 'DOGEUSDT', priceChangePercent: '1.0', quoteVolume: '2000000', volume: '9999' },
        { symbol: 'ETHBTC', priceChangePercent: '0.5', quoteVolume: '300', volume: '10' },
        { symbol: 'BADUSDC', priceChangePercent: '0', quoteVolume: '123', volume: '1' },
      ]) };
    }
    if (u.includes('ticker/bookTicker')) {
      return { ok: true, json: async () => ([
        { symbol: 'BTCUSDC', bidPrice: '100', askPrice: '101' },
        { symbol: 'ETHUSDC', bidPrice: '10', askPrice: '11' },
      ]) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// ── Spec test 1 + 2: only allowed public spot endpoints, no API key/secret ───
test('snapshot fetcher uses only allowed public spot endpoints and sends no API key', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = fakeBinanceFetch(calls);
  try {
    const snap = await fetchBinancePublicSnapshot();
    assert.equal(calls.length, 3);
    const allowed = ['/api/v3/exchangeInfo', '/api/v3/ticker/24hr', '/api/v3/ticker/bookTicker'];
    for (const c of calls) {
      const u = new URL(c.url);
      assert.ok(allowed.includes(u.pathname), `endpoint ${u.pathname} must be in the public allowlist`);
      assert.doesNotMatch(c.url, /\/order|fapi|dapi|sapi|signature|timestamp|margin|leverage/i);
      assert.ok(!c.headers['X-MBX-APIKEY'], 'no API key header sent');
      assert.ok(!JSON.stringify(c.headers).match(/secret|api[-_]?key/i), 'no credential-shaped headers');
    }
    assert.equal(snap.source, PUBLIC_SNAPSHOT_SOURCE);
  } finally {
    global.fetch = originalFetch;
  }
});

test('snapshot output is sanitized, TRADING + stable-quote only, volume-sorted and bounded', async () => {
  const originalFetch = global.fetch;
  global.fetch = fakeBinanceFetch([]);
  try {
    const snap = await fetchBinancePublicSnapshot();
    const syms = snap.markets.map((m) => m.symbol);
    // BREAK status and BTC-quoted pairs are excluded; USDT pair is allowed in the
    // snapshot (universe filters enforce USDC later).
    assert.deepEqual(syms, ['BTCUSDC', 'ETHUSDC', 'DOGEUSDT'], 'sorted by quoteVolume desc');
    const btc = snap.markets[0];
    assert.equal(btc.status, 'TRADING');
    assert.equal(btc.quoteVolume, 10000000);
    assert.equal(btc.priceChangePercent, 5);
    assert.equal(btc.bidPrice, 100);
    assert.equal(btc.askPrice, 101);
    assert.equal(btc.spreadPct, 1);
    assert.equal(btc.source, PUBLIC_SNAPSHOT_SOURCE);
    // Bounded list
    const capped = await fetchBinancePublicSnapshot({ maxMarkets: 1 });
    assert.equal(capped.markets.length, 1);
    assert.equal(capped.diagnostics.postedSymbols, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('base URL override is restricted to Binance public hosts and https', () => {
  assert.equal(resolvePublicBaseUrl('https://api.binance.com'), 'https://api.binance.com');
  assert.equal(resolvePublicBaseUrl('https://api1.binance.com/'), 'https://api1.binance.com');
  assert.equal(resolvePublicBaseUrl(undefined), 'https://api.binance.com');
  assert.throws(() => resolvePublicBaseUrl('https://evil.example'), /Disallowed hostname/);
  assert.throws(() => resolvePublicBaseUrl('http://api.binance.com'), /https/);
  assert.throws(() => resolvePublicBaseUrl('https://api.binance.com/sneaky'), /path/);
});

// ── Spec test 12: no forbidden namespaces introduced by the snapshot path ────
test('snapshot modules introduce no /fapi //dapi //sapi /order endpoints', () => {
  const src = fs.readFileSync(new URL('../scripts/auto/binance-public.mjs', import.meta.url), 'utf8');
  for (const re of [/\/fapi\//, /\/dapi\//, /\/sapi\//, /\/api\/v3\/order/, /X-MBX-APIKEY/]) {
    assert.doesNotMatch(src, re);
  }
});

test('marketsFromSnapshot maps snapshot fields onto the universe market shape', () => {
  const mapped = marketsFromSnapshot(freshSnapshot([snapshotMarket()]));
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].symbol, 'BTCUSDC');
  assert.equal(mapped[0].volume24hUsd, 5e8);
  assert.equal(mapped[0].quoteVolume24h, 5e8);
  assert.equal(mapped[0].change24hPct, 4);
  assert.equal(mapped[0].spreadPct, 0.01);
  assert.deepEqual(marketsFromSnapshot(null), []);
  assert.deepEqual(marketsFromSnapshot({ markets: 'junk' }), []);
});

// ── Spec tests 5 + 7 + 9: fresh snapshot beats Netlify fetch; shadow no intents ──
test('fresh local worker snapshot is used before the Netlify public fetch (shadow, zero intents)', async () => {
  const snapshot = freshSnapshot([snapshotMarket(), snapshotMarket({ symbol: 'ETHUSDC', baseAsset: 'ETH', quoteVolume: 2e8, priceChangePercent: 2 })], 30_000);
  let publicFetchCalled = false;
  const fetchPublicFn = async () => { publicFetchCalled = true; return []; };
  const { out } = await evaluateAutoTraderWithFallback({
    env: ENV_SHADOW, markets: [], caps: CAPS, fleet: HEALTHY_FLEET,
    localSnapshot: snapshot, snapshotFreshMs: 120000,
    threshold: 1, regime: { regime: 'RISK_ON', entriesAllowed: true },
  }, fetchPublicFn);
  assert.equal(publicFetchCalled, false, 'Netlify public fetch must NOT run when the snapshot is fresh');
  assert.equal(out.diagnostics.dataSource, 'local_worker_binance_public');
  assert.equal(out.diagnostics.snapshotUsed, true);
  assert.equal(out.diagnostics.fallbackUsed, false, 'fallbackUsed=false with usable USDC symbols');
  assert.equal(out.diagnostics.publicFetchAttempted, false);
  assert.ok(out.diagnostics.snapshotAgeMs >= 30_000 && out.diagnostics.snapshotAgeMs < 120_000);
  assert.ok(out.diagnostics.usdcSymbols >= 2);
  assert.ok(out.candidate, 'candidate from the real USDC universe');
  assert.equal(out.intent, null, 'shadow creates zero live/testnet intents');
  assert.equal(out.decision, 'SHADOW_BUY_SIGNAL');
});

// ── Spec test 6: stale snapshot is ignored ───────────────────────────────────
test('a stale snapshot is ignored and the Netlify public fetch runs instead', async () => {
  const snapshot = freshSnapshot([snapshotMarket()], 10 * 60 * 1000); // 10 min old
  let publicFetchCalled = false;
  const fetchPublicFn = async () => {
    publicFetchCalled = true;
    return [{ symbol: 'ETHUSDC', volume24hUsd: 10000000, spreadPct: 0.01, status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDC' }];
  };
  const { out } = await evaluateAutoTraderWithFallback({
    env: ENV_SHADOW, markets: [], caps: CAPS, fleet: HEALTHY_FLEET,
    localSnapshot: snapshot, snapshotFreshMs: 120000,
  }, fetchPublicFn);
  assert.equal(publicFetchCalled, true);
  assert.equal(out.diagnostics.snapshotUsed, false);
  assert.equal(out.diagnostics.dataSource, 'binance_public');
  assert.ok(out.diagnostics.snapshotAgeMs >= 10 * 60 * 1000, 'stale age is reported');
  assert.equal(out.intent, null);
});

// ── Spec test 8: snapshot missing + Netlify 451 → fallback + publicFetchError ──
test('missing snapshot + Netlify HTTP 451 surfaces publicFetchError and uses the allowlist fallback', async () => {
  const fetchPublicFn = async () => { throw new Error('exchangeInfo failed: Error: HTTP 451'); };
  const { out, events } = await evaluateAutoTraderWithFallback({
    env: ENV_SHADOW, markets: [], caps: CAPS, fleet: HEALTHY_FLEET,
    localSnapshot: null,
  }, fetchPublicFn);
  assert.equal(out.diagnostics.publicFetchAttempted, true);
  assert.equal(out.diagnostics.publicFetchOk, false);
  assert.match(out.diagnostics.publicFetchError, /451/);
  assert.equal(out.diagnostics.fallbackUsed, true);
  assert.equal(out.diagnostics.dataSource, 'fallback');
  assert.equal(out.candidate.symbol, 'BTCUSDC');
  assert.equal(out.intent, null, 'fallback path still creates zero intents in shadow');
  assert.ok(events.some((e) => e.type === 'AUTO_PUBLIC_FETCH_FAILED'));
});

// ── Spec test 10: live mode still restricts to LIVE_ALLOWED_SYMBOLS ──────────
test('live mode restricts snapshot-derived markets to LIVE_ALLOWED_SYMBOLS', () => {
  const markets = marketsFromSnapshot(freshSnapshot([
    snapshotMarket(),
    snapshotMarket({ symbol: 'ETHUSDC', baseAsset: 'ETH', quoteVolume: 9e8, priceChangePercent: 9 }),
  ]));
  const out = evaluateAutoTrader({
    env: FULL_LIVE_ENV, markets, caps: CAPS, fleet: HEALTHY_FLEET, threshold: 1,
    sessionId: 'sess_live', liveAllowedSymbols: ['BTCUSDC'],
    regime: { regime: 'RISK_ON', entriesAllowed: true },
  });
  assert.equal(out.universeSize, 1, 'only the allowlisted symbol survives in live mode');
  assert.ok(out.candidate);
  assert.equal(out.candidate.symbol, 'BTCUSDC');
  if (out.intent) assert.equal(out.intent.symbol, 'BTCUSDC');
});
