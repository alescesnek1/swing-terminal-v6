// binance-public.mjs — public market data fetcher for Binance spot
//
// PURE PUBLIC: uses no API keys, no signatures, and guarantees no order execution.
// Only accesses /api/v3/exchangeInfo, /ticker/24hr, and /ticker/bookTicker.

const ALLOWED_ENDPOINTS = [
  '/api/v3/exchangeInfo',
  '/api/v3/ticker/24hr',
  '/api/v3/ticker/bookTicker',
];

function checkUrl(url) {
  const u = new URL(url);
  if (u.hostname !== 'api.binance.com') throw new Error('Disallowed hostname: ' + u.hostname);
  if (!ALLOWED_ENDPOINTS.includes(u.pathname)) throw new Error('Disallowed endpoint: ' + u.pathname);
  if (u.pathname.includes('/order') || u.pathname.includes('/fapi') || u.pathname.includes('/dapi') || u.pathname.includes('/sapi')) {
    throw new Error('Disallowed namespace/action: ' + u.pathname);
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

export async function fetchBinancePublicUniverse() {
  const [exchangeInfo, ticker24hr, bookTicker] = await Promise.allSettled([
    fetchWithTimeoutAndRetry('https://api.binance.com/api/v3/exchangeInfo'),
    fetchWithTimeoutAndRetry('https://api.binance.com/api/v3/ticker/24hr'),
    fetchWithTimeoutAndRetry('https://api.binance.com/api/v3/ticker/bookTicker'),
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

  const markets = [];

  for (const s of symbols) {
    if (!s || !s.symbol) continue;
    const t = tickerMap.get(s.symbol);
    if (!t) continue;

    const b = bookMap.get(s.symbol);
    
    let spreadPct = null;
    if (b) {
      const ask = Number(b.askPrice);
      const bid = Number(b.bidPrice);
      if (bid > 0 && ask >= bid) {
        spreadPct = ((ask - bid) / bid) * 100;
      }
    }

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
