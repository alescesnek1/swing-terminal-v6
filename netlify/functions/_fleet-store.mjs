// Durable fleet state store for the Bot Fleet Manager.
//
// Primary backend: Netlify Blobs (survives across serverless instances/cold
// starts). Fallback: in-memory Map for local/dev when @netlify/blobs cannot be
// loaded. The whole fleet lives in a single JSON document under one key, so a
// read-modify-write within a request is atomic enough for per-session
// idempotency (last-write-wins across concurrent requests; idempotency keys are
// enforced inside the document).
//
// SECURITY: this document holds NO Binance secrets and NO worker token — only
// session metadata, configs, intents, results and command queues.

const FLEET_KEY = 'fleet-state';

let _backendResolved = false;
let _blobStore = null; // Netlify Blobs store, or null if unavailable
let _backendName = 'memory';
const _mem = new Map();

function emptyFleet() {
  return {
    botSessions: {},      // sessionId -> Session
    workerStatuses: {},   // workerId  -> WorkerStatus
    executionIntents: {}, // sessionId -> Intent | null
    executionResults: {}, // sessionId -> Result[]
    positionResults: {},  // sessionId -> PositionRecord[]
    botConfigs: {},       // ownerUserId -> BotConfig
    commandQueue: {},     // sessionId -> Command[]
    usedIdempotencyKeys: {}, // sessionId -> string[]
    events: [],           // tagged event ring (sessionId/ownerUserId)
    lastRegime: null,     // { regime, entriesAllowed, reason[], metrics, updatedAt }
    updatedAt: null,
  };
}

function normalize(data) {
  const base = emptyFleet();
  if (!data || typeof data !== 'object') return base;
  for (const key of Object.keys(base)) {
    if (data[key] !== undefined && data[key] !== null) base[key] = data[key];
  }
  // Defensive: ensure map containers are objects and arrays are arrays.
  for (const k of ['botSessions', 'workerStatuses', 'executionIntents', 'executionResults', 'positionResults', 'botConfigs', 'commandQueue', 'usedIdempotencyKeys']) {
    if (typeof base[k] !== 'object' || Array.isArray(base[k])) base[k] = {};
  }
  if (!Array.isArray(base.events)) base.events = [];
  return base;
}

async function resolveBackend() {
  if (_backendResolved) return;
  _backendResolved = true;
  try {
    const mod = await import('@netlify/blobs');
    if (mod && typeof mod.getStore === 'function') {
      _blobStore = mod.getStore({ name: 'bot-fleet', consistency: 'strong' });
      _backendName = 'blobs';
      return;
    }
  } catch (err) {
    console.warn('[fleetStore] @netlify/blobs unavailable, using in-memory fallback:', err && err.message);
  }
  _blobStore = null;
  _backendName = 'memory';
}

export function fleetBackend() {
  return _backendName;
}

export async function loadFleet() {
  await resolveBackend();
  if (_blobStore) {
    try {
      const data = await _blobStore.get(FLEET_KEY, { type: 'json' });
      return normalize(data);
    } catch (err) {
      console.warn('[fleetStore] blob read failed, returning empty fleet:', err && err.message);
      return emptyFleet();
    }
  }
  const raw = _mem.get(FLEET_KEY);
  return normalize(raw ? JSON.parse(raw) : null);
}

export async function saveFleet(fleet) {
  fleet.updatedAt = new Date().toISOString();
  await resolveBackend();
  if (_blobStore) {
    try {
      await _blobStore.setJSON(FLEET_KEY, fleet);
      return;
    } catch (err) {
      console.error('[fleetStore] blob write failed:', err && err.message);
      // Fall through to memory so the request still completes locally.
    }
  }
  _mem.set(FLEET_KEY, JSON.stringify(fleet));
}

export { emptyFleet };
