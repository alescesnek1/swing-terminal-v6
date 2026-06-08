// Identity + authorization helpers for the Bot Fleet Manager.
//
// Auth source is Supabase: the browser sends `Authorization: Bearer <jwt>`.
//
// Supabase signs access tokens with either:
//   - HS256 (symmetric)  -> verify with SUPABASE_JWT_SECRET (legacy projects), or
//   - ES256 / RS256 (asymmetric) -> verify via the project's public JWKS:
//       ${SUPABASE_URL}/auth/v1/.well-known/jwks.json
//
// All verification uses Node's built-in `crypto` (no external dependency).
// decode-only mode is gated behind AUTH_DECODE_ONLY=true and is for local/dev
// skeleton use ONLY — it is never production-safe and never permits admin control.
//
// SECURITY: never trust ownerUserId/email/orgId from a request body — identity is
// derived only from the verified/decoded token here. Raw tokens are never logged
// and never returned.
import crypto from 'node:crypto';

let _warnedDecodeOnly = false;

// JWKS cache (per warm function instance).
const JWKS_TTL_MS = 10 * 60 * 1000;
let _jwksCache = { url: null, keys: null, fetchedAt: 0 };

function b64urlToString(input) {
  return b64urlToBuffer(input).toString('utf8');
}
function b64urlToBuffer(input) {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function decodeJwt(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = JSON.parse(b64urlToString(parts[0]));
    const payload = JSON.parse(b64urlToString(parts[1]));
    return { header, payload, signingInput: `${parts[0]}.${parts[1]}`, signature: parts[2] };
  } catch {
    return null;
  }
}

function decodeOnlyEnabled() {
  return process.env.AUTH_DECODE_ONLY === 'true';
}

async function getJwks() {
  const baseRaw = process.env.SUPABASE_URL;
  if (!baseRaw) return null;
  const url = `${baseRaw.replace(/\/$/, '')}/auth/v1/.well-known/jwks.json`;
  const now = Date.now();
  if (_jwksCache.keys && _jwksCache.url === url && (now - _jwksCache.fetchedAt) < JWKS_TTL_MS) {
    return _jwksCache.keys;
  }
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return _jwksCache.url === url ? _jwksCache.keys : null;
    const data = await res.json();
    const keys = Array.isArray(data && data.keys) ? data.keys : [];
    _jwksCache = { url, keys, fetchedAt: now };
    return keys;
  } catch {
    return _jwksCache.url === url ? _jwksCache.keys : null;
  }
}

function verifyHs256(decoded, secret) {
  const expected = crypto.createHmac('sha256', secret).update(decoded.signingInput).digest();
  const sig = b64urlToBuffer(decoded.signature);
  return expected.length === sig.length && crypto.timingSafeEqual(expected, sig);
}

function verifyAsymmetric(decoded, jwk, alg) {
  const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' });
  const data = Buffer.from(decoded.signingInput);
  const sig = b64urlToBuffer(decoded.signature);
  if (alg === 'ES256') {
    // JWS ES256 signatures are raw r||s (IEEE P1363), not DER.
    return crypto.verify('sha256', data, { key: keyObject, dsaEncoding: 'ieee-p1363' }, sig);
  }
  if (alg === 'RS256') {
    return crypto.verify('sha256', data, keyObject, sig);
  }
  return false;
}

function pickJwk(keys, decoded, alg) {
  const kid = decoded.header && decoded.header.kid;
  if (kid) {
    const byKid = keys.find((k) => k.kid === kid);
    if (byKid) return byKid;
  }
  const byAlg = keys.find((k) => k.alg === alg);
  if (byAlg) return byAlg;
  return keys.length === 1 ? keys[0] : null;
}

function finalize(decoded, verified, authMode) {
  const p = decoded.payload || {};
  const exp = Number(p.exp);
  if (Number.isFinite(exp) && Date.now() / 1000 > exp) {
    return { ok: false, reason: 'token expired', authMode, verified: false };
  }
  // Only enforce issuer/audience on cryptographically verified tokens; unverified
  // claims are meaningless and only reached in dev decode-only mode.
  if (verified) {
    const base = process.env.SUPABASE_URL;
    if (p.iss && base) {
      const expectedIss = `${base.replace(/\/$/, '')}/auth/v1`;
      if (p.iss !== expectedIss) return { ok: false, reason: 'issuer mismatch', authMode, verified: false };
    }
    if (p.aud) {
      const auds = Array.isArray(p.aud) ? p.aud : [p.aud];
      if (!auds.includes('authenticated')) return { ok: false, reason: 'audience mismatch', authMode, verified: false };
    }
  }
  const email = String(p.email || (p.user_metadata && p.user_metadata.email) || '').toLowerCase();
  const userId = p.sub || (p.user_metadata && p.user_metadata.sub) || null;
  if (!userId) return { ok: false, reason: 'token missing subject', authMode, verified: false };
  const orgId = (p.app_metadata && (p.app_metadata.org_id || p.app_metadata.orgId)) || 'default';
  return { ok: true, verified, authMode, userId, email, orgId };
}

// When a token cannot be cryptographically verified, allow it through only in
// explicit dev decode-only mode; otherwise reject (production-safe default).
function decodeOrReject(decoded, reason) {
  if (decodeOnlyEnabled()) {
    if (!_warnedDecodeOnly) {
      _warnedDecodeOnly = true;
      console.warn('AUTH_DECODE_ONLY=true; auth is decode-only skeleton mode (NOT production-safe).');
    }
    return finalize(decoded, false, 'decode_only');
  }
  return { ok: false, reason: reason || 'token could not be verified (decode-only disabled)', authMode: 'decode_only', verified: false };
}

export async function verifyJwt(token) {
  const decoded = decodeJwt(token);
  if (!decoded) return { ok: false, reason: 'malformed token', authMode: 'decode_only', verified: false };
  const alg = decoded.header && decoded.header.alg;

  if (alg === 'HS256') {
    const secret = process.env.SUPABASE_JWT_SECRET || '';
    if (secret) {
      if (!verifyHs256(decoded, secret)) return { ok: false, reason: 'invalid signature', authMode: 'decode_only', verified: false };
      return finalize(decoded, true, 'verified_hs256');
    }
    return decodeOrReject(decoded, 'HS256 token but SUPABASE_JWT_SECRET not set');
  }

  if (alg === 'ES256' || alg === 'RS256') {
    const keys = await getJwks();
    if (keys && keys.length) {
      const jwk = pickJwk(keys, decoded, alg);
      if (!jwk) return decodeOrReject(decoded, 'no matching JWKS key for kid');
      let valid = false;
      try { valid = verifyAsymmetric(decoded, jwk, alg); } catch { valid = false; }
      if (!valid) return { ok: false, reason: 'invalid signature', authMode: 'decode_only', verified: false };
      return finalize(decoded, true, alg === 'ES256' ? 'verified_jwks_es256' : 'verified_jwks_rs256');
    }
    return decodeOrReject(decoded, 'JWKS unavailable (set SUPABASE_URL)');
  }

  // Unknown / "none" alg.
  return decodeOrReject(decoded, `unsupported alg: ${alg}`);
}

function bearerToken(req) {
  const header = req.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : '';
}

// Returns { ok, verified, authMode, userId, email, orgId } or { ok:false, reason, authMode, verified:false }.
export async function getIdentity(req) {
  const token = bearerToken(req);
  if (!token) return { ok: false, reason: 'No bearer token', authMode: 'decode_only', verified: false };
  return await verifyJwt(token);
}

export function adminEmails() {
  return String(process.env.BOT_ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(identity) {
  if (!identity || !identity.email) return false;
  return adminEmails().includes(identity.email);
}

// Owner of own session is always allowed (subject to upstream verified gating in
// non-dev mode). Admin control over someone else's session ALWAYS requires a
// cryptographically verified token.
export function canControlSession(identity, session) {
  if (!identity || !session) return false;
  if (session.ownerUserId && session.ownerUserId === identity.userId) return true;
  if (isAdmin(identity) && identity.verified === true && (session.orgId || 'default') === (identity.orgId || 'default')) return true;
  return false;
}
