// ─────────────────────────────────────────────────────────────
// Swing Terminal v2.0 — Redis (Deno Edge)
//
// Post-pivot role: Redis is now ONLY a defensive shield around our
// API credits. Two responsibilities:
//   1. Atomic rate limiting (per-user + global) via a Lua script.
//   2. AI analysis result cache (`ai:<symbol>:<lang>`) with TTL.
//
// All market-data hash reads (HGETALL `snap:*`) are gone — the
// background ingest worker no longer exists.
// ─────────────────────────────────────────────────────────────

import { Redis } from 'https://esm.sh/@upstash/redis';

// ── Constants ──
const REDIS_KEYS = {
  AI_CACHE: 'ai',
  RATE_LIMIT: 'rl',
  RATE_LIMIT_GLOBAL: 'rl:global',
  REGIME_CURRENT: 'regime:current',
  REGIME_HISTORY: 'regime:history',
};

// Market regime cache. The /api/regime endpoint fans out to Binance
// /ticker/24hr for ~500 pairs; recomputing per request would burn
// API weight unnecessarily. 15 min TTL is the right balance — short
// enough that a real bear flush is caught within one refresh cycle,
// long enough that idle browsers don't keep the cache hot for free.
const REGIME_TTL_SECONDS = 15 * 60;
const REGIME_HISTORY_LIMIT = 10;

// Default TTL for cached AI analyses (seconds). Tuned so a coin's
// analysis can be re-served instantly to other users hitting the
// same pair within the window. Keep below the max session a trader
// would care about staring at a single thesis (~12 min default).
const AI_CACHE_TTL_SECONDS = parseInt(
  Deno.env.get('AI_CACHE_TTL_SECONDS') || '720',
  10,
);

// ── Singleton Redis client ──
let _redis = null;

export function getRedis() {
  if (_redis) return _redis;
  const url = Deno.env.get('UPSTASH_REDIS_REST_URL');
  const token = Deno.env.get('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) {
    console.warn('[REDIS] UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN missing — Redis disabled, using in-memory fallback only.');
    return null;
  }
  try {
    _redis = new Redis({ url, token });
  } catch (e) {
    console.error('[REDIS] Failed to create Redis client:', e.message);
    return null;
  }
  return _redis;
}

// ─────────────────────────────────────────────────────────────
// AI Analysis Cache
// ─────────────────────────────────────────────────────────────

export function aiCacheKey(symbol, lang) {
  return `${REDIS_KEYS.AI_CACHE}:${symbol}:${lang || 'cs'}`;
}

/**
 * Read a cached analysis. Returns the parsed object or null on miss.
 * Soft-fails (returns null) on any Redis error so the caller can
 * proceed with a fresh fetch instead of erroring out.
 */
export async function aiCacheGet(symbol, lang) {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(aiCacheKey(symbol, lang));
    if (raw == null) return null;
    return typeof raw === 'object' ? raw : JSON.parse(String(raw));
  } catch (err) {
    console.warn('[REDIS] aiCacheGet error:', err.message);
    return null;
  }
}

/**
 * Store an analysis in cache. Soft-fails — a cache write error must
 * never break the request.
 */
export async function aiCacheSet(symbol, lang, payload) {
  try {
    const redis = getRedis();
    if (!redis) return 0;
    const value = JSON.stringify(payload);
    await redis.set(aiCacheKey(symbol, lang), value, { ex: AI_CACHE_TTL_SECONDS });
    return AI_CACHE_TTL_SECONDS;
  } catch (err) {
    console.warn('[REDIS] aiCacheSet error:', err.message);
    return 0;
  }
}

export function getAiCacheTtlSeconds() {
  return AI_CACHE_TTL_SECONDS;
}

// ─────────────────────────────────────────────────────────────
// Rate Limiter (atomic Lua)
// ─────────────────────────────────────────────────────────────

// V5 (D-2): atomic combined user + global rate limit.
// Old code ran two separate Lua evals — a failed user attempt would
// still consume a global slot. New script checks user FIRST, then global,
// only incrementing both if both pass. If either is over its cap we
// return the offending scope without consuming anything from the other.
//
// KEYS[1] = user_key, KEYS[2] = global_key
// ARGV[1] = user_limit, ARGV[2] = user_window_ms
// ARGV[3] = global_limit, ARGV[4] = global_window_ms
// Reply (string): "scope:remaining_user:reset_user:remaining_global:reset_global"
//   scope ∈ {"ok","user","global"}
const COMBINED_RATE_LIMIT_LUA = `
local user_key = KEYS[1]
local global_key = KEYS[2]
local user_limit = tonumber(ARGV[1])
local user_window_ms = tonumber(ARGV[2])
local global_limit = tonumber(ARGV[3])
local global_window_ms = tonumber(ARGV[4])

local user_current = tonumber(redis.call('GET', user_key) or '0')
local global_current = tonumber(redis.call('GET', global_key) or '0')

local user_ttl = redis.call('PTTL', user_key)
if user_ttl < 0 then user_ttl = 0 end
local global_ttl = redis.call('PTTL', global_key)
if global_ttl < 0 then global_ttl = 0 end

if user_current >= user_limit then
  return 'user:0:' .. tostring(user_ttl) .. ':' .. tostring(math.max(0, global_limit - global_current)) .. ':' .. tostring(global_ttl)
end
if global_current >= global_limit then
  return 'global:' .. tostring(math.max(0, user_limit - user_current)) .. ':' .. tostring(user_ttl) .. ':0:' .. tostring(global_ttl)
end

local u = redis.call('INCR', user_key)
if u == 1 then redis.call('PEXPIRE', user_key, user_window_ms) end
local g = redis.call('INCR', global_key)
if g == 1 then redis.call('PEXPIRE', global_key, global_window_ms) end

user_ttl = redis.call('PTTL', user_key)
if user_ttl < 0 then user_ttl = 0 end
global_ttl = redis.call('PTTL', global_key)
if global_ttl < 0 then global_ttl = 0 end

return 'ok:' .. tostring(user_limit - u) .. ':' .. tostring(user_ttl) .. ':' .. tostring(global_limit - g) .. ':' .. tostring(global_ttl)
`;

function symbolToKey(symbol) {
  return symbol.replace(/[/:]/g, '_');
}

// Phase 3 tier limits. Free tier = 5/hr AI requests per pair; Pro = 30/hr.
// Reads from env so ops can re-tune without a redeploy.
function getTierUserLimit(tier) {
  if (tier === 'pro') return parseInt(Deno.env.get('RL_USER_LIMIT_PRO') || '30', 10);
  return parseInt(Deno.env.get('RL_USER_LIMIT_FREE') || '5', 10);
}

/**
 * Atomic combined rate limit. Returns:
 *   { allowed, scope: 'ok' | 'user' | 'global', remaining, reset_ms, tier }
 * On Redis failure we fail-open (allowed=true) so transient outages
 * don't lock users out, same as the legacy single-bucket behavior.
 *
 * @param {string} userId
 * @param {string} symbol
 * @param {string} [tier]  'free' | 'pro' — drives per-user limit
 */
export async function checkRateLimit(userId, symbol, tier = 'free') {
  try {
    const redis = getRedis();
    if (!redis) return { allowed: true, remaining: -1, reset_ms: 0, scope: 'ok', tier };

    const userKey = `${REDIS_KEYS.RATE_LIMIT}:${tier}:${userId}:${symbolToKey(symbol)}`;
    const globalKey = REDIS_KEYS.RATE_LIMIT_GLOBAL;

    const userLimit = getTierUserLimit(tier);
    const userWindowMs = parseInt(Deno.env.get('RL_USER_WINDOW_MS') || '3600000', 10);
    const globalLimit = parseInt(Deno.env.get('RL_GLOBAL_CAPACITY') || '1000', 10);
    const globalWindowMs = parseInt(Deno.env.get('RL_GLOBAL_WINDOW_MS') || '3600000', 10);

    const result = await redis.eval(
      COMBINED_RATE_LIMIT_LUA,
      [userKey, globalKey],
      [String(userLimit), String(userWindowMs), String(globalLimit), String(globalWindowMs)],
    );
    const parts = String(result).split(':');
    const scope = parts[0];
    const remUser = parseInt(parts[1], 10);
    const resetUser = parseInt(parts[2], 10);
    const remGlobal = parseInt(parts[3], 10);
    const resetGlobal = parseInt(parts[4], 10);

    if (scope === 'ok') {
      return {
        allowed: true,
        scope: 'ok',
        remaining: Math.min(remUser, remGlobal),
        reset_ms: Math.max(resetUser, resetGlobal),
        tier,
      };
    }
    return {
      allowed: false,
      scope,
      remaining: 0,
      reset_ms: scope === 'user' ? resetUser : resetGlobal,
      tier,
    };
  } catch (err) {
    console.error('[RATE_LIMIT] Error:', err.message);
    return { allowed: true, remaining: -1, reset_ms: 0, scope: 'ok', tier };
  }
}

// ─────────────────────────────────────────────────────────────
// Market Regime cache + history
//
// Two keys:
//   • regime:current   — JSON snapshot, 15 min TTL.
//   • regime:history   — Redis LIST, LPUSH on label transitions,
//                        capped to last 10 entries via LTRIM.
// All helpers soft-fail (return null / empty / false) so a Redis
// blip never breaks the /api/regime response.
// ─────────────────────────────────────────────────────────────

export function getRegimeTtlSeconds() {
  return REGIME_TTL_SECONDS;
}

export function getRegimeHistoryLimit() {
  return REGIME_HISTORY_LIMIT;
}

function _safeParse(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch { return null; }
}

export async function regimeCacheGet() {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.get(REDIS_KEYS.REGIME_CURRENT);
    return _safeParse(raw);
  } catch (err) {
    console.warn('[REDIS] regimeCacheGet error:', err.message);
    return null;
  }
}

export async function regimeCacheSet(state) {
  try {
    const redis = getRedis();
    if (!redis) return 0;
    await redis.set(REDIS_KEYS.REGIME_CURRENT, JSON.stringify(state), { ex: REGIME_TTL_SECONDS });
    return REGIME_TTL_SECONDS;
  } catch (err) {
    console.warn('[REDIS] regimeCacheSet error:', err.message);
    return 0;
  }
}

export async function regimeHistoryHead() {
  try {
    const redis = getRedis();
    if (!redis) return null;
    const raw = await redis.lindex(REDIS_KEYS.REGIME_HISTORY, 0);
    return _safeParse(raw);
  } catch (err) {
    console.warn('[REDIS] regimeHistoryHead error:', err.message);
    return null;
  }
}

export async function regimeHistoryPush(entry) {
  try {
    const redis = getRedis();
    if (!redis) return false;
    await redis.lpush(REDIS_KEYS.REGIME_HISTORY, JSON.stringify(entry));
    await redis.ltrim(REDIS_KEYS.REGIME_HISTORY, 0, REGIME_HISTORY_LIMIT - 1);
    return true;
  } catch (err) {
    console.warn('[REDIS] regimeHistoryPush error:', err.message);
    return false;
  }
}

export async function regimeHistoryList() {
  try {
    const redis = getRedis();
    if (!redis) return [];
    const raw = await redis.lrange(REDIS_KEYS.REGIME_HISTORY, 0, REGIME_HISTORY_LIMIT - 1);
    if (!Array.isArray(raw)) return [];
    return raw.map(_safeParse).filter(Boolean);
  } catch (err) {
    console.warn('[REDIS] regimeHistoryList error:', err.message);
    return [];
  }
}
