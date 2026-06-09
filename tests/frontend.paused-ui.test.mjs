import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');

function extractFunctionSource(name) {
  const start = terminalJs.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} exists`);
  const brace = terminalJs.indexOf('{', start);
  let depth = 0;
  for (let i = brace; i < terminalJs.length; i += 1) {
    if (terminalJs[i] === '{') depth += 1;
    else if (terminalJs[i] === '}') {
      depth -= 1;
      if (depth === 0) return terminalJs.slice(start, i + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function loadPrimaryState() {
  const context = {
    _fleetWorkerOnline: (s) => !!(s && s.worker && s.worker.online),
    _fleetOpenPositionCount: (s) => Array.isArray(s && s.openPositions) ? s.openPositions.length : 0,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunctionSource('_fleetPrimaryState')}; this.fn = _fleetPrimaryState;`, context);
  return context.fn;
}

test('frontend paused worker renders ENTRIES PAUSED, not BOT RUNNING', () => {
  const primary = loadPrimaryState();
  const state = primary({
    status: 'running',
    pauseRequested: true,
    worker: { online: true, currentState: 'paused' },
    openPositions: [],
    positionResults: [],
  });
  assert.match(state.text, /ENTRIES PAUSED/);
  assert.doesNotMatch(state.text, /BOT RUNNING/);
});

test('frontend exposes admin clear global kill switch UX', () => {
  assert.match(terminalJs, /\/api\/bot\/global-kill-switch\/clear/);
  assert.match(terminalJs, /CLEAR GLOBAL KILL SWITCH/);
  assert.match(terminalJs, /fleet-clear-gks-btn/);
});

test('frontend smoke order is gated with exact paused and kill-switch reasons', () => {
  assert.match(terminalJs, /smokeBlockedReason/);
  assert.match(terminalJs, /Smoke order hidden: global kill switch is active\./);
  assert.match(terminalJs, /Smoke order hidden: entries are paused for this session\./);
});
