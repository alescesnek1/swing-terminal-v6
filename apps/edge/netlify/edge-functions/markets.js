// ─────────────────────────────────────────────────────────────
// Swing Terminal v7.0 — /api/markets Edge Function (Deno)
//
// V7.0 adds a panic_score field per row (computed client-side; the
// row shape is unchanged here but the schema version is bumped to
// flush every v6_8 isolate cache on the first request).
//
// V4 BUSINESS LOGIC: the screener is no longer Binance-bound.
// We pull the top-N coins by volume from CoinGecko (broader
// universe — DEX-only / multi-chain assets included) and merge
// real-time Binance ticker data wherever a USDC/USDT pair
// exists. Each row is tagged with `binance_available` + `pair`
// so the UI can render BIN / DEX badges and the analyze edge
// function can skip the Binance fetch for non-listed coins.
// ─────────────────────────────────────────────────────────────

// V4: pull a 7-day hourly sparkline so we can derive 4H and 12H % deltas
// (CoinGecko's /coins/markets endpoint does not expose those windows
// directly — only 1h, 24h, 7d, 14d, 30d). Plus the explicit windows.
import { logFatal, logWarn } from './lib/log.js';
import { verifyAuth, checkOrigin, pickAllowOrigin } from './lib/security.js';
import { getTier, COIN_CAPS, tierSeesDex, TIER_FREE, TIER_PRO } from './lib/tier.js';

const COINGECKO_MARKETS_URL_PAGE1 =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=true&price_change_percentage=1h,24h,7d';
const COINGECKO_MARKETS_URL_PAGE2 =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=2&sparkline=true&price_change_percentage=1h,24h,7d';
const COINGECKO_MARKETS_URL_PAGE3 =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=3&sparkline=true&price_change_percentage=1h,24h,7d';
const COINGECKO_MARKETS_URL_PAGE4 =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=4&sparkline=true&price_change_percentage=1h,24h,7d';
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const BINANCE_EXCHANGEINFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';
// V4 Premium: Binance USDⓈ-M Futures (a.k.a. "Alpha"). A LOT of coins
// flagged [DEX] today are actually live on Binance Futures — we want
// their funding/OI/orderbook for the AI analysis instead of falling
// back to CoinGecko-only fundamentals.
const BINANCE_FUTURES_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const BINANCE_FUTURES_EXCHANGEINFO_URL = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

const CDN_MAX_AGE_SEC = 30;
const CDN_SWR_SEC = 60;

const RESPONSE_CACHE_TTL_MS = CDN_MAX_AGE_SEC * 1000;
const EXCHANGEINFO_CACHE_TTL_MS = 60 * 60 * 1000;
const COINGECKO_CACHE_TTL_MS = 60 * 1000;

const QUOTE_PRIORITY = ['USDC', 'USDT'];
const FUT_QUOTE_PRIORITY = ['USDT', 'USDC'];

// V6.4: expanded to 1000 coins (4 CoinGecko pages). Movers tab needs
// the full breadth for accurate top/bottom gainers; heatmap capped at
// 500 client-side for performance.
const TOP_N = 1000;

// V6: schema-version namespace for cache invalidation. Every cached
// value is stamped with this string; any value whose stamp differs
// from the current MARKETS_SCHEMA_VERSION is treated as a cache MISS
// and rebuilt from upstream. Bump this whenever the row shape, gauntlet
// rules, or venue resolution logic changes — the bump alone is enough
// to nuke any survivor entries from long-lived isolates without code
// gymnastics. Equivalent to renaming a Redis key prefix on a stack
// that did use Redis. markets.js intentionally has no Upstash cache
// (per-isolate memory + 15s browser cache only), so this is the
// closest defensible equivalent.
// V6.7: bump invalidates every in-isolate cache so the new hybrid pipeline
// (CG-merged rows + appended Binance-only USDT spot rows + relaxed spot MC
// floor) takes effect on the next request without a deploy-side flush.
// V6.8 Sprint 1: bumped to v6_8 to nuke v6_7 entries that lacked the
// pre-sliced free/pro string variants.
// V7.0: bumped to v7_0_panic_stream so every legacy v6_8 isolate cache
// is invalidated on first hit after deploy — clients now compute a
// panic_score per row and the row shape MAY pick up additional fields
// at a later sprint. No upstream/shape change in this bump.
const MARKETS_SCHEMA_VERSION = 'v7_0_panic_stream';

// V6.8 Sprint 1 (FIX-6): _responseCache now carries the parsed array AND
// two pre-sliced JSON strings (free / pro). Tier filter is computed once
// at cache-write time, never on the hot path. Shape:
//   { at, v, full, freeBody, proBody, fullBody }
let _responseCache = null;
let _quoteIndex = null;           // { at, v, byBase }
let _futQuoteIndex = null;        // { at, v, byBase } (PERPETUAL only)
let _spotUsdtIndex = null;        // { at, v, byBase } — USDT-quoted spot ONLY
let _coingeckoCache = null;       // { at, v, list }

// V6.8 Sprint 1 (FIX-2): in-flight singletons. Concurrent cold-start
// requests collapse onto ONE upstream fetch instead of N. Each promise
// is nulled in `finally` so the next miss can refresh normally.
let _buildInFlight = null;
let _cgInFlight = null;
let _spotIdxInFlight = null;
let _futIdxInFlight = null;
let _spotUsdtIdxInFlight = null;

// CORS headers — delegate to pickAllowOrigin so localhost dev gets
// its Origin echoed back (browsers reject a wildcard "*" when credentials
// are involved, and previously a request from http://localhost:8888 to
// an APP_ORIGIN=https://prod.example would have echoed the production
// URL and the browser would reject the response).
function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request ? pickAllowOrigin(request) : (Deno.env.get('APP_ORIGIN') || '*'),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function cacheHeaders(request) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': `public, s-maxage=${CDN_MAX_AGE_SEC}, stale-while-revalidate=${CDN_SWR_SEC}`,
    ...corsHeaders(request),
  };
}

async function getQuoteIndex() {
  const now = Date.now();
  if (_quoteIndex && _quoteIndex.v === MARKETS_SCHEMA_VERSION && now - _quoteIndex.at < EXCHANGEINFO_CACHE_TTL_MS) return _quoteIndex.byBase;
  // V6.8 Sprint 1 (FIX-2): collapse concurrent misses onto one upstream fetch.
  if (_spotIdxInFlight) return _spotIdxInFlight;
  _spotIdxInFlight = (async () => {
    const res = await fetch(BINANCE_EXCHANGEINFO_URL, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
    const data = await res.json();
    const byBase = Object.create(null);
    for (const s of data.symbols || []) {
      if (s.status !== 'TRADING' || !s.isSpotTradingAllowed) continue;
      if (!QUOTE_PRIORITY.includes(s.quoteAsset)) continue;
      const existing = byBase[s.baseAsset];
      if (!existing || QUOTE_PRIORITY.indexOf(s.quoteAsset) < QUOTE_PRIORITY.indexOf(existing.quote)) {
        // V5 hotfix: carry the canonical baseAsset string explicitly so
        // shapeFromCoingecko can run its strict-equality check against it.
        byBase[s.baseAsset] = { base: s.baseAsset, quote: s.quoteAsset, pair: s.symbol };
      }
    }
    _quoteIndex = { at: Date.now(), v: MARKETS_SCHEMA_VERSION, byBase };
    return byBase;
  })();
  try { return await _spotIdxInFlight; } finally { _spotIdxInFlight = null; }
}

// V6.7 hybrid pipeline: USDT-only spot index. `getQuoteIndex` dedupes by
// base with USDC > USDT priority, which means a base like FOO that has
// FOOUSDT (but no FOOUSDC) is captured, but a base FOO with BOTH pairs
// only exposes FOOUSDC — and the scanner needs to see FOOUSDT separately
// so volatile mid/small-cap USDT books aren't masked by their USDC twin.
// This index keeps EVERY USDT-quoted spot pair available, one row per base.
async function getSpotUsdtIndex() {
  const now = Date.now();
  if (_spotUsdtIndex && _spotUsdtIndex.v === MARKETS_SCHEMA_VERSION && now - _spotUsdtIndex.at < EXCHANGEINFO_CACHE_TTL_MS) return _spotUsdtIndex.byBase;
  // V6.8 Sprint 1 (FIX-2): in-flight dedup.
  if (_spotUsdtIdxInFlight) return _spotUsdtIdxInFlight;
  _spotUsdtIdxInFlight = (async () => {
    const res = await fetch(BINANCE_EXCHANGEINFO_URL, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
    const data = await res.json();
    const byBase = Object.create(null);
    for (const s of data.symbols || []) {
      if (s.status !== 'TRADING' || !s.isSpotTradingAllowed) continue;
      if (s.quoteAsset !== 'USDT') continue;
      byBase[s.baseAsset] = { base: s.baseAsset, quote: 'USDT', pair: s.symbol };
    }
    _spotUsdtIndex = { at: Date.now(), v: MARKETS_SCHEMA_VERSION, byBase };
    return byBase;
  })();
  try { return await _spotUsdtIdxInFlight; } finally { _spotUsdtIdxInFlight = null; }
}

async function fetchBinanceTickerMap() {
  const res = await fetch(BINANCE_TICKER_URL, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`ticker/24hr HTTP ${res.status}`);
  const tickers = await res.json();
  const byPair = new Map();
  for (const t of tickers) byPair.set(t.symbol, t);
  return byPair;
}

// V4 Premium: futures (USDⓈ-M, perpetual only) variant. We index PERPETUAL
// contracts by base asset so coins NOT on spot can still be tagged [ALPHA]
// and analyzed with real Binance Futures data instead of falling through
// to a CoinGecko-only snapshot.
async function getFuturesQuoteIndex() {
  const now = Date.now();
  if (_futQuoteIndex && _futQuoteIndex.v === MARKETS_SCHEMA_VERSION && now - _futQuoteIndex.at < EXCHANGEINFO_CACHE_TTL_MS) return _futQuoteIndex.byBase;
  // V6.8 Sprint 1 (FIX-2): in-flight dedup.
  if (_futIdxInFlight) return _futIdxInFlight;
  _futIdxInFlight = (async () => {
    const res = await fetch(BINANCE_FUTURES_EXCHANGEINFO_URL, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error(`fut/exchangeInfo HTTP ${res.status}`);
    const data = await res.json();
    const byBase = Object.create(null);
    for (const s of data.symbols || []) {
      if (s.status !== 'TRADING') continue;
      if (s.contractType !== 'PERPETUAL') continue;
      if (!FUT_QUOTE_PRIORITY.includes(s.quoteAsset)) continue;
      const existing = byBase[s.baseAsset];
      if (!existing || FUT_QUOTE_PRIORITY.indexOf(s.quoteAsset) < FUT_QUOTE_PRIORITY.indexOf(existing.quote)) {
        // V5 hotfix: carry the canonical baseAsset string for the
        // strict-equality assertion in shapeFromCoingecko.
        byBase[s.baseAsset] = { base: s.baseAsset, quote: s.quoteAsset, pair: s.symbol };
      }
    }
    _futQuoteIndex = { at: Date.now(), v: MARKETS_SCHEMA_VERSION, byBase };
    return byBase;
  })();
  try { return await _futIdxInFlight; } finally { _futIdxInFlight = null; }
}

async function fetchBinanceFuturesTickerMap() {
  const res = await fetch(BINANCE_FUTURES_TICKER_URL, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`fut/ticker/24hr HTTP ${res.status}`);
  const tickers = await res.json();
  const byPair = new Map();
  // Futures ticker is an array; just like spot.
  if (Array.isArray(tickers)) {
    for (const t of tickers) byPair.set(t.symbol, t);
  }
  return byPair;
}

async function fetchCoingeckoMarkets() {
  const now = Date.now();
  if (_coingeckoCache && _coingeckoCache.v === MARKETS_SCHEMA_VERSION && now - _coingeckoCache.at < COINGECKO_CACHE_TTL_MS) return _coingeckoCache.list;
  // V6.8 Sprint 1 (FIX-2): in-flight singleton collapses concurrent CG
  // hits onto ONE 4-page fetch. CG's free tier global cap (~30 req/min)
  // was getting torched on cold-start fan-outs; this caps it at 4 / minute
  // regardless of caller concurrency.
  if (_cgInFlight) return _cgInFlight;
  _cgInFlight = (async () => {
    // V6.4: fan-out across 4 CoinGecko pages for top-1000 coverage.
    // Page 1 is mandatory; pages 2-4 are best-effort — if any 429s
    // or fails we still ship whatever succeeded.
    const pages = [
      COINGECKO_MARKETS_URL_PAGE1,
      COINGECKO_MARKETS_URL_PAGE2,
      COINGECKO_MARKETS_URL_PAGE3,
      COINGECKO_MARKETS_URL_PAGE4,
    ];
    const results = await Promise.allSettled(
      pages.map(url => fetch(url, { headers: { 'Accept': 'application/json' } }))
    );
    // Page 1 is mandatory
    if (results[0].status !== 'fulfilled' || !results[0].value.ok) {
      throw new Error(`coingecko/markets p1 HTTP ${results[0].status === 'fulfilled' ? results[0].value.status : results[0].reason}`);
    }
    const list1 = await results[0].value.json();
    if (!Array.isArray(list1)) throw new Error('coingecko/markets: unexpected payload (p1)');
    let combined = [...list1];
    // Pages 2-4: best-effort
    for (let i = 1; i < results.length; i++) {
      if (results[i].status === 'fulfilled' && results[i].value.ok) {
        try {
          const j = await results[i].value.json();
          if (Array.isArray(j)) combined = combined.concat(j);
        } catch (e) {
          console.warn(`[MARKETS] CG page${i+1} JSON parse failed:`, e.message);
        }
      } else {
        console.warn(`[MARKETS] CG page${i+1} unavailable, continuing with ${combined.length} coins`);
      }
    }
    _coingeckoCache = { at: Date.now(), v: MARKETS_SCHEMA_VERSION, list: combined };
    return combined;
  })();
  try { return await _cgInFlight; } finally { _cgInFlight = null; }
}

// Compute % change `hoursAgo` hours ago vs. the latest sparkline point.
// CoinGecko sparkline_in_7d returns roughly hourly prices for 7 days
// (~168 entries). Returns null when we lack enough history — caller
// renders that as "-" in the UI rather than a misleading 0%.
function pctFromSparkline(prices, hoursAgo) {
  if (!Array.isArray(prices) || prices.length < hoursAgo + 2) return null;
  const last = prices[prices.length - 1];
  const past = prices[prices.length - 1 - hoursAgo];
  if (!Number.isFinite(last) || !Number.isFinite(past) || past <= 0) return null;
  return +(((last - past) / past) * 100).toFixed(2);
}

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────────
// V4 Premium / V5 HOTFIX-2: venue resolver — STRICT EQUALITY MODE
// ─────────────────────────────────────────────────────────────
//
// A coin is promoted to BIN or ALPHA ONLY if EVERY ONE of these holds:
//
//   1. STRICT base-asset equality (===):
//        cg.symbol.toUpperCase().trim() === binance.baseAsset
//      (No .includes, no startsWith, no fuzzy match — full string only.)
//
//   2. The base asset MUST be in the LIVE /ticker/24hr list right now,
//      not just exchangeInfo. Inactive / paused / delisted bases that
//      still appear in exchangeInfo are rejected.
//
//   3. Price-proximity sanity (≤ 1.5× ratio). Aliased symbols across
//      different assets nearly always trade at very different prices.
//      The previous 3× threshold passed small-cap collisions; 1.5× is
//      tight enough to catch them.
//
//   4. Market-cap sanity (≥ $5M USD). Small-cap CG entries are the
//      primary class of false ALPHA — a brand-new $200k market-cap CG
//      token will never legitimately match an active Binance Futures
//      perp. If CG market_cap is below the floor, we refuse to promote
//      it to BIN/ALPHA even if the symbol matches.
//
// If ANY check fails → exchangeBadge = 'DEX'. Order of evaluation is
// fail-fast so a price-or-cap reject doesn't even consult the venue.
// All rejection paths are observable via console — every promotion AND
// every rejection logs a structured line so audits of "why is X tagged
// ALPHA / why isn't Y" take seconds, not minutes.

const PRICE_RATIO_MAX = 1.5;
// $50M floor. Binance Futures does not list micro-caps, so any
// CoinGecko entry below this threshold matching a Binance perp base
// is virtually guaranteed to be a symbol-collision false positive
// (production saw USELESS, VVV, SKYAI promoted to ALPHA at the prior
// $5M floor). $50M is well below any legitimate USDⓈ-M perp listing
// and well above every alias collision we've seen in production.
const MARKET_CAP_FLOOR_USD = 50_000_000;

function _pricesPlausiblyMatch(cgPrice, livePrice) {
  const c = parseFloat(cgPrice);
  const v = parseFloat(livePrice);
  // If we have no usable CG price we can't validate — REJECT the match.
  // Was previously permissive; production showed that permissive default
  // is exactly how aliased symbols sneak through.
  if (!Number.isFinite(c) || c <= 0) return false;
  if (!Number.isFinite(v) || v <= 0) return false;
  const ratio = Math.max(c, v) / Math.min(c, v);
  return ratio <= PRICE_RATIO_MAX;
}

function _strictBaseEquals(cgSymbol, binanceBaseAsset) {
  // ABSOLUTE EQUALITY. Both sides normalized exactly the same way:
  // trim whitespace + uppercase. No other transformation. No length
  // tolerance. No prefix/suffix stripping.
  const a = String(cgSymbol || '').trim().toUpperCase();
  const b = String(binanceBaseAsset || '').trim().toUpperCase();
  if (!a || !b) return false;
  return a === b;
}

function _hasMinimumMarketCap(cg) {
  const mc = Number(cg?.market_cap);
  if (!Number.isFinite(mc) || mc < MARKET_CAP_FLOOR_USD) return false;
  return true;
}

function shapeFromCoingecko(cg, spotTicker, spotMeta, futTicker, futMeta, liveFutPairs, liveSpotPairs) {
  const sym = String(cg.symbol || '').trim().toUpperCase();

  // ── ABSOLUTE VENUE GATE (UNBYPASSABLE) ──
  // Production saw USELESS / SKYAI / VVV slip through the gauntlet
  // because their CoinGecko market_cap was inflated past the floor.
  // The ONLY source of truth for "is this asset on Binance Futures?"
  // is the live /fapi/v1/ticker/24hr response — exchangeInfo can be
  // stale, the in-isolate caches can hold past listings, and any
  // CoinGecko-derived signal can be gamed by listing fraud.
  //
  // Rule: before ANY of the four downstream gauntlet gates runs, we
  // reconstruct the exact perp symbol from the CG base (sym+USDT,
  // sym+USDC) and demand a hit in liveFutPairs. If neither candidate
  // is in the LIVE ticker payload pulled this request, the futures
  // match is force-nulled — no exchangeInfo lookup, no cached state,
  // no market-cap-derived inference can revive it. Same for spot.
  //
  // The liveFutPairs / liveSpotPairs sets are passed in from the
  // caller (buildMarketsBody) which builds them directly from the
  // current ticker Map keys — they are guaranteed in-sync with the
  // ticker data and cannot be stubbed out by any cache layer.
  if (futTicker && futMeta && liveFutPairs instanceof Set) {
    const candidates = [`${sym}USDT`, `${sym}USDC`];
    const hit = candidates.find((p) => liveFutPairs.has(p));
    if (!hit) {
      console.warn(`[MARKETS] ALPHA force-rejected for ${sym} (cg.id=${cg.id}) — constructed pairs ${candidates.join('/')} not in LIVE futures ticker; cg_mc=${cg.market_cap}`);
      futTicker = null;
      futMeta = null;
    }
  }
  if (spotTicker && spotMeta && liveSpotPairs instanceof Set) {
    const candidates = [`${sym}USDC`, `${sym}USDT`];
    const hit = candidates.find((p) => liveSpotPairs.has(p));
    if (!hit) {
      console.warn(`[MARKETS] BIN force-rejected for ${sym} (cg.id=${cg.id}) — constructed pairs ${candidates.join('/')} not in LIVE spot ticker; cg_mc=${cg.market_cap}`);
      spotTicker = null;
      spotMeta = null;
    }
  }

  // ── STRICT VALIDATION GAUNTLET ──
  // Reject the futures match if ANY of the four gates fail. Same for spot.
  // We intentionally re-verify base equality here (even though the caller
  // already did the lookup) so the assignment logic is self-contained and
  // a future refactor of the caller can never bypass it.

  let futReject = null;
  if (futTicker && futMeta) {
    if (!_strictBaseEquals(sym, futMeta.base ?? sym)) {
      futReject = 'base-mismatch';
    } else if (!_pricesPlausiblyMatch(cg.current_price, futTicker.lastPrice)) {
      futReject = 'price-divergence';
    } else if (!_hasMinimumMarketCap(cg)) {
      futReject = 'market-cap-floor';
    }
    if (futReject) {
      console.warn(`[MARKETS] ALPHA rejected for ${sym} (cg.id=${cg.id}) — ${futReject}; cg_price=${cg.current_price} fut_price=${futTicker.lastPrice} cg_mc=${cg.market_cap}`);
      futTicker = null;
      futMeta = null;
    }
  }

  let spotReject = null;
  if (spotTicker && spotMeta) {
    if (!_strictBaseEquals(sym, spotMeta.base ?? sym)) {
      spotReject = 'base-mismatch';
    } else if (!_pricesPlausiblyMatch(cg.current_price, spotTicker.lastPrice)) {
      spotReject = 'price-divergence';
    }
    // V6.7: market-cap floor REMOVED for spot. The floor existed to suppress
    // false ALPHA promotions on Binance Futures (high collision rate on
    // micro-caps); spot is curated tightly enough by Binance's listing
    // process that a strict base-equality + price-proximity match is
    // sufficient. Without this relaxation, volatile small-cap USDT spot
    // pairs lost their Binance overwrite and reported stale CG values.
    if (spotReject) {
      console.warn(`[MARKETS] BIN rejected for ${sym} (cg.id=${cg.id}) — ${spotReject}; cg_price=${cg.current_price} spot_price=${spotTicker.lastPrice} cg_mc=${cg.market_cap}`);
      spotTicker = null;
      spotMeta = null;
    }
  }

  const onSpot = !!spotTicker && !!spotMeta;
  const onFutures = !!futTicker && !!futMeta;

  // Pick the venue that drives the live ticker fields. Spot beats
  // futures for price/volume because spot books are usually deeper
  // and the futures mark is funding-distorted.
  let venueTicker = null;
  let venueMeta = null;
  let venueMarket = null;       // 'spot' | 'futures' | null
  let exchangeBadge = 'DEX';

  if (onSpot) {
    venueTicker = spotTicker;
    venueMeta = spotMeta;
    venueMarket = 'spot';
    exchangeBadge = 'BIN';
  } else if (onFutures) {
    venueTicker = futTicker;
    venueMeta = futMeta;
    venueMarket = 'futures';
    exchangeBadge = 'ALPHA';
  }

  const onBinance = !!venueTicker;

  // Prefer the live venue ticker when present — it's more real-time
  // than CoinGecko's 60-90s lag.
  const price = onBinance ? parseFloat(venueTicker.lastPrice) : (cg.current_price || 0);
  const c24 = onBinance
    ? parseFloat(venueTicker.priceChangePercent)
    : safeNum(cg.price_change_percentage_24h_in_currency ?? cg.price_change_percentage_24h);
  const high = onBinance ? parseFloat(venueTicker.highPrice) : (cg.high_24h || 0);
  const low = onBinance ? parseFloat(venueTicker.lowPrice) : (cg.low_24h || 0);
  const qVol = onBinance ? parseFloat(venueTicker.quoteVolume) : (cg.total_volume || 0);
  const trades = onBinance && venueTicker.count != null ? parseInt(venueTicker.count, 10) : 0;

  // Multi-timeframe deltas. 1H and 7D come straight from the explicit
  // CoinGecko fields; 4H and 12H are derived from the hourly sparkline
  // because the public /coins/markets endpoint doesn't expose them.
  const sparkline = (cg.sparkline_in_7d && Array.isArray(cg.sparkline_in_7d.prices))
    ? cg.sparkline_in_7d.prices
    : (cg.sparkline_in_7d?.price && Array.isArray(cg.sparkline_in_7d.price)
        ? cg.sparkline_in_7d.price
        : null);

  const c1 = safeNum(cg.price_change_percentage_1h_in_currency);
  const c4 = pctFromSparkline(sparkline, 4);
  const c12 = pctFromSparkline(sparkline, 12);
  const c7d = safeNum(cg.price_change_percentage_7d_in_currency);

  return {
    id: String(cg.id || sym.toLowerCase()),
    symbol: sym,
    name: cg.name || sym,
    pair: venueMeta ? venueMeta.pair : null,
    quote: venueMeta ? venueMeta.quote : null,
    binance_available: onBinance,
    binance_market: venueMarket,                // 'spot' | 'futures' | null
    futures_pair: futMeta ? futMeta.pair : null,
    futures_quote: futMeta ? futMeta.quote : null,
    spot_pair: spotMeta ? spotMeta.pair : null,
    exchange: exchangeBadge,                    // 'BIN' | 'ALPHA' | 'DEX'
    image: cg.image || null,
    current_price: price,
    price_change_percentage_24h: c24 ?? 0,
    high_24h: high,
    low_24h: low,
    total_volume: qVol,
    base_volume: onBinance ? parseFloat(venueTicker.volume) : 0,
    trades_24h: trades,
    market_cap: cg.market_cap || 0,
    market_cap_rank: cg.market_cap_rank || 0,
    _funding: 0,
    _oi: 0,
    _oiDelta: 0,
    _takerRatio: 0.5,
    // null = "no data, render as -"; numbers (incl. 0) render normally.
    _c1: c1,
    _c4: c4,
    _c12: c12,
    _c24: c24,
    _c7d: c7d,
  };
}

// V6.7: synthesize a row for a Binance spot pair that has NO matching
// CoinGecko entry. CoinGecko's market-cap-ordered Top 1000 hides any
// high-volume Binance USDT spot listing whose global market cap puts
// it outside the top universe — exactly the cohort the scanner needs
// most. These rows skip the CG gauntlet entirely (there is no CG row
// to validate against) and are tagged BIN with market_cap=0 so the
// downstream tier filter and heatmap know to deprioritize them in
// market-cap views while the scanner still sees their live volume.
function _makeBinanceSpotRow(meta, ticker) {
  const sym = String(meta.base || '').toUpperCase();
  const c24 = parseFloat(ticker.priceChangePercent);
  return {
    id: sym.toLowerCase(),
    symbol: sym,
    name: sym,
    pair: meta.pair,
    quote: meta.quote,
    binance_available: true,
    binance_market: 'spot',
    futures_pair: null,
    futures_quote: null,
    spot_pair: meta.pair,
    exchange: 'BIN',
    image: null,
    current_price: parseFloat(ticker.lastPrice),
    price_change_percentage_24h: Number.isFinite(c24) ? c24 : 0,
    high_24h: parseFloat(ticker.highPrice),
    low_24h: parseFloat(ticker.lowPrice),
    total_volume: parseFloat(ticker.quoteVolume),
    base_volume: parseFloat(ticker.volume),
    trades_24h: ticker.count != null ? parseInt(ticker.count, 10) : 0,
    market_cap: 0,
    market_cap_rank: 0,
    _funding: 0,
    _oi: 0,
    _oiDelta: 0,
    _takerRatio: 0.5,
    _c1: null,
    _c4: null,
    _c12: null,
    _c24: Number.isFinite(c24) ? c24 : null,
    _c7d: null,
  };
}

// Legacy fallback path: if CoinGecko is down, we keep the screener
// alive with Binance-only data so the user isn't staring at a blank
// table. Same shape as the merged path. Now also includes futures-only
// (ALPHA) coins so a futures-listed asset still appears.
// V6.8 Sprint 1 (FIX-6): now returns the parsed ARRAY (not a JSON string)
// so the caller can build pre-sliced tier views once.
async function buildBinanceOnlyBody() {
  const [spotIdxRes, spotTickerRes, futIdxRes, futTickerRes] = await Promise.allSettled([
    getQuoteIndex(),
    fetchBinanceTickerMap(),
    getFuturesQuoteIndex(),
    fetchBinanceFuturesTickerMap(),
  ]);

  const spotIndex = spotIdxRes.status === 'fulfilled' ? spotIdxRes.value : {};
  const spotByPair = spotTickerRes.status === 'fulfilled' ? spotTickerRes.value : new Map();
  const futIndex = futIdxRes.status === 'fulfilled' ? futIdxRes.value : {};
  const futByPair = futTickerRes.status === 'fulfilled' ? futTickerRes.value : new Map();

  // Live pair Sets from the ticker Maps — built ONCE before the loop.
  // shapeFromCoingecko uses these as the absolute, unbypassable "is
  // this pair live on Binance?" gate.
  const liveFutPairs = new Set(futByPair.keys());
  const liveSpotPairs = new Set(spotByPair.keys());

  const bases = new Set([...Object.keys(spotIndex), ...Object.keys(futIndex)]);
  const rows = [];
  for (const base of bases) {
    const spotMeta = spotIndex[base] || null;
    const futMeta = futIndex[base] || null;
    const spotT = spotMeta ? spotByPair.get(spotMeta.pair) : null;
    const futT = futMeta ? futByPair.get(futMeta.pair) : null;
    const driverT = spotT || futT;
    if (!driverT) continue;

    const cgStub = {
      id: base.toLowerCase(),
      symbol: base,
      name: base,
      current_price: parseFloat(driverT.lastPrice),
      price_change_percentage_24h: parseFloat(driverT.priceChangePercent),
      high_24h: parseFloat(driverT.highPrice),
      low_24h: parseFloat(driverT.lowPrice),
      total_volume: parseFloat(driverT.quoteVolume),
      market_cap: 0,
      sparkline_in_7d: null,
    };
    rows.push(shapeFromCoingecko(cgStub, spotT || null, spotMeta, futT || null, futMeta, liveFutPairs, liveSpotPairs));
  }
  rows.sort((a, b) => b.total_volume - a.total_volume);
  // V6.8 Sprint 1 (FIX-6): return ARRAY; caller stringifies once.
  return rows.slice(0, TOP_N);
}

// V6.8 Sprint 1 (FIX-6): returns the parsed ARRAY. Caller (handler) is
// responsible for building the pre-sliced tier strings and caching all
// three views (full + free + pro) together.
async function buildMarketsBody() {
  // Five sources fired in parallel: CoinGecko universe, Binance Spot
  // exchangeInfo + ticker, Binance Futures exchangeInfo + ticker. Any
  // one that fails is recovered below. Futures sources failing is
  // non-fatal — the page just renders without ALPHA badges.
  const [cgRes, spotIdxRes, spotTickerRes, futIdxRes, futTickerRes, usdtIdxRes] = await Promise.allSettled([
    fetchCoingeckoMarkets(),
    getQuoteIndex(),
    fetchBinanceTickerMap(),
    getFuturesQuoteIndex(),
    fetchBinanceFuturesTickerMap(),
    getSpotUsdtIndex(),
  ]);

  // CoinGecko down → Binance-only fallback so the UI keeps working.
  if (cgRes.status !== 'fulfilled') {
    console.warn('[MARKETS] CoinGecko failed, falling back to Binance-only:', cgRes.reason?.message);
    return await buildBinanceOnlyBody();
  }

  const cgList = cgRes.value;
  const spotIndex = spotIdxRes.status === 'fulfilled' ? spotIdxRes.value : {};
  const spotByPair = spotTickerRes.status === 'fulfilled' ? spotTickerRes.value : new Map();
  const futIndex = futIdxRes.status === 'fulfilled' ? futIdxRes.value : {};
  const futByPair = futTickerRes.status === 'fulfilled' ? futTickerRes.value : new Map();

  // V5 hotfix: explicit allowlist of futures base assets that have a
  // LIVE ticker entry right now. exchangeInfo can carry stale / paused
  // entries that don't appear in /ticker/24hr — those must not promote
  // a coin to ALPHA. We re-derive futIndex through this gate so a
  // baseAsset that exists in exchangeInfo but NOT in the ticker list
  // gets dropped before it reaches shapeFromCoingecko.
  const liveFutBases = new Set();
  for (const meta of Object.values(futIndex)) {
    if (futByPair.has(meta.pair)) liveFutBases.add(meta.pair); // pair-keyed
  }
  function _liveFutMeta(symUpper) {
    const meta = futIndex[symUpper];
    if (!meta) return null;
    if (!futByPair.has(meta.pair)) return null; // no live ticker → not really listed
    return meta;
  }

  if (futIdxRes.status !== 'fulfilled') {
    console.warn('[MARKETS] Futures exchangeInfo failed:', futIdxRes.reason?.message);
  }

  // Live pair Sets from the ticker Maps — the ONLY source of truth for
  // "this pair is currently listed on Binance Futures / Spot." Built
  // directly from /fapi/v1/ticker/24hr and /api/v3/ticker/24hr response
  // keys, so they cannot be revived by a stale exchangeInfo cache,
  // a stale isolate-local quoteIndex, or any CoinGecko-derived signal.
  // shapeFromCoingecko's absolute venue gate consults these Sets first
  // and force-rejects to DEX if the constructed pair is missing.
  const liveFutPairs = new Set(futByPair.keys());
  const liveSpotPairs = new Set(spotByPair.keys());

  // Every CoinGecko row maps to ONE output row. If a coin isn't on
  // Binance Spot or Futures, it MUST still ship out tagged exchange:'DEX'
  // — otherwise the screener silently drops the entire DEX universe and
  // becomes a Binance-only table. Do NOT add a Binance-presence filter
  // here under any circumstances.
  let dexCount = 0;
  let binCount = 0;
  let alphaCount = 0;
  const rows = [];
  for (const cg of cgList) {
    const sym = String(cg.symbol || '').toUpperCase();
    // Even a missing symbol does NOT skip the row — fall back to id so
    // a CoinGecko-only entry (e.g. some long-tail token) still appears.
    const baseKey = sym || String(cg.id || '').toUpperCase();
    if (!baseKey) continue;
    const spotMeta = sym ? (spotIndex[sym] || null) : null;
    // V5 hotfix: only consider futures match if the base has a LIVE
    // ticker right now (drops stale exchangeInfo-only entries).
    const futMeta = sym ? _liveFutMeta(sym) : null;
    const spotTicker = spotMeta ? (spotByPair.get(spotMeta.pair) || null) : null;
    const futTicker = futMeta ? (futByPair.get(futMeta.pair) || null) : null;
    const row = shapeFromCoingecko(cg, spotTicker, spotMeta, futTicker, futMeta, liveFutPairs, liveSpotPairs);
    if (row.exchange === 'DEX') dexCount++;
    else if (row.exchange === 'ALPHA') alphaCount++;
    else if (row.exchange === 'BIN') binCount++;
    rows.push(row);
  }

  // Sort the CG-derived universe by market cap DESC first, then cap at
  // TOP_N. Doing this BEFORE the Binance append guarantees the appended
  // low-MC Binance-only rows survive the slice — otherwise the MC sort
  // would sink them and the slice would chop them off.
  rows.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
  const cgSliced = rows.slice(0, TOP_N);

  // V6.7 HYBRID APPEND — every Binance USDT spot pair that has NO
  // CoinGecko match yet (its base symbol isn't already a row) gets
  // synthesized into a BIN-tagged row. This is the fix for the V6.4/V6.5
  // regression where volatile Binance spot listings outside CG's top-1000
  // market-cap universe disappeared from the scanner. These rows go at
  // the tail of the response so market-cap-ordered consumers ignore them
  // by default while the volume-ordered scanner picks them up.
  const usdtSpotIndex = usdtIdxRes.status === 'fulfilled' ? usdtIdxRes.value : {};
  const seenSyms = new Set();
  for (const r of cgSliced) seenSyms.add(r.symbol);
  let binAppended = 0;
  for (const base of Object.keys(usdtSpotIndex)) {
    if (seenSyms.has(base)) continue;
    const meta = usdtSpotIndex[base];
    const t = spotByPair.get(meta.pair);
    if (!t) continue;
    const qv = parseFloat(t.quoteVolume);
    if (!Number.isFinite(qv) || qv <= 0) continue; // skip dead/stale pairs
    cgSliced.push(_makeBinanceSpotRow(meta, t));
    seenSyms.add(base);
    binAppended++;
  }

  console.log(`[MARKETS] built rows total=${rows.length} BIN=${binCount} ALPHA=${alphaCount} DEX=${dexCount} | bin_appended=${binAppended} | shipping=${cgSliced.length}`);
  // V6.8 Sprint 1 (FIX-6): return ARRAY; handler builds + caches the
  // pre-sliced tier strings.
  return cgSliced;
}

// V6.8 Sprint 1 (FIX-2): in-flight singleton around the WHOLE pipeline.
// Wraps buildMarketsBody so 100 concurrent cold-start callers see ONE
// upstream fan-out instead of 100. Returns the parsed array.
async function buildMarketsBodyDeduped() {
  if (_buildInFlight) return _buildInFlight;
  _buildInFlight = (async () => buildMarketsBody())();
  try { return await _buildInFlight; } finally { _buildInFlight = null; }
}

// V6.8 Sprint 1 (FIX-6): build the three pre-sliced JSON views once,
// store all of them in _responseCache. Tier filter cost moves from
// per-request (was JSON.parse + filter + stringify) to per-cache-miss
// (one pass, three strings).
function _buildCacheBundle(full) {
  const cap = COIN_CAPS[TIER_PRO] || 1000;
  const freeCap = COIN_CAPS[TIER_FREE] || 50;
  const includeDexForPro = tierSeesDex(TIER_PRO);
  // Pro view: include DEX, cap at pro limit (typically full).
  const proArr = includeDexForPro ? full.slice(0, cap) : full.filter(r => r.exchange !== 'DEX').slice(0, cap);
  // Free view: exclude DEX, cap at free limit.
  const freeArr = tierSeesDex(TIER_FREE)
    ? full.slice(0, freeCap)
    : full.filter(r => r.exchange !== 'DEX').slice(0, freeCap);
  return {
    full,
    fullBody: JSON.stringify(full),
    proBody: JSON.stringify(proArr),
    freeBody: JSON.stringify(freeArr),
  };
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  // Phase 3: tier-gated. Origin must be allowlisted, JWT required.
  // We auth even on the read path so the server is the source of
  // truth for cap + DEX visibility — UI clamps are not sufficient.
  const originCheck = checkOrigin(request);
  if (!originCheck.ok) {
    return new Response(JSON.stringify({ error: 'Forbidden origin', detail: originCheck.reason }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
  const auth = await verifyAuth(request);
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: 'Unauthorized', detail: auth.reason }), {
      status: auth.status,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
  const tier = getTier(auth.user);

  try {
    const now = Date.now();
    let bundle;
    if (_responseCache && _responseCache.v === MARKETS_SCHEMA_VERSION && now - _responseCache.at < RESPONSE_CACHE_TTL_MS) {
      bundle = _responseCache;
    } else {
      // V6.8 Sprint 1 (FIX-2): dedup-wrapped build.
      const fullArr = await buildMarketsBodyDeduped();
      // V6.8 Sprint 1 (FIX-6): build all three tier views once.
      bundle = { at: now, v: MARKETS_SCHEMA_VERSION, ..._buildCacheBundle(fullArr) };
      _responseCache = bundle;
    }
    // V6.8 Sprint 1 (FIX-6): O(1) tier lookup — no parse, no filter, no
    // stringify on the hot path.
    const body = tier === TIER_PRO ? bundle.proBody : bundle.freeBody;
    // V6.8 Sprint 1 (FIX-1): restore CDN caching. Cache-Control comes
    // straight from cacheHeaders() (s-maxage=30, SWR=60). MARKETS_SCHEMA_VERSION
    // bumps are the safe invalidation mechanism; `no-cache` was the wrong tool
    // and forced every authed request through to origin.
    const headers = {
      ...cacheHeaders(request),
      'X-Tier': tier,
      'X-Markets-Schema': MARKETS_SCHEMA_VERSION,
      'Vary': 'Authorization, Origin',
    };
    return new Response(body, { status: 200, headers });
  } catch (err) {
    logFatal({ location: 'markets/handler', error: err, payload: { cached_fallback_available: !!_responseCache, tier } });
    if (_responseCache) {
      const body = tier === TIER_PRO ? _responseCache.proBody : _responseCache.freeBody;
      return new Response(body, {
        status: 200,
        headers: { ...cacheHeaders(request), 'X-Served-From': 'stale-memory', 'X-Tier': tier, 'X-Markets-Schema': MARKETS_SCHEMA_VERSION },
      });
    }
    return new Response(JSON.stringify({ error: err.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(request) },
    });
  }
}
