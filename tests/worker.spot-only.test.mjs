import test from 'node:test';
import assert from 'node:assert/strict';

process.env.WORKER_MODE = 'testnet';
process.env.BINANCE_ENV = 'testnet';
process.env.BOT_CONTROL_URL = 'http://127.0.0.1:9';
process.env.BOT_WORKER_TOKEN = 'test-worker-token';
process.env.BINANCE_API_KEY = 'test-key';
process.env.BINANCE_API_SECRET = 'test-secret';
process.env.WORKER_SESSION_ID = `session_spot_${Date.now()}`;
process.env.BINANCE_TESTNET_BASE_OVERRIDE = 'http://127.0.0.1:9/api';

const { assertSpotOnlyRequest } = await import('../scripts/local-binance-worker.mjs');

for (const path of ['/fapi/v1/order', '/dapi/v1/order', '/sapi/v1/margin/order']) {
  test(`spot-only rejects ${path}`, () => {
    assert.throws(() => assertSpotOnlyRequest('POST', `https://api.binance.com${path}`, {}), /SPOT_ONLY_BLOCKED/);
  });
}

for (const params of [{ leverage: 2 }, { marginType: 'isolated' }, { sideEffectType: 'MARGIN_BUY' }, { withdraw: true }, { borrow: 'USDT' }, { repay: 'USDT' }]) {
  test(`spot-only rejects forbidden params ${Object.keys(params)[0]}`, () => {
    assert.throws(() => assertSpotOnlyRequest('POST', 'http://127.0.0.1:9/api/v3/order', params), /SPOT_ONLY_BLOCKED/);
  });
}

test('spot-only allows signed order and account allowlist paths', () => {
  assert.equal(assertSpotOnlyRequest('POST', 'http://127.0.0.1:9/api/v3/order', { symbol: 'BTCUSDT' }), true);
  assert.equal(assertSpotOnlyRequest('GET', 'http://127.0.0.1:9/api/v3/account', {}), true);
});

test('spot-only rejects non-allowlisted signed path', () => {
  assert.throws(() => assertSpotOnlyRequest('DELETE', 'http://127.0.0.1:9/api/v3/order', { symbol: 'BTCUSDT' }), /SPOT_ONLY_BLOCKED/);
});
