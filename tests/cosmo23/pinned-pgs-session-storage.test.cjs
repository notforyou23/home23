'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const {
  createOperationScratchQuota,
} = require('../../shared/memory-source/scratch-quota.cjs');
const {
  openPinnedPGSStore,
} = require('../../cosmo23/pgs-engine/src/pinned-store');
const {
  createPgsSessionAuthority,
} = require('../../engine/src/dashboard/brain-operations/pgs-session-authority');
const {
  createEngine,
  limits: operationLimits,
  operationOptions,
  sourcePin,
} = require('./helpers/pinned-pgs-fixture.cjs');

const storeLimits = {
  maxScratchBytes: 64 * 1024 * 1024,
  minFreeScratchBytes: 1,
  maxTransactionRecords: 10,
  maxTransactionBytes: 1024 * 1024,
  maxNodesPerWorkUnit: 2,
  maxContextCharsPerWorkUnit: 4096,
  maxSelectedWorkUnits: 16,
};

async function operationScratch(root, operationId) {
  const operationRoot = path.join(
    root,
    'instances',
    'jerry',
    'runtime',
    'brain-operations',
    operationId,
  );
  const scratchDir = path.join(operationRoot, 'scratch');
  await fs.mkdir(scratchDir, { recursive: true });
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 64 * 1024 * 1024,
  });
  return { operationRoot, scratchDir, scratchQuota };
}

async function sessionFixture(t) {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-session-store-')),
  );
  const sessionRoot = path.join(root, 'instances', 'jerry', 'runtime', 'pgs-sessions', 'pgss-test');
  const databasePath = path.join(sessionRoot, 'session.sqlite');
  const anchorPath = `${sessionRoot}.authority.json`;
  const leasePath = path.join(sessionRoot, 'lease.json');
  await fs.mkdir(sessionRoot, { recursive: true });
  await fs.writeFile(databasePath, '');
  await fs.writeFile(anchorPath, 'authority-anchor\n');
  await fs.writeFile(leasePath, 'active-lease\n');
  const quotas = [];
  let verifies = 0;
  let closes = 0;
  let marks = 0;
  let closed = false;
  const sessionStorage = Object.freeze({
    databasePath,
    quotaMaxBytes: 64 * 1024 * 1024,
    async verify() {
      if (closed) throw Object.assign(new Error('closed'), { code: 'session_capability_closed' });
      verifies += 1;
      return { databasePath };
    },
    async reconcileQuota() {
      if (closed) throw Object.assign(new Error('closed'), { code: 'session_capability_closed' });
      const entries = await fs.readdir(sessionRoot);
      let bytes = 0;
      for (const entry of entries) {
        if (entry === 'lease.json') continue;
        bytes += Number((await fs.stat(path.join(sessionRoot, entry))).size);
      }
      quotas.push(bytes);
      if (bytes > 64 * 1024 * 1024) {
        throw Object.assign(new Error('quota exceeded'), { code: 'session_quota_exceeded' });
      }
      return { bytes };
    },
    async markProjectionUsable() {
      if (closed) throw Object.assign(new Error('closed'), { code: 'session_capability_closed' });
      marks += 1;
      return { marked: true };
    },
    async close() {
      closes += 1;
      closed = true;
      return { released: true };
    },
  });
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    sessionRoot,
    databasePath,
    anchorPath,
    leasePath,
    sessionStorage,
    counts: () => ({ verifies, quotas: quotas.length, closes, marks }),
  };
}

function storeOptions(source, scratch, sessionStorage, overrides = {}) {
  return {
    sourcePin: source,
    scratchDir: scratch.scratchDir,
    scratchQuota: scratch.scratchQuota,
    sessionStorage,
    pgsSweep: { provider: 'sweep', model: 'shared-model' },
    query: 'What does the pinned evidence show?',
    signal: new AbortController().signal,
    limits: storeLimits,
    ...overrides,
  };
}

test('initializes and reuses the authority database in place without a scratch copy', async (t) => {
  const session = await sessionFixture(t);
  const firstScratch = await operationScratch(session.root, 'brop-first');
  const secondScratch = await operationScratch(session.root, 'brop-second');
  t.after(() => firstScratch.scratchQuota.close());
  t.after(() => secondScratch.scratchQuota.close());
  const source = sourcePin({ nodeCount: 8 });

  const first = await openPinnedPGSStore(
    storeOptions(source, firstScratch, session.sessionStorage),
  );
  assert.equal(first.databasePath, session.databasePath);
  assert.equal(first.reused, false);
  assert.equal(session.counts().marks, 1);
  first.close();

  assert.deepEqual(await fs.readdir(firstScratch.scratchDir), []);
  assert.equal(await fs.readFile(session.anchorPath, 'utf8'), 'authority-anchor\n');
  assert.equal(await fs.readFile(session.leasePath, 'utf8'), 'active-lease\n');

  const second = await openPinnedPGSStore(
    storeOptions(source, secondScratch, session.sessionStorage),
  );
  assert.equal(second.databasePath, session.databasePath);
  assert.equal(second.reused, true);
  assert.equal(session.counts().marks, 2);
  second.close();

  assert.deepEqual(await fs.readdir(secondScratch.scratchDir), []);
  assert.equal(session.counts().verifies > 2, true);
  assert.equal(session.counts().quotas > 2, true);
});

test('does not mark a fresh session usable when initial projection construction fails', async (t) => {
  const session = await sessionFixture(t);
  const scratch = await operationScratch(session.root, 'brop-projection-failure');
  t.after(() => scratch.scratchQuota.close());
  const base = sourcePin({ nodeCount: 8 });
  const marker = Object.assign(new Error('source failed during projection'), {
    code: 'source_unavailable',
  });
  const source = {
    ...base,
    async *iterateNodes() {
      yield { id: 'n-before-failure', concept: 'partial projection' };
      throw marker;
    },
  };

  await assert.rejects(
    openPinnedPGSStore(storeOptions(source, scratch, session.sessionStorage)),
    error => error === marker,
  );
  assert.equal(session.counts().marks, 0);
});

test('reuse-only continuation rejects an empty session database without reading live source', async (t) => {
  const session = await sessionFixture(t);
  const scratch = await operationScratch(session.root, 'brop-reuse-only-empty');
  t.after(() => scratch.scratchQuota.close());
  let iterated = false;
  const base = sourcePin({ nodeCount: 8 });
  const source = {
    ...base,
    async *iterateNodes() {
      iterated = true;
      yield* base.iterateNodes();
    },
    async *iterateEdges() {
      iterated = true;
      yield* base.iterateEdges();
    },
  };
  const reuseOnlyStorage = Object.freeze({
    ...session.sessionStorage,
    reuseOnly: true,
  });

  await assert.rejects(
    openPinnedPGSStore(storeOptions(source, scratch, reuseOnlyStorage)),
    { code: 'session_state_invalid' },
  );
  assert.equal(iterated, false);
  assert.equal(session.counts().marks, 0);
});

test('reuse-only continuation fails closed for missing, corrupt, or incomplete projections', async (t) => {
  const cases = [
    ['missing', async (databasePath) => fs.unlink(databasePath), 'session_state_invalid'],
    ['corrupt', async (databasePath) => fs.writeFile(databasePath, 'not sqlite'), 'pgs_projection_invalid'],
    ['incomplete', async (databasePath) => {
      const database = new Database(databasePath);
      database.prepare("UPDATE metadata SET value = 'false' WHERE key = 'completeProjection'").run();
      database.close();
    }, 'pgs_binding_mismatch'],
  ];
  for (const [label, mutate, expectedCode] of cases) {
    await t.test(label, async (subtest) => {
      const session = await sessionFixture(subtest);
      const scratch = await operationScratch(session.root, `brop-reuse-only-${label}`);
      subtest.after(() => scratch.scratchQuota.close());
      let iterated = false;
      const base = sourcePin({ nodeCount: 8 });
      const source = {
        ...base,
        async *iterateNodes() {
          iterated = true;
          yield* base.iterateNodes();
        },
        async *iterateEdges() {
          iterated = true;
          yield* base.iterateEdges();
        },
      };
      const initial = await openPinnedPGSStore(
        storeOptions(base, scratch, session.sessionStorage),
      );
      initial.close();
      await mutate(session.databasePath);
      const reuseOnlyStorage = Object.freeze({
        ...session.sessionStorage,
        reuseOnly: true,
      });

      await assert.rejects(
        openPinnedPGSStore(storeOptions(source, scratch, reuseOnlyStorage)),
        { code: expectedCode },
      );
      assert.equal(iterated, false);
    });
  }
});

test('failed initial projection discards the real fresh session but preserves operation scratch', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-session-discard-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentRuntimeRoot = path.join(root, 'instances', 'jerry', 'runtime');
  await fs.mkdir(agentRuntimeRoot, { recursive: true });
  const authority = await createPgsSessionAuthority({ agentRuntimeRoot, agentId: 'jerry' });
  t.after(() => authority.stop());
  const operationId = `brop_${'d'.repeat(32)}`;
  const created = await authority.createSession({
    ownerAgent: 'jerry', operationId, binding: { integration: 'failed-projection' },
  });
  const storage = await authority.openSessionStorage(created.workerHandle, {
    ownerAgent: 'jerry', operationId,
  });
  const scratch = await operationScratch(root, operationId);
  t.after(() => scratch.scratchQuota.close());
  const fixture = createEngine();
  const base = sourcePin({ nodeCount: 8 });
  const marker = Object.assign(new Error('source failed during projection'), {
    code: 'source_unavailable',
  });
  const source = {
    ...base,
    async *iterateNodes() {
      yield { id: 'n-before-failure', concept: 'partial projection' };
      throw marker;
    },
  };
  const options = operationOptions(source, {
    scratchDir: scratch.scratchDir,
    quota: scratch.scratchQuota,
  }, {
    sessionStorage: storage,
    limits: operationLimits,
  });

  await assert.rejects(fixture.engine.runPinnedOperation(options), error => error === marker);
  await assert.rejects(fs.lstat(created.workerHandle.sessionRoot), { code: 'ENOENT' });
  await assert.rejects(
    fs.lstat(path.join(
      agentRuntimeRoot, 'pgs-sessions', `${created.sessionId}.authority.json`,
    )),
    { code: 'ENOENT' },
  );
  assert.equal((await fs.stat(scratch.scratchDir)).isDirectory(), true);
});

test('cancelled and interrupted initialization discard only their fresh sessions', async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'home23-pgs-session-abort-discard-')),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const agentRuntimeRoot = path.join(root, 'instances', 'jerry', 'runtime');
  await fs.mkdir(agentRuntimeRoot, { recursive: true });
  const authority = await createPgsSessionAuthority({ agentRuntimeRoot, agentId: 'jerry' });
  t.after(() => authority.stop());

  for (const [index, code] of ['operation_cancelled', 'worker_stopped'].entries()) {
    const operationId = `brop_${String(index + 1).repeat(32)}`;
    const created = await authority.createSession({
      ownerAgent: 'jerry', operationId, binding: { integration: code },
    });
    const storage = await authority.openSessionStorage(created.workerHandle, {
      ownerAgent: 'jerry', operationId,
    });
    const scratch = await operationScratch(root, operationId);
    t.after(() => scratch.scratchQuota.close());
    const controller = new AbortController();
    const reason = Object.assign(new Error(code), { code });
    controller.abort(reason);
    const fixture = createEngine();
    const options = operationOptions(sourcePin({ nodeCount: 8 }), {
      scratchDir: scratch.scratchDir,
      quota: scratch.scratchQuota,
    }, {
      sessionStorage: storage,
      signal: controller.signal,
      limits: operationLimits,
    });

    await assert.rejects(fixture.engine.runPinnedOperation(options), error => error === reason);
    await assert.rejects(fs.lstat(created.workerHandle.sessionRoot), { code: 'ENOENT' });
    assert.equal((await fs.stat(scratch.scratchDir)).isDirectory(), true);
  }
});

test('authority database binding and schema mismatches fail closed without cleanup', async (t) => {
  const session = await sessionFixture(t);
  const scratch = await operationScratch(session.root, 'brop-mismatch');
  t.after(() => scratch.scratchQuota.close());
  const source = sourcePin({ nodeCount: 8 });
  const initial = await openPinnedPGSStore(storeOptions(source, scratch, session.sessionStorage));
  initial.close();
  const before = await fs.stat(session.databasePath);

  await assert.rejects(
    openPinnedPGSStore(storeOptions(source, scratch, session.sessionStorage, {
      query: 'A different query must not reuse sweeps',
    })),
    { code: 'pgs_binding_mismatch' },
  );
  assert.equal((await fs.stat(session.databasePath)).ino, before.ino);
  assert.equal(await fs.readFile(session.anchorPath, 'utf8'), 'authority-anchor\n');
  assert.equal(await fs.readFile(session.leasePath, 'utf8'), 'active-lease\n');

  const database = new Database(session.databasePath);
  database.prepare("UPDATE metadata SET value = '2' WHERE key = 'schemaVersion'").run();
  database.close();
  await assert.rejects(
    openPinnedPGSStore(storeOptions(source, scratch, session.sessionStorage)),
    { code: 'pgs_schema_unsupported' },
  );
  assert.equal((await fs.stat(session.databasePath)).ino, before.ino);
  assert.equal(await fs.readFile(session.anchorPath, 'utf8'), 'authority-anchor\n');
  assert.equal(await fs.readFile(session.leasePath, 'utf8'), 'active-lease\n');
});

test('runPinnedOperation releases session storage exactly once on every exit path', async (t) => {
  async function runCase(name, mutate) {
    const session = await sessionFixture(t);
    const scratch = await operationScratch(session.root, `brop-${name}`);
    t.after(() => scratch.scratchQuota.close());
    const fixture = createEngine();
    const controller = new AbortController();
    const options = operationOptions(sourcePin({ nodeCount: 4 }), {
      scratchDir: scratch.scratchDir,
      quota: scratch.scratchQuota,
    }, {
      sessionStorage: session.sessionStorage,
      signal: controller.signal,
      limits: operationLimits,
    });
    await mutate({ options, controller, fixture });
    assert.equal(session.counts().closes, 1, name);
  }

  await runCase('success', async ({ options, fixture }) => {
    const envelope = await fixture.engine.runPinnedOperation(options);
    assert.equal(envelope.state, 'complete');
  });
  await runCase('invalid', async ({ options, fixture }) => {
    options.query = '';
    await assert.rejects(fixture.engine.runPinnedOperation(options), { code: 'invalid_request' });
  });
  await runCase('cancelled', async ({ options, controller, fixture }) => {
    const reason = Object.assign(new Error('cancelled'), { code: 'operation_cancelled' });
    controller.abort(reason);
    await assert.rejects(fixture.engine.runPinnedOperation(options), error => error === reason);
  });
});
