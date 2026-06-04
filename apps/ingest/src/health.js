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
 * @param {import('./paperbot.js').PaperBot} [opts.paperBot]   V6 — paper-trading sandbox; enables /api/paperbot/* REST polling.
 * @returns {import('http').Server}
 */
export function startHealthServer({ port = 8080, statusFn, paperBot }) {
  const app = express();
  const startTime = Date.now();

  // V6 — permissive CORS for the paperbot polling endpoints so the
  // Netlify-hosted client can read state when WebSocket is blocked.
  // The endpoints are read-only and emit only public sandbox data.
  app.use('/api/paperbot', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Cache-Control', 'no-store');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api/paperbot', express.json({ type: '*/*', limit: '16kb' }));

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

  // ── V6 PaperBot polling endpoints ──
  // Frontend can read these on an interval (e.g. every 2s) when the
  // WS stream is unavailable. Both endpoints are read-only.
  app.get('/api/paperbot/state', (_req, res) => {
    if (!paperBot) {
      res.status(503).json({ error: 'paperbot_unavailable' });
      return;
    }
    res.status(200).json(paperBot.getState());
  });

  app.get('/api/paperbot/trades', (req, res) => {
    if (!paperBot) {
      res.status(503).json({ error: 'paperbot_unavailable' });
      return;
    }
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
    res.status(200).json({
      count: paperBot.ledger.length,
      trades: paperBot.getLedger().slice(0, limit),
    });
  });

  app.post('/api/paperbot/emergency-close', async (req, res) => {
    if (!paperBot || typeof paperBot.emergencyCloseAll !== 'function') {
      res.status(503).json({ error: 'paperbot_unavailable' });
      return;
    }
    try {
      const report = await paperBot.emergencyCloseAll({
        source: req.body && req.body.source || 'terminal',
      });
      res.status(report.flat ? 200 : 500).json(report);
    } catch (err) {
      res.status(500).json({ error: 'emergency_close_failed', detail: err.message });
    }
  });

  const server = app.listen(port, () => {
    console.log(`[HEALTH] Server listening on :${port}`);
    console.log(`[HEALTH]   GET /healthz             — liveness probe`);
    console.log(`[HEALTH]   GET /readyz              — readiness probe`);
    console.log(`[HEALTH]   GET /api/paperbot/state  — V6 paperbot state (polling fallback)`);
    console.log(`[HEALTH]   GET /api/paperbot/trades — V6 paperbot closed-trade ledger`);
  });

  return server;
}
