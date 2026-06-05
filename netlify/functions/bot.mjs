const DEFAULT_STATE = {
  status: 'safety',
  mode: 'dry_run',
  botAwake: false,
  candidate: null,
  paperPosition: null,
  closedTrades: [],
  manualExecutionPlan: null,
  realizedPnl: 0,
  unrealizedPnl: 0,
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

function roundMoney(value) {
  return Number((Number(value) || 0).toFixed(8));
}

function takeProfitPctForScore(score) {
  if (score >= 10) return 20;
  if (score >= 8) return 15;
  return 10;
}

function envFlag(name) {
  return process.env[name] === 'true';
}

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function getTradingMode() {
  return 'dry_run';
}

function getLiveTradingEnabled() {
  return process.env.BOT_LIVE_TRADING_ENABLED === 'true';
}

function getBotSafetyConfig() {
  const binanceEnv = process.env.BINANCE_ENV === 'production' ? 'production' : 'testnet';
  return {
    mode: 'dry_run',
    liveTradingEnabled: false,
    allowRealOrders: false,
    binanceEnv,
    maxPositionUsd: envNumber('BOT_MAX_POSITION_USD', 10),
    maxOpenPositions: envNumber('BOT_MAX_OPEN_POSITIONS', 1),
    stopLossPct: envNumber('BOT_STOP_LOSS_PCT', 3),
    takeProfitPct: envNumber('BOT_TAKE_PROFIT_PCT', 15),
  };
}

function getBinanceConfigStatus() {
  const hasApiKey = Boolean(process.env.BINANCE_API_KEY);
  const hasApiSecret = Boolean(process.env.BINANCE_API_SECRET);
  const safetyConfig = getBotSafetyConfig();
  return {
    binanceConfigured: hasApiKey && hasApiSecret,
    binanceEnv: safetyConfig.binanceEnv,
    hasApiKey,
    hasApiSecret,
  };
}

function isLiveTradingAllowed() {
  const config = getBotSafetyConfig();
  const binanceConfig = getBinanceConfigStatus();
  return process.env.BOT_TRADING_MODE === 'live'
    && envFlag('BOT_LIVE_TRADING_ENABLED')
    && envFlag('BOT_ALLOW_REAL_ORDERS')
    && config.binanceEnv === 'production'
    && binanceConfig.hasApiKey
    && binanceConfig.hasApiSecret
    && config.maxPositionUsd <= 10
    && config.maxOpenPositions === 1;
}

function blockLiveExecution(reason) {
  return {
    enabled: true,
    type: 'execution_preview',
    mode: 'BLOCKED',
    executionEnabled: false,
    realOrderSubmitted: false,
    reason,
  };
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
  const executionPreview = buildExecutionPreview(botControlState.paperPosition);
  return {
    ok: true,
    status: botControlState.status,
    mode: mode === 'dry_run' ? 'dry_run' : 'dry_run',
    botAwake: botControlState.botAwake,
    liveTradingEnabled: false,
    tradingEnabled: false,
    statePersistence: 'volatile_serverless_memory',
    productionReady: false,
    executionEnabled: false,
    realOrderSubmitted: false,
    liveGateWouldPass: isLiveTradingAllowed(),
    safetyConfig: getBotSafetyConfig(),
    binanceConfig: getBinanceConfigStatus(),
    executionPreview,
    message: botControlState.message || 'PaperBot control skeleton is in safety mode. No trading engine is running.',
    candidate: botControlState.candidate,
    paperPosition: botControlState.paperPosition,
    closedTrades: botControlState.closedTrades,
    manualExecutionPlan: botControlState.manualExecutionPlan,
    realizedPnl: botControlState.realizedPnl,
    unrealizedPnl: botControlState.unrealizedPnl,
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

function makeManualExecutionPlan(position) {
  if (!position) return null;
  return {
    enabled: true,
    exchange: 'Binance',
    symbol: `${position.symbol}USDT`,
    side: 'BUY',
    positionUsd: position.positionUsd,
    entryReference: position.entry,
    stopLoss: position.stopLoss,
    takeProfit: position.takeProfit,
    warning: 'Manual execution only. No order was submitted by this app.',
  };
}

function buildExecutionPreview(paperPosition) {
  if (!paperPosition || paperPosition.status !== 'open') return null;
  const config = getBotSafetyConfig();
  const basePreview = {
    enabled: true,
    type: 'execution_preview',
    symbol: `${paperPosition.symbol}USDT`,
    side: 'BUY',
    positionUsd: paperPosition.positionUsd,
    entryReference: paperPosition.entry,
    stopLoss: paperPosition.stopLoss,
    takeProfit: paperPosition.takeProfit,
    realOrderSubmitted: false,
  };
  if (config.binanceEnv !== 'testnet') {
    return {
      ...basePreview,
      ...blockLiveExecution('Live execution is hard-blocked in this build. No Binance order submitted.'),
    };
  }
  return {
    ...basePreview,
    mode: 'testnet_ready',
    reason: 'Execution preview only. No Binance order submitted.',
  };
}

function makePaperPosition(candidate) {
  const entry = roundMoney(candidate.price);
  const positionUsd = 10;
  const stopLossPct = 3;
  const takeProfitPct = takeProfitPctForScore(candidate.score);
  return {
    id: `PAPER-${candidate.symbol}-${Date.now()}`,
    symbol: candidate.symbol,
    side: 'LONG',
    entry,
    currentPrice: entry,
    stopLoss: roundMoney(entry * (1 - stopLossPct / 100)),
    takeProfit: roundMoney(entry * (1 + takeProfitPct / 100)),
    positionUsd,
    quantity: roundMoney(positionUsd / entry),
    stopLossPct,
    takeProfitPct,
    openedAt: new Date().toISOString(),
    status: 'open',
    dryRun: true,
    realOrderSubmitted: false,
  };
}

function findMarketForSymbol(markets, symbol) {
  const needle = String(symbol || '').toUpperCase();
  return (markets || []).find((row) => String(row && row.symbol || '').toUpperCase() === needle) || null;
}

function pnlForPosition(position, price) {
  const currentPrice = roundMoney(price);
  const pnlUsd = roundMoney((currentPrice - position.entry) * position.quantity);
  const pnlPct = roundMoney(((currentPrice / position.entry) - 1) * 100);
  return { currentPrice, pnlUsd, pnlPct };
}

function monitorPaperPosition(markets) {
  const position = botControlState.paperPosition;
  const events = [];
  if (!position || position.status !== 'open') return { events };

  const row = findMarketForSymbol(markets, position.symbol);
  const price = row ? marketNumber(row, ['current_price', 'price', 'last']) : position.currentPrice;
  const pnl = pnlForPosition(position, price);
  const nextPosition = { ...position, currentPrice: pnl.currentPrice };
  let closeReason = null;
  if (pnl.currentPrice <= position.stopLoss) closeReason = 'STOP_LOSS';
  else if (pnl.currentPrice >= position.takeProfit) closeReason = 'TAKE_PROFIT';

  if (closeReason) {
    const closedTrade = {
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      entry: position.entry,
      exit: pnl.currentPrice,
      positionUsd: position.positionUsd,
      quantity: position.quantity,
      pnlUsd: pnl.pnlUsd,
      pnlPct: pnl.pnlPct,
      closeReason,
      openedAt: position.openedAt,
      closedAt: new Date().toISOString(),
      dryRun: true,
      realOrderSubmitted: false,
    };
    botControlState.paperPosition = null;
    botControlState.closedTrades = [closedTrade, ...botControlState.closedTrades].slice(0, 20);
    botControlState.realizedPnl = roundMoney((botControlState.realizedPnl || 0) + closedTrade.pnlUsd);
    botControlState.unrealizedPnl = 0;
    botControlState.manualExecutionPlan = null;
    events.push(event('PAPER_POSITION_CLOSED', 'info', `Paper position closed for ${position.symbol}: ${closeReason}.`, { closedTrade }));
    return { events, closedTrade };
  }

  botControlState.paperPosition = nextPosition;
  botControlState.unrealizedPnl = pnl.pnlUsd;
  events.push(event('PAPER_POSITION_MONITORED', 'info', `Open paper position monitored for ${position.symbol}.`, {
    paperPosition: nextPosition,
    unrealizedPnl: pnl.pnlUsd,
    unrealizedPnlPct: pnl.pnlPct,
  }));
  return { events, paperPosition: nextPosition };
}

function runDryRunScanFromMarkets(markets) {
  const events = [];

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
  const paperPosition = makePaperPosition(candidate);
  const manualExecutionPlan = makeManualExecutionPlan(paperPosition);
  events.push(event('PAPER_POSITION_OPENED', 'info', `Dry-run paper position opened for ${candidate.symbol}. No real order submitted.`, {
    paperPosition,
  }));
  events.push(event('MANUAL_EXECUTION_PLAN_READY', 'info', `Manual Binance trade plan ready for ${candidate.symbol}. No order was submitted by this app.`, {
    manualExecutionPlan,
  }));
  return { ok: true, status: 'paper_position_open', candidate, paperPosition, manualExecutionPlan, events };
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
    const marketEvents = [event('MARKET_SCAN_STARTED', 'info', 'Dry-run market scan started.')];
    let markets = [];
    try {
      markets = await fetchMarkets(req);
      marketEvents.push(event('MARKET_SCAN_COMPLETED', 'info', `Dry-run market scan completed across ${markets.length} markets.`, {
        marketCount: markets.length,
      }));
    } catch (err) {
      marketEvents.push(event('MARKET_SCAN_FAILED', 'warn', `Market scan failed: ${err.message}`));
      const nextEvents = [wakeEvent, ...marketEvents];
      botControlState = {
        ...botControlState,
        status: 'safety',
        message: 'Dry-run PaperBot scan failed safely. No real orders can be submitted.',
        events: nextEvents.concat(previousEvents).slice(0, 30),
        updatedAt: new Date().toISOString(),
      };
      return json(req, publicState({
        status: 'safety',
        message: botControlState.message,
        events: nextEvents,
        authMode: auth.authMode,
      }));
    }

    let result;
    if (botControlState.paperPosition && botControlState.paperPosition.status === 'open') {
      const monitor = monitorPaperPosition(markets);
      const alreadyOpenEvent = botControlState.paperPosition
        ? event('PAPER_POSITION_ALREADY_OPEN', 'info', `Existing paper position remains open for ${botControlState.paperPosition.symbol}.`, {
            paperPosition: botControlState.paperPosition,
          })
        : null;
      result = {
        ok: true,
        status: monitor.closedTrade ? 'paper_position_closed' : (botControlState.paperPosition ? 'paper_position_open' : 'stopped'),
        candidate: botControlState.candidate,
        paperPosition: botControlState.paperPosition,
        closedTrade: monitor.closedTrade,
        manualExecutionPlan: botControlState.manualExecutionPlan,
        events: alreadyOpenEvent ? [...marketEvents, alreadyOpenEvent, ...monitor.events] : [...marketEvents, ...monitor.events],
      };
    } else {
      result = runDryRunScanFromMarkets(markets);
      result.events = [...marketEvents, ...result.events];
    }

    const nextEvents = [wakeEvent, ...result.events];
    const nextStatus = result.status || 'ready_dry_run';
    const message = result.paperPosition
      ? `Paper position open. Monitoring simulated LONG ${result.paperPosition.symbol}. No real order submitted.`
      : result.closedTrade
        ? 'Paper position closed by dry-run monitor. No real order submitted.'
        : result.ok
          ? 'Dry-run PaperBot cycle completed. No real orders can be submitted.'
          : 'Dry-run PaperBot scan failed safely. No real orders can be submitted.';
    botControlState = {
      ...botControlState,
      status: nextStatus,
      candidate: result.candidate || botControlState.candidate || null,
      paperPosition: result.paperPosition || botControlState.paperPosition || null,
      manualExecutionPlan: result.manualExecutionPlan || botControlState.manualExecutionPlan || null,
      message,
      events: nextEvents.concat(previousEvents).slice(0, 30),
      updatedAt: new Date().toISOString(),
    };
    return json(req, publicState({
      status: nextStatus,
      message,
      candidate: botControlState.candidate,
      paperPosition: botControlState.paperPosition,
      closedTrades: botControlState.closedTrades,
      manualExecutionPlan: botControlState.manualExecutionPlan,
      realizedPnl: botControlState.realizedPnl,
      unrealizedPnl: botControlState.unrealizedPnl,
      events: nextEvents,
      authMode: auth.authMode,
    }));
  }

  const stopEvent = event('BOT_STOP_REQUESTED', 'info', 'Stop requested in dry-run skeleton mode.');
  botControlState = {
    ...botControlState,
    status: 'stopped',
    botAwake: false,
    message: botControlState.paperPosition
      ? 'Dry-run bot stopped. Open paper position remains simulated and will be monitored on next Wake.'
      : 'Bot dry-run control state stopped. No positions existed.',
    events: [stopEvent, ...botControlState.events].slice(0, 30),
    updatedAt: stopEvent.ts,
  };
  return json(req, publicState({
    message: botControlState.message,
    events: [stopEvent],
    authMode: auth.authMode,
  }));
}

export const config = {
  path: '/api/bot/*',
};
