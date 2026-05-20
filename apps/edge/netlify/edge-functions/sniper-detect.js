// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — /api/sniper-detect (Sniper Limit Protocol)
//
// Goal: surface "bid walls" — heavy resting buy-limit clusters in
// the order book that sit 5–15 % below the current mark. A coin
// trading within 2 % of such a wall is a high-probability mean-
// reversion target: market-makers will defend the cluster, the
// wick into it tends to fill limit orders, and the bounce off the
// wall is the cleanest scalp setup we can detect mechanically.
//
// Pipeline:
//   1. Pull top-N USDⓈ-M perpetuals by 24h quoteVolume (one cheap call
//      to /fapi/v1/ticker/24hr — same call funding-divergence makes,
//      so isolates that already cached it pay zero extra weight).
//   2. For each pair, fetch /fapi/v1/depth?limit=100 in bounded
//      concurrency (8-wide). Spot depth is only used if a base is
//      not on perps (kept off by default — the scan is futures-first
//      since that's where the leveraged liquidations and reversion
//      plays actually happen).
//   3. Detect the largest bid cluster within [-15 %, -5 %] of mark.
//      A "cluster" = price band ±0.5 % around the candidate level,
//      summed. We score by USD notional, not by base qty, so a
//      $5M wall in SOL beats a 1 000-base wall in PEPE.
//   4. Combine wall location with proximity to 24h low for the final
//      optimal_limit_entry — we lift the entry slightly above the
//      densest level so we don't sit BEHIND the wall in the queue.
//   5. Emit a signal whenever current price is within 2 % of that
//      entry. Frontend stamps the SNIPER badge and the detail panel
//      shows the Optimal Limit Entry + wall size box.
//
// Caching: 60 s memory + 60 s Redis. Single shared payload across all
// users — sniper math is market-wide, not per-tier.
// ─────────────────────────────────────────────────────────────

import { checkOrigin, pickAllowOrigin, verifyAuth } from './lib/security.js';
import { getRedis } from './lib/redis.js';
import { logFatal, logWarn } from './lib/log.js';

const FUT_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const FUT_DEPTH_URL  = 'https://fapi.binance.com/fapi/v1/depth';
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60 * 1000;
const REDIS_KEY = 'sniper:v1';

// Scan budget. Each /depth call at limit=100 = weight 5 on /fapi
// (1200/min budget), so 60 pairs = 300 weight per scan — safe margin.
const SCAN_TOP_N = 60;
const DEPTH_LIMIT = 100;
const CONCURRENCY = 8;

// Wall search window: only bids that sit 5 %–15 % below mark count.
// Below 5 % is "current support, already in play"; below 15 % is
// "too far away to anchor an entry this session."
const WALL_MIN_DROP_PCT = 5;
const WALL_MAX_DROP_PCT = 15;

// Wall cluster half-width (% around the candidate level). Liquidity
// rarely sits on a single tick — accountants stack limits in a band.
const CLUSTER_HALF_WIDTH_PCT = 0.5;

// Minimum USD notional for a level to qualify as a "wall." Below this
// it's just routine retail liquidity and not a magnet for price.
const WALL_MIN_NOTIONAL_USD = 250_000;

// Wall must be at least N× the median bid notional inside the window
// to be considered a true cluster vs. uniform book depth.
const WALL_RELATIVE_RATIO = 3.0;

// Sniper trigger: current price within this % of optimal entry.
const TRIGGER_PROXIMITY_PCT = 2.0;

// Entry buffer above the wall (so we don't queue behind it).
const ENTRY_LIFT_PCT = 0.15;

let _memoryCache = null; // { at, body }

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': pickAllowOrigin(request),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Vary': 'Origin',
  };
}

async function fetchWithTimeout(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

// Top-N USDⓈ-M perpetuals by quote volume, USDT/USDC-quoted only.
async function topPerpsByVolume(n) {
  const tickers = await fetchWithTimeout(FUT_TICKER_URL, 'sniper/ticker');
  if (!Array.isArray(tickers)) return [];
  const filtered = tickers
    .filter((t) => typeof t.symbol === 'string' && (t.symbol.endsWith('USDT') || t.symbol.endsWith('USDC')))
    .map((t) => ({
      symbol: t.symbol,
      lastPrice: parseFloat(t.lastPrice),
      lowPrice: parseFloat(t.lowPrice),
      highPrice: parseFloat(t.highPrice),
      priceChangePct: parseFloat(t.priceChangePercent),
      quoteVolume: parseFloat(t.quoteVolume) || 0,
    }))
    .filter((t) => Number.isFinite(t.lastPrice) && t.lastPrice > 0);
  filtered.sort((a, b) => b.quoteVolume - a.quoteVolume);
  return filtered.slice(0, n);
}

// Detect the densest bid cluster inside the [-WALL_MAX, -WALL_MIN] band.
function detectBidWall(bids, mark) {
  if (!Array.isArray(bids) || !bids.length || !(mark > 0)) return null;

  const minPx = mark * (1 - WALL_MAX_DROP_PCT / 100);
  const maxPx = mark * (1 - WALL_MIN_DROP_PCT / 100);

  const levels = bids
    .map(([p, q]) => [parseFloat(p), parseFloat(q)])
    .filter(([p, q]) => Number.isFinite(p) && Number.isFinite(q) && p >= minPx && p <= maxPx);

  if (!levels.length) return null;

  // Median notional inside the window — the noise floor we test against.
  const notionals = levels.map(([p, q]) => p * q).sort((a, b) => a - b);
  const median = notionals[Math.floor(notionals.length / 2)] || 0;

  // Slide a ±CLUSTER_HALF_WIDTH_PCT band over every candidate level and
  // pick the band with the maximum summed notional. This catches the
  // common case of a wall being smeared across 3-4 adjacent ticks.
  let bestCenter = null;
  let bestNotional = 0;
  let bestBaseQty = 0;
  let bestSpread = 0;
  for (const [px] of levels) {
    const lo = px * (1 - CLUSTER_HALF_WIDTH_PCT / 100);
    const hi = px * (1 + CLUSTER_HALF_WIDTH_PCT / 100);
    let notional = 0;
    let baseQty = 0;
    let count = 0;
    for (const [p, q] of levels) {
      if (p >= lo && p <= hi) {
        notional += p * q;
        baseQty += q;
        count++;
      }
    }
    if (notional > bestNotional) {
      bestNotional = notional;
      bestCenter = px;
      bestBaseQty = baseQty;
      bestSpread = count;
    }
  }

  if (!bestCenter || bestNotional < WALL_MIN_NOTIONAL_USD) return null;
  if (median > 0 && bestNotional / median < WALL_RELATIVE_RATIO) return null;

  return {
    wall_price: +bestCenter.toFixed(8),
    wall_notional_usd: +bestNotional.toFixed(0),
    wall_base_qty: +bestBaseQty.toFixed(4),
    wall_levels: bestSpread,
    drop_from_mark_pct: +(((mark - bestCenter) / mark) * 100).toFixed(2),
  };
}

function computeSniperRow(ticker, depth) {
  const mark = ticker.lastPrice;
  const wall = detectBidWall(depth?.bids, mark);
  if (!wall) return null;

  // Lift the entry slightly above the wall center so our limit sits
  // IN FRONT of the queue rather than behind the densest level.
  const optimal_limit_entry = +(wall.wall_price * (1 + ENTRY_LIFT_PCT / 100)).toFixed(8);

  // Distance from the current price to the entry. Negative = current
  // price is still ABOVE the entry (we wait for the wick).
  const distance_pct = +(((mark - optimal_limit_entry) / mark) * 100).toFixed(2);
  const proximity_pct = Math.abs(distance_pct);
  const triggered = proximity_pct <= TRIGGER_PROXIMITY_PCT;

  // Confluence with 24h low — entries near the daily low are higher
  // probability since they coincide with classic range-rotation buys.
  const low24 = ticker.lowPrice;
  let proximity_to_24h_low_pct = null;
  if (low24 > 0) {
    proximity_to_24h_low_pct = +(((optimal_limit_entry - low24) / low24) * 100).toFixed(2);
  }

  // Confidence: stronger wall + closer entry + near-24h-low = higher.
  // Bounded 0..1 — bias toward 1 when all three line up.
  let confidence = 0;
  confidence += Math.min(0.5, wall.wall_notional_usd / 5_000_000 * 0.5);
  confidence += Math.min(0.3, (TRIGGER_PROXIMITY_PCT - proximity_pct) / TRIGGER_PROXIMITY_PCT * 0.3);
  if (proximity_to_24h_low_pct != null && Math.abs(proximity_to_24h_low_pct) <= 2) confidence += 0.2;
  confidence = +Math.min(1, Math.max(0, confidence)).toFixed(3);

  const baseSymbol = ticker.symbol.replace(/USDT$|USDC$|BUSD$/, '');
  return {
    symbol: baseSymbol,
    pair: ticker.symbol,
    market: 'futures',
    mark_price: +mark.toFixed(8),
    low_24h: +low24.toFixed(8),
    optimal_limit_entry,
    distance_pct,
    proximity_pct: +proximity_pct.toFixed(2),
    triggered,
    confidence,
    wall_price: wall.wall_price,
    wall_notional_usd: wall.wall_notional_usd,
    wall_base_qty: wall.wall_base_qty,
    wall_levels: wall.wall_levels,
    wall_drop_pct: wall.drop_from_mark_pct,
    proximity_to_24h_low_pct,
  };
}

async function scanPair(ticker) {
  try {
    const url = `${FUT_DEPTH_URL}?symbol=${ticker.symbol}&limit=${DEPTH_LIMIT}`;
    const depth = await fetchWithTimeout(url, `sniper/depth/${ticker.symbol}`);
    return computeSniperRow(ticker, depth);
  } catch (e) {
    logWarn?.({ location: 'sniper-detect/scanPair', message: e.message, payload: { pair: ticker.symbol } });
    return null;
  }
}

// Bounded concurrency runner — keeps in-flight /depth calls capped at
// CONCURRENCY so we don't broadside Binance with 60 simultaneous requests.
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let idx = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

async function buildSniperPayload() {
  const top = await topPerpsByVolume(SCAN_TOP_N);
  if (!top.length) {
    return { generated_at: new Date().toISOString(), scanned: 0, signal_count: 0, signals: [], all: [] };
  }
  const rows = await mapWithConcurrency(top, CONCURRENCY, scanPair);
  const detected = rows.filter(Boolean);
  // `all` carries every coin where we DETECTED a wall (even if not
  // currently triggered) — the frontend uses it for the detail-modal
  // "Optimal Limit Entry" box even when no SNIPER badge fires.
  // `signals` is the actively-triggered subset for badging.
  const signals = detected.filter((r) => r.triggered);
  signals.sort((a, b) => b.confidence - a.confidence);
  detected.sort((a, b) => b.confidence - a.confidence);
  return {
    generated_at: new Date().toISOString(),
    scanned: top.length,
    detected: detected.length,
    signal_count: signals.length,
    signals: signals.slice(0, 50),
    all: detected.slice(0, 200),
  };
}

async function redisGet() {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(REDIS_KEY);
    if (raw == null) return null;
    return typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch { return null; }
}

async function redisSet(payload) {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(REDIS_KEY, JSON.stringify(payload), { ex: 60 });
  } catch { /* */ }
}

export default async function handler(request) {
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'GET') {
      return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
      });
    }
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

    const now = Date.now();
    if (_memoryCache && now - _memoryCache.at < CACHE_TTL_MS) {
      return new Response(_memoryCache.body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache-Layer': 'memory', ...corsHeaders(request) },
      });
    }
    const redisHit = await redisGet();
    if (redisHit && Date.now() - new Date(redisHit.generated_at).getTime() < CACHE_TTL_MS) {
      const body = JSON.stringify(redisHit);
      _memoryCache = { at: now, body };
      return new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache-Layer': 'redis', ...corsHeaders(request) },
      });
    }

    const payload = await buildSniperPayload();
    const body = JSON.stringify(payload);
    _memoryCache = { at: now, body };
    await redisSet(payload);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache-Layer': 'live', ...corsHeaders(request) },
    });
  } catch (err) {
    logFatal({ location: 'sniper-detect/handler', error: err });
    return new Response(JSON.stringify({ error: 'Sniper scan failed', detail: err.message, signals: [], all: [] }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}
