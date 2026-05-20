// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Universal Redis Client
// Auto-detects runtime and switches protocol:
//   • Deno (Netlify Edge)  → @upstash/redis REST over HTTP
//   • Node.js (Fly.io)     → ioredis TCP persistent connection
// ─────────────────────────────────────────────────────────────

const isDeno = typeof Deno !== 'undefined';

/** @type {import('@upstash/redis').Redis | import('ioredis').default | null} */
let _redis = null;

/**
 * Returns a singleton Redis client configured for the current runtime.
 * @returns {Promise<object>}
 */
export async function getRedis() {
  if (_redis) return _redis;

  if (isDeno) {
    // ── Netlify Edge (Deno) → REST client ──
    const { Redis } = await import('npm:@upstash/redis');
    _redis = new Redis({
      url: Deno.env.get('UPSTASH_REDIS_REST_URL'),
      token: Deno.env.get('UPSTASH_REDIS_REST_TOKEN'),
    });
    console.log('[REDIS] Connected via REST (Deno/Edge)');
  } else {
    // ── Fly.io (Node.js) → TCP client ──
    const { default: IORedis } = await import('ioredis');
    _redis = new IORedis(process.env.REDIS_URL, {
      tls: { rejectUnauthorized: false },
      connectTimeout: 10000,
      maxRetriesPerRequest: 3,
    });

    _redis.on('connect', () => console.log('[REDIS] Connected via TCP (Node.js)'));
    _redis.on('error', (err) => console.error('[REDIS] Error:', err.message));
  }

  return _redis;
}

/**
 * Execute a Lua script atomically in Redis.
 * Normalizes the API between @upstash/redis and ioredis.
 *
 * @param {string}   script  Lua source code
 * @param {string[]} keys    KEYS array
 * @param {(string|number)[]} args  ARGV array
 * @returns {Promise<any>}
 */
export async function evalLua(script, keys = [], args = []) {
  const redis = await getRedis();

  if (isDeno) {
    // @upstash/redis: eval(script, keys[], args[])
    return redis.eval(script, keys, args);
  } else {
    // ioredis: eval(script, numkeys, ...keys, ...args)
    return redis.eval(script, keys.length, ...keys, ...args);
  }
}

/**
 * HGETALL wrapper that normalizes empty results to null.
 * ioredis returns {} for non-existent keys, @upstash/redis returns null.
 *
 * @param {string} key  Redis hash key
 * @returns {Promise<Record<string, string> | null>}
 */
export async function redisHgetall(key) {
  const redis = await getRedis();
  const result = await redis.hgetall(key);

  // Normalize: both runtimes → null when key doesn't exist
  if (!result || (typeof result === 'object' && Object.keys(result).length === 0)) {
    return null;
  }
  return result;
}

/**
 * HSET wrapper for writing hash data with optional TTL.
 *
 * @param {string} key   Redis hash key
 * @param {Record<string, string|number>} data  field→value pairs
 * @param {number} [ttlMs]  optional TTL in milliseconds
 */
export async function redisHset(key, data, ttlMs) {
  const redis = await getRedis();

  if (isDeno) {
    // @upstash/redis: hset(key, fields)
    await redis.hset(key, data);
  } else {
    // ioredis: hset(key, field1, val1, field2, val2, ...)
    const flat = Object.entries(data).flat();
    await redis.hset(key, ...flat);
  }

  if (ttlMs) {
    await redis.pexpire(key, ttlMs);
  }
}

/**
 * Simple SET with optional PX (millisecond TTL).
 *
 * @param {string} key
 * @param {string} value
 * @param {number} [ttlMs]
 */
export async function redisSet(key, value, ttlMs) {
  const redis = await getRedis();
  if (ttlMs) {
    await redis.set(key, value, 'PX', ttlMs);
  } else {
    await redis.set(key, value);
  }
}

/**
 * MSET wrapper for writing multiple keys at once.
 * Saves rate limits by executing as a single command.
 *
 * @param {Record<string, string>} data  key→value pairs
 */
export async function redisMset(data) {
  const redis = await getRedis();

  if (isDeno) {
    // @upstash/redis supports object
    await redis.mset(data);
  } else {
    // ioredis optionally accepts object but we flatten to be safe
    const flat = Object.entries(data).flat();
    await redis.mset(...flat);
  }
}

/**
 * Simple GET.
 *
 * @param {string} key
 * @returns {Promise<string|null>}
 */
export async function redisGet(key) {
  const redis = await getRedis();
  return redis.get(key);
}

/**
 * SADD — add members to a Set.
 *
 * @param {string} key
 * @param {...string} members
 */
export async function redisSadd(key, ...members) {
  const redis = await getRedis();
  if (isDeno) {
    await redis.sadd(key, ...members);
  } else {
    await redis.sadd(key, ...members);
  }
}

/**
 * SMEMBERS — get all members of a Set.
 *
 * @param {string} key
 * @returns {Promise<string[]>}
 */
export async function redisSmembers(key) {
  const redis = await getRedis();
  const result = await redis.smembers(key);
  return result || [];
}

/**
 * DEL — delete key(s).
 *
 * @param {...string} keys
 */
export async function redisDel(...keys) {
  const redis = await getRedis();
  await redis.del(...keys);
}

/**
 * Check if the Redis connection is alive.
 * @returns {Promise<boolean>}
 */
export async function redisPing() {
  try {
    const redis = await getRedis();
    const resp = await redis.ping();
    return resp === 'PONG' || resp === true;
  } catch {
    return false;
  }
}
