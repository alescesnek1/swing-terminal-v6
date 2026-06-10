// auto-scorer.mjs — score candidates from injected market + regime data.
//
// PURE: no I/O, no order submission. Output per candidate:
//   { symbol, score, reasons[], riskFlags[], recommendedPositionUsd }
// Score is 0..100. riskFlags surface anything that should make auto-risk/strategy
// hesitate (blacklist, cooldown, high volatility, wide spread, regime risk-off).

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export const DEFAULT_SCORE_WEIGHTS = Object.freeze({
  momentum: 35,   // 24h trend/momentum
  volume: 20,     // liquidity confidence
  spreadPenalty: 15,
  volatilityPenalty: 15,
  regime: 15,     // market regime alignment
});

// Score a single candidate. `caps` provides maxPositionUsd / minPositionUsd for the
// recommended size. `cooldowns` maps symbol -> epoch-ms until which entries are paused.
export function scoreCandidate({
  market,
  regime = null,
  blacklist = [],
  cooldowns = {},
  now = Date.now(),
  caps = {},
  weights = {},
} = {}) {
  const w = { ...DEFAULT_SCORE_WEIGHTS, ...weights };
  const symbol = String((market && market.symbol) || '').toUpperCase();
  const reasons = [];
  const riskFlags = [];

  const change = Number(market && (market.change24hPct != null ? market.change24hPct : market.priceChangePct));
  const vol = Number(market && (market.volume24hUsd != null ? market.volume24hUsd : market.quoteVolume24h));
  const spread = Number(market && market.spreadPct);
  const volatility = Number(market && (market.volatilityPct != null ? market.volatilityPct : Math.abs(change)));

  // Momentum: positive 24h trend scores up; flat/negative scores down.
  let momentum = 0;
  if (Number.isFinite(change)) {
    momentum = clamp((change + 5) / 10, 0, 1); // -5%→0, +5%→1
    reasons.push(`24h change ${change > 0 ? '+' : ''}${change}%`);
  }
  // Volume confidence (log-ish): $5M→~0.5, $50M→~1.
  let volumeScore = 0;
  if (Number.isFinite(vol) && vol > 0) {
    volumeScore = clamp(Math.log10(vol) / 8, 0, 1); // 1e8 → 1
    reasons.push(`24h volume $${Math.round(vol).toLocaleString('en-US')}`);
  }
  // Spread penalty (lower is better).
  let spreadPenalty = 0;
  if (Number.isFinite(spread)) {
    spreadPenalty = clamp(spread / 0.5, 0, 1); // 0.5% → full penalty
    if (spread > 0.15) riskFlags.push('wide spread');
    reasons.push(`spread ${spread}%`);
  }
  // Volatility penalty (too hot is risky).
  let volPenalty = 0;
  if (Number.isFinite(volatility)) {
    volPenalty = clamp((volatility - 3) / 12, 0, 1); // >3% starts to penalize
    if (volatility > 8) riskFlags.push('high volatility');
  }
  // Regime alignment.
  let regimeScore = 0.5;
  if (regime && regime.regime) {
    const r = String(regime.regime).toUpperCase();
    if (r === 'RISK_ON' || r === 'BULL' || r === 'TRENDING') regimeScore = 1;
    else if (r === 'NEUTRAL' || r === 'RANGE') regimeScore = 0.5;
    else if (r === 'RISK_OFF' || r === 'BEAR' || r === 'CRASH') { regimeScore = 0; riskFlags.push('regime risk-off'); }
    reasons.push(`regime ${r}`);
    if (regime.entriesAllowed === false) riskFlags.push('regime blocks entries');
  }

  // Cooldown / blacklist flags (do not zero the score — auto-risk hard-blocks).
  if ((blacklist || []).map((s) => String(s).toUpperCase()).includes(symbol)) riskFlags.push('blacklisted');
  const cd = Number(cooldowns && cooldowns[symbol]);
  if (Number.isFinite(cd) && now < cd) riskFlags.push('cooldown');
  if (market && market._isFallback) {
    riskFlags.push('FALLBACK_ALLOWLIST_SYMBOL');
  }

  const raw = w.momentum * momentum
    + w.volume * volumeScore
    + w.regime * regimeScore
    - w.spreadPenalty * spreadPenalty
    - w.volatilityPenalty * volPenalty;
  const score = Math.round(clamp(raw, 0, 100));

  const maxUsd = Number(caps.maxPositionUsd);
  const minUsd = Number(caps.minPositionUsd);
  let recommendedPositionUsd = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 0;
  if (Number.isFinite(minUsd) && recommendedPositionUsd > 0 && recommendedPositionUsd < minUsd) recommendedPositionUsd = minUsd;

  return { symbol, score, reasons, riskFlags, recommendedPositionUsd };
}

// Score and rank a whole universe (highest score first). Ties keep input order.
export function scoreUniverse(universe = [], ctx = {}) {
  return (universe || [])
    .map((market) => scoreCandidate({ ...ctx, market }))
    .sort((a, b) => b.score - a.score);
}
