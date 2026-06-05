import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const STATE_FILE = path.join(__dirname, '..', '.paperbot-worker-state.json');

// --- Configuration Checks ---
const workerMode = process.env.WORKER_MODE;
const binanceEnv = process.env.BINANCE_ENV;
const controlUrl = process.env.BOT_CONTROL_URL;
const workerToken = process.env.BOT_WORKER_TOKEN;
const apiKey = process.env.BINANCE_API_KEY;
const apiSecret = process.env.BINANCE_API_SECRET;
const maxPositionUsd = Number(process.env.MAX_POSITION_USD) || 10;
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS) || 5000;

if (workerMode !== 'testnet') {
  console.error('[ERROR] WORKER_MODE must be testnet');
  process.exit(1);
}
if (binanceEnv !== 'testnet') {
  console.error('[ERROR] BINANCE_ENV must be testnet');
  process.exit(1);
}
if (!controlUrl || !workerToken || !apiKey || !apiSecret) {
  console.error('[ERROR] Missing required environment variables (BOT_CONTROL_URL, BOT_WORKER_TOKEN, BINANCE_API_KEY, BINANCE_API_SECRET).');
  process.exit(1);
}

const BINANCE_TESTNET_BASE = 'https://testnet.binance.vision/api';

// --- State Management ---
let workerState = { usedKeys: [] };
try {
  if (fs.existsSync(STATE_FILE)) {
    workerState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  }
} catch (err) {
  console.error('[WARN] Failed to load local state, starting fresh.', err.message);
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(workerState, null, 2));
  } catch (err) {
    console.error('[ERROR] Failed to save worker state.', err.message);
  }
}

function markKeyUsed(key) {
  if (!workerState.usedKeys) workerState.usedKeys = [];
  if (!workerState.usedKeys.includes(key)) {
    workerState.usedKeys.push(key);
    workerState.usedKeys = workerState.usedKeys.slice(-100);
    saveState();
  }
}

function isKeyUsed(key) {
  return workerState.usedKeys && workerState.usedKeys.includes(key);
}

// --- Utils ---
function hmacSha256(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex');
}

async function reportResult(resultBody) {
  try {
    const res = await fetch(`${controlUrl}/api/bot/execution-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-BOT-WORKER-TOKEN': workerToken
      },
      body: JSON.stringify(resultBody)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[ERROR] Failed to report result:`, data);
    } else {
      console.log(`[INFO] Result reported successfully for intent ${resultBody.id}`);
    }
  } catch (err) {
    console.error(`[ERROR] Network error reporting result:`, err.message);
  }
}

// --- Polling Loop ---
async function pollIntent() {
  try {
    const res = await fetch(`${controlUrl}/api/bot/execution-intent`, {
      method: 'GET',
      headers: {
        'X-BOT-WORKER-TOKEN': workerToken
      }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[ERROR] Failed to fetch intent: ${data.error || res.status}`);
      return;
    }

    const intent = data.intent;
    if (!intent) return; // No pending intent

    console.log(`[INFO] Found claimed/pending intent ${intent.id} for ${intent.symbol}`);

    if (isKeyUsed(intent.idempotencyKey)) {
      console.log(`[WARN] Intent ${intent.id} (key: ${intent.idempotencyKey}) was already processed locally. Skipping.`);
      return;
    }

    if (intent.mode !== 'testnet') {
      await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: 'Intent mode is not testnet', testnet: true, realProductionOrder: false });
      markKeyUsed(intent.idempotencyKey);
      return;
    }

    if (!/^[A-Z0-9]+(USDT|USDC)$/.test(intent.symbol)) {
      await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: 'Invalid symbol format', testnet: true, realProductionOrder: false });
      markKeyUsed(intent.idempotencyKey);
      return;
    }

    if (intent.positionUsd > maxPositionUsd) {
      await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: 'Position USD exceeds MAX_POSITION_USD', testnet: true, realProductionOrder: false });
      markKeyUsed(intent.idempotencyKey);
      return;
    }

    if (intent.side !== 'BUY' || intent.type !== 'MARKET') {
      await reportResult({ id: intent.id, idempotencyKey: intent.idempotencyKey, status: 'failed', error: 'Only BUY MARKET is supported in this phase', testnet: true, realProductionOrder: false });
      markKeyUsed(intent.idempotencyKey);
      return;
    }

    // Process on Binance
    await executeOnBinance(intent);

  } catch (err) {
    console.error(`[ERROR] Polling loop error:`, err.message);
  }
}

async function executeOnBinance(intent) {
  try {
    console.log(`[INFO] Fetching exchangeInfo for ${intent.symbol}...`);
    const eiRes = await fetch(`${BINANCE_TESTNET_BASE}/v3/exchangeInfo?symbol=${intent.symbol}`);
    const eiData = await eiRes.json();
    if (!eiData || !eiData.symbols || !eiData.symbols[0]) {
      throw new Error(`Symbol ${intent.symbol} not found in exchangeInfo`);
    }
    const symbolInfo = eiData.symbols[0];
    const lotSizeFilter = symbolInfo.filters.find(f => f.filterType === 'LOT_SIZE');
    if (!lotSizeFilter) throw new Error('LOT_SIZE filter not found');

    const stepSize = parseFloat(lotSizeFilter.stepSize);

    console.log(`[INFO] Fetching ticker price for ${intent.symbol}...`);
    const priceRes = await fetch(`${BINANCE_TESTNET_BASE}/v3/ticker/price?symbol=${intent.symbol}`);
    const priceData = await priceRes.json();
    if (!priceData || !priceData.price) throw new Error('Failed to fetch ticker price');
    const price = parseFloat(priceData.price);

    let rawQty = intent.positionUsd / price;
    
    // Round down to stepSize
    const precision = Math.max(0, -Math.floor(Math.log10(stepSize)));
    const stepPow = Math.pow(10, precision);
    let qty = Math.floor(rawQty * stepPow) / stepPow;

    const notionalFilter = symbolInfo.filters.find(f => f.filterType === 'NOTIONAL' || f.filterType === 'MIN_NOTIONAL');
    if (notionalFilter) {
      const minNotional = parseFloat(notionalFilter.minNotional);
      if (qty * price < minNotional) {
        throw new Error(`Order size ${qty * price} is less than minNotional ${minNotional}`);
      }
    }

    console.log(`[INFO] Submitting TESTNET BUY MARKET for ${qty} ${intent.symbol}...`);

    const queryParams = new URLSearchParams();
    queryParams.append('symbol', intent.symbol);
    queryParams.append('side', 'BUY');
    queryParams.append('type', 'MARKET');
    queryParams.append('quantity', qty.toFixed(precision));
    queryParams.append('timestamp', Date.now().toString());
    queryParams.append('recvWindow', '5000');

    const queryString = queryParams.toString();
    const signature = hmacSha256(queryString, apiSecret);
    const finalUrl = `${BINANCE_TESTNET_BASE}/v3/order?${queryString}&signature=${signature}`;

    const orderRes = await fetch(finalUrl, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const orderData = await orderRes.json();

    if (!orderRes.ok) {
      throw new Error(`Binance error: ${orderData.msg || JSON.stringify(orderData)}`);
    }

    console.log(`[INFO] Order successful. OrderID: ${orderData.orderId}`);

    await reportResult({
      id: intent.id,
      idempotencyKey: intent.idempotencyKey,
      status: 'submitted',
      exchange: 'binance_spot_testnet',
      symbol: intent.symbol,
      orderId: orderData.orderId,
      orderStatus: orderData.status,
      executedQty: orderData.executedQty,
      cummulativeQuoteQty: orderData.cummulativeQuoteQty,
      testnet: true,
      realProductionOrder: false
    });

    markKeyUsed(intent.idempotencyKey);

  } catch (err) {
    console.error(`[ERROR] Execution failed for intent ${intent.id}:`, err.message);
    await reportResult({
      id: intent.id,
      idempotencyKey: intent.idempotencyKey,
      status: 'failed',
      error: err.message,
      testnet: true,
      realProductionOrder: false
    });
    markKeyUsed(intent.idempotencyKey);
  }
}

console.log(`[START] Local Binance Worker started (Testnet Mode)`);
console.log(`[INFO] Control URL: ${controlUrl}`);
console.log(`[INFO] Polling every ${pollIntervalMs}ms`);

setInterval(pollIntent, pollIntervalMs);
pollIntent();
