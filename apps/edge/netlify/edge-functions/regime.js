// ─────────────────────────────────────────────────────────────
// Swing Terminal v3.0 — /api/regime Edge Function (Deno)
//
// Computes a global market-regime score (0–100) from the same
// 500-coin pool the scanner already consumes. Cached in Upstash
// Redis for 15 minutes to protect Binance API weight; the call
// path on a cache HIT is one Redis GET + one LRANGE.
//
// Score inputs:
//   • Breadth        — % of coins green over the 24h window
//   • BTC impulse    — BTC's 24h % change, mapped to a 0..100 axis
//   • Vol tilt       — average |c24| across the pool, signed by breadth
//
// Bucket map:
//   score < 35  → BEAR/FLUSH
//   35 ≤ s ≤ 65 → CHOP
//   score > 65  → BULL/TREND
//
// History: LPUSH on label transitions only, LTRIM to last 10.
// ─────────────────────────────────────────────────────────────

import {
  regimeCacheGet,
  regimeCacheSet,
  regimeHistoryHead,
  regimeHistoryPush,
  regimeHistoryList,
  getRegimeTtlSeconds,
} from './lib/redis.js';
import { logFatal } from './lib/log.js';
import { pickAllowOrigin } from './lib/security.js';

const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/24hr';
const BINANCE_EXCHANGEINFO_URL = 'https://api.binance.com/api/v3/exchangeInfo';

const QUOTE_PRIORITY = ['USDC', 'USDT'];
const POOL_SIZE = 500;
const EXCHANGEINFO_CACHE_TTL_MS = 60 * 60 * 1000;

// CDN edge cache. Layered on top of the 15-min Redis cache so that a
// burst of polls inside the same second collapses to a single Redis
// hit per region. Short s-maxage keeps the regime label responsive.
const CDN_MAX_AGE_SEC = 60;

let _quoteIndex = null;

// CORS — delegates to pickAllowOrigin so a request from localhost:8888
// (or any other dev port) gets its Origin echoed back. Previously we
// echoed APP_ORIGIN unconditionally, which made browser CORS reject
// any local dev response in setups where APP_ORIGIN is set to prod.
function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': request ? pickAllowOrigin(request) : (Deno.env.get('APP_ORIGIN') || '*'),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function jsonResponse(request, body, { status = 200, cache = false } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...corsHeaders(request),
  };
  headers['Cache-Control'] = cache
    ? `public, s-maxage=${CDN_MAX_AGE_SEC}, stale-while-revalidate=120`
    : 'no-store';
  return new Response(JSON.stringify(body), { status, headers });
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ─────────────────────────────────────────────────────────────
// Binance quote index (which spot pair to use per base asset)
// ─────────────────────────────────────────────────────────────

async function getQuoteIndex() {
  const now = Date.now();
  if (_quoteIndex && now - _quoteIndex.at < EXCHANGEINFO_CACHE_TTL_MS) return _quoteIndex.byBase;

  const res = await fetch(BINANCE_EXCHANGEINFO_URL, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`exchangeInfo HTTP ${res.status}`);
  const data = await res.json();

  const byBase = Object.create(null);
  for (const s of data.symbols || []) {
    if (s.status !== 'TRADING' || !s.isSpotTradingAllowed) continue;
    if (!QUOTE_PRIORITY.includes(s.quoteAsset)) continue;
    const existing = byBase[s.baseAsset];
    if (!existing || QUOTE_PRIORITY.indexOf(s.quoteAsset) < QUOTE_PRIORITY.indexOf(existing.quote)) {
      byBase[s.baseAsset] = { quote: s.quoteAsset, pair: s.symbol };
    }
  }
  _quoteIndex = { at: now, byBase };
  return byBase;
}

// ─────────────────────────────────────────────────────────────
// Score math
// ─────────────────────────────────────────────────────────────

function bucketize(score) {
  if (score < 35) return { label: 'BEAR/FLUSH', bucket: 'bear' };
  if (score > 65) return { label: 'BULL/TREND', bucket: 'bull' };
  return { label: 'CHOP', bucket: 'chop' };
}

function computeRegime(rows, btcRow) {
  if (!rows.length) return null;

  let greenCount = 0;
  let absVolSum = 0;
  for (const r of rows) {
    if (r.c24 > 0) greenCount++;
    absVolSum += Math.abs(r.c24);
  }
  const total = rows.length;
  const greenPct = (greenCount / total) * 100;        // breadth, 0..100
  const avgVol = absVolSum / total;                   // % per coin
  const btcC24 = btcRow ? btcRow.c24 : 0;             // signed %

  // BTC impulse: 0% → 50, +10% → 100, −10% → 0.
  const btcImpulse = clamp(50 + 5 * btcC24, 0, 100);

  // Volatility intensity (0..100). On its own this is direction-blind,
  // so we tilt it by breadth: high vol on a green tape boosts bull,
  // high vol on a red tape boosts bear.
  const volMagnitude = clamp(avgVol * 5, 0, 100);
  const volTilt = greenPct >= 50 ? volMagnitude : (100 - volMagnitude);

  // Final blend — breadth is the strongest signal, BTC impulse second,
  // vol just a conviction modifier.
  const raw = 0.50 * greenPct + 0.35 * btcImpulse + 0.15 * volTilt;
  const score = Math.round(clamp(raw, 0, 100));
  const { label, bucket } = bucketize(score);

  const reasons = [];
  reasons.push(`Breadth: ${greenPct.toFixed(0)}% coinů v zelené`);
  reasons.push(`BTC 24h: ${btcC24 >= 0 ? '+' : ''}${btcC24.toFixed(2)}%`);
  reasons.push(`Avg |24h|: ${avgVol.toFixed(2)}%`);

  return {
    score,
    label,
    bucket,
    reasons,
    inputs: {
      coins_total: total,
      green_pct: +greenPct.toFixed(1),
      avg_vol_24h: +avgVol.toFixed(2),
      btc_change_24h: btcRow ? +btcC24.toFixed(2) : null,
    },
    components: {
      breadth_score: +greenPct.toFixed(1),
      btc_impulse: +btcImpulse.toFixed(1),
      vol_tilt: +volTilt.toFixed(1),
    },
    computed_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────
// Build fresh regime from Binance bulk ticker
// ─────────────────────────────────────────────────────────────

async function buildRegime() {
  const index = await getQuoteIndex();

  const wantedPairs = new Set();
  const baseByPair = new Map();
  for (const [base, info] of Object.entries(index)) {
    wantedPairs.add(info.pair);
    baseByPair.set(info.pair, base);
  }

  const res = await fetch(BINANCE_TICKER_URL, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`ticker/24hr HTTP ${res.status}`);
  const tickers = await res.json();

  const rows = [];
  let btcRow = null;
  for (const t of tickers) {
    if (!wantedPairs.has(t.symbol)) continue;
    const c24 = parseFloat(t.priceChangePercent);
    const qv = parseFloat(t.quoteVolume);
    if (!Number.isFinite(c24) || !Number.isFinite(qv)) continue;
    const base = baseByPair.get(t.symbol);
    const row = { pair: t.symbol, base, c24, qv };
    rows.push(row);
    if (base === 'BTC') btcRow = row;
  }

  rows.sort((a, b) => b.qv - a.qv);
  const pool = rows.slice(0, POOL_SIZE);
  return computeRegime(pool, btcRow);
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return jsonResponse(request, { error: 'Method Not Allowed' }, { status: 405 });
  }

  try {
    // 1. Try Redis cache.
    const cached = await regimeCacheGet();
    if (cached) {
      const history = await regimeHistoryList();
      return jsonResponse(request, {
        current: cached,
        history,
        cached: true,
        ttl_seconds: getRegimeTtlSeconds(),
      }, { cache: true });
    }

    // 2. Compute fresh from Binance.
    const fresh = await buildRegime();
    if (!fresh) {
      return jsonResponse(request, { error: 'Regime computation produced empty pool' }, { status: 502 });
    }

    // 3. Persist current snapshot for the next 15 min.
    await regimeCacheSet(fresh);

    // 4. Push history entry only on label transitions — keeps the list
    //    meaningful (e.g. "BULL/TREND → CHOP") instead of 10 duplicates.
    const head = await regimeHistoryHead();
    if (!head || head.label !== fresh.label) {
      await regimeHistoryPush({
        score: fresh.score,
        label: fresh.label,
        bucket: fresh.bucket,
        from: head?.label || null,
        green_pct: fresh.inputs.green_pct,
        btc_change_24h: fresh.inputs.btc_change_24h,
        at: fresh.computed_at,
      });
    }

    const history = await regimeHistoryList();

    return jsonResponse(request, {
      current: fresh,
      history,
      cached: false,
      ttl_seconds: getRegimeTtlSeconds(),
    }, { cache: true });
  } catch (err) {
    logFatal({ location: 'regime/handler', error: err });

    // Best-effort fallback: if Binance is down but we have a stale
    // Redis snapshot from a previous successful run, still serve it.
    try {
      const stale = await regimeCacheGet();
      const history = await regimeHistoryList();
      if (stale) {
        return jsonResponse(request, {
          current: stale,
          history,
          cached: true,
          stale: true,
          error: err.message,
        }, { cache: false });
      }
    } catch { /* ignore */ }

    return jsonResponse(request, { error: err.message }, { status: 502 });
  }
}
