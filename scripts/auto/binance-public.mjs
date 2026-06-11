// binance-public.mjs — public market data fetcher for Binance spot
//
// PURE PUBLIC: uses no API keys, no signatures, and guarantees no order execution.
// Only accesses /api/v3/exchangeInfo, /ticker/24hr, and /ticker/bookTicker.
//
// Two consumers share this module:
//   • Netlify serverless (fetchBinancePublicUniverse) — fallback path; may be
//     egress-blocked by Binance (HTTP 451 for some serverless IP ranges).
//   • The local worker (fetchBinancePublicSnapshot) — primary path; runs on the
//     operator's machine where Binance public endpoints are reachable, and posts a
//     sanitized snapshot to the control plane.

const ALLOWED_ENDPOINTS = [
  '/api/v3/exchangeInfo',
  '/api/v3/ticker/24hr',
  '/api/v3/ticker/bookTicker',
];

// Base URLs are restricted to Binance public spot API hosts. A custom base
// (BINANCE_BASE_URL on the worker) can pick a mirror, never a different service.
const ALLOWED_HOSTNAMES = new Set([
  'api.binance.com',
  'api1.binance.com',
  'api2.binance.com',
  'api3.binance.com',
  'api4.binance.com',
  'data-api.binance.vision',
]);
const DEFAULT_BASE_URL = 'https://api.binance.com';

export const PUBLIC_SNAPSHOT_SOURCE = 'local_worker_binance_public';

export function resolvePublicBaseUrl(baseUrl) {
  const raw = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid Binance public base URL: ' + raw); }
  if (u.protocol !== 'https:') throw new Error('Binance public base URL must be https: ' + raw);
  if (!ALLOWED_HOSTNAMES.has(u.hostname)) throw new Error('Disallowed hostname: ' + u.hostname);
  if (u.pathname && u.pathname !== '/') throw new Error('Binance public base URL must not include a path: ' + raw);
  return `${u.protocol}//${u.host}`;
}

function checkUrl(url) {
  const u = new URL(url);
  if (!ALLOWED_HOSTNAMES.has(u.hostname)) throw new Error('Disallowed hostname: ' + u.hostname);
  if (!ALLOWED_ENDPOINTS.includes(u.pathname)) throw new Error('Disallowed endpoint: ' + u.pathname);
  if (u.pathname.includes('/order') || u.pathname.includes('/fapi') || u.pathname.includes('/dapi') || u.pathname.includes('/sapi')) {
    throw new Error('Disallowed namespace/action: ' + u.pathname);
  }
  // Public-only: never a signed request, never leverage/margin params.
  const qs = u.search.toLowerCase();
  if (qs.includes('signature') || qs.includes('timestamp') || qs.includes('margin') || qs.includes('leverage')) {
    throw new Error('Disallowed query parameter for public endpoint: ' + u.search);
  }
}

async function fetchWithTimeoutAndRetry(url, timeoutMs = 5000) {
  checkUrl(url);

  let attempt = 0;
  while (attempt < 2) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { 'Accept': 'application/json' }, // NO API KEY HERE
        signal: controller.signal,
      });
      clearTimeout(id);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(id);
      attempt++;
      if (attempt >= 2) throw err;
      // Jitter backoff 250-750ms
      const delay = Math.floor(250 + Math.random() * 500);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function fetchPublicRaw(baseUrl) {
  const base = resolvePublicBaseUrl(baseUrl);
  const [exchangeInfo, ticker24hr, bookTicker] = await Promise.allSettled([
    fetchWithTimeoutAndRetry(`${base}/api/v3/exchangeInfo`),
    fetchWithTimeoutAndRetry(`${base}/api/v3/ticker/24hr`),
    fetchWithTimeoutAndRetry(`${base}/api/v3/ticker/bookTicker`),
  ]);

  if (exchangeInfo.status === 'rejected') throw new Error('exchangeInfo failed: ' + exchangeInfo.reason);
  if (ticker24hr.status === 'rejected') throw new Error('ticker/24hr failed: ' + ticker24hr.reason);

  const symbols = exchangeInfo.value.symbols || [];
  const tickers = ticker24hr.value || [];
  const books = bookTicker.status === 'fulfilled' ? (bookTicker.value || []) : [];

  const tickerMap = new Map();
  for (const t of tickers) {
    tickerMap.set(t.symbol, t);
  }

  const bookMap = new Map();
  for (const b of books) {
    bookMap.set(b.symbol, b);
  }

  return { symbols, tickerMap, bookMap };
}

function spreadPctFromBook(b) {
  if (!b) return null;
  const ask = Number(b.askPrice);
  const bid = Number(b.bidPrice);
  if (bid > 0 && ask >= bid) return ((ask - bid) / bid) * 100;
  return null;
}

export async function fetchBinancePublicUniverse(opts = {}) {
  const { symbols, tickerMap, bookMap } = await fetchPublicRaw(opts.baseUrl);
  const markets = [];

  for (const s of symbols) {
    if (!s || !s.symbol) continue;
    const t = tickerMap.get(s.symbol);
    if (!t) continue;

    const b = bookMap.get(s.symbol);
    const spreadPct = spreadPctFromBook(b);

    markets.push({
      symbol: s.symbol,
      status: s.status, // e.g. 'TRADING'
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      change24hPct: Number(t.priceChangePercent),
      volume24hUsd: Number(t.quoteVolume),
      quoteVolume24h: Number(t.quoteVolume),
      spreadPct: spreadPct,
    });
  }

  return markets;
}

// Worker-side snapshot: a bounded, sanitized array of public spot market objects
// suitable for posting to the control plane. Pre-filters to TRADING stablecoin
// quotes and caps the list so the fleet document stays small.
export async function fetchBinancePublicSnapshot({ baseUrl, quoteAssets = ['USDC', 'USDT'], maxMarkets = 300 } = {}) {
  const fetchedAt = new Date().toISOString();
  const { symbols, tickerMap, bookMap } = await fetchPublicRaw(baseUrl);
  const quotes = new Set(quoteAssets.map((q) => String(q).toUpperCase()));

  let markets = [];
  for (const s of symbols) {
    if (!s || !s.symbol || !s.quoteAsset) continue;
    if (String(s.status).toUpperCase() !== 'TRADING') continue;
    if (!quotes.has(String(s.quoteAsset).toUpperCase())) continue;
    const t = tickerMap.get(s.symbol);
    if (!t) continue;
    const b = bookMap.get(s.symbol);
    markets.push({
      symbol: String(s.symbol).slice(0, 24),
      baseAsset: String(s.baseAsset || '').slice(0, 16),
      quoteAsset: String(s.quoteAsset || '').slice(0, 16),
      status: String(s.status || '').slice(0, 16),
      quoteVolume: Number(t.quoteVolume),
      volume: Number(t.volume),
      bidPrice: b ? Number(b.bidPrice) : null,
      askPrice: b ? Number(b.askPrice) : null,
      spreadPct: spreadPctFromBook(b),
      priceChangePercent: Number(t.priceChangePercent),
      source: PUBLIC_SNAPSHOT_SOURCE,
    });
  }

  markets.sort((a, b) => (Number(b.quoteVolume) || 0) - (Number(a.quoteVolume) || 0));
  const totalEligible = markets.length;
  markets = markets.slice(0, maxMarkets);

  return {
    source: PUBLIC_SNAPSHOT_SOURCE,
    fetchedAt,
    markets,
    diagnostics: {
      fetchedSymbols: symbols.length,
      eligibleSymbols: totalEligible,
      postedSymbols: markets.length,
      quoteAssets: Array.from(quotes),
      baseUrl: resolvePublicBaseUrl(baseUrl),
    },
  };
}
