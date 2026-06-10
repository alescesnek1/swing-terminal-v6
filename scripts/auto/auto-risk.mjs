// auto-risk.mjs — hard gates that must ALL pass before any entry intent.
//
// PURE: returns { allowed, blocks } with explicit diagnostic reasons. It never
// submits an order. For live mode it re-derives the live-execution gate from env
// (auto-env) independently of the UI, so a misconfigured env can never let
// autonomous code reach a live order.

import { autoLiveExecutionAllowed } from './auto-env.mjs';

// Evaluate entry gates. All inputs are injected so this is fully testable.
export function evaluateEntryGates({
  mode = 'shadow',
  env = process.env,
  durable = false,
  preflightFresh = false,
  workerOnline = false,
  openPositions = 0,
  pendingIntent = false,
  safetyLock = false,
  globalKill = false,
  sessionPaused = false,
  dailyTradesUsed = 0,
  maxDailyTrades = 0,
  dailyLossUsd = 0,
  maxDailyLossUsd = Infinity,
  cooldownUntil = 0,
  now = Date.now(),
  positionUsd = 0,
  minPositionUsd = 0,
  maxPositionUsd = Infinity,
  freeQuote = null,        // free quote balance (number) or null if unknown
  quoteAsset = 'USDC',
  maxOpenPositions = 1,
} = {}) {
  const blocks = [];
  const block = (code, reason) => blocks.push({ code, reason });

  // Universal gates (apply to every mode, including shadow/paper, so the operator
  // sees identical diagnostics regardless of mode).
  if (durable !== true) block('NO_DURABLE_STORE', 'durable store is required before any entry');
  if (globalKill === true) block('GLOBAL_KILL', 'global kill switch is active');
  if (safetyLock === true) block('SAFETY_LOCK', 'live safety lock active — reconcile the open position first');
  if (sessionPaused === true) block('SESSION_PAUSED', 'entries are paused for this session');
  if (workerOnline !== true) block('WORKER_OFFLINE', 'local worker is offline');
  if (Number(openPositions) >= Number(maxOpenPositions)) block('POSITION_OPEN', `max open positions (${maxOpenPositions}) reached`);
  if (pendingIntent === true) block('PENDING_INTENT', 'an execution intent is already pending');
  if (Number(dailyTradesUsed) >= Number(maxDailyTrades)) block('DAILY_TRADES_CAP', `daily trade cap reached (${dailyTradesUsed}/${maxDailyTrades})`);
  if (Number(dailyLossUsd) >= Number(maxDailyLossUsd)) block('DAILY_LOSS_CAP', `daily loss cap reached (${dailyLossUsd}/${maxDailyLossUsd})`);
  if (Number.isFinite(Number(cooldownUntil)) && now < Number(cooldownUntil)) block('COOLDOWN', `in post-close cooldown for ${Math.ceil((cooldownUntil - now) / 1000)}s`);

  // Position sizing.
  const usd = Number(positionUsd);
  if (!(Number.isFinite(usd) && usd > 0)) block('NO_SIZE', 'positionUsd must be > 0');
  else {
    if (usd < Number(minPositionUsd)) block('BELOW_MIN', `positionUsd ${usd} below minimum ${minPositionUsd}`);
    if (usd > Number(maxPositionUsd)) block('ABOVE_MAX', `positionUsd ${usd} above cap ${maxPositionUsd}`);
    if (freeQuote != null && Number.isFinite(Number(freeQuote)) && Number(freeQuote) < usd) {
      block('INSUFFICIENT_QUOTE', `insufficient ${quoteAsset} balance (need ${usd}, have ${freeQuote})`);
    }
  }

  // Live-only gates.
  if (mode === 'live_spot') {
    if (String(quoteAsset).toUpperCase() !== 'USDC') block('QUOTE_NOT_USDC', 'live quote asset must be USDC');
    if (preflightFresh !== true) block('PREFLIGHT_STALE', 'fresh live preflight is required for live entries');
    const gate = autoLiveExecutionAllowed(env);
    if (!gate.allowed) block('LIVE_GATE', `autonomous live execution gate not satisfied: missing ${gate.missing.join(', ')}`);
  }

  return { allowed: blocks.length === 0, blocks, mode };
}
