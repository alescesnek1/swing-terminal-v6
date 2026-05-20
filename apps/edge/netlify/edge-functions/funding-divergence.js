// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — /api/funding-divergence (Phase 4 Wildcard A)
//
// "Smart Money Divergence" — institutional squeeze detector.
//
// Premise: Binance funding rate signals AGGREGATE retail positioning
// (perp longs pay shorts when funding > 0). When funding diverges from
// recent price action, retail is leaning the wrong way and the
// squeeze risk is high:
//
//   • SHORTS_TRAPPED  (bullish): funding ≤ -0.005% AND price_24h ≥ +3%
//                                — shorts paying to short into strength
//   • LONGS_TRAPPED   (bearish): funding ≥ +0.02%  AND price_24h ≤ -3%
//                                — longs paying to long into weakness
//   • CROWDED_LONG    (bearish): funding ≥ +0.03%  AND |price_24h| < 1%
//                                — record positioning, no price reward
//   • NEUTRAL                    — everything else
//
// One batched fetch to /fapi/v1/premiumIndex (~all perps in <300 KB).
// Cached 60s per isolate + Redis. The endpoint is auth-gated and uses
// the JWT only for cost attribution — no tier restriction; this is a
// market-wide indicator everyone benefits from.
// ─────────────────────────────────────────────────────────────

import { checkOrigin, pickAllowOrigin, verifyAuth } from './lib/security.js';
import { getRedis } from './lib/redis.js';
import { logFatal, logWarn } from './lib/log.js';

const FUTURES_PREMIUM_URL = 'https://fapi.binance.com/fapi/v1/premiumIndex';
const FUTURES_24HR_URL = 'https://fapi.binance.com/fapi/v1/ticker/24hr';
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 60 * 1000;
const REDIS_KEY = 'smart-money:divergence:v1';

let _memoryCache = null; // { at, body }

// Tunables — kept generous to avoid noise.
const FUND_SHORT_TRAP_BPS = -0.005;   // -0.5 bps = -0.005 %
const FUND_LONG_TRAP_BPS  =  0.02;    // +2 bps
const FUND_CROWDED_BPS    =  0.03;    // +3 bps
const PRICE_DIVERGENCE_PCT = 3;
const PRICE_CHOP_PCT = 1;

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

function classify(fundingPct, priceChangePct) {
  if (!Number.isFinite(fundingPct) || !Number.isFinite(priceChangePct)) return null;
  if (fundingPct <= FUND_SHORT_TRAP_BPS && priceChangePct >= PRICE_DIVERGENCE_PCT) {
    return { signal: 'SHORTS_TRAPPED', bias: 'bullish', confidence: scoreSquish(Math.abs(fundingPct), priceChangePct) };
  }
  if (fundingPct >= FUND_LONG_TRAP_BPS && priceChangePct <= -PRICE_DIVERGENCE_PCT) {
    return { signal: 'LONGS_TRAPPED', bias: 'bearish', confidence: scoreSquish(fundingPct, Math.abs(priceChangePct)) };
  }
  if (fundingPct >= FUND_CROWDED_BPS && Math.abs(priceChangePct) < PRICE_CHOP_PCT) {
    return { signal: 'CROWDED_LONG', bias: 'bearish', confidence: scoreSquish(fundingPct, 1) };
  }
  return null;
}

// Sigmoid-ish 0..1 mapper: higher |funding| + |price| → higher conf.
function scoreSquish(absFundingPct, absPricePct) {
  const x = absFundingPct * 10 + absPricePct * 0.05;
  return +Math.min(1, x).toFixed(3);
}

async function buildDivergencePayload() {
  const [premiumData, tickerData] = await Promise.all([
    fetchWithTimeout(FUTURES_PREMIUM_URL, 'fut-premium-bulk'),
    fetchWithTimeout(FUTURES_24HR_URL, 'fut-ticker-bulk'),
  ]);

  const tickerByPair = new Map();
  if (Array.isArray(tickerData)) {
    for (const t of tickerData) tickerByPair.set(t.symbol, t);
  }

  const signals = [];
  if (Array.isArray(premiumData)) {
    for (const p of premiumData) {
      const pair = p.symbol;
      if (!pair) continue;
      // Funding rates come in 8h fraction form (e.g. 0.0001 = 0.01%);
      // scale to a percent to match priceChangePercent units.
      const fundingPct = parseFloat(p.lastFundingRate) * 100;
      const t = tickerByPair.get(pair);
      if (!t) continue;
      const priceChangePct = parseFloat(t.priceChangePercent);
      const decision = classify(fundingPct, priceChangePct);
      if (!decision) continue;
      signals.push({
        symbol: pair.replace(/USDT$|USDC$|BUSD$/, ''),
        pair,
        funding_pct: +fundingPct.toFixed(4),
        price_change_24h_pct: +priceChangePct.toFixed(2),
        mark_price: parseFloat(p.markPrice),
        ...decision,
      });
    }
  }
  // Sort by confidence DESC so the UI gets the strongest signals first.
  signals.sort((a, b) => b.confidence - a.confidence);
  return {
    generated_at: new Date().toISOString(),
    signal_count: signals.length,
    signals: signals.slice(0, 40),
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

    const payload = await buildDivergencePayload();
    const body = JSON.stringify(payload);
    _memoryCache = { at: now, body };
    await redisSet(payload);
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Cache-Layer': 'live', ...corsHeaders(request) },
    });
  } catch (err) {
    logFatal({ location: 'funding-divergence/handler', error: err });
    return new Response(JSON.stringify({ error: 'Divergence build failed', detail: err.message, signals: [] }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }
}
