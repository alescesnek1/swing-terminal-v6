// ─────────────────────────────────────────────────────────────
// Swing Terminal V6 — Paper Trading Engine (24/7 sandbox)
//
// Subscribes to the same `tick` event on the Aggregator that powers
// alerts and the client stream. Runs a basic momentum-breakout entry
// rule per symbol, manages open positions with TP / SL / time-stop,
// keeps a ledger of closed trades, and feeds a self-tuning
// `cautionMultiplier` learning loop that tightens the entry trigger
// after losses and decays it after wins.
//
// The bot lives on the server, ticks independently of every client
// connection, and exposes its state two ways:
//   • `pb` event (consumed by stream.js → fanned to WS clients).
//   • `getState()` / `getLedger()` (consumed by the REST polling
//     fallback wired into health.js).
//
// Frame contract (matches client expectations):
//   { t:'pb', status, balance, equity, pnl, pnlPct, winRate,
//     wins, losses, openCount, cautionMultiplier, openPositions,
//     recentTrades, ts }
// ─────────────────────────────────────────────────────────────

import { EventEmitter } from 'node:events';

const DEFAULTS = {
  startingBalance: 10_000,
  riskPerTradeUsd: 250,
  takeProfitPctMin: 0.10,
  takeProfitPctMax: 0.20,
  stopLossPct: 0.03,
  maxHoldMs: 30 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
  maxOpenPositions: 6,
  ledgerCap: 200,
  recentTradesCap: 25,
  // Momentum window: last N ticks held per symbol. Breakout fires
  // when the latest price clears the rolling max by `entryEdgePct *
  // cautionMultiplier`. A tight window keeps the bot reactive on
  // 50ms tick cadence without needing kline buffers.
  priceWindow: 36,
  flushMinPct: 0.0035,
  // Learning loop. Loss → tighten; win → relax. Clamped so the bot
  // never freezes (mult ≤ MAX) and never trades on noise (mult ≥ MIN).
  cautionOnLoss: 1.18,
  cautionOnWin: 0.93,
  cautionMin: 0.5,
  cautionMax: 4.0,
  // State broadcast cadence. Decoupled from the tick fan-out so a
  // 50ms tick storm doesn't drown the WS in pb frames.
  broadcastIntervalMs: 2000,
};

export class PaperBot extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('./aggregator.js').Aggregator} opts.aggregator
   * @param {Partial<typeof DEFAULTS>} [opts.config]
   */
  constructor({ aggregator, config = {} } = {}) {
    super();
    if (!aggregator) throw new Error('PaperBot: aggregator is required');
    this.setMaxListeners(64);

    this.aggregator = aggregator;
    this.cfg = { ...DEFAULTS, ...config };

    this.startedAt = 0;
    this.status = 'idle';
    this.balance = this.cfg.startingBalance;
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.cautionMultiplier = 1.0;

    /** @type {Map<string, { side:'long', symbol:string, entryPrice:number, qty:number, notional:number, tp:number, sl:number, openedAt:number, lastPrice:number }>} */
    this.openPositions = new Map();
    /** @type {Array<object>} closed-trade ledger, newest first, capped. */
    this.ledger = [];

    /** Per-symbol rolling price window for breakout detection. */
    this._priceBuf = new Map();
    /** Per-symbol cooldown after a closed trade. */
    this._cooldown = new Map();
    /** Last seen price per symbol — feeds equity mark-to-market. */
    this._lastPrice = new Map();

    this._tickListener = (frame) => this._onTick(frame);
    this._broadcastTimer = null;
  }

  start() {
    if (this.status === 'running') return;
    this.startedAt = Date.now();
    this.status = 'running';
    this.aggregator.on('tick', this._tickListener);
    this._broadcastTimer = setInterval(
      () => this._broadcastState(),
      this.cfg.broadcastIntervalMs,
    );
    console.log(
      `[PAPERBOT] Started — balance $${this.balance.toFixed(2)}, ` +
      `risk $${this.cfg.riskPerTradeUsd}/trade, ` +
      `TP ${(this.cfg.takeProfitPctMin * 100).toFixed(2)}-${(this.cfg.takeProfitPctMax * 100).toFixed(2)}% / ` +
      `SL ${(this.cfg.stopLossPct * 100).toFixed(2)}%`,
    );
    this._broadcastState();
  }

  stop() {
    if (this.status !== 'running') return;
    this.aggregator.off('tick', this._tickListener);
    if (this._broadcastTimer) clearInterval(this._broadcastTimer);
    this._broadcastTimer = null;
    this.status = 'stopped';
    console.log(
      `[PAPERBOT] Stopped — closed ${this.ledger.length} trades, ` +
      `PnL $${this.realizedPnl.toFixed(2)}, ` +
      `W/L ${this.wins}/${this.losses}, ` +
      `caution ${this.cautionMultiplier.toFixed(2)}`,
    );
  }

  // ─────────────────────────────────────────────────────────
  // Tick handling
  // ─────────────────────────────────────────────────────────
  _onTick(frame) {
    if (!frame || frame.t !== 'tick') return;
    const sym = frame.s;
    const px = Number(frame.p);
    if (!sym || !Number.isFinite(px) || px <= 0) return;

    this._lastPrice.set(sym, px);
    this._pushPrice(sym, px);

    // Update / close any position on this symbol first — exits take
    // priority over entries so a flip-flopping tick never enters a new
    // trade on the same frame that the prior one stops out.
    const pos = this.openPositions.get(sym);
    if (pos) {
      pos.lastPrice = px;
      this._maybeClose(pos, px, frame.ts || Date.now());
      return;
    }

    this._maybeOpen(sym, px, frame.ts || Date.now());
  }

  _pushPrice(sym, px) {
    let buf = this._priceBuf.get(sym);
    if (!buf) {
      buf = [];
      this._priceBuf.set(sym, buf);
    }
    buf.push(px);
    if (buf.length > this.cfg.priceWindow) buf.shift();
  }

  // ─────────────────────────────────────────────────────────
  // Entry rule — momentum breakout
  // ─────────────────────────────────────────────────────────
  _maybeOpen(sym, px, ts) {
    if (this.openPositions.size >= this.cfg.maxOpenPositions) return;

    const cdUntil = this._cooldown.get(sym) || 0;
    if (ts < cdUntil) return;

    const buf = this._priceBuf.get(sym);
    if (!buf || buf.length < 4) return;

    const signal = this._detectFlush(buf);
    if (!signal) return;

    const notional = Math.min(this.cfg.riskPerTradeUsd / this.cfg.stopLossPct, this.balance * 0.5);
    if (notional <= 0) return;
    const qty = notional / px;
    const sideMul = signal.side === 'short' ? -1 : 1;
    const tpPct = this._takeProfitPctForSignal(signal);
    const slPct = 0.03;

    const pos = {
      side: signal.side,
      symbol: sym,
      entryPrice: px,
      qty,
      notional,
      tp: px * (1 + sideMul * tpPct),
      sl: px * (1 - sideMul * slPct),
      tpPct,
      slPct,
      reason: signal.side === 'short' ? 'liquidation_flush_short' : 'liquidation_flush_long',
      openedAt: ts,
      lastPrice: px,
    };
    this.openPositions.set(sym, pos);

    console.log(
      `[PAPERBOT] OPEN ${signal.side.toUpperCase()} ${sym} @ ${px.toFixed(6)} ` +
      `qty=${qty.toFixed(4)} tp=${pos.tp.toFixed(6)} sl=${pos.sl.toFixed(6)} ` +
      `caution=${this.cautionMultiplier.toFixed(2)}`,
    );
    this._broadcastState();
  }

  _detectFlush(buf) {
    const n = Array.isArray(buf) ? buf.length : 0;
    if (n < 4) return null;
    const last = Number(buf[n - 1]);
    if (!Number.isFinite(last) || last <= 0) return null;

    let maxStep = 0;
    for (let i = Math.max(1, n - 12); i < n; i++) {
      const a = Number(buf[i - 1]);
      const b = Number(buf[i]);
      if (a > 0 && b > 0) maxStep = Math.max(maxStep, Math.abs(b - a) / a);
    }

    const minFlush = Math.max(this.cfg.flushMinPct, Math.min(0.018, maxStep * 1.25));
    const lookbackStart = Math.max(1, n - 10);
    let best = null;

    for (let i = lookbackStart; i < n - 1; i++) {
      const base = Number(buf[i - 1]);
      const wick = Number(buf[i]);
      if (!(base > 0 && wick > 0)) continue;

      const flushPct = (wick - base) / base;
      const mag = Math.abs(flushPct);
      if (mag < minFlush) continue;

      const reactionPct = (last - wick) / wick;
      const retrace = Math.abs(last - wick) / Math.abs(wick - base);
      const stabilized = Math.abs(reactionPct) <= mag * 0.18;
      if (retrace < 0.08 && !stabilized) continue;

      const strength = 21 + mag * 300 + Math.min(8, retrace * 10);
      const required = 16 * Math.sqrt(Math.max(this.cfg.cautionMin, this.cautionMultiplier));
      if (strength < required) continue;

      if (flushPct < 0 && last > wick && last <= base * 1.006) {
        const candidate = { side: 'long', magnitude: mag, strength };
        if (!best || candidate.strength > best.strength) best = candidate;
      } else if (flushPct > 0 && last < wick && last >= base * 0.994) {
        const candidate = { side: 'short', magnitude: mag, strength };
        if (!best || candidate.strength > best.strength) best = candidate;
      }
    }
    return best;
  }

  _takeProfitPctForSignal(signal) {
    const min = 0.10;
    const max = 0.20;
    const mag = Number(signal && signal.magnitude) || 0;
    const scale = Math.max(0, Math.min(1, mag / 0.035));
    return min + (max - min) * scale;
  }

  // ─────────────────────────────────────────────────────────
  // Exit rule — TP / SL / time stop
  // ─────────────────────────────────────────────────────────
  _maybeClose(pos, px, ts) {
    let reason = null;
    const sideMul = pos.side === 'short' ? -1 : 1;
    pos.slPct = 0.03;
    pos.sl = pos.entryPrice * (1 - sideMul * 0.03);
    pos.tpPct = Math.max(0.10, Math.min(0.20, Number(pos.tpPct) || this.cfg.takeProfitPctMin));
    pos.tp = pos.entryPrice * (1 + sideMul * pos.tpPct);

    if (pos.side === 'short') {
      if (px <= pos.tp) reason = 'tp';
      else if (px >= pos.sl) reason = 'sl';
    } else if (px >= pos.tp) reason = 'tp';
    else if (px <= pos.sl) reason = 'sl';
    else if (ts - pos.openedAt >= this.cfg.maxHoldMs) reason = 'time';
    if (!reason) return;

    const effectiveExit = reason === 'sl' ? pos.sl : px;
    const pnlPct = sideMul * ((effectiveExit - pos.entryPrice) / pos.entryPrice) * 100;
    const pnl = (pnlPct / 100) * pos.notional;
    this.balance += pnl;
    this.realizedPnl += pnl;

    const win = pnl > 0;
    if (win) this.wins++; else this.losses++;
    this._adjustCaution(win);

    const closed = {
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: effectiveExit,
      qty: pos.qty,
      notional: pos.notional,
      pnl,
      pnlPct,
      reason,
      openedAt: pos.openedAt,
      closedAt: ts,
      holdMs: ts - pos.openedAt,
      cautionAtClose: this.cautionMultiplier,
    };
    this.ledger.unshift(closed);
    if (this.ledger.length > this.cfg.ledgerCap) this.ledger.length = this.cfg.ledgerCap;

    this.openPositions.delete(pos.symbol);
    this._cooldown.set(pos.symbol, ts + this.cfg.cooldownMs);

    console.log(
      `[PAPERBOT] CLOSE ${pos.symbol} ${reason.toUpperCase()} ` +
      `@ ${effectiveExit.toFixed(6)} pnl=$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) ` +
      `bal=$${this.balance.toFixed(2)} W/L=${this.wins}/${this.losses} ` +
      `caution=${this.cautionMultiplier.toFixed(2)}`,
    );

    this._broadcastState();
  }

  // ─────────────────────────────────────────────────────────
  // Learning loop — tighten on loss, relax on win, clamped.
  // ─────────────────────────────────────────────────────────
  _adjustCaution(win) {
    const next = win
      ? this.cautionMultiplier * this.cfg.cautionOnWin
      : this.cautionMultiplier * this.cfg.cautionOnLoss;
    this.cautionMultiplier = Math.max(
      this.cfg.cautionMin,
      Math.min(this.cfg.cautionMax, next),
    );
  }

  // ─────────────────────────────────────────────────────────
  // State + broadcast
  // ─────────────────────────────────────────────────────────
  _unrealizedPnl() {
    let u = 0;
    for (const p of this.openPositions.values()) {
      const px = this._lastPrice.get(p.symbol) || p.lastPrice || p.entryPrice;
      const sideMul = p.side === 'short' ? -1 : 1;
      u += sideMul * ((px - p.entryPrice) / p.entryPrice) * p.notional;
    }
    return u;
  }

  getState() {
    const unrealized = this._unrealizedPnl();
    const equity = this.balance + unrealized;
    const totalClosed = this.wins + this.losses;
    const winRate = totalClosed > 0 ? (this.wins / totalClosed) * 100 : 0;
    const pnl = equity - this.cfg.startingBalance;
    const pnlPct = (pnl / this.cfg.startingBalance) * 100;

    const openPositions = [];
    for (const p of this.openPositions.values()) {
      const px = this._lastPrice.get(p.symbol) || p.lastPrice || p.entryPrice;
      const sideMul = p.side === 'short' ? -1 : 1;
      const currentPnlPct = p.entryPrice > 0 ? sideMul * ((px - p.entryPrice) / p.entryPrice) * 100 : 0;
      const currentPnl = (currentPnlPct / 100) * p.notional;
      openPositions.push({
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        currentPrice: px,
        markPrice: px,
        qty: p.qty,
        notional: p.notional,
        tp: p.tp,
        sl: p.sl,
        tpPrice: p.tp,
        slPrice: p.sl,
        tpPct: p.tpPct,
        slPct: 0.03,
        pnl: currentPnl,
        pnlPct: currentPnlPct,
        currentPnl,
        currentPnlPct,
        reason: p.reason,
        openedAt: p.openedAt,
        ageMs: Date.now() - p.openedAt,
      });
    }

    return {
      t: 'pb',
      status: this.status,
      startedAt: this.startedAt,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      startingBalance: this.cfg.startingBalance,
      balance: this.balance,
      equity,
      pnl,
      pnlPct,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      wins: this.wins,
      losses: this.losses,
      totalClosed,
      winRate,
      openCount: this.openPositions.size,
      cautionMultiplier: this.cautionMultiplier,
      openPositions,
      recentTrades: this.ledger.slice(0, this.cfg.recentTradesCap),
      ts: Date.now(),
    };
  }

  getLedger() {
    return this.ledger.slice();
  }

  _broadcastState() {
    try {
      this.emit('pb', this.getState());
    } catch (e) {
      console.warn('[PAPERBOT] broadcast failed:', e && e.message);
    }
  }
}
