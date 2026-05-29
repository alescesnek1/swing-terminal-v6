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
  takeProfitPct: 0.018,
  stopLossPct: 0.009,
  maxHoldMs: 30 * 60 * 1000,
  cooldownMs: 5 * 60 * 1000,
  maxOpenPositions: 6,
  ledgerCap: 200,
  recentTradesCap: 25,
  // Momentum window: last N ticks held per symbol. Breakout fires
  // when the latest price clears the rolling max by `entryEdgePct *
  // cautionMultiplier`. A tight window keeps the bot reactive on
  // 50ms tick cadence without needing kline buffers.
  priceWindow: 60,
  entryEdgePct: 0.0025,
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
      `TP ${(this.cfg.takeProfitPct * 100).toFixed(2)}% / ` +
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
    if (!buf || buf.length < this.cfg.priceWindow) return;

    // Exclude the latest tick from the reference window so the
    // breakout test is `current > prior_high`, not `current > current`.
    let priorHigh = -Infinity;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i] > priorHigh) priorHigh = buf[i];
    }
    if (!Number.isFinite(priorHigh) || priorHigh <= 0) return;

    const edge = this.cfg.entryEdgePct * this.cautionMultiplier;
    const threshold = priorHigh * (1 + edge);
    if (px <= threshold) return;

    const notional = Math.min(this.cfg.riskPerTradeUsd / this.cfg.stopLossPct, this.balance * 0.5);
    if (notional <= 0) return;
    const qty = notional / px;

    const pos = {
      side: 'long',
      symbol: sym,
      entryPrice: px,
      qty,
      notional,
      tp: px * (1 + this.cfg.takeProfitPct),
      sl: px * (1 - this.cfg.stopLossPct),
      openedAt: ts,
      lastPrice: px,
    };
    this.openPositions.set(sym, pos);

    console.log(
      `[PAPERBOT] OPEN ${sym} @ ${px.toFixed(6)} ` +
      `qty=${qty.toFixed(4)} tp=${pos.tp.toFixed(6)} sl=${pos.sl.toFixed(6)} ` +
      `caution=${this.cautionMultiplier.toFixed(2)}`,
    );
    this._broadcastState();
  }

  // ─────────────────────────────────────────────────────────
  // Exit rule — TP / SL / time stop
  // ─────────────────────────────────────────────────────────
  _maybeClose(pos, px, ts) {
    let reason = null;
    if (px >= pos.tp) reason = 'tp';
    else if (px <= pos.sl) reason = 'sl';
    else if (ts - pos.openedAt >= this.cfg.maxHoldMs) reason = 'time';
    if (!reason) return;

    const pnl = (px - pos.entryPrice) * pos.qty;
    const pnlPct = (px / pos.entryPrice - 1) * 100;
    this.balance += pnl;
    this.realizedPnl += pnl;

    const win = pnl > 0;
    if (win) this.wins++; else this.losses++;
    this._adjustCaution(win);

    const closed = {
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice: px,
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
      `@ ${px.toFixed(6)} pnl=$${pnl.toFixed(2)} (${pnlPct.toFixed(2)}%) ` +
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
      u += (px - p.entryPrice) * p.qty;
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
      openPositions.push({
        symbol: p.symbol,
        side: p.side,
        entryPrice: p.entryPrice,
        markPrice: px,
        qty: p.qty,
        notional: p.notional,
        tp: p.tp,
        sl: p.sl,
        pnl: (px - p.entryPrice) * p.qty,
        pnlPct: (px / p.entryPrice - 1) * 100,
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
