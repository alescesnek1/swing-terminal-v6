const DEFAULT_STATE = {
  status: 'safety',
  mode: 'dry_run',
  botAwake: false,
  events: [],
  updatedAt: null,
};

const SENSITIVE_REQUEST_FIELDS = new Set([
  'apiKey',
  'apiSecret',
  'api_key',
  'api_secret',
  'secret',
  'binanceSecret',
  'binanceApiSecret',
]);

const DEFAULT_ALLOWED_ORIGINS = [
  'https://swing-terminal-v4-ales.netlify.app',
  'https://swing-terminal-v6.netlify.app',
];

const DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const NETLIFY_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.netlify\.app$/i;

let botControlState = { ...DEFAULT_STATE };

function getTradingMode() {
  return process.env.BOT_TRADING_MODE === 'live' ? 'dry_run' : (process.env.BOT_TRADING_MODE || 'dry_run');
}

function getLiveTradingEnabled() {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true';
}

function getAllowedOrigins() {
  const configured = String(process.env.APP_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== '*');
  return Array.from(new Set([...configured, ...DEFAULT_ALLOWED_ORIGINS]));
}

function requestOrigin(req) {
  const origin = req.headers.get('origin') || '';
  if (origin) return origin;
  const referer = req.headers.get('referer') || '';
  if (!referer) return '';
  try { return new URL(referer).origin; } catch { return ''; }
}

function checkOrigin(req) {
  const origin = requestOrigin(req);
  if (!origin) return { ok: false, origin: '', reason: 'No Origin or Referer header' };
  if (DEV_ORIGIN_RE.test(origin)) return { ok: true, origin, dev: true };
  if (NETLIFY_ORIGIN_RE.test(origin)) return { ok: true, origin, netlify: true };
  if (getAllowedOrigins().includes(origin)) return { ok: true, origin };
  return { ok: false, origin, reason: 'Origin not allowed' };
}

function corsHeaders(req) {
  const probe = checkOrigin(req);
  return {
    'Access-Control-Allow-Origin': probe.ok ? probe.origin : (getAllowedOrigins()[0] || 'null'),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
    },
  });
}

async function parseBody(req) {
  if (req.method !== 'POST') return {};
  const raw = await req.text();
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new Error('Invalid JSON body');
  }
}

function findSensitiveFields(body) {
  return Object.keys(body || {}).filter((key) => SENSITIVE_REQUEST_FIELDS.has(key));
}

async function verifyAuth() {
  return { ok: true, authMode: 'not_enforced_skeleton' };
}

function publicState(extra = {}) {
  const mode = getTradingMode() || 'dry_run';
  const liveTradingEnabled = getLiveTradingEnabled();
  return {
    ok: true,
    status: botControlState.status,
    mode: mode === 'dry_run' ? 'dry_run' : 'dry_run',
    botAwake: botControlState.botAwake,
    liveTradingEnabled,
    tradingEnabled: false,
    statePersistence: 'volatile_serverless_memory',
    productionReady: false,
    message: 'PaperBot control skeleton is in safety mode. No trading engine is running.',
    events: botControlState.events,
    ...extra,
  };
}

function routeName(req) {
  const url = new URL(req.url);
  return url.pathname.replace(/^\/api\/bot\/?/, '') || 'state';
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const origin = checkOrigin(req);
  if (!origin.ok) {
    return json(req, { ok: false, error: 'Origin not allowed', reason: origin.reason }, 403);
  }

  const auth = await verifyAuth(req);
  if (!auth.ok) {
    return json(req, { ok: false, error: 'Unauthorized', reason: auth.reason, authMode: auth.authMode }, auth.status || 401);
  }

  const route = routeName(req);
  if (route === 'state') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    return json(req, publicState({ authMode: auth.authMode }));
  }

  if (route !== 'wake' && route !== 'stop') {
    return json(req, { ok: false, error: 'Not Found' }, 404);
  }
  if (req.method !== 'POST') {
    return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
  }

  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    return json(req, { ok: false, error: err.message }, 400);
  }

  const deniedFields = findSensitiveFields(body);
  if (deniedFields.length) {
    return json(req, {
      ok: false,
      error: 'Credentials are not accepted by this endpoint.',
      deniedFields,
      message: 'API keys and secrets must be configured only in Netlify Environment Variables. They are never entered in the browser.',
    }, 400);
  }

  if (route === 'wake') {
    const event = {
      type: 'BOT_WAKE_REQUESTED',
      severity: 'info',
      message: 'Wake requested in dry-run skeleton mode.',
      ts: new Date().toISOString(),
    };
    botControlState = {
      ...botControlState,
      status: 'ready_dry_run',
      botAwake: true,
      events: [event, ...botControlState.events].slice(0, 20),
      updatedAt: event.ts,
    };
    return json(req, publicState({
      message: 'Bot dry-run control state updated. No trading engine started. No orders can be submitted.',
      events: [event],
      authMode: auth.authMode,
    }));
  }

  const event = {
    type: 'BOT_STOP_REQUESTED',
    severity: 'info',
    message: 'Stop requested in dry-run skeleton mode.',
    ts: new Date().toISOString(),
  };
  botControlState = {
    ...botControlState,
    status: 'stopped',
    botAwake: false,
    events: [event, ...botControlState.events].slice(0, 20),
    updatedAt: event.ts,
  };
  return json(req, publicState({
    message: 'Bot dry-run control state stopped. No positions existed.',
    events: [event],
    authMode: auth.authMode,
  }));
}

export const config = {
  path: '/api/bot/*',
};
