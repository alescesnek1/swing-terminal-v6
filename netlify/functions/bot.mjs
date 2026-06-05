const DEFAULT_STATE = {
  status: 'safety',
  mode: 'dry_run',
  botAwake: false,
  candidate: null,
  message: 'PaperBot control skeleton is in safety mode. No trading engine is running.',
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

function event(type, severity, message, data = undefined) {
  const out = { type, severity, message, ts: new Date().toISOString() };
  if (data && typeof data === 'object') out.data = data;
  return out;
}

function getTradingMode() {
  return 'dry_run';
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
    message: botControlState.message || 'PaperBot control skeleton is in safety mode. No trading engine is running.',
    candidate: botControlState.candidate,
    events: botControlState.events,
    ...extra,
  };
}

function marketNumber(row, keys) {
  for (const key of keys) {
    const value = Number(row && row[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return 0;
  const idx = Math.max(0, Math.min(sortedAsc.length - 1, Math.floor((sortedAsc.length - 1) * p)));
  return sortedAsc[idx];
}

function normalizeCandidate(row, volumeP70, volumeP90) {
  const change24h = marketNumber(row, ['price_change_percentage_24h', '_c24', 'c24']);
  const change1h = marketNumber(row, ['price_change_percentage_1h_in_currency', '_c1', 'c1']);
  const totalVolume = marketNumber(row, ['total_volume', 'volume', 'quoteVolume']);
  const rankRaw = marketNumber(row, ['market_cap_rank', 'rank']);
  const rank = rankRaw > 0 ? rankRaw : 9999;
  const price = marketNumber(row, ['current_price', 'price', 'last']);
  const symbol = String(row && row.symbol || '').toUpperCase();
  const name = String(row && row.name || symbol || 'Unknown');
  const reason = [];
  let score = 0;

  if (!symbol || price <= 0 || totalVolume < 100000) return null;

  if (change24h <= -8) { score += 4; reason.push('24h flush'); }
  else if (change24h <= -5) { score += 3; reason.push('24h drop'); }
  else if (change24h <= -3) { score += 2; reason.push('24h weakness'); }

  if (change1h > 1.5 && change24h < 0) { score += 3; reason.push('1h reclaim'); }
  else if (change1h > 0.5 && change24h < 0) { score += 1; reason.push('1h recovery'); }

  if (totalVolume >= volumeP90) { score += 2; reason.push('high relative volume'); }
  else if (totalVolume >= volumeP70) { score += 1; reason.push('liquid enough'); }

  if (rank <= 300) { score += 1; reason.push('top 300 rank'); }
  else if (rank > 700) { score -= 2; reason.push('low-rank penalty'); }

  if (change24h > 8) { score -= 4; reason.push('overheat penalty'); }
  if (change1h > 5) { score -= 2; reason.push('1h pump penalty'); }

  return {
    symbol,
    name,
    score,
    price,
    change24h,
    change1h,
    reason,
    rank,
    totalVolume,
  };
}

async function fetchMarkets(req) {
  const requestUrl = new URL(req.url);
  const baseOrigin = /^https?:\/\//i.test(requestUrl.origin)
    ? requestUrl.origin
    : 'https://swing-terminal-v6.netlify.app';
  const marketsUrl = `${baseOrigin}/api/markets`;
  const headers = { 'Accept': 'application/json', 'Origin': requestOrigin(req) || baseOrigin };
  const auth = req.headers.get('authorization');
  if (auth) headers.Authorization = auth;

  const res = await fetch(marketsUrl, { headers });
  if (!res.ok) throw new Error(`markets HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('markets response was not an array');
  return data;
}

function scoreMarkets(markets) {
  const volumes = markets
    .map((row) => marketNumber(row, ['total_volume', 'volume', 'quoteVolume']))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  const volumeP70 = Math.max(100000, percentile(volumes, 0.70));
  const volumeP90 = Math.max(volumeP70, percentile(volumes, 0.90));
  const candidates = markets
    .map((row) => normalizeCandidate(row, volumeP70, volumeP90))
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (b.totalVolume - a.totalVolume) || (a.rank - b.rank));
  return candidates[0] || null;
}

function riskCheck(candidate) {
  const liveTradingEnabled = getLiveTradingEnabled();
  const tradingEnabled = false;
  const checks = [
    { ok: getTradingMode() === 'dry_run', reason: 'mode must be dry_run' },
    { ok: tradingEnabled === false, reason: 'tradingEnabled must be false' },
    { ok: liveTradingEnabled === false, reason: 'live env flag must not be active' },
    { ok: botControlState.botAwake === true, reason: 'bot must be awake' },
    { ok: !!candidate, reason: 'candidate must exist' },
    { ok: !!candidate && candidate.price > 0, reason: 'candidate price must be positive' },
    { ok: !!candidate && candidate.score >= 6, reason: 'candidate score must be at least 6' },
  ];
  const failed = checks.find((check) => !check.ok);
  return failed ? { ok: false, reason: failed.reason } : { ok: true };
}

async function runDryRunScan(req) {
  const events = [
    event('MARKET_SCAN_STARTED', 'info', 'Dry-run market scan started.'),
  ];

  let markets = [];
  try {
    markets = await fetchMarkets(req);
  } catch (err) {
    events.push(event('MARKET_SCAN_FAILED', 'warn', `Market scan failed: ${err.message}`));
    return { ok: false, status: 'safety', candidate: null, events };
  }

  events.push(event('MARKET_SCAN_COMPLETED', 'info', `Dry-run market scan completed across ${markets.length} markets.`, {
    marketCount: markets.length,
  }));

  const candidate = scoreMarkets(markets);
  if (!candidate || candidate.score < 6) {
    events.push(event('MARKET_SCAN_SKIPPED', 'info', 'No flush/reclaim candidate passed the minimum score.', {
      bestScore: candidate ? candidate.score : 0,
      symbol: candidate ? candidate.symbol : null,
    }));
    events.push(event('RISK_CHECK_FAILED', 'warn', 'Risk check failed: candidate score below threshold or no candidate exists.'));
    return { ok: true, status: 'safety', candidate, events };
  }

  events.push(event('SIGNAL_FOUND', 'info', `Flush/reclaim signal found for ${candidate.symbol} with score ${candidate.score}.`, {
    candidate,
  }));

  const risk = riskCheck(candidate);
  if (!risk.ok) {
    events.push(event('RISK_CHECK_FAILED', 'warn', `Risk check failed: ${risk.reason}.`));
    return { ok: true, status: 'safety', candidate, events };
  }

  events.push(event('RISK_CHECK_PASSED', 'info', 'Dry-run risk check passed. Trading remains disabled.'));
  const entry = Number(candidate.price.toFixed(8));
  const stopLoss = Number((candidate.price * 0.97).toFixed(8));
  const takeProfit = Number((candidate.price * 1.15).toFixed(8));
  events.push(event(
    'PAPER_TRADE_SIMULATED',
    'info',
    `Dry-run paper trade simulated for ${candidate.symbol}. Entry ${entry}, SL ${stopLoss}, TP ${takeProfit}. No real order submitted.`,
    {
      symbol: candidate.symbol,
      entry,
      stopLoss,
      takeProfit,
      positionUsd: 10,
      dryRun: true,
    },
  ));
  return { ok: true, status: 'ready_dry_run', candidate, events };
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
    const wakeEvent = event('BOT_WAKE_REQUESTED', 'info', 'Wake requested in dry-run skeleton mode.');
    const previousEvents = botControlState.events;
    botControlState = {
      ...botControlState,
      status: 'ready_dry_run',
      botAwake: true,
      events: [wakeEvent, ...previousEvents].slice(0, 20),
      updatedAt: wakeEvent.ts,
    };
    const scan = await runDryRunScan(req);
    const nextEvents = [wakeEvent, ...scan.events];
    const nextStatus = scan.status || 'ready_dry_run';
    const message = scan.ok
      ? 'Dry-run PaperBot scan completed. No trading engine started. No real orders can be submitted.'
      : 'Dry-run PaperBot scan failed safely. No trading engine started. No real orders can be submitted.';
    botControlState = {
      ...botControlState,
      status: nextStatus,
      candidate: scan.candidate || null,
      message,
      events: nextEvents.concat(previousEvents).slice(0, 30),
      updatedAt: new Date().toISOString(),
    };
    return json(req, publicState({
      status: nextStatus,
      message,
      candidate: scan.candidate || null,
      events: nextEvents,
      authMode: auth.authMode,
    }));
  }

  const stopEvent = event('BOT_STOP_REQUESTED', 'info', 'Stop requested in dry-run skeleton mode.');
  botControlState = {
    ...botControlState,
    status: 'stopped',
    botAwake: false,
    message: 'Bot dry-run control state stopped. No positions existed.',
    events: [stopEvent, ...botControlState.events].slice(0, 30),
    updatedAt: stopEvent.ts,
  };
  return json(req, publicState({
    message: 'Bot dry-run control state stopped. No positions existed.',
    events: [stopEvent],
    authMode: auth.authMode,
  }));
}

export const config = {
  path: '/api/bot/*',
};
