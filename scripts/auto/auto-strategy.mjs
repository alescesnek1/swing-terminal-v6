// auto-strategy.mjs — turn scored candidates + an open position into decisions and
// backend-shaped intents. It MUST NOT submit orders; it only returns intent objects
// that match what the existing backend endpoints (create-*-execution-intent) and the
// worker already consume.

import { evaluateExit } from './auto-exit-manager.mjs';

export const DEFAULT_ENTRY_THRESHOLD = 60;

// Decide whether to enter. Returns { action:'BUY'|'NONE', symbol, score, positionUsd, reasons }.
// Never returns BUY when entries are disallowed (regime / flag) or the top score is
// below threshold or the candidate carries a hard risk flag (blacklist/cooldown).
export function decideEntry({
  scored = [],
  threshold = DEFAULT_ENTRY_THRESHOLD,
  regime = null,
  allowEntries = true,
} = {}) {
  const reasons = [];
  if (allowEntries === false) return { action: 'NONE', reasons: ['entries disabled'] };
  if (regime && regime.entriesAllowed === false) return { action: 'NONE', reasons: ['regime blocks entries'] };
  const top = (scored || [])[0] || null;
  if (!top) return { action: 'NONE', reasons: ['no candidate'] };
  const hardFlags = (top.riskFlags || []).filter((f) => f === 'blacklisted' || f === 'cooldown' || f === 'regime risk-off');
  if (hardFlags.length) return { action: 'NONE', symbol: top.symbol, score: top.score, reasons: [`risk flags: ${hardFlags.join(', ')}`] };
  if (!(Number(top.score) >= Number(threshold))) {
    return { action: 'NONE', symbol: top.symbol, score: top.score, reasons: [`score ${top.score} < threshold ${threshold}`] };
  }
  reasons.push(`score ${top.score} >= threshold ${threshold}`, ...(top.reasons || []));
  return { action: 'BUY', symbol: top.symbol, score: top.score, positionUsd: top.recommendedPositionUsd, reasons };
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
