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

function loadCloseHarness(session, fetchImpl) {
  const document = createFakeDocument();
  const calls = [];
  const toasts = [];
  const context = {
    document,
    calls,
    Fleet: {
      botConfirm: null,
      selectedId: session.sessionId,
      openPositionSessionId: _fleetOpenCount(session) > 0 ? session.sessionId : null,
      retryLaunchUrl: null,
      emergency: null,
      data: { sessions: [session] },
    },
    window: {
      location: { href: '', origin: 'https://swing-terminal-v6.netlify.app' },
      confirm: () => true,
      Toast: { success: (...a) => toasts.push(['success', ...a]), error: (...a) => toasts.push(['error', ...a]) },
    },
    location: { origin: 'https://swing-terminal-v6.netlify.app' },
    console,
    Date,
    _esc: (value) => String(value == null ? '' : value)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    refreshFleet: () => {},
    renderFleet: () => {},
    _fleetFetch: (method, path, body) => {
      calls.push({ method, path, body });
      return fetchImpl ? fetchImpl(method, path, body) : Promise.resolve({ ok: true, commandType: 'STOP' });
    },
  };
  vm.createContext(context);
  const sources = [
    '_botConfirmList', '_renderBotConfirmModal', 'openBotConfirmModal', 'toggleBotConfirmAck',
    'closeBotConfirmModal', 'confirmBotConfirmModal', '_fleetSessionFromData', '_fleetSessionIsLive',
    '_fleetModeLabel', '_fleetOpenPositionCount', '_fleetWorkerOnline', '_fleetLaunchUrl',
    '_fleetSessionAction', '_doStopAndCloseSession', 'confirmCloseLivePosition', 'stopAndCloseSession',
    'stopBotSession',
  ].map(extractFunctionSource).join('\n');
  vm.runInContext(sources, context);
  return { context, document, calls, toasts };
}

function _fleetOpenCount(s) { return Array.isArray(s && s.openPositions) ? s.openPositions.length : 0; }

const liveOpenSession = () => ({
  sessionId: 'live_session_42',
  mode: 'live_spot',
  worker: { online: true },
  openPositions: [{ symbol: 'BTCUSDC', executedQty: '0.00012', orderId: 778899 }],
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

// â”€â”€ Spec 4: live close confirmation modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
test('confirmCloseLivePosition opens a real-money MARKET SELL confirmation modal', () => {
  const { context, document, calls } = loadCloseHarness(liveOpenSession());
  context.confirmCloseLivePosition('live_session_42');
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'opens the body-level modal');
  assert.match(modal.innerHTML, /Close BTCUSDC Live Position/);
  assert.match(modal.innerHTML, /REAL MONEY/);
  assert.match(modal.innerHTML, /MARKET SELL/);
  assert.match(modal.innerHTML, /Symbol: BTCUSDC/);
  assert.match(modal.innerHTML, /Side: SELL/);
  assert.match(modal.innerHTML, /Type: MARKET/);
  assert.match(modal.innerHTML, /Qty: 0\.00012/);
  assert.match(modal.innerHTML, /Entry order: 778899/);
  assert.match(modal.innerHTML, /Live session: live_session_42/);
  assert.match(modal.innerHTML, /I understand this closes my live position with a real-money market sell/);
  assert.match(modal.innerHTML, /Close BTCUSDC live position/);
  assert.equal(calls.length, 0, 'opening the modal calls no API');
});

// â”€â”€ Spec 4 + 6: checkbox gates the close; clicking close sends the close command â”€â”€
test('checkbox gates the live close and confirm sends exactly one /stop close command', async () => {
  const { context, document, calls } = loadCloseHarness(liveOpenSession());
  context.confirmCloseLivePosition('live_session_42');
  const modal = document.getElementById('bot-confirm-modal');
  assert.match(modal.innerHTML, /id="bot-confirm-continue"[^>]*disabled/, 'submit disabled while unchecked');
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 0, 'unchecked confirm is ignored');
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'checked confirm submits the close once');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/api/bot/session/live_session_42/stop');
  assert.equal(document.getElementById('bot-confirm-modal'), null, 'modal closes after the close is queued');
});

// â”€â”€ Spec 5: STOP BOT and the CLOSE button converge on the SAME close command â”€â”€
test('STOP BOT on an open-position session delegates to the same /stop close command', () => {
  const { context, document, calls } = loadCloseHarness(liveOpenSession());
  // STOP BOT must NOT take a separate stop path while a position is open â€” it opens
  // the same live close confirmation modal the CLOSE button uses (no API yet).
  context.stopBotSession();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'STOP BOT delegates to the live close modal');
  assert.match(modal.innerHTML, /Close BTCUSDC Live Position/);
  assert.equal(calls.length, 0, 'no command fires until the operator confirms');
});

test('a flat (no-position) session STOP BOT still posts the same /stop endpoint', async () => {
  const flat = { sessionId: 'live_session_flat', mode: 'live_spot', worker: { online: true }, openPositions: [] };
  const { context, calls } = loadCloseHarness(flat);
  context.stopBotSession();
  await flush();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/bot/session/live_session_flat/stop');
});

test('the CLOSE button (stopAndCloseSession) routes a live session through the confirmation modal', () => {
  const { context, document, calls } = loadCloseHarness(liveOpenSession());
  context.stopAndCloseSession('live_session_42');
  assert.ok(document.getElementById('bot-confirm-modal'), 'live close opens the modal, not a bare window.confirm');
  assert.equal(calls.length, 0);
});

test('a live API error keeps the close modal open and shows the message', async () => {
  let reject;
  const { context, document, calls } = loadCloseHarness(liveOpenSession(), () => new Promise((_r, rj) => { reject = rj; }));
  context.confirmCloseLivePosition('live_session_42');
  context.toggleBotConfirmAck(true);
  context.confirmBotConfirmModal();
  context.confirmBotConfirmModal();
  await flush();
  assert.equal(calls.length, 1, 'double submit while busy is ignored');
  reject(new Error('live safety lock active'));
  await flush();
  const modal = document.getElementById('bot-confirm-modal');
  assert.ok(modal, 'modal stays open on error');
  assert.match(modal.innerHTML, /live safety lock active/);
});

// â”€â”€ Source-level guarantees for the render branches (spec 1/2/3 + UI 1â€“4) â”€â”€â”€â”€
test('live open position renders CLOSE â€¦ LIVE POSITION as the single primary action', () => {
  // The global red panel primary button closes via stopAndCloseSession, mode-labelled.
  assert.match(terminalJs, /CLOSE ' \+ _esc\(sym\) \+ ' ' \+ _fleetModeLabel\(openPosSession\) \+ ' POSITION/);
  assert.match(terminalJs, /onclick="stopAndCloseSession\(/);
  // stopAndCloseSession routes live sessions through the confirmation modal.
  assert.match(terminalJs, /if \(_fleetSessionIsLive\(sess\)\) \{ confirmCloseLivePosition/);
});

test('STOP BOT is disabled with a "close position first" message while a position is open', () => {
  assert.match(terminalJs, /const closeFirst = openCountDetail > 0;/);
  assert.match(terminalJs, /Close the ' \+ \(selLive \? 'live' : 'open'\) \+ ' position first/);
  assert.match(terminalJs, /STOP BOT' \+ \(closeFirst \? ' \(close position first\)' : ''\)/);
  // Disabled whenever a position is open (or the session cannot be stopped).
  assert.match(terminalJs, /\(\(canStop && !closeFirst\) \? '' : ' disabled'\)/);
});

test('no CREATE LIVE order is offered while an open position exists', () => {
  assert.match(terminalJs, /anyOpenPosition \|\| smokeOpenCount > 0\) liveBlockedReason = 'Live order hidden: close the open position first.'/);
});

test('testnet/paper sessions are demoted to a collapsed archive when live mode is active', () => {
  assert.match(terminalJs, /const liveModeActive = _fleetLiveModeActive\(sessions\);/);
  assert.match(terminalJs, /function _fleetLiveModeActive/);
  assert.match(terminalJs, /function _fleetDefaultLiveSelectedId/);
  assert.match(terminalJs, /function _fleetResolveSelectedId/);
  assert.match(terminalJs, /archivedTestnetSessions = liveModeActive/);
  assert.match(terminalJs, /!_fleetSessionIsLive\(s\) && _fleetOpenPositionCount\(s\) === 0/);
  assert.match(terminalJs, /Testnet \/ Paper sessions \(/);
  // The primary WORKERS list renders the demoted set, not the raw active list.
  assert.match(terminalJs, /for \(const s of primaryActiveSessions\)/);
});

