import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import ccxt from 'ccxt';

const envBool = (key, fallback = false) => {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(raw));
};

const envNum = (key, fallback) => {
  const n = Number(process.env[key]);
  return Number.isFinite(n) ? n : fallback;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULTS = {
  liveExecution: envBool('PAPERBOT_LIVE', false),
  startingBalance: envNum('PAPERBOT_BANKROLL_USD', 10),
  maxBankrollUsd: envNum('PAPERBOT_MAX_BANKROLL_USD', 10),
  minOrderNotionalUsd: envNum('PAPERBOT_MIN_NOTIONAL_USD', 5.10),
  maxOrderNotionalUsd: envNum('PAPERBOT_MAX_ORDER_NOTIONAL_USD', 5.10),
  feePct: envNum('PAPERBOT_FEE_PCT', 0.001),
  takeProfitPctMin: 0.10,
  takeProfitPctMax: 0.20,
  stopLossPct: 0.03,
  maxHoldMs: 30 * 60 * 1000,
  cooldownMs: 20 * 60 * 1000,
  signalLockMs: 6 * 60 * 60 * 1000,
  minQuoteVolumeUsd: 1_000_000,
  maxOpenPositions: 1,
  ledgerCap: 200,
  recentTradesCap: 25,
  priceWindow: 64,
  volumeWindow: 20,
  atrWindow: 14,
  atrNormalWindow: 20,
  flushMinPct: 0.0035,
  volumeAnomalyRatio: 2.5,
  maxAtrExpansion: 3,
  maxSpreadPct: 0.005,
  maxConsecutiveStopLosses: 3,
  circuitPauseMs: 30 * 60 * 1000,
  broadcastIntervalMs: 2000,
  entryPostOnlyOffsetPct: 0.0005,
  entryFillTimeoutMs: 45_000,
  orderPollMs: 1500,
  http429PauseMs: 60_000,
  ollamaEnabled: envBool('PAPERBOT_OLLAMA', true),
  ollamaUrl: process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate',
  ollamaModel: process.env.OLLAMA_MODEL || 'llama3',
  ollamaTimeoutMs: envNum('OLLAMA_TIMEOUT_MS', 6000),
  advisoryCap: 80,
};

const CORRELATION_CLASS = {
  BTC: 'MAJOR_BTC_ETH',
  ETH: 'MAJOR_BTC_ETH',
  SOL: 'L1_BETA',
  AVAX: 'L1_BETA',
  NEAR: 'L1_BETA',
  SUI: 'L1_BETA',
  APT: 'L1_BETA',
  DOGE: 'MEME',
  SHIB: 'MEME',
  PEPE: 'MEME',
  WIF: 'MEME',
  BONK: 'MEME',
};

export class PaperBot extends EventEmitter {
  constructor({ aggregator, config = {} } = {}) {
    super();
    if (!aggregator) throw new Error('PaperBot: aggregator is required');
    this.setMaxListeners(64);

    this.aggregator = aggregator;
    this.cfg = { ...DEFAULTS, ...config };
    this.liveExecution = !!this.cfg.liveExecution;

    this.startedAt = 0;
    this.status = 'idle';
    this.pauseUntil = 0;
    this.balance = Math.min(this.cfg.startingBalance, this.cfg.maxBankrollUsd);
    this.realizedPnl = 0;
    this.wins = 0;
    this.losses = 0;
    this.consecutiveStopLosses = 0;
    this.cautionMultiplier = 1.0;
    this.exchange = null;
    this.exchangeReady = false;
    this.rateLimitedUntil = 0;
    this.emergencyActive = false;

    this.openPositions = new Map();
    this.ledger = [];
    this.advisoryLogs = [];

    this._priceBuf = new Map();
    this._cooldown = new Map();
    this._consumedSignals = new Map();
    this._inflightSignals = new Map();
    this._lastPrice = new Map();
    this._lastQuoteVolume = new Map();
    this._marketSymbolCache = new Map();
    this._lastOrderBookCheck = new Map();

    this._tickListener = (frame) => { void this._onTick(frame); };
    this._broadcastTimer = null;
  }

  start() {
    if (this.status === 'running') return;
    this.startedAt = Date.now();
    this.status = 'running';
    if (this.liveExecution) {
      void this._initExchange().catch((err) => {
        this.status = 'paused';
        this.pauseUntil = Date.now() + this.cfg.circuitPauseMs;
        this._advise('risk', 'Live exchange initialization failed; bot paused', { error: err.message });
        this._broadcastState();
      });
    }
    this.aggregator.on('tick', this._tickListener);
    this._broadcastTimer = setInterval(() => this._broadcastState(), this.cfg.broadcastIntervalMs);
    this._advise('system', 'Liquidation Flush Hunter online', {
      mode: this.liveExecution ? 'live_binance_spot' : 'paper',
      bankrollUsd: this.balance,
      minNotionalUsd: this.cfg.minOrderNotionalUsd,
      stopLossPct: this.cfg.stopLossPct,
    });
    this._broadcastState();
  }

  stop() {
    if (this.status !== 'running' && this.status !== 'paused') return;
    this.aggregator.off('tick', this._tickListener);
    if (this._broadcastTimer) clearInterval(this._broadcastTimer);
    this._broadcastTimer = null;
    this.status = 'stopped';
    this._broadcastState();
  }

  async _initExchange() {
    if (this.exchangeReady) return;
    const apiKey = process.env.BINANCE_API_KEY || '';
    const secret = process.env.BINANCE_API_SECRET || '';
    if (!apiKey || !secret) throw new Error('PaperBot live mode requires BINANCE_API_KEY and BINANCE_API_SECRET');
    this.exchange = new ccxt.binance({
      apiKey,
      secret,
      enableRateLimit: true,
      options: { defaultType: 'spot' },
    });
    await this.exchange.loadMarkets();
    this.exchangeReady = true;
  }

  async _onTick(frame) {
    if (!frame || frame.t !== 'tick') return;
    const sym = String(frame.s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const px = Number(frame.p);
    if (!sym || !Number.isFinite(px) || px <= 0) return;

    const now = Date.now();
    const quoteVolume = Number(frame.qv);
    const point = this._pushMarketPoint(sym, px, quoteVolume, now);
    this._lastPrice.set(sym, px);

    const pos = this.openPositions.get(sym);
    if (pos) {
      pos.lastPrice = px;
      await this._maybeClose(pos, px, now);
      return;
    }

    if (this.status !== 'running' || this.emergencyActive) return;
    if (this.pauseUntil > now) return;
    if (this.rateLimitedUntil > now) return;
    if (!this._isTradableMarket(sym, quoteVolume, now)) return;
    await this._maybeOpen(sym, px, point, now);
  }

  _pushMarketPoint(sym, price, quoteVolume, ts) {
    let buf = this._priceBuf.get(sym);
    if (!buf) {
      buf = [];
      this._priceBuf.set(sym, buf);
    }

    const prevQv = this._lastQuoteVolume.get(sym);
    const qv = Number.isFinite(quoteVolume) && quoteVolume > 0 ? quoteVolume : null;
    const volumeDelta = qv != null && Number.isFinite(prevQv) ? Math.max(0, qv - prevQv) : 0;
    if (qv != null) this._lastQuoteVolume.set(sym, qv);

    const prev = buf[buf.length - 1];
    const trPct = prev && prev.price > 0 ? Math.abs(price - prev.price) / prev.price : 0;
    const point = { price, ts, qv, volumeDelta, trPct };
    buf.push(point);
    if (buf.length > this.cfg.priceWindow) buf.shift();
    return point;
  }

  async _maybeOpen(sym, px, point, ts) {
    if (this.openPositions.size >= this.cfg.maxOpenPositions) return;
    if ((this._cooldown.get(sym) || 0) > ts) return;

    const buf = this._priceBuf.get(sym);
    if (!buf || buf.length < Math.max(24, this.cfg.volumeWindow + 2)) return;

    const signal = this._detectFlush(sym, buf, point);
    if (!signal) return;
    if (signal.side !== 'long') return this._reject(signal, 'spot_short_disabled');
    if (this._isSignalConsumed(signal.signalKey)) return;
    if (this._inflightSignals.has(signal.signalKey)) return;

    const correlation = this._correlationClass(sym);
    for (const p of this.openPositions.values()) {
      if (p.side === signal.side && p.correlationClass === correlation) {
        return this._reject(signal, `correlation_guard:${correlation}`);
      }
    }

    const micro = await this._preflightMicrostructure(sym, px);
    if (micro.block) return this._reject(signal, micro.reason, micro);

    const notional = this._sizedNotional(micro.minNotionalUsd);
    if (notional <= 0) return this._reject(signal, 'bankroll_or_min_notional_failed', { notional });

    this._consumeSignal(signal.signalKey);
    this._inflightSignals.set(signal.signalKey, ts + 60_000);
    try {
      await this._openPosition({ ...signal, symbol: sym, price: px, notional, correlationClass: correlation, micro }, ts);
    } finally {
      this._inflightSignals.delete(signal.signalKey);
    }
  }

  _detectFlush(sym, buf) {
    const n = Array.isArray(buf) ? buf.length : 0;
    if (n < Math.max(24, this.cfg.volumeWindow + 2)) return null;
    const last = this._bufPrice(buf[n - 1]);
    if (!(last > 0)) return null;

    const volumeSlice = buf.slice(Math.max(0, n - this.cfg.volumeWindow - 1), n - 1);
    const avgVol = this._avg(volumeSlice.map((p) => Number(p.volumeDelta) || 0).filter((v) => v > 0));
    const currentVol = Number(buf[n - 1].volumeDelta) || Number(buf[n - 2].volumeDelta) || 0;
    if (!(avgVol > 0) || currentVol < avgVol * this.cfg.volumeAnomalyRatio) {
      return this._softReject(sym, 'volume_anomaly_failed', { currentVol, avgVol });
    }

    const atrGuard = this._atrGuard(buf);
    if (atrGuard.block) return this._softReject(sym, atrGuard.reason, atrGuard);

    let maxStep = 0;
    for (let i = Math.max(1, n - 12); i < n; i++) {
      const a = this._bufPrice(buf[i - 1]);
      const b = this._bufPrice(buf[i]);
      if (a > 0 && b > 0) maxStep = Math.max(maxStep, Math.abs(b - a) / a);
    }

    const minFlush = Math.max(this.cfg.flushMinPct, Math.min(0.018, maxStep * 1.25));
    const lookbackStart = Math.max(1, n - 10);
    let best = null;

    for (let i = lookbackStart; i < n - 1; i++) {
      const base = this._bufPrice(buf[i - 1]);
      const wick = this._bufPrice(buf[i]);
      if (!(base > 0 && wick > 0)) continue;

      const flushPct = (wick - base) / base;
      const mag = Math.abs(flushPct);
      if (mag < minFlush) continue;

      const reactionPct = (last - wick) / wick;
      const retrace = Math.abs(last - wick) / Math.abs(wick - base);
      const stabilized = Math.abs(reactionPct) <= mag * 0.18;
      if (retrace < 0.08 && !stabilized) continue;

      const strength = 21 + mag * 300 + Math.min(8, retrace * 10) + Math.min(10, currentVol / Math.max(avgVol, 1));
      const required = 16 * Math.sqrt(Math.max(this.cfg.cautionMin || 0.75, this.cautionMultiplier));
      if (strength < required) continue;
      const wickTs = this._bufTs(buf[i], i);
      const baseTs = this._bufTs(buf[i - 1], i - 1);
      const signalRoot = [sym, wickTs, baseTs, Math.round(wick * 1e8), Math.round(base * 1e8)].join(':');
      const meta = { magnitude: mag, strength, volumeRatio: currentVol / avgVol, atrRatio: atrGuard.ratio };

      if (flushPct < 0 && last > wick && last <= base * 1.006) {
        const candidate = { side: 'long', signalKey: signalRoot + ':long', ...meta };
        if (!best || candidate.strength > best.strength) best = candidate;
      } else if (flushPct > 0 && last < wick && last >= base * 0.994) {
        const candidate = { side: 'short', signalKey: signalRoot + ':short', ...meta };
        if (!best || candidate.strength > best.strength) best = candidate;
      }
    }
    return best;
  }

  _softReject(sym, reason, extra = {}) {
    const key = `${sym}:${reason}:${Math.floor(Date.now() / 60_000)}`;
    if (!this._isSignalConsumed(key)) {
      this._consumeSignal(key, Date.now(), 60_000);
      this._advise('reject', `Signal rejected: ${reason}`, { symbol: sym, reason, ...extra });
    }
    return null;
  }

  _atrGuard(buf) {
    const ranges = buf.map((p) => Number(p.trPct) || 0).filter((v) => v > 0);
    const current = this._avg(ranges.slice(-this.cfg.atrWindow));
    const normal = this._avg(ranges.slice(-(this.cfg.atrWindow + this.cfg.atrNormalWindow), -this.cfg.atrWindow));
    const ratio = normal > 0 ? current / normal : 1;
    return {
      block: normal > 0 && ratio > this.cfg.maxAtrExpansion,
      reason: 'atr_extreme_chop',
      currentAtrPct: current,
      normalAtrPct: normal,
      ratio,
    };
  }

  async _preflightMicrostructure(sym, px) {
    const cached = this._lastOrderBookCheck.get(sym);
    if (cached && Date.now() - cached.ts < 5000) return cached;
    let out = { block: false, spreadPct: 0, minNotionalUsd: this.cfg.minOrderNotionalUsd };
    if (!this.exchangeReady && this.liveExecution) await this._initExchange();
    if (!this.exchange) {
      this.exchange = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'spot' } });
      await this.exchange.loadMarkets();
    }
    try {
      const marketSymbol = await this._resolveMarketSymbol(sym);
      const market = this.exchange.markets[marketSymbol] || {};
      const minCost = Number(market?.limits?.cost?.min);
      const book = await this._safeExchangeCall(() => this.exchange.fetchOrderBook(marketSymbol, 5));
      const bid = Number(book?.bids?.[0]?.[0]) || 0;
      const ask = Number(book?.asks?.[0]?.[0]) || 0;
      const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : px;
      const spreadPct = bid > 0 && ask > bid ? (ask - bid) / mid : 0;
      out = {
        block: spreadPct > this.cfg.maxSpreadPct,
        reason: 'spread_guard',
        marketSymbol,
        bid,
        ask,
        spreadPct,
        minNotionalUsd: Math.max(this.cfg.minOrderNotionalUsd, Number.isFinite(minCost) ? minCost : 0),
      };
    } catch (err) {
      out = { block: true, reason: 'liquidity_preflight_failed', error: err.message, minNotionalUsd: this.cfg.minOrderNotionalUsd };
    }
    out.ts = Date.now();
    this._lastOrderBookCheck.set(sym, out);
    return out;
  }

  async _openPosition(signal, ts) {
    const sideMul = 1;
    const tpPct = this._takeProfitPctForSignal(signal);
    const grossTpPct = tpPct + this.cfg.feePct * 2;
    const slPct = this.cfg.stopLossPct;
    const entryPrice = signal.price;
    const notional = signal.notional;
    const qty = notional / entryPrice;
    const pos = {
      side: 'long',
      symbol: signal.symbol,
      marketSymbol: signal.micro.marketSymbol || `${signal.symbol}/USDT`,
      entryPrice,
      qty,
      notional,
      tp: entryPrice * (1 + sideMul * grossTpPct),
      sl: entryPrice * (1 - sideMul * slPct),
      tpPct,
      grossTpPct,
      slPct,
      signalKey: signal.signalKey,
      reason: 'liquidation_flush_long',
      openedAt: ts,
      lastPrice: entryPrice,
      correlationClass: signal.correlationClass,
      mode: this.liveExecution ? 'live' : 'paper',
      feesPct: this.cfg.feePct,
    };

    if (this.liveExecution) {
      const live = await this._executeLiveEntry(pos, signal);
      Object.assign(pos, live);
    }

    this.openPositions.set(pos.symbol, pos);
    this._advise('executed', `Executed deterministic LONG ${pos.symbol}`, {
      symbol: pos.symbol,
      mode: pos.mode,
      notional,
      exchangeRiskUsd: notional * slPct,
      sl: pos.sl,
      tp: pos.tp,
      signal,
    });
    this._broadcastState();
  }

  async _executeLiveEntry(pos) {
    await this._initExchange();
    const symbol = pos.marketSymbol;
    const entryLimit = pos.entryPrice * (1 - this.cfg.entryPostOnlyOffsetPct);
    const amount = this._amountToPrecision(symbol, pos.qty);
    const price = this._priceToPrecision(symbol, entryLimit);
    const clientOrderId = this._clientOrderId('lfh_entry', pos.signalKey);

    const entryOrder = await this._safeExchangeCall(() => this.exchange.createLimitBuyOrder(symbol, amount, price, {
      newClientOrderId: clientOrderId,
    }));

    const filled = await this._waitForFill(symbol, entryOrder.id, this.cfg.entryFillTimeoutMs);
    if (!filled.filled) {
      await this._safeExchangeCall(() => this.exchange.cancelOrder(entryOrder.id, symbol)).catch(() => {});
      throw new Error(`entry_not_filled:${symbol}`);
    }

    const filledQty = this._amountToPrecision(symbol, filled.amount || amount);
    const average = Number(filled.average) || pos.entryPrice;
    pos.entryPrice = average;
    pos.qty = Number(filledQty);
    pos.notional = pos.qty * average;
    pos.sl = average * (1 - this.cfg.stopLossPct);
    pos.tp = average * (1 + pos.grossTpPct);

    const stop = await this._safeExchangeCall(() => this.exchange.createOrder(
      symbol,
      'STOP_LOSS',
      'sell',
      this._amountToPrecision(symbol, pos.qty),
      undefined,
      {
        stopPrice: this._priceToPrecision(symbol, pos.sl),
        newClientOrderId: this._clientOrderId('lfh_stop', pos.signalKey),
      },
    ));

    let tpOrder = null;
    try {
      tpOrder = await this._safeExchangeCall(() => this.exchange.createLimitSellOrder(
        symbol,
        this._amountToPrecision(symbol, pos.qty),
        this._priceToPrecision(symbol, pos.tp),
        { newClientOrderId: this._clientOrderId('lfh_tp', pos.signalKey) },
      ));
    } catch (err) {
      this._advise('system', 'TP limit order not placed; deterministic TP monitor remains active', {
        symbol: pos.symbol,
        reason: err.message,
      });
    }

    return {
      entryOrderId: entryOrder.id,
      stopOrderId: stop.id,
      tpOrderId: tpOrder && tpOrder.id,
      entryClientOrderId: clientOrderId,
    };
  }

  async _waitForFill(symbol, orderId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const order = await this._safeExchangeCall(() => this.exchange.fetchOrder(orderId, symbol));
      const status = String(order?.status || '').toLowerCase();
      const filled = Number(order?.filled) || 0;
      if (status === 'closed' || filled > 0) {
        return { filled: true, amount: filled || Number(order?.amount), average: Number(order?.average) || Number(order?.price) };
      }
      if (status === 'canceled' || status === 'rejected' || status === 'expired') break;
      await sleep(this.cfg.orderPollMs);
    }
    return { filled: false };
  }

  async _maybeClose(pos, px, ts) {
    let reason = null;
    pos.tpPct = Math.max(this.cfg.takeProfitPctMin, Math.min(this.cfg.takeProfitPctMax, Number(pos.tpPct) || this.cfg.takeProfitPctMin));
    pos.grossTpPct = pos.tpPct + this.cfg.feePct * 2;
    pos.slPct = this.cfg.stopLossPct;
    pos.tp = pos.entryPrice * (1 + pos.grossTpPct);
    pos.sl = pos.entryPrice * (1 - pos.slPct);

    if (px >= pos.tp) reason = 'tp';
    else if (px <= pos.sl) reason = 'sl';
    else if (ts - pos.openedAt >= this.cfg.maxHoldMs) reason = 'time';
    if (!reason) return;

    if (this.liveExecution) {
      if (reason === 'tp' && pos.tpOrderId) {
        await this._maybeFinalizeLiveOrder(pos, pos.tpOrderId, 'tp', ts);
      } else if (reason === 'sl' && pos.stopOrderId) {
        await this._maybeFinalizeLiveOrder(pos, pos.stopOrderId, 'sl', ts);
      } else {
        await this._closeLivePosition(pos, reason, ts);
      }
    } else {
      await this._finalizeClose(pos, reason === 'sl' ? pos.sl : px, reason, ts);
    }
  }

  async _maybeFinalizeLiveOrder(pos, orderId, reason, ts) {
    await this._initExchange();
    const order = await this._safeExchangeCall(() => this.exchange.fetchOrder(orderId, pos.marketSymbol));
    const status = String(order?.status || '').toLowerCase();
    const filled = Number(order?.filled) || 0;
    if (status !== 'closed' && filled < Number(pos.qty) * 0.99) return;

    if (reason === 'tp' && pos.stopOrderId) {
      await this._safeExchangeCall(() => this.exchange.cancelOrder(pos.stopOrderId, pos.marketSymbol)).catch(() => {});
    }
    if (reason === 'sl' && pos.tpOrderId) {
      await this._safeExchangeCall(() => this.exchange.cancelOrder(pos.tpOrderId, pos.marketSymbol)).catch(() => {});
    }

    const exit = Number(order?.average) || Number(order?.price) || (reason === 'sl' ? pos.sl : pos.tp);
    await this._finalizeClose(pos, exit, reason, ts, { orderId });
  }

  async _closeLivePosition(pos, reason, ts) {
    await this._initExchange();
    const symbol = pos.marketSymbol;
    if (pos.tpOrderId) await this._safeExchangeCall(() => this.exchange.cancelOrder(pos.tpOrderId, symbol)).catch(() => {});
    if (reason !== 'sl' && pos.stopOrderId) await this._safeExchangeCall(() => this.exchange.cancelOrder(pos.stopOrderId, symbol)).catch(() => {});
    const order = await this._safeExchangeCall(() => this.exchange.createMarketSellOrder(
      symbol,
      this._amountToPrecision(symbol, pos.qty),
      { newClientOrderId: this._clientOrderId(`lfh_exit_${reason}`, pos.signalKey) },
    ));
    const exit = Number(order?.average) || Number(order?.price) || pos.lastPrice || pos.entryPrice;
    await this._finalizeClose(pos, exit, reason, ts, { orderId: order?.id });
  }

  async _finalizeClose(pos, exitPrice, reason, ts, extra = {}) {
    const pnlPctGross = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;
    const grossPnl = (pnlPctGross / 100) * pos.notional;
    const fees = pos.notional * this.cfg.feePct * 2;
    const pnl = grossPnl - fees;

    this.balance = Math.min(this.cfg.maxBankrollUsd, this.balance + pnl);
    this.realizedPnl += pnl;
    const win = pnl > 0;
    if (win) {
      this.wins++;
      this.consecutiveStopLosses = 0;
    } else {
      this.losses++;
      if (reason === 'sl') this.consecutiveStopLosses++;
    }
    this._adjustCaution(win);

    const closed = {
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      qty: pos.qty,
      notional: pos.notional,
      pnl,
      pnlPct: pnlPctGross,
      fees,
      reason,
      openedAt: pos.openedAt,
      closedAt: ts,
      holdMs: ts - pos.openedAt,
      signalKey: pos.signalKey,
      mode: pos.mode,
      ...extra,
    };
    this.ledger.unshift(closed);
    if (this.ledger.length > this.cfg.ledgerCap) this.ledger.length = this.cfg.ledgerCap;

    this.openPositions.delete(pos.symbol);
    this._cooldown.set(pos.symbol, Date.now() + this.cfg.cooldownMs);
    this._consumeSignal(pos.signalKey);
    this._priceBuf.set(pos.symbol, []);

    if (this.consecutiveStopLosses >= this.cfg.maxConsecutiveStopLosses) {
      this.pauseUntil = Date.now() + this.cfg.circuitPauseMs;
      this.status = 'paused';
      this._advise('risk', 'Circuit breaker: 3 consecutive stop-losses; bot paused 30 minutes', {
        pauseUntil: this.pauseUntil,
      });
    }

    this._advise('closed', `Closed ${pos.symbol} ${reason.toUpperCase()}`, closed);
    this._broadcastState();
  }

  async emergencyCloseAll({ source = 'unknown' } = {}) {
    this.emergencyActive = true;
    this.status = 'emergency';
    const now = Date.now();
    const report = { source, ts: now, cancelled: [], closed: [], errors: [] };

    for (const pos of [...this.openPositions.values()]) {
      try {
        if (this.liveExecution) {
          await this._initExchange();
          if (pos.tpOrderId) {
            await this._safeExchangeCall(() => this.exchange.cancelOrder(pos.tpOrderId, pos.marketSymbol)).catch((e) => report.errors.push(e.message));
            report.cancelled.push(pos.tpOrderId);
          }
          if (pos.stopOrderId) {
            await this._safeExchangeCall(() => this.exchange.cancelOrder(pos.stopOrderId, pos.marketSymbol)).catch((e) => report.errors.push(e.message));
            report.cancelled.push(pos.stopOrderId);
          }
          const order = await this._safeExchangeCall(() => this.exchange.createMarketSellOrder(
            pos.marketSymbol,
            this._amountToPrecision(pos.marketSymbol, pos.qty),
            { newClientOrderId: this._clientOrderId('lfh_emergency', `${pos.signalKey}:${now}`) },
          ));
          const exit = Number(order?.average) || Number(order?.price) || pos.lastPrice || pos.entryPrice;
          await this._finalizeClose(pos, exit, 'emergency', now, { emergencySource: source, orderId: order?.id });
          report.closed.push(pos.symbol);
        } else {
          const exit = this._lastPrice.get(pos.symbol) || pos.lastPrice || pos.entryPrice;
          await this._finalizeClose(pos, exit, 'emergency', now, { emergencySource: source });
          report.closed.push(pos.symbol);
        }
      } catch (err) {
        report.errors.push(`${pos.symbol}:${err.message}`);
      }
    }

    this.status = 'paused';
    this.pauseUntil = Date.now() + this.cfg.circuitPauseMs;
    this._advise('risk', 'EMERGENCY_CLOSE_ALL completed', report);
    this._broadcastState();
    return { ...report, flat: this.openPositions.size === 0 };
  }

  _sizedNotional(minNotionalUsd) {
    const min = Math.max(this.cfg.minOrderNotionalUsd, Number(minNotionalUsd) || 0);
    const max = Math.min(this.cfg.maxOrderNotionalUsd, this.cfg.maxBankrollUsd, this.balance);
    if (max < min) return 0;
    return Math.min(max, Math.max(min, this.cfg.minOrderNotionalUsd));
  }

  _takeProfitPctForSignal(signal) {
    const mag = Number(signal?.magnitude) || 0;
    const scale = Math.max(0, Math.min(1, mag / 0.035));
    return this.cfg.takeProfitPctMin + (this.cfg.takeProfitPctMax - this.cfg.takeProfitPctMin) * scale;
  }

  async _resolveMarketSymbol(base) {
    const key = String(base || '').toUpperCase();
    if (this._marketSymbolCache.has(key)) return this._marketSymbolCache.get(key);
    if (!this.exchange) {
      this.exchange = new ccxt.binance({ enableRateLimit: true, options: { defaultType: 'spot' } });
      await this.exchange.loadMarkets();
    }
    const candidates = [`${key}/USDT`, `${key}/USDC`, `${key}/FDUSD`];
    const found = candidates.find((s) => this.exchange.markets[s]?.active);
    if (!found) throw new Error(`spot_market_not_found:${key}`);
    this._marketSymbolCache.set(key, found);
    return found;
  }

  async _safeExchangeCall(fn) {
    try {
      return await fn();
    } catch (err) {
      const code = Number(err?.status || err?.code);
      const msg = String(err?.message || '');
      const rateLimitClass = ccxt.RateLimitExceeded;
      const ddosClass = ccxt.DDoSProtection;
      const isRateLimited = code === 429
        || /429|rate limit|Too Many Requests/i.test(msg)
        || (typeof rateLimitClass === 'function' && err instanceof rateLimitClass)
        || (typeof ddosClass === 'function' && err instanceof ddosClass);
      if (isRateLimited) {
        this.rateLimitedUntil = Date.now() + this.cfg.http429PauseMs;
        this._advise('risk', 'HTTP 429/rate-limit guard: trading paused temporarily', {
          rateLimitedUntil: this.rateLimitedUntil,
          message: msg,
        });
      }
      throw err;
    }
  }

  _amountToPrecision(symbol, amount) {
    return Number(this.exchange.amountToPrecision(symbol, amount));
  }

  _priceToPrecision(symbol, price) {
    return Number(this.exchange.priceToPrecision(symbol, price));
  }

  _clientOrderId(prefix, key) {
    const digest = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 18);
    return `${prefix}_${digest}`.slice(0, 32);
  }

  _reject(signal, reason, extra = {}) {
    this._consumeSignal(signal.signalKey);
    this._advise('reject', `Signal rejected: ${reason}`, { signal, reason, ...extra });
  }

  _advise(type, message, context = {}) {
    const evt = {
      id: `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      ts: Date.now(),
      type,
      message,
      context: this._compactContext(context),
    };
    this.advisoryLogs.unshift(evt);
    if (this.advisoryLogs.length > this.cfg.advisoryCap) this.advisoryLogs.length = this.cfg.advisoryCap;
    void this._ollamaExplain(evt);
  }

  async _ollamaExplain(evt) {
    if (!this.cfg.ollamaEnabled) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.ollamaTimeoutMs);
    try {
      const prompt = JSON.stringify({
        role: 'quant_analyst',
        rule: 'Explain only. Never recommend or place trades.',
        event: evt,
        state: this._compactContext(this.getState()),
      });
      const res = await fetch(this.cfg.ollamaUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.cfg.ollamaModel,
          prompt,
          stream: false,
          options: { temperature: 0.2, num_predict: 80 },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      const text = String(data?.response || '').trim().replace(/\s+/g, ' ').slice(0, 600);
      if (text) evt.analysis = text;
      this._broadcastState();
    } catch {
      // Ollama is advisory only; execution never depends on it.
    } finally {
      clearTimeout(timer);
    }
  }

  _compactContext(obj) {
    try {
      return JSON.parse(JSON.stringify(obj, (_k, v) => {
        if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 1e8) / 1e8 : null;
        if (typeof v === 'string') return v.slice(0, 300);
        return v;
      }));
    } catch {
      return {};
    }
  }

  _isTradableMarket(sym, quoteVolumeUsd, now = Date.now()) {
    if (!sym || this._isToxicSymbol(sym)) return false;
    if ((this._cooldown.get(sym) || 0) > now) return false;
    if (!Number.isFinite(quoteVolumeUsd) || quoteVolumeUsd < this.cfg.minQuoteVolumeUsd) return false;
    return true;
  }

  _isToxicSymbol(sym) {
    const s = String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!s) return true;
    const blocked = new Set([
      'USDT','USDC','BUSD','FDUSD','TUSD','USDP','USDD','DAI','FRAX','LUSD','PYUSD','USDE','SUSDE','USD1','USTC',
      'EUR','EURC','EURS','EURI','EURT','AEUR','SEUR','JPY','JPYC','GYEN','GBP','GBPT','CHF','AUD','CAD','BRL',
      'REUSD','USDR','USDX','USDL','USDM','USDS','USDJ','XAUT',
    ]);
    if (blocked.has(s)) return true;
    return /(?:USD|USDT|USDC|DAI|EUR|JPY|GBP|CHF|AUD|CAD)$/.test(s);
  }

  _correlationClass(sym) {
    const s = String(sym || '').toUpperCase();
    return CORRELATION_CLASS[s] || `SINGLE_${s}`;
  }

  _isSignalConsumed(signalKey, now = Date.now()) {
    if (!signalKey) return true;
    this._pruneConsumedSignals(now);
    return (this._consumedSignals.get(signalKey) || 0) > now;
  }

  _consumeSignal(signalKey, now = Date.now(), ttl = this.cfg.signalLockMs) {
    if (!signalKey) return;
    this._consumedSignals.set(signalKey, now + ttl);
  }

  _pruneConsumedSignals(now = Date.now()) {
    for (const [key, until] of this._consumedSignals.entries()) {
      if (until <= now) this._consumedSignals.delete(key);
    }
    for (const [key, until] of this._inflightSignals.entries()) {
      if (until <= now) this._inflightSignals.delete(key);
    }
  }

  _adjustCaution(win) {
    const next = win ? this.cautionMultiplier * 0.93 : this.cautionMultiplier * 1.18;
    this.cautionMultiplier = Math.max(0.5, Math.min(4, next));
  }

  _unrealizedPnl() {
    let u = 0;
    for (const p of this.openPositions.values()) {
      const px = this._lastPrice.get(p.symbol) || p.lastPrice || p.entryPrice;
      u += ((px - p.entryPrice) / p.entryPrice) * p.notional;
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
      const currentPnlPct = p.entryPrice > 0 ? ((px - p.entryPrice) / p.entryPrice) * 100 : 0;
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
        slPct: p.slPct,
        pnl: currentPnl,
        pnlPct: currentPnlPct,
        currentPnl,
        currentPnlPct,
        reason: p.reason,
        openedAt: p.openedAt,
        ageMs: Date.now() - p.openedAt,
        mode: p.mode,
        stopOrderId: p.stopOrderId,
      });
    }

    return {
      t: 'pb',
      mode: this.liveExecution ? 'live_binance_spot' : 'paper',
      status: this.pauseUntil > Date.now() && this.status === 'paused' ? 'paused' : this.status,
      pauseUntil: this.pauseUntil,
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
      consecutiveStopLosses: this.consecutiveStopLosses,
      totalClosed,
      winRate,
      openCount: this.openPositions.size,
      cautionMultiplier: this.cautionMultiplier,
      risk: {
        minOrderNotionalUsd: this.cfg.minOrderNotionalUsd,
        stopLossPct: this.cfg.stopLossPct,
        maxExchangeRiskUsd: this.cfg.minOrderNotionalUsd * this.cfg.stopLossPct,
        feePct: this.cfg.feePct,
      },
      openPositions,
      recentTrades: this.ledger.slice(0, this.cfg.recentTradesCap),
      advisoryLogs: this.advisoryLogs.slice(0, 30),
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

  _bufPrice(point) {
    return Number(point && typeof point === 'object' ? point.price : point);
  }

  _bufTs(point, fallback) {
    const ts = Number(point && typeof point === 'object' ? point.ts : 0);
    return Number.isFinite(ts) && ts > 0 ? ts : fallback;
  }

  _avg(arr) {
    if (!Array.isArray(arr) || !arr.length) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }
}
