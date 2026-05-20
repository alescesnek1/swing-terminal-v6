// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — HMAC Signing & Verification (Isomorphic)
// Uses Web Crypto API — works in Deno, Node.js 20+, and browsers.
// ─────────────────────────────────────────────────────────────

import { HMAC_MAX_AGE_MS } from './constants.js';

const ALGORITHM = { name: 'HMAC', hash: 'SHA-256' };
const ENCODER = new TextEncoder();

/**
 * Import an HMAC key from a raw string.
 *
 * @param {string} secret  shared secret
 * @returns {Promise<CryptoKey>}
 */
async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    ENCODER.encode(secret),
    ALGORITHM,
    false,
    ['sign', 'verify']
  );
}

/**
 * Convert an ArrayBuffer to a hex string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert a hex string to a Uint8Array.
 * @param {string} hex
 * @returns {Uint8Array}
 */
function hexToBuf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Sign a message with HMAC-SHA256.
 * Used by the frontend to create request signatures.
 *
 * @param {string} body       request body (JSON string)
 * @param {string} timestamp  ISO timestamp or epoch ms
 * @param {string} secret     shared secret
 * @returns {Promise<string>} hex-encoded signature
 */
export async function signRequest(body, timestamp, secret) {
  const key = await importKey(secret);
  const message = `${timestamp}.${body}`;
  const signature = await crypto.subtle.sign(
    ALGORITHM,
    key,
    ENCODER.encode(message)
  );
  return bufToHex(signature);
}

/**
 * Verify an HMAC-SHA256 signature from a request.
 * Used by the Edge Function to validate incoming requests.
 *
 * Checks:
 *  1. Timestamp is within HMAC_MAX_AGE_MS (replay protection)
 *  2. Signature matches the expected value
 *
 * @param {string} body       raw request body
 * @param {string} signature  hex-encoded signature from X-Signature header
 * @param {string} timestamp  timestamp from X-Timestamp header
 * @param {string} secret     shared secret
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyRequest(body, signature, timestamp, secret) {
  // ── Replay protection ──
  const ts = Number(timestamp);
  if (isNaN(ts)) {
    return { valid: false, error: 'Invalid timestamp format' };
  }

  const age = Date.now() - ts;
  if (age > HMAC_MAX_AGE_MS) {
    return { valid: false, error: `Timestamp too old (${Math.round(age / 1000)}s)` };
  }

  if (age < -30_000) {
    // Allow 30s clock skew into the future, but no more
    return { valid: false, error: 'Timestamp is in the future' };
  }

  // ── Signature verification ──
  const key = await importKey(secret);
  const message = `${timestamp}.${body}`;

  const expectedBuf = await crypto.subtle.sign(
    ALGORITHM,
    key,
    ENCODER.encode(message)
  );
  const expectedHex = bufToHex(expectedBuf);

  // Timing-safe comparison
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
