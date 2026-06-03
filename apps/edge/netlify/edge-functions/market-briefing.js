// ─────────────────────────────────────────────────────────────
// Swing Terminal v4 — /api/market-briefing Edge Function (Deno)
//
// Premium global Market Overview — superior to CoinGecko's stock
// summary. Feeds Gemini the top-100 coins (gainers/losers/volume
// leaders) plus the latest CryptoPanic headlines and forces a
// structured Macro / Meta / Opportunities response.
//
// V4.1 PRODUCTION HARDENING (post 429-incident):
// This handler is BULLETPROOF against Gemini rate limits. The fallback
// cascade, in priority order:
//
//   1. Module-scope cache (per Deno isolate, 45 min TTL)
//   2. Redis fresh cache (cross-isolate, 45 min TTL)
//   3. Gemini call with exponential backoff: 0s → 2s → 5s → 10s
//      (4 total attempts; each attempt walks the model fallback chain)
//   4. Redis STALE cache (last-known-good, 30-day TTL — separate key)
//   5. In-memory stale (last successful payload from THIS isolate)
//   6. Synthetic "Market Snapshot" rendered from raw leaderboards
//
// Every layer below #3 marks the response with `meta.stale = true` and
// `meta.fallback_reason` so the UI can show a soft "using cached data"
// banner instead of a hard error. Stale data > no data > error screen.
// ─────────────────────────────────────────────────────────────

import { runMarketBriefing, GeminiApiError } from './lib/orchestrator.js';
import { getRedis } from './lib/redis.js';
import { checkOrigin, pickAllowOrigin, verifyAuth } from './lib/security.js';
import { logFatal } from './lib/log.js';
import { isAdminUser } from './lib/tier.js';

// ── Constants ──
// 45 min — sits in the requested 30-60 min window. Long enough that
// 100+ users hitting the panel during a busy hour share ONE Gemini
// call; short enough that a fresh briefing reflects the most recent
// CPI / FOMC / unlock event without going stale on a multi-hour gap.
const BRIEFING_TTL_SEC = parseInt(Deno.env.get('MARKET_BRIEFING_TTL_SEC') || '2700', 10);
const BRIEFING_TTL_MS = BRIEFING_TTL_SEC * 1000;

// Long-lived "last known good" copy. Survives well beyond the live
// TTL — used as a graceful fallback when Gemini is rate-limited and
// we'd otherwise have to show an error screen. 30 days is enough that
// a multi-day Gemini outage still serves SOMETHING useful.
const STALE_TTL_SEC = parseInt(Deno.env.get('MARKET_BRIEFING_STALE_TTL_SEC') || String(60 * 60 * 24 * 30), 10);

// Exponential-backoff schedule between Gemini attempts on 429 / 5xx.
// First attempt is immediate; subsequent attempts wait 2s, 5s, 10s.
// Total worst-case wait before fallback kicks in: ~17s + Gemini latency.
const RETRY_BACKOFF_MS = [0, 2000, 5000, 10000];

// Hard ceiling on per-user calls so a misbehaving client can't
// repeatedly miss-cache by spoofing the lang param. Generous —
// human users will only ever hit this through dev tools.
const PER_USER_CALLS_PER_HOUR = parseInt(Deno.env.get('MARKET_BRIEFING_USER_RPH') || '20', 10);

const REDIS_KEY = (lang) => `mkt-briefing:v1:${lang || 'cs'}`;
const STALE_REDIS_KEY = (lang) => `mkt-briefing:v1:stale:${lang || 'cs'}`;
const RL_KEY = (userId) => `rl:mkt-briefing:${userId}`;

const COINGECKO_TOP_URL =
  'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=volume_desc&per_page=100&page=1&sparkline=false&price_change_percentage=1h,24h,7d';
const CRYPTOPANIC_CURRENCIES = 'BTC,ETH,SOL,XRP,ADA,AVAX,DOT,LINK,UNI,DOGE,BNB,MATIC,TRX,ATOM,NEAR,APT,SUI,ARB,OP,INJ';

// Module-scope cache (per isolate). Keyed by language so cs/en
// don't collide. The "stale" map persists ANY successful payload
// indefinitely so the same isolate has its own last-known-good even
// if Redis is also unhealthy.
const _moduleCache = new Map();        // lang → { at, payload }
const _moduleStableCache = new Map();  // lang → { at, payload } — never auto-evicted

// Redis health flag — set on first successful ping per isolate.
// `null` means we haven't probed yet; `true` means up; `false` means
// we observed a failure recently. The flag only gates LOGGING — we
// always still try Redis in case it recovers, since a failed call is
// cheap (Upstash auto-times-out).
let _redisHealthy = null;
let _redisHealthLoggedAt = 0;
const REDIS_HEALTH_LOG_INTERVAL_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// HTTP helpers
// ─────────────────────────────────────────────────────────────

function corsHeaders(request) {
  return {
    'Access-Control-Allow-Origin': pickAllowOrigin(request),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(request, body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
      ...extraHeaders,
    },
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// Cache layer — module-scope first, Redis second
// ─────────────────────────────────────────────────────────────

function moduleCacheGet(lang) {
  const entry = _moduleCache.get(lang);
  if (!entry) return null;
  if (Date.now() - entry.at >= BRIEFING_TTL_MS) {
    _moduleCache.delete(lang);
    return null;
  }
  return entry.payload;
}

function moduleCacheSet(lang, payload) {
  const at = Date.now();
  _moduleCache.set(lang, { at, payload });
  // Mirror to the never-evicted "stable" map so a Gemini outage
  // serving from a hot isolate can still produce something even if
  // Redis is unreachable. Lasts for the lifetime of the isolate.
  _moduleStableCache.set(lang, { at, payload });
}

// Last-known-good in-memory copy. Returns whatever was last cached,
// regardless of age, with the entry's age included.
function moduleStableGet(lang) {
  const entry = _moduleStableCache.get(lang);
  if (!entry) return null;
  return { payload: entry.payload, age_ms: Date.now() - entry.at };
}

async function logRedisHealth(label, ok, err) {
  const now = Date.now();
  // Throttle the log line so a sustained outage doesn't spam
  // production logs every request.
  const shouldLog = ok !== _redisHealthy || (now - _redisHealthLoggedAt) > REDIS_HEALTH_LOG_INTERVAL_MS;
  _redisHealthy = ok;
  if (shouldLog) {
    _redisHealthLoggedAt = now;
    if (ok) {
      console.log(`[MKT-BRIEFING] redis ${label}: OK`);
    } else {
      console.warn(`[MKT-BRIEFING] redis ${label}: DEGRADED — falling back to in-memory cache. ${err?.message || err || ''}`);
    }
  }
}

async function redisCacheGet(lang) {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(REDIS_KEY(lang));
    await logRedisHealth('cache-get', true);
    if (raw == null) return null;
    return typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch (e) {
    await logRedisHealth('cache-get', false, e);
    return null;
  }
}

async function redisCacheSet(lang, payload) {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(REDIS_KEY(lang), JSON.stringify(payload), { ex: BRIEFING_TTL_SEC });
    await logRedisHealth('cache-set', true);
  } catch (e) {
    await logRedisHealth('cache-set', false, e);
  }
}

// Last-known-good Redis copy. Long TTL (default 30 days). Updated on
// EVERY successful generation — separate key from the live cache so
// it isn't auto-evicted at the 45-min mark.
async function redisStableGet(lang) {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(STALE_REDIS_KEY(lang));
    if (raw == null) return null;
    return typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch (e) {
    await logRedisHealth('stable-get', false, e);
    return null;
  }
}

async function redisStableSet(lang, payload) {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(STALE_REDIS_KEY(lang), JSON.stringify(payload), { ex: STALE_TTL_SEC });
  } catch (e) {
    await logRedisHealth('stable-set', false, e);
  }
}

// Per-user soft rate limit. Briefing is a public/global product so a
// shared cache is the primary cost shield — this is just defense in
// depth against scripted misuse.
async function checkUserRateLimit(userId) {
  try {
    const redis = getRedis();
    if (!redis) return { allowed: true, remaining: -1 };
    const key = RL_KEY(userId);
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, 3600);
    }
    if (count > PER_USER_CALLS_PER_HOUR) {
      const ttl = await redis.ttl(key);
      return { allowed: false, retry_after_seconds: Math.max(60, ttl || 3600) };
    }
    return { allowed: true, remaining: Math.max(0, PER_USER_CALLS_PER_HOUR - count) };
  } catch (e) {
    await logRedisHealth('rate-limit', false, e);
    // Fail-open on Redis hiccup.
    return { allowed: true, remaining: -1 };
  }
}

// ─────────────────────────────────────────────────────────────
// Source data fetch
// ─────────────────────────────────────────────────────────────

// V6.1 — hardened upstream fetch. 10s ceiling so a hanging CoinGecko /
// CryptoPanic edge can't lock the briefing handler past the Netlify
// edge soft limit. Every parse step is null-safe; bad JSON returns
// an empty list rather than throwing.
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000;

async function _safeFetchJson(url, label) {
  try {
    const r = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'SwingTerminal/6.1' },
      signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      throw new Error(`${label} HTTP ${r.status} body=${body.slice(0, 140)}`);
    }
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error(`${label} invalid JSON: ${e.message}`);
    }
  } catch (e) {
    // Re-throw with a labeled message; caller decides whether to degrade.
    throw new Error(`${label}: ${e.message}`);
  }
}

async function fetchCoinGeckoTop100() {
  const list = await _safeFetchJson(COINGECKO_TOP_URL, 'coingecko');
  if (!Array.isArray(list)) throw new Error('coingecko: unexpected payload (not an array)');
  return list.slice(0, 100).map((c) => ({
    rank: c.market_cap_rank,
    symbol: String(c.symbol || '').toUpperCase(),
    name: c.name,
    price: c.current_price,
    market_cap: c.market_cap,
    volume_24h: c.total_volume,
    pct_1h: c.price_change_percentage_1h_in_currency ?? null,
    pct_24h: c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h ?? null,
    pct_7d: c.price_change_percentage_7d_in_currency ?? null,
  }));
}

async function fetchCryptoPanicHeadlines() {
  const token = Deno.env.get('CRYPTOPANIC_TOKEN') || 'free';
  const url = `https://cryptopanic.com/api/free/v1/posts/?auth_token=${encodeURIComponent(token)}&public=true&kind=news&filter=important&currencies=${CRYPTOPANIC_CURRENCIES}`;
  try {
    const data = await _safeFetchJson(url, 'cryptopanic');
    const results = Array.isArray(data?.results) ? data.results : [];
    return results.slice(0, 25).map((p) => ({
      title: p.title || '',
      source: p.source?.title || p.domain || 'CryptoPanic',
      published_at: p.published_at || p.created_at || '',
      currencies: Array.isArray(p.currencies) ? p.currencies.map((c) => c.code).filter(Boolean) : [],
    }));
  } catch (e) {
    // News is non-critical — degrade silently so the macro briefing can
    // still synthesize on top-100 alone.
    console.warn('[MKT-BRIEFING] cryptopanic degraded:', e.message);
    return [];
  }
}

// V6.1 — opportunistic macro snapshot. CoinGecko exposes global crypto
// metrics (BTC dominance, total market cap delta) without a key, and
// stooq.com serves S&P 500 / DXY EOD quotes via a free CSV endpoint.
// All three calls are best-effort: failures never block the briefing,
// they just leave the corresponding field blank for Gemini to caveat.
async function fetchMacroContext() {
  const out = { btc_dominance_pct: null, total_mcap_change_pct_24h: null, sp500: null, dxy: null, sources: [] };

  // CoinGecko /global is free + key-less.
  try {
    const g = await _safeFetchJson('https://api.coingecko.com/api/v3/global', 'cg-global');
    const d = g?.data;
    if (d) {
      const dom = d.market_cap_percentage?.btc;
      const dt = d.market_cap_change_percentage_24h_usd;
      if (Number.isFinite(dom)) out.btc_dominance_pct = +dom.toFixed(2);
      if (Number.isFinite(dt)) out.total_mcap_change_pct_24h = +dt.toFixed(2);
      out.sources.push('coingecko/global');
    }
  } catch (e) {
    console.warn('[MKT-BRIEFING] cg-global degraded:', e.message);
  }

  // S&P 500 + DXY via Stooq CSV (no key required). Format: symbol per
  // request, last bar is the most recent close. Best-effort only.
  const fetchStooq = async (sym, label) => {
    try {
      const r = await fetch(`https://stooq.com/q/l/?s=${sym}&f=sd2t2ohlcv&h&e=csv`, {
        headers: { 'Accept': 'text/csv' },
        signal: AbortSignal.timeout(UPSTREAM_FETCH_TIMEOUT_MS),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const csv = await r.text();
      const lines = csv.trim().split(/\r?\n/);
      if (lines.length < 2) return null;
      const cols = lines[1].split(',');
      const close = Number(cols[6]);
      const open = Number(cols[3]);
      if (!Number.isFinite(close) || !Number.isFinite(open) || open <= 0) return null;
      out.sources.push(label);
      return { close, pct_change: +(((close - open) / open) * 100).toFixed(2) };
    } catch (e) {
      console.warn(`[MKT-BRIEFING] stooq/${sym} degraded:`, e.message);
      return null;
    }
  };
  const [sp, dx] = await Promise.allSettled([fetchStooq('^spx', 'stooq/^spx'), fetchStooq('^dxy', 'stooq/^dxy')]);
  if (sp.status === 'fulfilled' && sp.value) out.sp500 = sp.value;
  if (dx.status === 'fulfilled' && dx.value) out.dxy = dx.value;
  return out;
}

// Rank the top-100 into the buckets Gemini wants up front.
function buildLeaderboards(top100) {
  const withPct = top100.filter((c) => Number.isFinite(c.pct_24h));
  const sorted = [...withPct].sort((a, b) => (b.pct_24h ?? 0) - (a.pct_24h ?? 0));
  const gainers = sorted.slice(0, 10).map((c) => ({ symbol: c.symbol, name: c.name, pct_24h: c.pct_24h }));
  const losers = sorted.slice(-10).reverse().map((c) => ({ symbol: c.symbol, name: c.name, pct_24h: c.pct_24h }));
  const volumeLeaders = [...top100]
    .sort((a, b) => (b.volume_24h || 0) - (a.volume_24h || 0))
    .slice(0, 15)
    .map((c) => ({ symbol: c.symbol, name: c.name, volume_24h: c.volume_24h, pct_24h: c.pct_24h }));
  return { gainers, losers, volume_leaders: volumeLeaders };
}

// ─────────────────────────────────────────────────────────────
// V6.2 — Geopolitical / macro RSS injection
//
// Pulls real-world headlines from public RSS endpoints so the LLM can
// connect "Trump flies to China" / "Fed pauses" with the BTC + alt
// tape. RSS is parsed with a regex (no DOM in Deno) — robust enough
// for well-formed feeds from Yahoo Finance, Reuters, and Google News.
//
// Sources are fanned out; whichever return first usable items wins.
// Each item is { title, source, published_at, url }.
// ─────────────────────────────────────────────────────────────

const GEOPOL_FEEDS = [
  // Yahoo Finance global headlines (broad coverage of macro + equities).
  { name: 'yahoo-finance', url: 'https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC,^IXIC,^DJI,^DXY&region=US&lang=en-US' },
  // Google News topic search — geopolitics + macro keywords.
  { name: 'google-news-geopol', url: 'https://news.google.com/rss/search?q=(geopolitics+OR+%22interest+rates%22+OR+Fed+OR+CPI+OR+%22Trump%22+OR+%22China%22+OR+%22Russia%22+OR+%22Israel%22+OR+OPEC+OR+ECB)+when%3A2d&hl=en-US&gl=US&ceid=US:en' },
  // Reuters business news (stable RSS schema).
  { name: 'reuters-business', url: 'https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best' },
];

const RSS_FETCH_TIMEOUT_MS = 10_000;

function _stripXmlTags(s) {
  if (!s) return '';
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<\/?[^>]+>/g, '').trim();
}

function _decodeXmlEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&');
}

function _parseRssItems(xml, sourceName) {
  if (typeof xml !== 'string' || !xml.length) return [];
  const items = [];
  const itemRx = /<item\b[\s\S]*?<\/item>/gi;
  let m;
  while ((m = itemRx.exec(xml)) !== null) {
    const block = m[0];
    const tMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(block);
    const linkMatch = /<link[^>]*>([\s\S]*?)<\/link>/i.exec(block);
    const dateMatch = /<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block);
    const sourceMatch = /<source[^>]*>([\s\S]*?)<\/source>/i.exec(block);
    const title = _decodeXmlEntities(_stripXmlTags(tMatch?.[1] || '')).trim();
    if (!title) continue;
    items.push({
      title,
      url: _decodeXmlEntities(_stripXmlTags(linkMatch?.[1] || '')).trim(),
      source: _decodeXmlEntities(_stripXmlTags(sourceMatch?.[1] || '')).trim() || sourceName,
      published_at: (dateMatch?.[1] || '').trim(),
    });
    if (items.length >= 25) break;
  }
  return items;
}

async function _fetchRss(feed) {
  try {
    const r = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SwingTerminal/6.2)',
        'Accept': 'application/rss+xml, application/xml, text/xml',
      },
      signal: AbortSignal.timeout(RSS_FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const xml = await r.text();
    return _parseRssItems(xml, feed.name);
  } catch (e) {
    console.warn(`[MKT-BRIEFING] geopol ${feed.name} degraded:`, e.message);
    return [];
  }
}

async function fetchGeopoliticalHeadlines() {
  const settled = await Promise.allSettled(GEOPOL_FEEDS.map(_fetchRss));
  const merged = [];
  const seenTitles = new Set();
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue;
    for (const item of s.value) {
      const key = item.title.toLowerCase().slice(0, 80);
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      merged.push(item);
    }
  }
  // Top 5 — caller wants the headline list short so the LLM can correlate
  // each one with a market move in the briefing.
  return merged.slice(0, 5);
}

// ─────────────────────────────────────────────────────────────
// V6.2 — Deep token unlocks (14-day horizon)
//
// No public unlocks API works without a paid key, and the Token Unlocks
// site does not expose a stable scrape target. We curate a rolling
// 14-day window of imminent unlocks for the high-impact L2 / new
// listings (ZRO, STRK, W, ENA, JTO, PYTH, IO, AEVO, ALT, BLAST, EIGEN,
// ARB, OP, MANTA, SUI). Dates are best-known cadences (Token Unlocks
// public schedules); the LLM prompt instructs Gemini to web-verify
// each before quoting hard dates.
// ─────────────────────────────────────────────────────────────

const DEEP_UNLOCK_SEED = [
  { symbol: 'ZRO',   project: 'LayerZero',    cadence: 'monthly',  approx_day_of_month: 20, magnitude: 'large',   horizon_days: 14, note: 'Investor + core contributor cliff cohorts unlocking; check tokenunlocks.app for the exact tranche.' },
  { symbol: 'STRK',  project: 'Starknet',     cadence: 'monthly',  approx_day_of_month: 15, magnitude: 'large',   horizon_days: 14, note: 'L2 inflation + investor vesting. Significant supply event historically.' },
  { symbol: 'W',     project: 'Wormhole',     cadence: 'monthly',  approx_day_of_month: 3,  magnitude: 'large',   horizon_days: 14, note: 'Strategic investor + core contributor unlocks; rotating dilution.' },
  { symbol: 'ENA',   project: 'Ethena',       cadence: 'quarterly',approx_day_of_month: 25, magnitude: 'large',   horizon_days: 14, note: 'Investor + ecosystem unlock — biggest non-staking dilution event in the segment.' },
  { symbol: 'JTO',   project: 'Jito',         cadence: 'monthly',  approx_day_of_month: 7,  magnitude: 'medium',  horizon_days: 14, note: 'Continued vesting tranche.' },
  { symbol: 'PYTH',  project: 'Pyth Network', cadence: 'biannual', approx_day_of_month: 20, magnitude: 'large',   horizon_days: 14, note: 'Six-month cliff unlocks — sharp supply step.' },
  { symbol: 'IO',    project: 'io.net',       cadence: 'monthly',  approx_day_of_month: 11, magnitude: 'medium',  horizon_days: 14, note: 'Investor + core team tranche.' },
  { symbol: 'AEVO',  project: 'Aevo',         cadence: 'monthly',  approx_day_of_month: 14, magnitude: 'medium',  horizon_days: 14, note: 'Vesting continues post-airdrop unlock cliffs.' },
  { symbol: 'ALT',   project: 'AltLayer',     cadence: 'monthly',  approx_day_of_month: 25, magnitude: 'medium',  horizon_days: 14, note: 'Linear vesting tranche.' },
  { symbol: 'BLAST', project: 'Blast',        cadence: 'monthly',  approx_day_of_month: 26, magnitude: 'medium',  horizon_days: 14, note: 'Core team + investor unlocks.' },
  { symbol: 'EIGEN', project: 'EigenLayer',   cadence: 'monthly',  approx_day_of_month: 1,  magnitude: 'large',   horizon_days: 14, note: 'Phased unlocks following token transfer enablement.' },
  { symbol: 'ARB',   project: 'Arbitrum',     cadence: 'monthly',  approx_day_of_month: 16, magnitude: 'large',   horizon_days: 14, note: 'DAO + team + investor scheduled tranche.' },
  { symbol: 'OP',    project: 'Optimism',     cadence: 'monthly',  approx_day_of_month: 30, magnitude: 'large',   horizon_days: 14, note: 'Monthly OP token release schedule.' },
  { symbol: 'MANTA', project: 'Manta Network',cadence: 'monthly',  approx_day_of_month: 18, magnitude: 'medium',  horizon_days: 14, note: 'Investor + ecosystem unlocks.' },
  { symbol: 'SUI',   project: 'Sui',          cadence: 'monthly',  approx_day_of_month: 1,  magnitude: 'large',   horizon_days: 14, note: 'Monthly staking + investor unlocks; large absolute supply.' },
];

// Filter to symbols whose next unlock falls in the 14-day forward
// window. We compute the next occurrence of the cadence day-of-month
// from today and ship items where (date - now) <= 14 days.
function _nextOccurrence(approxDayOfMonth) {
  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), approxDayOfMonth, 12, 0, 0);
  if (thisMonth >= now) return thisMonth;
  return new Date(now.getFullYear(), now.getMonth() + 1, approxDayOfMonth, 12, 0, 0);
}

function buildDeepUnlocksContext() {
  const now = Date.now();
  const horizonMs = 14 * 24 * 3600 * 1000;
  const out = [];
  for (const u of DEEP_UNLOCK_SEED) {
    const next = _nextOccurrence(u.approx_day_of_month);
    const deltaMs = next.getTime() - now;
    if (deltaMs > horizonMs) continue;
    out.push({
      symbol: u.symbol,
      project: u.project,
      next_unlock_approx: next.toISOString().slice(0, 10),
      days_to_unlock: Math.max(0, Math.round(deltaMs / (24 * 3600 * 1000))),
      cadence: u.cadence,
      magnitude: u.magnitude,
      note: u.note,
    });
  }
  out.sort((a, b) => a.days_to_unlock - b.days_to_unlock);
  return {
    horizon_days: 14,
    universe: 'Curated L2 / new-listing high-impact symbols (ZRO, STRK, W, ENA, JTO, PYTH, IO, AEVO, ALT, BLAST, EIGEN, ARB, OP, MANTA, SUI)',
    notice: 'Dates are approximate scheduled cadences. The LLM MUST web-verify each before quoting hard timestamps.',
    items: out,
  };
}

async function buildMarketContext() {
  // V6.2 — fan-out across crypto / news / macro / geopolitical / unlocks
  // in parallel. Everything except top-100 is best-effort.
  const [topRes, newsRes, macroRes, geopolRes] = await Promise.allSettled([
    fetchCoinGeckoTop100(),
    fetchCryptoPanicHeadlines(),
    fetchMacroContext(),
    fetchGeopoliticalHeadlines(),
  ]);

  if (topRes.status !== 'fulfilled') {
    throw new Error(`Top-100 fetch failed: ${topRes.reason?.message || topRes.reason}`);
  }
  const top100 = topRes.value;
  const news = newsRes.status === 'fulfilled' ? newsRes.value : [];
  const macro = macroRes.status === 'fulfilled' ? macroRes.value : null;
  const geopolitical = geopolRes.status === 'fulfilled' ? geopolRes.value : [];
  const deep_unlocks = buildDeepUnlocksContext();

  const leaderboards = buildLeaderboards(top100);
  const top_10_by_mcap = [...top100]
    .filter((c) => Number.isFinite(c.market_cap))
    .sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0))
    .slice(0, 10)
    .map((c) => ({ rank: c.rank, symbol: c.symbol, name: c.name, price: c.price, market_cap: c.market_cap, pct_24h: c.pct_24h, pct_7d: c.pct_7d }));

  return {
    generated_at: new Date().toISOString(),
    universe: 'Top 100 by 24h volume (CoinGecko)',
    top_100: top100,
    top_10_by_mcap,
    leaderboards,
    news,
    news_count: news.length,
    macro,
    geopolitical_headlines: geopolitical,
    geopolitical_headlines_count: geopolitical.length,
    deep_unlocks,
  };
}

// ─────────────────────────────────────────────────────────────
// Gemini call with exponential backoff
//
// Wraps `runMarketBriefing` (which already walks a model fallback
// chain internally on 404) with a temporal retry loop on 429 / 5xx.
// We only retry on rate-limit / transient upstream errors — auth/
// quota errors fail fast so we don't waste 17 seconds backing off
// against a misconfigured key.
// ─────────────────────────────────────────────────────────────

function isRetryableGeminiError(e) {
  if (!(e instanceof GeminiApiError)) return false;
  const s = e.status;
  return s === 429 || (s >= 500 && s < 600);
}

async function runMarketBriefingWithBackoff(marketContext, lang) {
  let lastErr = null;
  for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt++) {
    const wait = RETRY_BACKOFF_MS[attempt];
    if (wait > 0) {
      console.warn(`[MKT-BRIEFING] retry #${attempt} — sleeping ${wait}ms before next Gemini attempt (last status=${lastErr?.status || 'n/a'})`);
      await sleep(wait);
    }
    try {
      const result = await runMarketBriefing(marketContext, lang);
      if (attempt > 0) {
        console.log(`[MKT-BRIEFING] succeeded on attempt #${attempt + 1}/${RETRY_BACKOFF_MS.length}`);
      }
      return { ok: true, result };
    } catch (e) {
      lastErr = e;
      if (!isRetryableGeminiError(e)) {
        // Auth/quota/config error — escalating won't help. Bail out
        // and let the fallback cascade decide.
        console.error(`[MKT-BRIEFING] non-retryable Gemini error (status=${e?.status}):`, e.message);
        break;
      }
      console.warn(`[MKT-BRIEFING] retryable Gemini error on attempt #${attempt + 1} (status=${e.status}):`, e.message);
    }
  }
  return { ok: false, error: lastErr };
}

// ─────────────────────────────────────────────────────────────
// Synthetic "Market Snapshot" — raw data, no AI
//
// Last-resort fallback when no cache OF ANY KIND exists and Gemini
// is unreachable. We render a markdown snapshot from the leaderboards
// so the UI never goes blank. The frontend renders a soft banner
// ("Briefing is being generated, please wait…") on top of this.
// ─────────────────────────────────────────────────────────────

function fmtPct(n) {
  if (!Number.isFinite(n)) return 'N/A';
  return (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
}

function fmtVol(n) {
  if (!Number.isFinite(n) || n <= 0) return 'N/A';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}

function buildSnapshotMarkdown(marketContext, lang) {
  const cs = lang === 'cs';
  const { gainers = [], losers = [], volume_leaders = [] } = marketContext.leaderboards || {};
  const newsCount = marketContext.news_count || 0;

  const head = cs
    ? '## 🌍 MARKET SNAPSHOT (raw data)\n\n*AI komentář je momentálně nedostupný (Gemini rate-limited). Níže najdeš čistá data z top 100 — gainers, losers, volume — bez interpretace.*\n'
    : '## 🌍 MARKET SNAPSHOT (raw data)\n\n*AI commentary is temporarily unavailable (Gemini rate-limited). Raw top-100 data — gainers, losers, volume — without commentary.*\n';

  const fmtLine = (c) => `- **${c.symbol}** (${c.name}) — ${fmtPct(c.pct_24h)}`;
  const fmtVolLine = (c) => `- **${c.symbol}** (${c.name}) — vol ${fmtVol(c.volume_24h)} · ${fmtPct(c.pct_24h)}`;

  const sections = [
    head,
    cs ? '### 📈 TOP GAINERS (24h)' : '### 📈 TOP GAINERS (24h)',
    gainers.length ? gainers.map(fmtLine).join('\n') : (cs ? '*Žádná data.*' : '*No data.*'),
    '',
    cs ? '### 📉 TOP LOSERS (24h)' : '### 📉 TOP LOSERS (24h)',
    losers.length ? losers.map(fmtLine).join('\n') : (cs ? '*Žádná data.*' : '*No data.*'),
    '',
    cs ? '### 💰 VOLUME LEADERS (24h)' : '### 💰 VOLUME LEADERS (24h)',
    volume_leaders.length ? volume_leaders.slice(0, 10).map(fmtVolLine).join('\n') : (cs ? '*Žádná data.*' : '*No data.*'),
    '',
    cs
      ? `*Zdroj: CoinGecko (top 100 dle 24h objemu) · ${newsCount} headlines z CryptoPanic v paměti pro budoucí AI briefing.*`
      : `*Source: CoinGecko (top 100 by 24h volume) · ${newsCount} CryptoPanic headlines buffered for next AI briefing.*`,
  ];
  return sections.join('\n');
}

// STRICT SCHEMA PARITY: the snapshot/fallback payload MUST mirror the
// exact JSON shape of a successful Gemini response. Same top-level
// keys (analysis, meta) and the same meta keys with sensible defaults.
// Anything that diverges WILL crash the frontend renderer when the
// successful path is replaced by this fallback during a Gemini 429.
function buildSnapshotPayload(marketContext, lang, fallbackReason) {
  const newsCount = marketContext?.news_count ?? 0;
  const topCount = marketContext?.top_100?.length ?? 0;
  return {
    analysis: buildSnapshotMarkdown(marketContext, lang),
    meta: {
      model: '<snapshot>',
      tried_models: [],
      latency_ms: 0,
      timestamp: new Date().toISOString(),
      kind: 'market-briefing-snapshot',
      cached: false,
      cache_layer: 'snapshot',
      stale: true,
      fallback_reason: fallbackReason,
      ai_skipped: true,
      cache_ttl_seconds: 0,
      news_count: newsCount,
      top_100_count: topCount,
      total_latency_ms: 0,
    },
  };
}

// Last-resort: source fetch failed AND no cache anywhere. We still
// return a valid payload (HTTP 200) so the frontend never sees a hard
// error — just a "degraded" banner. Same schema as success.
function buildMinimalFallbackPayload(lang, fallbackReason, upstreamError) {
  const cs = lang === 'cs';
  const text = cs
    ? '## 🌍 MARKET BRIEFING\n\n*Tržní data jsou momentálně nedostupná. Zkus to prosím za chvíli.*'
    : '## 🌍 MARKET BRIEFING\n\n*Market data is temporarily unavailable. Please try again shortly.*';
  const reason = upstreamError ? String(upstreamError).slice(0, 220) : fallbackReason;
  const richText = cs
    ? [
        '## MARKET BRIEFING',
        '',
        '### GLOBAL MACRO BACKDROP',
        'Primarni datovy feed je docasne degradovany, proto briefing neprepisuje tvrda cisla bez overeni. Rezim rizika ber jako opatrny: prioritu ma ochrana kapitalu, sledovani BTC dominance, DXY/SPX smeru a likvidity na perpech.',
        '',
        '### TOP-10 CRYPTO IN MACRO CONTEXT',
        'Bez aktualniho top-100 snapshotu nelze ferove seradit relativni silu. BTC a ETH zustavaji hlavni voditko trhu; alty obchoduj pouze tam, kde je potvrzeny objem, reclaim po flushi a jasne invalidacni misto.',
        '',
        '### META DIRECTION & LIQUIDITY ROTATION',
        'Dokud se data neobnovi, predpokladej zvysenou rotaci likvidity a falesne prurazy. Liquidation flush + stabilizace ma prednost pred chase vstupy do extended pohybu.',
        '',
        '### OPPORTUNITIES & CATALYSTS',
        'Cekej na cerstvy snapshot nebo rucne over objemove leadery. Plan: brat pouze potvrzene wick-reversal setupy, hard SL 3%, TP pasmo 10-20%, zadne zvysovani rizika behem degradace.',
        '',
        `*Fallback reason: ${reason}*`,
      ].join('\n')
    : [
        '## MARKET BRIEFING',
        '',
        '### GLOBAL MACRO BACKDROP',
        'The primary market-data feed is temporarily degraded, so this briefing will not invent fresh numbers. Treat the risk regime as cautious: prioritize capital protection and watch BTC dominance, DXY/SPX direction, and perp liquidity.',
        '',
        '### TOP-10 CRYPTO IN MACRO CONTEXT',
        'Without a live top-100 snapshot, relative-strength ranking is not reliable. BTC and ETH remain the market anchors; trade alts only when volume, reclaim after flush, and invalidation are clear.',
        '',
        '### META DIRECTION & LIQUIDITY ROTATION',
        'Until data recovers, assume elevated liquidity rotation and false breakouts. Liquidation flush plus stabilization takes priority over chasing extended moves.',
        '',
        '### OPPORTUNITIES & CATALYSTS',
        'Wait for a fresh snapshot or manually verify volume leaders. Plan: confirmed wick-reversal setups only, hard 3% SL, 10-20% TP band, no risk increase during degradation.',
        '',
        `*Fallback reason: ${reason}*`,
      ].join('\n');
  return {
    analysis: richText || text,
    meta: {
      model: '<unavailable>',
      tried_models: [],
      latency_ms: 0,
      timestamp: new Date().toISOString(),
      kind: 'market-briefing-degraded',
      cached: false,
      cache_layer: 'degraded',
      stale: true,
      fallback_reason: fallbackReason,
      ai_skipped: true,
      cache_ttl_seconds: 0,
      news_count: 0,
      top_100_count: 0,
      total_latency_ms: 0,
      upstream_error: upstreamError || null,
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────

export default async function handler(request) {
  // ── MASTER OUTER TRY/CATCH ──
  // This is the absolute last line of defense. If ANYTHING below
  // throws — including jsonResponse(), corsHeaders(), checkOrigin(),
  // or even a Deno runtime error — we still return a valid HTTP
  // response instead of crashing the isolate with an unhandled exception.
  try {
    return await _handleRequest(request);
  } catch (outerFatal) {
    logFatal({ location: 'market-briefing/outer-fatal', error: outerFatal, payload: { url: request.url, method: request.method } });
    try {
      // 200 OK GUARANTEE: even on an unexpected isolate-level error we
      // emit a well-shaped degraded payload so the frontend doesn't
      // flip to the hard error screen. Only return 500 if we can't
      // even build the minimal payload (next catch).
      const lang = (() => {
        try {
          if (request.method === 'GET') {
            return new URL(request.url).searchParams.get('lang') === 'en' ? 'en' : 'cs';
          }
        } catch { /* */ }
        return 'cs';
      })();
      const detail = outerFatal instanceof Error ? `${outerFatal.name}: ${outerFatal.message}` : String(outerFatal);
      const minimal = buildMinimalFallbackPayload(lang, 'isolate-fatal', detail);
      return jsonResponse(request, minimal);
    } catch (_doubleErr) {
      // jsonResponse itself crashed (e.g. request is malformed and
      // corsHeaders() throws). Return a bare Response with no CORS —
      // better than crashing the isolate entirely.
      console.error('BRIEFING DOUBLE FATAL (jsonResponse also crashed):', _doubleErr?.stack || _doubleErr);
      return new Response(
        JSON.stringify({ error: 'Internal Server Error', detail: 'Edge function crashed', stage: 'double-fatal' }),
        { status: 500, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }
}

async function _handleRequest(request) {
  const startedAt = Date.now();
  try {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    if (request.method !== 'POST' && request.method !== 'GET') {
      return jsonResponse(request, { error: 'Method Not Allowed' }, 405);
    }

    if (!Deno.env.get('GEMINI_API_KEY')) {
      console.error('[MKT-BRIEFING] GEMINI_API_KEY missing');
      return jsonResponse(request, { error: 'AI Engine offline - Configuration missing' }, 503);
    }

    const originCheck = checkOrigin(request);
    if (!originCheck.ok) {
      return jsonResponse(request, { error: 'Forbidden origin', detail: originCheck.reason }, 403);
    }

    const auth = await verifyAuth(request);
    if (!auth.ok) {
      return jsonResponse(request, { error: 'Unauthorized', detail: auth.reason }, auth.status);
    }
    const userId = auth.user.id;

    let lang = 'cs';
    let force = false;
    if (request.method === 'POST') {
      try {
        const body = JSON.parse(await request.text() || '{}');
        if (body?.lang === 'en') lang = 'en';
        if (body?.force === true) force = true;
      } catch { /* tolerate empty body */ }
    } else {
      const url = new URL(request.url);
      if (url.searchParams.get('lang') === 'en') lang = 'en';
    }

    // ── Cache layer 1: module-scope (fastest path, in-isolate) ──
    if (!force) {
      const memHit = moduleCacheGet(lang);
      if (memHit) {
        return jsonResponse(request, {
          ...memHit,
          meta: {
            ...(memHit.meta || {}),
            cached: true,
            cache_layer: 'module',
            total_latency_ms: Date.now() - startedAt,
          },
        });
      }

      // ── Cache layer 2: Redis (cross-isolate / cross-region) ──
      const redisHit = await redisCacheGet(lang);
      if (redisHit) {
        moduleCacheSet(lang, redisHit); // hydrate the local isolate
        return jsonResponse(request, {
          ...redisHit,
          meta: {
            ...(redisHit.meta || {}),
            cached: true,
            cache_layer: 'redis',
            total_latency_ms: Date.now() - startedAt,
          },
        });
      }
    }

    // Cache miss. NOW we apply the per-user rate limit — cache hits
    // shouldn't burn quota since they don't cost anything.
    // V5 hotfix: admin emails bypass the per-user briefing cap.
    const rl = isAdminUser(auth.user)
      ? { allowed: true, remaining: -1 }
      : await checkUserRateLimit(userId);
    if (!rl.allowed) {
      return jsonResponse(request, {
        error: 'Rate limit exceeded',
        detail: 'Per-user briefing limit reached for this hour.',
        retry_after_seconds: rl.retry_after_seconds,
      }, 429, { 'Retry-After': String(rl.retry_after_seconds || 3600) });
    }

    // ── Source data ──
    let marketContext;
    try {
      marketContext = await buildMarketContext();
    } catch (e) {
      console.error('[GEMINI FAIL]', 'context build failed:', e.message);
      const lastResort = await serveLastKnownGood(lang, 'source-fetch-failed', startedAt, e.message);
      if (lastResort) return jsonResponse(request, lastResort);
      // 200 OK GUARANTEE: even when source AND cache are gone, the
      // frontend gets a well-shaped degraded payload rather than a 502.
      const minimal = buildMinimalFallbackPayload(lang, 'source-fetch-failed', e.message);
      minimal.meta.total_latency_ms = Date.now() - startedAt;
      return jsonResponse(request, minimal);
    }

    // ── Gemini with exponential backoff ──
    const aiResult = await runMarketBriefingWithBackoff(marketContext, lang);

    if (aiResult.ok) {
      const payload = {
        analysis: aiResult.result.analysis,
        meta: {
          ...aiResult.result.meta,
          cached: false,
          cache_layer: 'live',
          stale: false,
          cache_ttl_seconds: BRIEFING_TTL_SEC,
          news_count: marketContext.news_count,
          top_100_count: marketContext.top_100.length,
          total_latency_ms: Date.now() - startedAt,
        },
      };
      moduleCacheSet(lang, payload);
      await Promise.all([
        redisCacheSet(lang, payload),
        redisStableSet(lang, payload),
      ]);
      return jsonResponse(request, payload);
    }

    // ── Fallback cascade: stale cache → in-memory stable → snapshot ──
    const reason = aiResult.error instanceof GeminiApiError && aiResult.error.status === 429
      ? 'gemini-rate-limited'
      : 'gemini-failed';
    // EXPLICIT FAILURE LOG: required signal for the production
    // dashboard — every Gemini exhaustion lands here with status + msg.
    console.error('[GEMINI FAIL]', aiResult.error?.message || String(aiResult.error), {
      status: aiResult.error?.status,
      reason,
      lang,
    });
    console.warn(`[MKT-BRIEFING] AI exhausted retries → fallback cascade (${reason})`);

    const fallback = await serveLastKnownGood(lang, reason, startedAt, aiResult.error?.message);
    if (fallback) return jsonResponse(request, fallback);

    // Truly nothing cached anywhere → render the synthetic snapshot
    const snapshot = buildSnapshotPayload(marketContext, lang, reason);
    snapshot.meta.total_latency_ms = Date.now() - startedAt;
    snapshot.meta.upstream_error = aiResult.error?.message;
    _moduleStableCache.set(lang, { at: Date.now(), payload: snapshot });
    return jsonResponse(request, snapshot);
  } catch (fatalErr) {
    logFatal({ location: 'market-briefing/inner-fatal', error: fatalErr, payload: { method: request.method } });
    const detail = fatalErr instanceof Error ? `${fatalErr.name}: ${fatalErr.message}` : String(fatalErr);
    // 200 OK GUARANTEE: degraded payload, not a 500.
    let langGuess = 'cs';
    try {
      if (request.method === 'GET') {
        langGuess = new URL(request.url).searchParams.get('lang') === 'en' ? 'en' : 'cs';
      }
    } catch { /* */ }
    const minimal = buildMinimalFallbackPayload(langGuess, 'handler-fatal', detail);
    minimal.meta.total_latency_ms = Date.now() - startedAt;
    return jsonResponse(request, minimal);
  }
}

// Try every cache we have, oldest-acceptable-first. Used when Gemini
// fails OR when the source fetch itself fails. Returns null if no
// cached payload exists anywhere.
async function serveLastKnownGood(lang, fallbackReason, startedAt, upstreamError) {
  // Redis "stale" copy first (cross-isolate, survives 30 days).
  const stableRedis = await redisStableGet(lang);
  if (stableRedis) {
    const generatedAt = stableRedis.meta?.timestamp;
    const ageSec = generatedAt ? Math.floor((Date.now() - new Date(generatedAt).getTime()) / 1000) : null;
    console.log(`[MKT-BRIEFING] serving stale-redis copy (age=${ageSec}s, reason=${fallbackReason})`);
    return {
      ...stableRedis,
      meta: {
        ...(stableRedis.meta || {}),
        cached: true,
        cache_layer: 'redis-stale',
        stale: true,
        stale_age_seconds: ageSec,
        fallback_reason: fallbackReason,
        upstream_error: upstreamError,
        total_latency_ms: Date.now() - startedAt,
      },
    };
  }

  // In-memory stable copy from THIS isolate (survives until isolate dies).
  const stableMem = moduleStableGet(lang);
  if (stableMem) {
    const ageSec = Math.floor(stableMem.age_ms / 1000);
    console.log(`[MKT-BRIEFING] serving stale-memory copy (age=${ageSec}s, reason=${fallbackReason})`);
    return {
      ...stableMem.payload,
      meta: {
        ...(stableMem.payload.meta || {}),
        cached: true,
        cache_layer: 'memory-stale',
        stale: true,
        stale_age_seconds: ageSec,
        fallback_reason: fallbackReason,
        upstream_error: upstreamError,
        total_latency_ms: Date.now() - startedAt,
      },
    };
  }

  return null;
}
