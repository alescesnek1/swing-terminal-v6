// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — HMAC Verification (Deno Edge)
// Pure Web Crypto API — zero external dependencies.
// ─────────────────────────────────────────────────────────────

const HMAC_MAX_AGE_MS = 300_000; // 5 minutes
const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
const ENCODER = new TextEncoder();

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    ALGORITHM,
    false,
    ['sign', 'verify']
  );
}

function bufToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Verify an HMAC-SHA256 signature from a request.
 *
 * @param {string} body       raw request body
 * @param {string} signature  hex-encoded signature from X-Signature header
 * @param {string} timestamp  timestamp from X-Timestamp header
 * @param {string} secret     shared secret
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyRequest(body, signature, timestamp, secret) {
  const ts = Number(timestamp);
  if (isNaN(ts)) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const age = Date.now() - ts;
  if (age > HMAC_MAX_AGE_MS) {
    return { valid: false, error: `Timestamp too old (${Math.round(age / 1000)}s)` };
  }

  if (age < -30_000) {
    return { valid: false, error: 'Timestamp is in the future' };
  }

  const key = await importKey(secret);
  const message = `${timestamp}.${body}`;

  const expectedBuf = await crypto.subtle.sign(
    ALGORITHM,
    key,
    ENCODER.encode(message)
  );
  const expectedHex = bufToHex(expectedBuf);

  if (signature.length !== expectedHex.length) {
    return { valid: false, error: 'Signature length mismatch' };
  }

  const sigBuf = hexToBuf(signature);
  const expBuf = new Uint8Array(expectedBuf);

  let diff = 0;
  for (let i = 0; i < sigBuf.length; i++) {
    diff |= sigBuf[i] ^ expBuf[i];
  }

  if (diff !== 0) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

/**
 * Verify HMAC from request headers.
 *
 * @param {string}  rawBody  raw request body
 * @param {Headers} headers  request headers
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyHMAC(rawBody, headers) {
  const signature = headers.get('x-signature');
  const timestamp = headers.get('x-timestamp');

  if (!signature) return { valid: false, error: 'Missing X-Signature header' };
  if (!timestamp) return { valid: false, error: 'Missing X-Timestamp header' };

  const secret = Deno.env.get('HMAC_SECRET');
  if (!secret) {
    console.error('[HMAC] HMAC_SECRET is not configured');
    return { valid: false, error: 'Server HMAC configuration error' };
  }

  return verifyRequest(rawBody, signature, timestamp, secret);
}
