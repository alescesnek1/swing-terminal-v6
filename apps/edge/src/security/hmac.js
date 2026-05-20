// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Server-side HMAC Verification (Edge)
// Wraps the shared HMAC module with Edge-specific secret loading.
// ─────────────────────────────────────────────────────────────

import { verifyRequest } from '../../../shared/hmac.js';

/**
 * Verify the HMAC signature of an incoming request.
 *
 * Reads headers:
 *   - X-Signature: hex-encoded HMAC-SHA256
 *   - X-Timestamp: epoch milliseconds
 *
 * @param {string} rawBody  raw request body (JSON string)
 * @param {Headers} headers  request headers
 * @returns {Promise<{valid: boolean, error?: string}>}
 */
export async function verifyHMAC(rawBody, headers) {
  const signature = headers.get('x-signature');
  const timestamp = headers.get('x-timestamp');

  if (!signature) {
    return { valid: false, error: 'Missing X-Signature header' };
  }

  if (!timestamp) {
    return { valid: false, error: 'Missing X-Timestamp header' };
  }

  const secret = Deno.env.get('HMAC_SECRET');
  if (!secret) {
    console.error('[HMAC] HMAC_SECRET is not configured');
    return { valid: false, error: 'Server HMAC configuration error' };
  }

  return verifyRequest(rawBody, signature, timestamp, secret);
}
