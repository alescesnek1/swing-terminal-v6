// ─────────────────────────────────────────────────────────────
// Swing Terminal v1.0 — Health Server
// Provides /healthz (liveness) and /readyz (readiness) for Fly.io
// ─────────────────────────────────────────────────────────────

import express from 'express';
import { redisPing } from '../../shared/redis-client.js';

/**
 * Starts the health check HTTP server.
 *
 * @param {object}   opts
 * @param {number}   opts.port       HTTP port (default 8080)
 * @param {Function} opts.statusFn   returns { ready, feeds, symbols }
 * @returns {import('http').Server}
 */
export function startHealthServer({ port = 8080, statusFn }) {
  const app = express();
  const startTime = Date.now();

  // ── Liveness: "Is the process alive?" ──
  app.get('/healthz', (_req, res) => {
    res.status(200).json({
      status: 'alive',
      uptime_s: Math.round((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Readiness: "Can we serve traffic?" ──
  app.get('/readyz', async (_req, res) => {
    try {
      const redisOk = await redisPing();
      const appStatus = statusFn ? statusFn() : { ready: true };

      const ready = redisOk && appStatus.ready;

      const body = {
        ready,
        redis: redisOk ? 'connected' : 'disconnected',
        feeds: appStatus.feeds || {},
        active_symbols: appStatus.symbols || 0,
        uptime_s: Math.round((Date.now() - startTime) / 1000),
        timestamp: new Date().toISOString(),
      };

      res.status(ready ? 200 : 503).json(body);
    } catch (err) {
      res.status(503).json({
        ready: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  const server = app.listen(port, () => {
    console.log(`[HEALTH] Server listening on :${port}`);
    console.log(`[HEALTH]   GET /healthz — liveness probe`);
    console.log(`[HEALTH]   GET /readyz  — readiness probe`);
  });

  return server;
}
