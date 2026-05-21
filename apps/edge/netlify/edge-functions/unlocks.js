// ─────────────────────────────────────────────────────────────
// Swing Terminal V7.1 — /api/unlocks Edge Function (Deno)
//
// REAL DYNAMIC UNLOCKS ENGINE
// Pulls live token-unlock schedules from public, free endpoints that
// do not require an API key, normalizes them into a single shape, and
// merges multiple sources so newer / smaller-cap tokens (XPL, PUMP,
// BIO, etc.) are not silently dropped.
//
// PRIMARY  : DefiLlama unlocks endpoint (https://api.llama.fi/emissions)
//            — open, no key required, comprehensive (200+ projects),
//            includes nextEvent timestamp + amount in tokens / USD.
// SECONDARY: CryptoRank public unlocks JSON
//            (https://api.cryptorank.io/v0/unlocks/upcoming) — covers
//            new listings DefiLlama may lag on.
// FALLBACK : empty array — the client (terminal.js) owns the dynamic
//            fallback generator (calGenerateDynamicFallback) so any
//            DATA-active coin can be synthesized into a vesting event
//            without a server roundtrip on cold-boot.
//
// Output schema — sorted by date ascending, deduped on (symbol|ts):
//   { source, fetched_at, items: [
//       { symbol, project, ts, date, amount_tokens, amount_usd,
//         pct_supply, magnitude, source }
//   ] }
// ─────────────────────────────────────────────────────────────

import { logWarn } from './lib/log.js';
import { pickAllowOrigin } from './lib/security.js';

const CDN_MAX_AGE_SEC = 1800;        // 30 min
const CDN_SWR_SEC = 3600;            // 1 hr
const MEMORY_TTL_MS = 25 * 60 * 1000; // 25 min

const HORIZON_DAYS = 90;
const MAX_ITEMS = 250;

const FETCH_TIMEOUT_MS = 9_000;

const LLAMA_URL = 'https://api.llama.fi/emissions';
const CRYPTORANK_URL = 'https://api.cryptorank.io/v0/unlocks/upcoming';

let _cache = null; // { at, body }

function corsHeaders(req) {
  return {
    'Access-Control-Allow-Origin': pickAllowOrigin(req),
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function jsonHeaders(req) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': `public, s-maxage=${CDN_MAX_AGE_SEC}, stale-while-revalidate=${CDN_SWR_SEC}`,
    ...corsHeaders(req),
  };
}

function magnitudeFromUsd(usd) {
  if (!Number.isFinite(usd) || usd <= 0) return 'unknown';
  if (usd >= 50_000_000) return 'huge';
  if (usd >= 10_000_000) return 'large';
  if (usd >= 1_000_000) return 'medium';
  return 'small';
}

function normalizeSymbol(s) {
  return String(s || '').toUpperCase().trim().replace(/\s+/g, '');
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ── DefiLlama emissions — primary source ──
// Returns an array of project objects; the field names we care about are
// `nextEvent` { date (unix s), toUnlock (tokens), toUnlockUsd } and the
// metadata block at top: token, name, gecko_id, mcap, circSupply, etc.
async function fetchLlama() {
  try {
    const r = await fetch(LLAMA_URL, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SwingTerminal/6.6' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      logWarn({ location: 'unlocks/llama', message: `HTTP ${r.status}` });
      return [];
    }
    const data = await r.json();
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.emissions) ? data.emissions : []);
    const out = [];
    const now = Date.now();
    const horizonMs = HORIZON_DAYS * 24 * 3600 * 1000;

    for (const row of rows) {
      const ev = row?.nextEvent || row?.unlocksByMonth?.next || null;
      const tsSec = safeNumber(ev?.date ?? ev?.timestamp ?? ev?.ts);
      if (!tsSec) continue;
      const ts = tsSec * 1000;
      if (ts < now - 24 * 3600 * 1000) continue;     // skip events already passed > 1d
      if (ts - now > horizonMs) continue;

      const symbol = normalizeSymbol(row.token || row.gecko_id || row.name);
      if (!symbol) continue;

      const amountTokens = safeNumber(ev.toUnlock ?? ev.amount ?? ev.tokens);
      const amountUsd = safeNumber(ev.toUnlockUsd ?? ev.usd ?? ev.amountUsd);
      const circ = safeNumber(row.circSupply ?? row.circulatingSupply);
      const pct = (Number.isFinite(amountTokens) && Number.isFinite(circ) && circ > 0)
        ? (amountTokens / circ) * 100
        : null;

      out.push({
        symbol,
        project: row.name || symbol,
        ts,
        date: new Date(ts).toISOString().slice(0, 10),
        amount_tokens: amountTokens,
        amount_usd: amountUsd,
        pct_supply: pct,
        magnitude: magnitudeFromUsd(amountUsd),
        source: 'defillama',
      });
    }
    return out;
  } catch (e) {
    logWarn({ location: 'unlocks/llama', message: e.message });
    return [];
  }
}

// ── CryptoRank public unlocks — secondary source for new-listings coverage.
// The v0 endpoint is rate-limited but does not require an API key.
async function fetchCryptoRank() {
  try {
    const r = await fetch(CRYPTORANK_URL, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SwingTerminal/6.6' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      logWarn({ location: 'unlocks/cryptorank', message: `HTTP ${r.status}` });
      return [];
    }
    const data = await r.json();
    const rows = Array.isArray(data?.data) ? data.data
               : Array.isArray(data?.unlocks) ? data.unlocks
               : Array.isArray(data) ? data : [];
    const out = [];
    const now = Date.now();
    const horizonMs = HORIZON_DAYS * 24 * 3600 * 1000;

    for (const row of rows) {
      const dateRaw = row.date || row.unlockDate || row.unlock_date || row.timestamp || row.ts;
      let ts;
      if (typeof dateRaw === 'number') ts = dateRaw < 1e12 ? dateRaw * 1000 : dateRaw;
      else if (typeof dateRaw === 'string') ts = Date.parse(dateRaw);
      if (!Number.isFinite(ts)) continue;
      if (ts < now - 24 * 3600 * 1000) continue;
      if (ts - now > horizonMs) continue;

      const symbol = normalizeSymbol(row.symbol || row.ticker || row.code || row.coin);
      if (!symbol) continue;

      const amountTokens = safeNumber(row.amount ?? row.tokens ?? row.tokenAmount);
      const amountUsd = safeNumber(row.usdAmount ?? row.amountUsd ?? row.valueUsd);
      const pct = safeNumber(row.percentage ?? row.percentOfTotal ?? row.pct);

      out.push({
        symbol,
        project: row.name || row.project || symbol,
        ts,
        date: new Date(ts).toISOString().slice(0, 10),
        amount_tokens: amountTokens,
        amount_usd: amountUsd,
        pct_supply: pct,
        magnitude: magnitudeFromUsd(amountUsd),
        source: 'cryptorank',
      });
    }
    return out;
  } catch (e) {
    logWarn({ location: 'unlocks/cryptorank', message: e.message });
    return [];
  }
}

function dedupeAndSort(items) {
  const seen = new Map();
  for (const it of items) {
    const key = `${it.symbol}|${Math.round(it.ts / (24 * 3600 * 1000))}`; // dedupe by symbol+day
    const existing = seen.get(key);
    // Prefer the entry with USD amount if both exist; otherwise first wins.
    if (!existing || (Number.isFinite(it.amount_usd) && !Number.isFinite(existing.amount_usd))) {
      seen.set(key, it);
    }
  }
  return [...seen.values()].sort((a, b) => a.ts - b.ts).slice(0, MAX_ITEMS);
}

async function buildUnlockPayload() {
  const [llama, cr] = await Promise.allSettled([fetchLlama(), fetchCryptoRank()]);
  const llamaItems = llama.status === 'fulfilled' ? llama.value : [];
  const crItems = cr.status === 'fulfilled' ? cr.value : [];
  const merged = dedupeAndSort([...llamaItems, ...crItems]);
  const sources = [];
  if (llamaItems.length) sources.push(`defillama(${llamaItems.length})`);
  if (crItems.length) sources.push(`cryptorank(${crItems.length})`);
  return {
    source: sources.join('+') || 'none',
    fetched_at: new Date().toISOString(),
    horizon_days: HORIZON_DAYS,
    count: merged.length,
    items: merged,
  };
}

export default async function handler(request) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed', items: [] }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders(request) },
    });
  }

  const now = Date.now();
  if (_cache && now - _cache.at < MEMORY_TTL_MS) {
    return new Response(_cache.body, {
      status: 200,
      headers: { ...jsonHeaders(request), 'X-Served-From': 'memory' },
    });
  }

  let payload;
  try {
    payload = await buildUnlockPayload();
  } catch (e) {
    logWarn({ location: 'unlocks/handler', message: `unexpected throw: ${e.message}` });
    if (_cache) {
      return new Response(_cache.body, {
        status: 200,
        headers: { ...jsonHeaders(request), 'X-Served-From': 'stale-memory' },
      });
    }
    payload = { source: 'none', fetched_at: new Date().toISOString(), horizon_days: HORIZON_DAYS, count: 0, items: [], note: 'Unlocks temporarily unavailable.' };
  }

  const body = JSON.stringify(payload);
  if (payload.items && payload.items.length) {
    _cache = { at: now, body };
  }
  // V6.8 Sprint 1 (FIX-13): never let an empty payload be CDN-cached.
  // The old jsonHeaders set s-maxage=1800 / SWR=3600, which meant a
  // transient outage produced a `{count:0,items:[]}` payload that the
  // CDN then served to every subsequent user for 30 minutes — calendar
  // looked broken even after upstream recovered. On empty, force a
  // hard no-store and stamp X-Empty so debugging is one curl away.
  const headers = (payload.items && payload.items.length)
    ? jsonHeaders(request)
    : {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Empty': '1',
        ...corsHeaders(request),
      };
  return new Response(body, { status: 200, headers });
}
