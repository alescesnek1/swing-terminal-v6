// ─────────────────────────────────────────────────────────────
// Swing Terminal v5 — Tier resolution (Deno Edge)
//
// Single source of truth: Supabase user.user_metadata.tier
//   'pro'  → 30 AI req/hr/pair, 300 coins, DEX visible
//   'free' → 5  AI req/hr/pair, top 50 coins,  BIN/ALPHA only
//
// All gating helpers here so a future tier rename or addition is
// one diff, not 6.
// ─────────────────────────────────────────────────────────────

export const TIER_FREE = 'free';
export const TIER_PRO  = 'pro';

// V5 hotfix: hardcoded admin allowlist. These emails are treated as
// pro tier AND skip rate limits in all gated edge functions. Kept in
// code (not env) per ops instruction — change requires a redeploy, so
// privilege escalation can't happen via an env-var slip.
const ADMIN_EMAILS = new Set([
  'ales.cesnek@thevld.com',
  'vld@thevld.com',
]);

/**
 * Match exactly (case-insensitive). Trimmed to avoid whitespace from
 * provider-side metadata sneaking through.
 */
export function isAdminUser(user) {
  const email = String(user?.email || '').trim().toLowerCase();
  return !!email && ADMIN_EMAILS.has(email);
}

/**
 * Extract the user's tier from a Supabase user object.
 *   • Admin email (hardcoded above) → 'pro' (with bypass enforced
 *     separately via isAdminUser in each gated endpoint).
 *   • user_metadata.tier === 'pro'  → 'pro'
 *   • Anything else                 → 'free' (fail-closed default).
 */
export function getTier(user) {
  if (isAdminUser(user)) return TIER_PRO;
  const raw = user?.user_metadata?.tier;
  if (raw === TIER_PRO) return TIER_PRO;
  return TIER_FREE;
}

// Visible-coin caps per tier.
export const COIN_CAPS = {
  [TIER_FREE]: 50,
  [TIER_PRO]:  1000,
};

// Whether the tier sees DEX (off-Binance) assets in the screener.
export function tierSeesDex(tier) {
  return tier === TIER_PRO;
}

// Whether the tier can use AI features at all. Free still gets some
// AI access — the per-pair rate limit (5/hr) handles the cost shield.
// This flag exists so a future "view-only" tier can be added cheaply.
export function tierCanUseAi(tier) {
  return tier === TIER_FREE || tier === TIER_PRO;
}
