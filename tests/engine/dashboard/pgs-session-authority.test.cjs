'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createPgsSessionAuthority,
} = require('../../../engine/src/dashboard/brain-operations/pgs-session-authority.js');

const OPERATION_A = `brop_${'a'.repeat(32)}`;
const OPERATION_B = `brop_${'b'.repeat(32)}`;
const OPERATION_C = `brop_${'c'.repeat(32)}`;

async function fixture(t, overrides = {}) {
  const createdRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-authority-'));
  const tempRoot = await fsp.realpath(createdRoot);
  const agentRuntimeRoot = path.join(tempRoot, 'runtime');
  await fsp.mkdir(agentRuntimeRoot, { recursive: true });
  t.after(() => fsp.rm(tempRoot, { recursive: true, force: true }));
  const now = { value: Date.parse('2026-07-12T12:00:00.000Z') };
  const options = {
    agentRuntimeRoot,
    agentId: 'jerry',
    clock: () => now.value,
    retentionMs: 60_000,
    leaseMs: 10_000,
    maxSessionBytes: 1024 * 1024,
    maxTotalBytes: 4 * 1024 * 1024,
    ...overrides,
  };
  const authority = await createPgsSessionAuthority(options);
  t.after(() => authority.stop?.());
  return { authority, agentRuntimeRoot, now, options };
}

function fakeJanitorTimers() {
  let callback = null;
  let interval = null;
  let unrefCalls = 0;
  let clearCalls = 0;
  return {
    timers: {
      setInterval(next, delay) {
        callback = next;
        interval = delay;
        return { unref() { unrefCalls += 1; } };
      },
      clearInterval() {
        clearCalls += 1;
        callback = null;
      },
    },
    async tick() {
      if (callback) await callback();
    },
    status() { return { interval, unrefCalls, clearCalls, armed: callback !== null }; },
  };
}

function binding(overrides = {}) {
  return {
    schemaVersion: 3,
    queryDigest: `sha256:${'1'.repeat(64)}`,
    sourceRevision: 42,
    sweepProvider: 'openai',
    sweepModel: 'gpt-5.5',
    ...overrides,
  };
}

test('creates an opaque per-agent session and rejects caller path fields', async (t) => {
  const { authority, agentRuntimeRoot } = await fixture(t);

  const created = await authority.createSession({
    ownerAgent: 'jerry',
    operationId: OPERATION_A,
    binding: binding(),
  });

  assert.match(created.sessionId, /^pgss_[A-Za-z0-9_-]{32}$/);
  assert.equal(created.continuableUntil, '2026-07-12T12:01:00.000Z');
  assert.equal(created.workerHandle.sessionId, created.sessionId);
  assert.equal(created.workerHandle.ownerAgent, 'jerry');
  assert.equal(created.workerHandle.operationId, OPERATION_A);
  assert.equal(
    path.dirname(created.workerHandle.sessionRoot),
    path.join(agentRuntimeRoot, 'pgs-sessions'),
  );
  assert.equal(created.workerHandle.databasePath, path.join(
    created.workerHandle.sessionRoot,
    'session.sqlite',
  ));

  await assert.rejects(
    authority.createSession({
      ownerAgent: 'jerry',
      operationId: OPERATION_A,
      binding: binding(),
      sessionRoot: path.join(agentRuntimeRoot, 'caller-selected'),
    }),
    { code: 'invalid_request' },
  );
});

test('same-owner continuation reopens one session after authority recreation', async (t) => {
  const { authority, options } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(created.workerHandle.databasePath, 'already swept');
  const createdIdentity = await fsp.stat(created.workerHandle.databasePath);
  await authority.releaseLease(created.workerHandle);

  const restarted = await createPgsSessionAuthority(options);
  const continued = await restarted.continueSession({
    sessionId: created.sessionId,
    ownerAgent: 'jerry',
    sourceOperationId: OPERATION_A,
    operationId: OPERATION_B,
    binding: binding(),
  });
  const continuedIdentity = await fsp.stat(continued.workerHandle.databasePath);

  assert.equal(continued.sessionId, created.sessionId);
  assert.equal(continued.workerHandle.sourceOperationId, OPERATION_A);
  assert.equal(continuedIdentity.dev, createdIdentity.dev);
  assert.equal(continuedIdentity.ino, createdIdentity.ino);
  assert.equal(await fsp.readFile(continued.workerHandle.databasePath, 'utf8'), 'already swept');
});

test('continuation denies a different owner', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'forrest',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_owner_mismatch' },
  );
});

test('continuation refuses a non-lineage source operation and an exact binding mismatch', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_C,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_lineage_mismatch' },
  );
  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding({ sourceRevision: 43 }),
    }),
    { code: 'session_binding_mismatch' },
  );
});

test('continuation fails closed for missing and expired sessions', async (t) => {
  const { authority, now } = await fixture(t);
  await assert.rejects(
    authority.continueSession({
      sessionId: `pgss_${'z'.repeat(32)}`,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_not_found' },
  );

  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);
  now.value += 60_001;
  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_expired' },
  );
});

test('an active session lease is exclusive', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_conflict' },
  );
});

test('lease age never permits a second writer while the owning process is alive', async (t) => {
  const { authority, now } = await fixture(t, {
    leaseMs: 1000,
    processId: 111,
    isProcessAlive: async (pid) => pid === 111,
  });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  now.value += 1001;

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_conflict' },
  );
});

test('a dead process lease can be reclaimed without losing session work', async (t) => {
  const { authority, options } = await fixture(t, {
    processId: 111,
    isProcessAlive: async (pid) => pid !== 111,
  });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(created.workerHandle.databasePath, 'committed sweep');

  const restarted = await createPgsSessionAuthority({
    ...options,
    processId: 222,
    isProcessAlive: async () => false,
  });
  const continued = await restarted.continueSession({
    sessionId: created.sessionId,
    ownerAgent: 'jerry',
    sourceOperationId: OPERATION_A,
    operationId: OPERATION_B,
    binding: binding(),
  });

  assert.equal(await fsp.readFile(continued.workerHandle.databasePath, 'utf8'), 'committed sweep');
  assert.notEqual(continued.workerHandle.leaseId, created.workerHandle.leaseId);
});

test('continuation rejects replacement of the captured session directory', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);
  const displaced = `${created.workerHandle.sessionRoot}.displaced`;
  await fsp.rename(created.workerHandle.sessionRoot, displaced);
  await fsp.mkdir(created.workerHandle.sessionRoot, { mode: 0o700 });
  await fsp.copyFile(
    path.join(displaced, 'session.sqlite'),
    path.join(created.workerHandle.sessionRoot, 'session.sqlite'),
  );

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_state_invalid' },
  );
});

test('continuation rejects a symlinked session database without following it', async (t) => {
  const { authority, agentRuntimeRoot } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);
  const outside = path.join(agentRuntimeRoot, 'outside.sqlite');
  await fsp.writeFile(outside, 'must remain untouched');
  await fsp.unlink(created.workerHandle.databasePath);
  await fsp.symlink(outside, created.workerHandle.databasePath);

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_state_invalid' },
  );
  assert.equal(await fsp.readFile(outside, 'utf8'), 'must remain untouched');
});

test('continuation rejects a hard-linked session database', async (t) => {
  const { authority, agentRuntimeRoot } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);
  const outsideLink = path.join(agentRuntimeRoot, 'database-hard-link.sqlite');
  await fsp.link(created.workerHandle.databasePath, outsideLink);

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_state_invalid' },
  );
});

test('worker handles are revalidated against the active lease and exact file identities', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  const trusted = await authority.validateWorkerHandle(created.workerHandle, {
    ownerAgent: 'jerry',
    operationId: OPERATION_A,
  });
  assert.equal(trusted.databasePath, created.workerHandle.databasePath);

  await assert.rejects(
    authority.validateWorkerHandle({
      ...created.workerHandle,
      databasePath: `${created.workerHandle.databasePath}.caller-selected`,
    }, {
      ownerAgent: 'jerry',
      operationId: OPERATION_A,
    }),
    { code: 'session_capability_invalid' },
  );

  const displaced = `${created.workerHandle.databasePath}.displaced`;
  await fsp.rename(created.workerHandle.databasePath, displaced);
  await fsp.writeFile(created.workerHandle.databasePath, 'replacement');
  await assert.rejects(
    authority.validateWorkerHandle(created.workerHandle, {
      ownerAgent: 'jerry',
      operationId: OPERATION_A,
    }),
    { code: 'session_state_invalid' },
  );
});

test('opens a trusted session-storage capability with verify, quota, and close hooks', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });

  const storage = await authority.openSessionStorage(created.workerHandle, {
    ownerAgent: 'jerry',
    operationId: OPERATION_A,
  });

  assert.equal(storage.sessionId, created.sessionId);
  assert.equal(storage.databasePath, created.workerHandle.databasePath);
  assert.equal(storage.quotaMaxBytes, 1024 * 1024);
  assert.equal((await storage.verify()).sessionId, created.sessionId);
  assert.equal((await storage.reconcileQuota()).sessionId, created.sessionId);
  assert.deepEqual(await storage.markProjectionUsable(), {
    marked: true,
    sessionId: created.sessionId,
  });
  assert.deepEqual(await storage.close(), { released: true, sessionId: created.sessionId });
  assert.deepEqual(await storage.close(), { released: false, sessionId: created.sessionId });
  await assert.rejects(storage.verify(), { code: 'session_capability_closed' });
});

test('closing a fresh session before its projection is usable discards only that exact session', async (t) => {
  const { authority, agentRuntimeRoot } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  const storage = await authority.openSessionStorage(created.workerHandle, {
    ownerAgent: 'jerry', operationId: OPERATION_A,
  });
  await fsp.writeFile(created.workerHandle.databasePath, Buffer.alloc(71));
  const outside = path.join(agentRuntimeRoot, 'preserve.txt');
  await fsp.writeFile(outside, 'preserve');

  const result = await storage.close();

  assert.deepEqual(result, {
    discarded: true,
    reclaimedBytes: result.reclaimedBytes,
    sessionId: created.sessionId,
  });
  assert.equal(result.reclaimedBytes >= 71, true);
  await assert.rejects(fsp.lstat(created.workerHandle.sessionRoot), { code: 'ENOENT' });
  await assert.rejects(
    fsp.lstat(path.join(
      agentRuntimeRoot, 'pgs-sessions', `${created.sessionId}.authority.json`,
    )),
    { code: 'ENOENT' },
  );
  assert.equal(await fsp.readFile(outside, 'utf8'), 'preserve');
});

test('usable fresh and every continuation close by releasing the lease without discarding state', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  const freshStorage = await authority.openSessionStorage(created.workerHandle, {
    ownerAgent: 'jerry', operationId: OPERATION_A,
  });
  assert.deepEqual(await freshStorage.markProjectionUsable(), {
    marked: true,
    sessionId: created.sessionId,
  });
  await assert.rejects(
    authority.discardUnusableSession(created.workerHandle),
    { code: 'session_discard_denied' },
  );
  assert.equal((await fsp.stat(created.workerHandle.databasePath)).isFile(), true);
  assert.deepEqual(await freshStorage.close(), { released: true, sessionId: created.sessionId });
  assert.equal((await fsp.stat(created.workerHandle.databasePath)).isFile(), true);

  const continued = await authority.continueSession({
    sessionId: created.sessionId,
    ownerAgent: 'jerry',
    sourceOperationId: OPERATION_A,
    operationId: OPERATION_B,
    binding: binding(),
  });
  const continuedStorage = await authority.openSessionStorage(continued.workerHandle, {
    ownerAgent: 'jerry', operationId: OPERATION_B,
  });
  assert.deepEqual(await continuedStorage.close(), {
    released: true,
    sessionId: created.sessionId,
  });
  assert.equal((await fsp.stat(created.workerHandle.databasePath)).isFile(), true);
});

test('unusable fresh-session discard fails closed after database identity replacement', async (t) => {
  const { authority } = await fixture(t);
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  const storage = await authority.openSessionStorage(created.workerHandle, {
    ownerAgent: 'jerry', operationId: OPERATION_A,
  });
  await fsp.rename(created.workerHandle.databasePath, `${created.workerHandle.databasePath}.old`);
  await fsp.writeFile(created.workerHandle.databasePath, 'replacement');

  await assert.rejects(storage.close(), { code: 'session_state_invalid' });
  assert.equal(await fsp.readFile(created.workerHandle.databasePath, 'utf8'), 'replacement');
});

test('writer capacity is capped by remaining house headroom without reserving inactive sessions', async (t) => {
  const { authority } = await fixture(t, {
    maxSessionBytes: 800,
    maxTotalBytes: 1000,
  });
  const retained = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(retained.workerHandle.databasePath, Buffer.alloc(600));
  await authority.releaseLease(retained.workerHandle);

  const constrained = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding(),
  });
  assert.equal(constrained.workerHandle.quotaMaxBytes, 400);
  const storage = await authority.openSessionStorage(constrained.workerHandle, {
    ownerAgent: 'jerry', operationId: OPERATION_B,
  });
  assert.equal(storage.quotaMaxBytes, 400);

  await assert.rejects(
    authority.createSession({
      ownerAgent: 'jerry', operationId: OPERATION_C, binding: binding(),
    }),
    { code: 'session_quota_exceeded' },
  );
  await storage.close();

  const reusedHeadroom = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_C, binding: binding(),
  });
  assert.equal(reusedHeadroom.workerHandle.quotaMaxBytes, 400);
});

test('concurrent creates reserve house capacity once and leave no failed-session residue', async (t) => {
  const { authority, agentRuntimeRoot } = await fixture(t, {
    maxSessionBytes: 800,
    maxTotalBytes: 800,
  });

  const settled = await Promise.allSettled([
    authority.createSession({
      ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
    }),
    authority.createSession({
      ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding(),
    }),
  ]);

  const fulfilled = settled.filter(({ status }) => status === 'fulfilled');
  const rejected = settled.filter(({ status }) => status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'session_quota_exceeded');
  assert.equal(fulfilled[0].value.workerHandle.quotaMaxBytes, 800);
  const entries = await fsp.readdir(path.join(agentRuntimeRoot, 'pgs-sessions'));
  assert.deepEqual(entries.sort(), [
    fulfilled[0].value.sessionId,
    `${fulfilled[0].value.sessionId}.authority.json`,
  ].sort());
});

test('new session admission automatically reclaims expired retained quota', async (t) => {
  const { authority, now, agentRuntimeRoot } = await fixture(t, {
    retentionMs: 1000,
    maxSessionBytes: 800,
    maxTotalBytes: 800,
  });
  const expired = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(expired.workerHandle.databasePath, Buffer.alloc(800));
  await authority.releaseLease(expired.workerHandle);
  now.value += 1001;

  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding(),
  });

  assert.equal(created.workerHandle.quotaMaxBytes, 800);
  await assert.rejects(fsp.lstat(expired.workerHandle.sessionRoot), { code: 'ENOENT' });
  const entries = await fsp.readdir(path.join(agentRuntimeRoot, 'pgs-sessions'));
  assert.deepEqual(entries.sort(), [
    created.sessionId,
    `${created.sessionId}.authority.json`,
  ].sort());
});

test('continuation admission automatically reclaims other expired retained quota', async (t) => {
  const { authority, now } = await fixture(t, {
    retentionMs: 1000,
    maxSessionBytes: 800,
    maxTotalBytes: 1000,
  });
  const expired = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(expired.workerHandle.databasePath, Buffer.alloc(800));
  await authority.releaseLease(expired.workerHandle);
  now.value += 500;
  const retained = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding(),
  });
  await fsp.writeFile(retained.workerHandle.databasePath, Buffer.alloc(100));
  await authority.releaseLease(retained.workerHandle);
  now.value += 501;

  const continued = await authority.continueSession({
    sessionId: retained.sessionId,
    ownerAgent: 'jerry',
    sourceOperationId: OPERATION_B,
    operationId: OPERATION_C,
    binding: binding(),
  });

  assert.equal(continued.workerHandle.quotaMaxBytes, 800);
  await assert.rejects(fsp.lstat(expired.workerHandle.sessionRoot), { code: 'ENOENT' });
  assert.equal((await fsp.stat(retained.workerHandle.databasePath)).size, 100);
});

test('quota reconciliation counts the database and every SQLite sidecar', async (t) => {
  const { authority } = await fixture(t, {
    maxSessionBytes: 1024,
    maxTotalBytes: 2048,
  });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(created.workerHandle.databasePath, Buffer.alloc(100));
  await fsp.writeFile(`${created.workerHandle.databasePath}-wal`, Buffer.alloc(200));
  await fsp.writeFile(`${created.workerHandle.databasePath}-shm`, Buffer.alloc(300));

  const quota = await authority.reconcileQuota();

  assert.deepEqual(quota, {
    maxSessionBytes: 1024,
    maxTotalBytes: 2048,
    totalBytes: 600,
    sessions: [{
      sessionId: created.sessionId,
      bytes: 600,
      overQuota: false,
    }],
  });
});

test('continuation refuses an over-quota session instead of starting a writer', async (t) => {
  const { authority } = await fixture(t, {
    maxSessionBytes: 512,
    maxTotalBytes: 2048,
  });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(created.workerHandle.databasePath, Buffer.alloc(513));
  await authority.releaseLease(created.workerHandle);

  await assert.rejects(
    authority.continueSession({
      sessionId: created.sessionId,
      ownerAgent: 'jerry',
      sourceOperationId: OPERATION_A,
      operationId: OPERATION_B,
      binding: binding(),
    }),
    { code: 'session_quota_exceeded' },
  );
});

test('cleanup removes only expired owned session files and reports reclaimed bytes', async (t) => {
  const { authority, now, agentRuntimeRoot } = await fixture(t, {
    retentionMs: 1000,
    cleanupBatchSize: 1,
  });
  const expired = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(expired.workerHandle.databasePath, Buffer.alloc(71));
  await fsp.writeFile(`${expired.workerHandle.databasePath}-wal`, Buffer.alloc(29));
  await authority.releaseLease(expired.workerHandle);
  now.value += 500;
  const live = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding(),
  });
  await fsp.writeFile(live.workerHandle.databasePath, Buffer.alloc(41));
  await authority.releaseLease(live.workerHandle);
  const outside = path.join(agentRuntimeRoot, 'not-session-state.txt');
  await fsp.writeFile(outside, 'preserve');
  now.value += 501;

  const cleanup = await authority.cleanupExpired();

  assert.deepEqual(cleanup.removedSessionIds, [expired.sessionId]);
  assert.equal(cleanup.removedSessions, 1);
  assert.equal(cleanup.reclaimedBytes >= 100, true);
  assert.equal(await fsp.readFile(outside, 'utf8'), 'preserve');
  assert.equal((await fsp.stat(live.workerHandle.databasePath)).isFile(), true);
  await assert.rejects(fsp.lstat(expired.workerHandle.sessionRoot), { code: 'ENOENT' });
});

test('cleanup refuses linked state and never follows it outside the session boundary', async (t) => {
  const { authority, now, agentRuntimeRoot } = await fixture(t, { retentionMs: 1000 });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);
  const outside = path.join(agentRuntimeRoot, 'outside-cleanup-target');
  await fsp.writeFile(outside, 'preserve me');
  await fsp.unlink(created.workerHandle.databasePath);
  await fsp.symlink(outside, created.workerHandle.databasePath);
  now.value += 1001;

  await assert.rejects(authority.cleanupExpired(), { code: 'session_state_invalid' });
  assert.equal(await fsp.readFile(outside, 'utf8'), 'preserve me');
});

test('cleanup skips an expired session while its writer process is still alive', async (t) => {
  const { authority, now } = await fixture(t, {
    retentionMs: 1000,
    leaseMs: 500,
    processId: 111,
    isProcessAlive: async (pid) => pid === 111,
  });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  now.value += 1001;

  const cleanup = await authority.cleanupExpired();

  assert.equal(cleanup.removedSessions, 0);
  assert.equal(cleanup.skippedActive, 1);
  assert.equal((await fsp.stat(created.workerHandle.databasePath)).isFile(), true);
});

test('authority startup and the unref hourly janitor reclaim expired lease-free sessions while idle', async (t) => {
  const janitor = fakeJanitorTimers();
  const first = await fixture(t, {
    retentionMs: 1000,
    janitorIntervalMs: 60 * 60 * 1000,
    timers: janitor.timers,
  });
  const expired = await first.authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(expired.workerHandle.databasePath, Buffer.alloc(73));
  await first.authority.releaseLease(expired.workerHandle);
  first.now.value += 1001;

  assert.deepEqual(janitor.status(), {
    interval: 60 * 60 * 1000,
    unrefCalls: 1,
    clearCalls: 0,
    armed: true,
  });
  await janitor.tick();
  await assert.rejects(fsp.lstat(expired.workerHandle.sessionRoot), { code: 'ENOENT' });

  const retained = await first.authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding(),
  });
  await first.authority.releaseLease(retained.workerHandle);
  first.now.value += 1001;
  await first.authority.stop();
  assert.equal(janitor.status().clearCalls, 1);
  await janitor.tick();
  assert.equal((await fsp.stat(retained.workerHandle.databasePath)).isFile(), true);

  const restartedJanitor = fakeJanitorTimers();
  const restarted = await createPgsSessionAuthority({
    ...first.options,
    timers: restartedJanitor.timers,
  });
  t.after(() => restarted.stop());
  await assert.rejects(fsp.lstat(retained.workerHandle.sessionRoot), { code: 'ENOENT' });
  assert.equal(restartedJanitor.status().unrefCalls, 1);
});

test('janitor reports a code-safe failure, retries, and clears stale health after success', async (t) => {
  const janitor = fakeJanitorTimers();
  const { authority, now } = await fixture(t, {
    retentionMs: 1000,
    janitorIntervalMs: 60 * 60 * 1000,
    timers: janitor.timers,
  });
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await authority.releaseLease(created.workerHandle);
  now.value += 1001;

  const authorityPath = path.join(
    path.dirname(created.workerHandle.sessionRoot),
    `${created.sessionId}.authority.json`,
  );
  const validAuthority = await fsp.readFile(authorityPath);
  await fsp.writeFile(authorityPath, '{');
  await janitor.tick();
  await fsp.writeFile(authorityPath, validAuthority);

  const failedStatus = await authority.storageStatus();
  assert.equal(failedStatus.janitorHealthy, false);
  assert.equal(failedStatus.lastJanitorErrorCode, 'session_state_invalid');
  assert.equal(JSON.stringify(failedStatus).includes(authorityPath), false);

  await janitor.tick();
  const recoveredStatus = await authority.storageStatus();
  assert.equal(recoveredStatus.janitorHealthy, true);
  assert.equal(recoveredStatus.lastJanitorErrorCode, null);
  await assert.rejects(fsp.lstat(created.workerHandle.sessionRoot), { code: 'ENOENT' });
  await authority.stop();
});

test('session storage telemetry is aggregate, bounded, and reports active and expiry state', async (t) => {
  const { authority, now } = await fixture(t, {
    maxSessionBytes: 1024,
    maxTotalBytes: 4096,
  });
  const active = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_A, binding: binding(),
  });
  await fsp.writeFile(active.workerHandle.databasePath, Buffer.alloc(100));
  now.value += 500;
  const retained = await authority.createSession({
    ownerAgent: 'jerry', operationId: OPERATION_B, binding: binding({ sourceRevision: 43 }),
  });
  await fsp.writeFile(retained.workerHandle.databasePath, Buffer.alloc(200));
  await authority.releaseLease(retained.workerHandle);

  assert.deepEqual(await authority.storageStatus(), {
    activeSessions: 1,
    headroomBytes: 3796,
    janitorHealthy: true,
    lastJanitorErrorCode: null,
    maxSessionBytes: 1024,
    maxTotalBytes: 4096,
    nextExpiry: active.continuableUntil,
    sessionCount: 2,
    totalBytes: 300,
  });
});
