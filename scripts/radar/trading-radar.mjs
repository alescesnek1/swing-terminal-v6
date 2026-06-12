// trading-radar.mjs - read-only mean-reversion advisory engine.
//
// SAFETY CONTRACT:
//   - no orders
//   - no execution intents
//   - no live/paper gate changes
// It consumes public market snapshots plus optional microstructure/position context
// and returns advisory candidates and exit guidance only.

const WEIRD_BASE_RE = /(UP|DOWN|BULL|BEAR)$|\d+(L|S)$/;
const QUOTES = new Set(['USDC', 'USDT']);

export const RADAR_STAGES = Object.freeze({
  NO_SETUP: 'NO_SETUP',
  WATCH: 'WATCH',
  LONG_FLUSH_CONFIRMED: 'LONG_FLUSH_CONFIRMED',
  STABILIZING: 'STABILIZING',
  SQUEEZE_CONFIRMED: 'SQUEEZE_CONFIRMED',
  ENTRY_READY: 'ENTRY_READY',
});

export const RADAR_ENTRY_TYPES = Object.freeze({
  NONE: null,
  RECLAIM_RETEST: 'RECLAIM_RETEST',
  ABSORPTION: 'ABSORPTION',
});

export const RADAR_EXIT_MODES = Object.freeze({
  EXHAUSTION_MODE: 'EXHAUSTION_MODE',
  NORMAL_MEAN_REVERSION_MODE: 'NORMAL_MEAN_REVERSION_MODE',
  EXPANSION_MODE: 'EXPANSION_MODE',
});

const DEFAULT_FILTERS = Object.freeze({
  minQuoteVolume24h: 10_000_000,
  maxSpreadPct: 0.15,
  minDepthUsd: 100_000,
});

function n(v, fallback = null) {
  const x = Number(v);
  return Number.isFinite(x) ? x : fallback;
}

function clamp(v, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}

function round(v, digits = 2) {
  const x = Number(v);
  if (!Number.isFinite(x)) return null;
  return Number(x.toFixed(digits));
}

function quoteAssetOf(m) {
  if (m && m.quoteAsset) return String(m.quoteAsset).toUpperCase();
  const s = String((m && m.symbol) || '').toUpperCase();
  for (const q of QUOTES) if (s.endsWith(q)) return q;
  return '';
}

function baseAssetOf(m) {
  if (m && m.baseAsset) return String(m.baseAsset).toUpperCase();
  const s = String((m && m.symbol) || '').toUpperCase();
  const q = quoteAssetOf(m);
  return q && s.endsWith(q) ? s.slice(0, -q.length) : s;
}

function midPrice(m) {
  const bid = n(m && m.bidPrice);
  const ask = n(m && m.askPrice);
  const last = n(m && (m.lastPrice ?? m.price ?? m.currentPrice));
  if (bid > 0 && ask > 0) return (bid + ask) / 2;
  return last > 0 ? last : null;
}

function pctToRatio(pct) {
  const v = Math.max(0.001, Math.abs(Number(pct) || 0));
  return v / 100;
}

function compactReasons(list, max = 6) {
  return Array.from(new Set((list || []).filter(Boolean).map((r) => String(r).slice(0, 180)))).slice(0, max);
}

export function defaultTradingRadarState(nowIso = null) {
  return {
    updatedAt: nowIso,
    source: 'uninitialized',
    dataFreshnessMs: null,
    universeDiagnostics: {
      fetched: 0,
      liquid: 0,
      spreadOk: 0,
      depthOk: 0,
      rejected: {},
      rejectedSamples: [],
    },
    marketRegime: {
      status: 'UNKNOWN',
      score: 50,
      blocksMeanReversion: false,
      reasons: ['no market data yet'],
      breadthPct: null,
      btc: null,
      eth: null,
    },
    candidates: [],
    watchlist: [],
    entryReady: [],
    selected: null,
    exitGuidance: null,
    missingSignals: [],
    dataCompleteness: 0,
    lastError: null,
  };
}

function rejectCount(diag, reason, symbol) {
  diag.rejected[reason] = (diag.rejected[reason] || 0) + 1;
  if (diag.rejectedSamples.length < 30) diag.rejectedSamples.push({ symbol, reason });
}

export function buildRadarUniverse(markets = [], opts = {}) {
  const filters = { ...DEFAULT_FILTERS, ...(opts.filters || {}) };
  const diag = { fetched: markets.length, liquid: 0, spreadOk: 0, depthOk: 0, rejected: {}, rejectedSamples: [] };
  const missing = new Set();
  const universe = [];

  for (const raw of markets || []) {
    const symbol = String((raw && raw.symbol) || '').toUpperCase();
    if (!symbol) { rejectCount(diag, 'missing symbol', ''); continue; }
    const quote = quoteAssetOf(raw);
    const base = baseAssetOf(raw);
    if (!QUOTES.has(quote)) { rejectCount(diag, 'non stable quote', symbol); continue; }
    if (WEIRD_BASE_RE.test(base) || raw.leveraged === true || raw.isLeveraged === true) {
      rejectCount(diag, 'weird/leverage token', symbol);
      continue;
    }
    if (raw.delisted === true || raw.exploitRisk === true || raw.unlockRisk === true || raw.newsRisk === 'high') {
      rejectCount(diag, 'event/delist risk', symbol);
      continue;
    }
    if (raw.status && String(raw.status).toUpperCase() !== 'TRADING') {
      rejectCount(diag, 'not trading', symbol);
      continue;
    }

    const quoteVolume = n(raw.quoteVolume24h ?? raw.volume24hUsd ?? raw.quoteVolume);
    if (!(quoteVolume >= filters.minQuoteVolume24h)) {
      rejectCount(diag, 'low 24h volume', symbol);
      continue;
    }
    diag.liquid++;

    const spreadPct = n(raw.spreadPct);
    if (spreadPct == null) missing.add('spreadPct');
    if (spreadPct != null && spreadPct > filters.maxSpreadPct) {
      rejectCount(diag, 'wide spread', symbol);
      continue;
    }
    diag.spreadOk++;

    const depthUsd = n(raw.depthUsdWithin1Pct ?? raw.depthUsdWithin0_5Pct ?? raw.orderBookDepthUsd);
    if (depthUsd == null) {
      missing.add('orderBookDepthWithin1Pct');
    } else if (depthUsd < filters.minDepthUsd) {
      rejectCount(diag, 'thin order book depth', symbol);
      continue;
    } else {
      diag.depthOk++;
    }

    const mid = midPrice(raw);
    if (mid == null) missing.add('midPrice');
    universe.push({
      ...raw,
      symbol,
      baseAsset: base,
      quoteAsset: quote,
      quoteVolume,
      spreadPct,
      mid,
      depthUsd,
    });
  }

  return { universe, diagnostics: diag, missingSignals: Array.from(missing).sort() };
}

export function evaluateMarketRegime(markets = []) {
  const btc = (markets || []).find((m) => /^BTC(USDC|USDT)$/.test(String(m.symbol || '').toUpperCase())) || null;
  const eth = (markets || []).find((m) => /^ETH(USDC|USDT)$/.test(String(m.symbol || '').toUpperCase())) || null;
  const changes = (markets || []).map((m) => n(m.change24hPct ?? m.priceChangePercent)).filter((v) => v != null);
  const breadthPct = changes.length ? (changes.filter((v) => v > 0).length / changes.length) * 100 : null;
  const btcChange = btc ? n(btc.change24hPct ?? btc.priceChangePercent, 0) : null;
  const ethChange = eth ? n(eth.change24hPct ?? eth.priceChangePercent, 0) : null;
  const reasons = [];
  let score = 70;

  if (btcChange == null) { score -= 12; reasons.push('BTC structure unavailable'); }
  else if (btcChange <= -4) { score -= 30; reasons.push('BTC active breakdown'); }
  else if (btcChange <= -2) { score -= 14; reasons.push('BTC weak'); }
  else reasons.push('BTC not in active breakdown');

  if (ethChange == null) { score -= 8; reasons.push('ETH structure unavailable'); }
  else if (ethChange <= -5) { score -= 22; reasons.push('ETH active breakdown'); }
  else if (ethChange <= -2.5) { score -= 10; reasons.push('ETH weak'); }

  if (breadthPct == null) { score -= 8; reasons.push('market breadth unavailable'); }
  else if (breadthPct < 25) { score -= 22; reasons.push('breadth collapse'); }
  else if (breadthPct < 40) { score -= 10; reasons.push('weak breadth'); }
  else reasons.push('breadth supportive enough');

  const blocks = score < 45 || btcChange <= -4 || ethChange <= -5 || breadthPct < 25;
  return {
    status: blocks ? 'RISK_OFF_BREAKDOWN' : (score >= 70 ? 'SUPPORTIVE' : 'MIXED'),
    score: round(clamp(score), 0),
    blocksMeanReversion: blocks,
    reasons: compactReasons(reasons, 5),
    breadthPct: breadthPct == null ? null : round(breadthPct, 1),
    btc: btc ? { symbol: btc.symbol, change24hPct: round(btcChange, 2) } : null,
    eth: eth ? { symbol: eth.symbol, change24hPct: round(ethChange, 2) } : null,
  };
}

function signalBooleans(m, regime) {
  const c24 = n(m.change24hPct ?? m.priceChangePercent, 0);
  const c12 = n(m.change12hPct);
  const c4 = n(m.change4hPct);
  const btcRel = n(m.btcRelativeChangePct ?? m.relativeToBtcPct);
  const atrPct = n(m.atrPct ?? m.realizedVolatilityPct);
  const volumeSpike = n(m.volumeSpike, Math.abs(c24) >= 6 ? 1.6 : 1);
  const oiChange = n(m.openInterestChangePct);
  const funding = n(m.fundingRate);
  const wickRecovery = n(m.wickRecoveryPct);
  const sellRatio = n(m.marketSellRatio);
  const bidRebuild = n(m.bidDepthRebuildPct ?? m.bidDepthChangePct);
  const shortLiq = n(m.shortLiquidationSpike);
  const longLiq = n(m.longLiquidationSpike ?? m.longLiquidationUsd);
  const buyDominance = n(m.marketBuyVolumeDominance ?? m.buyVolumeDominance);
  const retestHeld = m.retestHeld === true;
  const absorptionScore = n(m.absorptionScore);
  const reclaim = m.reclaimConfirmed === true || m.vwapReclaimed === true || m.rangeHighReclaimed === true;
  const higherLow = m.higherLowHeld === true;
  const noNewLows = m.noNewLows === true || n(m.noNewLowMinutes, 0) >= 20;
  const rangeFormed = m.rangeFormed === true || n(m.localRangeMinutes, 0) >= 20;

  const dropVsVol = atrPct != null ? Math.abs(c24) / Math.max(atrPct, 0.1) : null;
  const watchDrop = c24 <= -4 || c12 <= -3.5 || c4 <= -2.5 || btcRel <= -3 || dropVsVol >= 1.8;
  const panicFlush = (longLiq != null && longLiq >= 1.5) || (sellRatio != null && sellRatio >= 0.62) || (volumeSpike >= 1.8 && c24 <= -6);
  const oiFlush = oiChange != null && oiChange <= -4;
  const fundingOk = funding == null || funding <= 0.03;
  const wickOk = wickRecovery == null ? c24 <= -7 : wickRecovery >= 35;
  const bidsOk = bidRebuild != null && bidRebuild >= 8;
  const sellFade = m.sellAggressionFading === true || (sellRatio != null && sellRatio <= 0.56);
  const lateShorts = m.lateShortsAppearing === true || (oiChange != null && oiChange >= 0 && fundingOk);
  const squeeze = reclaim && (shortLiq >= 1.2 || buyDominance >= 0.56 || higherLow);
  const retestEntry = reclaim && retestHeld && (m.vwapHeld !== false) && !regime.blocksMeanReversion;
  const absorptionEntry = absorptionScore >= 70 && (m.aggressiveSellsFailed === true || sellFade) && !regime.blocksMeanReversion;

  return {
    c24, c12, c4, btcRel, atrPct, volumeSpike, oiChange, funding,
    watchDrop, panicFlush, oiFlush, fundingOk, wickOk, bidsOk, sellFade,
    noNewLows, rangeFormed, lateShorts, squeeze, reclaim, higherLow,
    retestEntry, absorptionEntry, absorptionScore, buyDominance, shortLiq,
  };
}

export function classifyRadarStage(market, regime = evaluateMarketRegime([])) {
  const s = signalBooleans(market, regime);
  const reasons = [];
  const riskFlags = [];
  let stage = RADAR_STAGES.NO_SETUP;

  if (s.watchDrop && s.volumeSpike >= 1.2) {
    stage = RADAR_STAGES.WATCH;
    reasons.push(`relative flush watched (${round(s.c24, 2)}% 24h, volume x${round(s.volumeSpike, 1)})`);
  }
  if (stage === RADAR_STAGES.WATCH && s.panicFlush && s.fundingOk && s.wickOk && (s.oiFlush || s.bidsOk || s.c24 <= -8)) {
    stage = RADAR_STAGES.LONG_FLUSH_CONFIRMED;
    reasons.push('panic selling/long flush confirmed');
  }
  if (stage === RADAR_STAGES.LONG_FLUSH_CONFIRMED && s.noNewLows && s.rangeFormed && (s.sellFade || s.bidsOk || s.lateShorts)) {
    stage = RADAR_STAGES.STABILIZING;
    reasons.push('new lows paused and local range formed');
  }
  if (stage === RADAR_STAGES.STABILIZING && s.squeeze) {
    stage = RADAR_STAGES.SQUEEZE_CONFIRMED;
    reasons.push('reclaim/squeeze confirmation present');
  }
  let entryType = RADAR_ENTRY_TYPES.NONE;
  if ((stage === RADAR_STAGES.SQUEEZE_CONFIRMED || stage === RADAR_STAGES.STABILIZING) && (s.retestEntry || s.absorptionEntry)) {
    stage = RADAR_STAGES.ENTRY_READY;
    entryType = s.retestEntry ? RADAR_ENTRY_TYPES.RECLAIM_RETEST : RADAR_ENTRY_TYPES.ABSORPTION;
    reasons.push(entryType === RADAR_ENTRY_TYPES.RECLAIM_RETEST
      ? 'reclaim retest held with regime not breaking down'
      : 'support/liquidation low absorbed aggressive sells');
  }

  if (regime.blocksMeanReversion) riskFlags.push('market regime blocks mean reversion');
  if (s.funding != null && s.funding > 0.08) riskFlags.push('funding toxic/long crowded');
  if (s.oiChange != null && s.oiChange > 12) riskFlags.push('OI expansion may be leveraged crowding');
  if (market.spreadPct != null && market.spreadPct > 0.08) riskFlags.push('spread above ideal');
  if (stage === RADAR_STAGES.WATCH) riskFlags.push('falling knife risk until stabilization confirms');

  const baseScore = {
    [RADAR_STAGES.NO_SETUP]: 0,
    [RADAR_STAGES.WATCH]: 38,
    [RADAR_STAGES.LONG_FLUSH_CONFIRMED]: 55,
    [RADAR_STAGES.STABILIZING]: 66,
    [RADAR_STAGES.SQUEEZE_CONFIRMED]: 76,
    [RADAR_STAGES.ENTRY_READY]: 84,
  }[stage];
  const setupQualityScore = clamp(baseScore
    + Math.min(8, Math.max(0, (s.volumeSpike - 1.2) * 4))
    + (s.bidsOk ? 5 : 0)
    + (s.buyDominance >= 0.58 ? 5 : 0)
    - (regime.blocksMeanReversion ? 25 : 0)
    - (riskFlags.length * 3));
  const confidence = clamp(35 + (stage === RADAR_STAGES.NO_SETUP ? 0 : 10)
    + (market.depthUsd != null ? 10 : 0)
    + (s.oiChange != null ? 8 : 0)
    + (s.funding != null ? 8 : 0)
    + (s.shortLiq != null || s.longLiquidationSpike != null ? 8 : 0)
    + (market.spreadPct != null ? 5 : 0)
    - (regime.blocksMeanReversion ? 12 : 0));

  return {
    stage,
    setupQualityScore: round(setupQualityScore, 0),
    confidence: round(confidence, 0),
    entryType,
    reasons: compactReasons(reasons.length ? reasons : ['no flush/stabilization sequence confirmed'], 8),
    riskFlags: compactReasons(riskFlags, 8),
    _signals: s,
  };
}

export function buildPriceLevels(market, stageInfo = {}) {
  const px = market.mid || midPrice(market) || n(market.lastPrice ?? market.price);
  if (!(px > 0)) return { entryZone: null, invalidationLevel: null, suggestedStop: null };
  const atr = pctToRatio(market.atrPct ?? market.realizedVolatilityPct ?? Math.max(2, Math.abs(n(market.change24hPct ?? market.priceChangePercent, 0)) / 2));
  const low = n(market.flushLow ?? market.liquidationLow ?? market.localLow);
  const reclaim = n(market.reclaimLevel ?? market.vwap ?? market.rangeHigh);
  const support = low || reclaim || px * (1 - atr * 0.6);
  const entryType = stageInfo.entryType;
  const center = entryType === RADAR_ENTRY_TYPES.ABSORPTION ? support : (reclaim || px);
  const halfBand = Math.max(atr * 0.18, 0.0025);
  const stopBuffer = Math.max(atr * 0.35, 0.006);
  return {
    entryZone: { low: round(center * (1 - halfBand), 8), high: round(center * (1 + halfBand), 8) },
    invalidationLevel: round(support * (1 - stopBuffer), 8),
    suggestedStop: round(support * (1 - stopBuffer * 1.15), 8),
    takeProfitCheckpoints: [
      { label: 'TP1', pct: 6, level: round(px * 1.06, 8) },
      { label: 'TP2', pct: 11, level: round(px * 1.11, 8) },
      { label: 'TP3', pct: 16, level: round(px * 1.16, 8) },
    ],
  };
}

function componentScore(positive, negative, fallback = 55) {
  let score = fallback;
  for (const p of positive) if (p) score += 9;
  for (const n1 of negative) if (n1) score -= 13;
  return clamp(score);
}

export function scoreExitQuality({ market = {}, position = {}, regime = evaluateMarketRegime([]), now = Date.now() } = {}) {
  const px = n(market.mid ?? market.lastPrice ?? market.price ?? position.currentPrice) || midPrice(market);
  const entry = n(position.entryPrice ?? position.entry);
  const pnlPct = entry > 0 && px > 0 ? ((px - entry) / entry) * 100 : n(position.pnlPct, 0);
  const openedAt = position.openedAt ? new Date(position.openedAt).getTime() : null;
  const ageMin = Number.isFinite(openedAt) ? Math.max(0, (now - openedAt) / 60000) : null;
  const s = signalBooleans(market, regime);
  const spread = n(market.spreadPct);
  const oi = n(market.openInterestChangePct);
  const funding = n(market.fundingRate);

  const momentum = componentScore([
    market.higherHighs === true || market.higherLowHeld === true,
    market.vwapHeld === true || market.reclaimHeld === true,
    n(market.followThroughPct, 0) > 1.2,
  ], [
    market.noNewHigh === true,
    market.vwapLost === true || market.reclaimLost === true,
    market.lowerHigh === true || market.rejection === true,
  ]);
  const book = componentScore([
    n(market.bidDepthRebuildPct, 0) > 8,
    spread != null && spread <= 0.08,
    market.askWallsAbsorbed === true,
  ], [
    market.bidsVanished === true,
    market.askWallsReloaded === true,
    spread != null && spread > 0.15,
  ]);
  const flow = componentScore([
    n(market.spotVolumeConfirmPct, 0) > 1,
    s.buyDominance >= 0.55,
    market.sellVolumeFading === true,
  ], [
    market.greenNoFollowThrough === true,
    market.positiveDeltaNoAdvance === true,
    market.pullbackVolumeGtBreakout === true,
    market.perpsOnlyMove === true,
  ]);
  const deriv = componentScore([
    market.spotLed === true,
    oi == null || oi < 10,
    funding == null || funding <= 0.05,
  ], [
    oi != null && oi > 18,
    funding != null && funding > 0.08,
    market.leveragedLongCrowding === true,
  ]);
  const regimeScore = regime.blocksMeanReversion ? 25 : clamp(regime.score || 55);
  const maturity = componentScore([
    pnlPct > 0 && pnlPct < 12 && (ageMin == null || ageMin < 240),
    pnlPct >= 10 && n(market.followThroughPct, 0) > 1,
  ], [
    pnlPct >= 10 && ageMin != null && ageMin > 360,
    n(position.mfePct, 0) - pnlPct > 5,
  ], 55);

  const score = clamp(momentum * 0.20 + book * 0.20 + flow * 0.20 + deriv * 0.15 + regimeScore * 0.15 + maturity * 0.10);
  return {
    score: round(score, 0),
    components: {
      momentum: round(momentum, 0),
      orderBook: round(book, 0),
      flow: round(flow, 0),
      derivatives: round(deriv, 0),
      marketRegime: round(regimeScore, 0),
      tradeMaturity: round(maturity, 0),
    },
    pnlPct: round(pnlPct, 2),
  };
}

export function classifyExitMode(score, market = {}, regime = evaluateMarketRegime([])) {
  if (regime.blocksMeanReversion || market.vwapLost === true || market.reclaimLost === true || market.bidsVanished === true) {
    return RADAR_EXIT_MODES.EXHAUSTION_MODE;
  }
  if (score > 75) return RADAR_EXIT_MODES.EXPANSION_MODE;
  if (score >= 55) return RADAR_EXIT_MODES.NORMAL_MEAN_REVERSION_MODE;
  return RADAR_EXIT_MODES.EXHAUSTION_MODE;
}

function checkpointAction(pnlPct, score) {
  const hit = pnlPct >= 16 ? 3 : pnlPct >= 11 ? 2 : pnlPct >= 6 ? 1 : 0;
  if (!hit) return null;
  if (hit === 1) {
    if (score > 75) return { status: 'TRAIL_STOP', action: 'TP1: hold core, optional small 15-20% partial' };
    if (score >= 55) return { status: 'TAKE_PROFIT_PARTIAL', action: 'TP1: take 25-35%, trail remainder' };
    if (score >= 35) return { status: 'TAKE_PROFIT_AGGRESSIVE', action: 'TP1: take 40-50%, tighten stop' };
    return { status: 'EXIT_ALL', action: 'TP1: protect profit aggressively' };
  }
  if (hit === 2) {
    if (score > 75) return { status: 'TRAIL_STOP', action: 'TP2: hold core, small 15-25% partial' };
    if (score >= 55) return { status: 'TAKE_PROFIT_PARTIAL', action: 'TP2: take 30-40%, trail remainder' };
    if (score >= 35) return { status: 'TAKE_PROFIT_AGGRESSIVE', action: 'TP2: take 50-70%' };
    return { status: 'EXIT_ALL', action: 'TP2: exit weak distribution' };
  }
  if (score > 75) return { status: 'TAKE_PROFIT_PARTIAL', action: 'TP3: take 25-40% and trail runner; never hold 100%' };
  if (score >= 55) return { status: 'TAKE_PROFIT_AGGRESSIVE', action: 'TP3: take 60-80% and leave small runner' };
  return { status: 'EXIT_ALL', action: 'TP3: exit; continuation quality below threshold' };
}

export function buildExitGuidance({ market = {}, position = null, regime = evaluateMarketRegime([]), now = Date.now() } = {}) {
  if (!position) {
    return {
      STATUS: 'NO_ACTION',
      ACTION: 'No open/simulated position context supplied.',
      TAKE_PROFIT_LEVEL: null,
      STOP_LOSS_LEVEL: null,
      MODE: 'NO_POSITION',
      EXIT_QUALITY_SCORE: null,
      CONFIDENCE: 35,
      TIME_VALIDITY: 'until next public snapshot',
      REASON: 'RADAR is advisory and needs position context for exit guidance.',
      INVALIDATION: null,
    };
  }

  const px = n(market.mid ?? market.lastPrice ?? market.price ?? position.currentPrice) || midPrice(market);
  const entry = n(position.entryPrice ?? position.entry);
  const quality = scoreExitQuality({ market, position, regime, now });
  const mode = classifyExitMode(quality.score, market, regime);
  const pnlPct = quality.pnlPct || 0;
  const checkpoint = checkpointAction(pnlPct, quality.score);
  const levels = buildPriceLevels({ ...market, mid: px });
  let status = checkpoint ? checkpoint.status : (quality.score >= 75 ? 'HOLD' : quality.score >= 55 ? 'TRAIL_STOP' : 'WAIT_FOR_CONFIRMATION');
  let action = checkpoint ? checkpoint.action : (quality.score >= 75 ? 'Hold while structure expands; trail below higher low/VWAP.' : quality.score >= 55 ? 'Trail structurally; take partial if reclaim fails.' : 'Wait up to 15-30 minutes for continuation or reduce.');

  const emergency = regime.blocksMeanReversion || market.vwapLost === true || market.reclaimLost === true || market.bidsVanished === true || market.sellVolumeSpike === true || market.positiveDeltaNoAdvance === true;
  if (emergency) {
    status = regime.blocksMeanReversion ? 'RISK_OFF_EXIT' : (quality.score < 35 ? 'EXIT_ALL' : 'TAKE_PROFIT_AGGRESSIVE');
    action = regime.blocksMeanReversion ? 'Market regime broke down; protect capital/profit.' : 'Emergency profit protection triggered by structure/flow deterioration.';
  }

  if (pnlPct >= 6 && status === 'HOLD') status = 'TRAIL_STOP';
  const stop = pnlPct >= 6 && entry > 0 ? Math.max(entry, levels.suggestedStop || 0) : levels.suggestedStop;
  return {
    STATUS: status,
    ACTION: action,
    TAKE_PROFIT_LEVEL: px > 0 ? {
      TP1: round(px * 1.06, 8),
      TP2: round(px * 1.11, 8),
      TP3: round(px * 1.16, 8),
    } : null,
    STOP_LOSS_LEVEL: stop ? round(stop, 8) : null,
    MODE: mode,
    EXIT_QUALITY_SCORE: quality.score,
    CONFIDENCE: round(clamp(quality.score * 0.65 + (market.depthUsd != null ? 15 : 5) + (regime.score || 50) * 0.15), 0),
    TIME_VALIDITY: '15-30 minutes or until VWAP/reclaim/HL changes',
    REASON: `score ${quality.score}; pnl ${round(pnlPct, 2)}%; ${mode}`,
    INVALIDATION: emergency ? 'VWAP/reclaim/HL or market regime already violated' : 'VWAP/reclaim/last valid higher low fails',
    COMPONENTS: quality.components,
  };
}

function completeness(missingSignals) {
  const tracked = [
    'orderBookDepthWithin1Pct',
    'spreadPct',
    'midPrice',
    'openInterestChangePct',
    'fundingRate',
    'longLiquidationSpike',
    'shortLiquidationSpike',
    'marketSellRatio',
    'bidDepthRebuildPct',
    'vwap/reclaim/retest',
  ];
  const missing = new Set(missingSignals);
  const present = tracked.filter((x) => !missing.has(x)).length;
  return round((present / tracked.length) * 100, 0);
}

function missingForMarket(m) {
  const miss = [];
  if (m.depthUsd == null) miss.push('orderBookDepthWithin1Pct');
  if (m.spreadPct == null) miss.push('spreadPct');
  if (m.mid == null) miss.push('midPrice');
  if (m.openInterestChangePct == null) miss.push('openInterestChangePct');
  if (m.fundingRate == null) miss.push('fundingRate');
  if (m.longLiquidationSpike == null && m.longLiquidationUsd == null) miss.push('longLiquidationSpike');
  if (m.shortLiquidationSpike == null) miss.push('shortLiquidationSpike');
  if (m.marketSellRatio == null) miss.push('marketSellRatio');
  if (m.bidDepthRebuildPct == null && m.bidDepthChangePct == null) miss.push('bidDepthRebuildPct');
  if (!m.reclaimConfirmed && !m.vwapReclaimed && !m.rangeHighReclaimed && !m.retestHeld) miss.push('vwap/reclaim/retest');
  return miss;
}

export function evaluateTradingRadar({
  markets = [],
  source = 'unknown',
  fetchedAt = null,
  receivedAt = null,
  now = Date.now(),
  positions = [],
  selectedSymbol = null,
  filters = {},
} = {}) {
  const nowIso = new Date(now).toISOString();
  const state = defaultTradingRadarState(nowIso);
  state.source = source;
  const freshnessBase = fetchedAt || receivedAt;
  const freshnessMs = freshnessBase ? Math.max(0, now - new Date(freshnessBase).getTime()) : null;
  state.dataFreshnessMs = Number.isFinite(freshnessMs) ? freshnessMs : null;

  try {
    const { universe, diagnostics, missingSignals } = buildRadarUniverse(markets, { filters });
    const regime = evaluateMarketRegime(markets);
    const allMissing = new Set(missingSignals);
    const candidates = universe.map((m) => {
      for (const miss of missingForMarket(m)) allMissing.add(miss);
      const stageInfo = classifyRadarStage(m, regime);
      const levels = buildPriceLevels(m, stageInfo);
      return {
        symbol: m.symbol,
        stage: stageInfo.stage,
        setupQualityScore: stageInfo.setupQualityScore,
        confidence: stageInfo.confidence,
        entryType: stageInfo.entryType,
        entryZone: levels.entryZone,
        invalidationLevel: levels.invalidationLevel,
        suggestedStop: levels.suggestedStop,
        takeProfitCheckpoints: levels.takeProfitCheckpoints,
        reasons: stageInfo.reasons,
        riskFlags: stageInfo.riskFlags,
        diagnostics: {
          change24hPct: round(n(m.change24hPct ?? m.priceChangePercent), 2),
          spreadPct: round(m.spreadPct, 4),
          quoteVolume: round(m.quoteVolume, 0),
          depthUsd: round(m.depthUsd, 0),
          missingSignals: missingForMarket(m).slice(0, 8),
        },
      };
    }).filter((c) => c.stage !== RADAR_STAGES.NO_SETUP)
      .sort((a, b) => (b.setupQualityScore - a.setupQualityScore) || (b.confidence - a.confidence));

    const selected = selectedSymbol
      ? candidates.find((c) => c.symbol === String(selectedSymbol).toUpperCase()) || candidates[0] || null
      : candidates[0] || null;
    const position = Array.isArray(positions) && positions.length
      ? (selected ? positions.find((p) => String(p.symbol || '').toUpperCase() === selected.symbol) : null) || positions[0]
      : null;
    const positionSymbol = position ? String(position.symbol || '').toUpperCase() : null;
    const positionMarket = positionSymbol
      ? universe.find((m) => m.symbol === positionSymbol) || markets.find((m) => String(m.symbol || '').toUpperCase() === positionSymbol) || {}
      : (selected ? universe.find((m) => m.symbol === selected.symbol) || {} : {});

    state.marketRegime = regime;
    state.universeDiagnostics = diagnostics;
    state.candidates = candidates.slice(0, 10);
    state.watchlist = candidates.filter((c) => c.stage !== RADAR_STAGES.ENTRY_READY).slice(0, 20);
    state.entryReady = candidates.filter((c) => c.stage === RADAR_STAGES.ENTRY_READY).slice(0, 10);
    state.selected = selected;
    state.exitGuidance = buildExitGuidance({ market: positionMarket, position, regime, now });
    state.missingSignals = Array.from(allMissing).sort();
    state.dataCompleteness = completeness(state.missingSignals);
    if (freshnessMs != null && freshnessMs > 120000) {
      state.missingSignals = Array.from(new Set([...state.missingSignals, 'fresh public snapshot'])).sort();
    }
    return state;
  } catch (err) {
    return { ...state, lastError: err && err.message ? err.message : String(err) };
  }
}
