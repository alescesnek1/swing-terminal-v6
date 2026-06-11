// auto-loop.mjs — the 24/7 autonomous evaluation loop that runs INSIDE the local
// worker. This module is pure orchestration with injected dependencies: it never
// touches the network or Binance itself, so every safety property is unit-testable.
//
// SAFETY CONTRACT:
//   • shadow      → posts decisions only; NEVER requests an intent
//   • paper       → may request paper/testnet intents through the backend only
//   • live_spot   → may request live intents through the backend only; the backend
//                   re-validates EVERY gate before creating anything
//   • The loop NEVER submits an order. All execution goes: decision → backend
//     auto-intent-request → fleet executionIntents / close command → the existing
//     worker execute/close path (free-base-balance + dust handling included).
//   • Backend unreachable → no new entries (decisions are not even attempted).
//   • Worker not yet hydrated (no successful session poll since start) → no entries.
//   • Stop/close always wins: the loop checks isStopping() first and exits early.
//   • One timer only: start() is idempotent; stop() clears it (no duplicates after
//     reconnect).

import { evaluateAutoTrader, marketsFromSnapshot } from './auto-trader.mjs';
import { evaluateExit, updatePeakPrice } from './auto-exit-manager.mjs';

export const AUTO_STRATEGY_VERSION = 'auto-loop-v1';
export const DEFAULT_AUTO_EVAL_INTERVAL_MS = 60000;
export const DEFAULT_AUTO_INTENT_BUCKET_MS = 300000; // 5-minute idempotency bucket
export const DEFAULT_AUTO_CONTROL_STALE_MS = 45000;  // control state older than this → backend treated unreachable
export const DEFAULT_SNAPSHOT_FRESH_MS = 120000;

// Exit thresholds from env with the spec defaults. Pure read, no I/O.
export function autoExitConfigFromEnv(env = process.env) {
  const num = (name, fallback) => {
    const n = Number(env && env[name]);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  return {
    stopLossPct: num('AUTO_STOP_LOSS_PCT', 1.0),
    takeProfitPct: num('AUTO_TAKE_PROFIT_PCT', 1.5),
    trailingStopPct: num('AUTO_TRAILING_STOP_PCT', 0.8),
    maxHoldMs: num('AUTO_MAX_HOLD_MS', 900000),
    cooldownAfterCloseMs: num('AUTO_COOLDOWN_AFTER_CLOSE_MS', 300000),
  };
}

// Deterministic idempotency key: identical for every tick inside the same time
// bucket, so the backend can reject duplicate auto intents structurally.
export function autoIdempotencyKey({ sessionId, symbol, side, now = Date.now(), bucketMs = DEFAULT_AUTO_INTENT_BUCKET_MS }) {
  const bucket = Math.floor(now / (Number(bucketMs) > 0 ? Number(bucketMs) : DEFAULT_AUTO_INTENT_BUCKET_MS));
  return `auto:${sessionId}:${String(symbol).toUpperCase()}:${String(side).toUpperCase()}:${bucket}`;
}

// createAutoLoop(deps) → { start, stop, tick, isRunning, getLastResult }
//
// All I/O is injected:
//   env                  — process.env-like object (worker env)
//   sessionId            — the worker session id
//   log(line)            — logger ([AUTO] lines)
//   getControl()         — latest backend auto control state or null:
//                          { enabled, mode, effectiveMode, entriesPaused, cooldownUntil,
//                            evalIntervalMs, buyScoreThreshold, gates: {...}, receivedAt }
//   isStopping()         — worker stop sequence active
//   isHydrated()         — at least one successful worker-session poll since start
//   backendHealthy()     — recent successful control-plane round-trip
//   getOpenPositions()   — local open positions array
//   getSnapshot()        — { snapshot, ageMs } | null  (latest public market snapshot)
//   refreshSnapshot()    — async; fetch + post a fresh snapshot, returns it (or null)
//   getPrice(symbol)     — async; current public price for exit management
//   updatePosition(pos)  — persist a mutated local position (peakPrice tracking)
//   postDecision(p)      — async; POST /api/bot/auto-decision → response json or throws
//   requestIntent(p)     — async; POST /api/bot/auto-intent-request → { status, json } or throws
//   now()                — clock (tests)
//   setIntervalFn/clearIntervalFn — timer seams (tests)
export function createAutoLoop({
  env = process.env,
  sessionId = null,
  log = () => {},
  getControl = () => null,
  isStopping = () => false,
  isHydrated = () => false,
  backendHealthy = () => false,
  getOpenPositions = () => [],
  getSnapshot = () => null,
  refreshSnapshot = async () => null,
  getPrice = async () => null,
  updatePosition = () => {},
  postDecision = async () => ({ ok: false }),
  requestIntent = async () => ({ status: 0, json: null }),
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  evalIntervalMs = null,
  intentBucketMs = DEFAULT_AUTO_INTENT_BUCKET_MS,
  snapshotFreshMs = DEFAULT_SNAPSHOT_FRESH_MS,
  controlStaleMs = DEFAULT_AUTO_CONTROL_STALE_MS,
} = {}) {
  let timer = null;
  let running = false;
  let lastResult = null;
  let localCooldownUntil = 0; // belt & braces: backend cooldown is authoritative

  const intervalMs = (() => {
    const n = Number(evalIntervalMs != null ? evalIntervalMs : env.AUTO_EVAL_INTERVAL_MS);
    return Number.isFinite(n) && n >= 5000 ? n : DEFAULT_AUTO_EVAL_INTERVAL_MS;
  })();

  function blocked(reason, extra = {}) {
    log(`[AUTO][BLOCK] reason=${reason}`);
    lastResult = { blocked: reason, at: now(), ...extra };
    return lastResult;
  }

  // Overlay the backend-requested mode onto the worker env for evaluation. The
  // AUTO_LIVE_* / BOT_* live gates are NOT overlaid — live execution requires the
  // real env flags on BOTH the worker and the backend.
  function evalEnvFor(control) {
    return { ...env, AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: control.mode };
  }

  async function ensureSnapshot() {
    const have = getSnapshot();
    if (have && have.snapshot && Number.isFinite(have.ageMs) && have.ageMs <= snapshotFreshMs) return have;
    try {
      const fresh = await refreshSnapshot();
      if (fresh) return { snapshot: fresh, ageMs: 0 };
    } catch (err) {
      log(`[AUTO][WARN] snapshot refresh failed: ${err.message}`);
    }
    return getSnapshot(); // possibly stale or null — evaluation handles both
  }

  async function safePostDecision(payload) {
    try {
      return await postDecision(payload);
    } catch (err) {
      log(`[AUTO][WARN] decision post failed: ${err.message}`);
      return null;
    }
  }

  async function tick(trigger = 'interval') {
    if (running) return { skipped: 'overlap' };
    if (isStopping()) return { skipped: 'stopping' };
    running = true;
    try {
      const tNow = now();
      const control = getControl();
      const controlAge = control && control.receivedAt ? tNow - control.receivedAt : Infinity;
      if (!control || controlAge > controlStaleMs || !backendHealthy()) {
        // Without fresh backend control state the worker must not create intents —
        // and a decision post would fail anyway. Stay quiet, stay safe.
        return blocked('backend_unreachable');
      }
      const mode = control.effectiveMode || 'off';
      if (mode === 'off' || control.enabled === false) {
        lastResult = { idle: 'auto_off', at: tNow };
        return lastResult;
      }

      log(`[AUTO] tick trigger=${trigger}`);
      log(`[AUTO] mode=${mode}`);

      const open = getOpenPositions();
      const exitConfig = autoExitConfigFromEnv(env);
      const cooldownUntil = Math.max(Number(control.cooldownUntil) || 0, localCooldownUntil);

      // ── Open position → exit management ONLY (no new entries) ──────────────
      if (open.length > 0) {
        const pos = open[0];
        let price = null;
        try { price = await getPrice(pos.symbol); } catch (err) {
          log(`[AUTO][WARN] price fetch failed for ${pos.symbol}: ${err.message}`);
        }
        if (price != null && Number.isFinite(Number(price))) {
          const newPeak = updatePeakPrice(pos, price);
          if (newPeak !== Number(pos.peakPrice)) { pos.peakPrice = newPeak; try { updatePosition(pos); } catch { /* best effort */ } }
        }
        const exit = evaluateExit({ position: pos, price, config: exitConfig, now: tNow });
        const wantClose = exit.shouldClose === true;
        const action = wantClose ? (mode === 'shadow' ? 'SHADOW_CLOSE' : 'CLOSE') : 'HOLD';
        log(`[AUTO] decision=${action} symbol=${pos.symbol} code=${exit.code} pnlPct=${exit.pnlPct != null ? exit.pnlPct.toFixed(3) : 'n/a'}`);

        const decisionPayload = {
          sessionId,
          action,
          decision: action,
          mode: control.mode,
          effectiveMode: mode,
          candidate: null,
          score: null,
          reasons: [exit.reason],
          riskBlocks: [],
          liveRiskBlocks: [],
          positionMgmt: {
            state: wantClose ? 'closing' : 'managing',
            symbol: pos.symbol,
            entryPrice: pos.entryPrice != null ? Number(pos.entryPrice) : null,
            price: price != null ? Number(price) : null,
            peakPrice: pos.peakPrice != null ? Number(pos.peakPrice) : null,
            pnlPct: exit.pnlPct != null ? exit.pnlPct : null,
            exitCode: exit.code,
          },
          dataSource: 'local_worker_position',
          snapshotAgeMs: null,
          strategyVersion: AUTO_STRATEGY_VERSION,
          cooldownUntil: cooldownUntil || null,
          evalIntervalMs: intervalMs,
        };
        const posted = await safePostDecision(decisionPayload);

        if (wantClose && mode !== 'shadow') {
          if (!posted) return blocked('backend_unreachable_no_close_intent');
          const idempotencyKey = autoIdempotencyKey({ sessionId, symbol: pos.symbol, side: 'SELL', now: tNow, bucketMs: intentBucketMs });
          try {
            const res = await requestIntent({
              sessionId, action: 'CLOSE', symbol: pos.symbol, side: 'SELL',
              idempotencyKey, reason: exit.reason, exitCode: exit.code, mode: control.mode,
              strategyVersion: AUTO_STRATEGY_VERSION,
            });
            log(`[AUTO][EXIT] close requested symbol=${pos.symbol} code=${exit.code} status=${res && res.status}`);
            localCooldownUntil = tNow + exitConfig.cooldownAfterCloseMs;
          } catch (err) {
            log(`[AUTO][WARN] close intent request failed: ${err.message}`);
          }
        }
        lastResult = { action, exit, at: tNow };
        return lastResult;
      }

      // ── Flat → consider an entry ────────────────────────────────────────────
      const snap = await ensureSnapshot();
      const snapshot = snap && snap.snapshot ? snap.snapshot : null;
      const snapshotAgeMs = snap && Number.isFinite(snap.ageMs) ? snap.ageMs : null;
      const markets = snapshot ? marketsFromSnapshot(snapshot) : [];
      const gates = control.gates || {};

      const out = evaluateAutoTrader({
        env: evalEnvFor(control),
        markets,
        regime: control.regime || null,
        liveAllowedSymbols: control.liveAllowedSymbols || ['BTCUSDC'],
        caps: control.caps || {},
        fleet: {
          durable: gates.durable === true,
          preflightFresh: gates.preflightFresh === true,
          workerOnline: true, // we ARE the worker
          openPositions: Math.max(Number(gates.openPositions) || 0, open.length),
          pendingIntent: gates.pendingIntent === true,
          safetyLock: gates.safetyLock === true,
          globalKill: gates.globalKill === true,
          sessionPaused: gates.sessionPaused === true || control.entriesPaused === true,
          dailyTradesUsed: Number(gates.dailyTradesUsed) || 0,
          dailyLossUsd: Number(gates.dailyLossUsd) || 0,
          freeQuote: gates.freeQuote != null ? Number(gates.freeQuote) : null,
          quoteAsset: gates.quoteAsset || 'USDC',
        },
        threshold: Number(control.buyScoreThreshold) > 0 ? Number(control.buyScoreThreshold) : (Number(env.AUTO_BUY_SCORE_THRESHOLD) > 0 ? Number(env.AUTO_BUY_SCORE_THRESHOLD) : 60),
        cooldownUntil,
        sessionId,
        now: tNow,
        dataSource: snapshot ? 'local_worker_binance_public' : 'none',
      });

      const liveRiskBlocks = (out.blocks || []).filter((b) => b && (b.code === 'LIVE_GATE' || b.code === 'PREFLIGHT_STALE' || b.code === 'QUOTE_NOT_USDC'));

      // Entry pause / hydration / cooldown downgrades: report, never create.
      let action = out.decision || 'NONE';
      const extraBlocks = [];
      if (!isHydrated()) extraBlocks.push({ code: 'NOT_HYDRATED', reason: 'worker has not completed a session poll since start' });
      if (control.entriesPaused === true) extraBlocks.push({ code: 'ENTRIES_PAUSED', reason: 'auto entries paused by operator' });
      if (cooldownUntil && tNow < cooldownUntil) extraBlocks.push({ code: 'COOLDOWN', reason: `post-close cooldown for ${Math.ceil((cooldownUntil - tNow) / 1000)}s` });
      const entryBlocked = extraBlocks.length > 0;
      if (entryBlocked && (action === 'PAPER_INTENT' || action === 'LIVE_INTENT')) action = 'BLOCKED';

      const mappedAction = action === 'SHADOW_BUY' ? 'SHADOW_BUY'
        : action === 'PAPER_INTENT' ? 'PAPER_BUY'
        : action === 'LIVE_INTENT' ? 'LIVE_BUY'
        : action === 'BLOCKED' ? 'BLOCKED'
        : 'NONE';

      if (out.candidate) log(`[AUTO] candidate=${out.candidate.symbol} score=${out.candidate.score}`);
      log(`[AUTO] decision=${mappedAction}`);
      for (const b of [...(out.blocks || []), ...extraBlocks]) log(`[AUTO][BLOCK] reason=${b.code}: ${b.reason}`);

      const decisionPayload = {
        sessionId,
        action: mappedAction,
        decision: mappedAction,
        mode: control.mode,
        effectiveMode: mode,
        candidate: out.candidate,
        score: out.candidate ? out.candidate.score : null,
        reasons: out.reasons || [],
        riskBlocks: [...(out.blocks || []), ...extraBlocks],
        liveRiskBlocks,
        positionMgmt: { state: 'flat' },
        dataSource: (out.diagnostics && out.diagnostics.dataSource) || (snapshot ? 'local_worker_binance_public' : 'none'),
        snapshotAgeMs,
        strategyVersion: AUTO_STRATEGY_VERSION,
        cooldownUntil: cooldownUntil || null,
        evalIntervalMs: intervalMs,
        universeSize: out.universeSize,
      };
      const posted = await safePostDecision(decisionPayload);

      // Intent creation: paper/live ONLY, never shadow, never while blocked, and
      // never when the decision post itself failed (backend connectivity gate).
      if (!entryBlocked && out.intent && (mode === 'paper' || mode === 'live_spot') && (mappedAction === 'PAPER_BUY' || mappedAction === 'LIVE_BUY')) {
        if (!posted) return blocked('backend_unreachable_no_entry_intent');
        const idempotencyKey = autoIdempotencyKey({ sessionId, symbol: out.intent.symbol, side: 'BUY', now: tNow, bucketMs: intentBucketMs });
        try {
          const res = await requestIntent({
            sessionId,
            action: 'BUY',
            symbol: out.intent.symbol,
            side: 'BUY',
            positionUsd: out.intent.positionUsd,
            idempotencyKey,
            mode: control.mode,
            score: out.candidate ? out.candidate.score : null,
            reasons: (out.reasons || []).slice(0, 6),
            strategyVersion: AUTO_STRATEGY_VERSION,
          });
          if (res && res.status >= 200 && res.status < 300 && res.json && res.json.ok) {
            log(`[AUTO][INTENT] created ${res.json.intent ? res.json.intent.id : '(existing)'} ${out.intent.symbol} positionUsd=${out.intent.positionUsd}`);
          } else {
            log(`[AUTO][BLOCK] reason=intent_rejected status=${res && res.status} error=${res && res.json && res.json.error}`);
          }
        } catch (err) {
          log(`[AUTO][WARN] intent request failed: ${err.message}`);
        }
      }

      lastResult = { action: mappedAction, candidate: out.candidate, blocks: [...(out.blocks || []), ...extraBlocks], at: tNow };
      return lastResult;
    } finally {
      running = false;
    }
  }

  function start() {
    if (timer) return false; // never duplicate the interval (reconnect-safe)
    timer = setIntervalFn(() => { tick('interval').catch((err) => log(`[AUTO][ERROR] tick failed: ${err.message}`)); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    log(`[AUTO] loop started interval=${intervalMs}ms strategy=${AUTO_STRATEGY_VERSION}`);
    return true;
  }

  function stop() {
    if (timer) { clearIntervalFn(timer); timer = null; log('[AUTO] loop stopped'); return true; }
    return false;
  }

  return {
    start,
    stop,
    tick,
    isRunning: () => !!timer,
    getLastResult: () => lastResult,
    intervalMs,
  };
}
