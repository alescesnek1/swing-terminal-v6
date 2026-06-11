import test from 'node:test';
import assert from 'node:assert/strict';

import { createAutoLoop, autoIdempotencyKey } from '../scripts/auto/auto-loop.mjs';

const SNAPSHOT = {
  fetchedAt: new Date().toISOString(),
  markets: [
    { symbol: 'BTCUSDC', baseAsset: 'BTC', quoteAsset: 'USDC', status: 'TRADING', quoteVolume: 500000000, spreadPct: 0.01, priceChangePercent: 4 },
  ],
};

function deps(over = {}) {
  let control = over.control || {
    enabled: true,
    mode: 'shadow',
    effectiveMode: 'shadow',
    receivedAt: 1000,
    buyScoreThreshold: 1,
    caps: { minPositionUsd: 6, maxPositionUsd: 6, maxDailyTrades: 2, maxDailyLossUsd: 5, maxOpenPositions: 1 },
    liveAllowedSymbols: ['BTCUSDC'],
    gates: { durable: true, preflightFresh: true, openPositions: 0, pendingIntent: false, safetyLock: false, globalKill: false, sessionPaused: false, dailyTradesUsed: 0, dailyLossUsd: 0, freeQuote: 100, quoteAsset: 'USDC' },
    regime: { regime: 'RISK_ON', entriesAllowed: true },
  };
  const decisions = [];
  const intents = [];
  const state = {
    now: 1000,
    control,
    decisions,
    intents,
    loop: createAutoLoop({
      env: over.env || { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: control.mode },
      sessionId: 'session_loop',
      log: () => {},
      getControl: () => state.control,
      isStopping: () => false,
      isHydrated: () => over.hydrated !== false,
      backendHealthy: () => over.backendHealthy !== false,
      getOpenPositions: () => over.openPositions || [],
      getSnapshot: () => ({ snapshot: SNAPSHOT, ageMs: 1000 }),
      refreshSnapshot: async () => SNAPSHOT,
      getPrice: async () => over.price,
      updatePosition: () => {},
      postDecision: async (p) => { decisions.push(p); return { ok: true }; },
      requestIntent: async (p) => { intents.push(p); return { status: 200, json: { ok: true, intent: { id: 'intent_1' } } }; },
      now: () => state.now,
      setIntervalFn: () => ({ unref() {} }),
      clearIntervalFn: () => {},
      evalIntervalMs: 60000,
    }),
  };
  return state;
}

test('worker auto loop in shadow posts decisions and creates zero intents', async () => {
  const s = deps();
  const result = await s.loop.tick('test');
  assert.equal(result.action, 'SHADOW_BUY');
  assert.equal(s.decisions.length, 1);
  assert.equal(s.decisions[0].action, 'SHADOW_BUY');
  assert.equal(s.decisions[0].dataSource, 'local_worker_binance_public');
  assert.equal(s.intents.length, 0);
});

test('paper loop creates only paper/testnet intent requests', async () => {
  const control = {
    ...deps().control,
    mode: 'paper',
    effectiveMode: 'paper',
    receivedAt: 1000,
  };
  const s = deps({ control, env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'paper' } });
  const result = await s.loop.tick('test');
  assert.equal(result.action, 'PAPER_BUY');
  assert.equal(s.intents.length, 1);
  assert.equal(s.intents[0].mode, 'paper');
  assert.equal(s.intents[0].action, 'BUY');
  assert.equal(s.intents[0].symbol, 'BTCUSDC');
});

test('live loop creates no intent unless all gates pass', async () => {
  const control = {
    ...deps().control,
    mode: 'live_spot',
    effectiveMode: 'live_locked',
    receivedAt: 1000,
  };
  const s = deps({ control, env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'live_spot' } });
  const result = await s.loop.tick('test');
  assert.notEqual(result.action, 'LIVE_BUY');
  assert.equal(s.intents.length, 0);
  assert.ok(s.decisions[0].riskBlocks.some((b) => b.code === 'LIVE_GATE'));
});

test('backend connection failure blocks new entries before decision/intent posts', async () => {
  const s = deps({ backendHealthy: false });
  const result = await s.loop.tick('test');
  assert.equal(result.blocked, 'backend_unreachable');
  assert.equal(s.decisions.length, 0);
  assert.equal(s.intents.length, 0);
});

test('worker restart hydration gate blocks entry intent after posting diagnostics', async () => {
  const control = { ...deps().control, mode: 'paper', effectiveMode: 'paper', receivedAt: 1000 };
  const s = deps({ control, env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'paper' }, hydrated: false });
  const result = await s.loop.tick('test');
  assert.equal(result.action, 'BLOCKED');
  assert.equal(s.intents.length, 0);
  assert.ok(s.decisions[0].riskBlocks.some((b) => b.code === 'NOT_HYDRATED'));
});

test('timers do not duplicate after reconnect/start and stop clears timer', () => {
  let intervals = 0;
  let clears = 0;
  const loop = createAutoLoop({
    getControl: () => null,
    setIntervalFn: () => { intervals++; return { unref() {} }; },
    clearIntervalFn: () => { clears++; },
  });
  assert.equal(loop.start(), true);
  assert.equal(loop.start(), false);
  assert.equal(intervals, 1);
  assert.equal(loop.stop(), true);
  assert.equal(clears, 1);
});

test('open position exit management creates close decision for stop loss', async () => {
  const control = { ...deps().control, mode: 'paper', effectiveMode: 'paper', receivedAt: 1000 };
  const pos = { symbol: 'BTCUSDC', entryPrice: 100, openedAt: new Date(0).toISOString(), peakPrice: 100 };
  const s = deps({ control, env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'paper', AUTO_STOP_LOSS_PCT: '1' }, openPositions: [pos], price: 98 });
  const result = await s.loop.tick('test');
  assert.equal(result.action, 'CLOSE');
  assert.equal(s.decisions[0].positionMgmt.exitCode, 'STOP_LOSS');
  assert.equal(s.intents.length, 1);
  assert.equal(s.intents[0].action, 'CLOSE');
});

test('auto idempotency key is stable inside a time bucket', () => {
  const a = autoIdempotencyKey({ sessionId: 's', symbol: 'btcusdc', side: 'buy', now: 1000, bucketMs: 5000 });
  const b = autoIdempotencyKey({ sessionId: 's', symbol: 'BTCUSDC', side: 'BUY', now: 4999, bucketMs: 5000 });
  const c = autoIdempotencyKey({ sessionId: 's', symbol: 'BTCUSDC', side: 'BUY', now: 5000, bucketMs: 5000 });
  assert.equal(a, b);
  assert.notEqual(a, c);
});
