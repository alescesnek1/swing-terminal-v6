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

function loadLiveStartHarness(fetchImpl) {
  const document = createFakeDocument();
  const calls = [];
  const toasts = [];
  const context = {
    document,
    calls,
    Fleet: {
      botConfirm: null,
      selectedId: null,
      retryLaunchUrl: null,
      data: {
        liveReadiness: {
          state: 'LIVE READY - MICRO CAPS',
          canStartLive: true,
          preflightFresh: true,
          preflightPassed: true,
          allowLive: true,
          requiresConsent: false,
          preflight: { ok: true, checkedAt: '2026-06-10T08:00:00.000Z' },
          caps: { allowedSymbols: ['BTCUSDC'], maxPositionUsd: 5, maxDailyLossUsd: 5, maxDailyTrades: 3 },
        },
        sessions: [],
      },
    },
    window: {
      location: { href: '' },
      Toast: {
        success: (...args) => toasts.push(['success', ...args]),
        error: (...args) => toasts.push(['error', ...args]),
      },
    },
    console,
    Date,
    _esc: (value) => String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;'),
    refreshFleet: () => {},
    renderFleet: () => {},
    _fleetFetch: (method, path, body) => {
      calls.push({ method, path, body });
      return fetchImpl ? fetchImpl(method, path, body) : Promise.resolve({ ok: true });
    },
  };
  vm.createContext(context);
  const sources = [
    '_botConfirmList',
    '_renderBotConfirmModal',
    'openBotConfirmModal',
    'toggleBotConfirmAck',
    'closeBotConfirmModal',
    'confirmBotConfirmModal',
    'openStartLiveSpotModal',
  ].map(extractFunctionSource).join('\n');
  vm.runInContext(sources, context);
  return { context, document, calls, toasts };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('live start uses persistent modal, not inline typed phrase input', () => {
  // No inline phrase input may exist anywhere in the fleet UI for live start.
  assert.doesNotMatch(terminalJs, /fleet-live-confirm-input/);
  assert.doesNotMatch(terminalJs, /Type: I UNDERSTAND THIS USES REAL MONEY/);
  assert.match(terminalJs, /onclick="openStartLiveSpotModal\(\)"/);

  const { context, document, calls } = loadLiveStartHarness();
  context.openStartLiveSpotModal();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'START LIVE SPOT opens the body-level modal');
  assert.match(modal.innerHTML, /Start Live Spot Trading/);
  assert.match(modal.innerHTML, /REAL MONEY/);
  assert.match(modal.innerHTML, /BTCUSDC/);
  assert.match(modal.innerHTML, /Max trade: \$5/);
  assert.match(modal.innerHTML, /Max daily loss: \$5/);
  assert.match(modal.innerHTML, /Max daily trades: 3/);
  assert.match(modal.innerHTML, /Live preflight: PASSED/);
  assert.match(modal.innerHTML, /I understand this uses real money/);
  assert.match(modal.innerHTML, /Start live spot/);
  assert.equal(calls.length, 0, 'opening the modal calls no API');
});

test('live start modal survives fleet polling rerenders', () => {
  const { context, document } = loadLiveStartHarness();
  context.openStartLiveSpotModal();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal);
  context.toggleBotConfirmAck(true);
  // Simulate fleet polling: data is replaced and the panel rerendered.
  context.Fleet.data = { ...context.Fleet.data, sessions: [{ sessionId: 'after-poll' }] };
  context.renderFleet();
  assert.equal(document.getElementById('bot-confirm-modal'), modal, 'same modal element after rerender');
  assert.match(modal.innerHTML, /Start Live Spot Trading/);
  assert.equal(context.Fleet.botConfirm.checkboxChecked, true, 'checkbox state survives rerender');
});

test('checkbox gates the Start live spot submit', async () => {
  const { context, document, calls } = loadLiveStartHarness();
  context.openStartLiveSpotModal();
  const modal = document.getElementById('bot-confirm-modal');
  assert.match(modal.innerHTML, /id="bot-confirm-continue"[^>]*disabled/, 'submit disabled while unchecked');

  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 0, 'unchecked confirm is ignored');

  context.toggleBotConfirmAck(true);
  assert.doesNotMatch(modal.innerHTML, /id="bot-confirm-continue"[^>]*disabled/, 'submit enabled once checked');
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'checked confirm submits');
  assert.equal(calls[0].path, '/api/bot/start-live-session');
});

test('double submit is disabled while the request is in flight', async () => {
  let resolveRequest;
  const { context, document, calls } = loadLiveStartHarness(() => new Promise((resolve) => { resolveRequest = resolve; }));
  context.openStartLiveSpotModal();
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'second click while busy is ignored');
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /Working\.\.\./);
  resolveRequest({ ok: true });
  await flush();
  assert.equal(calls.length, 1);
});

test('API error keeps the modal open and displays the error', async () => {
  let rejectRequest;
  const { context, document, calls } = loadLiveStartHarness(() => new Promise((resolve, reject) => { rejectRequest = reject; }));
  context.openStartLiveSpotModal();
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  rejectRequest(new Error('LIVE PREFLIGHT REQUIRED'));
  await flush();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'modal stays open on API error');
  assert.match(modal.innerHTML, /LIVE PREFLIGHT REQUIRED/);
  assert.equal(calls.length, 1);
  // Operator can retry after the error.
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 2, 'retry after error is possible');
});

test('successful live start calls existing start endpoint once and closes the modal', async () => {
  const { context, document, calls, toasts } = loadLiveStartHarness(() => Promise.resolve({
    ok: true,
    session: { sessionId: 'live_session_1' },
    launchUrl: 'swingworker://start?session=live_session_1',
  }));
  context.openStartLiveSpotModal();
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'start endpoint called exactly once');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/bot/start-live-session');
  // Backend live gates unchanged: the exact confirmation contract is still sent.
  assert.equal(calls[0].body.liveModeConfirmed, true);
  assert.equal(calls[0].body.confirmationPhrase, 'I UNDERSTAND THIS USES REAL MONEY');
  assert.equal(document.getElementById('bot-confirm-modal'), null, 'modal closes on success');
  assert.equal(context.Fleet.selectedId, 'live_session_1');
  assert.equal(context.window.location.href, 'swingworker://start?session=live_session_1', 'live start flow continues (worker launch)');
  assert.equal(toasts.filter((t) => t[0] === 'success').length, 1);
});

test('allowLive=false + preflight passed opens the unlock modal (enable live trading)', () => {
  const { context, document, calls } = loadLiveStartHarness();
  // Readiness is met (preflight passed) but the user has not consented yet.
  context.Fleet.data.liveReadiness.allowLive = false;
  context.Fleet.data.liveReadiness.requiresConsent = true;
  context.Fleet.data.config = { allowLive: false };
  context.openStartLiveSpotModal();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'START LIVE SPOT opens the modal even when allowLive=false');
  assert.match(modal.innerHTML, /will enable live trading/, 'summary explains the unlock');
  assert.match(modal.innerHTML, /will be enabled on confirm/, 'info line shows live trading is locked');
  assert.match(modal.innerHTML, /Enable live trading &amp; start/, 'confirm label reflects the unlock');
  assert.match(modal.innerHTML, /I understand this uses real money/);
  // Still checkbox-gated.
  assert.match(modal.innerHTML, /id="bot-confirm-continue"[^>]*disabled/);
  assert.equal(calls.length, 0);
});

test('unlock modal: checkbox gates confirm and confirm sends exact backend phrase', async () => {
  const { context, document, calls } = loadLiveStartHarness();
  context.Fleet.data.liveReadiness.allowLive = false;
  context.Fleet.data.liveReadiness.requiresConsent = true;
  context.openStartLiveSpotModal();
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 0, 'unchecked confirm is ignored in the unlock flow');
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'checked confirm submits the unlock+start');
  assert.equal(calls[0].path, '/api/bot/start-live-session');
  assert.equal(calls[0].body.liveModeConfirmed, true);
  assert.equal(calls[0].body.confirmationPhrase, 'I UNDERSTAND THIS USES REAL MONEY');
});

test('live start button exposes a locked reason instead of a dead disabled button', () => {
  // Source-level guarantees for the locked-reason UX (requirement #6/#8).
  assert.match(terminalJs, /liveLockedReason/);
  assert.match(terminalJs, /Live locked: confirmation required/);
  assert.match(terminalJs, /fleet-live-readiness__locked/);
  // The button enable state is driven by readiness (canStartLive), never by allowLive.
  assert.match(terminalJs, /onclick="openStartLiveSpotModal\(\)"' \+ \(live\.canStartLive \? '' : ' disabled'\)/);
});

test('live_spot stop and close labels never say testnet', () => {
  assert.match(terminalJs, /_fleetModeLabel/);
  assert.match(terminalJs, /LIVE SPOT - REAL MONEY/);
  // Mode label and emergency-close wording are derived from session.mode.
  assert.doesNotMatch(terminalJs, /<b>TESTNET<\/b>/);
  assert.doesNotMatch(terminalJs, /Emergency close ALL open testnet positions/);
  assert.doesNotMatch(terminalJs, /CLOSE ' \+ _esc\(sym\) \+ ' TESTNET POSITION/);
});
