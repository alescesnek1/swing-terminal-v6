// auto-scorer.mjs — score candidates from injected market + regime data.
//
// PURE: no I/O, no order submission. Output per candidate:
//   { symbol, score, reasons[], riskFlags[], recommendedPositionUsd, ...components }
// Score is 0..100. riskFlags surface anything that should make auto-risk/strategy
// hesitate (blacklist, cooldown, high volatility, wide spread, regime risk-off).

export const SCORING_VERSION = 'auto-scorer-v2';

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// Score components max values
const MAX_LIQUIDITY = 20;
const MAX_SPREAD = 15;
const MAX_MOMENTUM = 20;
const MAX_VOLATILITY = 15;
const MAX_TREND = 20;
const MAX_REGIME = 10;

// Score a single candidate. `caps` provides maxPositionUsd / minPositionUsd for the
// recommended size. `cooldowns` maps symbol -> epoch-ms until which entries are paused.
export function scoreCandidate({
  market,
  regime = null,
  blacklist = [],
  cooldowns = {},
  now = Date.now(),
  caps = {},
  historyMetrics = {}, // { trendScorePct (0-1), volatilityPct } passed from history
  historyWarmup = false,
} = {}) {
  const symbol = String((market && market.symbol) || '').toUpperCase();
  const reasons = [];
  const riskFlags = [];

  const change = Number(market && (market.change24hPct != null ? market.change24hPct : market.priceChangePct));
  const vol = Number(market && (market.volume24hUsd != null ? market.volume24hUsd : market.quoteVolume24h));
  const spread = Number(market && market.spreadPct);
  const volatility = historyMetrics.volatilityPct != null 
    ? Number(historyMetrics.volatilityPct) 
    : Number(market && (market.volatilityPct != null ? market.volatilityPct : Math.abs(change)));

  // Component 1: Liquidity (0-20)
  // Base: $5M is ~10 points, $50M+ is 20 points
  let liquidityScore = 0;
  if (Number.isFinite(vol) && vol > 0) {
    const logVol = Math.log10(vol);
    // Let's say 1M (6) -> 0, 100M (8) -> 20
    const rawLiq = (logVol - 6) * 10;
    liquidityScore = clamp(rawLiq, 0, MAX_LIQUIDITY);
    reasons.push(`24h volume $${Math.round(vol).toLocaleString('en-US')}`);
  } else {
    riskFlags.push('low liquidity');
  }

  // Component 2: Spread (0-15)
  // Base: 0% is 15 points, 0.15% is 0 points
  let spreadScore = 0;
  if (Number.isFinite(spread)) {
    const rawSpread = MAX_SPREAD - (spread / 0.01); // 1 point per 0.01%
    spreadScore = clamp(rawSpread, 0, MAX_SPREAD);
    reasons.push(`spread ${spread.toFixed(3)}%`);
    if (spread > 0.15) {
      riskFlags.push('wide spread');
    }
  }

  // Component 3: Momentum (0-20)
  // positive 24h trend scores up; flat/negative scores down, but penalize extreme pumps (>20%).
  let momentumScore = 0;
  if (Number.isFinite(change)) {
    if (change > 20) {
      // Overextended pump
      momentumScore = 5; 
      riskFlags.push('extreme 24h pump');
      reasons.push(`extreme 24h pump ${change.toFixed(2)}%`);
    } else if (change < -15) {
      // Extreme dump
      momentumScore = 0;
      riskFlags.push('extreme 24h dump');
      reasons.push(`extreme 24h dump ${change.toFixed(2)}%`);
    } else {
      // Map -5% -> 0, +10% -> 20
      const rawMom = ((change + 5) / 15) * MAX_MOMENTUM;
      momentumScore = clamp(rawMom, 0, MAX_MOMENTUM);
      reasons.push(`24h change ${change > 0 ? '+' : ''}${change.toFixed(2)}%`);
    }
  }

  // Component 4: Volatility (0-15)
  // penalize insane volatility, reward healthy movement.
  let volatilityScore = 0;
  if (Number.isFinite(volatility)) {
    // Say 1-4% is perfect (15). >4% drops off. >8% is 0.
    if (volatility < 1) {
      volatilityScore = clamp(volatility * 15, 0, MAX_VOLATILITY);
    } else {
      const rawVol = MAX_VOLATILITY - ((volatility - 3) * 3);
      volatilityScore = clamp(rawVol, 0, MAX_VOLATILITY);
    }
    if (volatility > 8) riskFlags.push('high volatility');
  }

  // Component 5: Trend (0-20)
  // Short rolling history trend
  let trendScore = 10; // Neutral default
  if (historyWarmup) {
    reasons.push('history warmup (neutral trend)');
  } else if (historyMetrics.trendScorePct != null) {
    trendScore = clamp(historyMetrics.trendScorePct * MAX_TREND, 0, MAX_TREND);
    reasons.push(`trend score ${(historyMetrics.trendScorePct * 100).toFixed(0)}%`);
  }

  // Component 6: Regime (0-10)
  let regimeScore = 5; // Neutral default
  if (regime && regime.regime) {
    const r = String(regime.regime).toUpperCase();
    if (r === 'RISK_ON' || r === 'BULL' || r === 'TRENDING') regimeScore = MAX_REGIME;
    else if (r === 'NEUTRAL' || r === 'RANGE') regimeScore = 5;
    else if (r === 'RISK_OFF' || r === 'BEAR' || r === 'CRASH') { regimeScore = 0; riskFlags.push('regime risk-off'); }
    reasons.push(`regime ${r}`);
    if (regime.entriesAllowed === false) riskFlags.push('regime blocks entries');
  }

  // Calculate final score
  const score = Math.round(
    liquidityScore + spreadScore + momentumScore + volatilityScore + trendScore + regimeScore
  );

  // Cooldown / blacklist flags
  if ((blacklist || []).map((s) => String(s).toUpperCase()).includes(symbol)) riskFlags.push('blacklisted');
  
  const cd = Number(cooldowns && cooldowns[symbol]);
  let cooldownBlocked = false;
  let cooldownRemainingMs = 0;
  if (Number.isFinite(cd) && now < cd) {
    riskFlags.push('cooldown');
    cooldownBlocked = true;
    cooldownRemainingMs = cd - now;
  }
  
  if (market && market._isFallback) {
    riskFlags.push('FALLBACK_ALLOWLIST_SYMBOL');
  }

  const maxUsd = Number(caps.maxPositionUsd);
  const minUsd = Number(caps.minPositionUsd);
  let recommendedPositionUsd = Number.isFinite(maxUsd) && maxUsd > 0 ? maxUsd : 0;
  if (Number.isFinite(minUsd) && recommendedPositionUsd > 0 && recommendedPositionUsd < minUsd) recommendedPositionUsd = minUsd;

  return { 
    symbol, 
    score, 
    reasons, 
    riskFlags, 
    recommendedPositionUsd,
    quoteVolume: vol,
    priceChangePercent: change,
    spreadPct: spread,
    liquidityScore: Math.round(liquidityScore),
    spreadScore: Math.round(spreadScore),
    momentumScore: Math.round(momentumScore),
    volatilityScore: Math.round(volatilityScore),
    trendScore: Math.round(trendScore),
    regimeScore: Math.round(regimeScore),
    cooldownBlocked,
    cooldownRemainingMs,
    cooldownUntil: cd || null,
    rejectedReason: null, // Populated by universe filtering if rejected before scoring
  };
}

// Score and rank a whole universe (highest score first). Ties keep input order.
export function scoreUniverse(universe = [], ctx = {}) {
  return (universe || [])
    .map((market) => scoreCandidate({ ...ctx, market }))
    .sort((a, b) => b.score - a.score);
}
