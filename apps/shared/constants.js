// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Shared Constants
// Used by both Netlify Edge (Deno) and Fly.io Ingest (Node.js)
// ─────────────────────────────────────────────────────────────

/** Redis key prefixes */
export const REDIS_KEYS = {
  /** md:{symbol}  — hash with live market data */
  MARKET_DATA: 'md',
  /** snap:{symbol} — latest complete JSON snapshot */
  SNAPSHOT: 'snap',
  /** trigger:snap:{symbol} — snapshot created by trigger engine */
  TRIGGER_SNAPSHOT: 'trigger:snap',
  /** cd:{rule}:{symbol} — cooldown flag after trigger fires */
  COOLDOWN: 'cd',
  /** rl:{userId}:{symbol} — rate limit counter */
  RATE_LIMIT: 'rl',
  /** rl:global — global rate limit counter */
  RATE_LIMIT_GLOBAL: 'rl:global',
  /** active_symbols — set of currently ingested symbols */
  ACTIVE_SYMBOLS: 'active_symbols',
};

/** TTL values in milliseconds */
export const TTL = {
  /** Market data expires after 30s (freshness gate) */
  MARKET_DATA_MS: 30_000,
  /** Complete snapshot expires after 60s */
  SNAPSHOT_MS: 60_000,
  /** Trigger snapshot stays 15 minutes for AI consumption */
  TRIGGER_SNAPSHOT_MS: 900_000,
  /** Cooldown after trigger fires — 15 minutes per rule/symbol */
  COOLDOWN_MS: 900_000,
  /** JWKS public key cache — 5 minutes */
  JWKS_CACHE_MS: 300_000,
};

/** Freshness gate: reject AI analysis if data is older than this */
export const FRESHNESS_THRESHOLD_MS = 30_000;

/** HMAC timestamp tolerance: reject signatures older than 5 minutes */
export const HMAC_MAX_AGE_MS = 300_000;

/** Default volume threshold for USDC perpetual filtering */
export const VOLUME_THRESHOLD_USDC = 5_000_000;

/**
 * Hard cap on how many base coins we stream via WebSocket.
 * Railway / Binance cannot reliably sustain ~600 concurrent streams,
 * which produced empty Redis buckets. Top-N by 24h volume keeps the
 * universe at a size the worker can actually keep live.
 */
export const TOP_N_SYMBOLS = 150;

/** How often to re-evaluate which symbols meet volume threshold */
export const MARKET_REFRESH_INTERVAL_MS = 3_600_000;

/**
 * Aggregation bucket width for incoming WebSocket ticks.
 * Bumped from 5s → 30s: Upstash free-tier caps at 500k commands/day and
 * 5s flushes blew through the quota ("ERR max requests limit exceeded").
 * 30s × 150 symbols = ~432k writes/day, which fits under the cap.
 */
export const AGGREGATION_INTERVAL_MS = 30_000;

/** Trigger engine rule identifiers */
export const RULES = {
  /** Funding rate jump > 15% from previous reading */
  FUNDING_SPIKE: 'a7',
  /** OI buildup + taker aggressivity */
  OI_TAKER_COMBO: 'b3',
};

/** Trigger thresholds */
export const TRIGGER_THRESHOLDS = {
  /** rule_a7: funding rate change threshold (15%) */
  FUNDING_RATE_DELTA_PCT: 0.15,
  /** rule_b3: taker buy ratio threshold */
  TAKER_BUY_RATIO: 0.65,
  /** rule_b3: OI change threshold (2%) */
  OI_CHANGE_PCT: 0.02,
};

// ─────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────

/**
 * Converts a ccxt symbol (e.g. "BTC/USDC:USDC") to a safe Redis key segment.
 * @param {string} symbol  ccxt symbol
 * @returns {string}       sanitized key segment (e.g. "BTC_USDC_USDC")
 */
export function symbolToKey(symbol) {
  return symbol.replace(/[/:]/g, '_');
}

/**
 * Builds a full Redis key from prefix + symbol.
 * @param {string} prefix  one of REDIS_KEYS.*
 * @param {string} symbol  ccxt symbol
 * @returns {string}        e.g. "md:BTC_USDC_USDC"
 */
export function redisKey(prefix, symbol) {
  return `${prefix}:${symbolToKey(symbol)}`;
}
