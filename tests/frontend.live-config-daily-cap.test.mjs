import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const terminalJs = fs.readFileSync(new URL('../apps/edge/public/js/terminal.js', import.meta.url), 'utf8');
const RAISE_PHRASE = "I UNDERSTAND THIS RAISES TODAY'S LIVE TRADE LIMIT";

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

function createFakeDocument() {
  const byId = new Map();
  const body = {
    children: [],
    appendChild(el) {
      el.parentNode = this;
      this.children.push(el);
      if (el.id) byId.set(el.id, el);
      return el;
    },
  };
  function makeEl(id = '') {
    return {
      id,
      value: '',
      checked: false,
      textContent: '',
      innerHTML: '',
      style: {},
      className: '',
      listeners: {},
      addEventListener(name, fn) { this.listeners[name] = fn; },
      closest() { return null; },
      focus() {},
      setSelectionRange() {},
      remove() {
        if (this.id) byId.delete(this.id);
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
        this.parentNode = null;
      },
    };
  }
  return {
    body,
    activeElement: null,
    createElement() { return makeEl(); },
    getElementById(id) { return byId.get(id) || null; },
    add(el) { byId.set(el.id, el); return el; },
    makeEl,
  };
}

function loadHarness(fetchImpl) {
  const document = createFakeDocument();
  const calls = [];
  const toasts = [];
  const defaults = { minTradeUsd: 5, maxTradeUsd: 10, maxDailyLossUsd: 3, maxDailyTrades: 5, maxOpenPositions: 1, stopLossPct: 3, takeProfitPct: 15, pauseOnMarketCrash: true, allowTestnet: true, allowLive: false };
  const fields = [
    { name: 'minTradeUsd' },
    { name: 'maxTradeUsd' },
    { name: 'maxDailyLossUsd' },
    { name: 'maxDailyTrades' },
    { name: 'maxOpenPositions' },
    { name: 'stopLossPct' },
    { name: 'takeProfitPct' },
  ];
  for (const f of fields) {
    const el = document.makeEl(`cfg-${f.name}`);
    el.value = String(defaults[f.name]);
    document.add(el);
  }
  const crash = document.makeEl('cfg-pauseOnMarketCrash');
  crash.checked = true;
  document.add(crash);
  document.add(document.makeEl('fleet-cfg-error'));
  document.add(document.makeEl('fleet-cfg-status'));
  const context = {
    document,
    calls,
    FLEET_CONFIG_DEFAULTS: defaults,
    FLEET_CONFIG_FIELDS: fields,
    LIVE_DAILY_TRADES_RAISE_PHRASE: RAISE_PHRASE,
    Fleet: {
      botConfirm: null,
      data: { config: { ...defaults, maxDailyTrades: 2, allowLive: true } },
    },
    window: {
      __botFleetConfigDraft: { ...defaults, allowLive: true },
      __botFleetConfigDirty: false,
      Toast: {
        success: (...args) => toasts.push(['success', ...args]),
        error: (...args) => toasts.push(['error', ...args]),
      },
    },
    console,
    Promise,
    setImmediate,
    _esc: (value) => String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    refreshFleet: () => {},
    _fleetFetch: (method, path, body) => {
      calls.push({ method, path, body });
      return fetchImpl ? fetchImpl(method, path, body) : Promise.resolve({ ok: true, config: body });
    },
  };
  vm.createContext(context);
  const sources = [
    '_botConfirmList',
    '_renderBotConfirmModal',
    'openBotConfirmModal',
    'toggleBotConfirmAck',
    'updateBotConfirmPhrase',
    'closeBotConfirmModal',
    'confirmBotConfirmModal',
    '_fleetNum',
    '_fleetCompleteConfig',
    '_fleetSetConfigStatus',
    '_fleetReadConfigFromForm',
    '_fleetApplyConfigToForm',
    '_postBotConfig',
    'saveBotConfig',
  ].map(extractFunctionSource).join('\n');
  vm.runInContext(sources, context);
  return { context, document, calls, toasts };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('raising max daily live trades above 3 requires the exact frontend phrase', async () => {
  const { context, document, calls } = loadHarness();
  document.getElementById('cfg-maxDailyTrades').value = '5';
  context.saveBotConfig();
  assert.equal(calls.length, 0, 'raise opens confirmation modal before POST');
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal);
  assert.match(modal.innerHTML, /Raise Daily Live Trade Cap/);
  assert.match(modal.innerHTML, /I UNDERSTAND THIS RAISES TODAY&#39;S LIVE TRADE LIMIT|I UNDERSTAND THIS RAISES TODAY'S LIVE TRADE LIMIT/);

  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 0, 'wrong/missing phrase still blocks submit');

  context.updateBotConfirmPhrase(RAISE_PHRASE);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/bot/config');
  assert.equal(calls[0].body.maxDailyTrades, 5);
  assert.equal(calls[0].body.allowLive, true, 'config save preserves live consent');
  assert.equal(calls[0].body.confirmLiveDailyTradesPhrase, RAISE_PHRASE);
});

test('saving a non-raise daily cap posts directly without the raise phrase', async () => {
  const { context, document, calls } = loadHarness();
  context.Fleet.data.config.maxDailyTrades = 5;
  document.getElementById('cfg-maxDailyTrades').value = '4';
  context.saveBotConfig();
  await flush();
  assert.equal(document.getElementById('bot-confirm-modal'), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.maxDailyTrades, 4);
  assert.equal(calls[0].body.confirmLiveDailyTradesPhrase, undefined);
  assert.equal(calls[0].body.allowLive, true);
});

test('source includes daily trade cap raise phrase and backend config payload field', () => {
  assert.match(terminalJs, /LIVE_DAILY_TRADES_RAISE_PHRASE/);
  assert.match(terminalJs, /confirmLiveDailyTradesPhrase/);
  assert.match(terminalJs, /live_caps_config/);
});
