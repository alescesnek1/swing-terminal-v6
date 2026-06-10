import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

// --- Valid live env so the module imports cleanly and the in-process PASS test
// exercises the live preflight branch. WORKER_LIVE_PREFLIGHT=true makes the module
// treat this as live preflight (no --session required, no main loop). ---
process.env.WORKER_MODE = 'live_spot';
process.env.BINANCE_ENV = 'live_spot';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token-live-pf';
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.BOT_LIVE_TRADING_ENABLED = 'true';
process.env.BOT_ALLOW_REAL_ORDERS = 'true';
process.env.LIVE_SPOT_ACK = 'I_UNDERSTAND_REAL_MONEY_RISK';
process.env.LOCAL_WORKER_LIVE_CONFIRM = 'true';
process.env.LIVE_MAX_POSITION_USD = '10';
process.env.LIVE_MAX_DAILY_LOSS_USD = '5';
process.env.LIVE_MAX_DAILY_TRADES = '3';
process.env.LIVE_MAX_OPEN_POSITIONS = '1';
process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDT';
process.env.WORKER_LIVE_PREFLIGHT = 'true';
delete process.env.WORKER_SESSION_ID;
delete process.env.BOT_GLOBAL_KILL_SWITCH;

const workerFile = fileURLToPath(new URL('../scripts/local-binance-worker.mjs', import.meta.url));
const worker = await import('../scripts/local-binance-worker.mjs');
const { runPreflight, LIVE_PREFLIGHT_FILE } = worker;

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

const FORBIDDEN_FRAGMENTS = ['/fapi', '/dapi', '/sapi', 'margin', 'borrow', 'repay', 'leverage', 'withdraw'];

// ── In-process PASS path: stub global fetch so no real Binance call is made. ──
test('live preflight passes on valid gates and uses only the spot /api/v3/account path', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (u.includes('/v3/account')) {
      return jsonResponse({ canTrade: true, accountType: 'SPOT', permissions: ['SPOT'], balances: [{ asset: 'USDT', free: '20' }, { asset: 'BTC', free: '0' }] });
    }
    if (u.includes('/v3/exchangeInfo')) {
      return jsonResponse({ symbols: [{ baseAsset: 'BTC', isSpotTradingAllowed: true, filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001' }, { filterType: 'NOTIONAL', minNotional: '10' }] }] });
    }
    if (u.includes('/api/bot/live-preflight-result')) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  };
  try {
    const code = await runPreflight();
    assert.equal(code, 0, 'valid gates must PASS (exit 0)');

    const urls = calls.map((c) => c.url.toLowerCase());
    // req: uses only /api/v3/account signed spot account path for the account check
    assert.ok(urls.some((u) => /\/api\/v3\/account(\?|$)/.test(u)), 'must reach signed /api/v3/account');
    // req: never polls worker-session, never sends a heartbeat
    assert.ok(!urls.some((u) => u.includes('worker-session')), 'must NOT call worker-session');
    assert.ok(!urls.some((u) => u.includes('worker-heartbeat')), 'must NOT call worker-heartbeat');
    // req: no futures/margin/sapi/etc. paths
    for (const bad of FORBIDDEN_FRAGMENTS) {
      assert.ok(!urls.some((u) => u.includes(bad)), `must NOT call any ${bad} path`);
    }
  } finally {
    globalThis.fetch = realFetch;
    try { fs.rmSync(LIVE_PREFLIGHT_FILE, { force: true }); } catch { /* best effort */ }
  }
});

// ── In-process PASS path for USDC-only mode: keep funds in USDC, trade BTCUSDC. ──
test('live preflight passes for BTCUSDC, shows USDC balance, and uses only the spot account path', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logged = [];
  console.log = (...a) => { logged.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); };
  process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDC';
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, method: (init && init.method) || 'GET' });
    if (u.includes('/v3/account')) {
      return jsonResponse({ canTrade: true, accountType: 'SPOT', permissions: ['SPOT'], balances: [{ asset: 'USDC', free: '25' }, { asset: 'USDT', free: '0' }, { asset: 'BTC', free: '0' }] });
    }
    if (u.includes('/v3/exchangeInfo')) {
      return jsonResponse({ symbols: [{ baseAsset: 'BTC', quoteAsset: 'USDC', isSpotTradingAllowed: true, filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001', minQty: '0.00001' }, { filterType: 'NOTIONAL', minNotional: '10' }] }] });
    }
    if (u.includes('/api/bot/live-preflight-result')) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  };
  try {
    const code = await runPreflight();
    assert.equal(code, 0, 'BTCUSDC valid gates must PASS (exit 0)');
    const out = logged.join('\n');
    assert.match(out, /LIVE PREFLIGHT PASS/, 'must print LIVE PREFLIGHT PASS');
    assert.match(out, /"USDC":"25"/, 'balances must include the USDC balance');
    assert.match(out, /"allowedSymbols":\["BTCUSDC"\]/, 'risk caps must show allowedSymbols ["BTCUSDC"]');

    const urls = calls.map((c) => c.url.toLowerCase());
    // req: only signed spot path used is /api/v3/account
    assert.ok(urls.some((u) => /\/api\/v3\/account(\?|$)/.test(u)), 'must reach signed /api/v3/account');
    assert.ok(!urls.some((u) => u.includes('worker-session')), 'must NOT call worker-session');
    assert.ok(!urls.some((u) => u.includes('worker-heartbeat')), 'must NOT call worker-heartbeat');
    for (const bad of FORBIDDEN_FRAGMENTS) {
      assert.ok(!urls.some((u) => u.includes(bad)), `must NOT call any ${bad} path`);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.log = realLog;
    process.env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDT';
    try { fs.rmSync(LIVE_PREFLIGHT_FILE, { force: true }); } catch { /* best effort */ }
  }
});

// ── Subprocess paths: prove the CLI flag never enters the worker loop. ──
function baseLiveEnv(port) {
  return {
    ...process.env,
    WORKER_MODE: 'live_spot',
    BINANCE_ENV: 'live_spot',
    BOT_CONTROL_URL: `http://127.0.0.1:${port}`,
    BOT_WORKER_TOKEN: 'test-worker-token-live-pf',
    BINANCE_API_KEY: 'test-key',
    BINANCE_API_SECRET: 'test-secret',
    BOT_LIVE_TRADING_ENABLED: 'true',
    BOT_ALLOW_REAL_ORDERS: 'true',
    LIVE_SPOT_ACK: 'I_UNDERSTAND_REAL_MONEY_RISK',
    LOCAL_WORKER_LIVE_CONFIRM: 'true',
    LIVE_MAX_POSITION_USD: '10',
    LIVE_MAX_DAILY_LOSS_USD: '5',
    LIVE_MAX_DAILY_TRADES: '3',
    LIVE_MAX_OPEN_POSITIONS: '1',
    LIVE_ALLOWED_SYMBOLS: 'BTCUSDT',
  };
}

// Runs `node local-binance-worker.mjs --live-preflight` (no --session) against a
// mock control server that records every endpoint it is asked to hit.
async function runLivePreflightSubprocess(mutateEnv) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const env = baseLiveEnv(port);
  delete env.WORKER_LIVE_PREFLIGHT; // rely on the --live-preflight CLI flag instead
  if (mutateEnv) mutateEnv(env);

  const child = spawn('node', [workerFile, '--live-preflight'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });

  let timeoutId;
  try {
    const exitCode = await Promise.race([
      new Promise((resolve) => child.on('close', resolve)),
      new Promise((_, reject) => { timeoutId = setTimeout(() => reject(new Error(`timeout. stdout: ${stdout} stderr: ${stderr}`)), 20000); }),
    ]);
    return { exitCode, stdout, stderr, hits };
  } catch (err) {
    child.kill('SIGKILL');
    throw err;
  } finally {
    clearTimeout(timeoutId);
    child.kill('SIGTERM');
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
    // The subprocess writes a FAIL marker to the repo root; don't leave it behind.
    try { fs.rmSync(LIVE_PREFLIGHT_FILE, { force: true }); } catch { /* best effort */ }
  }
}

function assertNoWorkerLoopCalls(hits, ctx) {
  assert.ok(!hits.some((u) => u.includes('worker-session')), `${ctx}: must NOT poll worker-session`);
  assert.ok(!hits.some((u) => u.includes('worker-heartbeat')), `${ctx}: must NOT send worker-heartbeat`);
}

test('live preflight does not require --session and never enters the worker loop on a failed gate', async () => {
  const { exitCode, stdout, hits } = await runLivePreflightSubprocess((env) => { delete env.LOCAL_WORKER_LIVE_CONFIRM; });
  assert.equal(exitCode, 1, 'missing gate must FAIL (exit 1)');
  assert.match(stdout, /LIVE PREFLIGHT FAIL/, 'must print LIVE PREFLIGHT FAIL');
  assert.doesNotMatch(stdout, /sessionId is required/, 'preflight must not require a session');
  assert.match(stdout, /LOCAL_WORKER_LIVE_CONFIRM/, 'failure reason must name the missing gate');
  assert.doesNotMatch(stdout, /\[START\] Local Binance Worker/, 'must not start the normal worker');
  assertNoWorkerLoopCalls(hits, 'missing-gate');
});

test('live preflight refuses a max position cap above 10', async () => {
  const { exitCode, stdout, hits } = await runLivePreflightSubprocess((env) => { env.LIVE_MAX_POSITION_USD = '50'; });
  assert.equal(exitCode, 1, 'max position > 10 must FAIL');
  assert.match(stdout, /LIVE PREFLIGHT FAIL/);
  assert.match(stdout, /LIVE_MAX_POSITION_USD/);
  assertNoWorkerLoopCalls(hits, 'oversized-position');
});

test('live preflight refuses an allowed-symbol set that is not exactly BTCUSDT', async () => {
  const { exitCode, stdout, hits } = await runLivePreflightSubprocess((env) => { env.LIVE_ALLOWED_SYMBOLS = 'ETHUSDT'; });
  assert.equal(exitCode, 1, 'non-BTCUSDT allowlist must FAIL');
  assert.match(stdout, /LIVE PREFLIGHT FAIL/);
  assert.match(stdout, /LIVE_ALLOWED_SYMBOLS/);
  assertNoWorkerLoopCalls(hits, 'wrong-symbol');
});

test('live preflight refuses a multi-symbol allowlist that includes BTCUSDT plus extras', async () => {
  const { exitCode, stdout } = await runLivePreflightSubprocess((env) => { env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDT,ETHUSDT'; });
  assert.equal(exitCode, 1, 'extra symbols beyond BTCUSDT must FAIL');
  assert.match(stdout, /LIVE_ALLOWED_SYMBOLS/);
});

test('live preflight refuses the BTCUSDT,BTCUSDC multi-symbol allowlist', async () => {
  const { exitCode, stdout, hits } = await runLivePreflightSubprocess((env) => { env.LIVE_ALLOWED_SYMBOLS = 'BTCUSDT,BTCUSDC'; });
  assert.equal(exitCode, 1, 'two valid symbols together must still FAIL (single symbol only)');
  assert.match(stdout, /LIVE PREFLIGHT FAIL/);
  assert.match(stdout, /LIVE_ALLOWED_SYMBOLS/);
  assertNoWorkerLoopCalls(hits, 'multi-symbol-usdc');
});

test('live preflight refuses ETHUSDC (unsupported single symbol)', async () => {
  const { exitCode, stdout, hits } = await runLivePreflightSubprocess((env) => { env.LIVE_ALLOWED_SYMBOLS = 'ETHUSDC'; });
  assert.equal(exitCode, 1, 'ETHUSDC must FAIL (only BTCUSDT or BTCUSDC allowed)');
  assert.match(stdout, /LIVE PREFLIGHT FAIL/);
  assert.match(stdout, /LIVE_ALLOWED_SYMBOLS/);
  assertNoWorkerLoopCalls(hits, 'eth-usdc');
});
