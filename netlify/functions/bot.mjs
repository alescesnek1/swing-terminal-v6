import crypto from 'node:crypto';
import { getIdentity, isAdmin, canControlSession } from './_auth.mjs';
import { loadFleet, saveFleet, fleetBackend } from './_fleet-store.mjs';
import { computeMarketRegime } from './_market-regime.mjs';

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
  // On-demand local worker session (testnet only). Replaces persistent daemon model.
  botSession: null,
  workerStatus: null,
  positionResults: [],
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

function workerOnline() {
  const ws = botControlState.workerStatus;
  if (!ws || !ws.lastSeenAt) return false;
  const last = new Date(ws.lastSeenAt).getTime();
  return Number.isFinite(last) && (Date.now() - last) < 20000;
}

function publicSession() {
  const session = botControlState.botSession;
  if (!session) return null;
  // Never leak anything sensitive; session holds no secrets by design.
  return {
    sessionId: session.sessionId,
    status: session.status,
    mode: session.mode,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    stopRequested: session.stopRequested === true,
    closePositionsOnStop: session.closePositionsOnStop !== false,
    realOrderSubmitted: false,
  };
}

function publicState(extra = {}) {
  const mode = getTradingMode() || 'dry_run';
  const executionPreview = buildExecutionPreview(botControlState.paperPosition);
  const base = {
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
    botSession: publicSession(),
    positionResults: botControlState.positionResults || [],
    events: botControlState.events,
    scanMeta: botControlState.scanMeta || null,
  };

  if (botControlState.workerStatus) {
    base.workerStatus = {
      ...botControlState.workerStatus,
      online: workerOnline(),
    };
  }

  return { ...base, ...extra };
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

// ══════════════════════════════════════════════════════════════════════════
// Bot Fleet Manager — multi-session, per-user, durable (Netlify Blobs) state.
// TESTNET ONLY. No Binance secrets here; no signing here; live trading locked.
// ══════════════════════════════════════════════════════════════════════════

const WORKER_ONLINE_MS = 20000;
const INTENT_TTL_MS = 120 * 1000;
const SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 3;
const TESTNET_MAX_TRADE_USD = 10;
const FLEET_COMMAND_TYPES = new Set(['STOP', 'PAUSE', 'RESUME', 'EMERGENCY_CLOSE']);
const STALE_SESSION_STATUSES = new Set(['launch_requested', 'launching', 'stopping', 'stop_requested', 'launch_failed']);
const STALE_LAUNCH_STATUSES = new Set(['launch_requested', 'launching', 'launch_failed']);
const STALE_STOPPING_STATUSES = new Set(['stopping', 'stop_requested']);
const CLEARED_ACTIVE_EXCLUDED_STATUSES = new Set(['cleared', 'stopped', 'launch_failed', 'expired']);

const DEFAULT_BOT_CONFIG = {
  minTradeUsd: 5,
  maxTradeUsd: 10,
  maxDailyLossUsd: 3,
  maxDailyTrades: 5,
  maxOpenPositions: 1,
  stopLossPct: 3,
  takeProfitPct: 15,
  pauseOnMarketCrash: true,
  allowTestnet: true,
  allowLive: false,
};

// Coerce a possibly-string value to a finite number. Missing/blank -> fallback.
// Present-but-not-finite (NaN/Infinity/garbage) -> push an error and use fallback.
function coerceNum(raw, fallback, label, errors, integer) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  let n = Number(raw);
  if (!Number.isFinite(n)) { errors.push(`${label} must be a finite number`); return fallback; }
  if (integer) n = Math.floor(n);
  return n;
}

// Server-side hard validation. Returns { ok, errors, config }.
function validateBotConfig(input) {
  const src = input && typeof input === 'object' ? input : {};
  const errors = [];
  const c = {
    minTradeUsd: coerceNum(src.minTradeUsd, DEFAULT_BOT_CONFIG.minTradeUsd, 'minTradeUsd', errors),
    maxTradeUsd: coerceNum(src.maxTradeUsd, DEFAULT_BOT_CONFIG.maxTradeUsd, 'maxTradeUsd', errors),
    maxDailyLossUsd: coerceNum(src.maxDailyLossUsd, DEFAULT_BOT_CONFIG.maxDailyLossUsd, 'maxDailyLossUsd', errors),
    maxDailyTrades: coerceNum(src.maxDailyTrades, DEFAULT_BOT_CONFIG.maxDailyTrades, 'maxDailyTrades', errors, true),
    maxOpenPositions: coerceNum(src.maxOpenPositions, DEFAULT_BOT_CONFIG.maxOpenPositions, 'maxOpenPositions', errors, true),
    stopLossPct: coerceNum(src.stopLossPct, DEFAULT_BOT_CONFIG.stopLossPct, 'stopLossPct', errors),
    takeProfitPct: coerceNum(src.takeProfitPct, DEFAULT_BOT_CONFIG.takeProfitPct, 'takeProfitPct', errors),
    pauseOnMarketCrash: src.pauseOnMarketCrash !== false,
    allowTestnet: true, // forced for testnet phase
    allowLive: false,   // hard-locked
  };
  if (!(c.minTradeUsd >= 1)) errors.push('minTradeUsd must be >= 1');
  if (!(c.maxTradeUsd >= 1)) errors.push('maxTradeUsd must be >= 1');
  if (!(c.maxTradeUsd <= TESTNET_MAX_TRADE_USD)) errors.push(`maxTradeUsd must be <= ${TESTNET_MAX_TRADE_USD} for testnet phase`);
  if (!(c.minTradeUsd <= c.maxTradeUsd)) errors.push('minTradeUsd must be <= maxTradeUsd');
  if (!(c.maxDailyLossUsd >= 0)) errors.push('maxDailyLossUsd must be >= 0');
  if (!(c.maxDailyTrades >= 1)) errors.push('maxDailyTrades must be >= 1');
  if (!(c.maxOpenPositions >= 1 && c.maxOpenPositions <= 5)) errors.push('maxOpenPositions must be between 1 and 5');
  if (!(c.stopLossPct > 0 && c.stopLossPct <= 50)) errors.push('stopLossPct must be > 0 (<= 50)');
  if (!(c.takeProfitPct > 0 && c.takeProfitPct <= 100)) errors.push('takeProfitPct must be > 0 (<= 100)');
  return { ok: errors.length === 0, errors, config: c };
}

function completeBotConfig(input) {
  const v = validateBotConfig(input);
  return v.ok ? v.config : { ...DEFAULT_BOT_CONFIG };
}

function getUserConfig(fleet, userId) {
  const stored = fleet.botConfigs && fleet.botConfigs[userId];
  return completeBotConfig(stored || DEFAULT_BOT_CONFIG);
}

function fevent(fleet, type, severity, message, extra = {}) {
  const ev = { type, severity, message, ts: new Date().toISOString(), ...extra };
  fleet.events = [ev, ...(fleet.events || [])].slice(0, 80);
  return ev;
}

function workerIsOnline(ws) {
  if (!ws || !ws.lastSeenAt) return false;
  const last = new Date(ws.lastSeenAt).getTime();
  return Number.isFinite(last) && (Date.now() - last) < WORKER_ONLINE_MS && ws.status !== 'offline';
}

function sessionWorkerStatus(fleet, session) {
  if (!session) return null;
  if (session.workerId && fleet.workerStatuses && fleet.workerStatuses[session.workerId]) {
    return fleet.workerStatuses[session.workerId];
  }
  const statuses = Object.values((fleet && fleet.workerStatuses) || {})
    .filter((ws) => ws && ws.sessionId === session.sessionId)
    .sort((a, b) => new Date(b.lastSeenAt || 0).getTime() - new Date(a.lastSeenAt || 0).getTime());
  return statuses[0] || null;
}

function sessionOpenPositions(fleet, sessionId) {
  const positions = ((fleet && fleet.positionResults && fleet.positionResults[sessionId]) || []);
  return positions.filter((p) => p && p.status === 'open');
}

function sessionAgeMs(session, now) {
  const ts = new Date(session.updatedAt || session.createdAt || 0).getTime();
  return Number.isFinite(ts) ? now - ts : Infinity;
}

function isSessionStaleNoWorker(session, fleet, now = Date.now()) {
  if (!session || !STALE_SESSION_STATUSES.has(session.status)) return false;
  const ws = sessionWorkerStatus(fleet, session);
  if (workerIsOnline(ws)) return false;
  if (sessionOpenPositions(fleet, session.sessionId).length > 0) return false;
  const age = sessionAgeMs(session, now);
  if (STALE_LAUNCH_STATUSES.has(session.status)) return age > 60000;
  if (STALE_STOPPING_STATUSES.has(session.status)) return age > 30000;
  return false;
}

function canClearNoWorkerNoPosition(session, fleet) {
  if (!session || !STALE_SESSION_STATUSES.has(session.status)) return false;
  const ws = sessionWorkerStatus(fleet, session);
  return !workerIsOnline(ws) && sessionOpenPositions(fleet, session.sessionId).length === 0;
}

function clearStaleSession(fleet, sessionId, identity, reason) {
  const session = fleet.botSessions && fleet.botSessions[sessionId];
  if (!session) return null;
  const nowIso = new Date().toISOString();
  session.status = 'cleared';
  session.stopRequested = true;
  session.closePositionsOnStop = false;
  session.updatedAt = nowIso;
  session.clearedAt = nowIso;
  session.clearedReason = reason;
  if (fleet.executionIntents[sessionId] && ['pending', 'claimed'].includes(fleet.executionIntents[sessionId].status)) {
    fleet.executionIntents[sessionId].status = 'cancelled';
  }
  fleet.commandQueue[sessionId] = [];
  const actor = identity && (identity.email || identity.userId) ? (identity.email || identity.userId) : 'system';
  fevent(fleet, 'WORKER_SESSION_STALE_CLEARED', 'warn',
    `Cleared stale no-worker session ${sessionId.slice(0, 12)} (${reason}) by ${actor}.`,
    { sessionId, ownerUserId: session.ownerUserId, clearedReason: reason });
  return session;
}

function launchUrlForSession(req, sessionId) {
  const controlUrl = requestOrigin(req) || getAllowedOrigins()[0] || 'https://swing-terminal-v6.netlify.app';
  return {
    controlUrl,
    launchUrl: `swingworker://start?session=${encodeURIComponent(sessionId)}&control=${encodeURIComponent(controlUrl)}`,
  };
}

function publicSessionView(fleet, session) {
  if (!session) return null;
  const ws = sessionWorkerStatus(fleet, session);
  const results = fleet.executionResults[session.sessionId] || [];
  const positions = fleet.positionResults[session.sessionId] || [];
  const openPositions = positions.filter((p) => p && p.status === 'open');
  const realizedPnl = results.reduce((acc, r) => acc + (Number(r.realizedPnl) || 0), 0);
  const now = Date.now();
  return {
    sessionId: session.sessionId,
    ownerUserId: session.ownerUserId,
    ownerEmail: session.ownerEmail,
    orgId: session.orgId,
    workerId: session.workerId || null,
    mode: 'testnet',
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    stopRequested: session.stopRequested === true,
    pauseRequested: session.pauseRequested === true,
    closePositionsOnStop: session.closePositionsOnStop !== false,
    clearedAt: session.clearedAt || null,
    clearedReason: session.clearedReason || null,
    isStaleNoWorker: isSessionStaleNoWorker(session, fleet, now),
    riskState: session.riskState || null,
    config: completeBotConfig(session.config),
    realOrderSubmitted: false,
    worker: ws ? {
      workerId: ws.workerId,
      platform: ws.platform,
      hostname: ws.hostname,
      currentState: ws.currentState,
      lastSeenAt: ws.lastSeenAt,
      online: workerIsOnline(ws),
    } : null,
    openPositions,
    positionResults: positions.slice(0, 20),
    executionResults: results.slice(0, 10),
    realizedPnl,
  };
}

function sessionsVisibleTo(fleet, identity) {
  const all = Object.values(fleet.botSessions || {});
  // Org-wide admin visibility requires a cryptographically verified token.
  const admin = isAdmin(identity) && identity.verified === true;
  return all.filter((s) => {
    if (s.ownerUserId === identity.userId) return true;
    return admin && (s.orgId || 'default') === (identity.orgId || 'default');
  });
}

function expireStaleIntent(fleet, sessionId) {
  const intent = fleet.executionIntents[sessionId];
  if (intent && (intent.status === 'pending' || intent.status === 'claimed')) {
    if (new Date(intent.expiresAt).getTime() < Date.now()) {
      intent.status = 'expired';
      fleet.executionIntents[sessionId] = intent;
    }
  }
}

function queueCommand(fleet, sessionId, type, createdBy) {
  if (!FLEET_COMMAND_TYPES.has(type)) return null;
  if (!fleet.commandQueue[sessionId]) fleet.commandQueue[sessionId] = [];
  const cmd = { id: `cmd_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`, type, createdAt: new Date().toISOString(), createdBy };
  fleet.commandQueue[sessionId].push(cmd);
  fleet.commandQueue[sessionId] = fleet.commandQueue[sessionId].slice(-20);
  return cmd;
}

function bodySessionId(req, body) {
  const url = new URL(req.url);
  return url.searchParams.get('sessionId') || (body && body.sessionId) || '';
}
function bodyWorkerId(req, body) {
  const url = new URL(req.url);
  return url.searchParams.get('workerId') || (body && body.workerId) || '';
}

// ── Worker-facing fleet routes (X-BOT-WORKER-TOKEN + sessionId required) ──────
async function handleFleetWorker(req, base, body) {
  const sessionId = bodySessionId(req, body);
  if (!sessionId) {
    return json(req, { ok: false, error: 'sessionId is required for worker endpoints' }, 400);
  }

  const fleet = await loadFleet();
  const session = fleet.botSessions[sessionId];

  // worker-heartbeat: bind worker, persist liveness, return control flags.
  if (base === 'worker-heartbeat') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    const workerId = bodyWorkerId(req, body);
    if (!workerId) return json(req, { ok: false, error: 'workerId is required' }, 400);

    const nowIso = new Date().toISOString();
    fleet.workerStatuses[workerId] = {
      workerId,
      sessionId,
      ownerUserId: session ? session.ownerUserId : null,
      platform: typeof body.platform === 'string' ? body.platform.slice(0, 60) : null,
      hostname: typeof body.hostname === 'string' ? body.hostname.slice(0, 120) : null,
      status: body.status === 'offline' ? 'offline' : 'online',
      lastSeenAt: nowIso,
      mode: 'testnet',
      currentState: typeof body.currentState === 'string' ? body.currentState.slice(0, 60) : null,
      pid: Number.isFinite(Number(body.pid)) ? Number(body.pid) : null,
      realProductionOrder: false,
    };

    if (!session) {
      // Orphan worker (session gone): tell it to stop gracefully.
      await saveFleet(fleet);
      return json(req, { ok: true, sessionKnown: false, stopRequested: true, closePositionsOnStop: true, pauseRequested: false });
    }

    session.workerId = workerId;
    const cs = fleet.workerStatuses[workerId].currentState;
    if (cs === 'stopped') session.status = 'stopped';
    else if (cs === 'stopping') session.status = 'stopping';
    else if (session.stopRequested) session.status = 'stopping';
    else if (session.pauseRequested) session.status = 'paused';
    else if (session.status === 'launch_requested' || session.status === 'running' || session.status === 'paused') {
      session.status = session.pauseRequested ? 'paused' : 'running';
    }
    session.updatedAt = nowIso;
    await saveFleet(fleet);
    return json(req, {
      ok: true,
      sessionKnown: true,
      stopRequested: session.stopRequested === true,
      pauseRequested: session.pauseRequested === true,
      closePositionsOnStop: session.closePositionsOnStop !== false,
    });
  }

  if (!session) {
    return json(req, { ok: false, error: 'Unknown session', stopRequested: true }, 404);
  }

  // worker-session: the ONLY place a worker receives an intent (per-session).
  if (base === 'worker-session') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    expireStaleIntent(fleet, sessionId);
    let intent = fleet.executionIntents[sessionId] || null;
    // Claim a pending intent for this session only. Never opens entries while paused/stopping.
    if (intent && intent.status === 'pending') {
      if (session.stopRequested || session.pauseRequested) {
        intent = null; // do not hand out entries while paused/stopping
      } else if (new Date(intent.expiresAt).getTime() < Date.now()) {
        fleet.executionIntents[sessionId].status = 'expired';
        intent = null;
      } else {
        fleet.executionIntents[sessionId].status = 'claimed';
        intent = fleet.executionIntents[sessionId];
      }
    } else if (intent && intent.status !== 'claimed') {
      intent = null;
    } else if (intent && intent.status === 'claimed' && (session.stopRequested || session.pauseRequested)) {
      intent = null;
    }

    const commands = (fleet.commandQueue[sessionId] || []).filter((c) => !c.consumedAt);
    await saveFleet(fleet);
    return json(req, {
      ok: true,
      session: {
        sessionId: session.sessionId,
        status: session.status,
        mode: 'testnet',
        stopRequested: session.stopRequested === true,
        pauseRequested: session.pauseRequested === true,
        closePositionsOnStop: session.closePositionsOnStop !== false,
        riskState: session.riskState || null,
      },
      config: completeBotConfig(session.config),
      commands,
      intent: intent && intent.status === 'claimed' ? intent : null,
      stopRequested: session.stopRequested === true,
      pauseRequested: session.pauseRequested === true,
      closePositionsOnStop: session.closePositionsOnStop !== false,
    });
  }

  // worker-command-ack: mark commands consumed.
  if (base === 'worker-command-ack') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    const ids = Array.isArray(body.commandIds) ? body.commandIds : (body.commandId ? [body.commandId] : []);
    const q = fleet.commandQueue[sessionId] || [];
    for (const c of q) {
      if (ids.includes(c.id)) c.consumedAt = new Date().toISOString();
    }
    fleet.commandQueue[sessionId] = q.filter((c) => !c.consumedAt);
    await saveFleet(fleet);
    return json(req, { ok: true });
  }

  // execution-result: per-session idempotency.
  if (base === 'execution-result') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    if (!body.id || !body.idempotencyKey || !body.status) return json(req, { ok: false, error: 'Invalid payload' }, 400);
    if (body.testnet !== true || body.realProductionOrder !== false) return json(req, { ok: false, error: 'Invalid safety payload' }, 400);

    const intent = fleet.executionIntents[sessionId];
    if (intent && body.id === intent.id) {
      intent.status = body.status === 'failed' ? 'failed' : 'submitted';
    }
    if (!fleet.usedIdempotencyKeys[sessionId]) fleet.usedIdempotencyKeys[sessionId] = [];
    if (fleet.usedIdempotencyKeys[sessionId].includes(body.idempotencyKey)) {
      await saveFleet(fleet);
      return json(req, { ok: false, error: 'Idempotency key already processed' }, 409);
    }
    fleet.usedIdempotencyKeys[sessionId].push(body.idempotencyKey);
    fleet.usedIdempotencyKeys[sessionId] = fleet.usedIdempotencyKeys[sessionId].slice(-100);

    if (!fleet.executionResults[sessionId]) fleet.executionResults[sessionId] = [];
    fleet.executionResults[sessionId] = [{ ...body, sessionId, receivedAt: new Date().toISOString() }, ...fleet.executionResults[sessionId]].slice(0, 20);
    fevent(fleet, body.status === 'failed' ? 'TESTNET_ORDER_FAILED' : 'TESTNET_ORDER_SUBMITTED',
      body.status === 'failed' ? 'warn' : 'info',
      body.status === 'failed' ? `Worker order failed: ${body.error || 'unknown'}` : `Worker submitted testnet order ${body.orderId} for ${body.symbol}.`,
      { sessionId, ownerUserId: session.ownerUserId });
    await saveFleet(fleet);
    return json(req, { ok: true });
  }

  // position-result: open/close reports.
  if (base === 'position-result') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    if (!body.symbol || !body.status) return json(req, { ok: false, error: 'Invalid payload' }, 400);
    const record = {
      symbol: String(body.symbol).toUpperCase().slice(0, 20),
      baseAsset: typeof body.baseAsset === 'string' ? body.baseAsset.slice(0, 20) : null,
      executedQty: body.executedQty != null ? String(body.executedQty).slice(0, 40) : null,
      orderId: body.orderId != null ? String(body.orderId).slice(0, 40) : null,
      closeOrderId: body.closeOrderId != null ? String(body.closeOrderId).slice(0, 40) : null,
      status: String(body.status).slice(0, 30),
      sessionId,
      error: typeof body.error === 'string' ? body.error.slice(0, 240) : null,
      testnet: true,
      realProductionOrder: false,
      receivedAt: new Date().toISOString(),
    };
    if (!fleet.positionResults[sessionId]) fleet.positionResults[sessionId] = [];
    fleet.positionResults[sessionId] = [record, ...fleet.positionResults[sessionId]].slice(0, 30);
    const sev = record.status === 'WORKER_CLOSE_FAILED' ? 'warn' : 'info';
    fevent(fleet, record.status === 'closed' ? 'WORKER_POSITION_CLOSED' : record.status === 'WORKER_CLOSE_FAILED' ? 'WORKER_CLOSE_FAILED' : 'WORKER_POSITION_OPEN', sev,
      `${record.status} ${record.symbol} (session ${sessionId.slice(0, 12)})`, { sessionId, ownerUserId: session.ownerUserId });
    await saveFleet(fleet);
    return json(req, { ok: true });
  }

  return json(req, { ok: false, error: 'Not Found' }, 404);
}

// ── Browser-facing fleet routes (Origin + identity; owner/admin authz) ────────
async function handleFleetBrowser(req, base, segments, identity, body) {
  // POST /api/bot/create-worker-pairing-code
  // Mints a short-lived, single-use pairing code for first-time worker install.
  // Owner-only: the code is bound to the caller's identity. No secrets returned.
  if (base === 'create-worker-pairing-code') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    if (process.env.BINANCE_ENV !== 'testnet') {
      return json(req, { ok: false, error: 'Worker install requires BINANCE_ENV=testnet.' }, 403);
    }
    if (process.env.BOT_LIVE_TRADING_ENABLED === 'true' || process.env.BOT_ALLOW_REAL_ORDERS === 'true') {
      return json(req, { ok: false, error: 'Live trading flags are active. Worker install is disabled.' }, 403);
    }
    const store = await loadPairings();
    prunePairings(store);
    const code = crypto.randomBytes(24).toString('base64url'); // ~32 chars, high entropy
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
    store.codes[code] = {
      code,
      ownerUserId: identity.userId,
      ownerEmail: identity.email || null,
      orgId: identity.orgId || 'default',
      createdAt,
      expiresAt,
      usedAt: null,
      platform: null,
      status: 'active',
    };
    await savePairings(store);
    const origin = selfOrigin(req);
    return json(req, {
      ok: true,
      pairingCode: code,
      expiresAt,
      windowsInstallCommand: windowsInstallCommand(origin, code),
      macosInstallCommand: macosInstallCommand(origin, code),
    });
  }

  // GET /api/bot/fleet
  if (base === 'fleet') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    const fleet = await loadFleet();
    const sessions = sessionsVisibleTo(fleet, identity).map((s) => publicSessionView(fleet, s));
    const myEvents = (fleet.events || []).filter((e) => !e.ownerUserId || e.ownerUserId === identity.userId || isAdmin(identity)).slice(0, 50);
    return json(req, {
      ok: true,
      backend: fleetBackend(),
      isAdmin: isAdmin(identity),
      identity: { userId: identity.userId, email: identity.email, orgId: identity.orgId, verified: identity.verified, authMode: identity.authMode },
      sessions,
      config: getUserConfig(fleet, identity.userId),
      lastRegime: fleet.lastRegime || null,
      events: myEvents,
      productionReady: false,
      realOrderSubmitted: false,
    });
  }

  // GET/POST /api/bot/config (per user)
  if (base === 'config') {
    const fleet = await loadFleet();
    if (req.method === 'GET') {
      return json(req, { ok: true, config: getUserConfig(fleet, identity.userId) });
    }
    if (req.method === 'POST') {
      const v = validateBotConfig(body);
      if (!v.ok) return json(req, { ok: false, error: 'Invalid config', errors: v.errors }, 400);
      fleet.botConfigs[identity.userId] = v.config;
      fevent(fleet, 'BOT_CONFIG_UPDATED', 'info', `Config updated by ${identity.email || identity.userId}.`, { ownerUserId: identity.userId });
      await saveFleet(fleet);
      return json(req, { ok: true, config: v.config });
    }
    return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
  }

  // POST /api/bot/start-session
  if (base === 'start-session') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    if (process.env.BINANCE_ENV !== 'testnet') return json(req, { ok: false, error: 'Worker sessions require BINANCE_ENV=testnet.' }, 403);
    if (process.env.BOT_LIVE_TRADING_ENABLED === 'true' || process.env.BOT_ALLOW_REAL_ORDERS === 'true') {
      return json(req, { ok: false, error: 'Live trading flags are active. Cannot start a worker session.' }, 403);
    }
    const fleet = await loadFleet();
    const now = Date.now();
    for (const s of Object.values(fleet.botSessions || {})) {
      if (s.ownerUserId === identity.userId && isSessionStaleNoWorker(s, fleet, now)) {
        clearStaleSession(fleet, s.sessionId, identity, 'auto_clear_before_start');
      }
    }

    const recent = Object.values(fleet.botSessions || {}).find((s) => {
      if (!s || s.ownerUserId !== identity.userId || s.status !== 'launch_requested') return false;
      if (workerIsOnline(sessionWorkerStatus(fleet, s))) return false;
      return (now - new Date(s.createdAt || s.updatedAt || 0).getTime()) < 60000;
    });
    if (recent) {
      await saveFleet(fleet);
      const launch = launchUrlForSession(req, recent.sessionId);
      return json(req, {
        ok: true,
        existing: true,
        reusedLaunchSession: true,
        sessionId: recent.sessionId,
        ...launch,
        session: publicSessionView(fleet, recent),
      });
    }

    const mine = Object.values(fleet.botSessions || {}).filter((s) => (
      s.ownerUserId === identity.userId && !CLEARED_ACTIVE_EXCLUDED_STATUSES.has(s.status)
    ));
    if (mine.length >= MAX_SESSIONS_PER_USER) {
      return json(req, {
        ok: false,
        error: 'Session limit reached',
        activeSessions: mine.map((s) => publicSessionView(fleet, s)),
      }, 429);
    }
    const sessionId = `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const session = {
      sessionId,
      ownerUserId: identity.userId,
      ownerEmail: identity.email,
      orgId: identity.orgId || 'default',
      workerId: null,
      mode: 'testnet',
      status: 'launch_requested',
      createdAt: nowIso,
      updatedAt: nowIso,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      stopRequested: false,
      pauseRequested: false,
      closePositionsOnStop: true,
      riskState: fleet.lastRegime || null,
      config: getUserConfig(fleet, identity.userId),
      realOrderSubmitted: false,
    };
    fleet.botSessions[sessionId] = session;
    fevent(fleet, 'WORKER_SESSION_START_REQUESTED', 'info', `Session ${sessionId.slice(0, 12)} requested by ${identity.email || identity.userId}.`, { sessionId, ownerUserId: identity.userId });
    await saveFleet(fleet);

    const launch = launchUrlForSession(req, sessionId);
    return json(req, { ok: true, sessionId, ...launch, session: publicSessionView(fleet, session) });
  }

  // POST /api/bot/clear-stale-sessions
  if (base === 'clear-stale-sessions') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    const fleet = await loadFleet();
    const now = Date.now();
    const adminOrgClear = isAdmin(identity) && identity.verified === true;
    const clearedSessionIds = [];
    for (const s of Object.values(fleet.botSessions || {})) {
      const canSee = s.ownerUserId === identity.userId
        || (adminOrgClear && (s.orgId || 'default') === (identity.orgId || 'default'));
      if (canSee && isSessionStaleNoWorker(s, fleet, now)) {
        clearStaleSession(fleet, s.sessionId, identity, adminOrgClear && s.ownerUserId !== identity.userId ? 'admin_clear_stale_sessions' : 'clear_stale_sessions');
        clearedSessionIds.push(s.sessionId);
      }
    }
    await saveFleet(fleet);
    return json(req, { ok: true, count: clearedSessionIds.length, clearedSessionIds });
  }

  // /api/bot/session/:sessionId[/:action]
  if (base === 'session') {
    const sessionId = segments[1];
    const action = segments[2] || null;
    if (!sessionId) return json(req, { ok: false, error: 'sessionId required' }, 400);
    const fleet = await loadFleet();
    const session = fleet.botSessions[sessionId];
    if (!session) return json(req, { ok: false, error: 'Session not found' }, 404);
    if (!canControlSession(identity, session)) return json(req, { ok: false, error: 'Forbidden' }, 403);

    if (!action) {
      if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
      return json(req, { ok: true, session: publicSessionView(fleet, session) });
    }
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);

    const actor = identity.email || identity.userId;
    if (action === 'stop') {
      if (canClearNoWorkerNoPosition(session, fleet)) {
        clearStaleSession(fleet, sessionId, identity, 'stop_requested_before_worker_online');
        await saveFleet(fleet);
        return json(req, { ok: true, cleared: true, session: publicSessionView(fleet, session) });
      }
      session.stopRequested = true;
      session.status = workerIsOnline(sessionWorkerStatus(fleet, session)) ? 'stopping' : 'stop_requested';
      session.closePositionsOnStop = true;
      expireStaleIntent(fleet, sessionId);
      if (fleet.executionIntents[sessionId] && fleet.executionIntents[sessionId].status === 'pending') {
        fleet.executionIntents[sessionId].status = 'cancelled';
      }
      queueCommand(fleet, sessionId, 'STOP', actor);
      fevent(fleet, 'WORKER_SESSION_STOP_REQUESTED', 'info', `Stop requested for ${sessionId.slice(0, 12)} by ${actor}. Worker will close positions then exit.`, { sessionId, ownerUserId: session.ownerUserId });
    } else if (action === 'pause') {
      session.pauseRequested = true;
      session.status = 'paused';
      if (fleet.executionIntents[sessionId] && fleet.executionIntents[sessionId].status === 'pending') {
        fleet.executionIntents[sessionId].status = 'cancelled';
      }
      queueCommand(fleet, sessionId, 'PAUSE', actor);
      fevent(fleet, 'ENTRIES_PAUSED', 'info', `Entries paused for ${sessionId.slice(0, 12)} by ${actor}.`, { sessionId, ownerUserId: session.ownerUserId });
    } else if (action === 'resume') {
      session.pauseRequested = false;
      if (!session.stopRequested) session.status = 'running';
      queueCommand(fleet, sessionId, 'RESUME', actor);
      fevent(fleet, 'ENTRIES_RESUMED', 'info', `Entries resumed for ${sessionId.slice(0, 12)} by ${actor}.`, { sessionId, ownerUserId: session.ownerUserId });
    } else if (action === 'emergency-close') {
      queueCommand(fleet, sessionId, 'EMERGENCY_CLOSE', actor);
      session.pauseRequested = true; // stop new entries while closing
      fevent(fleet, 'EMERGENCY_CLOSE_REQUESTED', 'warn', `Emergency close (testnet) requested for ${sessionId.slice(0, 12)} by ${actor}.`, { sessionId, ownerUserId: session.ownerUserId });
    } else if (action === 'clear-stale') {
      if (!canClearNoWorkerNoPosition(session, fleet)) {
        return json(req, { ok: false, error: 'Session is not clearable. A worker is online or open positions exist.' }, 409);
      }
      clearStaleSession(fleet, sessionId, identity, 'manual_clear_stale_session');
    } else {
      return json(req, { ok: false, error: 'Unknown session action' }, 404);
    }
    session.updatedAt = new Date().toISOString();
    await saveFleet(fleet);
    return json(req, { ok: true, session: publicSessionView(fleet, session) });
  }

  // POST /api/bot/create-execution-intent  (session-scoped, config + regime gated)
  if (base === 'create-execution-intent' || base === 'create-smoke-execution-intent') {
    if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    // Accept several body keys for client compatibility. The FULL id is used
    // verbatim — never normalized and never stripped of the "session_" prefix.
    const sessionId = (body && (body.sessionId || body.targetSessionId || body.botSessionId)) || '';
    if (!sessionId || typeof sessionId !== 'string') {
      return json(req, { ok: false, error: 'sessionId is required' }, 400);
    }
    if (process.env.BOT_LIVE_TRADING_ENABLED === 'true' || process.env.BOT_ALLOW_REAL_ORDERS === 'true') {
      return json(req, { ok: false, error: 'Live trading flags are active.' }, 403);
    }
    if (process.env.BINANCE_ENV !== 'testnet' || process.env.BOT_ALLOW_TESTNET_ORDERS !== 'true') {
      return json(req, { ok: false, error: 'Testnet execution is not allowed.' }, 403);
    }

    const fleet = await loadFleet();
    // Exact, full-id lookup using the same store as worker-heartbeat / worker-session.
    const session = fleet.botSessions[sessionId];
    if (!session) {
      // Debug-safe payload so a wrong/partial id is impossible to miss.
      const mine = Object.values(fleet.botSessions || {}).filter((s) => canControlSession(identity, s));
      const knownSessionIdsForUser = mine.map((s) => s.sessionId);
      const knownRunningSessionIdsForUser = mine
        .filter((s) => s.status === 'running' || workerIsOnline(sessionWorkerStatus(fleet, s)))
        .map((s) => s.sessionId);
      return json(req, {
        ok: false,
        error: 'Session not found',
        requestedSessionId: sessionId,
        knownSessionIdsForUser,
        knownRunningSessionIdsForUser,
      }, 404);
    }
    if (!canControlSession(identity, session)) return json(req, { ok: false, error: 'Forbidden' }, 403);
    if (session.stopRequested) return json(req, { ok: false, error: 'Session is stopping.' }, 409);
    if (session.pauseRequested) return json(req, { ok: false, error: 'Session entries are paused.' }, 409);

    // Require an online/running local worker bound to THIS session before queuing
    // an intent — otherwise no one will ever pick it up.
    const sessWorker = sessionWorkerStatus(fleet, session);
    if (!workerIsOnline(sessWorker)) {
      return json(req, {
        ok: false,
        error: 'Worker not online',
        requestedSessionId: sessionId,
        reason: 'No recent heartbeat from a local worker for this session. Start the worker, then retry.',
      }, 409);
    }

    const config = completeBotConfig(session.config || getUserConfig(fleet, identity.userId));

    // ── Risk regime gate ──
    let regime = fleet.lastRegime;
    try {
      const markets = await fetchMarkets(req);
      regime = computeMarketRegime(markets);
    } catch (err) {
      regime = regime || { regime: 'NEUTRAL', entriesAllowed: true, reason: ['regime unavailable'], updatedAt: new Date().toISOString() };
    }
    const prevRegime = fleet.lastRegime && fleet.lastRegime.regime;
    fleet.lastRegime = regime;
    session.riskState = regime;
    if (prevRegime && prevRegime !== regime.regime) {
      fevent(fleet, 'MARKET_REGIME_CHANGED', 'info', `Market regime ${prevRegime} → ${regime.regime}.`, { data: { metrics: regime.metrics } });
    }
    if (regime.regime === 'CRASH' && config.pauseOnMarketCrash) {
      fevent(fleet, 'ENTRIES_PAUSED_MARKET_CRASH', 'warn', `Entry blocked: market CRASH. ${regime.reason.join('; ')}`, { sessionId, ownerUserId: session.ownerUserId });
      await saveFleet(fleet);
      return json(req, { ok: false, error: 'Entries paused: market crash regime.', regime, blockedReason: regime.reason.join('; ') }, 409);
    }

    // Idempotency: if a pending/claimed intent already exists for THIS session,
    // return it instead of creating a duplicate (no global/cross-session pickup).
    expireStaleIntent(fleet, sessionId);
    const existing = fleet.executionIntents[sessionId];
    if (existing && (existing.status === 'pending' || existing.status === 'claimed')) {
      await saveFleet(fleet);
      return json(req, {
        ok: true,
        existing: true,
        intent: existing,
        regime,
        session: publicSessionView(fleet, session),
      });
    }

    const isSmoke = base === 'create-smoke-execution-intent';
    let symbol, positionUsd, quoteAsset, entryReference;
    if (isSmoke) {
      symbol = 'BTCUSDT';
      quoteAsset = 'USDT';
      entryReference = null;
      positionUsd = Math.min(config.maxTradeUsd, TESTNET_MAX_TRADE_USD);
    } else {
      const pp = botControlState.paperPosition;
      if (!pp || pp.status !== 'open') return json(req, { ok: false, error: 'No open paper position. Run Wake Bot first.' }, 400);
      if (!pp.testnetSymbolAvailable && !pp.smokeFallback) return json(req, { ok: false, error: 'Position not compatible with testnet.' }, 400);
      quoteAsset = pp.smokeFallback ? BOT_TESTNET_SMOKE_QUOTE_ASSET : BOT_QUOTE_ASSET;
      symbol = toBinanceQuoteSymbol(pp.symbol, quoteAsset);
      entryReference = pp.entry;
      positionUsd = Math.max(config.minTradeUsd, Math.min(Number(pp.positionUsd) || config.maxTradeUsd, config.maxTradeUsd));
    }
    // Config hard gate.
    if (!(positionUsd >= config.minTradeUsd && positionUsd <= config.maxTradeUsd && positionUsd <= TESTNET_MAX_TRADE_USD)) {
      await saveFleet(fleet);
      return json(req, { ok: false, error: `positionUsd ${positionUsd} violates config bounds [${config.minTradeUsd}, ${config.maxTradeUsd}].` }, 400);
    }
    // Max open positions.
    const open = (fleet.positionResults[sessionId] || []).filter((p) => p && p.status === 'open').length;
    if (open >= config.maxOpenPositions) {
      await saveFleet(fleet);
      return json(req, { ok: false, error: `Max open positions (${config.maxOpenPositions}) reached for this session.` }, 409);
    }

    const intentId = `intent_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const idempotencyKey = `fleet_${sessionId}_${symbol}_${Date.now()}`;
    const intent = {
      id: intentId,
      idempotencyKey,
      sessionId,
      mode: 'testnet',
      symbol,
      side: 'BUY',
      type: 'MARKET',
      positionUsd,
      entryReference,
      quoteAsset,
      smokeFallback: isSmoke,
      configSnapshot: { minTradeUsd: config.minTradeUsd, maxTradeUsd: config.maxTradeUsd, maxOpenPositions: config.maxOpenPositions },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
      status: 'pending',
      realOrderSubmitted: false,
      testnet: true,
      realProductionOrder: false,
    };
    fleet.executionIntents[sessionId] = intent;
    fevent(fleet, isSmoke ? 'TESTNET_SMOKE_INTENT_CREATED' : 'TESTNET_EXECUTION_INTENT_CREATED', 'info',
      `${isSmoke ? 'Smoke' : 'Execution'} intent ${intentId.slice(0, 14)} created for ${symbol} (session ${sessionId.slice(0, 12)}).`,
      { sessionId, ownerUserId: session.ownerUserId });
    await saveFleet(fleet);
    return json(req, { ok: true, intent, regime, session: publicSessionView(fleet, session) });
  }

  return json(req, { ok: false, error: 'Not Found' }, 404);
}

// ══════════════════════════════════════════════════════════════════════════
// Worker Bootstrap / Pairing — first-time install flow.
//
// A browser owner mints a short-lived, single-use pairing code. The user pastes
// ONE install command on the target machine. The installer fetches a public
// bootstrap script (no secrets), clones the repo, then exchanges the pairing
// code at POST /api/bot/worker-pair for the worker bootstrap config (control
// URL + shared worker token). The worker token is therefore NEVER exposed to
// the browser or placed in any URL — only handed to a caller proving possession
// of a valid pairing code.
//
// SECURITY: pairing codes hold NO Binance secrets and NO worker token. Binance
// keys are prompted for locally by the installer and written only to a local,
// gitignored .env.worker. This store is durable (Netlify Blobs) with an
// in-memory fallback so create + redeem can hit different serverless instances.
// ══════════════════════════════════════════════════════════════════════════

const PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes, single use
const PAIRING_KEY = 'worker-pairing-codes';
const WORKER_INSTALL_REPO = process.env.BOT_WORKER_INSTALL_REPO || 'alescesnek1/swing-terminal-v6';
const WORKER_INSTALL_BRANCH = process.env.BOT_WORKER_INSTALL_BRANCH || 'main';

let _pairingBackendResolved = false;
let _pairingBlobStore = null;
const _pairingMem = new Map();

async function resolvePairingBackend() {
  if (_pairingBackendResolved) return;
  _pairingBackendResolved = true;
  try {
    const mod = await import('@netlify/blobs');
    if (mod && typeof mod.getStore === 'function') {
      _pairingBlobStore = mod.getStore({ name: 'bot-worker-pairing', consistency: 'strong' });
      return;
    }
  } catch (err) {
    console.warn('[pairingStore] @netlify/blobs unavailable, using in-memory fallback:', err && err.message);
  }
  _pairingBlobStore = null;
}

function emptyPairingStore() {
  return { codes: {} };
}

function normalizePairingStore(data) {
  if (!data || typeof data !== 'object' || typeof data.codes !== 'object' || Array.isArray(data.codes)) {
    return emptyPairingStore();
  }
  return { codes: data.codes };
}

async function loadPairings() {
  await resolvePairingBackend();
  if (_pairingBlobStore) {
    try {
      const data = await _pairingBlobStore.get(PAIRING_KEY, { type: 'json' });
      return normalizePairingStore(data);
    } catch (err) {
      console.warn('[pairingStore] blob read failed:', err && err.message);
      return emptyPairingStore();
    }
  }
  const raw = _pairingMem.get(PAIRING_KEY);
  return normalizePairingStore(raw ? JSON.parse(raw) : null);
}

async function savePairings(store) {
  await resolvePairingBackend();
  if (_pairingBlobStore) {
    try { await _pairingBlobStore.setJSON(PAIRING_KEY, store); return; }
    catch (err) { console.error('[pairingStore] blob write failed:', err && err.message); }
  }
  _pairingMem.set(PAIRING_KEY, JSON.stringify(store));
}

// Mark expired codes and hard-delete long-dead ones so the document stays small.
function prunePairings(store) {
  const now = Date.now();
  for (const [code, rec] of Object.entries(store.codes || {})) {
    const exp = new Date(rec && rec.expiresAt || 0).getTime();
    if (!Number.isFinite(exp)) { delete store.codes[code]; continue; }
    if (rec.status !== 'used' && exp < now) rec.status = 'expired';
    if (exp + 60 * 60 * 1000 < now) delete store.codes[code]; // 1h past expiry
  }
}

// The function's own origin (installer/curl never sends an Origin header).
function selfOrigin(req) {
  try {
    const u = new URL(req.url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
  } catch { /* fall through */ }
  return getAllowedOrigins()[0] || 'https://swing-terminal-v6.netlify.app';
}

function windowsInstallCommand(origin, code) {
  return `powershell -ExecutionPolicy Bypass -Command "irm ${origin}/api/bot/install/windows?pair=${encodeURIComponent(code)} | iex"`;
}
function macosInstallCommand(origin, code) {
  return `curl -fsSL "${origin}/api/bot/install/macos?pair=${encodeURIComponent(code)}" | bash`;
}

function textResponse(req, body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(req),
    },
  });
}

// Public bootstrap script returned by GET /api/bot/install/<platform>?pair=CODE.
// Contains the pair code ONLY (no Binance secrets, no worker token). It fetches
// the committed installer from the public repo and runs it with the pair code.
function buildWindowsBootstrap(origin, code) {
  const installerUrl = `https://raw.githubusercontent.com/${WORKER_INSTALL_REPO}/${WORKER_INSTALL_BRANCH}/scripts/install-worker-windows.ps1`;
  return [
    '# SwingTerminal Worker first-time installer (TESTNET only).',
    '# This script contains only a short-lived pairing code. No secrets.',
    "$ErrorActionPreference = 'Stop'",
    `$PairCode = '${code}'`,
    `$ControlUrl = '${origin}'`,
    `$InstallerUrl = '${installerUrl}'`,
    "Write-Host 'Fetching SwingTerminal worker installer...' -ForegroundColor Cyan",
    '$installerText = Invoke-RestMethod -Uri $InstallerUrl',
    '$installer = [scriptblock]::Create($installerText)',
    '& $installer -PairCode $PairCode -ControlUrl $ControlUrl',
    '',
  ].join('\n');
}
function buildMacosBootstrap(origin, code) {
  const installerUrl = `https://raw.githubusercontent.com/${WORKER_INSTALL_REPO}/${WORKER_INSTALL_BRANCH}/scripts/install-worker-macos.sh`;
  return [
    '#!/usr/bin/env bash',
    '# SwingTerminal Worker first-time installer (TESTNET only).',
    '# This script contains only a short-lived pairing code. No secrets.',
    'set -euo pipefail',
    `PAIR_CODE='${code}'`,
    `CONTROL_URL='${origin}'`,
    `INSTALLER_URL='${installerUrl}'`,
    'echo "Fetching SwingTerminal worker installer..."',
    'TMP="$(mktemp -t swingworker-install.XXXXXX)"',
    'curl -fsSL "$INSTALLER_URL" -o "$TMP"',
    'bash "$TMP" --pair "$PAIR_CODE" --control "$CONTROL_URL"',
    'rm -f "$TMP"',
    '',
  ].join('\n');
}

// GET /api/bot/install/windows|macos?pair=CODE  (public; no auth/origin gate).
async function handleInstallScript(req, segments) {
  if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
  const platform = (segments[1] || '').toLowerCase();
  const url = new URL(req.url);
  const code = (url.searchParams.get('pair') || '').trim();
  const origin = selfOrigin(req);
  if (!code) return textResponse(req, '# Missing pair code. Generate one from the web app (Install Worker).\n', 400);
  if (platform === 'windows') return textResponse(req, buildWindowsBootstrap(origin, code));
  if (platform === 'macos') return textResponse(req, buildMacosBootstrap(origin, code));
  return json(req, { ok: false, error: 'Unknown install platform. Use windows or macos.' }, 404);
}

// POST /api/bot/worker-pair  (called by the local installer; authenticated by the
// pairing code itself — no browser Origin/JWT). Redeems a code for bootstrap config.
async function handleWorkerPair(req) {
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
  let body = {};
  try { body = await parseBody(req); } catch (err) { return json(req, { ok: false, error: err.message }, 400); }
  // Defense in depth: never accept Binance secrets on this endpoint.
  const denied = findSensitiveFields(body);
  if (denied.length) return json(req, { ok: false, error: 'Credentials are not accepted by this endpoint.', deniedFields: denied }, 400);

  const code = typeof body.pairingCode === 'string' ? body.pairingCode.trim() : '';
  if (!code) return json(req, { ok: false, error: 'pairingCode is required' }, 400);

  if (process.env.BINANCE_ENV !== 'testnet') {
    return json(req, { ok: false, error: 'Worker pairing requires BINANCE_ENV=testnet.' }, 403);
  }
  if (process.env.BOT_LIVE_TRADING_ENABLED === 'true' || process.env.BOT_ALLOW_REAL_ORDERS === 'true') {
    return json(req, { ok: false, error: 'Live trading flags are active. Pairing is disabled.' }, 403);
  }

  const store = await loadPairings();
  prunePairings(store);
  const rec = store.codes[code];
  if (!rec) { await savePairings(store); return json(req, { ok: false, error: 'Invalid pairing code.' }, 404); }
  if (rec.status === 'used' || rec.usedAt) { return json(req, { ok: false, error: 'Pairing code already used.' }, 409); }
  if (new Date(rec.expiresAt).getTime() < Date.now()) {
    rec.status = 'expired';
    await savePairings(store);
    return json(req, { ok: false, error: 'Pairing code expired. Generate a new one from the web app.' }, 410);
  }

  const token = process.env.BOT_WORKER_TOKEN || '';
  if (!token) return json(req, { ok: false, error: 'Worker token is not configured on the control server.' }, 500);

  rec.status = 'used';
  rec.usedAt = new Date().toISOString();
  rec.platform = typeof body.platform === 'string' ? body.platform.slice(0, 60) : rec.platform || null;
  rec.hostname = typeof body.hostname === 'string' ? body.hostname.slice(0, 120) : null;
  await savePairings(store);

  return json(req, {
    ok: true,
    controlUrl: selfOrigin(req),
    workerToken: token,
    ownerEmail: rec.ownerEmail || null,
    mode: 'testnet',
  });
}

const FLEET_WORKER_BASES = new Set(['worker-heartbeat', 'worker-session', 'execution-result', 'position-result', 'worker-command-ack']);
const FLEET_BROWSER_BASES = new Set(['fleet', 'config', 'start-session', 'session', 'clear-stale-sessions', 'create-execution-intent', 'create-smoke-execution-intent', 'create-worker-pairing-code']);

function isWorkerRoute(route) {
  return route === 'execution-intent';
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
  const segments = route.split('/').filter(Boolean);
  const base = segments[0] || route;
  let auth = { ok: true, authMode: 'worker' };

  // ── Worker Bootstrap install flow (public; no Origin/JWT gate) ──
  // GET /api/bot/install/<platform> serves a public, secret-free bootstrap.
  // POST /api/bot/worker-pair is authenticated by the pairing code itself.
  if (base === 'install') {
    return await handleInstallScript(req, segments);
  }
  if (base === 'worker-pair') {
    return await handleWorkerPair(req);
  }

  // ── Bot Fleet Manager dispatch (takes precedence over legacy routing) ──
  if (FLEET_WORKER_BASES.has(base)) {
    if (!checkWorkerToken(req)) {
      return json(req, { ok: false, error: 'Forbidden', reason: 'Invalid or missing X-BOT-WORKER-TOKEN' }, 403);
    }
    let body = {};
    if (req.method === 'POST') {
      try { body = await parseBody(req); } catch (err) { return json(req, { ok: false, error: err.message }, 400); }
    }
    return await handleFleetWorker(req, base, body);
  }
  if (FLEET_BROWSER_BASES.has(base)) {
    const origin = checkOrigin(req);
    if (!origin.ok) return json(req, { ok: false, error: 'Origin not allowed', reason: origin.reason }, 403);
    const identity = await getIdentity(req);
    if (!identity.ok) return json(req, { ok: false, error: 'Unauthorized', reason: identity.reason }, 401);
    let body = {};
    if (req.method === 'POST') {
      try { body = await parseBody(req); } catch (err) { return json(req, { ok: false, error: err.message }, 400); }
      const denied = findSensitiveFields(body);
      if (denied.length) return json(req, { ok: false, error: 'Credentials are not accepted by this endpoint.', deniedFields: denied }, 400);
    }
    return await handleFleetBrowser(req, base, segments, identity, body);
  }

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
    // Deprecated: global intent pickup is removed. Workers must use
    // GET /api/bot/worker-session?sessionId=&workerId= for per-session intents.
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    return json(req, { ok: true, intent: null, deprecated: true, reason: 'Use /api/bot/worker-session?sessionId=&workerId=' });
  }

  if (route === 'worker-session') {
    if (req.method !== 'GET') return json(req, { ok: false, error: 'Method Not Allowed' }, 405);
    const session = botControlState.botSession;
    if (!session) {
      return json(req, { ok: true, session: null });
    }
    // Expire stale sessions defensively.
    if (session.expiresAt && new Date(session.expiresAt).getTime() < Date.now() && session.status !== 'stopped') {
      session.status = 'expired';
      session.stopRequested = true;
    }
    const intent = botControlState.executionIntent;
    const activeIntent = intent && (intent.status === 'pending' || intent.status === 'claimed') ? intent : null;
    return json(req, {
      ok: true,
      session: {
        sessionId: session.sessionId,
        status: session.status,
        mode: session.mode,
        stopRequested: session.stopRequested === true,
        closePositionsOnStop: session.closePositionsOnStop !== false,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        realOrderSubmitted: false,
      },
      intent: activeIntent,
      mode: session.mode,
      stopRequested: session.stopRequested === true,
      closePositionsOnStop: session.closePositionsOnStop !== false,
    });
  }

  if (route !== 'wake' && route !== 'stop' && route !== 'testnet-order' && route !== 'clear-paper-position' && route !== 'create-execution-intent' && route !== 'create-smoke-execution-intent' && route !== 'execution-result' && route !== 'worker-heartbeat' && route !== 'start-session' && route !== 'stop-session' && route !== 'position-result') {
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

  if (route === 'create-smoke-execution-intent') {
    const allowTestnetOrders = process.env.BOT_ALLOW_TESTNET_ORDERS === 'true';
    const liveTradingEnabled = process.env.BOT_LIVE_TRADING_ENABLED === 'true';
    const allowRealOrders = process.env.BOT_ALLOW_REAL_ORDERS === 'true';
    const allowQuoteFallback = process.env.BOT_TESTNET_ALLOW_QUOTE_FALLBACK === 'true';
    const maxPositionUsd = envNumber('BOT_MAX_POSITION_USD', 10);
    
    if (liveTradingEnabled || allowRealOrders) {
      return json(req, { ok: false, error: 'Live trading flags are active. Cannot create testnet intent.' }, 403);
    }
    if (!allowTestnetOrders) {
      return json(req, { ok: false, error: 'Testnet execution is not allowed.' }, 403);
    }
    if (!allowQuoteFallback) {
      return json(req, { ok: false, error: 'Testnet quote fallback is not allowed. Cannot create smoke intent.' }, 403);
    }

    if (botControlState.executionIntent && (botControlState.executionIntent.status === 'pending' || botControlState.executionIntent.status === 'claimed')) {
      if (new Date(botControlState.executionIntent.expiresAt).getTime() > Date.now()) {
        return json(req, { ok: false, error: 'An execution intent is already pending or claimed.' }, 409);
      }
    }

    const intentId = `intent_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const symbol = 'BTCUSDT';
    const idempotencyKey = `paperbot_smoke_${symbol}_${Date.now()}`;

    if (botControlState.usedIdempotencyKeys && botControlState.usedIdempotencyKeys.includes(idempotencyKey)) {
      return json(req, { ok: false, error: 'Idempotency key already used.' }, 409);
    }

    const intent = {
      id: intentId,
      idempotencyKey,
      mode: 'testnet',
      symbol,
      side: 'BUY',
      type: 'MARKET',
      positionUsd: maxPositionUsd > 10 ? 10 : maxPositionUsd,
      entryReference: null,
      stopLoss: null,
      takeProfit: null,
      quoteAsset: 'USDT',
      productionQuoteAsset: 'USDC',
      smokeFallback: true,
      strategyFallback: true,
      fallbackReason: 'local_worker_testnet_smoke_validation',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120 * 1000).toISOString(),
      status: 'pending',
      realOrderSubmitted: false,
      testnet: true,
      realProductionOrder: false
    };

    botControlState.executionIntent = intent;
    const createEvent = event('TESTNET_SMOKE_INTENT_CREATED', 'info', `Created BTCUSDT testnet smoke intent for local worker. This is not a strategy signal. Production strategy remains USDC-only.`, { intentId });
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
      sessionId: body.sessionId || (botControlState.botSession && botControlState.botSession.sessionId) || null,
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
  if (route === 'start-session') {
    // Browser route. Creates an on-demand local worker session and returns a
    // swingworker:// launch URL. No secrets are ever placed in the URL.
    const isTestnetEnv = process.env.BINANCE_ENV === 'testnet';
    const liveTradingEnabled = process.env.BOT_LIVE_TRADING_ENABLED === 'true';
    const allowRealOrders = process.env.BOT_ALLOW_REAL_ORDERS === 'true';
    if (liveTradingEnabled || allowRealOrders) {
      return json(req, { ok: false, error: 'Live trading flags are active. Cannot start a worker session.' }, 403);
    }
    if (!isTestnetEnv) {
      return json(req, { ok: false, error: 'Worker sessions require BINANCE_ENV=testnet.' }, 403);
    }

    const sessionId = `session_${Date.now()}_${crypto.randomBytes(6).toString('hex')}`;
    const nowIso = new Date().toISOString();
    const session = {
      sessionId,
      status: 'launch_requested',
      mode: 'testnet',
      createdAt: nowIso,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      stopRequested: false,
      closePositionsOnStop: true,
      realOrderSubmitted: false,
    };
    botControlState.botSession = session;

    const controlUrl = requestOrigin(req) || getAllowedOrigins()[0] || 'https://swing-terminal-v6.netlify.app';
    const launchUrl = `swingworker://start?session=${encodeURIComponent(sessionId)}&control=${encodeURIComponent(controlUrl)}`;

    const startEvent = event('WORKER_SESSION_START_REQUESTED', 'info', 'Local worker launch requested. Waiting for swingworker:// helper to start the worker.', { sessionId });
    botControlState.events = [startEvent, ...botControlState.events].slice(0, 30);
    botControlState.updatedAt = startEvent.ts;

    return json(req, publicState({
      ok: true,
      sessionId,
      launchUrl,
      controlUrl,
      botSession: publicSession(),
      events: [startEvent],
      authMode: auth.authMode,
    }));
  }

  if (route === 'stop-session') {
    // Browser route. Flags the active session for a graceful stop. The worker
    // must stop opening new positions, close existing testnet positions, then exit.
    const session = botControlState.botSession;
    if (!session) {
      return json(req, { ok: false, error: 'No active worker session.' }, 400);
    }
    session.stopRequested = true;
    session.status = 'stop_requested';
    session.closePositionsOnStop = true;

    // Defensively cancel any pending intent so no new position is opened on stop.
    const intent = botControlState.executionIntent;
    if (intent && (intent.status === 'pending' || intent.status === 'claimed')) {
      intent.status = 'cancelled';
      botControlState.executionIntent = intent;
    }

    const stopEvent = event('WORKER_SESSION_STOP_REQUESTED', 'info', 'Stop requested. Worker will close testnet positions before exit.', { sessionId: session.sessionId });
    botControlState.events = [stopEvent, ...botControlState.events].slice(0, 30);
    botControlState.updatedAt = stopEvent.ts;

    return json(req, publicState({
      ok: true,
      botSession: publicSession(),
      events: [stopEvent],
      authMode: auth.authMode,
    }));
  }

  if (route === 'worker-heartbeat') {
    // Worker route. Persists the worker's liveness + reported lifecycle state.
    const nowIso = new Date().toISOString();
    const workerStatus = {
      workerStatus: body.workerStatus === 'offline' ? 'offline' : 'online',
      sessionId: body.sessionId || null,
      hostname: typeof body.hostname === 'string' ? body.hostname.slice(0, 120) : null,
      platform: typeof body.platform === 'string' ? body.platform.slice(0, 60) : null,
      startedAt: body.startedAt || null,
      lastSeenAt: nowIso,
      pid: Number.isFinite(Number(body.pid)) ? Number(body.pid) : null,
      mode: 'testnet',
      currentState: typeof body.currentState === 'string' ? body.currentState.slice(0, 60) : null,
      realProductionOrder: false,
    };
    botControlState.workerStatus = workerStatus;

    // Reflect worker lifecycle into the session for the UI.
    const session = botControlState.botSession;
    if (session && (!body.sessionId || body.sessionId === session.sessionId)) {
      if (workerStatus.currentState === 'stopped') {
        session.status = 'stopped';
      } else if (workerStatus.currentState === 'stopping') {
        session.status = 'stopping';
      } else if (!session.stopRequested && session.status === 'launch_requested') {
        session.status = 'running';
      }
    }
    botControlState.updatedAt = nowIso;

    return json(req, {
      ok: true,
      stopRequested: session ? session.stopRequested === true : false,
      closePositionsOnStop: session ? session.closePositionsOnStop !== false : true,
      sessionId: session ? session.sessionId : null,
    });
  }

  if (route === 'position-result') {
    // Worker route. Worker reports open/closed testnet positions. No secrets.
    if (!body || !body.symbol || !body.status) {
      return json(req, { ok: false, error: 'Invalid payload' }, 400);
    }
    const record = {
      symbol: String(body.symbol).toUpperCase().slice(0, 20),
      baseAsset: typeof body.baseAsset === 'string' ? body.baseAsset.slice(0, 20) : null,
      executedQty: body.executedQty != null ? String(body.executedQty).slice(0, 40) : null,
      orderId: body.orderId != null ? String(body.orderId).slice(0, 40) : null,
      closeOrderId: body.closeOrderId != null ? String(body.closeOrderId).slice(0, 40) : null,
      status: String(body.status).slice(0, 30),
      sessionId: body.sessionId || (botControlState.botSession && botControlState.botSession.sessionId) || null,
      error: typeof body.error === 'string' ? body.error.slice(0, 240) : null,
      testnet: true,
      realProductionOrder: false,
      receivedAt: new Date().toISOString(),
    };
    if (!botControlState.positionResults) botControlState.positionResults = [];
    botControlState.positionResults = [record, ...botControlState.positionResults].slice(0, 30);

    let posEvent;
    if (record.status === 'closed') {
      posEvent = event('WORKER_POSITION_CLOSED', 'info', `Local worker closed testnet position ${record.symbol} (order ${record.closeOrderId}).`, { record });
    } else if (record.status === 'WORKER_CLOSE_FAILED') {
      posEvent = event('WORKER_CLOSE_FAILED', 'warn', `Local worker failed to close testnet position ${record.symbol}. Manual attention required.`, { record });
    } else {
      posEvent = event('WORKER_POSITION_OPEN', 'info', `Local worker opened testnet position ${record.symbol} (order ${record.orderId}).`, { record });
    }
    botControlState.events = [posEvent, ...botControlState.events].slice(0, 30);
    botControlState.updatedAt = posEvent.ts;

    return json(req, { ok: true, positionResults: botControlState.positionResults.slice(0, 10) });
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
