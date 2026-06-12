import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');
const botSrc = fs.readFileSync(new URL('../netlify/functions/bot.mjs', import.meta.url), 'utf8');

test('UI renders a Trading RADAR advisory panel with overview, leaderboard, detail, exit guidance and diagnostics', () => {
  assert.match(terminalJs, /TRADING RADAR/);
  assert.match(terminalJs, /ADVISORY ONLY/);
  assert.match(terminalJs, /Candidate Leaderboard/);
  assert.match(terminalJs, /Selected Candidate/);
  assert.match(terminalJs, /Exit Guidance/);
  assert.match(terminalJs, /BTC\/ETH Regime/);
  assert.match(terminalJs, /Diagnostics/);
  assert.match(terminalJs, /data\.tradingRadar/);
  assert.match(terminalCss, /\.trading-radar/);
  assert.match(terminalCss, /\.radar-score--good/);
});

test('Trading RADAR backend is read-only and exposed through fleet state only', () => {
  assert.match(botSrc, /evaluateTradingRadar/);
  assert.match(botSrc, /tradingRadar: tradingRadarView/);
  assert.match(botSrc, /refreshTradingRadarFromFleet/);
  assert.doesNotMatch(botSrc, /tradingRadar[\s\S]{0,120}executionIntents\[/);
  assert.doesNotMatch(botSrc, /TRADING_RADAR[\s\S]{0,160}create-live-execution-intent/);
});
