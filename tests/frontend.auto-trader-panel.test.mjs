import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const terminalCss = fs.readFileSync(new URL('../apps/edge/public/css/terminal.css', import.meta.url), 'utf8');

test('UI renders an AUTO TRADER cockpit panel with mode, candidate, score, reasons and blocks', () => {
  assert.match(terminalJs, /AUTO TRADER/);
  assert.match(terminalJs, /auto\.status \|\| 'OFF'/);
  assert.match(terminalJs, /Candidate/);
  assert.match(terminalJs, /Score/);
  assert.match(terminalJs, /Reasons/);
  assert.match(terminalJs, /Risk blocks/);
  assert.match(terminalJs, /Daily trades/);
  assert.match(terminalJs, /Position mgmt/);
  assert.match(terminalCss, /\.fleet-auto-trader/);
});

test('UI exposes shadow, disable, paper and live promotion controls, and hides/disables shadow when active', () => {
  assert.match(terminalJs, /Enable Shadow Auto/);
  assert.match(terminalJs, /Disable Auto/);
  assert.match(terminalJs, /Promote to Paper/);
  assert.match(terminalJs, /Promote to Live/);
  assert.match(terminalJs, /function setAutoTraderMode\(mode\)/);
  assert.ok(terminalJs.includes("setAutoTraderMode(\\'shadow\\')"));
  assert.ok(terminalJs.includes("setAutoTraderMode(\\'paper\\')"));
  assert.match(terminalJs, /auto\.effectiveMode === 'shadow' \? ' disabled title="Shadow Auto is already active"' : ''/);
  assert.match(terminalJs, /Shadow observation active/);
  assert.match(terminalJs, /Diagnostics/);
  assert.match(terminalJs, /auto\.universeDiagnostics/);
});

test('live auto promotion uses explicit modal phrase confirmation', () => {
  assert.match(terminalJs, /function openPromoteAutoLiveModal/);
  assert.match(terminalJs, /I UNDERSTAND AUTONOMOUS LIVE SPOT USES REAL MONEY/);
  assert.match(terminalJs, /phraseExpected: phrase/);
  assert.match(terminalJs, /confirmLivePhrase: phrase/);
  assert.match(terminalJs, /updateBotConfirmPhrase/);
  assert.match(terminalCss, /\.bot-confirm__input/);
});

test('auto trader panel shows daily cap exhaustion as a risk block and disables live promotion', () => {
  assert.match(terminalJs, /autoBlocks\.push\(\{ code: 'DAILY_TRADES_CAP', reason: dailyCapReason \}\)/);
  assert.match(terminalJs, /const autoCanPromoteLive = auto\.canPromoteLive === true && auto\.liveExecutionAllowed === true && !dailyCapReason;/);
  assert.match(terminalJs, /Daily live trade cap exhausted/);
});
