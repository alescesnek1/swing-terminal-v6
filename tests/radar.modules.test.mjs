import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyFleet } from '../netlify/functions/_fleet-store.mjs';
import {
  RADAR_STAGES,
  RADAR_ENTRY_TYPES,
  RADAR_EXIT_MODES,
  buildRadarUniverse,
  classifyRadarStage,
  evaluateTradingRadar,
  scoreExitQuality,
  classifyExitMode,
  buildExitGuidance,
} from '../scripts/radar/trading-radar.mjs';

const NOW = new Date('2026-06-12T10:00:00Z').getTime();
const BTC = { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 900e6, bidPrice: 70000, askPrice: 70007, spreadPct: 0.01, change24hPct: 1.2 };
const ETH = { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 600e6, bidPrice: 3600, askPrice: 3601, spreadPct: 0.03, change24hPct: 0.8 };
const FLUSH = {
  symbol: 'SOLUSDT',
  baseAsset: 'SOL',
  quoteAsset: 'USDT',
  status: 'TRADING',
  quoteVolume24h: 250e6,
  bidPrice: 140,
  askPrice: 140.04,
  spreadPct: 0.028,
  change24hPct: -9.5,
  volumeSpike: 2.4,
  atrPct: 4,
  longLiquidationSpike: 2.2,
  openInterestChangePct: -7,
  marketSellRatio: 0.68,
  fundingRate: -0.01,
  wickRecoveryPct: 48,
  noNewLowMinutes: 34,
  rangeFormed: true,
  sellAggressionFading: true,
  bidDepthRebuildPct: 14,
  reclaimConfirmed: true,
  retestHeld: true,
  shortLiquidationSpike: 1.5,
  marketBuyVolumeDominance: 0.59,
  higherLowHeld: true,
  vwap: 140,
  flushLow: 132,
  depthUsdWithin1Pct: 1_800_000,
};

test('RADAR universe filters liquid stablecoin spot pairs and rejects weird/thin books', () => {
  const { universe, diagnostics } = buildRadarUniverse([
    BTC,
    { symbol: 'BTCUPUSDT', baseAsset: 'BTCUP', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 100e6, spreadPct: 0.01 },
    { symbol: 'DUSTUSDT', baseAsset: 'DUST', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 1000, spreadPct: 0.01 },
    { symbol: 'WIDEUSDT', baseAsset: 'WIDE', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 30e6, spreadPct: 0.4 },
    { symbol: 'THINUSDT', baseAsset: 'THIN', quoteAsset: 'USDT', status: 'TRADING', quoteVolume24h: 30e6, spreadPct: 0.01, depthUsdWithin1Pct: 1000 },
  ]);
  assert.deepEqual(universe.map((m) => m.symbol), ['BTCUSDT']);
  assert.equal(diagnostics.rejected['weird/leverage token'], 1);
  assert.equal(diagnostics.rejected['low 24h volume'], 1);
  assert.equal(diagnostics.rejected['wide spread'], 1);
  assert.equal(diagnostics.rejected['thin order book depth'], 1);
});

test('RADAR stages progress from watch through entry-ready when flush exhaustion confirms', () => {
  const watch = classifyRadarStage({ ...FLUSH, noNewLowMinutes: 0, rangeFormed: false, reclaimConfirmed: false, retestHeld: false });
  assert.equal(watch.stage, RADAR_STAGES.LONG_FLUSH_CONFIRMED);
  const stable = classifyRadarStage({ ...FLUSH, reclaimConfirmed: false, retestHeld: false });
  assert.equal(stable.stage, RADAR_STAGES.STABILIZING);
  const ready = classifyRadarStage(FLUSH, { blocksMeanReversion: false, score: 75 });
  assert.equal(ready.stage, RADAR_STAGES.ENTRY_READY);
  assert.equal(ready.entryType, RADAR_ENTRY_TYPES.RECLAIM_RETEST);
});

test('RADAR can classify absorption entry-ready without buying a falling knife', () => {
  const ready = classifyRadarStage({
    ...FLUSH,
    reclaimConfirmed: false,
    retestHeld: false,
    absorptionScore: 82,
    aggressiveSellsFailed: true,
  }, { blocksMeanReversion: false, score: 70 });
  assert.equal(ready.stage, RADAR_STAGES.ENTRY_READY);
  assert.equal(ready.entryType, RADAR_ENTRY_TYPES.ABSORPTION);
  assert.ok(ready.reasons.some((r) => /absorbed/.test(r)));
});

test('RADAR market-regime breakdown downgrades entry candidates', () => {
  const state = evaluateTradingRadar({
    markets: [{ ...BTC, change24hPct: -5 }, { ...ETH, change24hPct: -6 }, FLUSH],
    source: 'test',
    fetchedAt: new Date(NOW).toISOString(),
    now: NOW,
  });
  assert.equal(state.marketRegime.blocksMeanReversion, true);
  assert.notEqual(state.entryReady.length, 1, 'breakdown regime blocks entry-ready recommendations');
  assert.ok((state.candidates[0].riskFlags || []).includes('market regime blocks mean reversion'));
});

test('RADAR returns concrete price zones, missing-signal diagnostics, and stale freshness warnings', () => {
  const state = evaluateTradingRadar({
    markets: [BTC, ETH, { ...FLUSH, depthUsdWithin1Pct: undefined }],
    source: 'local_worker_binance_public',
    fetchedAt: new Date(NOW - 180000).toISOString(),
    now: NOW,
  });
  assert.ok(state.selected.entryZone.low > 0);
  assert.ok(state.selected.invalidationLevel > 0);
  assert.ok(state.missingSignals.includes('orderBookDepthWithin1Pct'));
  assert.ok(state.missingSignals.includes('fresh public snapshot'));
  assert.ok(state.dataCompleteness < 100);
});

test('RADAR exit quality and modes follow TP checkpoint/profit-protection rules', () => {
  const market = {
    ...FLUSH,
    bidPrice: 116,
    askPrice: 116.02,
    change24hPct: 4,
    higherHighs: true,
    vwapHeld: true,
    followThroughPct: 2,
    spotVolumeConfirmPct: 1.5,
    spotLed: true,
    sellVolumeFading: true,
  };
  const position = { symbol: 'SOLUSDT', entryPrice: 100, openedAt: new Date(NOW - 60 * 60000).toISOString(), mfePct: 17 };
  const quality = scoreExitQuality({ market, position, regime: { blocksMeanReversion: false, score: 78 }, now: NOW });
  assert.ok(quality.score > 75);
  assert.equal(classifyExitMode(quality.score, market, { blocksMeanReversion: false, score: 78 }), RADAR_EXIT_MODES.EXPANSION_MODE);
  const guidance = buildExitGuidance({ market, position, regime: { blocksMeanReversion: false, score: 78 }, now: NOW });
  assert.equal(guidance.STATUS, 'TAKE_PROFIT_PARTIAL');
  assert.match(guidance.ACTION, /TP3/);
  assert.match(guidance.ACTION, /never hold 100%/);
});

test('RADAR emergency profit protection exits on regime/structure failure', () => {
  const guidance = buildExitGuidance({
    market: { ...FLUSH, bidPrice: 108, askPrice: 108.1, vwapLost: true, bidsVanished: true },
    position: { symbol: 'SOLUSDT', entryPrice: 100, openedAt: new Date(NOW - 45 * 60000).toISOString() },
    regime: { blocksMeanReversion: true, score: 25 },
    now: NOW,
  });
  assert.equal(guidance.STATUS, 'RISK_OFF_EXIT');
  assert.equal(guidance.MODE, RADAR_EXIT_MODES.EXHAUSTION_MODE);
});

test('fleet empty state persists tradingRadar top-level field', () => {
  const fleet = emptyFleet();
  assert.ok(Object.hasOwn(fleet, 'tradingRadar'));
  fleet.tradingRadar = evaluateTradingRadar({ markets: [BTC, ETH, FLUSH], source: 'test', fetchedAt: new Date(NOW).toISOString(), now: NOW });
  assert.equal(fleet.tradingRadar.selected.symbol, 'SOLUSDT');
});
