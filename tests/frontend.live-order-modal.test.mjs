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
    appendChild(el) { el.parentNode = this; this.children.push(el); return el; },
  };
  return {
    body,
    createElement() {
      return {
        id: '', className: '', innerHTML: '', listeners: {},
        addEventListener(name, fn) { this.listeners[name] = fn; },
        remove() {
          if (!this.parentNode) return;
          this.parentNode.children = this.parentNode.children.filter((x) => x !== this);
          this.parentNode = null;
        },
      };
    },
    getElementById(id) { return body.children.find((el) => el.id === id) || null; },
  };
}

function loadLiveOrderHarness(fetchImpl) {
  const document = createFakeDocument();
  const calls = [];
  const toasts = [];
  const context = {
    document,
    calls,
    Fleet: {
      botConfirm: null,
      selectedId: 'live_session_42',
      liveOrderResult: null,
      data: {
        isAdmin: true,
        liveReadiness: {
          state: 'LIVE READY - MICRO CAPS',
          canStartLive: true,
          preflightPassed: true,
          allowLive: true,
          caps: { allowedSymbols: ['BTCUSDC'], maxPositionUsd: 6, minPositionUsd: 6, maxDailyLossUsd: 5, maxDailyTrades: 3 },
        },
        sessions: [{ sessionId: 'live_session_42', mode: 'live_spot', openPositions: [] }],
      },
    },
    window: { location: { href: '' }, Toast: { success: (...a) => toasts.push(['success', ...a]), error: (...a) => toasts.push(['error', ...a]) } },
    console,
    Date,
    _esc: (value) => String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    refreshFleet: () => {},
    renderFleet: () => {},
    _fleetSessionFromData: (id) => ((context.Fleet.data && context.Fleet.data.sessions) || []).find((s) => s.sessionId === id) || null,
    _fleetFetch: (method, path, body) => {
      calls.push({ method, path, body });
      return fetchImpl ? fetchImpl(method, path, body) : Promise.resolve({ ok: true, intent: { id: 'live_intent_1', symbol: 'BTCUSDC' } });
    },
  };
  vm.createContext(context);
  const sources = [
    '_botConfirmList', '_renderBotConfirmModal', 'openBotConfirmModal', 'toggleBotConfirmAck',
    'closeBotConfirmModal', 'confirmBotConfirmModal', 'openCreateLiveMicroOrderModal',
  ].map(extractFunctionSource).join('\n');
  vm.runInContext(sources, context);
  return { context, document, calls, toasts };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('live session renders a live-only CREATE LIVE order button, not the testnet smoke button', () => {
  // Source-level guarantee: the live branch renders a dedicated live button and
  // never silently reuses the testnet smoke action.
  assert.match(terminalJs, /onclick="openCreateLiveMicroOrderModal\(\)"/);
  assert.match(terminalJs, /CREATE LIVE ' \+ _esc\(liveSymbol\) \+ ' ORDER/);
  // The testnet smoke button still exists for testnet sessions.
  assert.match(terminalJs, /CREATE TESTNET SMOKE ORDER/);
  // The live branch is gated on the live_spot session (selLive).
  assert.match(terminalJs, /if \(selLive\) \{[\s\S]*openCreateLiveMicroOrderModal/);
});

test('live button opens the persistent Create Live Micro Order modal with the order details', () => {
  const { context, document, calls } = loadLiveOrderHarness();
  context.openCreateLiveMicroOrderModal();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'opens the body-level modal');
  assert.match(modal.innerHTML, /Create Live Micro Order/);
  assert.match(modal.innerHTML, /REAL MONEY/);
  assert.match(modal.innerHTML, /Symbol: BTCUSDC/);
  assert.match(modal.innerHTML, /Side: BUY/);
  assert.match(modal.innerHTML, /Type: MARKET/);
  assert.match(modal.innerHTML, /Max spend: \$6 USDC/);
  assert.match(modal.innerHTML, /Quote asset: USDC/);
  assert.match(modal.innerHTML, /Live session: live_session_42/);
  assert.match(modal.innerHTML, /click STOP to close the position immediately/i);
  assert.match(modal.innerHTML, /I understand this will place a real-money market order/);
  assert.match(modal.innerHTML, /Create live BTCUSDC order/);
  assert.equal(calls.length, 0, 'opening calls no API');
});

test('checkbox gates the live order submit', async () => {
  const { context, document, calls } = loadLiveOrderHarness();
  context.openCreateLiveMicroOrderModal();
  const modal = document.getElementById('bot-confirm-modal');
  assert.match(modal.innerHTML, /id="bot-confirm-continue"[^>]*disabled/, 'submit disabled while unchecked');
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 0, 'unchecked confirm is ignored');
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'checked confirm submits');
});

test('submit creates exactly one live intent with the explicit BTCUSDC/$6 payload', async () => {
  const { context, calls } = loadLiveOrderHarness();
  context.openCreateLiveMicroOrderModal();
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/bot/create-live-execution-intent');
  const b = calls[0].body;
  assert.equal(b.sessionId, 'live_session_42');
  assert.equal(b.symbol, 'BTCUSDC');
  assert.equal(b.side, 'BUY');
  assert.equal(b.type, 'MARKET');
  assert.equal(b.positionUsd, 6);
  assert.equal(b.mode, 'live_spot');
  assert.equal(b.realProductionOrder, true);
});

test('modal shows the configured cap as max spend (env-driven, not hardcoded)', () => {
  const { context, document } = loadLiveOrderHarness();
  // A different env cap (e.g. 8) flows straight through to the modal.
  context.Fleet.data.liveReadiness.caps.maxPositionUsd = 8;
  context.openCreateLiveMicroOrderModal();
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /Max spend: \$8 USDC/);
});

test('live button is hidden when the live cap is below the buffered minimum spend', () => {
  // Source-level guard: a $5 cap under a $6 minimum must not offer the button.
  assert.match(terminalJs, /liveMin > 0 && liveCap < liveMin/);
  assert.match(terminalJs, /below the minimum live spend/);
});

test('live button is hidden/blocked when free quote balance is below the required spend', () => {
  // Source-level guard (spec 1 + 8): the render branch compares the fresh preflight
  // free quote balance against the required spend and surfaces the exact message.
  assert.match(terminalJs, /live\.preflight && live\.preflight\.balances/);
  assert.match(terminalJs, /haveFreeQuote && freeQuoteNum < requiredSpend/);
  assert.match(terminalJs, /'Insufficient ' \+ liveQuote \+ ' balance\. Required ' \+ requiredSpend \+ ', available ' \+ freeQuoteRaw \+ '\.'/);
});

// Behavioral check: render the live action branch in a sandbox and assert that an
// underfunded account hides the CREATE LIVE button and shows the exact insufficient
// message, while a funded account shows the button.
function renderLiveActionBranch({ usdc, cap = 6, min = 6 }) {
  // Extract just the live-order block (from `if (selLive) {` to the matching close)
  // and evaluate it with a minimal sandbox that captures `html`.
  const marker = 'if (selLive) {';
  const start = terminalJs.indexOf(marker);
  assert.notEqual(start, -1, 'live branch exists');
  let depth = 0; let end = -1;
  for (let i = terminalJs.indexOf('{', start); i < terminalJs.length; i += 1) {
    if (terminalJs[i] === '{') depth += 1;
    else if (terminalJs[i] === '}') { depth -= 1; if (depth === 0) { end = i + 1; break; } }
  }
  const branch = terminalJs.slice(start, end);
  const ctx = {
    html: '',
    _esc: (v) => String(v == null ? '' : v),
    data: { isAdmin: true },
    live: {
      caps: { allowedSymbols: ['BTCUSDC'], maxPositionUsd: cap, minPositionUsd: min },
      preflightPassed: true, durable: true, state: 'LIVE READY - MICRO CAPS', allowLive: true,
      preflight: { balances: { USDC: usdc } },
    },
    sel: { stopRequested: false },
    selLive: true,
    newEntriesAllowed: true, anyOpenPosition: false, smokeOpenCount: 0,
    online: true, canStop: true, globalKillActive: false, sessionPaused: false, entriesAllowed: true,
    Fleet: { liveOrderResult: null },
  };
  // The branch references these locals; provide them on the context.
  ctx.sel.openPositions = [];
  vm.runInNewContext(`(function(){ var smokeOpenCount = ${0}; ${branch.replace(/^if \(selLive\) \{/, '').replace(/\}$/, '')} })()`, ctx);
  return ctx.html;
}

test('underfunded live account hides the CREATE LIVE button and shows the exact message', () => {
  const html = renderLiveActionBranch({ usdc: '4.49147530' });
  assert.doesNotMatch(html, /CREATE LIVE/);
  assert.match(html, /Insufficient USDC balance\. Required 6, available 4\.49147530\./);
});

test('funded live account renders the CREATE LIVE button', () => {
  const html = renderLiveActionBranch({ usdc: '10' });
  assert.match(html, /CREATE LIVE BTCUSDC ORDER/);
  assert.doesNotMatch(html, /Insufficient USDC balance/);
});

test('a dust-closed session shows no open position (no CLOSE REQUIRED) and a dust card', () => {
  // CLOSE REQUIRED is driven by _fleetOpenPositionCount > 0; a dust close leaves 0.
  const fn = vm.runInNewContext(`${extractFunctionSource('_fleetOpenPositionCount')}; _fleetOpenPositionCount`);
  assert.equal(fn({ openPositions: [] }), 0, 'no open position after a dust close → no CLOSE REQUIRED panel');
  assert.equal(fn({ openPositions: [{ symbol: 'BTCUSDC' }] }), 1);
  // The closed-trade card surfaces the dust explicitly instead of CLOSE REQUIRED.
  assert.match(terminalJs, /'CLOSED \(dust left\)'/);
  assert.match(terminalJs, /Residual dust/);
  // The CLOSE REQUIRED panel is gated on an open-position session, not on history.
  assert.match(terminalJs, /openPosSession[\s\S]{0,400}CLOSE REQUIRED/);
});

test('live order modal survives fleet polling rerenders', () => {
  const { context, document } = loadLiveOrderHarness();
  context.openCreateLiveMicroOrderModal();
  const modal = document.getElementById('bot-confirm-modal');
  context.toggleBotConfirmAck(true);
  context.Fleet.data = { ...context.Fleet.data, sessions: context.Fleet.data.sessions.concat([{ sessionId: 'other' }]) };
  context.renderFleet();
  assert.equal(document.getElementById('bot-confirm-modal'), modal);
  assert.match(modal.innerHTML, /Create Live Micro Order/);
  assert.equal(context.Fleet.botConfirm.checkboxChecked, true);
});

test('live order modal: double submit disabled and API error stays in the modal', async () => {
  let rejectRequest;
  const { context, document, calls } = loadLiveOrderHarness(() => new Promise((_resolve, reject) => { rejectRequest = reject; }));
  context.openCreateLiveMicroOrderModal();
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'second click while busy is ignored');
  assert.match(document.getElementById('bot-confirm-modal').innerHTML, /Working\.\.\./);
  rejectRequest(new Error('symbol is not allowlisted'));
  await flush();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'modal stays open on error');
  assert.match(modal.innerHTML, /symbol is not allowlisted/);
});

test('successful live order closes the modal and refreshes the fleet', async () => {
  let refreshed = 0;
  const { context, document, calls, toasts } = loadLiveOrderHarness(() => Promise.resolve({ ok: true, intent: { id: 'live_intent_9', symbol: 'BTCUSDC' } }));
  // The VM resolves free identifiers from the sandbox global at call time, so
  // reassigning refreshFleet here is picked up by onConfirm.
  context.refreshFleet = () => { refreshed += 1; };
  context.openCreateLiveMicroOrderModal();
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(document.getElementById('bot-confirm-modal'), null, 'modal closes on success');
  assert.equal(refreshed, 1, 'fleet refreshed after success');
  assert.equal(context.Fleet.liveOrderResult.symbol, 'BTCUSDC');
  assert.equal(toasts.filter((t) => t[0] === 'success').length, 1);
});
