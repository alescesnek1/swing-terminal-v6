// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Browser HMAC Client
// Signs API requests using Web Crypto API.
// ─────────────────────────────────────────────────────────────

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
const ENCODER = new TextEncoder();

/**
 * Import HMAC key from a raw string.
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    ALGORITHM,
    false,
    ['sign']
  );
}

/**
 * Convert ArrayBuffer to hex string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Sign a request body with HMAC-SHA256.
 *
 * @param {string} body       JSON body string
 * @param {string} timestamp  epoch milliseconds as string
 * @param {string} secret     shared HMAC secret
 * @returns {Promise<string>} hex-encoded signature
 */
export async function signBody(body, timestamp, secret) {
  const key = await importKey(secret);
  const message = `${timestamp}.${body}`;
  const sig = await crypto.subtle.sign(ALGORITHM, key, ENCODER.encode(message));
  return bufToHex(sig);
}
