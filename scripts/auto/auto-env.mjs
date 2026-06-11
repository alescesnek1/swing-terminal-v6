// auto-env.mjs — autonomous trader env flags + the live-execution gate.
//
// SAFETY: this module ONLY reads/normalizes flags. It performs no I/O and submits
// no orders. Autonomous LIVE execution must be impossible unless EVERY flag below
// is explicitly set — the default (empty) env yields { allowed:false } with every
// flag listed as missing.
//
// Dormant defaults (do NOT change without an explicit operator decision):
//   AUTO_TRADER_ENABLED=false
//   AUTO_TRADER_MODE=shadow
//   AUTO_LIVE_TRADING_ENABLED=false

export const LIVE_SPOT_ACK_TEXT = 'I_UNDERSTAND_REAL_MONEY_RISK';
export const AUTO_MODES = Object.freeze(['shadow', 'paper', 'live_spot']);

// Every flag (and its required value) that must hold for autonomous LIVE execution.
// Order is significant only for the human-readable `missing` list.
export const AUTO_LIVE_REQUIRED_FLAGS = Object.freeze([
  ['AUTO_TRADER_ENABLED', 'true'],
  ['AUTO_TRADER_MODE', 'live_spot'],
  ['AUTO_LIVE_TRADING_ENABLED', 'true'],
  ['BOT_LIVE_TRADING_ENABLED', 'true'],
  ['BOT_ALLOW_REAL_ORDERS', 'true'],
  ['LOCAL_WORKER_LIVE_CONFIRM', 'true'],
  ['LIVE_SPOT_ACK', LIVE_SPOT_ACK_TEXT],
]);

function flag(env, name) {
  return env && env[name] !== undefined && env[name] !== null ? String(env[name]) : '';
}

// Normalized view of the autonomous-trader env. `mode` is clamped to a known mode;
// when AUTO_TRADER_ENABLED is not 'true' the trader is OFF regardless of mode.
export function readAutoEnv(env = process.env) {
  const enabled = flag(env, 'AUTO_TRADER_ENABLED') === 'true';
  const rawMode = flag(env, 'AUTO_TRADER_MODE') || 'shadow';
  const mode = AUTO_MODES.includes(rawMode) ? rawMode : 'shadow';
  return {
    enabled,
    mode,
    autoLiveTradingEnabled: flag(env, 'AUTO_LIVE_TRADING_ENABLED') === 'true',
    botLiveTradingEnabled: flag(env, 'BOT_LIVE_TRADING_ENABLED') === 'true',
    allowRealOrders: flag(env, 'BOT_ALLOW_REAL_ORDERS') === 'true',
    localWorkerLiveConfirm: flag(env, 'LOCAL_WORKER_LIVE_CONFIRM') === 'true',
    liveSpotAck: flag(env, 'LIVE_SPOT_ACK') === LIVE_SPOT_ACK_TEXT,
    paperAllowRiskOff: flag(env, 'AUTO_PAPER_ALLOW_RISK_OFF') !== 'false',
    paperRiskOffSizeMultiplier: Number.isFinite(Number(flag(env, 'AUTO_PAPER_RISK_OFF_SIZE_MULTIPLIER'))) ? Number(flag(env, 'AUTO_PAPER_RISK_OFF_SIZE_MULTIPLIER')) : 0.5,
  };
}

// The effective autonomous mode for the operator UI: OFF when disabled, else the
// clamped mode. Never reports live_spot as the effective mode unless live execution
// is actually allowed — a misconfigured live mode degrades to LIVE LOCKED.
export function effectiveAutoMode(env = process.env) {
  const a = readAutoEnv(env);
  if (!a.enabled) return 'off';
  if (a.mode === 'live_spot') return autoLiveExecutionAllowed(env).allowed ? 'live_spot' : 'live_locked';
  return a.mode;
}

// The single source of truth for "may autonomous code create a LIVE intent?".
// Returns { allowed, missing[] }. With default env, allowed=false and every flag
// is missing. This is re-checked by auto-risk before any live intent is emitted.
export function autoLiveExecutionAllowed(env = process.env) {
  const missing = [];
  for (const [name, want] of AUTO_LIVE_REQUIRED_FLAGS) {
    if (flag(env, name) !== want) missing.push(name);
  }
  return { allowed: missing.length === 0, missing };
}
