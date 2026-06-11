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

function candidateView(c, extra = {}) {
  return c ? {
    symbol: c.symbol, score: c.score, reasons: c.reasons || [],
    riskFlags: c.riskFlags || [], recommendedPositionUsd: c.recommendedPositionUsd,
    quoteVolume: c.quoteVolume, priceChangePercent: c.priceChangePercent,
    spreadPct: c.spreadPct, liquidityScore: c.liquidityScore,
    spreadScore: c.spreadScore, momentumScore: c.momentumScore,
    volatilityScore: c.volatilityScore, trendScore: c.trendScore,
    regimeScore: c.regimeScore, cooldownBlocked: c.cooldownBlocked,
    cooldownRemainingMs: c.cooldownRemainingMs, cooldownUntil: c.cooldownUntil,
    rejectedReason: c.rejectedReason, ...extra
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
  dataSource = null,
  fetchError = null,
  historyMetricsMap = {},
  historyWarmup = false,
  cooldownOverrideGap = 12,
  leaderboardSize = 10,
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
    candidates: [],
    universeSize: 0,
    decision: 'OFF',
    decisionReason: null,
    scoreGap: null,
    entry: null,
    exit: null,
    blocks: [],
    intent: null,
    reasons: [],
    positionOpen: !!position,
    diagnostics: null,
  };

  if (!a.enabled) return { ...baseline, decisionReason: 'entries_disabled', reasons: ['auto trader disabled (AUTO_TRADER_ENABLED!=true)'] };

  // Universe + scoring (used for entries and for the candidate display).
  const { universe, diagnostics } = buildUniverse({ markets, mode, liveAllowedSymbols, filters, dataSource, fetchError });
  diagnostics.historySamples = Object.keys(historyMetricsMap).length;
  diagnostics.historyWarmup = historyWarmup;
  diagnostics.scoringVersion = 'auto-scorer-v2';

  // Map history to scorer
  const ctx = { regime, blacklist, cooldowns, now, caps, historyWarmup };
  const scored = (universe || [])
    .map((market) => scoreUniverse([{...market}], { ...ctx, historyMetrics: historyMetricsMap[market.symbol] || {} })[0])
    .sort((a, b) => b.score - a.score);
  
  // Track cooldown exclusions for diagnostics
  diagnostics.excludedCooldown = scored.filter(c => c.cooldownBlocked).length;

  const candidatesList = scored.slice(0, leaderboardSize).map((c, i) => candidateView(c, { rank: i + 1, selected: false, action: 'NONE', decisionReason: 'NONE' }));
  const topRawCandidate = scored[0] || null;

  // ── Position open → manage the exit (close converges on the worker close path) ──
  if (position) {
    const exit = decideExit({ position, price, config: exitConfig, now, stopRequested, emergency, regime });
    const wantClose = exit.action === 'CLOSE';
    return {
      ...baseline,
      candidate: candidateView(topRawCandidate),
      candidates: candidatesList,
      universeSize: universe.length,
      exit,
      // shadow logs a hypothetical close; paper/live emit a CLOSE command intent that
      // maps onto the SAME stop/close path the cockpit uses (no separate sell logic).
      decision: wantClose ? (mode === 'shadow' ? 'SHADOW_CLOSE' : 'CLOSE_INTENT') : 'HOLD',
      decisionReason: wantClose ? 'CLOSE' : 'open_position',
      intent: (wantClose && mode !== 'shadow' && sessionId)
        ? { type: 'CLOSE', sessionId, mode, endpoint: `/api/bot/session/${sessionId}/stop`, reason: exit.reason, source: 'auto-trader' }
        : null,
      reasons: [exit.reason],
      diagnostics,
    };
  }

  // ── Flat → consider an entry ──
  const riskMode = (mode === 'shadow' || (mode === 'paper' && a.paperAllowRiskOff)) ? 'flag_only' : 'block_entries';
  const entry = decideEntry({ scored, threshold, regime, allowEntries: true, cooldownOverrideGap, riskMode });
  
  // Tag the selected candidate in the leaderboard
  let selectedCandidate = null;
  if (entry.symbol) {
    selectedCandidate = candidatesList.find(c => c.symbol === entry.symbol);
    if (selectedCandidate) {
      selectedCandidate.selected = true;
      selectedCandidate.action = entry.action;
      selectedCandidate.decisionReason = entry.decisionReason;
    }
  }

  if (entry.action !== 'BUY') {
    return { 
      ...baseline, 
      candidate: selectedCandidate || candidateView(topRawCandidate), 
      candidates: candidatesList, 
      universeSize: universe.length, 
      entry, 
      decision: 'NONE', 
      decisionReason: entry.decisionReason,
      requiredThreshold: threshold,
      scoreGap: entry.scoreGap,
      reasons: entry.reasons, 
      diagnostics 
    };
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
    const shadowReason = entry.decisionReason === 'BUY' ? 'signal' : (entry.decisionReason || 'signal');
    return { ...baseline, candidate: selectedCandidate || candidateView(topRawCandidate), candidates: candidatesList, universeSize: universe.length, entry, blocks: risk.blocks, decision: 'SHADOW_BUY_SIGNAL', decisionReason: shadowReason, requiredThreshold: threshold, scoreGap: entry.scoreGap, intent: null, reasons: entry.reasons, diagnostics };
  }
  if (mode === 'paper') {
    if (!risk.allowed) return { ...baseline, candidate: selectedCandidate || candidateView(topRawCandidate), candidates: candidatesList, universeSize: universe.length, entry, blocks: risk.blocks, decision: 'BLOCKED', decisionReason: risk.reason, requiredThreshold: threshold, scoreGap: entry.scoreGap, intent: null, reasons: entry.reasons, diagnostics };
    
    const isRiskOff = entry.riskFlags && entry.riskFlags.includes('regime risk-off');
    if (isRiskOff && a.paperAllowRiskOff) {
      entry.positionUsd = Math.max(1, (entry.positionUsd || 1) * a.paperRiskOffSizeMultiplier);
    }
    const intent = buildEntryIntent(entry, { sessionId, mode: 'paper' });
    if (isRiskOff && intent) {
      intent.paperRiskOffTest = true;
      intent.riskFlags = entry.riskFlags || [];
    }
    const decisionReason = isRiskOff ? 'paper_signal_risk_off' : (entry.decisionReason === 'BUY' ? 'signal' : (entry.decisionReason || 'signal'));
    return { ...baseline, candidate: selectedCandidate || candidateView(topRawCandidate), candidates: candidatesList, universeSize: universe.length, entry, blocks: risk.blocks, decision: 'PAPER_INTENT', decisionReason, requiredThreshold: threshold, scoreGap: entry.scoreGap, intent, reasons: entry.reasons, diagnostics };
  }
  // live_spot
  if (!risk.allowed) return { ...baseline, candidate: selectedCandidate || candidateView(topRawCandidate), candidates: candidatesList, universeSize: universe.length, entry, blocks: risk.blocks, decision: 'BLOCKED', decisionReason: risk.reason, requiredThreshold: threshold, scoreGap: entry.scoreGap, intent: null, reasons: entry.reasons, diagnostics };
  const intent = buildEntryIntent(entry, { sessionId, mode: 'live_spot' });
  return { ...baseline, candidate: selectedCandidate || candidateView(topRawCandidate), candidates: candidatesList, universeSize: universe.length, entry, blocks: risk.blocks, decision: 'LIVE_INTENT', decisionReason: 'BUY', requiredThreshold: threshold, scoreGap: entry.scoreGap, intent, reasons: entry.reasons, diagnostics };
}

// Map a stored local-worker snapshot (sanitized public market objects) onto the
// market shape buildUniverse expects. Pure; tolerates a missing/malformed snapshot.
export function marketsFromSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.markets)) return [];
  return snapshot.markets
    .filter((m) => m && m.symbol)
    .map((m) => ({
      symbol: m.symbol,
      baseAsset: m.baseAsset || null,
      quoteAsset: m.quoteAsset || null,
      status: m.status || null,
      volume24hUsd: Number(m.quoteVolume),
      quoteVolume24h: Number(m.quoteVolume),
      spreadPct: m.spreadPct != null && Number.isFinite(Number(m.spreadPct)) ? Number(m.spreadPct) : null,
      change24hPct: Number(m.priceChangePercent),
    }));
}

export const SNAPSHOT_FRESH_MS_DEFAULT = 120000;

// Data-source priority when the scanner universe is empty/fully filtered:
//   a) scanner markets (already evaluated by the caller-provided args)
//   b) fresh local-worker public snapshot (args.localSnapshot, age <= snapshotFreshMs)
//   c) Netlify-side Binance public fetch — ONLY when the snapshot is missing/stale
//   d) shadow-only allowlist fallback (inside buildUniverse)
export async function evaluateAutoTraderWithFallback(args, fetchPublicFn) {
  let out = evaluateAutoTrader(args);
  const effectiveMode = effectiveAutoMode(args.env);

  let publicFetchAttempted = false;
  let publicFetchOk = false;
  let publicFetchCount = 0;
  let publicFetchMs = 0;
  let fetchError = null;
  let snapshotUsed = false;
  let snapshotAgeMs = null;
  const events = [];

  if (effectiveMode === 'shadow' && (!out.candidate || out.diagnostics.fallbackUsed)) {
    const now = args.now || Date.now();
    const snapshot = args.localSnapshot || null;
    const freshMs = Number(args.snapshotFreshMs) > 0 ? Number(args.snapshotFreshMs) : SNAPSHOT_FRESH_MS_DEFAULT;
    const fetchedAtMs = snapshot && snapshot.fetchedAt ? new Date(snapshot.fetchedAt).getTime() : NaN;
    snapshotAgeMs = Number.isFinite(fetchedAtMs) ? Math.max(0, now - fetchedAtMs) : null;
    const snapshotFresh = snapshotAgeMs != null && snapshotAgeMs <= freshMs;
    const snapshotMarkets = snapshotFresh ? marketsFromSnapshot(snapshot) : [];

    if (snapshotFresh && snapshotMarkets.length > 0) {
      // b) Fresh local-worker snapshot — use it and do NOT hit Binance from here.
      snapshotUsed = true;
      const newArgs = { ...args, markets: snapshotMarkets, dataSource: 'local_worker_binance_public', fetchError: null };
      if (args.computeRegime) newArgs.regime = args.computeRegime(snapshotMarkets);
      out = evaluateAutoTrader(newArgs);
    } else {
      // c) Snapshot missing/stale → Netlify-side public fetch.
      publicFetchAttempted = true;
      events.push({ type: 'AUTO_PUBLIC_FETCH_ATTEMPT', severity: 'info', message: 'Scanner universe empty/filtered and local worker snapshot missing or stale. Attempting Binance public fetch...' });
      const start = Date.now();
      try {
        const publicMarkets = await fetchPublicFn();
        publicFetchCount = publicMarkets ? publicMarkets.length : 0;
        publicFetchOk = true;
        publicFetchMs = Date.now() - start;
        events.push({ type: 'AUTO_PUBLIC_FETCH_OK', severity: 'info', message: `Binance public fetch succeeded with ${publicFetchCount} markets in ${publicFetchMs}ms.` });

        if (publicMarkets && publicMarkets.length > 0) {
          const newArgs = { ...args, markets: publicMarkets, dataSource: 'binance_public', fetchError: null };
          if (args.computeRegime) newArgs.regime = args.computeRegime(publicMarkets);
          out = evaluateAutoTrader(newArgs);
        }
      } catch (err) {
        publicFetchMs = Date.now() - start;
        fetchError = err.message;
        events.push({ type: 'AUTO_PUBLIC_FETCH_FAILED', severity: 'warning', message: `Binance public fetch failed after ${publicFetchMs}ms: ${fetchError}` });
        out.diagnostics.fetchError = fetchError;
      }
    }
  }

  if (out.diagnostics) {
    out.diagnostics.publicFetchAttempted = publicFetchAttempted;
    out.diagnostics.publicFetchOk = publicFetchOk;
    out.diagnostics.publicFetchCount = publicFetchCount;
    out.diagnostics.publicFetchMs = publicFetchMs;
    out.diagnostics.publicFetchError = fetchError;
    out.diagnostics.snapshotUsed = snapshotUsed;
    out.diagnostics.snapshotAgeMs = snapshotAgeMs;
  }

  return { out, events };
}
