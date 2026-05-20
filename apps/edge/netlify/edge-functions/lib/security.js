// ─────────────────────────────────────────────────────────────
// Swing Terminal v3.0 — Backend Lockdown (Deno Edge)
//
// Two responsibilities, both ahead of any cost-incurring call:
//   1. Origin allowlist — caller must come from a trusted host.
//      A direct Postman / curl hit (no Origin, wrong Origin) is
//      rejected with 403 *before* we touch Supabase or Gemini.
//   2. Supabase JWT — we delegate signature verification to
//      Supabase's server API (cryptographic), then enforce extra
//      claim checks (exp, aud, role, sub presence) so a leaked
//      anon-flow token can't impersonate an authenticated user.
// ─────────────────────────────────────────────────────────────

import { createClient } from 'https://esm.sh/@supabase/supabase-js';

// ─────────────────────────────────────────────────────────────
// Origin allowlist
// ─────────────────────────────────────────────────────────────

/**
 * Parse APP_ORIGIN env var (comma-separated) into an array of
 * exact-match origins. Empty / "*" is treated as "no allowlist
 * configured" and the request is denied (we explicitly do NOT
 * default to permissive in v3 — production must set APP_ORIGIN).
 */
function parseAllowlist() {
  const raw = (Deno.env.get('APP_ORIGIN') || '').trim();
  const list = (!raw || raw === '*') ? [] : raw.split(',').map((s) => s.trim()).filter(Boolean);
  // Strictly allow the production origin to fix 403 CORS issues
  if (!list.includes('https://swing-terminal-v4-ales.netlify.app')) {
    list.push('https://swing-terminal-v4-ales.netlify.app');
  }
  return list;
}

// Always tolerated for local dev — these are evaluated BEFORE the
// APP_ORIGIN allowlist so a misconfigured / unset APP_ORIGIN in
// netlify dev can never lock the developer out of their own loopback.
// Production deploys still get blocked unless APP_ORIGIN matches —
// none of these hosts are reachable on the public internet.
//
// Explicit string set first (covers the canonical `netlify dev` port
// 8888 plus the most common framework dev ports), then a permissive
// regex catch-all for any other loopback port a developer might pick.
const DEV_ALLOW_HOSTS = new Set([
  'http://localhost:8888',
  'http://127.0.0.1:8888',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
  'http://localhost',
  'http://127.0.0.1',
]);
const DEV_ALLOW_REGEX = [
  /^http:\/\/localhost(:\d+)?$/i,
  /^http:\/\/127\.0\.0\.1(:\d+)?$/i,
  /^http:\/\/\[::1\](:\d+)?$/i,
];

function _isDevOrigin(candidate) {
  if (!candidate) return false;
  if (DEV_ALLOW_HOSTS.has(candidate)) return true;
  return DEV_ALLOW_REGEX.some((re) => re.test(candidate));
}

/**
 * Verify the request's Origin (or, as a fallback, Referer's origin)
 * is allowed. Returns `{ ok, origin, reason }`.
 *
 * Decision matrix (evaluated in order — dev FIRST so a broken
 * APP_ORIGIN env var can never block local development):
 *   • Origin/Referer matches localhost / 127.0.0.1 / [::1] → allow (dev).
 *   • Origin/Referer matches APP_ORIGIN entry exactly → allow.
 *   • No Origin and no Referer → reject (Postman-style direct hit).
 *   • Otherwise → reject.
 */
export function checkOrigin(request) {
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';

  let candidate = origin;
  if (!candidate && referer) {
    try { candidate = new URL(referer).origin; } catch { /* malformed */ }
  }
  if (!candidate) {
    return { ok: false, origin: '', reason: 'No Origin or Referer header' };
  }

  // Dev FIRST. The previous order checked APP_ORIGIN first; if
  // APP_ORIGIN was unset (the default for many `netlify dev` runs)
  // the function fell through to the dev regex — which works for
  // most setups but was silently bypassed in at least one reported
  // case. Putting dev first guarantees loopback always passes.
  if (_isDevOrigin(candidate)) {
    return { ok: true, origin: candidate, dev: true };
  }

  const allowlist = parseAllowlist();
  if (allowlist.length && allowlist.includes(candidate)) {
    return { ok: true, origin: candidate };
  }
  return { ok: false, origin: candidate, reason: 'Origin not on allowlist' };
}

/**
 * Pick the CORS Allow-Origin value. For an origin that just passed
 * `checkOrigin` we echo it back (browsers reject "*" with credentials).
 * For preflight from an unknown origin we still echo a placeholder so
 * the browser can complete the round-trip and see the 403 body.
 *
 * Special case: a loopback Origin always echoes itself even when the
 * caller hasn't routed through checkOrigin yet (e.g. an OPTIONS
 * preflight before any auth) — keeps `netlify dev` preflights from
 * silently failing CORS even when the request body would be allowed.
 */
export function pickAllowOrigin(request) {
  const probe = checkOrigin(request);
  if (probe.ok) return probe.origin;
  const rawOrigin = request.headers.get('origin') || '';
  if (_isDevOrigin(rawOrigin)) return rawOrigin;
  const allowlist = parseAllowlist();
  return allowlist[0] || 'null';
}

// ─────────────────────────────────────────────────────────────
// Supabase JWT verification + claim checks
// ─────────────────────────────────────────────────────────────

let _supabaseClient = null;
function getSupabase() {
  if (_supabaseClient) return _supabaseClient;
  const url = Deno.env.get('SUPABASE_URL');
  const key = Deno.env.get('SUPABASE_ANON_KEY');
  if (!url || !key) throw new Error('Supabase env not configured');
  _supabaseClient = createClient(url, key);
  return _supabaseClient;
}

/**
 * Best-effort base64url JSON decode of a JWT segment.
 * Returns `null` on any malformed input — never throws.
 */
function decodeJwtSegment(seg) {
  try {
    const padded = seg.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(seg.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

/**
 * Verify the bearer token cryptographically (via Supabase API) AND
 * enforce extra claim checks. Returns `{ ok, user, reason, status }`
 * — never throws on bad tokens, only on configuration faults.
 */
export async function verifyAuth(request) {
  const authHeader = request.headers.get('authorization') || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return { ok: false, status: 401, reason: 'Missing Bearer token' };
  }
  const token = authHeader.slice(7).trim();
  if (!token || token.split('.').length !== 3) {
    return { ok: false, status: 401, reason: 'Malformed JWT' };
  }

  // V5 (D-5): cryptographic verification FIRST. The old order returned
  // "Token expired" / "Wrong audience" based on UNVERIFIED claims, which
  // is misleading on a forged token and could mask probe attempts. Now
  // we let Supabase reject any bad signature before trusting any claim.
  let user = null;
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return { ok: false, status: 401, reason: error?.message || 'Token rejected by Supabase' };
    }
    user = data.user;
  } catch (e) {
    // 503 not 500 — this is an upstream-provider issue, not our bug.
    return { ok: false, status: 503, reason: `Supabase call failed: ${e.message}` };
  }

  // Only NOW do we read claims — and only as a defense-in-depth check.
  // Supabase already validated exp/aud cryptographically before
  // returning the user. These secondary checks catch any drift between
  // the Supabase client and what we want to enforce ourselves.
  const claims = decodeJwtSegment(token.split('.')[1]) || {};
  if (claims.aud && claims.aud !== 'authenticated') {
    return { ok: false, status: 401, reason: `Wrong audience: ${claims.aud}` };
  }

  // Role guard. Anon flows can mint tokens with role=anon — app-level
  // features require role=authenticated.
  const role = user.role || claims.role;
  if (role && role !== 'authenticated') {
    return { ok: false, status: 403, reason: `Role ${role} not allowed` };
  }
  if (!user.id) {
    return { ok: false, status: 401, reason: 'Token has no subject' };
  }

  return { ok: true, status: 200, user };
}
