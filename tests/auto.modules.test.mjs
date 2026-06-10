// Unit tests for the autonomous trading layer (scripts/auto/*). Pure modules — no
// network, no Binance, no order submission. Proves the safety contract: shadow never
// creates intents, paper never creates a live intent, live requires every gate, and
// no futures/margin/leverage endpoint is ever introduced.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { readAutoEnv, effectiveAutoMode, autoLiveExecutionAllowed, AUTO_LIVE_REQUIRED_FLAGS } from '../scripts/auto/auto-env.mjs';
import { buildUniverse } from '../scripts/auto/auto-universe.mjs';
import { scoreCandidate, scoreUniverse } from '../scripts/auto/auto-scorer.mjs';
import { evaluateEntryGates } from '../scripts/auto/auto-risk.mjs';
import { evaluateExit } from '../scripts/auto/auto-exit-manager.mjs';
import { decideEntry, buildEntryIntent } from '../scripts/auto/auto-strategy.mjs';
import { evaluateAutoTrader } from '../scripts/auto/auto-trader.mjs';

const FULL_LIVE_ENV = {
  AUTO_TRADER_ENABLED: 'true',
  AUTO_TRADER_MODE: 'live_spot',
  AUTO_LIVE_TRADING_ENABLED: 'true',
  BOT_LIVE_TRADING_ENABLED: 'true',
  BOT_ALLOW_REAL_ORDERS: 'true',
  LOCAL_WORKER_LIVE_CONFIRM: 'true',
  LIVE_SPOT_ACK: 'I_UNDERSTAND_REAL_MONEY_RISK',
};
const CAPS = { maxPositionUsd: 6, minPositionUsd: 6, maxDailyTrades: 2, maxDailyLossUsd: 5, maxOpenPositions: 1 };
const BTC = { symbol: 'BTCUSDC', quoteAsset: 'USDC', baseAsset: 'BTC', volume24hUsd: 5e8, spreadPct: 0.02, change24hPct: 4, volatilityPct: 4, status: 'TRADING' };
const HEALTHY_FLEET = {
  durable: true, preflightFresh: true, workerOnline: true, openPositions: 0, pendingIntent: false,
  safetyLock: false, globalKill: false, sessionPaused: false, dailyTradesUsed: 0, dailyLossUsd: 0,
  freeQuote: 100, quoteAsset: 'USDC',
};
const markets = [
  BTC,
  { symbol: 'ETHUSDC', quoteAsset: 'USDC', baseAsset: 'ETH', volume24hUsd: 2e8, spreadPct: 0.03, change24hPct: 2, status: 'TRADING' },
  { symbol: 'DOGEUSDT', quoteAsset: 'USDT', baseAsset: 'DOGE', volume24hUsd: 1e8, spreadPct: 0.05, change24hPct: 1, status: 'TRADING' },
  { symbol: 'BTCUP', quoteAsset: 'USDC', baseAsset: 'BTCUP', volume24hUsd: 9e8, spreadPct: 0.01, status: 'TRADING' },
  { symbol: 'JUNKUSDC', quoteAsset: 'USDC', baseAsset: 'JUNK', volume24hUsd: 1000, spreadPct: 0.9, status: 'TRADING' },
];

// 1. auto universe respects live allowlist
test('1. universe respects the live allowlist (USDC, non-leveraged, liquid only)', () => {
  const { universe, rejected } = buildUniverse({ markets, mode: 'live_spot', liveAllowedSymbols: ['BTCUSDC'] });
  assert.deepEqual(universe.map((u) => u.symbol), ['BTCUSDC'], 'live universe is exactly the allowlist intersection');
  // The leveraged token, the USDT pair, the illiquid junk, and the non-allowlisted
  // ETHUSDC are all rejected with reasons.
  const reasons = Object.fromEntries(rejected.map((r) => [r.symbol, r.reason]));
  assert.match(reasons.BTCUP, /leveraged/);
  assert.match(reasons.DOGEUSDT, /quote/);
  assert.match(reasons.JUNKUSDC, /low volume|wide spread/);
  assert.match(reasons.ETHUSDC, /allowlist/);
});

test('1b. shadow/paper universe allows all USDC liquid pairs but still drops leverage/USDT/junk', () => {
  const { universe } = buildUniverse({ markets, mode: 'paper', liveAllowedSymbols: ['BTCUSDC'] });
  const syms = universe.map((u) => u.symbol).sort();
  assert.deepEqual(syms, ['BTCUSDC', 'ETHUSDC']);
});

// 2. auto scorer returns reasons and risk flags
test('2. scorer returns score, reasons and risk flags', () => {
  const s = scoreCandidate({ market: { ...BTC, spreadPct: 0.4, volatilityPct: 12 }, regime: { regime: 'RISK_OFF' }, blacklist: ['BTCUSDC'], cooldowns: {}, caps: CAPS });
  assert.equal(s.symbol, 'BTCUSDC');
  assert.ok(Number.isFinite(s.score));
  assert.ok(s.reasons.length > 0, 'reasons present');
  assert.ok(s.riskFlags.includes('high volatility'));
  assert.ok(s.riskFlags.includes('wide spread'));
  assert.ok(s.riskFlags.includes('regime risk-off'));
  assert.ok(s.riskFlags.includes('blacklisted'));
  assert.equal(s.recommendedPositionUsd, 6);
  const ranked = scoreUniverse([BTC, { ...BTC, symbol: 'ETHUSDC', change24hPct: -4 }], { caps: CAPS });
  assert.equal(ranked[0].symbol, 'BTCUSDC', 'higher-momentum candidate ranks first');
});

// 3. shadow mode never creates a live OR testnet order intent, does not require live gates, and evaluates despite daily cap
test('3. shadow mode never creates any execution intent and evaluates despite daily cap', () => {
  // Pass NO live env variables (AUTO_LIVE_TRADING_ENABLED is missing), and daily cap is exhausted
  const out = evaluateAutoTrader({ env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'shadow' }, markets, caps: CAPS, fleet: { ...HEALTHY_FLEET, dailyTradesUsed: 2 }, threshold: 1, sessionId: 'sess_1', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.mode, 'shadow');
  assert.equal(out.decision, 'SHADOW_BUY');
  assert.equal(out.intent, null, 'shadow emits no intent');
  assert.ok(out.candidate, 'shadow candidate is evaluated even when daily cap exhausted and live gates missing');
  assert.ok(out.blocks.some(b => b.code === 'DAILY_TRADES_CAP'), 'daily cap block is recorded for shadow');
  
  // buildEntryIntent also refuses for shadow regardless of decision.
  assert.equal(buildEntryIntent({ action: 'BUY', symbol: 'BTCUSDC', positionUsd: 6 }, { sessionId: 's', mode: 'shadow' }), null);
});

test('3b. shadow tick with empty scanner data falls back to BTCUSDC with FALLBACK_ALLOWLIST_SYMBOL', () => {
  const out = evaluateAutoTrader({
    env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'shadow' },
    markets: [], // empty scanner data
    caps: CAPS,
    fleet: HEALTHY_FLEET,
    threshold: 0, // ensure score > threshold passes even if score is 0
    sessionId: 'sess_1',
    regime: { regime: 'RISK_ON', entriesAllowed: true },
    liveAllowedSymbols: ['BTCUSDC']
  });
  
  assert.equal(out.mode, 'shadow');
  assert.equal(out.decision, 'SHADOW_BUY');
  assert.ok(out.candidate, 'fallback candidate is generated');
  assert.equal(out.candidate.symbol, 'BTCUSDC', 'fallback uses allowed symbol');
  assert.ok(out.candidate.riskFlags.includes('FALLBACK_ALLOWLIST_SYMBOL'), 'fallback risk flag is set');
  assert.ok(out.diagnostics, 'diagnostics object is returned');
  assert.equal(out.diagnostics.dataSource, 'fallback', 'dataSource indicates fallback');
  assert.equal(out.diagnostics.universeTotal, 0, 'original scanner universe was 0');
});

// 4. paper mode cannot create a live intent
test('4. paper mode only ever creates a paper/testnet intent, never live', () => {
  const out = evaluateAutoTrader({ env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'paper' }, markets, caps: CAPS, fleet: HEALTHY_FLEET, threshold: 1, sessionId: 'sess_paper', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.decision, 'PAPER_INTENT');
  assert.ok(out.intent, 'paper intent created');
  assert.equal(out.intent.mode, 'paper');
  assert.equal(out.intent.realProductionOrder, false);
  assert.equal(out.intent.testnet, true);
  assert.notEqual(out.intent.endpoint, '/api/bot/create-live-execution-intent');
  const live = buildEntryIntent({ action: 'BUY', symbol: 'BTCUSDC', positionUsd: 6 }, { sessionId: 's', mode: 'paper' });
  assert.notEqual(live.mode, 'live_spot');
});

// 5. live mode cannot create an intent unless ALL live gates pass
test('5. live mode requires the full live gate before any intent', () => {
  // Missing the env gate → blocked even though everything else is healthy.
  const noGate = evaluateAutoTrader({ env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'live_spot' }, markets, caps: CAPS, fleet: HEALTHY_FLEET, threshold: 1, sessionId: 'sess_live', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(noGate.decision, 'BLOCKED');
  assert.equal(noGate.intent, null);
  assert.ok(noGate.blocks.some((b) => b.code === 'LIVE_GATE'));
  // Full env + healthy fleet → a live intent is produced.
  const ok = evaluateAutoTrader({ env: FULL_LIVE_ENV, markets, caps: CAPS, fleet: HEALTHY_FLEET, threshold: 1, sessionId: 'sess_live', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(ok.decision, 'LIVE_INTENT');
  assert.ok(ok.intent);
  assert.equal(ok.intent.mode, 'live_spot');
  assert.equal(ok.intent.realProductionOrder, true);
  assert.equal(ok.intent.endpoint, '/api/bot/create-live-execution-intent');
});

// 6. one-open-position rule blocks auto buy (entry path not reached → exit path)
test('6. an open position blocks a new auto buy', () => {
  const gates = evaluateEntryGates({ mode: 'paper', durable: true, workerOnline: true, openPositions: 1, positionUsd: 6, minPositionUsd: 6, maxPositionUsd: 6, maxDailyTrades: 2, maxOpenPositions: 1 });
  assert.equal(gates.allowed, false);
  assert.ok(gates.blocks.some((b) => b.code === 'POSITION_OPEN'));
});

// 7. pending-intent rule blocks a duplicate buy
test('7. a pending intent blocks a duplicate auto buy', () => {
  const out = evaluateAutoTrader({ env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'paper' }, markets, caps: CAPS, fleet: { ...HEALTHY_FLEET, pendingIntent: true }, threshold: 1, sessionId: 's', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.decision, 'BLOCKED');
  assert.equal(out.intent, null);
  assert.ok(out.blocks.some((b) => b.code === 'PENDING_INTENT'));
});

// 8. daily trade cap blocks new entries
test('8. exhausted daily trade cap blocks new entries', () => {
  const out = evaluateAutoTrader({ env: FULL_LIVE_ENV, markets, caps: CAPS, fleet: { ...HEALTHY_FLEET, dailyTradesUsed: 2 }, threshold: 1, sessionId: 's', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.intent, null);
  assert.ok(out.blocks.some((b) => b.code === 'DAILY_TRADES_CAP'));
});

// 9. loss cap blocks new entries
test('9. exhausted daily loss cap blocks new entries', () => {
  const gates = evaluateEntryGates({ mode: 'paper', durable: true, workerOnline: true, openPositions: 0, dailyLossUsd: 5, maxDailyLossUsd: 5, maxDailyTrades: 2, positionUsd: 6, minPositionUsd: 6, maxPositionUsd: 6 });
  assert.equal(gates.allowed, false);
  assert.ok(gates.blocks.some((b) => b.code === 'DAILY_LOSS_CAP'));
});

// 10-13. exit triggers create a close decision
const POS = { entryPrice: 100, openedAt: new Date(Date.now() - 60_000).toISOString(), peakPrice: 120 };
test('10. stop loss creates a close decision', () => {
  const e = evaluateExit({ position: POS, price: 96, config: { stopLossPct: 3, takeProfitPct: 15 } });
  assert.equal(e.shouldClose, true);
  assert.equal(e.code, 'STOP_LOSS');
});
test('11. take profit creates a close decision', () => {
  const e = evaluateExit({ position: POS, price: 116, config: { stopLossPct: 3, takeProfitPct: 15 } });
  assert.equal(e.shouldClose, true);
  assert.equal(e.code, 'TAKE_PROFIT');
});
test('12. trailing stop creates a close decision', () => {
  const e = evaluateExit({ position: POS, price: 110, config: { stopLossPct: 50, takeProfitPct: 100, trailingStopPct: 5 } });
  assert.equal(e.shouldClose, true);
  assert.equal(e.code, 'TRAILING_STOP');
});
test('13. max hold time creates a close decision', () => {
  const e = evaluateExit({ position: { entryPrice: 100, openedAt: new Date(Date.now() - 3_600_000).toISOString() }, price: 101, config: { stopLossPct: 50, takeProfitPct: 100, maxHoldMs: 60_000 } });
  assert.equal(e.shouldClose, true);
  assert.equal(e.code, 'MAX_HOLD');
});
test('13b. an open position routes the orchestrator into a close decision (paper → CLOSE_INTENT, shadow → hypothetical)', () => {
  const paper = evaluateAutoTrader({ env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'paper' }, markets, caps: CAPS, position: POS, price: 96, exitConfig: { stopLossPct: 3 }, sessionId: 'sess_x' });
  assert.equal(paper.decision, 'CLOSE_INTENT');
  assert.equal(paper.intent.type, 'CLOSE');
  assert.equal(paper.intent.endpoint, '/api/bot/session/sess_x/stop');
  const shadow = evaluateAutoTrader({ env: { AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'shadow' }, markets, caps: CAPS, position: POS, price: 96, exitConfig: { stopLossPct: 3 }, sessionId: 'sess_x' });
  assert.equal(shadow.decision, 'SHADOW_CLOSE');
  assert.equal(shadow.intent, null);
});

// 14. worker offline blocks auto buy
test('14. worker offline blocks an auto buy', () => {
  const out = evaluateAutoTrader({ env: FULL_LIVE_ENV, markets, caps: CAPS, fleet: { ...HEALTHY_FLEET, workerOnline: false }, threshold: 1, sessionId: 's', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.intent, null);
  assert.ok(out.blocks.some((b) => b.code === 'WORKER_OFFLINE'));
});

// 15. stale live preflight blocks auto buy
test('15. a stale live preflight blocks a live auto buy', () => {
  const out = evaluateAutoTrader({ env: FULL_LIVE_ENV, markets, caps: CAPS, fleet: { ...HEALTHY_FLEET, preflightFresh: false }, threshold: 1, sessionId: 's', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.intent, null);
  assert.ok(out.blocks.some((b) => b.code === 'PREFLIGHT_STALE'));
});

// 16. safety lock blocks auto buy
test('16. live safety lock blocks an auto buy', () => {
  const out = evaluateAutoTrader({ env: FULL_LIVE_ENV, markets, caps: CAPS, fleet: { ...HEALTHY_FLEET, safetyLock: true }, threshold: 1, sessionId: 's', regime: { regime: 'RISK_ON', entriesAllowed: true } });
  assert.equal(out.intent, null);
  assert.ok(out.blocks.some((b) => b.code === 'SAFETY_LOCK'));
});

// 17. no futures/margin/leverage endpoints introduced anywhere in the auto layer
test('17. the autonomous layer introduces no futures/margin/leverage/borrow endpoints', () => {
  const files = ['auto-env', 'auto-universe', 'auto-scorer', 'auto-strategy', 'auto-risk', 'auto-exit-manager', 'auto-trader'];
  const forbidden = [/\/fapi\//, /\/dapi\//, /\/sapi\//, /futures/i, /marginType/, /sideEffectType/, /\bleverage=/, /\/margin\/order/, /\/borrow/, /\/repay/, /\/withdraw/];
  for (const name of files) {
    const src = fs.readFileSync(new URL(`../scripts/auto/${name}.mjs`, import.meta.url), 'utf8');
    for (const re of forbidden) assert.doesNotMatch(src, re, `${name}.mjs must not reference ${re}`);
  }
});

// 20. autonomous live is impossible with the default (dormant) env
test('20. autonomous live is impossible with the default dormant env', () => {
  const def = {}; // nothing set
  assert.equal(readAutoEnv(def).enabled, false);
  assert.equal(readAutoEnv(def).mode, 'shadow');
  assert.equal(effectiveAutoMode(def), 'off');
  const gate = autoLiveExecutionAllowed(def);
  assert.equal(gate.allowed, false);
  assert.equal(gate.missing.length, AUTO_LIVE_REQUIRED_FLAGS.length, 'every live flag is missing by default');
  // Even if someone flips the trader on in live mode, missing flags keep it locked.
  assert.equal(effectiveAutoMode({ AUTO_TRADER_ENABLED: 'true', AUTO_TRADER_MODE: 'live_spot' }), 'live_locked');
  const out = evaluateAutoTrader({ env: def, markets, caps: CAPS, fleet: HEALTHY_FLEET, threshold: 1, sessionId: 's' });
  assert.equal(out.decision, 'OFF');
  assert.equal(out.intent, null);
});
