// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Binance USDT+USDC Perpetuals Feed (v2)
//
// Discovery:     REST fetchTickers() → Top-N by 24h quoteVolume
// Streaming:     MULTIPLEXED watchBidsAsks + watchTradesForSymbols
//                (one WS connection, not one-per-symbol)
// Resilience:    Infinite reconnect loop with exponential backoff;
//                Binance closes (1001 / 1006 / read-timeout) are
//                swallowed and the stream is re-opened.
// Funding / OI:  Single REST batch every 30s via fetchFundingRates().
// ─────────────────────────────────────────────────────────────

import ccxt from 'ccxt';
import {
  VOLUME_THRESHOLD_USDC,
  MARKET_REFRESH_INTERVAL_MS,
  TOP_N_SYMBOLS,
  REDIS_KEYS,
} from '../../../shared/constants.js';
import { redisSadd, redisDel } from '../../../shared/redis-client.js';

/** Max symbols per watchTradesForSymbols call (ccxt binance hard limit). */
const BINANCE_MAX_STREAM_SYMBOLS = 200;

/** Funding-rate / open-interest refresh cadence (REST). */
const FUNDING_POLL_MS = 30_000;

/** Exponential backoff bounds for WS reconnects. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export class BinanceFeed {
  /**
   * @param {object}              opts
   * @param {import('../aggregator.js').Aggregator} opts.aggregator
   * @param {object}              opts.triggerEngine
   * @param {string}              [opts.apiKey]
   * @param {string}              [opts.apiSecret]
   * @param {number}              [opts.volumeThreshold]
   * @param {number}              [opts.refreshInterval]
   * @param {number}              [opts.topN]
   */
  constructor({
    aggregator,
    triggerEngine,
    apiKey = '',
    apiSecret = '',
    volumeThreshold = VOLUME_THRESHOLD_USDC,
    refreshInterval = MARKET_REFRESH_INTERVAL_MS,
    topN = TOP_N_SYMBOLS,
  }) {
    this.exchange = new ccxt.pro.binance({
      apiKey: apiKey || undefined,
      secret: apiSecret || undefined,
      enableRateLimit: true,
      // ccxt.pro default keepAlive is 180s — we tighten it so Binance
      // doesn't close idle sockets (1001 / 1006) before we've pinged.
      options: {
        defaultType: 'swap',
        keepAlive: 30_000,
        tradesLimit: 1000,
        watchTrades: { name: 'trade' },
      },
    });

    this.aggregator = aggregator;
    this.triggerEngine = triggerEngine;
    this.volumeThreshold = volumeThreshold;
    this.refreshInterval = refreshInterval;
    this.topN = topN;

    /** @type {string[]} currently streamed symbols (≤ topN) */
    this.activeSymbols = [];

    /** @type {boolean} */
    this.running = false;

    /** @type {number} monotonic id — bumps on every re-discovery so old
     *  loops notice the universe has changed and restart themselves. */
    this._generation = 0;

    /** @type {NodeJS.Timeout|null} */
    this._refreshTimer = null;

    /** @type {NodeJS.Timeout|null} */
    this._fundingTimer = null;
  }

  // ───────────────────────────────────────────────────────────
  // Discovery
  // ───────────────────────────────────────────────────────────

  /**
   * REST pre-flight: list active USDT+USDC linear perps, sort by 24h
   * quoteVolume, keep the top `topN`. NO per-base deduplication — if
   * both BTC/USDT and BTC/USDC clear the volume bar they both stream.
   *
   * @returns {Promise<string[]>}
   */
  async discoverSymbols() {
    console.log(
      `[BINANCE] ╔═══════════════════════════════════════════════════╗`
    );
    console.log(
      `[BINANCE] ║  TOP-${String(this.topN).padEnd(3)} USDT+USDC PERP DISCOVERY (v2)          ║`
    );
    console.log(
      `[BINANCE] ╚═══════════════════════════════════════════════════╝`
    );

    await this.exchange.loadMarkets(true);

    const candidates = Object.values(this.exchange.markets).filter(
      (m) =>
        m.active &&
        m.type === 'swap' &&
        m.linear === true &&
        (m.settle === 'USDT' || m.quote === 'USDT' ||
          m.settle === 'USDC' || m.quote === 'USDC')
    );
    console.log(`[BINANCE] USDT+USDC linear perps available: ${candidates.length}`);

    if (candidates.length === 0) {
      console.warn('[BINANCE] No USDT/USDC perps found.');
      return [];
    }

    // Bulk ticker pull — one REST call, explicit symbols to prevent API segment masking
    let tickers = {};
    const candidateSymbols = candidates.map(c => c.symbol);
    try {
      tickers = await this.exchange.fetchTickers(candidateSymbols);
    } catch (err) {
      console.error('[BINANCE] fetchTickers failed:', err.message);
      // Per-symbol fallback capped to avoid rate-limit storms.
      for (const sym of candidateSymbols.slice(0, 300)) {
        try {
          tickers[sym] = await this.exchange.fetchTicker(sym);
        } catch { /* skip */ }
      }
    }

    // Sort ALL USDT+USDC perps by 24h quoteVolume, take the top N.
    const ranked = candidates
      .map((m) => ({
        symbol: m.symbol,
        base: m.base,
        quote: m.quote,
        vol: (tickers[m.symbol] && tickers[m.symbol].quoteVolume) || 0,
      }))
      .filter((r) => r.vol > 0)
      .sort((a, b) => b.vol - a.vol)
      .slice(0, this.topN);

    this.activeSymbols = ranked.map((r) => r.symbol);

    console.log(
      `[BINANCE] ▶ Tracking ${this.activeSymbols.length} symbols (requested Top-${this.topN}):`
    );
    ranked.slice(0, 10).forEach((r, i) => {
      console.log(
        `  ${String(i + 1).padStart(3)}. ${r.symbol.padEnd(22)} vol: $${(r.vol / 1e6).toFixed(1)}M`
      );
    });
    if (ranked.length > 10) {
      const tail = ranked[ranked.length - 1];
      console.log(`  ... through #${ranked.length} ${tail.symbol} (vol: $${(tail.vol / 1e6).toFixed(1)}M)`);
    }

    try {
      await redisDel(REDIS_KEYS.ACTIVE_SYMBOLS);
      if (this.activeSymbols.length > 0) {
        await redisSadd(REDIS_KEYS.ACTIVE_SYMBOLS, ...this.activeSymbols);
      }
    } catch (err) {
      console.error('[BINANCE] Redis active_symbols update failed:', err.message);
    }

    return this.activeSymbols;
  }

  // ───────────────────────────────────────────────────────────
  // Lifecycle
  // ───────────────────────────────────────────────────────────

  async start() {
    if (this.running) return;
    this.running = true;

    console.log('[BINANCE] Starting feed...');
    await this.discoverSymbols();
    this._generation++;

    // Kick off the three always-on workers. Each is an infinite
    // reconnect loop — they return only when `this.running` flips false.
    this._runTickersForever(this._generation);
    this._runTradesForever(this._generation);
    this._runFundingPollForever();

    this._refreshTimer = setInterval(async () => {
      console.log('[BINANCE] Scheduled market refresh...');
      try {
        const before = [...this.activeSymbols];
        await this.discoverSymbols();
        const added = this.activeSymbols.filter((s) => !before.includes(s));
        const removed = before.filter((s) => !this.activeSymbols.includes(s));
        if (added.length || removed.length) {
          console.log(`[BINANCE] Universe changed: +${added.length} / -${removed.length}`);
          // New generation → current loops abort after their next await
          // and the relaunched ones subscribe to the fresh symbol set.
          this._generation++;
          this._runTickersForever(this._generation);
          this._runTradesForever(this._generation);
        }
      } catch (err) {
        console.error('[BINANCE] Refresh error:', err.message);
      }
    }, this.refreshInterval);

    console.log(
      `[BINANCE] ✅ Feed running. ${this.activeSymbols.length} symbols streamed. ` +
      `Next refresh in ${this.refreshInterval / 60_000}min.`
    );
  }

  async stop() {
    this.running = false;
    if (this._refreshTimer) { clearInterval(this._refreshTimer); this._refreshTimer = null; }
    if (this._fundingTimer) { clearTimeout(this._fundingTimer); this._fundingTimer = null; }
    try { await this.exchange.close(); } catch { /* ignore */ }
    console.log('[BINANCE] Feed stopped');
  }

  getStatus() {
    return {
      running: this.running,
      symbols: this.activeSymbols.length,
      generation: this._generation,
      exchange: 'binance',
    };
  }

  // ───────────────────────────────────────────────────────────
  // Multiplexed WS loops (one connection, many symbols)
  // ───────────────────────────────────────────────────────────

  /**
   * Chunk the active symbol list so each ccxt watch call stays below
   * the Binance combined-stream cap.
   * @returns {string[][]}
   */
  _chunkedSymbols() {
    const chunks = [];
    for (let i = 0; i < this.activeSymbols.length; i += BINANCE_MAX_STREAM_SYMBOLS) {
      chunks.push(this.activeSymbols.slice(i, i + BINANCE_MAX_STREAM_SYMBOLS));
    }
    return chunks;
  }

  /**
   * Run the watchTickers multiplexed stream forever. A new
   * generation supersedes older calls — stale loops notice and exit.
   * @param {number} gen
   */
  async _runTickersForever(gen) {
    const chunks = this._chunkedSymbols();
    for (const chunk of chunks) {
      this._tickersChunkLoop(chunk, gen);
    }
  }

  /**
   * Run the trades multiplexed stream forever.
   * @param {number} gen
   */
  async _runTradesForever(gen) {
    const chunks = this._chunkedSymbols();
    for (const chunk of chunks) {
      this._tradesChunkLoop(chunk, gen);
    }
  }

  /**
   * Infinite reconnect loop for one multiplexed ticker stream.
   * @param {string[]} chunk
   * @param {number}   gen
   */
  async _tickersChunkLoop(chunk, gen) {
    let backoff = RECONNECT_MIN_MS;
    while (this.running && gen === this._generation) {
      try {
        const tickers = await this.exchange.watchTickers(chunk);
        backoff = RECONNECT_MIN_MS; // success → reset

        for (const [symbol, tick] of Object.entries(tickers || {})) {
          if (!tick) continue;
          this.aggregator.onTicker(symbol, tick);
        }
      } catch (err) {
        if (!this.running || gen !== this._generation) break;
        const code = err && (err.code || err.status) ? ` [${err.code || err.status}]` : '';
        console.warn(
          `[BINANCE] watchTickers WS dropped${code}: ${err.message || err}. ` +
          `Reconnecting in ${backoff}ms (chunk of ${chunk.length}).`
        );
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    }
  }

  /**
   * Infinite reconnect loop for one multiplexed trade stream.
   * @param {string[]} chunk
   * @param {number}   gen
   */
  async _tradesChunkLoop(chunk, gen) {
    let backoff = RECONNECT_MIN_MS;
    while (this.running && gen === this._generation) {
      try {
        const trades = await this.exchange.watchTradesForSymbols(chunk);
        backoff = RECONNECT_MIN_MS;

        if (Array.isArray(trades)) {
          for (const trade of trades) {
            if (trade && trade.symbol) this.aggregator.onTrade(trade.symbol, trade);
          }
        }
      } catch (err) {
        if (!this.running || gen !== this._generation) break;
        const code = err && (err.code || err.status) ? ` [${err.code || err.status}]` : '';
        console.warn(
          `[BINANCE] trades WS dropped${code}: ${err.message || err}. ` +
          `Reconnecting in ${backoff}ms (chunk of ${chunk.length}).`
        );
        await this._sleep(backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
      }
    }
  }

  /**
   * REST-poll all funding rates + open interest in batches. A single
   * fetchFundingRates() call replaces 150 per-symbol watchFundingRate
   * subscriptions that Binance doesn't reliably keep alive.
   */
  async _runFundingPollForever() {
    const tick = async () => {
      if (!this.running) return;
      try {
        const rates = await this.exchange.fetchFundingRates(this.activeSymbols);
        for (const [symbol, fr] of Object.entries(rates || {})) {
          if (fr) this.aggregator.onFundingRate(symbol, fr);
        }
      } catch (err) {
        console.warn('[BINANCE] fetchFundingRates failed:', err.message);
      }

      // Open interest — per symbol, but bounded in parallel to avoid
      // swamping the REST rate limit.
      try {
        const syms = [...this.activeSymbols];
        const CONCURRENCY = 8;
        let idx = 0;
        const worker = async () => {
          while (idx < syms.length && this.running) {
            const s = syms[idx++];
            try {
              const oi = await this.exchange.fetchOpenInterest(s);
              if (oi) this.aggregator.onOpenInterest(s, oi);
            } catch { /* best-effort */ }
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, worker));
      } catch (err) {
        console.warn('[BINANCE] fetchOpenInterest batch failed:', err.message);
      }

      if (this.running) {
        this._fundingTimer = setTimeout(tick, FUNDING_POLL_MS);
      }
    };
    // fire immediately, then schedule
    tick();
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
