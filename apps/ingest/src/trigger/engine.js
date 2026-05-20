// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Trigger Engine (AI Spam Filter)
// Evaluates rules on aggregated data to decide when a snapshot
// is worth sending to the AI for analysis.
// ─────────────────────────────────────────────────────────────

import {
  REDIS_KEYS,
  TTL,
  RULES,
  TRIGGER_THRESHOLDS,
  redisKey,
} from '../../../shared/constants.js';

import { getRedis, redisSet, redisGet } from '../../../shared/redis-client.js';

export class TriggerEngine {
  /**
   * @param {import('../aggregator.js').Aggregator} aggregator
   */
  constructor(aggregator) {
    this.aggregator = aggregator;

    /** @type {NodeJS.Timeout|null} */
    this._evalInterval = null;

    /** Evaluation frequency (check every aggregation cycle) */
    this._evalFreqMs = 5_000;

    /** Stats counters */
    this.stats = {
      evaluations: 0,
      triggers: 0,
      cooldowns: 0,
    };
  }

  /**
   * Start the periodic rule evaluation loop.
   */
  start() {
    if (this._evalInterval) return;

    this._evalInterval = setInterval(
      () => this._evaluateAll(),
      this._evalFreqMs
    );

    console.log('[TRIGGER] Engine started');
    console.log(`[TRIGGER]   rule_a7: Funding rate delta > ${TRIGGER_THRESHOLDS.FUNDING_RATE_DELTA_PCT * 100}%`);
    console.log(`[TRIGGER]   rule_b3: OI delta > ${TRIGGER_THRESHOLDS.OI_CHANGE_PCT * 100}% + Taker buy ratio > ${TRIGGER_THRESHOLDS.TAKER_BUY_RATIO}`);
    console.log(`[TRIGGER]   Cooldown: ${TTL.COOLDOWN_MS / 60_000}min per rule/symbol`);
  }

  /**
   * Stop the evaluation loop.
   */
  stop() {
    if (this._evalInterval) {
      clearInterval(this._evalInterval);
      this._evalInterval = null;
    }
    console.log(`[TRIGGER] Engine stopped. Stats: ${JSON.stringify(this.stats)}`);
  }

  /**
   * Get engine status for health endpoint.
   * @returns {object}
   */
  getStatus() {
    return { ...this.stats, running: !!this._evalInterval };
  }

  // ─────────────────────────────────────────────────────────
  // Rule Engine
  // ─────────────────────────────────────────────────────────

  /**
   * Evaluate all rules for all symbols with available snapshots.
   */
  async _evaluateAll() {
    // Get all symbols that have a previous snapshot
    const symbols = this._getTrackedSymbols();
    if (symbols.length === 0) return;

    for (const symbol of symbols) {
      try {
        await this._evaluateSymbol(symbol);
      } catch (err) {
        console.error(`[TRIGGER] Eval error ${symbol}:`, err.message);
      }
    }
  }

  /**
   * Get all symbols currently being tracked by the aggregator.
   * @returns {string[]}
   */
  _getTrackedSymbols() {
    // Access the aggregator's internal snapshot map
    const snapshots = this.aggregator._prevSnapshots;
    return snapshots ? [...snapshots.keys()] : [];
  }

  /**
   * Evaluate all rules for a single symbol.
   *
   * @param {string} symbol
   */
  async _evaluateSymbol(symbol) {
    const snapshot = this.aggregator.getSnapshot(symbol);
    if (!snapshot) return;

    this.stats.evaluations++;

    // ── Rule A7: Funding Rate Spike ──
    const ruleA7 = await this._ruleA7(symbol, snapshot);

    // ── Rule B3: OI Buildup + Taker Aggression ──
    const ruleB3 = await this._ruleB3(symbol, snapshot);

    // If any rule fired, create a trigger snapshot
    const firedRules = [];
    if (ruleA7) firedRules.push(RULES.FUNDING_SPIKE);
    if (ruleB3) firedRules.push(RULES.OI_TAKER_COMBO);

    if (firedRules.length > 0) {
      await this._createTriggerSnapshot(symbol, firedRules, snapshot);
    }
  }

  /**
   * Rule A7: Funding Rate Spike
   * Fires when the funding rate changes by more than 15% from previous reading.
   *
   * @param {string} symbol
   * @param {object} snapshot
   * @returns {Promise<boolean>}
   */
  async _ruleA7(symbol, snapshot) {
    if (snapshot.fundingRate === null || snapshot.fundingRate === undefined) return false;

    // Check cooldown
    const onCooldown = await this._isOnCooldown(RULES.FUNDING_SPIKE, symbol);
    if (onCooldown) return false;

    // Get live snapshot from aggregator (has delta already computed)
    // We use the Redis snapshot which has funding_rate_delta
    const mdKey = redisKey(REDIS_KEYS.MARKET_DATA, symbol);
    const redis = await getRedis();
    const frDelta = await redis.hget(mdKey, 'funding_rate_delta');

    if (frDelta === null || frDelta === undefined) return false;

    const deltaAbs = Math.abs(parseFloat(frDelta));

    if (deltaAbs > TRIGGER_THRESHOLDS.FUNDING_RATE_DELTA_PCT) {
      console.log(
        `[TRIGGER] 🔔 rule_a7 FIRED for ${symbol}: ` +
        `funding rate delta ${(deltaAbs * 100).toFixed(1)}% > ${TRIGGER_THRESHOLDS.FUNDING_RATE_DELTA_PCT * 100}%`
      );
      this.stats.triggers++;
      await this._setCooldown(RULES.FUNDING_SPIKE, symbol);
      return true;
    }

    return false;
  }

  /**
   * Rule B3: OI Buildup + Taker Aggressivity
   * Fires when OI increases by > 2% AND taker buy ratio > 0.65.
   *
   * @param {string} symbol
   * @param {object} snapshot
   * @returns {Promise<boolean>}
   */
  async _ruleB3(symbol, snapshot) {
    // Check cooldown
    const onCooldown = await this._isOnCooldown(RULES.OI_TAKER_COMBO, symbol);
    if (onCooldown) return false;

    // Read from Redis snapshot
    const mdKey = redisKey(REDIS_KEYS.MARKET_DATA, symbol);
    const redis = await getRedis();

    const [oiChangePct, takerBuyRatio] = await Promise.all([
      redis.hget(mdKey, 'oi_change_pct'),
      redis.hget(mdKey, 'taker_buy_ratio'),
    ]);

    if (oiChangePct === null || takerBuyRatio === null) return false;

    const oi = parseFloat(oiChangePct);
    const tbr = parseFloat(takerBuyRatio);

    const oiCondition = oi > TRIGGER_THRESHOLDS.OI_CHANGE_PCT;
    const takerCondition = tbr > TRIGGER_THRESHOLDS.TAKER_BUY_RATIO;

    if (oiCondition && takerCondition) {
      console.log(
        `[TRIGGER] 🔔 rule_b3 FIRED for ${symbol}: ` +
        `OI change ${(oi * 100).toFixed(2)}% > ${TRIGGER_THRESHOLDS.OI_CHANGE_PCT * 100}%, ` +
        `Taker buy ratio ${tbr.toFixed(3)} > ${TRIGGER_THRESHOLDS.TAKER_BUY_RATIO}`
      );
      this.stats.triggers++;
      await this._setCooldown(RULES.OI_TAKER_COMBO, symbol);
      return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────
  // Cooldown management
  // ─────────────────────────────────────────────────────────

  /**
   * Check if a rule is on cooldown for a specific symbol.
   *
   * @param {string} rule    rule identifier (e.g. 'a7')
   * @param {string} symbol
   * @returns {Promise<boolean>}
   */
  async _isOnCooldown(rule, symbol) {
    const key = redisKey(REDIS_KEYS.COOLDOWN, `${rule}:${symbol}`);
    const val = await redisGet(key);

    if (val) {
      this.stats.cooldowns++;
      return true;
    }
    return false;
  }

  /**
   * Set a cooldown for a rule/symbol pair.
   *
   * @param {string} rule
   * @param {string} symbol
   */
  async _setCooldown(rule, symbol) {
    const key = redisKey(REDIS_KEYS.COOLDOWN, `${rule}:${symbol}`);
    await redisSet(key, '1', TTL.COOLDOWN_MS);
  }

  // ─────────────────────────────────────────────────────────
  // Trigger snapshot creation
  // ─────────────────────────────────────────────────────────

  /**
   * Create a trigger snapshot in Redis for AI consumption.
   *
   * @param {string}   symbol
   * @param {string[]} firedRules  array of rule IDs that fired
   * @param {object}   snapshot    current aggregated data
   */
  async _createTriggerSnapshot(symbol, firedRules, snapshot) {
    const key = redisKey(REDIS_KEYS.TRIGGER_SNAPSHOT, symbol);

    // Read full market data from Redis for the snapshot
    const mdKey = redisKey(REDIS_KEYS.MARKET_DATA, symbol);
    const redis = await getRedis();
    const marketData = await redis.hgetall(mdKey);

    const triggerPayload = {
      symbol,
      triggered_by: firedRules,
      triggered_at: new Date().toISOString(),
      market_data: marketData || {},
      aggregator_snapshot: {
        price: snapshot.price,
        funding_rate: snapshot.fundingRate,
        open_interest: snapshot.openInterest,
        taker_buy_ratio: snapshot.takerBuyRatio,
      },
    };

    await redisSet(key, JSON.stringify(triggerPayload), TTL.TRIGGER_SNAPSHOT_MS);

    console.log(
      `[TRIGGER] 📸 Snapshot created for ${symbol} ` +
      `(rules: ${firedRules.join(', ')}) — TTL: ${TTL.TRIGGER_SNAPSHOT_MS / 60_000}min`
    );
  }
}
