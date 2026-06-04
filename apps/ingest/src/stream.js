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

function parseUpgradeUrl(req) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  } catch (err) {
    console.log(`[STREAM] Upgrade URL parse failed: ${err.message}`);
    return null;
  }
}

function rejectUpgrade(socket, statusCode, reason, details = {}) {
  const statusText = statusCode === 400 ? 'Bad Request'
    : statusCode === 401 ? 'Unauthorized'
    : statusCode === 403 ? 'Forbidden'
    : statusCode === 404 ? 'Not Found'
    : 'Error';
  console.log(`[STREAM] Upgrade rejected: ${statusCode} ${reason}`, details);
  try {
    socket.write(
      `HTTP/1.1 ${statusCode} ${statusText}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n'
      + '\r\n',
    );
  } catch {}
  socket.destroy();
}

/**
 * Starts the WS stream server bound to an existing http.Server.
 *
 * @param {object} opts
 * @param {import('http').Server} opts.server       The http.Server returned by startHealthServer.
 * @param {import('./aggregator.js').Aggregator} opts.aggregator
 * @param {import('./paperbot.js').PaperBot} [opts.paperBot]   V6 — optional paper-trading sandbox.
 * @returns {{ close: () => Promise<void>, clientCount: () => number }}
 */
export function startStreamServer({ server, aggregator, paperBot }) {
  if (!server) throw new Error('startStreamServer: server is required');
  if (!aggregator) throw new Error('startStreamServer: aggregator is required');

  const allowedOrigins = parseAllowedOrigins();
  const requireToken = process.env.STREAM_REQUIRE_TOKEN === 'true';
  console.log(`[STREAM] Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`[STREAM] Query-token enforcement: ${requireToken ? 'enabled' : 'bypassed for debug'}`);

  // `noServer:true` so we can run the upgrade auth check ourselves;
  // ws's built-in `verifyClient` is sync-only and we want clear logs.
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const upgradeUrl = parseUpgradeUrl(req);
    if (!upgradeUrl) {
      rejectUpgrade(socket, 400, 'bad_url', { rawUrl: req.url || '' });
      return;
    }

    if (upgradeUrl.pathname !== STREAM_PATH) {
      rejectUpgrade(socket, 404, 'wrong_path', { path: upgradeUrl.pathname, expected: STREAM_PATH });
      return;
    }

    const origin = req.headers.origin || '';
    const originOk = allowedOrigins.includes(origin) || isLocalhost(origin) || origin === '';
    if (!originOk) {
      rejectUpgrade(socket, 403, 'origin_not_allowed', { origin, allowedOrigins });
      return;
    }

    const token = upgradeUrl.searchParams.get('token') || extractQueryToken(req.url);
    const tokenParts = token ? token.split('.').length : 0;
    console.log('[STREAM] Upgrade auth debug', {
      path: upgradeUrl.pathname,
      origin: origin || '(none)',
      token_present: !!token,
      token_len: token.length,
      token_parts: tokenParts,
      requireToken,
    });

    if (requireToken && !isLocalhost(origin) && !token) {
      rejectUpgrade(socket, 401, 'token_missing', { origin: origin || '(none)', token_present: false });
      return;
    }

    if (requireToken && token && tokenParts !== 3) {
      rejectUpgrade(socket, 401, 'token_malformed', { origin: origin || '(none)', token_parts: tokenParts });
      return;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws._origin = origin;
        ws._tokenPresent = !!token;
        ws._missedPings = 0;
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      console.log(`[STREAM] handleUpgrade failed: ${err.stack || err.message}`);
      socket.destroy();
    }
  });

  wss.on('connection', (ws) => {
    try {
      ws.send(JSON.stringify({ t: 'hello', v: '7.0', interval_ms: PING_INTERVAL_MS }));
    } catch { /* socket may have closed already */ }

    // V6: greet new clients with the current PaperBot snapshot so the
    // sandbox UI shows live PnL/positions on first paint without
    // waiting up to broadcastIntervalMs for the next push.
    if (paperBot) {
      try { ws.send(JSON.stringify(paperBot.getState())); } catch {}
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && msg.t === 'pong') ws._missedPings = 0;
      if (msg && msg.t === 'pb_heartbeat' && paperBot && typeof paperBot.recordSessionHeartbeat === 'function') {
        const ok = paperBot.recordSessionHeartbeat({
          sessionId: msg.sessionId,
          transport: 'ws',
          remoteAddress: '',
        });
        if (ok && ws.readyState === 1) {
          try { ws.send(JSON.stringify({ t: 'pb_heartbeat_ack', ts: Date.now() })); } catch {}
        }
      }
      if (msg && msg.t === 'pb_reconnect' && paperBot && typeof paperBot.reconnectSession === 'function') {
        void paperBot.reconnectSession({
          sessionId: msg.sessionId,
          apiKey: msg.apiKey,
          apiSecret: msg.apiSecret,
          transport: 'ws',
        }).then((state) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pb_reconnect_ok', state, ts: Date.now() }));
        }).catch((err) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pb_reconnect_error', error: err.message, ts: Date.now() }));
        });
      }
    });

    ws.on('close', () => { /* gc handled by ws */ });
    ws.on('error', () => { try { ws.terminate(); } catch {} });
  });

  // Tick fan-out. ONE listener on the aggregator, broadcast to N clients.
  const broadcast = (payload) => {
    for (const ws of wss.clients) {
      if (ws.readyState === 1 /* OPEN */) {
        try { ws.send(payload); } catch { /* drop frame for this client */ }
      }
    }
  };
  const onTick = (frame) => broadcast(JSON.stringify(frame));
  aggregator.on('tick', onTick);

  // V6 — PaperBot state fan-out. The bot already self-throttles its
  // own broadcasts (cfg.broadcastIntervalMs), so this listener is a
  // straight pass-through. Frames carry `t:'pb'` so the client can
  // tell them apart from market `tick` frames.
  let onPb = null;
  if (paperBot) {
    onPb = (frame) => broadcast(JSON.stringify(frame));
    paperBot.on('pb', onPb);
  }

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
      if (paperBot && onPb) paperBot.off('pb', onPb);
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}
