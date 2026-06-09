// Lost-update protection test for the fleet store.
//
// Reproduces the EXACT production bug: a browser-queued STOP/EMERGENCY_CLOSE
// command was clobbered by a concurrent worker heartbeat/poll write because both
// did load→mutate→save on one shared document (last-write-wins). Proves that
// mutateFleet's optimistic-concurrency (etag CAS) retry preserves BOTH writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mutateFleet, __setBlobStoreForTest } from '../netlify/functions/_fleet-store.mjs';

// Minimal fake of the Netlify Blobs API with etag semantics + a hook to inject a
// concurrent write between our read and our conditional write.
function makeFakeBlobStore() {
  return {
    raw: null,
    etag: 0,
    onBeforeSet: null,
    async getWithMetadata() {
      return { data: this.raw ? JSON.parse(this.raw) : null, etag: String(this.etag) };
    },
    async setJSON(key, value, opts = {}) {
      if (this.onBeforeSet) { const cb = this.onBeforeSet; this.onBeforeSet = null; await cb(); }
      if (opts.onlyIfMatch !== undefined && opts.onlyIfMatch !== String(this.etag)) return { modified: false };
      if (opts.onlyIfNew && this.raw != null) return { modified: false };
      this.raw = JSON.stringify(value); this.etag += 1; return { modified: true };
    },
    // direct (non-CAS) write used to simulate a racing worker heartbeat
    writeDirect(obj) { this.raw = JSON.stringify(obj); this.etag += 1; },
  };
}

test('CAS: a concurrent worker write between read and write does not drop a queued command', async () => {
  const fake = makeFakeBlobStore();
  __setBlobStoreForTest(fake);
  try {
    // Seed an initial fleet (as if a session already exists).
    await mutateFleet((fleet) => { fleet.botSessions['s1'] = { sessionId: 's1', status: 'running' }; });

    // The browser queues an EMERGENCY_CLOSE for s1. While this mutator is between
    // its read and its conditional write, a worker heartbeat writes the document
    // directly (bumping the etag) — exactly the production race.
    fake.onBeforeSet = () => {
      const cur = JSON.parse(fake.raw);
      cur.workerStatuses['w1'] = { workerId: 'w1', sessionId: 's1', lastSeenAt: 'now' };
      fake.writeDirect(cur);
    };
    await mutateFleet((fleet) => {
      if (!fleet.commandQueue['s1']) fleet.commandQueue['s1'] = [];
      fleet.commandQueue['s1'].push({ id: 'cmd1', type: 'EMERGENCY_CLOSE' });
    });

    const finalState = JSON.parse(fake.raw);
    // Both survived: the worker heartbeat AND the queued command.
    assert.equal(finalState.workerStatuses['w1'].workerId, 'w1', 'concurrent worker write preserved');
    assert.equal(finalState.commandQueue['s1'].length, 1, 'queued command NOT clobbered');
    assert.equal(finalState.commandQueue['s1'][0].type, 'EMERGENCY_CLOSE');
  } finally {
    __setBlobStoreForTest(null);
  }
});

test('CAS: command + control flag both persist across the race', async () => {
  const fake = makeFakeBlobStore();
  __setBlobStoreForTest(fake);
  try {
    await mutateFleet((fleet) => { fleet.botSessions['s2'] = { sessionId: 's2', status: 'running', pauseRequested: false }; });
    fake.onBeforeSet = () => {
      const cur = JSON.parse(fake.raw);
      cur.workerStatuses['w2'] = { workerId: 'w2', lastSeenAt: 't' }; // racing heartbeat
      fake.writeDirect(cur);
    };
    await mutateFleet((fleet) => {
      fleet.botSessions['s2'].stopRequested = true;
      fleet.botSessions['s2'].pauseRequested = true;
      (fleet.commandQueue['s2'] = fleet.commandQueue['s2'] || []).push({ id: 'c2', type: 'STOP' });
    });
    const f = JSON.parse(fake.raw);
    assert.equal(f.botSessions['s2'].stopRequested, true);
    assert.equal(f.workerStatuses['w2'].workerId, 'w2');
    assert.equal(f.commandQueue['s2'][0].type, 'STOP');
  } finally {
    __setBlobStoreForTest(null);
  }
});
