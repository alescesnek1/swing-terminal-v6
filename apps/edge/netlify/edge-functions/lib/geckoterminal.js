// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — GeckoTerminal DEX data (Deno Edge)
//
// Phase 3 scope: Solana (network=solana) and Ethereum L1
// (network=eth). Used by /api/analyze for coins where
// ctx.binance_available === false, giving Gemini real DEX liquidity
// + on-chain trading data instead of the CoinGecko-only fallback.
//
// Public API requires no key — rate limit ~30 rpm. We cache in Redis
// for 60s per pool address to absorb bursts.
// ─────────────────────────────────────────────────────────────

import { getRedis } from './redis.js';
import { logWarn } from './log.js';

const GT_BASE = 'https://api.geckoterminal.com/api/v2';
const CACHE_TTL_SEC = 60;
const FETCH_TIMEOUT_MS = 5000;

// CoinGecko id → { network, address }. The CoinGecko response on the
// markets endpoint includes `platforms` per coin, but our markets.js
// trims that out — so for v5 we ship a tiny static index for the
// most-traded DEX coins and fall through to a search lookup for
// anything else. Static entries avoid an extra fetch on the hot path.
const STATIC_CONTRACT_INDEX = {
  // Ethereum mainnet
  'pepe':            { network: 'eth', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' },
  'shiba-inu':       { network: 'eth', address: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce' },
  'mog-coin':        { network: 'eth', address: '0xaaee1a9723aadb7afa2810263653a34ba2c21c7a' },
  'wojak':           { network: 'eth', address: '0x5026f006b85729a8b14553fae6af249ad16c9aab' },
  // Solana
  'dogwifcoin':      { network: 'solana', address: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  'bonk':            { network: 'solana', address: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  'jupiter-exchange-solana': { network: 'solana', address: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  'popcat':          { network: 'solana', address: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
};

async function fetchWithTimeout(url, label) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'Accept': 'application/json', 'User-Agent': 'SwingTerminal/5.0' },
    });
    if (!r.ok) throw new Error(`${label} HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function cacheGet(key) {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(key);
    if (raw == null) return null;
    return typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch (e) {
    logWarn({ location: 'geckoterminal/cache-get', error: e, payload: { key } });
    return null;
  }
}

async function cacheSet(key, value) {
  try {
    const redis = getRedis();
    if (!redis) return;
    await redis.set(key, JSON.stringify(value), { ex: CACHE_TTL_SEC });
  } catch (e) {
    logWarn({ location: 'geckoterminal/cache-set', error: e, payload: { key } });
  }
}

/**
 * Resolve a CoinGecko id to { network, address }. Static index first,
 * search API fallback. Returns null if the coin isn't a tradable DEX
 * asset on a supported chain.
 */
async function resolveContract(coingeckoId) {
  if (!coingeckoId) return null;
  const id = String(coingeckoId).toLowerCase();
  if (STATIC_CONTRACT_INDEX[id]) return STATIC_CONTRACT_INDEX[id];

  // Fall through: GeckoTerminal search.
  const cacheKey = `gt:resolve:${id}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  try {
    const data = await fetchWithTimeout(
      `${GT_BASE}/search/pools?query=${encodeURIComponent(id)}&network=eth,solana&page=1`,
      'gt-search',
    );
    const top = data?.data?.[0];
    if (!top) {
      await cacheSet(cacheKey, null);
      return null;
    }
    const network = top.relationships?.network?.data?.id || null;
    const address = top.attributes?.address || null;
    if (!network || !address) return null;
    const result = { network, address };
    await cacheSet(cacheKey, result);
    return result;
  } catch (e) {
    logWarn({ location: 'geckoterminal/resolve', error: e, payload: { id } });
    return null;
  }
}

/**
 * Fetch a DEX trading snapshot for the given CoinGecko id. Output
 * mirrors the structure analyze.js feeds Gemini so the prompt stays
 * stable across BIN / ALPHA / DEX paths.
 *
 * Returns null if the asset isn't on a supported chain or all fetches
 * fail — caller falls back to the CoinGecko-only path.
 */
export async function fetchDexSnapshot(coingeckoId) {
  const contract = await resolveContract(coingeckoId);
  if (!contract) return null;

  const cacheKey = `gt:snap:${contract.network}:${contract.address.toLowerCase()}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return { ...cached, _from_cache: true };

  try {
    // /networks/{net}/tokens/{addr} returns price + top pools + volume.
    const tokenData = await fetchWithTimeout(
      `${GT_BASE}/networks/${contract.network}/tokens/${contract.address}?include=top_pools`,
      'gt-token',
    );
    const attrs = tokenData?.data?.attributes || {};
    const topPools = (tokenData?.included || []).filter((x) => x.type === 'pool').slice(0, 3);
    const poolSummary = topPools.map((p) => ({
      name: p.attributes?.name,
      dex: p.relationships?.dex?.data?.id,
      reserve_in_usd: parseFloat(p.attributes?.reserve_in_usd || '0'),
      volume_24h_usd: parseFloat(p.attributes?.volume_usd?.h24 || '0'),
      price_change_24h: parseFloat(p.attributes?.price_change_percentage?.h24 || '0'),
      transactions_24h_buys: p.attributes?.transactions?.h24?.buys || 0,
      transactions_24h_sells: p.attributes?.transactions?.h24?.sells || 0,
    }));

    const snapshot = {
      source: 'geckoterminal',
      network: contract.network,
      address: contract.address,
      symbol: attrs.symbol,
      name: attrs.name,
      price_usd: parseFloat(attrs.price_usd || '0'),
      fdv_usd: parseFloat(attrs.fdv_usd || '0'),
      market_cap_usd: parseFloat(attrs.market_cap_usd || '0'),
      total_reserve_in_usd: parseFloat(attrs.total_reserve_in_usd || '0'),
      volume_24h_usd: parseFloat(attrs.volume_usd?.h24 || '0'),
      total_supply: attrs.total_supply,
      top_pools: poolSummary,
      fetched_at: new Date().toISOString(),
    };
    await cacheSet(cacheKey, snapshot);
    return snapshot;
  } catch (e) {
    logWarn({ location: 'geckoterminal/snapshot', error: e, payload: { coingeckoId, contract } });
    return null;
  }
}
