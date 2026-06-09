import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';

const workerFile = fileURLToPath(new URL('../scripts/local-binance-worker.mjs', import.meta.url));

if (process.env.RUN_WORKER_SUBPROCESS_TESTS !== 'true') {
  test('worker subprocess tests skipped by default', { skip: true }, () => {});
} else {
  test('worker-new-5: subprocess handles 502 and stderr gracefully', async () => {
    let heartbeatCount = 0;
    let closed = false;
    
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (req.url.includes('/api/bot/worker-session')) {
        const mockPos = { symbol: 'BTCUSDT', executedQty: '0.0001', orderId: 'mock-1', status: 'open', stepSize: '0.00001000' };
        if (heartbeatCount > 0) {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, session: { stopRequested: true, openPositions: [mockPos] }, stopRequested: true, openPositions: [mockPos] }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, session: { stopRequested: false, openPositions: [mockPos] }, stopRequested: false, openPositions: [mockPos] }));
        }
      } else if (req.url === '/api/bot/worker-heartbeat') {
        heartbeatCount++;
        res.writeHead(502);
        res.end(JSON.stringify({ msg: 'bad gateway' }));
      } else if (req.url.includes('/v3/exchangeInfo')) {
        res.writeHead(200);
        res.end(JSON.stringify({ symbols: [{ baseAsset: 'BTC', filters: [{ filterType: 'LOT_SIZE', stepSize: '0.00001' }, { filterType: 'MIN_NOTIONAL', minNotional: '10' }] }] }));
      } else if (req.url.includes('/v3/order')) {
        res.writeHead(200);
        res.end(JSON.stringify({ orderId: 'mock-1', executedQty: '0.0001', status: 'FILLED', fills: [{ price: '50000', qty: '0.0001' }] }));
      } else if (req.url.includes('/api/bot/position-result')) {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            if (parsed && (parsed.status === 'closed' || parsed.status === 'CLOSED_WITH_DUST')) closed = true;
          } catch (e) {}
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        });
      } else {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
      }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const env = { 
      ...process.env, 
      WORKER_MODE: 'testnet',
      BINANCE_ENV: 'testnet',
      BOT_CONTROL_URL: `http://127.0.0.1:${port}`, 
      BOT_WORKER_TOKEN: 'test-worker-token',
      BINANCE_API_KEY: 'test-key',
      BINANCE_API_SECRET: 'test-secret',
      WORKER_SESSION_ID: `sess_sub_${Date.now()}`, 
      BINANCE_TESTNET_BASE_OVERRIDE: `http://127.0.0.1:${port}/api` 
    };
    
    const child = spawn('node', [workerFile], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', d => stderr += d);
    child.stdout.on('data', d => stdout += d);
    
    let timeoutId;
    try {
      const exitCode = await Promise.race([
        new Promise(resolve => child.on('close', resolve)),
        new Promise((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('timeout! stdout: ' + stdout + ' stderr: ' + stderr)), 20000);
        })
      ]);
      
      assert.equal(exitCode, 0, 'Worker must exit cleanly (0) after STOP, not crash on 502 stderr');
      assert.equal(closed, true, 'Worker must have closed the position. stdout: ' + stdout + '\nstderr: ' + stderr);
      assert.equal(stderr.includes('[WARN] Heartbeat HTTP 502'), false, 'stderr must not contain recoverable warnings');
    } catch (err) {
      child.kill('SIGKILL');
      throw err;
    } finally {
      clearTimeout(timeoutId);
      child.kill('SIGTERM');
      if (server.closeAllConnections) server.closeAllConnections();
      await new Promise(r => server.close(r));
    }
  });
}
