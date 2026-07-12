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
    counts: () => ({ verifies, quotas: quotas.length, closes }),
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
  first.close();

  assert.deepEqual(await fs.readdir(firstScratch.scratchDir), []);
  assert.equal(await fs.readFile(session.anchorPath, 'utf8'), 'authority-anchor\n');
  assert.equal(await fs.readFile(session.leasePath, 'utf8'), 'active-lease\n');

  const second = await openPinnedPGSStore(
    storeOptions(source, secondScratch, session.sessionStorage),
  );
  assert.equal(second.databasePath, session.databasePath);
  assert.equal(second.reused, true);
  second.close();

  assert.deepEqual(await fs.readdir(secondScratch.scratchDir), []);
  assert.equal(session.counts().verifies > 2, true);
  assert.equal(session.counts().quotas > 2, true);
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
