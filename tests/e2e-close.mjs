// Deterministic end-to-end lifecycle proof — NO human steps, NO real Binance.
//
// Spins up the REAL backend handler behind a localhost HTTP server, mocks Binance
// Spot Testnet on the same server, spawns the REAL worker process, then drives the
// exact browser API path:
//   START → worker ONLINE → SMOKE BUY → OPEN → EMERGENCY CLOSE → SELL → CLOSED → START allowed
//
// Run: `npm run e2e`. Exits 0 on success and prints the evidence block.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(__dirname, '..');
const WORKER_TOKEN = 'e2e-worker-token';

// Backend env MUST be set before importing the handler.
process.env.BOT_WORKER_TOKEN = WORKER_TOKEN;
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_ALLOW_TESTNET_ORDERS = 'true';
process.env.BOT_ALLOW_MEMORY_STORE = 'true'; // harness uses memory; prod uses durable blobs
process.env.AUTH_DECODE_ONLY = 'true';
delete process.env.BOT_LIVE_TRADING_ENABLED;
delete process.env.BOT_ALLOW_REAL_ORDERS;

const { default: handler } = await import('../netlify/functions/bot.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const JWT = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'e2e-user', email: 'e2e@example.com' })}.sig`;

function sendJson(res, obj, code = 200) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); }
function collectBody(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); }); }

function mockBinance(req, res, u) {
  if (u.pathname === '/v3/exchangeInfo') return sendJson(res, { symbols: [{ baseAsset: 'BTC', filters: [
    { filterType: 'LOT_SIZE', stepSize: '0.00001000' }, { filterType: 'NOTIONAL', minNotional: '1' } ] }] });
  if (u.pathname === '/v3/ticker/price') return sendJson(res, { symbol: u.searchParams.get('symbol'), price: '50000' });
  if (u.pathname === '/v3/order') {
    const side = u.searchParams.get('side');
    return sendJson(res, { orderId: (side === 'SELL' ? 'SELL-' : 'BUY-') + Date.now(), status: 'FILLED', executedQty: '0.00015000', cummulativeQuoteQty: '7.5' });
  }
  if (u.pathname === '/v3/account') return sendJson(res, { accountType: 'SPOT', balances: [{ asset: 'USDT', free: '1000' }, { asset: 'BTC', free: '0' }] });
  return sendJson(res, {}, 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL('http://' + req.headers.host + req.url);
    if (u.pathname.startsWith('/v3/')) { if (req.method === 'POST') await collectBody(req); return mockBinance(req, res, u); }
    const bodyBuf = (req.method === 'POST') ? await collectBody(req) : undefined;
    const headers = {}; for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
    const webReq = new Request(u.toString(), { method: req.method, headers, body: bodyBuf && bodyBuf.length ? bodyBuf : undefined });
    const out = await handler(webReq);
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(await out.text());
  } catch (err) { sendJson(res, { ok: false, error: String(err && err.message) }, 500); }
});

const evidence = { workerBuyLog: null, workerSellLog: null, fleetBefore: null, fleetAfter: null, startAllowedAgain: false };
let worker = null;
const workerLines = [];

function fail(msg) { console.error('\n[E2E][FAIL] ' + msg); shutdown(1); }
function shutdown(code) { try { if (worker) worker.kill('SIGKILL'); } catch {} try { server.close(); } catch {} process.exit(code); }

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const PORT = server.address().port;
  const BASE = `http://127.0.0.1:${PORT}`;
  console.log(`[E2E] control plane + mock Binance on ${BASE}`);

  const browser = (method, p, body) => fetch(BASE + p, {
    method, headers: { Origin: 'http://localhost', Authorization: 'Bearer ' + JWT, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
  const fleet = () => browser('GET', '/api/bot/fleet').then((r) => r.json);
  const sessionView = async (sid) => (await fleet()).sessions.find((s) => s.sessionId === sid) || null;
  const pollUntil = async (fn, ms, label) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(400); } throw new Error('timeout waiting for ' + label); };

  // 1. START BOT (browser path).
  const start = await browser('POST', '/api/bot/start-session', {});
  if (start.status !== 200) return fail('start-session failed: ' + JSON.stringify(start.json));
  const sid = start.json.sessionId;
  console.log('[E2E] START BOT → session ' + sid);

  // 2. Spawn the REAL worker bound to this exact session (what swingworker:// does).
  worker = spawn(process.execPath, ['scripts/local-binance-worker.mjs', '--session', sid], {
    cwd: REPO,
    env: { ...process.env,
      WORKER_MODE: 'testnet', BINANCE_ENV: 'testnet',
      BOT_CONTROL_URL: BASE, BOT_WORKER_TOKEN: WORKER_TOKEN,
      BINANCE_API_KEY: 'e2e-key', BINANCE_API_SECRET: 'e2e-secret',
      BINANCE_TESTNET_BASE_OVERRIDE: BASE, POLL_INTERVAL_MS: '800',
    },
  });
  const onData = (d) => { const s = d.toString(); s.split(/\r?\n/).forEach((l) => { if (l.trim()) workerLines.push(l); }); };
  worker.stdout.on('data', onData); worker.stderr.on('data', onData);

  // 3. Wait for the worker to come ONLINE (heartbeat reaches fleet).
  await pollUntil(async () => { const s = await sessionView(sid); return s && s.worker && s.worker.online; }, 20000, 'worker online');
  console.log('[E2E] worker ONLINE');

  // 4. CREATE TESTNET SMOKE ORDER (browser path) → worker BUYs.
  const smoke = await browser('POST', '/api/bot/create-smoke-execution-intent', { sessionId: sid });
  if (smoke.status !== 200) return fail('smoke intent failed: ' + JSON.stringify(smoke.json));
  console.log('[E2E] SMOKE intent created');

  // 5. Wait for the OPEN position to appear in the fleet.
  await pollUntil(async () => { const s = await sessionView(sid); return s && (s.openPositions || []).length > 0; }, 20000, 'open position');
  evidence.fleetBefore = await sessionView(sid);
  evidence.workerBuyLog = workerLines.find((l) => /\[ORDER\].*BUY MARKET/.test(l)) || workerLines.find((l) => /Order successful/.test(l));
  console.log('[E2E] OPEN position visible (openPositions=' + (evidence.fleetBefore.openPositions || []).length + ')');

  // 6. EMERGENCY CLOSE TESTNET (browser path, exact session).
  const emc = await browser('POST', `/api/bot/session/${encodeURIComponent(sid)}/emergency-close`, {});
  if (emc.status !== 200) return fail('emergency-close failed: ' + JSON.stringify(emc.json));
  console.log('[E2E] EMERGENCY CLOSE requested');

  // 7. Wait for CLOSED (openPositions back to 0).
  await pollUntil(async () => { const s = await sessionView(sid); return s && (s.openPositions || []).length === 0; }, 25000, 'position closed');
  evidence.fleetAfter = await sessionView(sid);
  evidence.workerSellLog = workerLines.find((l) => /\[CLOSE\].*SELL MARKET/.test(l)) || workerLines.find((l) => /Close result OK/.test(l));
  console.log('[E2E] CLOSED (openPositions=0)');

  // 8. START BOT available again (no open position blocks it).
  const restart = await browser('POST', '/api/bot/start-session', {});
  evidence.startAllowedAgain = restart.status === 200 && restart.json.ok === true;

  // ── Assertions ──
  if (!evidence.workerBuyLog) return fail('no worker BUY log line captured');
  if (!evidence.workerSellLog) return fail('no worker SELL log line captured');
  if ((evidence.fleetBefore.openPositions || []).length !== 1) return fail('expected 1 open position before close');
  if ((evidence.fleetAfter.openPositions || []).length !== 0) return fail('expected 0 open positions after close');
  if (!evidence.startAllowedAgain) return fail('start-session not allowed again after close');

  console.log('\n================ E2E CLOSE EVIDENCE ================');
  console.log('worker BUY : ' + evidence.workerBuyLog);
  console.log('worker SELL: ' + evidence.workerSellLog);
  console.log('fleet before close: openPositions=' + JSON.stringify(evidence.fleetBefore.openPositions));
  console.log('fleet after  close: openPositions=' + JSON.stringify(evidence.fleetAfter.openPositions));
  console.log('positionResults after: ' + JSON.stringify((evidence.fleetAfter.positionResults || []).map((p) => ({ status: p.status, orderId: p.orderId, closeOrderId: p.closeOrderId }))));
  console.log('START BOT allowed again: ' + evidence.startAllowedAgain);
  console.log('===================================================');
  console.log('\n[E2E][PASS] Full UI-driven testnet lifecycle proven.');
  shutdown(0);
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
// Safety timeout so a hang never blocks CI.
setTimeout(() => fail('global timeout (90s)'), 90000).unref();
