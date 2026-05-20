// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Data Aggregator
// Receives raw WebSocket ticks, computes rolling metrics,
// and writes aggregated snapshots to Redis.
// ─────────────────────────────────────────────────────────────

import {
  REDIS_KEYS,
  TTL,
  AGGREGATION_INTERVAL_MS,
  redisKey,
} from '../../shared/constants.js';

import { getRedis, redisMset } from '../../shared/redis-client.js';

/**
 * @typedef {object} TickBucket
 * @property {number} openPrice
 * @property {number} highPrice
 * @property {number} lowPrice
 * @property {number} closePrice
 * @property {number} volume
 * @property {number} takerBuyVolume
 * @property {number} takerSellVolume
 * @property {number} tradeCount
 * @property {number} startTime
 */

export class Aggregator {
  constructor() {
    /** @type {Map<string, TickBucket>} current bucket per symbol */
    this._buckets = new Map();

    /** @type {Map<string, object>} previous snapshot per symbol (for delta calc) */
    this._prevSnapshots = new Map();

    /** Flush interval handle */
    this._flushInterval = null;
  }

  /**
   * Start the periodic flush loop.
   */
  start() {
    if (this._flushInterval) return;

    this._flushInterval = setInterval(
      () => this._flushAll(),
      AGGREGATION_INTERVAL_MS
    );

    console.log(`[AGGREGATOR] Started (${AGGREGATION_INTERVAL_MS}ms buckets)`);
  }

  /**
   * Stop the flush loop.
   */
  stop() {
    if (this._flushInterval) {
      clearInterval(this._flushInterval);
      this._flushInterval = null;
      console.log('[AGGREGATOR] Stopped');
    }
  }

  // ─────────────────────────────────────────────────────────
  // Ingest methods — called by feed handlers
  // ─────────────────────────────────────────────────────────

  /**
   * Process a ticker update.
   *
   * @param {string} symbol  ccxt symbol (e.g. "BTC/USDC:USDC")
   * @param {object} ticker  ccxt ticker object
   */
  onTicker(symbol, ticker) {
    const bucket = this._getOrCreateBucket(symbol);

    bucket.closePrice = ticker.last !== undefined ? ticker.last : (ticker.close !== undefined ? ticker.close : bucket.closePrice);
    if (ticker.high && ticker.high > bucket.highPrice) bucket.highPrice = ticker.high;
    if (ticker.low && (bucket.lowPrice === 0 || ticker.low < bucket.lowPrice)) {
      bucket.lowPrice = ticker.low;
    }
    bucket.volume = ticker.baseVolume !== undefined ? ticker.baseVolume : bucket.volume;
    if (ticker.percentage !== undefined) bucket.percentage = ticker.percentage;
    if (ticker.quoteVolume !== undefined) bucket.quoteVolume = ticker.quoteVolume;
  }

  /**
   * Process a trade update (for taker flow calculation).
   *
   * @param {string} symbol  ccxt symbol
   * @param {object} trade   ccxt trade object
   */
  onTrade(symbol, trade) {
    const bucket = this._getOrCreateBucket(symbol);
    const vol = trade.amount * (trade.price || 0);

    bucket.tradeCount++;
    if (trade.side === 'buy') {
      bucket.takerBuyVolume += vol;
    } else {
      bucket.takerSellVolume += vol;
    }
  }

  /**
   * Process a funding rate update.
   *
   * @param {string} symbol       ccxt symbol
   * @param {object} fundingRate  ccxt funding rate object
   */
  onFundingRate(symbol, fundingRate) {
    const bucket = this._getOrCreateBucket(symbol);
    bucket.fundingRate = fundingRate.fundingRate;
    bucket.fundingTimestamp = fundingRate.fundingDatetime || new Date().toISOString();
    bucket.nextFundingTimestamp = fundingRate.fundingDatetime || null;
  }

  /**
   * Process an open interest update.
   *
   * @param {string} symbol
   * @param {object} oi  { openInterest: number, ... }
   */
  onOpenInterest(symbol, oi) {
    const bucket = this._getOrCreateBucket(symbol);
    bucket.openInterest = oi.openInterestValue || oi.openInterest || 0;
  }

  /**
   * Get the latest snapshot for a symbol (used by trigger engine).
   *
   * @param {string} symbol
   * @returns {object|null}
   */
  getSnapshot(symbol) {
    return this._prevSnapshots.get(symbol) || null;
  }

  /**
   * Get the previous snapshot for delta calculations.
   *
   * @param {string} symbol
   * @returns {object|null}
   */
  getPreviousSnapshot(symbol) {
    return this._prevSnapshots.get(symbol) || null;
  }

  // ─────────────────────────────────────────────────────────
  // Internal methods
  // ─────────────────────────────────────────────────────────

  /**
   * Get or create a bucket for a symbol.
   * @param {string} symbol
   * @returns {TickBucket}
   */
  _getOrCreateBucket(symbol) {
    if (!this._buckets.has(symbol)) {
      this._buckets.set(symbol, {
        openPrice: 0,
        highPrice: 0,
        lowPrice: 0,
        closePrice: 0,
        volume: 0,
        quoteVolume: 0,
        percentage: 0,
        takerBuyVolume: 0,
        takerSellVolume: 0,
        tradeCount: 0,
        fundingRate: null,
        fundingTimestamp: null,
        nextFundingTimestamp: null,
        openInterest: 0,
        startTime: Date.now(),
      });
    }
    return this._buckets.get(symbol);
  }

  /**
   * Flush all accumulated buckets in a SINGLE Redis pipeline (one
   * network round-trip). Each valid symbol contributes exactly ONE
   * command (SET snap:<sym> JSON PX ttl), so a full flush of 150
   * symbols = 150 Upstash commands — not 450+ as before.
   *
   * The md:<sym> hash was dropped; nothing in the codebase reads it.
   */
  async _flushAll() {
    /** @type {Array<{symbol:string, snapshot:object, derived:object}>} */
    const batch = [];
    const now = Date.now();

    for (const [symbol, bucket] of this._buckets.entries()) {
      // Never flush an empty price bucket — a 0 close would surface in the
      // edge response as current_price: 0 and look like a live market.
      if (!Number.isFinite(bucket.closePrice) || bucket.closePrice <= 0) continue;

      const prev = this._prevSnapshots.get(symbol);

      const totalTakerVol = bucket.takerBuyVolume + bucket.takerSellVolume;
      const takerBuyRatio = totalTakerVol > 0
        ? bucket.takerBuyVolume / totalTakerVol
        : 0.5;

      let oiChangePct = 0;
      if (prev && prev.openInterest > 0 && bucket.openInterest > 0) {
        oiChangePct = (bucket.openInterest - prev.openInterest) / prev.openInterest;
      }

      let fundingRateDelta = 0;
      if (prev && prev.fundingRate !== null && bucket.fundingRate !== null) {
        const prevFR = Math.abs(prev.fundingRate);
        if (prevFR > 0) {
          fundingRateDelta = (bucket.fundingRate - prev.fundingRate) / prevFR;
        }
      }

      const snapshot = {
        symbol,
        price: String(bucket.closePrice),
        high: String(bucket.highPrice),
        low: String(bucket.lowPrice),
        volume_24h: String(bucket.volume),
        quote_volume_24h: String(bucket.quoteVolume),
        percentage: String(bucket.percentage),
        funding_rate: bucket.fundingRate !== null ? String(bucket.fundingRate) : '0',
        funding_rate_delta: String(fundingRateDelta),
        funding_ts: bucket.fundingTimestamp || '',
        open_interest: String(bucket.openInterest),
        oi_change_pct: String(oiChangePct),
        taker_buy_vol: String(bucket.takerBuyVolume),
        taker_sell_vol: String(bucket.takerSellVolume),
        taker_buy_ratio: String(takerBuyRatio),
        trade_count: String(bucket.tradeCount),
        ts: String(now),
      };

      batch.push({
        symbol,
        snapshot,
        derived: {
          price: bucket.closePrice,
          fundingRate: bucket.fundingRate,
          openInterest: bucket.openInterest,
          takerBuyRatio,
          oiChangePct,
          ts: now,
        },
      });
    }

    // Reset buckets before awaiting I/O — new ticks shouldn't collide
    // with data we're about to ship.
    this._buckets.clear();

    if (batch.length === 0) return;

    try {
      const msetPayload = {};

      for (const { symbol, snapshot } of batch) {
        const snapKey = redisKey(REDIS_KEYS.SNAPSHOT, symbol);
        msetPayload[snapKey] = JSON.stringify(snapshot);
      }

      // Execute as a single MSET command to drastically save Upstash quota
      await redisMset(msetPayload);

      // Update in-memory deltas only after the write succeeds so a
      // failed flush doesn't zero out the delta baseline.
      for (const { symbol, derived } of batch) {
        this._prevSnapshots.set(symbol, derived);
      }

      console.log(`[AGGREGATOR] Flushed ${batch.length} snapshots in 1 MSET command`);
    } catch (err) {
      console.error('[AGGREGATOR] MSET flush failed:', err.message);
    }
  }
}
