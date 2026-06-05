import crypto from 'node:crypto';

const DEFAULT_STATE = {
  status: 'safety',
  mode: 'dry_run',
  botAwake: false,
  candidate: null,
  paperPosition: null,
  closedTrades: [],
  manualExecutionPlan: null,
  testnetOrder: null,
  testnetOrders: [],
  realizedPnl: 0,
  unrealizedPnl: 0,
  message: 'PaperBot control skeleton is in safety mode. No trading engine is running.',
  executionIntent: null,
  executionResults: [],
  usedIdempotencyKeys: [],
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
    allowTestnetOrders: envFlag('BOT_ALLOW_TESTNET_ORDERS'),
    binanceEnv,
    maxPositionUsd: envNumber('BOT_MAX_POSITION_USD', 10),
    maxOpenPositions: envNumber('BOT_MAX_OPEN_POSITIONS', 1),
    stopLossPct: envNumber('BOT_STOP_LOSS_PCT', 3),
    takeProfitPct: envNumber('BOT_TAKE_PROFIT_PCT', 15),
  };
}

function getBinanceConfigStatus() {
  const safetyConfig = getBotSafetyConfig();
  return {
    binanceConfigured: true, // Frontend assumes true to allow intent creation
    binanceEnv: safetyConfig.binanceEnv,
    hasApiKey: false, // Netlify does not hold keys
    hasApiSecret: false,
  };
}

function getTestnetExecutionEnabled() {
  return process.env.BINANCE_ENV === 'testnet'
    && process.env.BOT_ALLOW_TESTNET_ORDERS === 'true'
    && process.env.BOT_TRADING_MODE !== 'live'
    && process.env.BOT_LIVE_TRADING_ENABLED !== 'true'
    && process.env.BOT_ALLOW_REAL_ORDERS !== 'true';
}

class SafeBinanceError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.safeMessage = message;
    this.binanceCode = meta.binanceCode;
    this.binanceMessage = meta.binanceMessage;
    this.httpStatus = meta.httpStatus;
  }
}

function safeTestnetOrderError(err, fallbackMessage = 'Testnet order failed safely.') {
  return {
    ok: false,
    error: 'TESTNET_ORDER_FAILED',
    blockedReason: err && err.safeMessage ? err.safeMessage : fallbackMessage,
    binanceCode: err && err.binanceCode ? err.binanceCode : undefined,
    binanceMessage: err && err.binanceMessage ? err.binanceMessage : undefined,
    httpStatus: err && err.httpStatus ? err.httpStatus : undefined,
    testnetOrderSubmitted: false,
    realOrderSubmitted: false,
    executionEnabled: false,
    testnetExecutionEnabled: false
  };
}

const BOT_QUOTE_ASSET = 'USDC';
const BOT_TESTNET_SMOKE_QUOTE_ASSET = 'USDT';

function getExecutionQuoteAsset({ smokeFallback = false } = {}) {
  return smokeFallback ? BOT_TESTNET_SMOKE_QUOTE_ASSET : BOT_QUOTE_ASSET;
}

let testnetTradableSymbolsCache = {
  USDC: { at: 0, symbols: null },
  USDT: { at: 0, symbols: null }
};

async function getTestnetTradableSymbols(quoteAsset = BOT_QUOTE_ASSET) {
  const now = Date.now();
  const cacheEntry = testnetTradableSymbolsCache[quoteAsset];
  if (cacheEntry && cacheEntry.symbols && (now - cacheEntry.at < 5 * 60 * 1000)) {
    return cacheEntry.symbols;
  }
  try {
    const data = await binancePublic('/v3/exchangeInfo');
    const symbols = new Set();
      if (data && Array.isArray(data.symbols)) {
        for (const row of data.symbols) {
          const statusOk = String(row.status || '').toUpperCase() === 'TRADING' || row.status === undefined;
          const quoteOk = String(row.quoteAsset || '').toUpperCase() === quoteAsset;
          const spotOk = row.isSpotTradingAllowed !== false;
          if (statusOk && quoteOk && spotOk) {
            symbols.add(String(row.symbol).toUpperCase());
          }
        }
      }
    if (!testnetTradableSymbolsCache[quoteAsset]) {
      testnetTradableSymbolsCache[quoteAsset] = { at: 0, symbols: null };
    }
    testnetTradableSymbolsCache[quoteAsset].symbols = symbols;
    testnetTradableSymbolsCache[quoteAsset].at = now;
    return symbols;
  } catch (err) {
    return null;
  }
}

async function getTestnetExchangeInfoDebug() {
  try {
    const data = await binancePublic('/v3/exchangeInfo');
    const isArray = Array.isArray(data && data.symbols);
    let count = 0;
    let quoteCounts = { USDT: 0, USDC: 0, BTC: 0, BNB: 0 };
    let tradingQuoteCounts = { USDT: 0, USDC: 0, BTC: 0, BNB: 0 };
    let firstSymbols = [];

    if (isArray) {
      count = data.symbols.length;
      firstSymbols = data.symbols.slice(0, 5).map(row => ({
        symbol: row.symbol,
        status: row.status,
        baseAsset: row.baseAsset,
        quoteAsset: row.quoteAsset,
        permissions: row.permissions,
        isSpotTradingAllowed: row.isSpotTradingAllowed,
        allowedSelfTradePreventionModes: row.allowedSelfTradePreventionModes
      }));

      for (const row of data.symbols) {
        const q = String(row.quoteAsset || '').toUpperCase();
        if (quoteCounts[q] !== undefined) quoteCounts[q]++;
        
        const statusOk = String(row.status || '').toUpperCase() === "TRADING" || row.status === undefined;
        const spotOk = row.isSpotTradingAllowed !== false;
        if (statusOk && spotOk) {
          if (tradingQuoteCounts[q] !== undefined) tradingQuoteCounts[q]++;
        }
      }
    }

    return {
      ok: true,
      httpStatus: 200,
      symbolsIsArray: isArray,
      symbolsCount: count,
      firstSymbols,
      quoteCounts,
      tradingQuoteCounts
    };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message,
      httpStatus: err && err.httpStatus
    };
  }
}
  
  function toBinanceQuoteSymbol(symbol, quoteAsset = BOT_QUOTE_ASSET) {
    return `${String(symbol || '').toUpperCase()}${quoteAsset}`;
  }

// ── Binance Spot TESTNET adapter ──────────────────────────────────────────────
// TESTNET ONLY. These helpers must never reach the Binance production API.
// Production base URL and live orders are hard-blocked by BINANCE_ENV === 'testnet'.
const BINANCE_TESTNET_BASE_URL = 'https://testnet.binance.vision/api';

function getBinanceBaseUrl() {
  if (process.env.BINANCE_ENV === 'testnet') return BINANCE_TESTNET_BASE_URL;
  return null;
}

async function binancePublic(path, params = {}) {
  const base = getBinanceBaseUrl();
  if (!base) throw new Error('TESTNET_ONLY: Binance base URL is unavailable outside testnet.');
  const search = new URLSearchParams();
  for (const key of Object.keys(params)) {
    if (params[key] !== undefined && params[key] !== null) search.append(key, String(params[key]));
  }
  const qs = search.toString();
  const url = qs ? `${base}${path}?${qs}` : `${base}${path}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data && data.code && data.msg) {
      throw new SafeBinanceError(`Binance Testnet rejected request: ${data.msg}`, {
        binanceCode: data.code,
        binanceMessage: data.msg,
        httpStatus: res.status
      });
    }
    throw new SafeBinanceError(`Binance testnet public HTTP ${res.status} failed safely.`, { httpStatus: res.status });
  }
  return data;
}

async function getExchangeInfo(symbol) {
  let data;
  try {
    data = await binancePublic('/v3/exchangeInfo', { symbol });
  } catch (err) {
    throw new SafeBinanceError(`Symbol ${symbol} is not available on Binance Spot Testnet.`, {
      binanceCode: err && err.binanceCode,
      binanceMessage: err && err.binanceMessage,
      httpStatus: err && err.httpStatus
    });
  }
  const info = Array.isArray(data && data.symbols)
    ? data.symbols.find((row) => String(row.symbol).toUpperCase() === String(symbol).toUpperCase())
    : null;
  if (!info) throw new SafeBinanceError(`Symbol ${symbol} is not available on Binance Spot Testnet.`);
  return info;
}

function stepPrecision(stepSize) {
  const step = String(stepSize || '');
  if (!step.includes('.')) return 0;
  return step.split('.')[1].replace(/0+$/, '').length;
}

function roundStep(quantity, stepSize) {
  const step = Number(stepSize);
  const qty = Number(quantity);
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(qty)) return qty;
  const precision = stepPrecision(stepSize);
  const rounded = Math.floor(qty / step) * step;
  return Number(rounded.toFixed(precision > 0 ? precision : 8));
}

function formatQuantity(quantity, stepSize) {
  const precision = stepPrecision(stepSize);
  return Number(quantity).toFixed(precision > 0 ? precision : 8);
}

function findFilter(filters, type) {
  return Array.isArray(filters) ? filters.find((row) => row && row.filterType === type) || null : null;
}

function validateMinNotional(price, quantity, filters) {
  const filter = findFilter(filters, 'MIN_NOTIONAL') || findFilter(filters, 'NOTIONAL');
  if (!filter) return { ok: true };
  const minNotional = Number(filter.minNotional);
  if (!Number.isFinite(minNotional) || minNotional <= 0) return { ok: true };
  const notional = Number(price) * Number(quantity);
  if (!Number.isFinite(notional) || notional < minNotional) {
    return { ok: false, reason: `Order notional ${notional} is below MIN_NOTIONAL ${minNotional}.`, minNotional, notional };
  }
  return { ok: true, minNotional, notional };
}

function buildTestnetMarketOrderParams(paperPosition, exchangeInfo) {
  const symbol = `${paperPosition.symbol}${BOT_QUOTE_ASSET}`;
  const filters = exchangeInfo && Array.isArray(exchangeInfo.filters) ? exchangeInfo.filters : [];
  const lotSize = findFilter(filters, 'LOT_SIZE');
  const stepSize = lotSize ? lotSize.stepSize : null;
  const price = Number(paperPosition.entry) || Number(paperPosition.currentPrice) || 0;
  const rawQuantity = price > 0 ? Number(paperPosition.positionUsd) / price : Number(paperPosition.quantity);
  let quantity = stepSize ? roundStep(rawQuantity, stepSize) : Number(rawQuantity);
  if (lotSize) {
    const minQty = Number(lotSize.minQty);
    if (Number.isFinite(minQty) && minQty > 0 && quantity < minQty) quantity = minQty;
  }
  const notionalCheck = validateMinNotional(price, quantity, filters);
  return { symbol, side: 'BUY', type: 'MARKET', quantity, stepSize, price, notionalCheck };
}

function getTestnetSafetyGate(paperPosition) {
  const env = process.env;
  const positionUsd = paperPosition ? Number(paperPosition.positionUsd) : 0;
  const maxPositionUsd = envNumber('BOT_MAX_POSITION_USD', 10);
  const maxOpenPositions = envNumber('BOT_MAX_OPEN_POSITIONS', 1);
  const openCount = botControlState.paperPosition && botControlState.paperPosition.status === 'open' ? 1 : 0;
  const checks = [
    { ok: env.BINANCE_ENV === 'testnet', reason: 'BINANCE_ENV must be testnet' },
    { ok: env.BOT_ALLOW_TESTNET_ORDERS === 'true', reason: 'BOT_ALLOW_TESTNET_ORDERS must be true' },
    { ok: env.BOT_TRADING_MODE !== 'live', reason: 'BOT_TRADING_MODE must not be live' },
    { ok: env.BOT_LIVE_TRADING_ENABLED !== 'true', reason: 'BOT_LIVE_TRADING_ENABLED must not be true' },
    { ok: env.BOT_ALLOW_REAL_ORDERS !== 'true', reason: 'BOT_ALLOW_REAL_ORDERS must not be true' },
    { ok: !!paperPosition, reason: 'an open paper position must exist' },
    { ok: !!paperPosition && paperPosition.status === 'open', reason: 'paper position must be open' },
    { ok: !!paperPosition && paperPosition.realOrderSubmitted === false, reason: 'paper position must not have a real order' },
    { ok: positionUsd > 0 && positionUsd <= maxPositionUsd, reason: 'positionUsd must be within BOT_MAX_POSITION_USD' },
    { ok: openCount <= 1 && maxOpenPositions <= 1, reason: 'max open positions must be <= 1' },
    { ok: !(paperPosition && paperPosition.smokeFallback && env.BOT_TESTNET_ALLOW_QUOTE_FALLBACK !== 'true'), reason: 'BOT_TESTNET_ALLOW_QUOTE_FALLBACK must be true for smoke fallback' },
    { ok: !(paperPosition && paperPosition.smokeFallback && paperPosition.quoteAsset !== BOT_TESTNET_SMOKE_QUOTE_ASSET), reason: 'smoke fallback must use USDT quote' },
  ];
  const failed = checks.find((check) => !check.ok);
  return failed ? { ok: false, reason: failed.reason } : { ok: true };
}

function isLiveTradingAllowed() {
  const config = getBotSafetyConfig();
  const binanceConfig = getBinanceConfigStatus();
  return process.env.BOT_TRADING_MODE === 'live'
    && envFlag('BOT_LIVE_TRADING_ENABLED')
    && envFlag('BOT_ALLOW_REAL_ORDERS')
    && config.binanceEnv === 'production'
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
    testnetExecutionEnabled: getTestnetExecutionEnabled(),
    testnetOrderSubmitted: Boolean(botControlState.testnetOrder),
    realOrderSubmitted: false,
    liveGateWouldPass: isLiveTradingAllowed(),
    safetyConfig: getBotSafetyConfig(),
    binanceConfig: getBinanceConfigStatus(),
    executionPreview,
    testnetOrder: botControlState.testnetOrder || null,
    testnetOrders: botControlState.testnetOrders || [],
    message: botControlState.message || 'PaperBot control skeleton is in safety mode. No trading engine is running.',
    candidate: botControlState.candidate,
    paperPosition: botControlState.paperPosition,
    closedTrades: botControlState.closedTrades,
    manualExecutionPlan: botControlState.manualExecutionPlan,
    realizedPnl: botControlState.realizedPnl,
    unrealizedPnl: botControlState.unrealizedPnl,
    executionIntent: botControlState.executionIntent || null,
    executionResults: botControlState.executionResults || [],
    events: botControlState.events,
    scanMeta: botControlState.scanMeta || null,
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

function scoreMarketsList(markets) {
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
  return candidates;
}

function scoreMarkets(markets) {
  return scoreMarketsList(markets)[0] || null;
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
    symbol: `${position.symbol}${BOT_QUOTE_ASSET}`,
    side: 'BUY',
    quoteAsset: BOT_QUOTE_ASSET,
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
    symbol: paperPosition.binanceSymbol || `${paperPosition.symbol}${BOT_QUOTE_ASSET}`,
    side: 'BUY',
    quoteAsset: paperPosition.quoteAsset || BOT_QUOTE_ASSET,
    positionUsd: paperPosition.positionUsd,
    entryReference: paperPosition.entry,
    stopLoss: paperPosition.stopLoss,
    takeProfit: paperPosition.takeProfit,
    realOrderSubmitted: false,
    testnetSymbolAvailable: paperPosition.testnetSymbolAvailable === true,
  };
  if (config.binanceEnv !== 'testnet') {
    return {
      ...basePreview,
      ...blockLiveExecution('Live execution is hard-blocked in this build. No Binance order submitted.'),
    };
  }
  return {
    ...basePreview,
    mode: paperPosition && paperPosition.smokeFallback ? 'testnet_smoke_ready' : 'testnet_ready',
    reason: 'Execution preview only. No Binance order submitted.',
    testnetExecutionEnabled: true,
    executionEnabled: false,
    realOrderSubmitted: false,
    productionReady: false,
    quoteAsset: paperPosition && paperPosition.smokeFallback ? BOT_TESTNET_SMOKE_QUOTE_ASSET : BOT_QUOTE_ASSET,
    productionQuoteAsset: BOT_QUOTE_ASSET
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
  }));
  return { events, paperPosition: nextPosition };
}

async function runDryRunScanFromMarkets(markets) {
  const events = [];

  const isTestnetEnv = process.env.BINANCE_ENV === 'testnet';
  const allowQuoteFallback = process.env.BOT_TESTNET_ALLOW_QUOTE_FALLBACK === 'true';
  const isTestnetConfigured = isTestnetEnv; // Keys no longer needed for public endpoints or UI
  const allowTestnetOrders = process.env.BOT_ALLOW_TESTNET_ORDERS === 'true';
  const allowFallback = process.env.BOT_TESTNET_ALLOW_COMPATIBLE_FALLBACK === 'true';
  
  let testnetSymbols = new Set();
  let testnetFilterActive = false;
  let exchangeInfoDebug = null;
  if (isTestnetConfigured && allowTestnetOrders) {
    const s = await getTestnetTradableSymbols(BOT_QUOTE_ASSET);
    if (s) testnetSymbols = s;
    testnetFilterActive = true;
    exchangeInfoDebug = await getTestnetExchangeInfoDebug();
  }

  const candidatesList = scoreMarketsList(markets);
  let bestCandidate = null;
  
  let skippedCount = 0;
  const topSkippedSymbols = [];

  for (const c of candidatesList) {
    if (c.score < 6) continue;
    
    if (testnetFilterActive) {
      const binanceSym = toBinanceQuoteSymbol(c.symbol);
      if (!testnetSymbols.has(binanceSym)) {
        skippedCount++;
        if (topSkippedSymbols.length < 5) topSkippedSymbols.push(binanceSym);
        events.push(event('TESTNET_SYMBOL_SKIPPED', 'warn', `Skipped ${c.symbol} because ${binanceSym} is not available on Binance Spot Testnet.`, {
          symbol: c.symbol,
          binanceSymbol: binanceSym,
          quoteAsset: BOT_QUOTE_ASSET,
          testnetSymbolAvailable: false
        }));
        continue;
      }
      c.binanceSymbol = binanceSym;
      c.quoteAsset = BOT_QUOTE_ASSET;
      c.testnetSymbolAvailable = true;
    }
    
    bestCandidate = c;
    break;
  }

  let fallbackAttempted = false;
  let fallbackSelected = false;
  let fallbackBlockedReason = null;
  let quoteFallbackAttempted = false;
  let quoteFallbackSelected = false;
  let quoteFallbackBlockedReason = null;

  if (!bestCandidate) {
    let fallbackCandidate = null;
    if (isTestnetConfigured && allowTestnetOrders && allowFallback && testnetFilterActive) {
      fallbackAttempted = true;
      for (const c of candidatesList) {
        if (!c.symbol || c.symbol === 'USDC' || c.symbol.includes('USDT') || c.symbol.includes('USDC')) continue;
        if (c.price <= 0) continue;
        const binanceSym = toBinanceQuoteSymbol(c.symbol);
        if (testnetSymbols.has(binanceSym)) {
          fallbackCandidate = c;
          break;
        }
      }
      if (!fallbackCandidate) {
        fallbackBlockedReason = "No /api/markets asset exists in Binance Spot Testnet USDC symbol set.";
        
        if (testnetSymbols.size === 0) {
          if (allowQuoteFallback) {
            quoteFallbackAttempted = true;
            const usdtSymbols = await getTestnetTradableSymbols(BOT_TESTNET_SMOKE_QUOTE_ASSET);
            if (!usdtSymbols || usdtSymbols.size === 0) {
              if (!exchangeInfoDebug) exchangeInfoDebug = await getTestnetExchangeInfoDebug();
              quoteFallbackBlockedReason = `No USDT symbols available on Binance Spot Testnet. exchangeInfo symbolsCount=${exchangeInfoDebug.symbolsCount}, firstSymbols=${JSON.stringify(exchangeInfoDebug.firstSymbols)}`;
            } else {
              const allowList = ['BTC', 'ETH', 'BNB', 'SOL', 'ADA', 'XRP', 'DOGE'];
              let selectedBase = allowList.find(base => usdtSymbols.has(`${base}${BOT_TESTNET_SMOKE_QUOTE_ASSET}`));
              if (!selectedBase) selectedBase = Array.from(usdtSymbols)[0].replace(BOT_TESTNET_SMOKE_QUOTE_ASSET, '');
              if (selectedBase) {
                try {
                  const priceData = await binancePublic('/v3/ticker/price', { symbol: `${selectedBase}${BOT_TESTNET_SMOKE_QUOTE_ASSET}` });
                  const price = parseFloat(priceData.price);
                  if (price > 0) {
                    quoteFallbackSelected = true;
                    fallbackCandidate = {
                      symbol: selectedBase,
                      price,
                      score: 0,
                      binanceSymbol: `${selectedBase}${BOT_TESTNET_SMOKE_QUOTE_ASSET}`,
                      quoteAsset: BOT_TESTNET_SMOKE_QUOTE_ASSET,
                      strategyFallback: true,
                      smokeFallback: true,
                      fallbackReason: "testnet_quote_fallback_adapter_validation",
                      testnetSymbolAvailable: true
                    };
                    events.push(event('TESTNET_SMOKE_QUOTE_FALLBACK_SELECTED', 'info', `Binance Spot Testnet returned 0 USDC pairs. Selected ${fallbackCandidate.binanceSymbol} using testnet-only USDT smoke fallback to validate order signing/execution. Production strategy remains USDC-only.`, {
                      fallbackCandidate
                    }));
                  } else {
                    quoteFallbackBlockedReason = "Ticker price returned zero for selected smoke symbol";
                  }
                } catch (e) {
                  quoteFallbackBlockedReason = "Ticker price unavailable for selected smoke symbol";
                }
              } else {
                quoteFallbackBlockedReason = "No base symbol could be extracted from USDT testnet pairs";
              }
            }
          } else {
            quoteFallbackBlockedReason = "BOT_TESTNET_ALLOW_QUOTE_FALLBACK is not true";
          }
        }
      }

      if (fallbackCandidate && !fallbackCandidate.smokeFallback) {
        fallbackSelected = true;
        fallbackCandidate.binanceSymbol = toBinanceQuoteSymbol(fallbackCandidate.symbol);
        fallbackCandidate.quoteAsset = BOT_QUOTE_ASSET;
        fallbackCandidate.testnetSymbolAvailable = true;
        fallbackCandidate.strategyFallback = true;
        events.push(event('TESTNET_COMPATIBLE_FALLBACK_SELECTED', 'info', `No high-score compatible setup found. Selected ${fallbackCandidate.binanceSymbol} as testnet-compatible fallback for adapter validation.`, {
          symbol: fallbackCandidate.symbol,
          binanceSymbol: fallbackCandidate.binanceSymbol
        }));
        bestCandidate = fallbackCandidate;
      } else if (fallbackCandidate && fallbackCandidate.smokeFallback) {
        fallbackSelected = true;
        bestCandidate = fallbackCandidate;
      }
    } else {
      if (!isTestnetConfigured) fallbackBlockedReason = "Testnet not configured";
      else if (!allowTestnetOrders) fallbackBlockedReason = "Testnet orders not allowed";
      else if (!allowFallback) fallbackBlockedReason = "Fallback not allowed by env";
      else if (!testnetFilterActive) fallbackBlockedReason = "Testnet filter not active";
    }

    if (!bestCandidate) {
      const topScore = candidatesList[0] ? candidatesList[0].score : 0;
      const topSym = candidatesList[0] ? candidatesList[0].symbol : null;
      const scanMeta = {
        testnetFallbackEnabled: allowFallback,
        testnetUsdcSymbolsCount: testnetSymbols ? testnetSymbols.size : 0,
        skippedCount,
        topSkippedSymbols,
        fallbackAttempted,
        fallbackSelected,
        fallbackBlockedReason,
        quoteFallbackEnabled: allowQuoteFallback,
        quoteFallbackAttempted,
        quoteFallbackSelected,
        quoteFallbackBlockedReason,
        smokeQuoteAsset: BOT_TESTNET_SMOKE_QUOTE_ASSET,
        exchangeInfoDebug,
        compatibleMarketSymbolsChecked: candidatesList.length
      };
      
      if (candidatesList.length > 0 && topScore >= 6) {
        events.push(event('MARKET_SCAN_SKIPPED', 'warn', `No flush/reclaim candidate passed both strategy filters and Binance Spot Testnet ${BOT_QUOTE_ASSET} symbol availability.`, {
          bestScore: topScore,
          symbol: topSym,
          ...scanMeta
        }));
      } else {
        events.push(event('MARKET_SCAN_SKIPPED', 'info', testnetFilterActive ? 'No Binance Spot Testnet USDC-compatible market from current /api/markets universe.' : 'No flush/reclaim candidate passed the minimum score.', {
          bestScore: topScore,
          symbol: topSym,
          ...scanMeta
        }));
      }
      
      events.push(event('RISK_CHECK_FAILED', 'warn', 'Risk check failed: candidate score below threshold or no testnet-compatible candidate exists.'));
      return { ok: true, status: 'safety', candidate: null, events, scanMeta };
    }
  }

  const scanMeta = {
    testnetFallbackEnabled: allowFallback,
    testnetUsdcSymbolsCount: testnetSymbols ? testnetSymbols.size : 0,
    skippedCount,
    topSkippedSymbols,
    fallbackAttempted,
    fallbackSelected,
    fallbackBlockedReason,
    quoteFallbackEnabled: allowQuoteFallback,
    quoteFallbackAttempted,
    quoteFallbackSelected,
    quoteFallbackBlockedReason,
    smokeQuoteAsset: BOT_TESTNET_SMOKE_QUOTE_ASSET,
    exchangeInfoDebug,
    compatibleMarketSymbolsChecked: candidatesList.length
  };

  const candidate = bestCandidate;

  if (!candidate.strategyFallback) {
    events.push(event('SIGNAL_FOUND', 'info', `Flush/reclaim signal found for ${candidate.symbol} with score ${candidate.score}.`, {
      candidate,
    }));
  }

  const risk = riskCheck(candidate);
  if (!risk.ok) {
    events.push(event('RISK_CHECK_FAILED', 'warn', `Risk check failed: ${risk.reason}.`));
    return { ok: true, status: 'safety', candidate, events };
  }

  events.push(event('RISK_CHECK_PASSED', 'info', 'Dry-run risk check passed. Trading remains disabled.'));
  const paperPosition = makePaperPosition(candidate);
  if (testnetFilterActive) {
    paperPosition.binanceSymbol = candidate.binanceSymbol;
    paperPosition.quoteAsset = candidate.quoteAsset;
    paperPosition.testnetSymbolAvailable = candidate.testnetSymbolAvailable;
    if (candidate.strategyFallback) {
      paperPosition.strategyFallback = true;
      if (candidate.smokeFallback) {
        paperPosition.smokeFallback = true;
        paperPosition.fallbackReason = candidate.fallbackReason;
        paperPosition.quoteAsset = candidate.quoteAsset;
      }
      paperPosition.takeProfit = Number((paperPosition.entry * 1.10).toFixed(4));
    }
  }

  const manualExecutionPlan = makeManualExecutionPlan(paperPosition);
  events.push(event('PAPER_POSITION_OPENED', 'info', `Dry-run paper position opened for ${candidate.symbol}. No real order submitted.`, {
    paperPosition,
  }));
  events.push(event('MANUAL_EXECUTION_PLAN_READY', 'info', `Manual Binance trade plan ready for ${candidate.symbol}. No order was submitted by this app.`, {
    manualExecutionPlan,
  }));
  return { ok: true, status: 'paper_position_open', candidate, paperPosition, manualExecutionPlan, events, scanMeta };
}

function routeName(req) {
  const url = new URL(req.url);
  return url.pathname.replace(/^\/api\/bot\/?/, '') || 'state';
}

function blockTestnetOrder(req, auth, reason, extra = {}) {
  const blockEvent = event('TESTNET_ORDER_BLOCKED', 'warn', `Testnet order blocked: ${reason}.`);
  botControlState = {
    ...botControlState,
    events: [blockEvent, ...botControlState.events].slice(0, 30),
    updatedAt: blockEvent.ts,
  };
  return json(req, publicState({
    testnetOrderSubmitted: false,
    realOrderSubmitted: false,
    executionEnabled: false,
    blockedReason: reason,
    events: [blockEvent],
    authMode: auth.authMode,
    ...extra,
  }));
}

async function validatePaperPositionForTestnet(paperPosition) {
  if (!paperPosition || paperPosition.status !== 'open') {
    return { ok: false, reason: 'No open paper position.' };
  }
  const quoteAsset = paperPosition.smokeFallback ? BOT_TESTNET_SMOKE_QUOTE_ASSET : BOT_QUOTE_ASSET;
  const symbol = toBinanceQuoteSymbol(paperPosition.symbol, quoteAsset);
  
  const isTestnetEnv = process.env.BINANCE_ENV === 'testnet';
  if (isTestnetEnv) {
    const testnetSymbols = await getTestnetTradableSymbols(quoteAsset);
    if (testnetSymbols && !testnetSymbols.has(symbol)) {
      return { ok: false, reason: `Symbol ${symbol} is not available on Binance Spot Testnet. Clear the paper position and run Wake Bot again.`, symbol };
    }
  }
  
  return { ok: true, symbol };
}

async function handleTestnetOrder(req, auth) {
  const blockEvent = event('TESTNET_ORDER_BLOCKED', 'warn', `Direct Netlify Binance execution is disabled. Use Create Testnet Intent and local worker.`);
  botControlState = {
    ...botControlState,
    events: [blockEvent, ...botControlState.events].slice(0, 30),
    updatedAt: blockEvent.ts,
  };
  return json(req, publicState({
    testnetOrderSubmitted: false,
    realOrderSubmitted: false,
    executionEnabled: false,
    blockedReason: 'Direct Netlify Binance execution is disabled. Use Create Testnet Intent and local worker.',
    events: [blockEvent],
    authMode: auth.authMode,
  }));
}

function isWorkerRoute(route) {
  return route === 'execution-intent' || route === 'execution-result';
}

function checkWorkerToken(req) {
  const expected = process.env.BOT_WORKER_TOKEN || '';
  const provided = req.headers.get('x-bot-worker-token') || '';
  return Boolean(expected && provided && provided === expected);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  const route = routeName(req);
  let auth = { ok: true, authMode: 'worker' };

  if (isWorkerRoute(route)) {
    if (!checkWorkerToken(req)) {
      return json(req, { ok: false, error: 'Forbidden', reason: 'Invalid or missing X-BOT-WORKER-TOKEN' }, 403);
    }
  } else {
    const origin = checkOrigin(req);
    if (!origin.ok) {
      return json(req, { ok: false, error: 'Origin not allowed', reason: origin.reason }, 403);
    }

    auth = await verifyAuth(req);
    if (!auth.ok) {
      return json(req, { ok: false, error: 'Unauthorized', reason: auth.reason, authMode: auth.authMode }, auth.status || 401);
    }
  }
  if (route === 'state') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    return json(req, publicState({ authMode: auth.authMode }));
  }

  if (route === 'testnet-exchange-info-debug') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    const debugInfo = await getTestnetExchangeInfoDebug();
    return json(req, debugInfo);
  }

  if (route === 'execution-intent') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    let intent = botControlState.executionIntent;
    if (intent && intent.status === 'pending') {
      if (new Date(intent.expiresAt).getTime() < Date.now()) {
        intent.status = 'expired';
        botControlState.executionIntent = intent;
        intent = null;
      } else {
        intent.status = 'claimed';
        botControlState.executionIntent = intent;
      }
    } else if (intent && intent.status === 'claimed') {
      if (new Date(intent.expiresAt).getTime() < Date.now()) {
        intent.status = 'expired';
        botControlState.executionIntent = intent;
      }
      intent = null;
    } else {
      intent = null;
    }
    return json(req, { ok: true, intent });
  }

  if (route !== 'wake' && route !== 'stop' && route !== 'testnet-order' && route !== 'clear-paper-position' && route !== 'create-execution-intent' && route !== 'execution-result') {
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
  if (route === 'create-execution-intent') {
    const isTestnetEnv = process.env.BINANCE_ENV === 'testnet';
    const allowTestnetOrders = process.env.BOT_ALLOW_TESTNET_ORDERS === 'true';
    const liveTradingEnabled = process.env.BOT_LIVE_TRADING_ENABLED === 'true';
    const allowRealOrders = process.env.BOT_ALLOW_REAL_ORDERS === 'true';
    const maxPositionUsd = envNumber('BOT_MAX_POSITION_USD', 10);
    
    if (liveTradingEnabled || allowRealOrders) {
      return json(req, { ok: false, error: 'Live trading flags are active. Cannot create testnet intent.' }, 403);
    }
    if (!isTestnetEnv || !allowTestnetOrders) {
      return json(req, { ok: false, error: 'Testnet execution is not allowed.' }, 403);
    }
    
    const paperPosition = botControlState.paperPosition;
    if (!paperPosition) {
      return json(req, { ok: false, error: 'No open paper position.' }, 400);
    }
    if (paperPosition.realOrderSubmitted) {
      return json(req, { ok: false, error: 'Real order already submitted.' }, 400);
    }
    if (!paperPosition.testnetSymbolAvailable && !paperPosition.smokeFallback) {
      return json(req, { ok: false, error: 'Position not compatible with testnet.' }, 400);
    }
    if (paperPosition.positionUsd > maxPositionUsd) {
      return json(req, { ok: false, error: `Position size exceeds maximum allowed (${maxPositionUsd} USD).` }, 400);
    }

    if (botControlState.executionIntent && (botControlState.executionIntent.status === 'pending' || botControlState.executionIntent.status === 'claimed')) {
      if (new Date(botControlState.executionIntent.expiresAt).getTime() > Date.now()) {
        return json(req, { ok: false, error: 'An execution intent is already pending or claimed.' }, 409);
      }
    }

    const intentId = `intent_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const quoteAsset = paperPosition.smokeFallback ? BOT_TESTNET_SMOKE_QUOTE_ASSET : BOT_QUOTE_ASSET;
    const binanceSym = toBinanceQuoteSymbol(paperPosition.symbol, quoteAsset);
    const idempotencyKey = `paperbot_${binanceSym}_${Date.now()}`;

    if (botControlState.usedIdempotencyKeys && botControlState.usedIdempotencyKeys.includes(idempotencyKey)) {
      return json(req, { ok: false, error: 'Idempotency key already used.' }, 409);
    }

    const intent = {
      id: intentId,
      idempotencyKey,
      mode: 'testnet',
      symbol: binanceSym,
      side: paperPosition.side === 'LONG' ? 'BUY' : 'SELL',
      type: 'MARKET',
      positionUsd: paperPosition.positionUsd,
      entryReference: paperPosition.entry,
      stopLoss: paperPosition.stopLoss,
      takeProfit: paperPosition.takeProfit,
      quoteAsset,
      productionQuoteAsset: BOT_QUOTE_ASSET,
      smokeFallback: paperPosition.smokeFallback || false,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120 * 1000).toISOString(), // 120 seconds expiry
      status: 'pending',
      realOrderSubmitted: false
    };

    botControlState.executionIntent = intent;
    const createEvent = event('TESTNET_EXECUTION_INTENT_CREATED', 'info', `Testnet execution intent created for ${binanceSym}. Waiting for local worker.`, { intentId });
    botControlState.events = [createEvent, ...botControlState.events].slice(0, 30);
    botControlState.updatedAt = createEvent.ts;

    return json(req, publicState({
      ok: true,
      executionIntent: intent,
      events: [createEvent]
    }));
  }

  if (route === 'execution-result') {
    if (!body || !body.id || !body.idempotencyKey || !body.status) {
      return json(req, { ok: false, error: 'Invalid payload' }, 400);
    }
    
    const intent = botControlState.executionIntent;
    if (!intent || (intent.status !== 'pending' && intent.status !== 'claimed')) {
      return json(req, { ok: false, error: 'No active intent found.' }, 400);
    }
    if (new Date(intent.expiresAt).getTime() < Date.now()) {
      intent.status = 'expired';
      return json(req, { ok: false, error: 'Intent has expired.' }, 400);
    }
    if (body.id !== intent.id || body.idempotencyKey !== intent.idempotencyKey) {
      return json(req, { ok: false, error: 'Intent mismatch.' }, 400);
    }
    if (botControlState.usedIdempotencyKeys && botControlState.usedIdempotencyKeys.includes(body.idempotencyKey)) {
      return json(req, { ok: false, error: 'Idempotency key already processed.' }, 409);
    }
    if (body.testnet !== true || body.realProductionOrder !== false) {
      return json(req, { ok: false, error: 'Invalid safety payload.' }, 400);
    }

    intent.status = body.status === 'failed' ? 'failed' : 'submitted';
    if (!botControlState.usedIdempotencyKeys) botControlState.usedIdempotencyKeys = [];
    botControlState.usedIdempotencyKeys.push(body.idempotencyKey);
    
    const execResult = {
      ...body,
      receivedAt: new Date().toISOString()
    };
    if (!botControlState.executionResults) botControlState.executionResults = [];
    botControlState.executionResults = [execResult, ...botControlState.executionResults].slice(0, 20);

    const resultEvent = body.status === 'failed' 
      ? event('TESTNET_ORDER_FAILED_BY_LOCAL_WORKER', 'warn', `Local worker failed to execute order: ${body.error || 'Unknown error'}`)
      : event('TESTNET_ORDER_SUBMITTED_BY_LOCAL_WORKER', 'info', `Local worker submitted testnet order ${body.orderId} for ${body.symbol}.`);
      
    botControlState.events = [resultEvent, ...botControlState.events].slice(0, 30);
    botControlState.updatedAt = resultEvent.ts;

    return json(req, publicState({
      ok: true,
      events: [resultEvent]
    }));
  }
  if (route === 'testnet-order') {
    return await handleTestnetOrder(req, auth);
  }

  if (route === 'clear-paper-position') {
    const clearEvent = event('PAPER_POSITION_CLEARED', 'info', 'Open paper position cleared by user.');
    botControlState = {
      ...botControlState,
      paperPosition: null,
      manualExecutionPlan: null,
      executionPreview: null,
      unrealizedPnl: 0,
      events: [clearEvent, ...botControlState.events].slice(0, 30),
      updatedAt: clearEvent.ts,
    };
    return json(req, publicState({
      ok: true,
      status: 'safety',
      paperPosition: null,
      message: 'Open paper position cleared. Run Wake Bot again to scan for a testnet-compatible USDC setup.',
      events: [clearEvent],
      realOrderSubmitted: false,
      testnetOrderSubmitted: false,
      authMode: auth.authMode,
    }));
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
      const valid = await validatePaperPositionForTestnet(botControlState.paperPosition);
      if (!valid.ok) {
        const invalidEvent = event('PAPER_POSITION_INVALIDATED', 'warn', `Previous paper position was not available on Binance Spot Testnet ${BOT_QUOTE_ASSET} pairs and was cleared before scanning.`);
        botControlState.paperPosition = null;
        botControlState.manualExecutionPlan = null;
        botControlState.executionPreview = null;
        botControlState.unrealizedPnl = 0;
        
        marketEvents.push(invalidEvent);
        result = await runDryRunScanFromMarkets(markets);
        result.events = [...marketEvents, ...result.events];
      } else {
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
      }
    } else {
      result = await runDryRunScanFromMarkets(markets);
      result.events = [...marketEvents, ...result.events];
    }
    
    if (result.scanMeta) {
      botControlState.scanMeta = result.scanMeta;
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
