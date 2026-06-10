// auto-trader.mjs — orchestrator that wires the autonomous layer together.
//
// SAFETY CONTRACT (the whole point of this module):
//   • shadow  → never returns an execution intent (logs hypothetical only)
//   • paper   → may return ONLY a paper/testnet intent, never a live one
//   • live_spot → may return a live intent ONLY when every auto-risk gate passes,
//                 which includes the env live-execution gate (auto-env)
// It NEVER submits an order. It returns a decision object; a caller decides what to
// do with `intent`. With the default dormant env it returns { decision: 'OFF' }.

import { readAutoEnv, effectiveAutoMode, autoLiveExecutionAllowed } from './auto-env.mjs';
import { buildUniverse } from './auto-universe.mjs';
import { scoreUniverse } from './auto-scorer.mjs';
import { decideEntry, decideExit, buildEntryIntent, DEFAULT_ENTRY_THRESHOLD } from './auto-strategy.mjs';
import { evaluateEntryGates } from './auto-risk.mjs';

function candidateView(c) {
  return c ? {
    symbol: c.symbol, score: c.score, reasons: c.reasons || [],
    riskFlags: c.riskFlags || [], recommendedPositionUsd: c.recommendedPositionUsd,
  } : null;
}

export function evaluateAutoTrader({
  env = process.env,
  markets = [],
  regime = null,
  liveAllowedSymbols = ['BTCUSDC'],
  filters = {},
  caps = {},
  fleet = {},            // durable/preflightFresh/workerOnline/openPositions/... (see auto-risk)
  position = null,       // open position object (for exit evaluation)
  price = null,
  exitConfig = {},
  stopRequested = false,
  emergency = false,
  threshold = DEFAULT_ENTRY_THRESHOLD,
  blacklist = [],
  cooldowns = {},
  cooldownUntil = 0,
  sessionId = null,
  now = Date.now(),
} = {}) {
  const a = readAutoEnv(env);
  const mode = a.mode;
  const effectiveMode = effectiveAutoMode(env);
  const liveExecutionAllowed = autoLiveExecutionAllowed(env).allowed;

  const baseline = {
    enabled: a.enabled,
    mode,
    effectiveMode,
    liveExecutionAllowed,
    candidate: null,
    universeSize: 0,
    decision: 'OFF',
    entry: null,
    exit: null,
    blocks: [],
    intent: null,
    reasons: [],
    positionOpen: !!position,
    diagnostics: null,
  };

  if (!a.enabled) return { ...baseline, reasons: ['auto trader disabled (AUTO_TRADER_ENABLED!=true)'] };

  // Universe + scoring (used for entries and for the candidate display).
  const { universe, diagnostics } = buildUniverse({ markets, mode, liveAllowedSymbols, filters });
  const scored = scoreUniverse(universe, { regime, blacklist, cooldowns, now, caps });
  const candidate = scored[0] || null;

  // ── Position open → manage the exit (close converges on the worker close path) ──
  if (position) {
    const exit = decideExit({ position, price, config: exitConfig, now, stopRequested, emergency, regime });
    const wantClose = exit.action === 'CLOSE';
    return {
      ...baseline,
      candidate: candidateView(candidate),
      universeSize: universe.length,
      exit,
      // shadow logs a hypothetical close; paper/live emit a CLOSE command intent that
      // maps onto the SAME stop/close path the cockpit uses (no separate sell logic).
      decision: wantClose ? (mode === 'shadow' ? 'SHADOW_CLOSE' : 'CLOSE_INTENT') : 'HOLD',
      intent: (wantClose && mode !== 'shadow' && sessionId)
        ? { type: 'CLOSE', sessionId, mode, endpoint: `/api/bot/session/${sessionId}/stop`, reason: exit.reason, source: 'auto-trader' }
        : null,
      reasons: [exit.reason],
      diagnostics,
    };
  }

  // ── Flat → consider an entry ──
  const entry = decideEntry({ scored, threshold, regime, allowEntries: true });
  if (entry.action !== 'BUY') {
    return { ...baseline, candidate: candidateView(candidate), universeSize: universe.length, entry, decision: 'NONE', reasons: entry.reasons, diagnostics };
  }

  const risk = evaluateEntryGates({
    mode,
    env,
    durable: fleet.durable === true,
    preflightFresh: fleet.preflightFresh === true,
    workerOnline: fleet.workerOnline === true,
    openPositions: Number(fleet.openPositions) || 0,
    pendingIntent: fleet.pendingIntent === true,
    safetyLock: fleet.safetyLock === true,
    globalKill: fleet.globalKill === true,
    sessionPaused: fleet.sessionPaused === true,
    dailyTradesUsed: Number(fleet.dailyTradesUsed) || 0,
    maxDailyTrades: Number(caps.maxDailyTrades),
    dailyLossUsd: Number(fleet.dailyLossUsd) || 0,
    maxDailyLossUsd: Number(caps.maxDailyLossUsd),
    cooldownUntil,
    now,
    positionUsd: entry.positionUsd,
    minPositionUsd: Number(caps.minPositionUsd),
    maxPositionUsd: Number(caps.maxPositionUsd),
    freeQuote: fleet.freeQuote != null ? Number(fleet.freeQuote) : null,
    quoteAsset: fleet.quoteAsset || 'USDC',
    maxOpenPositions: Number(caps.maxOpenPositions) || 1,
  });

  // shadow ALWAYS resolves to a hypothetical (no intent), regardless of gates.
  if (mode === 'shadow') {
    return { ...baseline, candidate: candidateView(candidate), universeSize: universe.length, entry, blocks: risk.blocks, decision: 'SHADOW_BUY', intent: null, reasons: entry.reasons, diagnostics };
  }

  if (!risk.allowed) {
    return { ...baseline, candidate: candidateView(candidate), universeSize: universe.length, entry, blocks: risk.blocks, decision: 'BLOCKED', intent: null, reasons: risk.blocks.map((b) => b.reason), diagnostics };
  }

  const intent = buildEntryIntent(entry, { sessionId, mode });
  return {
    ...baseline,
    candidate: candidateView(candidate),
    universeSize: universe.length,
    entry,
    blocks: [],
    decision: mode === 'live_spot' ? 'LIVE_INTENT' : 'PAPER_INTENT',
    intent,
    reasons: entry.reasons,
    diagnostics,
  };
}
