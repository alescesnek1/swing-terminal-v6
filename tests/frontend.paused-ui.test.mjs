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
    _fleetSessionIsLive: (s) => !!s && s.mode === 'live_spot',
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunctionSource('_fleetPrimaryState')}; this.fn = _fleetPrimaryState;`, context);
  return context.fn;
}

function createFakeDocument() {
  const body = {
    children: [],
    appendChild(el) {
      el.parentNode = this;
      this.children.push(el);
      return el;
    },
  };
  return {
    body,
    createElement() {
      return {
        id: '',
        className: '',
        innerHTML: '',
        listeners: {},
        addEventListener(name, fn) { this.listeners[name] = fn; },
        remove() {
          if (!this.parentNode) return;
          this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
          this.parentNode = null;
        },
      };
    },
    getElementById(id) {
      return body.children.find((el) => el.id === id) || null;
    },
  };
}

function loadBotConfirmHarness(extraFunctions = []) {
  const document = createFakeDocument();
  const calls = [];
  const toasts = [];
  const context = {
    document,
    calls,
    Fleet: { botConfirm: null, data: null, selectedId: 'sess-1' },
    window: {
      Toast: {
        success: (...args) => toasts.push(['success', ...args]),
        error: (...args) => toasts.push(['error', ...args]),
      },
    },
    _esc: (value) => String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    refreshFleet: () => {},
    renderFleet: () => {},
    _fleetSessionFromData: (id) => {
      const sessions = (context.Fleet.data && context.Fleet.data.sessions) || [];
      return sessions.find((s) => s.sessionId === id) || null;
    },
    _fleetFetch: (method, path, body) => {
      calls.push({ method, path, body });
      return Promise.resolve({ ok: true });
    },
  };
  vm.createContext(context);
  const sources = [
    '_botConfirmList',
    '_renderBotConfirmModal',
    'openBotConfirmModal',
    'closeBotConfirmModal',
    'confirmBotConfirmModal',
    ...extraFunctions,
  ].map(extractFunctionSource).join('\n');
  vm.runInContext(sources, context);
  return { context, document, calls, toasts };
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

test('frontend exposes admin clear global kill switch modal UX', async () => {
  const { context, document, calls } = loadBotConfirmHarness(['clearGlobalKillSwitch']);
  assert.match(terminalJs, /\/api\/bot\/global-kill-switch\/clear/);
  assert.match(terminalJs, /CLEAR GLOBAL KILL SWITCH/);
  assert.match(terminalJs, /openBotConfirmModal\(\{/);
  assert.match(terminalJs, /fleet-clear-gks-btn/);

  context.clearGlobalKillSwitch();
  let modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'clear opens modal');
  assert.match(modal.innerHTML, /Clear Global Kill Switch\?/);
  assert.equal(calls.length, 0, 'open does not call API');

  context.closeBotConfirmModal();
  assert.equal(document.getElementById('bot-confirm-modal'), null, 'cancel closes modal');
  assert.equal(calls.length, 0, 'cancel does not call API');

  context.clearGlobalKillSwitch();
  await context.confirmBotConfirmModal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'continue calls clear endpoint once');
  assert.equal(calls[0].path, '/api/bot/global-kill-switch/clear');
  assert.equal(calls[0].body.confirmation, 'CLEAR GLOBAL KILL SWITCH');
});

test('frontend smoke order is gated with exact paused and kill-switch reasons', () => {
  assert.match(terminalJs, /smokeBlockedReason/);
  assert.match(terminalJs, /Smoke order hidden: global kill switch is active\./);
  assert.match(terminalJs, /Smoke order hidden: entries are paused for this session\./);
});

test('frontend bot confirmation modal survives fleet rerenders while open', () => {
  const { context, document } = loadBotConfirmHarness();
  context.openBotConfirmModal({
    title: 'Persistent modal',
    effects: ['One'],
    confirmLabel: 'Continue',
    onConfirm: () => Promise.resolve(),
  });
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal);
  context.Fleet.data = { sessions: [{ sessionId: 'after-poll' }] };
  context.renderFleet();
  assert.equal(document.getElementById('bot-confirm-modal'), modal);
  assert.match(modal.innerHTML, /Persistent modal/);
});

test('frontend activate and emergency stop use confirmation modal gates', async () => {
  const { context, document, calls } = loadBotConfirmHarness(['activateGlobalKillSwitch', 'emergencyStopAllLiveSpot']);

  context.activateGlobalKillSwitch();
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /Activate Global Kill Switch\?/);
  assert.equal(calls.length, 0);
  await context.confirmBotConfirmModal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/bot/global-kill-switch/activate');

  context.emergencyStopAllLiveSpot();
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /Emergency Stop All Live Spot\?/);
  assert.equal(calls.length, 1, 'emergency stop waits for Continue');
});

test('frontend resume entries blocks under global kill switch and otherwise uses modal', async () => {
  const { context, document, calls, toasts } = loadBotConfirmHarness(['_fleetSessionAction', 'resumeBotEntries']);

  context.Fleet.data = { globalKillSwitchActive: true, sessions: [{ sessionId: 'sess-1', pauseRequested: true }] };
  context.resumeBotEntries();
  assert.equal(document.getElementById('bot-confirm-modal'), null);
  assert.equal(calls.length, 0);
  assert.match(toasts.at(-1).join(' '), /Cannot resume entries while global kill switch is active/);

  context.Fleet.data = { globalKillSwitchActive: false, sessions: [{ sessionId: 'sess-1', pauseRequested: true }] };
  context.resumeBotEntries();
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /Resume Entries\?/);
  assert.equal(calls.length, 0);
  await context.confirmBotConfirmModal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/bot/session/sess-1/resume');
});

test('frontend bot confirmation modal disables double-submit and shows API errors', async () => {
  const { context, document, calls } = loadBotConfirmHarness();
  let rejectRequest;
  context.openBotConfirmModal({
    title: 'Error modal',
    effects: ['One'],
    confirmLabel: 'Continue',
    onConfirm: () => {
      calls.push({ path: '/fail' });
      return new Promise((resolve, reject) => { rejectRequest = reject; });
    },
  });
  context.confirmBotConfirmModal();
  context.confirmBotConfirmModal();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, 'busy modal ignores a second Continue click');
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /disabled/);
  rejectRequest(new Error('backend rejected'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /backend rejected/);
});

test('frontend kill-switch controls render for the right active state', () => {
  assert.match(terminalJs, /globalKillActive[\s\S]*fleet-clear-gks-btn/);
  assert.match(terminalJs, /Entries are blocked because global kill switch is active\./);
  assert.doesNotMatch(terminalJs, /fleet-clear-gks-input/);
  assert.doesNotMatch(terminalJs, /Type: CLEAR GLOBAL KILL SWITCH/);
  assert.doesNotMatch(terminalJs, /Type: ACTIVATE GLOBAL KILL SWITCH/);
  // Live activation moved to the persistent modal too — no typed phrase field.
  assert.doesNotMatch(terminalJs, /Type: I UNDERSTAND THIS USES REAL MONEY/);
  assert.doesNotMatch(terminalJs, /fleet-live-confirm-input/);
});

test('terminal.js must not contain deprecated _e( references', () => {
  // Static scan for `_e(` to prevent regression.
  const hasDeprecatedHelper = /\b_e\s*\(/.test(terminalJs);
  assert.equal(hasDeprecatedHelper, false, 'Use _esc() instead of _e()');
});
