// ─────────────────────────────────────────────────────────────
// Swing Terminal v7.0 — /api/stream-markets WebSocket Server
//
// Attaches to the same HTTP server as /healthz so Fly.io exposes a
// single port. Subscribes to Aggregator's `tick` event and fans every
// ticker delta out to every connected browser client as a compact
// JSON frame.
//
// Frame contract (mirrors the client in apps/edge/public/js/terminal.js):
//   { "t":"tick", "s":"BTC", "p":65432.10, "c24":2.51,
//     "qv":4.21e10, "ts":1700000000000 }
//
// Auth model (V7.0 baseline):
//   • Origin allowlist enforced on the HTTP Upgrade handshake.
//   • ?token=… query parameter is accepted opaque (Bearer JWT). The
//     presence of a non-empty token is required for non-localhost
//     origins; full Supabase JWT verification is the next sprint.
//
// Liveness:
//   • Server sends a `{"t":"ping"}` every 25s; clients reply `{"t":"pong"}`.
//   • Any socket that misses two consecutive pings is dropped.
// ─────────────────────────────────────────────────────────────

import { WebSocketServer } from 'ws';

const STREAM_PATH = '/api/stream-markets';
const PING_INTERVAL_MS = 25_000;

function parseAllowedOrigins() {
  const raw = process.env.STREAM_ALLOWED_ORIGINS
    || 'https://swing-terminal-v6.netlify.app,http://localhost:8888,http://127.0.0.1:8888';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function isLocalhost(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(origin || '');
}

function extractQueryToken(reqUrl) {
  try {
    const u = new URL(reqUrl, 'http://x');
    return u.searchParams.get('token') || '';
  } catch { return ''; }
}

/**
 * Starts the WS stream server bound to an existing http.Server.
 *
 * @param {object} opts
 * @param {import('http').Server} opts.server       The http.Server returned by startHealthServer.
 * @param {import('./aggregator.js').Aggregator} opts.aggregator
 * @returns {{ close: () => Promise<void>, clientCount: () => number }}
 */
export function startStreamServer({ server, aggregator }) {
  if (!server) throw new Error('startStreamServer: server is required');
  if (!aggregator) throw new Error('startStreamServer: aggregator is required');

  const allowedOrigins = parseAllowedOrigins();
  console.log(`[STREAM] Allowed origins: ${allowedOrigins.join(', ')}`);

  // `noServer:true` so we can run the upgrade auth check ourselves;
  // ws's built-in `verifyClient` is sync-only and we want clear logs.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(STREAM_PATH)) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin || '';
    const originOk = allowedOrigins.includes(origin) || isLocalhost(origin) || origin === '';
    if (!originOk) {
      console.warn(`[STREAM] Rejected upgrade — origin "${origin}" not in allowlist`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = extractQueryToken(req.url);
    if (!isLocalhost(origin) && !token) {
      console.warn(`[STREAM] Rejected upgrade — token missing from non-local origin "${origin}"`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws._origin = origin;
      ws._tokenPresent = !!token;
      ws._missedPings = 0;
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    try {
      ws.send(JSON.stringify({ t: 'hello', v: '7.0', interval_ms: PING_INTERVAL_MS }));
    } catch { /* socket may have closed already */ }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.t === 'pong') ws._missedPings = 0;
    });

    ws.on('close', () => { /* gc handled by ws */ });
    ws.on('error', () => { try { ws.terminate(); } catch {} });
  });

  // Tick fan-out. ONE listener on the aggregator, broadcast to N clients.
  const onTick = (frame) => {
    const payload = JSON.stringify(frame);
    for (const ws of wss.clients) {
      if (ws.readyState === 1 /* OPEN */) {
        try { ws.send(payload); } catch { /* drop frame for this client */ }
      }
    }
  };
  aggregator.on('tick', onTick);

  // Heartbeat / dead-socket reaper.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== 1) continue;
      if (ws._missedPings >= 2) {
        try { ws.terminate(); } catch {}
        continue;
      }
      ws._missedPings = (ws._missedPings || 0) + 1;
      try { ws.send('{"t":"ping"}'); } catch { /* socket gone, will GC */ }
    }
  }, PING_INTERVAL_MS);

  console.log(`[STREAM] WS server attached at ${STREAM_PATH}`);

  return {
    clientCount: () => wss.clients.size,
    close: async () => {
      clearInterval(pingTimer);
      aggregator.off('tick', onTick);
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
