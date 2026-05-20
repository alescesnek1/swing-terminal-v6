// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — JWT Verification (Deno Edge)
// Pure Web Crypto API — zero external dependencies.
// ─────────────────────────────────────────────────────────────

const JWKS_CACHE_MS = 300_000; // 5 min

let _jwksCache = null;
let _jwksCacheTimestamp = 0;

function base64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function fetchJWKS() {
  const now = Date.now();
  if (_jwksCache && now - _jwksCacheTimestamp < JWKS_CACHE_MS) return _jwksCache;

  const url = Deno.env.get('AUTH_JWKS_URL');
  if (!url) throw new Error('AUTH_JWKS_URL is not configured');

  console.log('[JWT] Fetching JWKS from:', url);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`JWKS fetch failed: ${response.status}`);

  _jwksCache = await response.json();
  _jwksCacheTimestamp = now;
  console.log(`[JWT] JWKS cached (${_jwksCache.keys?.length || 0} keys)`);
  return _jwksCache;
}

async function _verifySignature(headerB64, payloadB64, signatureB64, jwk, payload) {
  const cryptoKey = await crypto.subtle.importKey(
    'jwk', jwk,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['verify']
  );
  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = base64urlDecode(signatureB64);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, signedInput);
  if (!valid) { console.warn('[JWT] Invalid signature'); return null; }
  return payload;
}

/**
 * Verify a JWT token using RS256 + JWKS.
 * @param {string} token
 * @returns {Promise<object|null>}
 */
export async function verifyJWT(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) { console.warn('[JWT] Malformed token'); return null; }

    const [headerB64, payloadB64, signatureB64] = parts;
    const header = JSON.parse(new TextDecoder().decode(base64urlDecode(headerB64)));
    if (header.alg !== 'RS256') { console.warn(`[JWT] Unsupported alg: ${header.alg}`); return null; }

    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(payloadB64)));

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) { console.warn(`[JWT] Expired ${now - payload.exp}s ago`); return null; }
    if (payload.nbf && payload.nbf > now + 30) { console.warn('[JWT] Not yet valid'); return null; }

    const expectedIssuer = Deno.env.get('AUTH_ISSUER');
    if (expectedIssuer && payload.iss !== expectedIssuer) { console.warn('[JWT] Issuer mismatch'); return null; }

    const expectedAudience = Deno.env.get('AUTH_AUDIENCE');
    if (expectedAudience) {
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(expectedAudience)) { console.warn('[JWT] Audience mismatch'); return null; }
    }

    const jwks = await fetchJWKS();
    let jwk = jwks.keys?.find(k => k.kid === header.kid);

    if (!jwk) {
      _jwksCache = null;
      const refreshed = await fetchJWKS();
      jwk = refreshed.keys?.find(k => k.kid === header.kid);
      if (!jwk) { console.warn('[JWT] Key not found'); return null; }
    }

    return await _verifySignature(headerB64, payloadB64, signatureB64, jwk, payload);
  } catch (err) {
    console.error('[JWT] Error:', err.message);
    return null;
  }
}
