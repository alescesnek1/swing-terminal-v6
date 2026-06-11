// auto-strategy.mjs — turn scored candidates + an open position into decisions and
// backend-shaped intents. It MUST NOT submit orders; it only returns intent objects
// that match what the existing backend endpoints (create-*-execution-intent) and the
// worker already consume.

import { evaluateExit } from './auto-exit-manager.mjs';

export const DEFAULT_ENTRY_THRESHOLD = 60;

export function decideEntry({
  scored = [],
  threshold = DEFAULT_ENTRY_THRESHOLD,
  regime = null,
  allowEntries = true,
  cooldownOverrideGap = 12,
  riskMode = 'block_entries',
} = {}) {
  const reasons = [];
  
  if (allowEntries === false) {
    return { action: 'NONE', decisionReason: 'entries_disabled', reasons: ['entries disabled'] };
  }
  if (regime && regime.entriesAllowed === false && riskMode === 'block_entries') {
    return { action: 'NONE', decisionReason: 'regime_risk_off', reasons: ['regime blocks entries'] };
  }
  if (!scored || scored.length === 0) {
    return { action: 'NONE', decisionReason: 'no_candidate', reasons: ['no candidate'] };
  }

  // 1. Pick selected candidate from the leaderboard after applying cooldown rules
  let top = scored[0];
  let runnerUp = null;
  let scoreGap = null;
  let limitedUniverse = false;

  if (scored.length === 1) {
    limitedUniverse = true;
  } else {
    // Find the best non-cooldown candidate to compare against
    for (let i = 1; i < scored.length; i++) {
      if (!scored[i].cooldownBlocked) {
        runnerUp = scored[i];
        break;
      }
    }
    
    // If top is cooling down, check if it beats runner-up by more than override gap
    if (top.cooldownBlocked) {
      if (runnerUp) {
        scoreGap = top.score - runnerUp.score;
        if (scoreGap <= cooldownOverrideGap) {
          // Top didn't beat runner up by enough, fallback to runnerUp
          reasons.push(`Top candidate ${top.symbol} cooled down and gap (${scoreGap}) <= ${cooldownOverrideGap}. Falling back to runner-up ${runnerUp.symbol}`);
          top = runnerUp;
          // Runner-up's gap to its next best isn't computed here, but that's fine
        } else {
          reasons.push(`Top candidate ${top.symbol} cooled down but beats runner-up by ${scoreGap} > ${cooldownOverrideGap}. Overriding cooldown.`);
        }
      } else {
        // No non-cooldown runner ups at all
        reasons.push(`Top candidate ${top.symbol} cooled down but no viable runner-ups available. Keeping top.`);
      }
    }
  }

  if (limitedUniverse) {
    reasons.push('limited universe (only 1 eligible symbol)');
  }

  const hardFlags = (top.riskFlags || []).filter((f) => f === 'blacklisted' || (f === 'regime risk-off' && riskMode === 'block_entries'));
  if (hardFlags.length) {
    return { 
      action: 'NONE', symbol: top.symbol, score: top.score, 
      decisionReason: hardFlags.includes('regime risk-off') ? 'regime_risk_off' : 'blacklisted', 
      reasons: [...reasons, `risk flags: ${hardFlags.join(', ')}`],
      scoreGap, limitedUniverse,
    };
  }

  if (!(Number(top.score) >= Number(threshold))) {
    return { 
      action: 'NONE', symbol: top.symbol, score: top.score, 
      decisionReason: 'score_below_threshold', 
      reasons: [...reasons, `score ${top.score} < threshold ${threshold}`],
      scoreGap: (threshold - top.score), // gap to threshold
      limitedUniverse,
    };
  }
  
  reasons.push(`score ${top.score} >= threshold ${threshold}`, ...(top.reasons || []));
  return { 
    action: 'BUY', 
    symbol: top.symbol, 
    score: top.score, 
    positionUsd: top.recommendedPositionUsd, 
    decisionReason: 'BUY', 
    reasons, 
    scoreGap, 
    limitedUniverse,
    riskFlags: top.riskFlags || []
  };
}

// Build a backend-shaped entry intent. In shadow mode NO intent is produced (returns
// null) — shadow only logs. paper → testnet intent; live_spot → live intent payload.
// This function does not submit; the caller decides whether to POST it.
export function buildEntryIntent(decision, { sessionId, mode = 'shadow' } = {}) {
  if (!decision || decision.action !== 'BUY') return null;
  if (mode === 'shadow') return null; // shadow never creates an execution intent
  const base = {
    sessionId,
    symbol: decision.symbol,
    side: 'BUY',
    type: 'MARKET',
    positionUsd: decision.positionUsd,
    source: 'auto-trader',
  };
  if (mode === 'live_spot') {
    return { ...base, mode: 'live_spot', realProductionOrder: true, testnet: false, endpoint: '/api/bot/create-live-execution-intent' };
  }
  // paper → existing testnet smoke/execution path.
  return { ...base, mode: 'paper', realProductionOrder: false, testnet: true, endpoint: '/api/bot/create-execution-intent' };
}

// Decide whether to close the open position. Delegates the thresholds to the exit
// manager; returns { action:'CLOSE'|'HOLD', code, reason, pnlPct }.
export function decideExit(ctx = {}) {
  const exit = evaluateExit(ctx);
  return exit.shouldClose
    ? { action: 'CLOSE', code: exit.code, reason: exit.reason, pnlPct: exit.pnlPct }
    : { action: 'HOLD', code: 'HOLD', reason: exit.reason, pnlPct: exit.pnlPct };
}
