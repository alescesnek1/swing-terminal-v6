// auto-exit-manager.mjs — decide WHEN to close an open position.
//
// PURE: returns a close decision; it never submits an order. The actual close is
// executed by the existing worker close path (which checks the ACTUAL free base
// balance and handles dust) via the same stop/close command the cockpit uses.
//
// Exit priority (highest first): emergency → stopRequested → hard stop loss →
// take profit → trailing stop → max hold time → regime risk-off.

export const DEFAULT_EXIT_CONFIG = Object.freeze({
  stopLossPct: 3,
  takeProfitPct: 15,
  trailingStopPct: 0,   // 0 disables trailing
  maxHoldMs: 0,         // 0 disables max-hold
});

function pct(from, to) {
  const a = Number(from); const b = Number(to);
  if (!(Number.isFinite(a) && a > 0 && Number.isFinite(b))) return null;
  return ((b - a) / a) * 100;
}

// Track the peak price seen since entry for trailing-stop math. Pure: returns the
// new peak, never mutates the input.
export function updatePeakPrice(position, price) {
  const p = Number(price);
  const peak = Number(position && position.peakPrice);
  const entry = Number(position && position.entryPrice);
  const base = Number.isFinite(peak) ? peak : (Number.isFinite(entry) ? entry : 0);
  return Number.isFinite(p) ? Math.max(base, p) : base;
}

// Evaluate exit. Returns { shouldClose, code, reason, pnlPct }.
export function evaluateExit({
  position,
  price,
  config = {},
  now = Date.now(),
  stopRequested = false,
  emergency = false,
  regime = null,
} = {}) {
  const c = { ...DEFAULT_EXIT_CONFIG, ...config };
  const entry = Number(position && position.entryPrice);
  const last = Number(price);
  const pnlPct = pct(entry, last);
  const none = (extra = {}) => ({ shouldClose: false, code: 'HOLD', reason: 'within thresholds', pnlPct, ...extra });

  if (emergency) return { shouldClose: true, code: 'EMERGENCY', reason: 'emergency close requested', pnlPct };
  if (stopRequested) return { shouldClose: true, code: 'STOP_REQUESTED', reason: 'manual stop requested', pnlPct };

  if (Number.isFinite(pnlPct)) {
    if (c.stopLossPct > 0 && pnlPct <= -Math.abs(c.stopLossPct)) {
      return { shouldClose: true, code: 'STOP_LOSS', reason: `stop loss hit (${pnlPct.toFixed(2)}% <= -${c.stopLossPct}%)`, pnlPct };
    }
    if (c.takeProfitPct > 0 && pnlPct >= Math.abs(c.takeProfitPct)) {
      return { shouldClose: true, code: 'TAKE_PROFIT', reason: `take profit hit (${pnlPct.toFixed(2)}% >= ${c.takeProfitPct}%)`, pnlPct };
    }
  }

  // Trailing stop: drop from the peak by more than trailingStopPct.
  if (c.trailingStopPct > 0) {
    const peak = updatePeakPrice(position, last);
    const dropPct = pct(peak, last);
    if (Number.isFinite(dropPct) && dropPct <= -Math.abs(c.trailingStopPct)) {
      return { shouldClose: true, code: 'TRAILING_STOP', reason: `trailing stop hit (${dropPct.toFixed(2)}% from peak ${peak})`, pnlPct, peakPrice: peak };
    }
  }

  // Max hold time.
  if (c.maxHoldMs > 0) {
    const opened = new Date(position && (position.openedAt || position.timeOpened) || 0).getTime();
    if (Number.isFinite(opened) && opened > 0 && (now - opened) >= c.maxHoldMs) {
      return { shouldClose: true, code: 'MAX_HOLD', reason: `max hold time reached (${Math.round((now - opened) / 1000)}s)`, pnlPct };
    }
  }

  // Regime flips risk-off → close to protect capital.
  if (regime && (String(regime.regime || '').toUpperCase() === 'CRASH' || regime.entriesAllowed === false && regime.exitOnRiskOff === true)) {
    return { shouldClose: true, code: 'REGIME_RISK_OFF', reason: 'market regime flipped risk-off', pnlPct };
  }

  return none();
}
