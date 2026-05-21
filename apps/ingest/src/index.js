// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Ingest Worker Entry Point
// Starts health server, connects to Redis, discovers markets,
// and launches WebSocket feeds.
// ─────────────────────────────────────────────────────────────

import { startHealthServer } from './health.js';
import { startStreamServer } from './stream.js';
import { Aggregator } from './aggregator.js';
import { TriggerEngine } from './trigger/engine.js';
import { BinanceFeed } from './feeds/binance.js';
import { getRedis, redisPing } from '../../shared/redis-client.js';
import { TOP_N_SYMBOLS } from '../../shared/constants.js';

// ─────────────────────────────────────────────────────────────
// Configuration from environment
// ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '8080', 10);
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const VOLUME_THRESHOLD = parseInt(process.env.VOLUME_THRESHOLD_USDC || '5000000', 10);
const REFRESH_INTERVAL = parseInt(process.env.MARKET_REFRESH_INTERVAL_MS || '3600000', 10);
const TOP_N = parseInt(process.env.TOP_N_SYMBOLS || String(TOP_N_SYMBOLS), 10);

// ─────────────────────────────────────────────────────────────
// Global state
// ─────────────────────────────────────────────────────────────
let aggregator;
let triggerEngine;
let binanceFeed;
let streamServer;
let shuttingDown = false;

// ─────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────
async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║     SWING TERMINAL v1.0 — Ingest Worker         ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`[MAIN] PID: ${process.pid}`);
  console.log(`[MAIN] Node: ${process.version}`);
  console.log(`[MAIN] Volume threshold: $${(VOLUME_THRESHOLD / 1e6).toFixed(0)}M USDC`);
  console.log(`[MAIN] Market refresh interval: ${REFRESH_INTERVAL / 60_000}min`);
  console.log(`[MAIN] Top-N base coins streamed: ${TOP_N}`);
  console.log('');

  // ── Step 1: Test Redis connectivity ──
  console.log('[MAIN] Connecting to Redis...');
  try {
    await getRedis();
    const pong = await redisPing();
    if (!pong) throw new Error('PING failed');
    console.log('[MAIN] Redis connected ✓');
  } catch (err) {
    console.error('[MAIN] Redis connection failed:', err.message);
    process.exit(1);
  }

  // ── Step 2: Initialize components ──
  aggregator = new Aggregator();
  triggerEngine = new TriggerEngine(aggregator);

  binanceFeed = new BinanceFeed({
    aggregator,
    triggerEngine,
    apiKey: BINANCE_API_KEY,
    apiSecret: BINANCE_API_SECRET,
    volumeThreshold: VOLUME_THRESHOLD,
    refreshInterval: REFRESH_INTERVAL,
    topN: TOP_N,
  });

  // ── Step 3: Start health server ──
  const httpServer = startHealthServer({
    port: PORT,
    statusFn: () => ({
      ready: binanceFeed.running && binanceFeed.activeSymbols.length > 0,
      feeds: {
        binance: binanceFeed.getStatus(),
      },
      trigger: triggerEngine.getStatus(),
      symbols: binanceFeed.activeSymbols.length,
      stream_clients: streamServer ? streamServer.clientCount() : 0,
    }),
  });

  // ── Step 3b (V7.0): attach /api/stream-markets WS server to the
  // existing HTTP listener so Fly.io still exposes a single port.
  streamServer = startStreamServer({ server: httpServer, aggregator });

  // ── Step 4: Start aggregator ──
  aggregator.start();

  // ── Step 5: Start trigger engine ──
  triggerEngine.start();

  // ── Step 6: Start feed ──
  try {
    await binanceFeed.start();
  } catch (err) {
    console.error('[MAIN] Failed to start Binance feed:', err.message);
    console.error('[MAIN] Will retry automatically via the refresh cycle');
  }

  console.log('');
  console.log('[MAIN] ✅ Ingest worker fully operational');
  console.log(`[MAIN] Tracking ${binanceFeed.activeSymbols.length} USDC perpetual(s)`);
}

// ─────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n[MAIN] Received ${signal}, shutting down gracefully...`);

  try {
    // Stop feed first (closes WebSockets)
    if (binanceFeed) await binanceFeed.stop();

    // Close client-facing stream server before tearing the aggregator
    // down so listeners are detached cleanly and clients get a 1001
    // (going away) instead of a 1006 (abnormal closure).
    if (streamServer) await streamServer.close();

    // Stop trigger engine
    if (triggerEngine) triggerEngine.stop();

    // Stop aggregator (final flush)
    if (aggregator) aggregator.stop();

    // Close Redis
    const redis = await getRedis();
    if (redis && typeof redis.quit === 'function') {
      await redis.quit();
    }

    console.log('[MAIN] Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('[MAIN] Shutdown error:', err.message);
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Catch unhandled rejections
process.on('unhandledRejection', (err) => {
  console.error('[MAIN] Unhandled rejection:', err);
  // Don't crash — WebSocket reconnection is handled internally
});

// ── Launch ──
main().catch((err) => {
  console.error('[MAIN] Fatal error:', err);
  process.exit(1);
});
