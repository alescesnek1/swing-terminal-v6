// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — JWT Verification (Deno / Edge)
// Pure Web Crypto API — no external dependencies.
// Supports RS256 tokens with JWKS auto-discovery and caching.
// ─────────────────────────────────────────────────────────────

import { TTL } from '../../../shared/constants.js';

// ── JWKS Cache ──
let _jwksCache = null;
let _jwksCacheTimestamp = 0;

/**
 * Base64url decode to Uint8Array.
 * @param {string} str  base64url encoded string
 * @returns {Uint8Array}
 */
function base64urlDecode(str) {
  // Replace base64url chars → base64
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  // Add padding
  while (str.length % 4) str += '=';

  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Fetch and cache JWKS from the configured URL.
 * @returns {Promise<object>}  JWKS response { keys: [...] }
 */
async function fetchJWKS() {
  const now = Date.now();

  // Return cached if fresh
  if (_jwksCache && now - _jwksCacheTimestamp < TTL.JWKS_CACHE_MS) {
    return _jwksCache;
  }

  const url = Deno.env.get('AUTH_JWKS_URL');
  if (!url) {
    throw new Error('AUTH_JWKS_URL is not configured');
  }

  console.log('[JWT] Fetching JWKS from:', url);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`JWKS fetch failed: ${response.status} ${response.statusText}`);
  }

  _jwksCache = await response.json();
  _jwksCacheTimestamp = now;

  console.log(`[JWT] JWKS cached (${_jwksCache.keys?.length || 0} keys, TTL: ${TTL.JWKS_CACHE_MS / 1000}s)`);
  return _jwksCache;
}

/**
 * Verify a JWT token using RS256 and JWKS.
 *
 * Checks:
 *  1. Algorithm is RS256
 *  2. Key ID (kid) exists in JWKS
 *  3. Signature is valid
 *  4. Token is not expired
 *  5. Issuer matches AUTH_ISSUER (if configured)
 *  6. Audience matches AUTH_AUDIENCE (if configured)
 *
 * @param {string} token  raw JWT string (without "Bearer " prefix)
 * @returns {Promise<object|null>}  decoded payload or null if invalid
 */
export async function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      console.warn('[JWT] Malformed token (not 3 parts)');
      return null;
    }

    const [headerB64, payloadB64, signatureB64] = parts;

    // ── Decode header ──
    const headerBytes = base64urlDecode(headerB64);
    const header = JSON.parse(new TextDecoder().decode(headerBytes));

    if (header.alg !== 'RS256') {
      console.warn(`[JWT] Unsupported algorithm: ${header.alg}`);
      return null;
    }

    // ── Decode payload ──
    const payloadBytes = base64urlDecode(payloadB64);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));

    // ── Check expiry ──
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.warn(`[JWT] Token expired ${now - payload.exp}s ago`);
      return null;
    }

    // ── Check not-before ──
    if (payload.nbf && payload.nbf > now + 30) {
      console.warn('[JWT] Token not yet valid (nbf)');
      return null;
    }

    // ── Check issuer ──
    const expectedIssuer = Deno.env.get('AUTH_ISSUER');
    if (expectedIssuer && payload.iss !== expectedIssuer) {
      console.warn(`[JWT] Issuer mismatch: expected ${expectedIssuer}, got ${payload.iss}`);
      return null;
    }

    // ── Check audience ──
    const expectedAudience = Deno.env.get('AUTH_AUDIENCE');
    if (expectedAudience) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(expectedAudience)) {
        console.warn(`[JWT] Audience mismatch: expected ${expectedAudience}`);
        return null;
      }
    }

    // ── Fetch JWKS and find matching key ──
    const jwks = await fetchJWKS();
    const jwk = jwks.keys?.find((k) => k.kid === header.kid);

    if (!jwk) {
      console.warn(`[JWT] Key ID not found in JWKS: ${header.kid}`);

      // Force refresh JWKS in case keys rotated
      _jwksCache = null;
      const refreshedJwks = await fetchJWKS();
      const refreshedJwk = refreshedJwks.keys?.find((k) => k.kid === header.kid);

      if (!refreshedJwk) {
        console.warn('[JWT] Key ID not found even after JWKS refresh');
        return null;
      }

      return await _verifySignature(headerB64, payloadB64, signatureB64, refreshedJwk, payload);
    }

    return await _verifySignature(headerB64, payloadB64, signatureB64, jwk, payload);
  } catch (err) {
    console.error('[JWT] Verification error:', err.message);
    return null;
  }
}

/**
 * Verify the RS256 signature using Web Crypto API.
 *
 * @param {string} headerB64
 * @param {string} payloadB64
 * @param {string} signatureB64
 * @param {object} jwk
 * @param {object} payload
 * @returns {Promise<object|null>}
 */
async function _verifySignature(headerB64, payloadB64, signatureB64, jwk, payload) {
  // Import the JWK as a CryptoKey
  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // Prepare signed input and signature
  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlDecode(signatureB64);

  // Verify
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    signature,
    signedInput
  );

  if (!valid) {
    console.warn('[JWT] Invalid signature');
    return null;
  }

  return payload;
}
