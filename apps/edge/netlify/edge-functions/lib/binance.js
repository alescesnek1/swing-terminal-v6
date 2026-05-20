// ─────────────────────────────────────────────────────────────
// Swing Terminal v3.0 — Binance On-Demand Fetcher (Deno Edge)
//
// One snapshot = parallel hits across spot + futures + macro:
//
//   Spot:
//     • /api/v3/ticker/24hr?symbol=…   (24h stats)
//     • /api/v3/depth?symbol=…&limit=50  (order book + whale walls)
//     • /api/v3/klines?symbol=…&interval=1d&limit=30  (7d / 30d %)
//
//   Futures (skipped silently for spot-only listings):
//     • /fapi/v1/premiumIndex?symbol=…
//     • /fapi/v1/openInterest?symbol=…
//
//   Macro (cached per isolate, ~30 s TTL):
//     • BTCUSDT 24h ticker as market benchmark
// ─────────────────────────────────────────────────────────────

const SPOT_BASE = 'https://api.binance.com';
const FUT_BASE = 'https://fapi.binance.com';

const FETCH_TIMEOUT_MS = 4500;
const ORDERBOOK_DEPTH = 50;

// Per-isolate macro cache. BTC's 24h % barely moves second-to-second
// and several requests landing on the same isolate inside half a
// minute should share one fetch.
let _btcBenchmarkCache = null;
const BTC_CACHE_TTL_MS = 30_000;

/**
 * Convert a UI symbol to a Binance pair symbol.
 *   "BTC"        → BTCUSDT
 *   "BTC/USDT"   → BTCUSDT
 *   "BTC/USDC"   → BTCUSDC
 *   "BTC:USDC"   → BTCUSDC
 *   "BTCUSDT"    → BTCUSDT
 */
export function normalizeBinanceSymbol(input) {
  const raw = String(input || '').toUpperCase().trim();
  if (!raw) return null;
  const stripped = raw.replace(/[\/:\- ]/g, '');
  if (!/^[A-Z0-9]+$/.test(stripped)) return null;

  const KNOWN_QUOTES = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'TUSD', 'BTC', 'ETH'];
  for (const q of KNOWN_QUOTES) {
    if (stripped.endsWith(q) && stripped.length > q.length) {
      return { pair: stripped, base: stripped.slice(0, -q.length), quote: q };
    }
  }
  return { pair: `${stripped}USDT`, base: stripped, quote: 'USDT' };
}

async function fetchJson(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${label} HTTP ${res.status}: ${body.slice(0, 140)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────
// Whale wall detection
// ─────────────────────────────────────────────────────────────

/**
 * Scan the top N levels per side and flag any level whose quantity
 * is materially larger than the rest — those are resting limit
 * orders big enough to act as price magnets / barriers.
 *
 * Heuristic (pick whichever fires):
 *   • qty ≥ 4× median of its side, OR
 *   • qty ≥ 8% of the cumulative depth on its side
 *
 * We keep up to top 3 walls per side, sorted by size desc.
 */
function detectWalls(levels, side) {
  if (!levels.length) return [];
  const qtys = levels.map(([, q]) => q).sort((a, b) => a - b);
  const median = qtys[Math.floor(qtys.length / 2)] || 0;
  const total = qtys.reduce((s, q) => s + q, 0) || 0;

  const candidates = levels
    .map(([price, qty], idx) => {
      const ratio = median > 0 ? qty / median : 0;
      const shareOfBook = total > 0 ? qty / total : 0;
      const isWall = ratio >= 4 || shareOfBook >= 0.08;
      return { price, qty, ratio: +ratio.toFixed(2), share: +shareOfBook.toFixed(3), depth_index: idx, side, isWall };
    })
    .filter((x) => x.isWall)
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 3);

  return candidates;
}

function summarizeOrderbook(depth) {
  if (!depth || !Array.isArray(depth.bids) || !Array.isArray(depth.asks)) return null;

  const bids = depth.bids.slice(0, ORDERBOOK_DEPTH).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  const asks = depth.asks.slice(0, ORDERBOOK_DEPTH).map(([p, q]) => [parseFloat(p), parseFloat(q)]);
  if (!bids.length || !asks.length) return null;

  const bestBid = bids[0][0];
  const bestAsk = asks[0][0];
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = mid > 0 ? ((bestAsk - bestBid) / mid) * 10_000 : 0;

  const sumQty = (rows) => rows.reduce((s, [, q]) => s + q, 0);
  const bidQty = sumQty(bids);
  const askQty = sumQty(asks);
  const total = bidQty + askQty;
  const imbalance = total > 0 ? (bidQty - askQty) / total : 0;

  return {
    levels_scanned: ORDERBOOK_DEPTH,
    best_bid: bestBid,
    best_ask: bestAsk,
    spread_bps: +spreadBps.toFixed(2),
    top5_bids: bids.slice(0, 5),
    top5_asks: asks.slice(0, 5),
    cumulative_bid_qty: +bidQty.toFixed(4),
    cumulative_ask_qty: +askQty.toFixed(4),
    imbalance: +imbalance.toFixed(4),
    walls: {
      bids: detectWalls(bids, 'bid'),
      asks: detectWalls(asks, 'ask'),
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Klines / multi-timeframe
// ─────────────────────────────────────────────────────────────

/**
 * Compute 7-day and 30-day percent change + range from daily klines.
 * Each kline = [openTime, open, high, low, close, volume, closeTime, ...].
 * Returns null if Binance has fewer than 7 daily candles for the pair
 * (brand-new listings) — the orchestrator surfaces this as N/A.
 */
function summarizeKlines(rows) {
  if (!Array.isArray(rows) || rows.length < 7) return null;

  const closes = rows.map((r) => parseFloat(r[4]));
  const highs = rows.map((r) => parseFloat(r[2]));
  const lows = rows.map((r) => parseFloat(r[3]));
  const last = closes[closes.length - 1];

  const window = (n) => {
    if (rows.length < n) return null;
    const slice = rows.slice(-n);
    const open = parseFloat(slice[0][1]);
    const wHigh = Math.max(...slice.map((r) => parseFloat(r[2])));
    const wLow = Math.min(...slice.map((r) => parseFloat(r[3])));
    const pct = open > 0 ? ((last - open) / open) * 100 : 0;
    return {
      window_days: n,
      open,
      close: last,
      high: wHigh,
      low: wLow,
      change_pct: +pct.toFixed(2),
      range_pct: wLow > 0 ? +(((wHigh - wLow) / wLow) * 100).toFixed(2) : 0,
    };
  };

  return {
    last_close: last,
    seven_day: window(7),
    thirty_day: window(30) || window(rows.length),
    candles_available: rows.length,
  };
}

// ─────────────────────────────────────────────────────────────
// BTC benchmark (cached per isolate)
// ─────────────────────────────────────────────────────────────

async function getBtcBenchmark() {
  const now = Date.now();
  if (_btcBenchmarkCache && now - _btcBenchmarkCache.at < BTC_CACHE_TTL_MS) {
    return _btcBenchmarkCache.value;
  }
  try {
    const t = await fetchJson(`${SPOT_BASE}/api/v3/ticker/24hr?symbol=BTCUSDT`, 'btc-benchmark');
    const value = {
      last_price: parseFloat(t.lastPrice),
      change_pct_24h: parseFloat(t.priceChangePercent),
      high_24h: parseFloat(t.highPrice),
      low_24h: parseFloat(t.lowPrice),
      quote_volume_24h: parseFloat(t.quoteVolume),
    };
    _btcBenchmarkCache = { at: now, value };
    return value;
  } catch (e) {
    console.warn('[BINANCE] BTC benchmark fetch failed:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Public: full snapshot
// ─────────────────────────────────────────────────────────────

// V5 (D-7): bounded LRU on the per-isolate snapshot cache. Old version
// was an unbounded Map keyed by `${market}:${pair}` — a long-lived
// isolate querying a churning altcoin set would grow it indefinitely.
// 200 entries is plenty for typical traffic (one entry per unique
// pair analyzed in the last minute) and bounds isolate memory.
const SNAPSHOT_CACHE_MAX = 200;
const _snapshotCache = new Map();
const SNAPSHOT_CACHE_TTL_MS = 60_000;

function _snapshotCacheSet(key, value) {
  if (_snapshotCache.has(key)) _snapshotCache.delete(key);
  _snapshotCache.set(key, value);
  // Drop the oldest entry once we cross the cap (Map iteration order
  // is insertion order, so the first key is the oldest).
  if (_snapshotCache.size > SNAPSHOT_CACHE_MAX) {
    const oldest = _snapshotCache.keys().next().value;
    if (oldest !== undefined) _snapshotCache.delete(oldest);
  }
}

export async function fetchBinanceSnapshot({ pair, base, quote, market = 'spot', futures_pair }) {
  const now = Date.now();
  // Cache key namespaces by market so an ALPHA snapshot (futures API)
  // can never collide with a spot snapshot for the same base asset.
  const cacheKey = `${market}:${pair}`;
  if (_snapshotCache.has(cacheKey)) {
    const cached = _snapshotCache.get(cacheKey);
    if (now - cached.at < SNAPSHOT_CACHE_TTL_MS) {
      return cached.data;
    }
    _snapshotCache.delete(cacheKey);
  }

  // ── Futures-only (ALPHA) branch ──
  // No spot listing → all data comes from /fapi. We still keep the
  // same return shape so analyze.js / orchestrator don't need a
  // dedicated branch — they just see "spot" populated from the
  // futures ticker, plus futures funding/OI like usual.
  if (market === 'futures') {
    return await fetchFuturesOnlySnapshot({ pair, base, quote, cacheKey });
  }

  const tickerUrl = `${SPOT_BASE}/api/v3/ticker/24hr?symbol=${pair}`;
  const depthUrl = `${SPOT_BASE}/api/v3/depth?symbol=${pair}&limit=${ORDERBOOK_DEPTH}`;
  const klinesUrl = `${SPOT_BASE}/api/v3/klines?symbol=${pair}&interval=1d&limit=30`;
  // Prefer the explicit futures_pair the caller resolved against /fapi
  // exchangeInfo — the legacy "swap quote to USDT" guess fails for the
  // increasing slice of pairs that are USDC-quoted on perps.
  const futPair = futures_pair || (quote === 'USDT' ? pair : `${base}USDT`);
  const fundingUrl = `${FUT_BASE}/fapi/v1/premiumIndex?symbol=${futPair}`;
  const oiUrl = `${FUT_BASE}/fapi/v1/openInterest?symbol=${futPair}`;

  const startedAt = Date.now();
  const [tickerR, depthR, klinesR, fundingR, oiR, btc] = await Promise.allSettled([
    fetchJson(tickerUrl, 'spot-ticker'),
    fetchJson(depthUrl, 'spot-depth'),
    fetchJson(klinesUrl, 'spot-klines'),
    fetchJson(fundingUrl, 'fut-premium'),
    fetchJson(oiUrl, 'fut-oi'),
    getBtcBenchmark(),
  ]);
  const fetchMs = Date.now() - startedAt;

  const errors = {};
  if (tickerR.status === 'rejected') errors.ticker = String(tickerR.reason?.message || tickerR.reason);
  if (depthR.status === 'rejected') errors.depth = String(depthR.reason?.message || depthR.reason);
  if (klinesR.status === 'rejected') errors.klines = String(klinesR.reason?.message || klinesR.reason);
  if (fundingR.status === 'rejected') errors.funding = String(fundingR.reason?.message || fundingR.reason);
  if (oiR.status === 'rejected') errors.openInterest = String(oiR.reason?.message || oiR.reason);

  if (tickerR.status !== 'fulfilled') {
    // V5 hotfix: spot ticker rejected (almost always HTTP 400 "Invalid
    // symbol" — the pair is futures-only). Auto-fallback to /fapi instead
    // of returning a 503 to the caller. This is the safety net for any
    // upstream that forgot to set market='futures'; analyze.js + briefing.js
    // now route explicitly, but this catches future regressions and any
    // edge case where the venue hint isn't available (e.g. a manual
    // symbol entry in the search box).
    const msg = String(tickerR.reason?.message || tickerR.reason || '');
    const looksLikeInvalidSymbol = /HTTP 400/i.test(msg) || /Invalid symbol/i.test(msg);
    if (looksLikeInvalidSymbol) {
      console.warn(`[BINANCE] spot ticker rejected for ${pair} — auto-falling back to /fapi`);
      try {
        const futResult = await fetchFuturesOnlySnapshot({ pair, base, quote, cacheKey });
        if (futResult && futResult.snapshot) {
          // Tag the snapshot so the orchestrator and the cache layer
          // know this was a venue-fallback hit (auditability).
          futResult.snapshot.spot_fallback_to_futures = true;
          futResult.venue_fallback = 'spot→futures';
          return futResult;
        }
      } catch (e) {
        console.warn(`[BINANCE] /fapi fallback ALSO failed for ${pair}: ${e.message}`);
      }
    }
    return { snapshot: null, partial: true, errors, fetch_ms: fetchMs };
  }

  const t = tickerR.value;
  const orderbook = depthR.status === 'fulfilled' ? summarizeOrderbook(depthR.value) : null;
  const multiTf = klinesR.status === 'fulfilled' ? summarizeKlines(klinesR.value) : null;
  const premium = fundingR.status === 'fulfilled' ? fundingR.value : null;
  const oi = oiR.status === 'fulfilled' ? oiR.value : null;
  const btcBench = btc.status === 'fulfilled' ? btc.value : null;

  // Relative strength vs. BTC over the last 24h.
  const ownC24 = parseFloat(t.priceChangePercent);
  const btcC24 = btcBench ? btcBench.change_pct_24h : null;
  const relStrengthVsBtc = btcC24 != null ? +((ownC24 - btcC24).toFixed(2)) : null;

  const futuresAvailable = !!(premium || oi);
  const futures = {
    available: futuresAvailable,
    mark_price: premium ? parseFloat(premium.markPrice) : 'N/A',
    index_price: premium ? parseFloat(premium.indexPrice) : 'N/A',
    funding_rate: premium ? parseFloat(premium.lastFundingRate) : 'N/A',
    next_funding_time: premium ? premium.nextFundingTime : 'N/A',
    open_interest_base: oi ? parseFloat(oi.openInterest) : 'N/A',
    note: futuresAvailable ? undefined : 'Pár není listován na Binance Futures (spot-only).',
  };

  const snapshot = {
    pair,
    futures_pair: futuresAvailable ? futPair : null,
    base,
    quote,
    fetched_at: new Date().toISOString(),
    fetch_ms: fetchMs,
    spot: {
      last_price: parseFloat(t.lastPrice),
      open_price: parseFloat(t.openPrice),
      high_24h: parseFloat(t.highPrice),
      low_24h: parseFloat(t.lowPrice),
      price_change_pct_24h: ownC24,
      base_volume_24h: parseFloat(t.volume),
      quote_volume_24h: parseFloat(t.quoteVolume),
      trades_24h: parseInt(t.count, 10),
      weighted_avg_price: parseFloat(t.weightedAvgPrice),
    },
    multi_timeframe: multiTf || { note: 'N/A — Binance has < 7d of daily candles for this pair (likely a fresh listing).' },
    orderbook,
    futures,
    macro: {
      btc_benchmark: btcBench || { note: 'N/A — BTC benchmark fetch failed.' },
      relative_strength_vs_btc_24h: relStrengthVsBtc != null ? relStrengthVsBtc : 'N/A',
    },
    errors: Object.keys(errors).length ? errors : undefined,
  };

  // partial = spot side incomplete (depth or klines missing). Missing
  // futures on a spot-only coin is *expected*, not partial.
  const partial = depthR.status !== 'fulfilled' || klinesR.status !== 'fulfilled';
  const result = { snapshot, partial, errors, fetch_ms: fetchMs, futuresAvailable };
  _snapshotCacheSet(cacheKey, { at: Date.now(), data: result });
  return result;
}

// ─────────────────────────────────────────────────────────────
// V4 Premium: ALPHA / futures-only snapshot
//
// For coins that aren't on Binance Spot but ARE on Binance Futures
// (USDⓈ-M perps), we still want a proper trading snapshot — funding,
// OI, depth, klines — instead of dropping back to a CoinGecko-only
// fundamentals view. Same return shape as the spot path so the
// orchestrator doesn't need a special branch.
// ─────────────────────────────────────────────────────────────

async function fetchFuturesOnlySnapshot({ pair, base, quote, cacheKey }) {
  // Hard-normalize the symbol before it ever touches /fapi. Anything the
  // frontend forwarded (lowercase, BTC/USDT, BTC-USDT, "btc") gets
  // collapsed to BTCUSDT / BTCUSDC. Without this, Binance Futures rejects
  // the request with "Invalid symbol" and we surface a generic 503.
  const KNOWN_FUT_QUOTES = ['USDT', 'USDC', 'BUSD'];
  const sanitize = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  let futSymbol = sanitize(pair);
  if (!futSymbol) futSymbol = sanitize(base) + (sanitize(quote) || 'USDT');
  if (!KNOWN_FUT_QUOTES.some((q) => futSymbol.endsWith(q))) {
    futSymbol = futSymbol + 'USDT';
  }
  pair = futSymbol;

  const tickerUrl = `${FUT_BASE}/fapi/v1/ticker/24hr?symbol=${pair}`;
  const depthUrl = `${FUT_BASE}/fapi/v1/depth?symbol=${pair}&limit=${ORDERBOOK_DEPTH}`;
  const klinesUrl = `${FUT_BASE}/fapi/v1/klines?symbol=${pair}&interval=1d&limit=30`;
  const fundingUrl = `${FUT_BASE}/fapi/v1/premiumIndex?symbol=${pair}`;
  const oiUrl = `${FUT_BASE}/fapi/v1/openInterest?symbol=${pair}`;

  const startedAt = Date.now();
  const [tickerR, depthR, klinesR, fundingR, oiR, btc] = await Promise.allSettled([
    fetchJson(tickerUrl, 'fut-ticker'),
    fetchJson(depthUrl, 'fut-depth'),
    fetchJson(klinesUrl, 'fut-klines'),
    fetchJson(fundingUrl, 'fut-premium'),
    fetchJson(oiUrl, 'fut-oi'),
    getBtcBenchmark(),
  ]);
  const fetchMs = Date.now() - startedAt;

  const errors = {};
  if (tickerR.status === 'rejected') errors.ticker = String(tickerR.reason?.message || tickerR.reason);
  if (depthR.status === 'rejected') errors.depth = String(depthR.reason?.message || depthR.reason);
  if (klinesR.status === 'rejected') errors.klines = String(klinesR.reason?.message || klinesR.reason);
  if (fundingR.status === 'rejected') errors.funding = String(fundingR.reason?.message || fundingR.reason);
  if (oiR.status === 'rejected') errors.openInterest = String(oiR.reason?.message || oiR.reason);

  if (tickerR.status !== 'fulfilled') {
    console.error(`[BINANCE/FUT] ticker rejected for ${pair}:`, errors.ticker, '| all errors:', JSON.stringify(errors));
    return { snapshot: null, partial: true, errors, fetch_ms: fetchMs, futuresAvailable: false };
  }

  const t = tickerR.value;
  const orderbook = depthR.status === 'fulfilled' ? summarizeOrderbook(depthR.value) : null;
  const multiTf = klinesR.status === 'fulfilled' ? summarizeKlines(klinesR.value) : null;
  const premium = fundingR.status === 'fulfilled' ? fundingR.value : null;
  const oi = oiR.status === 'fulfilled' ? oiR.value : null;
  const btcBench = btc.status === 'fulfilled' ? btc.value : null;

  const ownC24 = parseFloat(t.priceChangePercent);
  const btcC24 = btcBench ? btcBench.change_pct_24h : null;
  const relStrengthVsBtc = btcC24 != null ? +((ownC24 - btcC24).toFixed(2)) : null;

  const futuresAvailable = !!(premium || oi);
  const futures = {
    available: futuresAvailable,
    mark_price: premium ? parseFloat(premium.markPrice) : 'N/A',
    index_price: premium ? parseFloat(premium.indexPrice) : 'N/A',
    funding_rate: premium ? parseFloat(premium.lastFundingRate) : 'N/A',
    next_funding_time: premium ? premium.nextFundingTime : 'N/A',
    open_interest_base: oi ? parseFloat(oi.openInterest) : 'N/A',
  };

  const snapshot = {
    pair,
    futures_pair: pair,
    base,
    quote,
    fetched_at: new Date().toISOString(),
    fetch_ms: fetchMs,
    venue: 'binance-futures',
    binance_market: 'futures',
    binance_available: true,
    alpha_only: true,
    spot: {
      // The futures /ticker/24hr response has the same fields as spot
      // (lastPrice, openPrice, highPrice, lowPrice, priceChangePercent,
      // volume, quoteVolume, count, weightedAvgPrice). Mapping it into
      // the `spot` slot keeps the prompt structure stable for Gemini.
      last_price: parseFloat(t.lastPrice),
      open_price: parseFloat(t.openPrice),
      high_24h: parseFloat(t.highPrice),
      low_24h: parseFloat(t.lowPrice),
      price_change_pct_24h: ownC24,
      base_volume_24h: parseFloat(t.volume),
      quote_volume_24h: parseFloat(t.quoteVolume),
      trades_24h: t.count != null ? parseInt(t.count, 10) : 'N/A',
      weighted_avg_price: t.weightedAvgPrice != null ? parseFloat(t.weightedAvgPrice) : 'N/A',
      note: 'Pair is NOT on Binance Spot — fields above are from Binance Futures (USDⓈ-M perpetual). Treat as the live trading venue.',
    },
    multi_timeframe: multiTf || { note: 'N/A — Binance Futures has < 7d of daily candles for this perp.' },
    orderbook,
    futures,
    macro: {
      btc_benchmark: btcBench || { note: 'N/A — BTC benchmark fetch failed.' },
      relative_strength_vs_btc_24h: relStrengthVsBtc != null ? relStrengthVsBtc : 'N/A',
    },
    errors: Object.keys(errors).length ? errors : undefined,
  };

  const partial = depthR.status !== 'fulfilled' || klinesR.status !== 'fulfilled';
  const result = { snapshot, partial, errors, fetch_ms: fetchMs, futuresAvailable };
  _snapshotCacheSet(cacheKey, { at: Date.now(), data: result });
  return result;
}
