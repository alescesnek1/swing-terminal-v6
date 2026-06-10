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

let _blobStore = null; // Netlify Blobs store, or null if unavailable
let _backendName = 'memory';
let _storeError = null; // last safe diagnostic message (no secrets)
const _mem = new Map();

// Explicit Blobs credentials, used only if auto-context injection is missing
// (e.g. a manual/CLI deploy). Never logged.
function blobCredsFromEnv() {
  const siteID = process.env.NETLIFY_SITE_ID || process.env.BLOBS_SITE_ID || process.env.SITE_ID || null;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN || process.env.NETLIFY_AUTH_TOKEN || null;
  return siteID && token ? { siteID, token } : null;
}

// Downgrade to memory and record why. Keeps the system HONEST: the UI then shows
// "CONTROL STATE NOT DURABLE" and blocks new entries instead of pretending.
function downgradeToMemory(reason) {
  _blobStore = null;
  _backendName = 'memory';
  _storeError = reason ? String(reason).slice(0, 200) : 'unknown blob error';
}

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
    liveAuditEvents: [],   // immutable live_spot action ring, no secrets
    livePreflight: null,   // sanitized latest local-worker live preflight result
    globalKillSwitch: false,
    liveSafetyLock: null,  // { active, sessionId, reason, since } — set after a failed live close, cleared on reconciliation

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
  if (!Array.isArray(base.liveAuditEvents)) base.liveAuditEvents = [];
  if (typeof base.globalKillSwitch !== 'boolean') base.globalKillSwitch = false;
  return base;
}

// Resolve the durable backend. Unlike the previous version this does NOT pin a
// failure permanently: while we are on memory we re-attempt on every call so a
// transient cold-start race or late-injected Blobs context can recover.
async function resolveBackend() {
  if (_blobStore) return; // already durable
  try {
    const mod = await import('@netlify/blobs');
    if (!mod || typeof mod.getStore !== 'function') {
      return downgradeToMemory('@netlify/blobs has no getStore export');
    }
    const opts = { name: 'bot-fleet', consistency: 'strong' };
    try {
      _blobStore = mod.getStore(opts);
    } catch (e1) {
      // Auto-context not injected (manual/CLI deploy). Retry with explicit creds.
      const creds = blobCredsFromEnv();
      if (!creds) throw e1;
      _blobStore = mod.getStore({ ...opts, ...creds });
    }
    _backendName = 'blobs';
    _storeError = null;
  } catch (err) {
    downgradeToMemory(err && err.message ? err.message : 'blob init failed');
    console.warn('[fleetStore] Netlify Blobs unavailable, using in-memory fallback:', _storeError);
  }
}

export function fleetBackend() {
  return _backendName;
}

// Safe, UI-facing store diagnostics (no secrets).
export function fleetStoreInfo() {
  const durable = _backendName === 'blobs';
  return { storeMode: durable ? 'durable_blobs' : 'memory_fallback', durable, storeError: durable ? null : _storeError };
}

export async function loadFleet() {
  await resolveBackend();
  if (_blobStore) {
    try {
      const data = await _blobStore.get(FLEET_KEY, { type: 'json' });
      return normalize(data);
    } catch (err) {
      // A read failure means the store is not actually usable — downgrade so the
      // UI reflects reality instead of silently reporting durable_blobs.
      downgradeToMemory(err && err.message ? err.message : 'blob read failed');
      console.warn('[fleetStore] blob read failed, downgrading to memory:', _storeError);
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
      // Mirror to memory so a later blob failure cannot lose this write within
      // the process lifetime (monotonic open-position state).
      _mem.set(FLEET_KEY, JSON.stringify(fleet));
      return;
    } catch (err) {
      downgradeToMemory(err && err.message ? err.message : 'blob write failed');
      console.error('[fleetStore] blob write failed, downgrading to memory:', _storeError);
    }
  }
  _mem.set(FLEET_KEY, JSON.stringify(fleet));
}

// In-process serialization for the memory backend (single process, no etag).
let _memChain = Promise.resolve();
const MUTATE_MAX_ATTEMPTS = 6;

// mutateFleet: load → mutator(fleet) → write, with LOST-UPDATE PROTECTION.
//
// Why this exists: the whole fleet is one document. Every worker heartbeat/poll
// and every browser action did load→mutate→save independently, so a command
// queued by the browser could be clobbered by a concurrent worker write that had
// loaded the document a moment earlier. With the durable Blobs store (separate
// function invocations) this race is frequent — STOP/EMERGENCY_CLOSE commands
// silently vanished before the worker ever polled them.
//
// - Blobs backend: optimistic concurrency via etag (getWithMetadata + setJSON
//   { onlyIfMatch }), retried on conflict. Re-runs the mutator on fresh state.
// - Memory backend: an in-process async mutex (single process, no etag needed).
//
// The mutator MUST be a pure function of `fleet` (it may be re-run); side effects
// other than mutating `fleet` should be idempotent. It returns the value
// mutateFleet resolves to.
export async function mutateFleet(mutator) {
  await resolveBackend();

  // ── Durable Blobs: compare-and-swap with retry ──
  if (_blobStore && typeof _blobStore.getWithMetadata === 'function' && typeof _blobStore.setJSON === 'function') {
    for (let attempt = 0; attempt < MUTATE_MAX_ATTEMPTS; attempt++) {
      let data = null; let etag = null;
      try {
        const r = await _blobStore.getWithMetadata(FLEET_KEY, { type: 'json' });
        if (r) { data = r.data; etag = r.etag || null; }
      } catch (err) {
        downgradeToMemory(err && err.message ? err.message : 'blob read failed');
        break; // fall through to memory path
      }
      const fleet = normalize(data);
      const result = await mutator(fleet);
      fleet.updatedAt = new Date().toISOString();
      try {
        const opts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
        const res = await _blobStore.setJSON(FLEET_KEY, fleet, opts);
        // Netlify Blobs returns { modified: false } when the precondition failed.
        if (res && res.modified === false) continue; // concurrent write — retry
        _mem.set(FLEET_KEY, JSON.stringify(fleet));
        return result;
      } catch (err) {
        // Some SDK versions throw on precondition failure — retry a few times.
        if (attempt < MUTATE_MAX_ATTEMPTS - 1) continue;
        downgradeToMemory(err && err.message ? err.message : 'blob write failed');
        break;
      }
    }
  }

  // ── Memory backend: serialize via mutex so concurrent mutations don't lose ──
  const run = _memChain.then(async () => {
    const raw = _mem.get(FLEET_KEY);
    const fleet = normalize(raw ? JSON.parse(raw) : null);
    const result = await mutator(fleet);
    fleet.updatedAt = new Date().toISOString();
    _mem.set(FLEET_KEY, JSON.stringify(fleet));
    return result;
  });
  _memChain = run.then(() => {}, () => {});
  return run;
}

// Test-only seam: inject a fake blob store to exercise the CAS path deterministically.
export function __setBlobStoreForTest(store) {
  _blobStore = store;
  _backendName = store ? 'blobs' : 'memory';
  _storeError = null;
}

export { emptyFleet };
