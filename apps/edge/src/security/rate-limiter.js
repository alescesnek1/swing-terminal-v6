// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Redis-based Rate Limiter (Edge)
// Atomic Lua script prevents bypass via parallel requests.
// ─────────────────────────────────────────────────────────────

import { evalLua } from '../../../shared/redis-client.js';
import { REDIS_KEYS, redisKey } from '../../../shared/constants.js';

/**
 * Lua script for atomic rate limiting.
 *
 * KEYS[1] = rate limit key
 * ARGV[1] = max allowed requests
 * ARGV[2] = window duration in milliseconds
 *
 * Returns string: "remaining:ttl_ms"
 *   - remaining >= 0 → allowed
 *   - remaining < 0  → denied
 */
const RATE_LIMIT_LUA = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])

local current = tonumber(redis.call('GET', key) or '0')

if current >= limit then
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then ttl = 0 end
  return tostring(-1) .. ':' .. tostring(ttl)
end

local new_count = redis.call('INCR', key)
if new_count == 1 then
  redis.call('PEXPIRE', key, window_ms)
end

local remaining = limit - new_count
local ttl = redis.call('PTTL', key)
return tostring(remaining) .. ':' .. tostring(ttl)
`;

/**
 * Check per-user rate limit for a specific symbol.
 *
 * @param {string} userId   user identifier (JWT sub claim)
 * @param {string} symbol   trading pair symbol
 * @returns {Promise<{allowed: boolean, remaining: number, reset_ms: number}>}
 */
export async function checkUserRateLimit(userId, symbol) {
  const key = redisKey(REDIS_KEYS.RATE_LIMIT, `${userId}:${symbol}`);
  const windowMs = parseInt(Deno.env.get('RL_USER_WINDOW_MS') || '900000', 10);
  const limit = 1; // 1 request per 15 min per symbol

  return _execRateLimit(key, limit, windowMs);
}

/**
 * Check global rate limit (across all users).
 *
 * @returns {Promise<{allowed: boolean, remaining: number, reset_ms: number}>}
 */
export async function checkGlobalRateLimit() {
  const key = REDIS_KEYS.RATE_LIMIT_GLOBAL;
  const capacity = parseInt(Deno.env.get('RL_GLOBAL_CAPACITY') || '120', 10);
  const windowMs = parseInt(Deno.env.get('RL_GLOBAL_WINDOW_MS') || '3600000', 10);

  return _execRateLimit(key, capacity, windowMs);
}

/**
 * Combined rate limit check: global + per-user.
 *
 * @param {string} userId
 * @param {string} symbol
 * @returns {Promise<{allowed: boolean, remaining: number, reset_ms: number, scope: string}>}
 */
export async function checkRateLimit(userId, symbol) {
  // ── Check global limit first ──
  const global = await checkGlobalRateLimit();
  if (!global.allowed) {
    return { ...global, scope: 'global' };
  }

  // ── Check per-user limit ──
  const user = await checkUserRateLimit(userId, symbol);
  if (!user.allowed) {
    return { ...user, scope: 'user' };
  }

  return {
    allowed: true,
    remaining: Math.min(global.remaining, user.remaining),
    reset_ms: Math.max(global.reset_ms, user.reset_ms),
    scope: 'ok',
  };
}

/**
 * Execute the atomic Lua rate limit script.
 *
 * @param {string} key       Redis key
 * @param {number} limit     max requests
 * @param {number} windowMs  window in milliseconds
 * @returns {Promise<{allowed: boolean, remaining: number, reset_ms: number}>}
 */
async function _execRateLimit(key, limit, windowMs) {
  try {
    const result = await evalLua(
      RATE_LIMIT_LUA,
      [key],
      [String(limit), String(windowMs)]
    );

    const parts = String(result).split(':');
    const remaining = parseInt(parts[0], 10);
    const ttl = parseInt(parts[1] || '0', 10);

    return {
      allowed: remaining >= 0,
      remaining: Math.max(0, remaining),
      reset_ms: ttl,
    };
  } catch (err) {
    console.error('[RATE_LIMIT] Lua eval error:', err.message);
    // Fail open to avoid blocking users due to Redis issues
    return { allowed: true, remaining: -1, reset_ms: 0 };
  }
}
