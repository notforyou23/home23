import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const {
  ATTACHMENT_STATES,
  EXECUTION_STATES,
  INLINE_RESULT_LIMIT_BYTES,
  OPERATION_EVENT_MAX_BYTES,
  OPERATION_EVENT_MAX_COUNT,
  OPERATION_RESULT_ARTIFACT_MAX_BYTES,
  PUBLIC_RECORD_FIELDS,
  TERMINAL_STATES,
  buildBrainOperationIdempotencyKey,
} = require('../../../engine/src/dashboard/brain-operations/operation-contract.js');
const { BrainOperationStore } = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const { canonicalJson } = require('../../../shared/brain-operations/canonical-json.cjs');
const execFileAsync = promisify(execFile);

const DAY = 24 * 60 * 60 * 1000;
const INITIAL_NOW = Date.parse('2026-07-10T12:00:00.000Z');

function validMutationBoundaries(canonicalRoot) {
  return [
    { kind: 'brain', path: canonicalRoot },
    { kind: 'run', path: canonicalRoot },
    { kind: 'pgs', path: path.join(canonicalRoot, 'pgs-sessions') },
    { kind: 'session', path: path.join(canonicalRoot, 'sessions') },
    { kind: 'cache', path: path.join(canonicalRoot, 'cache') },
    { kind: 'export', path: path.join(canonicalRoot, 'exports') },
    { kind: 'agency', path: path.join(canonicalRoot, 'agency') },
  ];
}

function typedCode(code) {
  return (error) => error?.code === code;
}

function validTarget(overrides = {}) {
  const canonicalRoot = overrides.canonicalRoot ?? '/brains/jerry';
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot,
    accessMode: 'own',
    ownerAgent: 'jerry',
    displayName: 'jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: overrides.mutationBoundaries ?? validMutationBoundaries('/instances/jerry/brain'),
    ...overrides,
  };
}

function validOwnedRunTarget(overrides = {}) {
  return {
    domain: 'owned-run',
    runId: 'run-1',
    canonicalRoot: '/brains/runs/run-1',
    ownerAgent: 'jerry',
    runState: 'completed',
    catalogRevision: 'catalog-1',
    route: '/api/brains/runs/run-1',
    mutationBoundaries: validMutationBoundaries('/brains/runs/run-1'),
    ...overrides,
  };
}

function validRequesterTarget(overrides = {}) {
  return {
    domain: 'requester',
    requesterAgent: 'jerry',
    ...overrides,
  };
}

function validRequest(overrides = {}) {
  return {
    requestId: 'request-1',
    requesterAgent: 'jerry',
    target: validTarget(),
    operationType: 'query',
    requestParameters: { query: 'canary' },
    parameters: { query: 'canary' },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: true,
    ...overrides,
  };
}

function validDescriptor(overrides = {}) {
  return {
    version: 1,
    canonicalRoot: '/brains/jerry',
    generation: 'g1',
    sourceMode: 'memory_manifest',
    baseRevision: 1,
    cutoffRevision: 1,
    activeBase: {
      nodes: { file: 'memory-nodes.base-1.jsonl.gz', count: 12, bytes: 100 },
      edges: { file: 'memory-edges.base-1.jsonl.gz', count: 20, bytes: 200 },
    },
    activeDelta: {
      epoch: 'e1',
      file: 'memory-delta.e1.jsonl',
      fromRevision: 2,
      toRevision: 1,
      count: 0,
      committedBytes: 0,
    },
    summary: { nodeCount: 12, edgeCount: 20, clusterCount: 3 },
    ...overrides,
  };
}

function descriptorDigest(descriptor) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(descriptor)).digest('hex')}`;
}

function makeFixture(t, options = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'home23-brain-operation-store-')));
  const clock = { now: options.initialNow ?? INITIAL_NOW };
  const fixture = {
    root,
    clock,
    store: new BrainOperationStore({
      root,
      requesterAgent: 'jerry',
      now: () => clock.now,
      ...options,
    }),
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fixture;
}

function operationDirectory(root, operationId) {
  return path.join(root, 'operations', operationId);
}

function anotherStore(fixture, options = {}) {
  return new BrainOperationStore({
    root: fixture.root,
    requesterAgent: 'jerry',
    now: () => fixture.clock.now,
    ...options,
  });
}

function statusPath(root, operationId) {
  return path.join(operationDirectory(root, operationId), 'status.json');
}

function resultPath(root, operationId) {
  return path.join(operationDirectory(root, operationId), 'result.json');
}

async function createOne(fixture, overrides = {}) {
  return fixture.store.create(validRequest(overrides));
}

async function startLockHolder(t, targetPath, lockPath, holdMs) {
  const childSource = `
    const lockfile = require(process.env.LOCK_MODULE);
    (async () => {
      const release = await lockfile.lock(process.env.TARGET_PATH, {
        realpath: false,
        lockfilePath: process.env.LOCK_PATH,
        stale: 30000,
        update: 5000,
        retries: 0,
      });
      process.stdout.write('LOCKED\\n');
      setTimeout(async () => {
        await release();
        process.exit(0);
      }, Number(process.env.HOLD_MS));
    })().catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exit(2);
    });
  `;
  const child = spawn(process.execPath, ['-e', childSource], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCK_MODULE: require.resolve('proper-lockfile'),
      TARGET_PATH: targetPath,
      LOCK_PATH: lockPath,
      HOLD_MS: String(holdMs),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.includes('LOCKED\n')) resolve();
    });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!stdout.includes('LOCKED\n')) {
        reject(new Error(`lock holder exited before ready: ${code}/${signal}: ${stderr}`));
      }
    });
  });
  return child;
}

async function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, 'exit');
}

function listFilesRecursive(root) {
  if (!fs.existsSync(root)) return [];
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else files.push(fullPath);
    }
  };
  visit(root);
  return files;
}

async function crashArtifactAdoption(root, operationId, input, crashStage) {
  const childSource = `
    const { BrainOperationStore } = require(process.env.STORE_MODULE);
    const input = JSON.parse(process.env.ADOPTION_INPUT);
    const store = new BrainOperationStore({
      root: process.env.STORE_ROOT,
      requesterAgent: 'jerry',
      crashInjector: async (stage) => {
        if (stage === process.env.CRASH_STAGE) process.kill(process.pid, 'SIGKILL');
      },
    });
    store.adoptResultArtifact(process.env.OPERATION_ID, input)
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(String(error && error.stack || error));
        process.exit(2);
      });
  `;
  await assert.rejects(
    () => execFileAsync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      timeout: 10_000,
      env: {
        ...process.env,
        STORE_MODULE: path.resolve('engine/src/dashboard/brain-operations/operation-store.js'),
        STORE_ROOT: root,
        OPERATION_ID: operationId,
        ADOPTION_INPUT: JSON.stringify(input),
        CRASH_STAGE: crashStage,
      },
    }),
    (error) => error?.signal === 'SIGKILL',
  );
}

async function crashJsonResult(root, operationId, expectedVersion, result, crashStage) {
  const childSource = `
    const { BrainOperationStore } = require(process.env.STORE_MODULE);
    const store = new BrainOperationStore({
      root: process.env.STORE_ROOT,
      requesterAgent: 'jerry',
      crashInjector: async (stage) => {
        if (stage === process.env.CRASH_STAGE) process.kill(process.pid, 'SIGKILL');
      },
    });
    store.setResult(process.env.OPERATION_ID, {
      expectedVersion: Number(process.env.EXPECTED_VERSION),
      result: JSON.parse(process.env.RESULT_JSON),
    }).then(() => process.exit(0)).catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exit(2);
    });
  `;
  await assert.rejects(
    () => execFileAsync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      timeout: 10_000,
      env: {
        ...process.env,
        STORE_MODULE: path.resolve('engine/src/dashboard/brain-operations/operation-store.js'),
        STORE_ROOT: root,
        OPERATION_ID: operationId,
        EXPECTED_VERSION: String(expectedVersion),
        RESULT_JSON: JSON.stringify(result),
        CRASH_STAGE: crashStage,
      },
    }),
    (error) => error?.signal === 'SIGKILL',
  );
}

async function crashCollectGarbage(root, now, crashStage) {
  const childSource = `
    const { BrainOperationStore } = require(process.env.STORE_MODULE);
    const store = new BrainOperationStore({
      root: process.env.STORE_ROOT,
      requesterAgent: 'jerry',
      now: () => Number(process.env.NOW_MS),
      crashInjector: async (stage) => {
        if (stage === process.env.CRASH_STAGE) process.kill(process.pid, 'SIGKILL');
      },
    });
    store.collectGarbage().then(() => process.exit(0)).catch((error) => {
      process.stderr.write(String(error && error.stack || error));
      process.exit(2);
    });
  `;
  await assert.rejects(
    () => execFileAsync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      timeout: 10_000,
      env: {
        ...process.env,
        STORE_MODULE: path.resolve('engine/src/dashboard/brain-operations/operation-store.js'),
        STORE_ROOT: root,
        NOW_MS: String(now),
        CRASH_STAGE: crashStage,
      },
    }),
    (error) => error?.signal === 'SIGKILL',
  );
}

function ageCrashLocks(root, operationId) {
  for (const lockPath of [
    path.join(operationDirectory(root, operationId), '.operation.lock'),
    path.join(root, 'result-handles', '.index.lock'),
    path.join(root, 'idempotency', '.index.lock'),
  ]) {
    if (fs.existsSync(lockPath)) fs.utimesSync(lockPath, new Date(0), new Date(0));
  }
}

test('operation contract fixes canonical states, bounds, and deterministic idempotency', () => {
  assert.deepEqual(EXECUTION_STATES, [
    'queued', 'running', 'complete', 'partial', 'failed', 'cancelled', 'interrupted',
  ]);
  assert.deepEqual([...TERMINAL_STATES], ['complete', 'partial', 'failed', 'cancelled', 'interrupted']);
  assert.deepEqual(ATTACHMENT_STATES, ['attached', 'detached', 'closed']);
  assert.equal(INLINE_RESULT_LIMIT_BYTES, 64 * 1024);
  assert.equal(OPERATION_EVENT_MAX_COUNT, 4096);
  assert.equal(OPERATION_EVENT_MAX_BYTES, 8 * 1024 * 1024);
  assert.equal(OPERATION_RESULT_ARTIFACT_MAX_BYTES, 2 * 1024 * 1024 * 1024);

  const key = buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query');
  assert.match(key, /^sha256:[a-f0-9]{64}$/);
  assert.equal(key, buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query'));
  assert.notEqual(key, buildBrainOperationIdempotencyKey('jerry', 'request-2', 'query'));

  for (const bad of [
    '', ' '.repeat(2), 'x'.repeat(257), 7, null, 'a/b', 'a\\b', 'a\0b', '..',
    'a\u2215b', 'a\u2044b', 'a\uff0fb', 'a\uff3cb', 'é',
  ]) {
    assert.throws(
      () => buildBrainOperationIdempotencyKey(bad, 'request-1', 'query'),
      typedCode('identifier_invalid'),
      String(bad),
    );
    assert.throws(
      () => buildBrainOperationIdempotencyKey('jerry', bad, 'query'),
      typedCode('identifier_invalid'),
      String(bad),
    );
    assert.throws(
      () => buildBrainOperationIdempotencyKey('jerry', 'request-1', bad),
      typedCode('identifier_invalid'),
      String(bad),
    );
  }
});

test('invalid identifiers, caller IDs, and non-JSON input fail before filesystem artifacts', async (t) => {
  const fixture = makeFixture(t);
  const cyclic = {};
  cyclic.self = cyclic;
  const withGetter = {};
  Object.defineProperty(withGetter, 'query', {
    enumerable: true,
    get() { throw new Error('must not execute'); },
  });
  const cases = [
    validRequest({ requestId: '' }),
    validRequest({ requestId: 'x'.repeat(257) }),
    validRequest({ requesterAgent: 'jerry/../../forrest' }),
    validRequest({ operationType: 'query\\other' }),
    validRequest({ operationId: 'brop_caller_supplied' }),
    validRequest({ requestParameters: cyclic, parameters: {} }),
    validRequest({ requestParameters: { value: Number.NaN }, parameters: {} }),
    validRequest({ requestParameters: { value: 1n }, parameters: {} }),
    validRequest({ requestParameters: withGetter, parameters: {} }),
    validRequest({ requestParameters: {}, parameters: { callback() {} } }),
    validRequest({ sourcePinDescriptor: validDescriptor(), sourcePinDigest: 'sha256:' + 'a'.repeat(64) }),
  ];
  for (const input of cases) {
    await assert.rejects(() => fixture.store.create(input));
    assert.deepEqual(fs.readdirSync(fixture.root), [], JSON.stringify(Object.keys(input)));
  }
});

test('target union requires exact public snapshots and seven canonical mutation boundaries', async (t) => {
  const invalidFixture = makeFixture(t);
  const brainRequired = [
    'domain', 'brainId', 'canonicalRoot', 'accessMode', 'ownerAgent', 'displayName',
    'kind', 'lifecycle', 'catalogRevision', 'route', 'mutationBoundaries',
  ];
  const ownedRequired = [
    'domain', 'runId', 'canonicalRoot', 'ownerAgent', 'runState', 'catalogRevision',
    'route', 'mutationBoundaries',
  ];
  const invalidTargets = [];
  for (const key of brainRequired) {
    const target = structuredClone(validTarget());
    delete target[key];
    invalidTargets.push(target);
  }
  for (const key of ownedRequired) {
    const target = structuredClone(validOwnedRunTarget());
    delete target[key];
    invalidTargets.push(target);
  }
  invalidTargets.push(
    validTarget({ counts: { nodes: 1 } }),
    validTarget({ projectionRoot: '/private/projection' }),
    validTarget({ lockRoot: '/private/lock' }),
    validTarget({ accessMode: 'write' }),
    validTarget({ kind: 'unknown' }),
    validTarget({ lifecycle: 'active' }),
    validTarget({ displayName: 42 }),
    validTarget({ route: 'api/brain/brain-jerry' }),
    validTarget({ route: '/api/brain/../private' }),
    validTarget({ mutationBoundaries: 'not-an-array' }),
    validTarget({ mutationBoundaries: validTarget().mutationBoundaries.slice(0, 6) }),
    validTarget({
      mutationBoundaries: [
        ...validTarget().mutationBoundaries,
        { kind: 'private', path: '/private/path' },
      ],
    }),
    validTarget({
      mutationBoundaries: validTarget().mutationBoundaries.map((boundary, index) =>
        index === 1 ? { ...boundary, kind: 'brain' } : boundary),
    }),
    validTarget({
      mutationBoundaries: validTarget().mutationBoundaries.map((boundary, index) =>
        index === 0 ? { ...boundary, path: 'relative/path' } : boundary),
    }),
    validTarget({
      mutationBoundaries: validTarget().mutationBoundaries.map((boundary, index) =>
        index === 0 ? { ...boundary, path: '/instances/jerry/brain/../private' } : boundary),
    }),
    validTarget({
      mutationBoundaries: validTarget().mutationBoundaries.map((boundary, index) =>
        index === 0 ? { ...boundary, projectionRoot: '/private' } : boundary),
    }),
    validOwnedRunTarget({ operationRoot: '/private/operation' }),
    validOwnedRunTarget({ runState: null }),
    validOwnedRunTarget({ runState: 'archived' }),
    validRequesterTarget({ route: '/private/requester' }),
    validRequesterTarget({ requesterAgent: 'forrest' }),
  );
  for (let index = 0; index < invalidTargets.length; index += 1) {
    await assert.rejects(
      () => invalidFixture.store.create(validRequest({
        requestId: `target-invalid-${index}`,
        target: invalidTargets[index],
      })),
      typedCode('target_invalid'),
      String(index),
    );
    assert.deepEqual(fs.readdirSync(invalidFixture.root), []);
  }

  const validFixture = makeFixture(t);
  const shuffled = validTarget({
    mutationBoundaries: [...validTarget().mutationBoundaries].reverse(),
  });
  const brain = await createOne(validFixture, { requestId: 'target-exact-brain', target: shuffled });
  assert.deepEqual(brain.record.target.mutationBoundaries.map(({ kind }) => kind), [
    'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
  ]);
  assert.deepEqual(
    Object.keys(brain.record.target).sort(),
    [...brainRequired].sort(),
  );
  const readOnly = await createOne(validFixture, {
    requestId: 'target-exact-read-only',
    target: validTarget({ accessMode: 'read-only', ownerAgent: null }),
  });
  assert.equal(readOnly.record.target.ownerAgent, null);
  const owned = await createOne(validFixture, {
    requestId: 'target-exact-owned',
    target: validOwnedRunTarget(),
  });
  assert.deepEqual(Object.keys(owned.record.target).sort(), [...ownedRequired].sort());
  const requester = await createOne(validFixture, {
    requestId: 'target-exact-requester',
    target: validRequesterTarget(),
  });
  assert.deepEqual(requester.record.target, validRequesterTarget());
});

test('persisted target snapshot drift outside the exact union fails operation_corrupt on reload', async (t) => {
  const mutations = [
    (target) => { delete target.displayName; },
    (target) => { target.projectionRoot = '/private/projection'; },
    (target) => { target.mutationBoundaries[0].path = 'relative/path'; },
    (target) => { target.mutationBoundaries[1].kind = 'brain'; },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `persisted-target-${index}` });
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const privateRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    mutations[index](privateRecord.target);
    fs.writeFileSync(recordPath, JSON.stringify(privateRecord));
    await assert.rejects(
      () => anotherStore(fixture).get(created.record.operationId),
      typedCode('operation_corrupt'),
      String(index),
    );
  }
});

test('persisted private record schema drift fails closed before public projection', async (t) => {
  const mutations = [
    (record) => { record.parameters = 'not-an-object'; },
    (record) => { record.canonicalEvidence = 'yes'; },
    (record) => { record.phase = '/tmp/private-phase'; },
    (record) => { record.resultArtifact = { arbitrary: '/tmp/private' }; },
    (record) => { delete record.startedAt; },
    (record) => { record.privatePath = '/tmp/private'; },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `persisted-private-${index}` });
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const privateRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    mutations[index](privateRecord);
    fs.writeFileSync(recordPath, JSON.stringify(privateRecord));
    await assert.rejects(
      () => anotherStore(fixture).get(created.record.operationId),
      typedCode('operation_corrupt'),
      String(index),
    );
  }
});

test('phase events reject private paths and path-like phases before public status', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'phase-event-validation' });
  await assert.rejects(
    () => fixture.store.appendEvent(created.record.operationId, {
      type: 'phase',
      phase: '/private/worker/scratch',
      scratchPath: '/private/also-event',
    }),
    typedCode('event_invalid'),
  );
  const committed = await fixture.store.appendEvent(created.record.operationId, {
    type: 'phase',
    phase: 'source-open',
  });
  assert.equal(committed.phase, 'source-open');
  assert.deepEqual(
    (await fixture.store.readEvents(created.record.operationId, 0)).map((event) => event.phase),
    ['source-open'],
  );
});

test('top-level Proxy input is rejected without invoking ownKeys or property traps', async (t) => {
  const fixture = makeFixture(t);
  let traps = 0;
  const proxy = new Proxy(validRequest(), {
    ownKeys() { traps += 1; throw new Error('ownKeys must not run'); },
    get() { traps += 1; throw new Error('get must not run'); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('descriptor must not run'); },
  });
  await assert.rejects(() => fixture.store.create(proxy), typedCode('request_invalid'));
  assert.equal(traps, 0);
  assert.deepEqual(fs.readdirSync(fixture.root), []);
});

test('configured root under a persistent parent symlink is rejected before writes', (t) => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'home23-store-root-symlink-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const realParent = path.join(base, 'real-parent');
  const linkedParent = path.join(base, 'linked-parent');
  fs.mkdirSync(realParent);
  fs.symlinkSync(realParent, linkedParent);
  assert.throws(() => new BrainOperationStore({
    root: path.join(linkedParent, 'brain-operations'),
    requesterAgent: 'jerry',
  }), typedCode('store_configuration_invalid'));
  assert.deepEqual(fs.readdirSync(realParent), []);
});

test('operation and attachment path-like identifiers are exhaustively rejected without artifacts', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'identifier-methods' });
  const invalid = [
    '', '.', '..', '../outside', 'a/b', 'a\\b', 'a\0b', 'a\u2215b', 'a\u2044b',
    'a\uff0fb', 'a\uff3cb', 'line\nbreak', 'é', 'x'.repeat(257), 7, null,
  ];
  const rootBefore = fs.readdirSync(fixture.root).sort();
  for (const value of invalid) {
    await assert.rejects(() => fixture.store.get(value));
    await assert.rejects(() => fixture.store.appendEvent(value, { type: 'heartbeat' }));
    await assert.rejects(() => fixture.store.openAttachment(record.operationId, value));
    assert.deepEqual(fs.readdirSync(fixture.root).sort(), rootBefore, String(value));
    assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, record.operationId), 'attachments')), false);
  }
});

test('32 concurrent creates produce one random operation and stable drift is idempotent', async (t) => {
  const fixture = makeFixture(t);
  const concurrent = await Promise.all(
    Array.from({ length: 32 }, () => fixture.store.create(validRequest())),
  );
  assert.equal(concurrent.filter(({ created }) => created).length, 1);
  assert.equal(new Set(concurrent.map(({ record }) => record.operationId)).size, 1);
  const first = concurrent[0].record;
  assert.match(first.operationId, /^brop_[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.operationId, first.requestId);
  assert.equal(first.state, 'queued');
  assert.equal(first.recordVersion, 1);
  assert.equal(first.eventSequence, 0);
  assert.equal(Object.hasOwn(first, '_idempotencyKey'), false);
  assert.equal(Object.hasOwn(first, '_requestFingerprint'), false);

  const duplicate = await fixture.store.create(validRequest());
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.record.operationId, first.operationId);
  assert.equal((await fixture.store.list()).length, 1);

  const drift = await fixture.store.create(validRequest({
    target: validTarget({
      displayName: 'renamed display only',
      catalogRevision: 'catalog-2',
      lifecycle: 'completed',
      mutationBoundaries: validTarget().mutationBoundaries.map((row) => ({ ...row })),
    }),
  }));
  assert.equal(drift.created, false);
  assert.equal(drift.record.operationId, first.operationId);
  assert.equal(drift.record.target.displayName, 'jerry');

  await assert.rejects(() => fixture.store.create(validRequest({
    target: validTarget({
      brainId: 'brain-forrest',
      canonicalRoot: '/brains/forrest',
      accessMode: 'read-only',
      ownerAgent: 'forrest',
      mutationBoundaries: validMutationBoundaries('/brains/forrest'),
    }),
  })), typedCode('idempotency_conflict'));
  await assert.rejects(() => fixture.store.create(validRequest({
    requestParameters: { query: 'different' },
    parameters: { query: 'different' },
  })), typedCode('idempotency_conflict'));
  assert.equal(fs.readdirSync(path.join(fixture.root, 'operations'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).length, 1);
});

test('public projections are exact while idempotency, worker, result-kind, and journal recovery fields stay private', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'projection-private' });
  const worker = await fixture.store.setWorker(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    worker: { workerId: 'private-worker', route: '/internal/private-worker' },
  });
  for (const record of [created.record, worker, await fixture.store.get(created.record.operationId), ...(await fixture.store.list())]) {
    assert.deepEqual(Object.keys(record).sort(), [...PUBLIC_RECORD_FIELDS].sort());
    assert.equal(JSON.stringify(record).includes('private-worker'), false);
    assert.equal(JSON.stringify(record).includes('_idempotencyKey'), false);
    assert.equal(JSON.stringify(record).includes(fixture.root), false);
  }
  const privateRecord = JSON.parse(fs.readFileSync(statusPath(fixture.root, created.record.operationId), 'utf8'));
  assert.match(privateRecord._idempotencyKey, /^sha256:[a-f0-9]{64}$/);
  assert.match(privateRecord._requestFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(privateRecord._worker, { workerId: 'private-worker', route: '/internal/private-worker' });
  assert.equal(privateRecord._resultKind, null);
  assert.equal(typeof privateRecord._eventBytes, 'number');
});

test('independent store instances serialize create, events, pin, worker, result, and terminal races', async (t) => {
  const fixture = makeFixture(t);
  const other = anotherStore(fixture);
  const starts = await Promise.all(Array.from({ length: 24 }, (_, index) =>
    (index % 2 ? fixture.store : other).create(validRequest())));
  assert.equal(starts.filter((row) => row.created).length, 1);
  const operationId = starts[0].record.operationId;

  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    (index % 2 ? fixture.store : other).appendEvent(operationId, {
      type: 'progress', index,
    })));
  const afterEvents = await fixture.store.get(operationId);
  assert.equal(afterEvents.eventSequence, 40);
  assert.equal(afterEvents.recordVersion, 41);
  assert.deepEqual((await other.readEvents(operationId, 0)).map((row) => row.sequence),
    Array.from({ length: 40 }, (_, index) => index + 1));

  const pinOperation = await createOne(fixture, { requestId: 'multi-instance-pin' });
  const descriptor = validDescriptor();
  const pinRows = await Promise.all([
    fixture.store.attachSourcePin(pinOperation.record.operationId, {
      expectedVersion: pinOperation.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    }),
    other.attachSourcePin(pinOperation.record.operationId, {
      expectedVersion: pinOperation.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    }),
  ]);
  assert.equal(new Set(pinRows.map((row) => row.recordVersion)).size, 1);

  const workerOperation = await createOne(fixture, { requestId: 'multi-instance-worker' });
  const workers = await Promise.allSettled([
    fixture.store.setWorker(workerOperation.record.operationId, {
      expectedVersion: workerOperation.record.recordVersion,
      worker: { workerId: 'worker-a' },
    }),
    other.setWorker(workerOperation.record.operationId, {
      expectedVersion: workerOperation.record.recordVersion,
      worker: { workerId: 'worker-b' },
    }),
  ]);
  assert.equal(workers.filter((row) => row.status === 'fulfilled').length, 1);

  const resultOperation = await createOne(fixture, { requestId: 'multi-instance-result' });
  const results = await Promise.allSettled([
    fixture.store.setResult(resultOperation.record.operationId, {
      expectedVersion: resultOperation.record.recordVersion,
      result: { winner: 'a' },
    }),
    other.setResult(resultOperation.record.operationId, {
      expectedVersion: resultOperation.record.recordVersion,
      result: { winner: 'b' },
    }),
  ]);
  assert.equal(results.filter((row) => row.status === 'fulfilled').length, 1);

  const terminalOperation = await createOne(fixture, { requestId: 'multi-instance-terminal' });
  const terminals = await Promise.allSettled([
    fixture.store.transition(terminalOperation.record.operationId, {
      expectedVersion: terminalOperation.record.recordVersion,
      state: 'complete',
    }),
    other.transition(terminalOperation.record.operationId, {
      expectedVersion: terminalOperation.record.recordVersion,
      state: 'cancelled',
    }),
  ]);
  assert.equal(terminals.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(TERMINAL_STATES.has((await fixture.store.get(terminalOperation.record.operationId)).state), true);
});

test('separate Node processes share the proper-lockfile idempotency boundary', async (t) => {
  const fixture = makeFixture(t);
  const storePath = path.resolve('engine/src/dashboard/brain-operations/operation-store.js');
  const childSource = `
    const { BrainOperationStore } = require(process.env.STORE_MODULE);
    const input = JSON.parse(process.env.STORE_INPUT);
    const store = new BrainOperationStore({ root: process.env.STORE_ROOT, requesterAgent: 'jerry' });
    store.create(input).then((result) => process.stdout.write(JSON.stringify(result))).catch((error) => {
      process.stderr.write(String(error && (error.stack || error)));
      process.exitCode = 1;
    });
  `;
  const environment = {
    ...process.env,
    STORE_MODULE: storePath,
    STORE_ROOT: fixture.root,
    STORE_INPUT: JSON.stringify(validRequest({ requestId: 'multiprocess-create' })),
  };
  const outputs = await Promise.all(Array.from({ length: 6 }, () =>
    execFileAsync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      env: environment,
      maxBuffer: 1024 * 1024,
    })));
  const rows = outputs.map(({ stdout }) => JSON.parse(stdout));
  assert.equal(rows.filter((row) => row.created).length, 1);
  assert.equal(new Set(rows.map((row) => row.record.operationId)).size, 1);
  assert.equal((await fixture.store.list()).length, 1);
});

test('separate Node processes serialize event, pin, worker, result, and terminal mutations', async (t) => {
  const fixture = makeFixture(t);
  const storePath = path.resolve('engine/src/dashboard/brain-operations/operation-store.js');
  const childSource = `
    const { BrainOperationStore } = require(process.env.STORE_MODULE);
    const payload = JSON.parse(process.env.STORE_PAYLOAD);
    const store = new BrainOperationStore({ root: process.env.STORE_ROOT, requesterAgent: 'jerry' });
    Promise.resolve(store[payload.method](...payload.args))
      .then((value) => process.stdout.write(JSON.stringify({ ok: true, value })))
      .catch((error) => process.stdout.write(JSON.stringify({ ok: false, code: error && error.code })));
  `;
  async function child(payload) {
    const { stdout } = await execFileAsync(process.execPath, ['-e', childSource], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        STORE_MODULE: storePath,
        STORE_ROOT: fixture.root,
        STORE_PAYLOAD: JSON.stringify(payload),
      },
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  }

  const eventOperation = await createOne(fixture, { requestId: 'multiprocess-events' });
  const eventRows = await Promise.all(Array.from({ length: 8 }, (_, index) => child({
    method: 'appendEvent',
    args: [eventOperation.record.operationId, { type: 'progress', index }],
  })));
  assert.equal(eventRows.every((row) => row.ok), true);
  assert.equal((await fixture.store.get(eventOperation.record.operationId)).eventSequence, 8);

  const pinOperation = await createOne(fixture, { requestId: 'multiprocess-pin' });
  const descriptor = validDescriptor();
  const pins = await Promise.all(Array.from({ length: 4 }, () => child({
    method: 'attachSourcePin',
    args: [pinOperation.record.operationId, {
      expectedVersion: pinOperation.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    }],
  })));
  assert.equal(pins.every((row) => row.ok), true);
  assert.equal(new Set(pins.map((row) => row.value.recordVersion)).size, 1);

  for (const [name, method, buildInput] of [
    ['worker', 'setWorker', (index, record) => ({
      expectedVersion: record.recordVersion, worker: { workerId: `child-${index}` },
    })],
    ['result', 'setResult', (index, record) => ({
      expectedVersion: record.recordVersion, result: { child: index },
    })],
    ['terminal', 'transition', (index, record) => ({
      expectedVersion: record.recordVersion, state: index ? 'cancelled' : 'complete',
    })],
  ]) {
    const operation = await createOne(fixture, { requestId: `multiprocess-${name}` });
    const rows = await Promise.all([0, 1, 2, 3].map((index) => child({
      method,
      args: [operation.record.operationId, buildInput(index, operation.record)],
    })));
    assert.equal(rows.filter((row) => row.ok).length, 1, name);
  }
});

test('cross-process operation lock waits beyond the former five-second retry ceiling', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'long-lock-wait' });
  const operationRoot = operationDirectory(fixture.root, created.record.operationId);
  const holder = await startLockHolder(
    t,
    statusPath(fixture.root, created.record.operationId),
    path.join(operationRoot, '.operation.lock'),
    5600,
  );
  const startedAt = Date.now();
  const committed = await fixture.store.appendEvent(created.record.operationId, {
    type: 'progress',
    value: 'after-long-holder',
  });
  const elapsed = Date.now() - startedAt;
  assert.equal(committed.eventSequence, 1);
  assert.ok(elapsed >= 5200, `lock wait was only ${elapsed}ms`);
  await waitForChildExit(holder);
});

test('configurable short acquisition deadline fails with typed operation_lock_timeout', async (t) => {
  const fixture = makeFixture(t);
  assert.ok(fixture.store.lockTimeoutMs >= 8 * 60 * 60 * 1000);
  for (const lockTimeoutMs of [0, -1, 1.5, Number.NaN, '60', 24 * 60 * 60 * 1000 + 1]) {
    assert.throws(() => new BrainOperationStore({
      root: fixture.root,
      requesterAgent: 'jerry',
      lockTimeoutMs,
    }), typedCode('store_configuration_invalid'));
  }
  const created = await createOne(fixture, { requestId: 'short-lock-timeout' });
  const operationRoot = operationDirectory(fixture.root, created.record.operationId);
  const before = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
  const holder = await startLockHolder(
    t,
    statusPath(fixture.root, created.record.operationId),
    path.join(operationRoot, '.operation.lock'),
    500,
  );
  const bounded = anotherStore(fixture, { lockTimeoutMs: 60 });
  const startedAt = Date.now();
  await assert.rejects(
    () => bounded.appendEvent(created.record.operationId, { type: 'heartbeat' }),
    typedCode('operation_lock_timeout'),
  );
  assert.ok(Date.now() - startedAt < 1000);
  assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), before);
  await waitForChildExit(holder);
});

test('owned-run and requester targets use only stable identity in the fingerprint', async (t) => {
  const fixture = makeFixture(t);
  const owned = validOwnedRunTarget({ catalogRevision: 'one' });
  const first = await createOne(fixture, { target: owned, requestId: 'owned-1' });
  const drift = await createOne(fixture, {
    target: {
      ...owned,
      runState: 'paused',
      catalogRevision: 'two',
      route: '/changed/route',
      mutationBoundaries: owned.mutationBoundaries
        .map((boundary) => ({
          ...boundary,
          path: path.join(owned.canonicalRoot, 'changed', boundary.kind),
        }))
        .reverse(),
    },
    requestId: 'owned-1',
  });
  assert.equal(drift.record.operationId, first.record.operationId);
  for (const target of [
    { ...owned, runId: 'run-2' },
    {
      ...owned,
      canonicalRoot: '/brains/runs/run-2',
      mutationBoundaries: validMutationBoundaries('/brains/runs/run-2'),
    },
    { ...owned, ownerAgent: 'forrest' },
  ]) {
    await assert.rejects(() => createOne(fixture, {
      target,
      requestId: 'owned-1',
    }), typedCode('idempotency_conflict'));
  }

  const requester = await createOne(fixture, {
    requestId: 'requester-1',
    target: validRequesterTarget(),
    operationType: 'synthesis',
  });
  assert.equal(requester.record.target.domain, 'requester');
});

test('idempotency digest is exact NUL-delimited SHA-256 and excludes only documented drift', async (t) => {
  const manual = crypto.createHash('sha256')
    .update('jerry\0request-1\0query', 'utf8')
    .digest('hex');
  assert.equal(buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query'), `sha256:${manual}`);

  const fixture = makeFixture(t);
  const base = await createOne(fixture, {
    requestId: 'stable-brain',
    requestParameters: { alpha: 1, beta: 2 },
    parameters: { alpha: 1, beta: 2, modelSelection: { provider: 'one', model: 'm1' } },
  });
  const drifts = [
    { displayName: 'renamed' },
    { ownerAgent: 'changed-catalog-owner' },
    { kind: 'research' },
    { lifecycle: 'completed' },
    { catalogRevision: 'catalog-99' },
    { route: '/new/route' },
    { mutationBoundaries: validTarget().mutationBoundaries
      .map((boundary) => ({
        ...boundary,
        path: path.join(validTarget().canonicalRoot, 'new', boundary.kind),
      }))
      .reverse() },
  ];
  for (const drift of drifts) {
    const duplicate = await createOne(fixture, {
      requestId: 'stable-brain',
      target: validTarget(drift),
      requestParameters: { beta: 2, alpha: 1 },
      parameters: { alpha: 1, beta: 2, modelSelection: { provider: 'two', model: 'm2' } },
    });
    assert.equal(duplicate.created, false, JSON.stringify(drift));
    assert.equal(duplicate.record.operationId, base.record.operationId);
    assert.deepEqual(duplicate.record.parameters.modelSelection, { provider: 'one', model: 'm1' });
    assert.equal(duplicate.record.target.displayName, 'jerry');
  }

  for (const target of [
    validRequesterTarget(),
    validTarget({ brainId: 'brain-forrest' }),
    validTarget({
      canonicalRoot: '/brains/other',
      mutationBoundaries: validMutationBoundaries('/brains/other'),
    }),
    validTarget({ accessMode: 'read-only' }),
  ]) {
    await assert.rejects(() => createOne(fixture, {
      requestId: 'stable-brain',
      target,
      requestParameters: { alpha: 1, beta: 2 },
    }), typedCode('idempotency_conflict'));
  }
});

test('status-committed idempotency orphan is found, repaired, and never duplicated', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'after_initial_status_commit') {
        fail = false;
        throw Object.assign(new Error('injected crash'), { code: 'injected_crash' });
      }
    },
  });
  await assert.rejects(() => createOne(fixture), typedCode('injected_crash'));
  assert.equal(fs.readdirSync(path.join(fixture.root, 'operations')).length, 1);
  assert.equal(fs.existsSync(path.join(fixture.root, 'idempotency', 'index.json')), false);

  const reloaded = new BrainOperationStore({
    root: fixture.root,
    requesterAgent: 'jerry',
    now: () => fixture.clock.now,
  });
  const key = buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query');
  const recovered = await reloaded.findByIdempotencyKey(key);
  assert.ok(recovered);
  assert.equal(fs.existsSync(path.join(fixture.root, 'idempotency', 'index.json')), true);
  const retry = await reloaded.create(validRequest());
  assert.equal(retry.created, false);
  assert.equal(retry.record.operationId, recovered.operationId);
  assert.equal(fs.readdirSync(path.join(fixture.root, 'operations')).length, 1);
});

test('create itself repairs a status-committed orphan and persists exact canonical index bytes', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'after_initial_status_commit') {
        fail = false;
        throw Object.assign(new Error('lost response'), { code: 'injected_crash' });
      }
    },
  });
  await assert.rejects(() => createOne(fixture), typedCode('injected_crash'));
  const operationId = fs.readdirSync(path.join(fixture.root, 'operations'))[0];
  const reloaded = anotherStore(fixture);
  const retry = await reloaded.create(validRequest());
  assert.equal(retry.created, false);
  assert.equal(retry.record.operationId, operationId);

  const key = buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query');
  const privateRecord = JSON.parse(fs.readFileSync(statusPath(fixture.root, operationId), 'utf8'));
  const expectedIndex = {
    version: 1,
    entries: {
      [key]: {
        operationId,
        requesterAgent: 'jerry',
        requestFingerprint: privateRecord._requestFingerprint,
      },
    },
  };
  assert.equal(
    fs.readFileSync(path.join(fixture.root, 'idempotency', 'index.json'), 'utf8'),
    `${canonicalJson(expectedIndex)}\n`,
  );
});

test('a failure before initial status rename is invisible and retry creates fresh work', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_initial_status_rename') {
        fail = false;
        throw Object.assign(new Error('injected crash'), { code: 'injected_crash' });
      }
    },
  });
  await assert.rejects(() => createOne(fixture), typedCode('injected_crash'));
  const operations = path.join(fixture.root, 'operations');
  assert.equal(fs.existsSync(operations) ? fs.readdirSync(operations).length : 0, 0);
  assert.equal(fs.existsSync(path.join(fixture.root, 'idempotency', 'index.json')), false);
  const retry = await createOne(fixture);
  assert.equal(retry.created, true);
});

test('missing or syntactically corrupt index repairs from one record; ambiguous claims fail closed', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture);
  const indexPath = path.join(fixture.root, 'idempotency', 'index.json');
  const key = buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query');

  fs.rmSync(indexPath);
  assert.equal((await fixture.store.findByIdempotencyKey(key)).operationId, record.operationId);
  fs.writeFileSync(indexPath, '{not-json');
  assert.equal((await fixture.store.findByIdempotencyKey(key)).operationId, record.operationId);
  const repairedIndexBytes = fs.readFileSync(indexPath, 'utf8');
  const repairedIndex = JSON.parse(repairedIndexBytes);
  assert.equal(repairedIndexBytes, `${canonicalJson(repairedIndex)}\n`);
  assert.deepEqual(Object.keys(repairedIndex.entries), [key]);
  assert.equal(repairedIndex.entries[key].operationId, record.operationId);

  const duplicateId = 'brop_' + Buffer.alloc(24, 7).toString('base64url');
  const duplicateDir = operationDirectory(fixture.root, duplicateId);
  fs.mkdirSync(duplicateDir);
  const privateRecord = JSON.parse(fs.readFileSync(statusPath(fixture.root, record.operationId), 'utf8'));
  fs.writeFileSync(path.join(duplicateDir, 'status.json'), JSON.stringify({
    ...privateRecord,
    operationId: duplicateId,
  }));
  await assert.rejects(() => fixture.store.findByIdempotencyKey(key), typedCode('idempotency_corrupt'));
});

test('indexed requester or fingerprint disagreement fails idempotency_corrupt', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture);
  const storedPath = statusPath(fixture.root, record.operationId);
  const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
  fs.writeFileSync(storedPath, JSON.stringify({ ...stored, _requestFingerprint: 'sha256:' + '0'.repeat(64) }));
  const key = buildBrainOperationIdempotencyKey('jerry', 'request-1', 'query');
  await assert.rejects(() => fixture.store.findByIdempotencyKey(key), typedCode('idempotency_corrupt'));
});

test('private key/requester and index requester/fingerprint mismatches independently fail closed', async (t) => {
  const mutations = [
    {
      name: 'private-key',
      mutate({ status }) { status._idempotencyKey = 'sha256:' + '1'.repeat(64); },
    },
    {
      name: 'private-requester',
      mutate({ status }) { status.requesterAgent = 'forrest'; },
    },
    {
      name: 'private-fingerprint',
      mutate({ status }) { status._requestFingerprint = 'sha256:' + '2'.repeat(64); },
    },
    {
      name: 'index-requester',
      mutate({ index, key }) { index.entries[key].requesterAgent = 'forrest'; },
    },
    {
      name: 'index-fingerprint',
      mutate({ index, key }) { index.entries[key].requestFingerprint = 'sha256:' + '3'.repeat(64); },
    },
    {
      name: 'index-key',
      mutate({ index, key }) {
        index.entries['sha256:' + '4'.repeat(64)] = index.entries[key];
        delete index.entries[key];
      },
    },
  ];
  for (const mutation of mutations) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `mismatch-${mutation.name}` });
    const key = buildBrainOperationIdempotencyKey('jerry', `mismatch-${mutation.name}`, 'query');
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const indexPath = path.join(fixture.root, 'idempotency', 'index.json');
    const status = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    mutation.mutate({ status, index, key });
    fs.writeFileSync(recordPath, JSON.stringify(status));
    fs.writeFileSync(indexPath, JSON.stringify(index));
    await assert.rejects(
      () => fixture.store.findByIdempotencyKey(key),
      typedCode('idempotency_corrupt'),
      mutation.name,
    );
  }
});

test('symlink operation directories are never scanned as idempotency authority', async (t) => {
  const fixture = makeFixture(t);
  const operations = path.join(fixture.root, 'operations');
  const outside = path.join(fixture.root, 'outside-operation');
  fs.mkdirSync(operations, { recursive: true });
  fs.mkdirSync(outside);
  const operationId = 'brop_' + Buffer.alloc(24, 9).toString('base64url');
  const request = validRequest({ requestId: 'symlink-claim' });
  const key = buildBrainOperationIdempotencyKey('jerry', request.requestId, request.operationType);
  fs.writeFileSync(path.join(outside, 'status.json'), JSON.stringify({
    operationId,
    requestId: request.requestId,
    operationType: request.operationType,
    requestParameters: request.requestParameters,
    parameters: request.parameters,
    canonicalEvidence: true,
    recordVersion: 1,
    eventSequence: 0,
    requesterAgent: 'jerry',
    target: request.target,
    state: 'queued',
    _idempotencyKey: key,
    _requestFingerprint: 'sha256:' + 'a'.repeat(64),
  }));
  fs.symlinkSync(outside, path.join(operations, operationId));
  assert.equal(await fixture.store.findByIdempotencyKey(key), null);
  assert.deepEqual(await fixture.store.list(), []);
});

test('every direct read rejects a symlink operation directory and a symlink status record', async (t) => {
  const fixture = makeFixture(t);
  const operations = path.join(fixture.root, 'operations');
  fs.mkdirSync(operations, { recursive: true });
  const outside = path.join(fixture.root, 'direct-read-outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'status.json'), '{}');
  const symlinkId = 'brop_' + Buffer.alloc(24, 0x4a).toString('base64url');
  fs.symlinkSync(outside, path.join(operations, symlinkId));
  const directReads = [
    () => fixture.store.get(symlinkId),
    () => fixture.store.getWorker(symlinkId),
    () => fixture.store.readEvents(symlinkId, 0),
    () => fixture.store.getResult(symlinkId, { requesterAgent: 'jerry', resultHandle: 'brres_' + 'A'.repeat(32) }),
    () => fixture.store.openResultArtifact(symlinkId, { requesterAgent: 'jerry', resultHandle: 'brres_' + 'A'.repeat(32) }),
    () => fixture.store.getAttachment(symlinkId, 'attachment'),
  ];
  for (const read of directReads) {
    await assert.rejects(read, typedCode('operation_corrupt'));
  }

  const created = await createOne(fixture, { requestId: 'status-symlink-read' });
  const recordPath = statusPath(fixture.root, created.record.operationId);
  const realStatus = `${recordPath}.real`;
  fs.renameSync(recordPath, realStatus);
  fs.symlinkSync(realStatus, recordPath);
  for (const read of [
    () => fixture.store.get(created.record.operationId),
    () => fixture.store.getWorker(created.record.operationId),
    () => fixture.store.readEvents(created.record.operationId, 0),
    () => fixture.store.getAttachment(created.record.operationId, 'attachment'),
  ]) {
    await assert.rejects(read, typedCode('operation_corrupt'));
  }
});

test('root and operations ancestor symlink replacement reject reads and mutations without touching outside bytes', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'ancestor-root-operations' });

  const rootBackup = `${fixture.root}.real`;
  const outsideRoot = fs.mkdtempSync(path.join(tmpdir(), 'home23-store-outside-root-'));
  t.after(() => fs.rmSync(outsideRoot, { recursive: true, force: true }));
  fs.renameSync(fixture.root, rootBackup);
  fs.symlinkSync(outsideRoot, fixture.root);
  fs.writeFileSync(path.join(outsideRoot, 'sentinel'), 'outside-root');
  try {
    await assert.rejects(() => fixture.store.get(created.record.operationId));
    await assert.rejects(() => fixture.store.create(validRequest({ requestId: 'outside-root-write' })));
    assert.equal(fs.readFileSync(path.join(outsideRoot, 'sentinel'), 'utf8'), 'outside-root');
    assert.deepEqual(fs.readdirSync(outsideRoot), ['sentinel']);
  } finally {
    fs.rmSync(fixture.root, { force: true });
    fs.renameSync(rootBackup, fixture.root);
  }

  const operations = path.join(fixture.root, 'operations');
  const operationsBackup = path.join(fixture.root, 'operations.real');
  fs.renameSync(operations, operationsBackup);
  fs.symlinkSync(operationsBackup, operations);
  const statusBefore = fs.readFileSync(path.join(operationsBackup, created.record.operationId, 'status.json'));
  try {
    await assert.rejects(() => fixture.store.get(created.record.operationId), typedCode('operation_corrupt'));
    await assert.rejects(() => fixture.store.appendEvent(created.record.operationId, { type: 'heartbeat' }));
    assert.deepEqual(
      fs.readFileSync(path.join(operationsBackup, created.record.operationId, 'status.json')),
      statusBefore,
    );
  } finally {
    fs.rmSync(operations, { force: true });
    fs.renameSync(operationsBackup, operations);
  }
});

test('attachment and result-handle parent symlinks reject reads and mutations without outside writes', async (t) => {
  const fixture = makeFixture(t);
  const attachmentOperation = await createOne(fixture, { requestId: 'ancestor-attachment' });
  await fixture.store.openAttachment(attachmentOperation.record.operationId, 'ancestor-attachment');
  const attachments = path.join(operationDirectory(fixture.root, attachmentOperation.record.operationId), 'attachments');
  const attachmentsBackup = `${attachments}.real`;
  fs.renameSync(attachments, attachmentsBackup);
  fs.symlinkSync(attachmentsBackup, attachments);
  const attachmentPath = path.join(attachmentsBackup, 'ancestor-attachment.json');
  const attachmentBefore = fs.readFileSync(attachmentPath);
  try {
    await assert.rejects(
      () => fixture.store.getAttachment(attachmentOperation.record.operationId, 'ancestor-attachment'),
      typedCode('attachment_corrupt'),
    );
    await assert.rejects(
      () => fixture.store.closeAttachment(
        attachmentOperation.record.operationId,
        'ancestor-attachment',
        'operation_terminal',
      ),
      typedCode('attachment_corrupt'),
    );
    assert.deepEqual(fs.readFileSync(attachmentPath), attachmentBefore);
  } finally {
    fs.rmSync(attachments, { force: true });
    fs.renameSync(attachmentsBackup, attachments);
  }

  const resultOperation = await createOne(fixture, { requestId: 'ancestor-result-handle' });
  const stored = await fixture.store.setResult(resultOperation.record.operationId, {
    expectedVersion: resultOperation.record.recordVersion,
    result: { answer: 'h'.repeat(70 * 1024) },
  });
  const handles = path.join(fixture.root, 'result-handles');
  const handlesBackup = path.join(fixture.root, 'result-handles.real');
  fs.renameSync(handles, handlesBackup);
  fs.symlinkSync(handlesBackup, handles);
  const outsideBefore = new Map(fs.readdirSync(handlesBackup).map((name) => [
    name,
    fs.readFileSync(path.join(handlesBackup, name)),
  ]));
  try {
    await assert.rejects(() => fixture.store.getResult(resultOperation.record.operationId, {
      requesterAgent: 'jerry', resultHandle: stored.resultHandle,
    }), typedCode('result_handle_invalid'));
    const second = await createOne(fixture, { requestId: 'ancestor-result-handle-write' });
    await assert.rejects(() => fixture.store.setResult(second.record.operationId, {
      expectedVersion: second.record.recordVersion,
      result: { answer: 'w'.repeat(70 * 1024) },
    }), typedCode('result_handle_invalid'));
    assert.deepEqual(fs.readdirSync(handlesBackup).sort(), [...outsideBefore.keys()].sort());
    for (const [name, bytes] of outsideBefore) {
      assert.deepEqual(fs.readFileSync(path.join(handlesBackup, name)), bytes);
    }
  } finally {
    fs.rmSync(handles, { force: true });
    fs.renameSync(handlesBackup, handles);
  }
});

test('event reads reject an operations-ancestor swap after status without returning outside bytes', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'event-ancestor-swap' });
  await fixture.store.appendEvent(created.record.operationId, {
    type: 'progress',
    value: 'inside',
  });

  const operations = path.join(fixture.root, 'operations');
  const operationsBackup = path.join(fixture.root, 'operations.real');
  const outsideOperations = fs.mkdtempSync(path.join(tmpdir(), 'home23-event-outside-'));
  t.after(() => fs.rmSync(outsideOperations, { recursive: true, force: true }));
  const outsideOperation = path.join(outsideOperations, created.record.operationId);
  fs.mkdirSync(outsideOperation);
  const outsideEventPath = path.join(outsideOperation, 'events.jsonl');
  const outsideBytes = Buffer.from(`${JSON.stringify({
    type: 'progress',
    operationId: created.record.operationId,
    sequence: 1,
    at: new Date(INITIAL_NOW).toISOString(),
    value: 'OUTSIDE_SECRET',
  })}\n`);
  fs.writeFileSync(outsideEventPath, outsideBytes);

  const reader = anotherStore(fixture);
  const originalReadEventRows = reader._readEventRows.bind(reader);
  let swapped = false;
  reader._readEventRows = async (...args) => {
    if (!swapped) {
      swapped = true;
      fs.renameSync(operations, operationsBackup);
      fs.symlinkSync(outsideOperations, operations);
    }
    return originalReadEventRows(...args);
  };
  try {
    await assert.rejects(
      () => reader.readEvents(created.record.operationId, 0),
      typedCode('operation_corrupt'),
    );
    assert.equal(swapped, true);
    assert.deepEqual(fs.readFileSync(outsideEventPath), outsideBytes);
  } finally {
    if (swapped) {
      fs.rmSync(operations, { force: true });
      fs.renameSync(operationsBackup, operations);
    }
  }
});

test('source pins validate exact numeric-v1 contract and exact retry increments once', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture);
  const descriptor = validDescriptor();
  const digest = descriptorDigest(descriptor);
  const attached = await fixture.store.attachSourcePin(record.operationId, {
    expectedVersion: record.recordVersion,
    descriptor,
    digest,
  });
  assert.deepEqual(attached.sourcePinDescriptor, descriptor);
  assert.equal(attached.sourcePinDigest, digest);
  assert.equal(attached.recordVersion, record.recordVersion + 1);

  const retries = await Promise.all(Array.from({ length: 32 }, () =>
    fixture.store.attachSourcePin(record.operationId, {
      expectedVersion: record.recordVersion,
      descriptor,
      digest,
    })));
  assert.deepEqual(new Set(retries.map((row) => row.recordVersion)), new Set([attached.recordVersion]));
  await assert.rejects(() => fixture.store.attachSourcePin(record.operationId, {
    expectedVersion: attached.recordVersion,
    descriptor: { ...descriptor, cutoffRevision: 2 },
    digest: 'sha256:' + 'b'.repeat(64),
  }), typedCode('source_pin_conflict'));
});

test('source pin rejects malformed manifest and legacy projection descriptors before mutation', async (t) => {
  const fixture = makeFixture(t);
  const mutations = [
    (d) => { delete d.activeBase.nodes.count; },
    (d) => { d.activeBase.nodes.bytes = 0; },
    (d) => { d.activeBase.edges.count = -1; },
    (d) => { d.activeBase.edges.bytes = 1.5; },
    (d) => { d.activeDelta.fromRevision = 1; },
    (d) => { d.activeDelta.toRevision = 2; },
    (d) => { d.activeDelta.count = 1; },
    (d) => { d.activeDelta.committedBytes = -1; },
    (d) => { d.activeBase.nodes.extra = true; },
    (d) => { d.version = '1'; },
    (d) => { d.version = 0; },
    (d) => { d.baseRevision = Number.MAX_SAFE_INTEGER + 1; },
    (d) => { d.cutoffRevision = null; },
    (d) => { d.generation = null; },
    (d) => { d.activeBase.nodes.file = '../nodes.gz'; },
    (d) => { d.activeDelta.file = '/tmp/delta'; },
    (d) => { d.projectionRoot = '/private/path'; },
    (d) => { d.canonicalRoot = '/brains/forrest'; },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const created = await createOne(fixture, { requestId: `pin-invalid-${index}` });
    const descriptor = structuredClone(validDescriptor());
    mutations[index](descriptor);
    const before = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
    await assert.rejects(() => fixture.store.attachSourcePin(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    }), typedCode('source_pin_invalid'));
    assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), before);
  }

  const legacy = validDescriptor({ sourceMode: 'legacy_projection' });
  const legacyOperation = await createOne(fixture, { requestId: 'legacy-pin' });
  const attached = await fixture.store.attachSourcePin(legacyOperation.record.operationId, {
    expectedVersion: legacyOperation.record.recordVersion,
    descriptor: legacy,
    digest: descriptorDigest(legacy),
  });
  assert.equal(attached.sourcePinDescriptor.version, 1);
  assert.equal(Object.hasOwn(attached.sourcePinDescriptor, 'projectionRoot'), false);

  const nonzeroCommittedBytes = validDescriptor({
    activeDelta: { ...validDescriptor().activeDelta, committedBytes: 1 },
  });
  const nonzeroOperation = await createOne(fixture, { requestId: 'pin-nonzero-empty-delta-bytes' });
  const nonzeroAttached = await fixture.store.attachSourcePin(nonzeroOperation.record.operationId, {
    expectedVersion: nonzeroOperation.record.recordVersion,
    descriptor: nonzeroCommittedBytes,
    digest: descriptorDigest(nonzeroCommittedBytes),
  });
  assert.equal(nonzeroAttached.sourcePinDescriptor.activeDelta.committedBytes, 1);
});

test('source-pin authority rejects every scalar, nested-shape, path, and digest drift', async (t) => {
  const fixture = makeFixture(t);
  const mutations = [
    (d) => { d.sourceMode = 'legacy-path'; },
    (d) => { delete d.baseRevision; },
    (d) => { d.baseRevision = 1.5; },
    (d) => { d.baseRevision = '1'; },
    (d) => { d.cutoffRevision = 0; },
    (d) => { delete d.cutoffRevision; },
    (d) => { d.activeBase.nodes.count = '12'; },
    (d) => { d.activeBase.edges.bytes = 0; },
    (d) => { d.activeBase.edges.file = 'nested/edges.gz'; },
    (d) => { d.activeDelta.epoch = ''; },
    (d) => { d.activeDelta.count = '0'; },
    (d) => { d.activeDelta.committedBytes = 1.25; },
    (d) => { d.summary.nodeCount = -1; },
    (d) => { d.summary.edgeCount = '20'; },
    (d) => { d.summary.extra = 1; },
    (d) => { d.lockRoot = '/private/lock'; },
    (d) => { d.operationRoot = '/private/operation'; },
    (d) => { d.activeDelta.privatePath = '/private/delta'; },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const created = await createOne(fixture, { requestId: `pin-matrix-${index}` });
    const descriptor = structuredClone(validDescriptor());
    mutations[index](descriptor);
    const before = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
    await assert.rejects(() => fixture.store.attachSourcePin(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    }), typedCode('source_pin_invalid'), String(index));
    assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), before);
  }

  for (const digest of [
    'sha256:' + 'A'.repeat(64),
    'SHA256:' + 'a'.repeat(64),
    'sha256:' + 'a'.repeat(63),
    'sha256:' + 'f'.repeat(64),
  ]) {
    const created = await createOne(fixture, { requestId: `pin-digest-${digest.length}-${digest[0]}` });
    await assert.rejects(() => fixture.store.attachSourcePin(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      descriptor: validDescriptor(),
      digest,
    }), typedCode('source_pin_invalid'));
  }
});

test('source-pin lost-response retry survives reload without a second version/event or worker', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'pin-lost-response' });
  const descriptor = validDescriptor();
  const digest = descriptorDigest(descriptor);
  const attached = await fixture.store.attachSourcePin(record.operationId, {
    expectedVersion: record.recordVersion,
    descriptor,
    digest,
  });
  const reloaded = anotherStore(fixture);
  const retry = await reloaded.attachSourcePin(record.operationId, {
    expectedVersion: record.recordVersion,
    descriptor,
    digest,
  });
  assert.equal(retry.recordVersion, attached.recordVersion);
  assert.equal(retry.eventSequence, attached.eventSequence);
  const privateRecord = JSON.parse(fs.readFileSync(statusPath(fixture.root, record.operationId), 'utf8'));
  assert.equal(privateRecord._worker, null);
  assert.deepEqual(privateRecord.sourcePinDescriptor, descriptor);
  assert.equal(privateRecord.sourcePinDigest, digest);
});

test('persisted source-pin null-pair, descriptor shape, and digest tampering fail operation_corrupt on reload', async (t) => {
  const mutations = [
    (record) => { record.sourcePinDescriptor = null; },
    (record) => { record.sourcePinDigest = null; },
    (record) => {
      record.sourcePinDescriptor.activeBase.nodes.bytes = 0;
      record.sourcePinDigest = descriptorDigest(record.sourcePinDescriptor);
    },
    (record) => { record.sourcePinDigest = 'sha256:' + 'f'.repeat(64); },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `persisted-pin-tamper-${index}` });
    const descriptor = validDescriptor();
    await fixture.store.attachSourcePin(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    });
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const privateRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    mutations[index](privateRecord);
    fs.writeFileSync(recordPath, JSON.stringify(privateRecord));
    await assert.rejects(
      () => anotherStore(fixture).get(created.record.operationId),
      typedCode('operation_corrupt'),
      String(index),
    );
  }
});

test('persisted source-pin release markers require a terminal operation and canonical timestamp', async (t) => {
  const cases = [
    { name: 'boolean', value: true, terminal: true },
    { name: 'object', value: { released: true }, terminal: true },
    { name: 'invalid-date', value: 'not-a-date', terminal: true },
    { name: 'nonterminal', value: new Date(INITIAL_NOW).toISOString(), terminal: false },
  ];
  for (const item of cases) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `release-marker-${item.name}` });
    const descriptor = validDescriptor();
    const pinned = await fixture.store.attachSourcePin(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      descriptor,
      digest: descriptorDigest(descriptor),
    });
    if (item.terminal) {
      await fixture.store.transition(created.record.operationId, {
        expectedVersion: pinned.recordVersion,
        state: 'complete',
      });
    }
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const privateRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    privateRecord.sourcePinReleasedAt = item.value;
    fs.writeFileSync(recordPath, JSON.stringify(privateRecord));
    await assert.rejects(
      () => anotherStore(fixture).get(created.record.operationId),
      typedCode('operation_corrupt'),
      item.name,
    );
  }
});

test('pin write failure exposes neither field and exact retry commits once', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_source_pin_status_rename') {
        fail = false;
        throw Object.assign(new Error('injected'), { code: 'injected_crash' });
      }
    },
  });
  const { record } = await createOne(fixture);
  const before = fs.readFileSync(statusPath(fixture.root, record.operationId));
  const descriptor = validDescriptor();
  await assert.rejects(() => fixture.store.attachSourcePin(record.operationId, {
    expectedVersion: record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  }), typedCode('injected_crash'));
  assert.deepEqual(fs.readFileSync(statusPath(fixture.root, record.operationId)), before);
  const attached = await fixture.store.attachSourcePin(record.operationId, {
    expectedVersion: record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  assert.equal(attached.recordVersion, record.recordVersion + 1);
});

test('state machine, worker assignment, and attachments remain independent', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture);
  const worker = await fixture.store.setWorker(record.operationId, {
    expectedVersion: record.recordVersion,
    worker: { process: 'cosmo23', workerId: 'worker-1' },
  });
  await assert.rejects(() => fixture.store.setWorker(record.operationId, {
    expectedVersion: worker.recordVersion,
    worker: { process: 'cosmo23', workerId: 'worker-2' },
  }), typedCode('worker_conflict'));

  const running = await fixture.store.transition(record.operationId, {
    expectedVersion: worker.recordVersion,
    state: 'running',
    phase: 'provider',
  });
  assert.equal(running.state, 'running');
  assert.ok(running.startedAt);
  await assert.rejects(() => fixture.store.transition(record.operationId, {
    expectedVersion: running.recordVersion,
    state: 'queued',
  }), typedCode('transition_invalid'));

  await fixture.store.openAttachment(record.operationId, 'attachment-a');
  await fixture.store.openAttachment(record.operationId, 'attachment-b');
  await fixture.store.detachAttachment(record.operationId, 'attachment-a', 'wait_deadline');
  assert.equal((await fixture.store.get(record.operationId)).state, 'running');
  assert.equal((await fixture.store.getAttachment(record.operationId, 'attachment-b')).state, 'attached');
  assert.equal((await fixture.store.getAttachment(record.operationId, 'attachment-a')).state, 'detached');
  await assert.rejects(
    () => fixture.store.openAttachment(record.operationId, '../outside'),
    typedCode('identifier_invalid'),
  );

  const completed = await fixture.store.transition(record.operationId, {
    expectedVersion: running.recordVersion,
    state: 'complete',
  });
  assert.equal(completed.state, 'complete');
  assert.ok(completed.completedAt);
  assert.ok(completed.resultExpiresAt);
  assert.ok(completed.metadataExpiresAt);
  await assert.rejects(() => fixture.store.transition(record.operationId, {
    expectedVersion: completed.recordVersion,
    state: 'failed',
  }), typedCode('operation_terminal'));
  await assert.rejects(
    () => fixture.store.appendEvent(record.operationId, { type: 'heartbeat' }),
    typedCode('operation_terminal'),
  );
});

test('transition error and sourceEvidence enforce bounded object-or-null schemas before mutation', async (t) => {
  const fixture = makeFixture(t);
  const invalidTransitions = [
    { state: 'failed', error: 'provider failed' },
    { state: 'failed', error: [] },
    { state: 'failed', error: {} },
    { state: 'failed', error: { code: 'provider_failed', message: 'failed' } },
    { state: 'failed', error: { code: 'provider_failed', message: 'failed', retryable: 'yes' } },
    { state: 'failed', error: { code: 'bad code', message: 'failed', retryable: false } },
    { state: 'failed', error: { code: 'x'.repeat(257), message: 'failed', retryable: false } },
    { state: 'failed', error: { code: 'provider_failed', message: '', retryable: false } },
    { state: 'failed', error: { code: 'provider_failed', message: 'm'.repeat(4097), retryable: false } },
    {
      state: 'failed',
      error: { code: 'provider_failed', message: 'failed', retryable: false, detail: 'x'.repeat(70 * 1024) },
    },
    { state: 'complete', sourceEvidence: 'evidence' },
    { state: 'complete', sourceEvidence: [] },
    { state: 'complete', sourceEvidence: 42 },
    { state: 'complete', sourceEvidence: { detail: 'x'.repeat(70 * 1024) } },
  ];
  for (let index = 0; index < invalidTransitions.length; index += 1) {
    const created = await createOne(fixture, { requestId: `transition-shape-${index}` });
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const before = fs.readFileSync(recordPath);
    await assert.rejects(
      () => fixture.store.transition(created.record.operationId, {
        expectedVersion: created.record.recordVersion,
        ...invalidTransitions[index],
      }),
      typedCode('transition_invalid'),
      String(index),
    );
    assert.deepEqual(fs.readFileSync(recordPath), before);
    assert.equal(fs.existsSync(path.join(operationDirectory(
      fixture.root,
      created.record.operationId,
    ), 'events.jsonl')), false);
  }

  const accepted = await createOne(fixture, { requestId: 'transition-shape-valid' });
  const error = {
    code: 'provider_failed',
    message: 'provider returned a terminal failure',
    retryable: true,
    provider: 'openai',
    detail: { status: 503 },
  };
  const sourceEvidence = { source: 'manifest', revisions: [1, 2, 3] };
  const failed = await fixture.store.transition(accepted.record.operationId, {
    expectedVersion: accepted.record.recordVersion,
    state: 'failed',
    error,
    sourceEvidence,
  });
  assert.deepEqual(failed.error, error);
  assert.deepEqual(failed.sourceEvidence, sourceEvidence);

  const nullable = await createOne(fixture, { requestId: 'transition-shape-null' });
  const completed = await fixture.store.transition(nullable.record.operationId, {
    expectedVersion: nullable.record.recordVersion,
    state: 'complete',
    error: null,
    sourceEvidence: null,
  });
  assert.equal(completed.error, null);
  assert.equal(completed.sourceEvidence, null);
});

test('persisted error and sourceEvidence shape tampering fails operation_corrupt on reload', async (t) => {
  const mutations = [
    (record) => { record.error = 'failed'; },
    (record) => { record.error = []; },
    (record) => { record.error = { code: 'failed', message: 'failed', retryable: 'no' }; },
    (record) => { record.sourceEvidence = 'evidence'; },
    (record) => { record.sourceEvidence = []; },
  ];
  for (let index = 0; index < mutations.length; index += 1) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `persisted-transition-shape-${index}` });
    const recordPath = statusPath(fixture.root, created.record.operationId);
    const privateRecord = JSON.parse(fs.readFileSync(recordPath, 'utf8'));
    mutations[index](privateRecord);
    fs.writeFileSync(recordPath, JSON.stringify(privateRecord));
    await assert.rejects(
      () => anotherStore(fixture).get(created.record.operationId),
      typedCode('operation_corrupt'),
      String(index),
    );
  }
});

test('every second worker assignment rejects while getWorker supports lost-response reconciliation', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'worker-lost-response' });
  const worker = { process: 'cosmo23', workerId: 'worker-stable', route: '/internal/worker-stable' };
  const assigned = await fixture.store.setWorker(record.operationId, {
    expectedVersion: record.recordVersion,
    worker,
  });
  await assert.rejects(() => anotherStore(fixture).setWorker(record.operationId, {
    expectedVersion: record.recordVersion,
    worker: structuredClone(worker),
  }), typedCode('worker_conflict'));
  assert.deepEqual(await anotherStore(fixture).getWorker(record.operationId), worker);
  assert.equal((await fixture.store.get(record.operationId)).recordVersion, assigned.recordVersion);
  await assert.rejects(() => fixture.store.setWorker(record.operationId, {
    expectedVersion: assigned.recordVersion,
    worker: { ...worker, workerId: 'worker-different' },
  }), typedCode('worker_conflict'));
});

test('trusted worker reconciliation read remains private and operation scratch is store-owned and symlink-safe', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'trusted-private-seams' });
  assert.equal(await fixture.store.getWorker(record.operationId), null);
  const assigned = await fixture.store.setWorker(record.operationId, {
    expectedVersion: record.recordVersion,
    worker: { workerId: 'worker-reconcile', process: 'cosmo23' },
  });
  assert.deepEqual(await anotherStore(fixture).getWorker(record.operationId), {
    workerId: 'worker-reconcile', process: 'cosmo23',
  });
  assert.equal(JSON.stringify(assigned).includes('worker-reconcile'), false);

  const scratch = await fixture.store.ensureScratchDirectory(record.operationId);
  assert.equal(scratch, path.join(operationDirectory(fixture.root, record.operationId), 'scratch'));
  const scratchStat = fs.lstatSync(scratch);
  assert.equal(scratchStat.isDirectory(), true);
  assert.equal(scratchStat.isSymbolicLink(), false);
  assert.equal(JSON.stringify(await fixture.store.get(record.operationId)).includes(scratch), false);

  fs.rmSync(scratch, { recursive: true });
  const outside = path.join(fixture.root, 'outside-scratch');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, scratch);
  await assert.rejects(
    () => fixture.store.ensureScratchDirectory(record.operationId),
    typedCode('scratch_corrupt'),
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('closed attachment state is explicitly reachable, idempotent, and independent of terminal execution', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'attachment-close' });
  await fixture.store.openAttachment(record.operationId, 'close-me');
  const closed = await fixture.store.closeAttachment(record.operationId, 'close-me', 'response_complete');
  assert.equal(closed.state, 'closed');
  assert.equal(closed.reason, 'response_complete');
  assert.ok(closed.closedAt);
  assert.deepEqual(
    await fixture.store.closeAttachment(record.operationId, 'close-me', 'response_complete'),
    closed,
  );
  await assert.rejects(
    () => fixture.store.openAttachment(record.operationId, 'close-me'),
    typedCode('attachment_closed'),
  );

  await fixture.store.openAttachment(record.operationId, 'close-after-terminal');
  const terminal = await fixture.store.transition(record.operationId, {
    expectedVersion: record.recordVersion,
    state: 'complete',
  });
  assert.equal(terminal.state, 'complete');
  const postTerminal = await fixture.store.closeAttachment(
    record.operationId,
    'close-after-terminal',
    'operation_terminal',
  );
  assert.equal(postTerminal.state, 'closed');
  assert.equal((await fixture.store.get(record.operationId)).recordVersion, terminal.recordVersion);
});

test('a detached attachment ID reopens atomically while a closed ID remains permanent', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'attachment-reopen' });
  const opened = await fixture.store.openAttachment(record.operationId, 'stable-attachment');
  fixture.clock.now += 1_000;
  const detached = await fixture.store.detachAttachment(
    record.operationId,
    'stable-attachment',
    'event_gap_reconnect',
  );
  assert.equal(detached.state, 'detached');
  assert.ok(detached.detachedAt);
  assert.equal(detached.reason, 'event_gap_reconnect');

  fixture.clock.now += 1_000;
  const reopened = await anotherStore(fixture).openAttachment(
    record.operationId,
    'stable-attachment',
  );
  assert.equal(reopened.state, 'attached');
  assert.equal(reopened.openedAt, opened.openedAt, 'stable attachment history keeps its first open');
  assert.equal(reopened.updatedAt, new Date(fixture.clock.now).toISOString());
  assert.equal(reopened.detachedAt, null);
  assert.equal(reopened.closedAt, null);
  assert.equal(reopened.reason, null);
  assert.deepEqual(await fixture.store.getAttachment(record.operationId, 'stable-attachment'), reopened);

  fixture.clock.now += 1_000;
  await fixture.store.closeAttachment(record.operationId, 'stable-attachment', 'response_complete');
  fixture.clock.now += 1_000;
  await assert.rejects(
    () => fixture.store.openAttachment(record.operationId, 'stable-attachment'),
    typedCode('attachment_closed'),
  );
});

test('cancel-versus-complete permits exactly one terminal winner', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture);
  const running = await fixture.store.transition(record.operationId, {
    expectedVersion: record.recordVersion,
    state: 'running',
  });
  const raced = await Promise.allSettled([
    fixture.store.transition(record.operationId, {
      expectedVersion: running.recordVersion,
      state: 'cancelled',
    }),
    fixture.store.transition(record.operationId, {
      expectedVersion: running.recordVersion,
      state: 'complete',
    }),
  ]);
  assert.equal(raced.filter((row) => row.status === 'fulfilled').length, 1);
  assert.equal(TERMINAL_STATES.has((await fixture.store.get(record.operationId)).state), true);
});

test('events stay bounded, retain material evidence, and report a resumable gap', async (t) => {
  const fixture = makeFixture(t, { eventMaxCount: 12, eventMaxBytes: 1800 });
  const { record } = await createOne(fixture);
  await fixture.store.appendEvent(record.operationId, { type: 'phase', phase: 'source-open' });
  await fixture.store.appendEvent(record.operationId, {
    type: 'provider_selected', providerCallId: 'provider-1', provider: 'openai',
  });
  for (let index = 0; index < 40; index += 1) {
    await fixture.store.appendEvent(record.operationId, {
      type: index % 2 ? 'heartbeat' : 'progress',
      progress: index,
      noise: 'x'.repeat(120),
    });
  }
  const events = await fixture.store.readEvents(record.operationId, 0);
  assert.equal(events[0].type, 'event_gap');
  assert.ok(events[0].oldestSequence > 1);
  assert.equal(events[0].latestSequence, (await fixture.store.get(record.operationId)).eventSequence);
  assert.ok(events.some((event) => event.type === 'phase'));
  assert.ok(events.some((event) => event.type === 'provider_selected'));
  const retained = events.filter((event) => event.type !== 'event_gap');
  assert.ok(retained.length <= 12);
  assert.ok(Buffer.byteLength(retained.map((event) => JSON.stringify(event) + '\n').join('')) <= 1800);
  const resumed = await fixture.store.readEvents(record.operationId, events[0].oldestSequence - 1);
  assert.notEqual(resumed[0]?.type, 'event_gap');
  for (let index = 1; index < resumed.length; index += 1) {
    assert.ok(resumed[index].sequence > resumed[index - 1].sequence);
  }
});

test('event sequence remains monotonic across concurrent appends and reload', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture);
  await Promise.all(Array.from({ length: 64 }, (_, index) =>
    fixture.store.appendEvent(record.operationId, { type: 'progress', index })));
  const reloaded = new BrainOperationStore({ root: fixture.root, requesterAgent: 'jerry' });
  const events = await reloaded.readEvents(record.operationId, 0);
  const material = events.filter((event) => event.type !== 'event_gap');
  assert.equal(material.length, 64);
  assert.deepEqual(material.map((event) => event.sequence), Array.from({ length: 64 }, (_, i) => i + 1));
  assert.equal((await reloaded.get(record.operationId)).eventSequence, 64);
});

test('event count and byte ceilings compact independently while retaining material terminal evidence', async (t) => {
  const countFixture = makeFixture(t, { eventMaxCount: 6, eventMaxBytes: 1024 * 1024 });
  const countOperation = await createOne(countFixture, { requestId: 'event-count-bound' });
  await countFixture.store.appendEvent(countOperation.record.operationId, { type: 'phase', phase: 'pin' });
  await countFixture.store.appendEvent(countOperation.record.operationId, {
    type: 'provider_selected', providerCallId: 'call-count', provider: 'openai',
  });
  for (let index = 0; index < 20; index += 1) {
    await countFixture.store.appendEvent(countOperation.record.operationId, { type: 'heartbeat', index });
  }
  const countRows = (await countFixture.store.readEvents(countOperation.record.operationId, 0))
    .filter((row) => row.type !== 'event_gap');
  assert.ok(countRows.length <= 6);
  assert.ok(countRows.some((row) => row.type === 'phase'));
  assert.ok(countRows.some((row) => row.type === 'provider_selected'));
  const beforeTerminal = await countFixture.store.get(countOperation.record.operationId);
  const terminal = await countFixture.store.transition(countOperation.record.operationId, {
    expectedVersion: beforeTerminal.recordVersion,
    state: 'complete',
  });
  const terminalRows = await countFixture.store.readEvents(countOperation.record.operationId, 0);
  assert.ok(terminalRows.some((row) => row.type === 'state' && row.state === 'complete'));
  assert.equal(terminal.recordVersion, countOperation.record.recordVersion + 23);

  const byteFixture = makeFixture(t, { eventMaxCount: 100, eventMaxBytes: 700 });
  const byteOperation = await createOne(byteFixture, { requestId: 'event-byte-bound' });
  await byteFixture.store.appendEvent(byteOperation.record.operationId, { type: 'phase', phase: 'source' });
  await byteFixture.store.appendEvent(byteOperation.record.operationId, {
    type: 'provider_selected', providerCallId: 'call-byte', provider: 'openai',
  });
  for (let index = 0; index < 20; index += 1) {
    await byteFixture.store.appendEvent(byteOperation.record.operationId, {
      type: 'progress', index, detail: 'x'.repeat(180),
    });
  }
  const byteRows = (await byteFixture.store.readEvents(byteOperation.record.operationId, 0))
    .filter((row) => row.type !== 'event_gap');
  assert.ok(Buffer.byteLength(byteRows.map((row) => JSON.stringify(row) + '\n').join('')) <= 700);
  assert.ok(byteRows.some((row) => row.type === 'phase'));
  assert.ok(byteRows.some((row) => row.type === 'provider_selected'));
});

test('event crash before status publication is invisible after reload and retry uses one sequence', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_status_rename') {
        fail = false;
        throw Object.assign(new Error('event status crash'), { code: 'injected_crash' });
      }
    },
  });
  const { record } = await createOne(fixture, { requestId: 'event-crash-reload' });
  await assert.rejects(
    () => fixture.store.appendEvent(record.operationId, { type: 'progress', value: 1 }),
    typedCode('injected_crash'),
  );
  assert.equal((await fixture.store.get(record.operationId)).eventSequence, 0);
  const reloaded = anotherStore(fixture);
  assert.deepEqual(await reloaded.readEvents(record.operationId, 0), []);
  const committed = await reloaded.appendEvent(record.operationId, { type: 'progress', value: 2 });
  assert.equal(committed.eventSequence, 1);
  assert.equal(committed.recordVersion, record.recordVersion + 1);
  const rows = await reloaded.readEvents(record.operationId, 0);
  assert.deepEqual(rows.map((row) => row.sequence), [1]);
  assert.equal(rows[0].value, 2);
});

test('cross-instance event cache detects an orphan append and repairs one fresh sequence', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'event-cache-orphan' });
  const storeB = anotherStore(fixture);
  assert.deepEqual(await storeB.readEvents(record.operationId, 0), []);

  let fail = true;
  const storeA = anotherStore(fixture, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_status_rename') {
        fail = false;
        throw Object.assign(new Error('orphan event append'), { code: 'injected_crash' });
      }
    },
  });
  await assert.rejects(
    () => storeA.appendEvent(record.operationId, { type: 'progress', value: 'orphan' }),
    typedCode('injected_crash'),
  );
  const committed = await storeB.appendEvent(record.operationId, { type: 'progress', value: 'committed' });
  assert.equal(committed.eventSequence, 1);
  const fresh = anotherStore(fixture);
  const rows = await fresh.readEvents(record.operationId, 0);
  assert.deepEqual(rows.map((row) => ({ sequence: row.sequence, value: row.value })), [
    { sequence: 1, value: 'committed' },
  ]);
});

test('event cache never binds pre-orphan rows to a post-orphan file identity', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'event-cache-identity-window' });
  await fixture.store.appendEvent(created.record.operationId, { type: 'progress', value: 'first' });

  const storeB = anotherStore(fixture);
  const originalRead = storeB._readSecureRegularFile.bind(storeB);
  let eventBytesReadResolve;
  let resumeReadResolve;
  const eventBytesRead = new Promise((resolve) => { eventBytesReadResolve = resolve; });
  const resumeRead = new Promise((resolve) => { resumeReadResolve = resolve; });
  let held = false;
  storeB._readSecureRegularFile = async (...args) => {
    const bytes = await originalRead(...args);
    if (!held && path.basename(args[0]) === 'events.jsonl') {
      held = true;
      eventBytesReadResolve();
      await resumeRead;
    }
    return bytes;
  };

  const staleRead = storeB.readEvents(created.record.operationId, 0);
  await eventBytesRead;
  const storeA = anotherStore(fixture, {
    crashInjector: async (stage) => {
      if (stage === 'before_status_rename') {
        throw Object.assign(new Error('orphan event append'), { code: 'injected_crash' });
      }
    },
  });
  try {
    await assert.rejects(
      () => storeA.appendEvent(created.record.operationId, { type: 'progress', value: 'orphan' }),
      typedCode('injected_crash'),
    );
  } finally {
    resumeReadResolve();
  }
  assert.deepEqual((await staleRead).map((row) => row.sequence), [1]);
  storeB._readSecureRegularFile = originalRead;

  const committed = await storeB.appendEvent(created.record.operationId, {
    type: 'progress',
    value: 'committed',
  });
  assert.equal(committed.eventSequence, 2);
  const rows = await anotherStore(fixture).readEvents(created.record.operationId, 0);
  assert.deepEqual(rows.map((row) => ({ sequence: row.sequence, value: row.value })), [
    { sequence: 1, value: 'first' },
    { sequence: 2, value: 'committed' },
  ]);
});

test('concurrent heartbeat events overwrite caller authority with post-mutation record state across reload', async (t) => {
  let now = INITIAL_NOW;
  const nowFn = () => {
    now += 1000;
    return now;
  };
  const fixture = makeFixture(t, { now: nowFn });
  const created = await createOne(fixture, { requestId: 'heartbeat-authority' });
  const provider = await fixture.store.appendEvent(created.record.operationId, {
    type: 'provider_activity',
    provider: 'openai',
  });
  const progress = await fixture.store.appendEvent(created.record.operationId, {
    type: 'progress',
    progress: 0.5,
  });
  const other = anotherStore(fixture, { now: nowFn });
  const forgedAt = '1999-01-01T00:00:00.000Z';
  const calls = Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? fixture.store : other).appendEvent(created.record.operationId, {
      type: 'heartbeat',
      heartbeatIndex: index,
      eventSequence: 999,
      recordVersion: 999,
      state: 'failed',
      phase: 'forged-phase',
      updatedAt: forgedAt,
      lastProviderActivityAt: forgedAt,
      lastProgressAt: forgedAt,
    }));
  const receipts = await Promise.all(calls);
  const rows = await anotherStore(fixture, { now: nowFn }).readEvents(created.record.operationId, 0);
  const heartbeats = rows.filter((event) => event.type === 'heartbeat');
  assert.equal(heartbeats.length, 8);
  assert.deepEqual(heartbeats.map((event) => event.sequence),
    [...heartbeats].map((event) => event.sequence).sort((left, right) => left - right));
  for (const event of heartbeats) {
    const receipt = receipts[event.heartbeatIndex];
    assert.equal(event.operationId, created.record.operationId);
    assert.equal(event.sequence, receipt.eventSequence);
    assert.equal(event.eventSequence, receipt.eventSequence);
    assert.equal(event.recordVersion, receipt.recordVersion);
    assert.equal(event.state, receipt.state);
    assert.equal(event.phase, receipt.phase);
    assert.equal(event.updatedAt, receipt.updatedAt);
    assert.equal(event.at, receipt.updatedAt);
    assert.equal(event.lastProviderActivityAt, provider.lastProviderActivityAt);
    assert.equal(event.lastProgressAt, progress.lastProgressAt);
    assert.notEqual(event.updatedAt, forgedAt);
  }
});

test('attachment mutations do not change recordVersion while event and state commits do exactly once', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'record-version-deltas' });
  await fixture.store.openAttachment(record.operationId, 'version-attachment');
  await fixture.store.detachAttachment(record.operationId, 'version-attachment', 'wait_deadline');
  assert.equal((await fixture.store.get(record.operationId)).recordVersion, record.recordVersion);
  const event = await fixture.store.appendEvent(record.operationId, { type: 'heartbeat' });
  assert.equal(event.recordVersion, record.recordVersion + 1);
  assert.equal(event.eventSequence, record.eventSequence + 1);
  const terminal = await fixture.store.transition(record.operationId, {
    expectedVersion: event.recordVersion,
    state: 'cancelled',
  });
  assert.equal(terminal.recordVersion, event.recordVersion + 1);
  assert.equal(terminal.eventSequence, event.eventSequence + 1);
});

test('setResult accepts only a non-null plain JSON object and rejects ambiguous top-level values invisibly', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'result-object-only' });
  const operationRoot = operationDirectory(fixture.root, created.record.operationId);
  const statusBefore = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
  const filesBefore = listFilesRecursive(operationRoot).map((file) => path.relative(operationRoot, file)).sort();
  const proxy = new Proxy({ answer: 'proxy' }, {});
  for (const result of [null, [], ['array'], 'scalar', 42, true, new Date(INITIAL_NOW), proxy]) {
    await assert.rejects(
      () => fixture.store.setResult(created.record.operationId, {
        expectedVersion: created.record.recordVersion,
        result,
      }),
      typedCode('result_invalid'),
    );
    assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), statusBefore);
    assert.deepEqual(
      listFilesRecursive(operationRoot).map((file) => path.relative(operationRoot, file)).sort(),
      filesBefore,
    );
  }
  const stored = await fixture.store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result: { answer: null },
  });
  assert.deepEqual(stored.result, { answer: null });
});

test('inline and file-backed results honor exact 64 KiB boundary and protected handles', async (t) => {
  const fixture = makeFixture(t);
  const emptyEnvelopeBytes = Buffer.byteLength(JSON.stringify({ answer: '' }), 'utf8');
  const inline = { answer: 'x'.repeat((64 * 1024) - emptyEnvelopeBytes) };
  assert.equal(Buffer.byteLength(JSON.stringify(inline), 'utf8'), 64 * 1024);
  const { record: inlineOperation } = await createOne(fixture, { requestId: 'request-inline' });
  const inlineStored = await fixture.store.setResult(inlineOperation.operationId, {
    expectedVersion: inlineOperation.recordVersion,
    result: inline,
  });
  assert.deepEqual(inlineStored.result, inline);
  assert.equal(inlineStored.resultHandle, null);

  const large = { answer: inline.answer + 'x' };
  assert.equal(Buffer.byteLength(JSON.stringify(large), 'utf8'), (64 * 1024) + 1);
  const { record: largeOperation } = await createOne(fixture, { requestId: 'request-large' });
  const stored = await fixture.store.setResult(largeOperation.operationId, {
    expectedVersion: largeOperation.recordVersion,
    result: large,
  });
  assert.match(stored.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.equal(stored.result, null);
  assert.deepEqual(stored.resultArtifact, {
    mediaType: 'application/json',
    contentEncoding: 'identity',
    bytes: Buffer.byteLength(JSON.stringify(large), 'utf8'),
    sha256: crypto.createHash('sha256').update(JSON.stringify(large)).digest('hex'),
  });
  assert.deepEqual(await fixture.store.getResult(largeOperation.operationId, {
    requesterAgent: 'jerry',
    resultHandle: stored.resultHandle,
  }), large);
  await assert.rejects(() => fixture.store.getResult(largeOperation.operationId, {
    requesterAgent: 'forrest',
    resultHandle: stored.resultHandle,
  }), typedCode('access_denied'));
  await assert.rejects(() => fixture.store.getResult(largeOperation.operationId, {
    requesterAgent: 'jerry',
    resultHandle: 'brres_invalid',
  }), typedCode('result_handle_invalid'));
  await assert.rejects(() => fixture.store.setResult(largeOperation.operationId, {
    expectedVersion: stored.recordVersion,
    result: { second: true },
  }), typedCode('result_conflict'));
});

test('file result handle index contains only a hash mapping and rejects well-formed cross-operation handles', async (t) => {
  const fixture = makeFixture(t);
  const first = await createOne(fixture, { requestId: 'handle-first' });
  const firstResult = await fixture.store.setResult(first.record.operationId, {
    expectedVersion: first.record.recordVersion,
    result: { answer: 'a'.repeat(70 * 1024) },
  });
  const second = await createOne(fixture, { requestId: 'handle-second' });
  const secondResult = await fixture.store.setResult(second.record.operationId, {
    expectedVersion: second.record.recordVersion,
    result: { answer: 'b'.repeat(70 * 1024) },
  });
  const firstHash = crypto.createHash('sha256').update(firstResult.resultHandle).digest('hex');
  const indexPath = path.join(fixture.root, 'result-handles', `${firstHash}.json`);
  const indexBytes = fs.readFileSync(indexPath, 'utf8');
  assert.equal(indexBytes.includes(firstResult.resultHandle), false);
  assert.equal(path.basename(indexPath).includes(firstResult.resultHandle), false);
  assert.deepEqual(JSON.parse(indexBytes), {
    handleSha256: firstHash,
    operationId: first.record.operationId,
    requesterAgent: 'jerry',
  });
  assert.notEqual(firstResult.resultHandle, first.record.operationId);
  assert.equal(firstResult.resultHandle.includes('/'), false);

  const wrong = 'brres_' + Buffer.alloc(24, 0x5c).toString('base64url');
  await assert.rejects(() => fixture.store.getResult(first.record.operationId, {
    requesterAgent: 'jerry', resultHandle: wrong,
  }), typedCode('result_handle_invalid'));
  await assert.rejects(() => fixture.store.getResult(second.record.operationId, {
    requesterAgent: 'jerry', resultHandle: firstResult.resultHandle,
  }), typedCode('result_handle_invalid'));
  await assert.rejects(() => fixture.store.getResult(first.record.operationId, {
    requesterAgent: 'jerry', resultHandle: secondResult.resultHandle,
  }), typedCode('result_handle_invalid'));
});

test('opaque result-handle collisions retry without overwriting another operation mapping', async (t) => {
  const sequence = [
    Buffer.alloc(24, 1),
    Buffer.alloc(24, 9),
    Buffer.alloc(24, 2),
    Buffer.alloc(24, 9),
    Buffer.alloc(24, 8),
  ];
  const fixture = makeFixture(t, {
    randomBytes: () => sequence.shift() ?? Buffer.alloc(24, 7),
  });
  const first = await createOne(fixture, { requestId: 'handle-collision-one' });
  const firstResult = await fixture.store.setResult(first.record.operationId, {
    expectedVersion: first.record.recordVersion,
    result: { answer: 'a'.repeat(70 * 1024) },
  });
  const second = await createOne(fixture, { requestId: 'handle-collision-two' });
  const secondResult = await fixture.store.setResult(second.record.operationId, {
    expectedVersion: second.record.recordVersion,
    result: { answer: 'b'.repeat(70 * 1024) },
  });
  assert.notEqual(secondResult.resultHandle, firstResult.resultHandle);
  assert.deepEqual(await fixture.store.getResult(first.record.operationId, {
    requesterAgent: 'jerry', resultHandle: firstResult.resultHandle,
  }), { answer: 'a'.repeat(70 * 1024) });
  assert.deepEqual(await fixture.store.getResult(second.record.operationId, {
    requesterAgent: 'jerry', resultHandle: secondResult.resultHandle,
  }), { answer: 'b'.repeat(70 * 1024) });
});

test('file-backed JSON result reads reject a symlink even when bytes and hash match', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'json-result-symlink' });
  const stored = await fixture.store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result: { answer: 's'.repeat(70 * 1024) },
  });
  const privateResult = resultPath(fixture.root, created.record.operationId);
  const outside = path.join(fixture.root, 'outside-result.json');
  fs.copyFileSync(privateResult, outside);
  fs.rmSync(privateResult);
  fs.symlinkSync(outside, privateResult);
  await assert.rejects(() => fixture.store.getResult(created.record.operationId, {
    requesterAgent: 'jerry', resultHandle: stored.resultHandle,
  }), typedCode('result_corrupt'));
});

test('result fault before rename leaves no result, handle index, or status mutation', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_result_rename') {
        fail = false;
        throw Object.assign(new Error('injected'), { code: 'injected_crash' });
      }
    },
  });
  const { record } = await createOne(fixture);
  const before = fs.readFileSync(statusPath(fixture.root, record.operationId));
  await assert.rejects(() => fixture.store.setResult(record.operationId, {
    expectedVersion: record.recordVersion,
    result: { answer: 'x'.repeat(70 * 1024) },
  }), typedCode('injected_crash'));
  assert.equal(fs.existsSync(resultPath(fixture.root, record.operationId)), false);
  assert.deepEqual(fs.readFileSync(statusPath(fixture.root, record.operationId)), before);
  const handles = path.join(fixture.root, 'result-handles');
  assert.equal(fs.existsSync(handles) ? fs.readdirSync(handles).length : 0, 0);
});

test('large-result handle-index and status publication faults are fully invisible and retryable', async (t) => {
  for (const failureStage of ['before_result_handle_index_rename', 'before_status_rename']) {
    let fail = true;
    const fixture = makeFixture(t, {
      crashInjector: async (stage) => {
        if (fail && stage === failureStage) {
          fail = false;
          throw Object.assign(new Error(`injected ${stage}`), { code: 'injected_crash' });
        }
      },
    });
    const { record } = await createOne(fixture, { requestId: `result-fault-${failureStage}` });
    const before = fs.readFileSync(statusPath(fixture.root, record.operationId));
    await assert.rejects(() => fixture.store.setResult(record.operationId, {
      expectedVersion: record.recordVersion,
      result: { answer: 'x'.repeat(70 * 1024) },
    }), typedCode('injected_crash'));
    assert.deepEqual(fs.readFileSync(statusPath(fixture.root, record.operationId)), before);
    assert.equal(fs.existsSync(resultPath(fixture.root, record.operationId)), false);
    const handles = path.join(fixture.root, 'result-handles');
    assert.equal(fs.existsSync(handles) ? fs.readdirSync(handles).length : 0, 0);
    const retry = await fixture.store.setResult(record.operationId, {
      expectedVersion: record.recordVersion,
      result: { answer: 'x'.repeat(70 * 1024) },
    });
    assert.ok(retry.resultHandle);
  }
});

test('real process crashes across large-JSON publication scavenge temps and orphan handles on exact retry', async (t) => {
  for (const [index, crashStage] of [
    'before_result_rename',
    'before_result_handle_index_rename',
    'before_status_rename',
  ].entries()) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, { requestId: `json-process-crash-${index}` });
    const operationRoot = operationDirectory(fixture.root, created.record.operationId);
    const result = {
      answer: 'j'.repeat(70 * 1024),
      crashStage,
    };
    let otherPublication = null;
    if (crashStage === 'before_status_rename') {
      const other = await createOne(fixture, {
        requestId: 'json-process-crash-live-other-mapping',
      });
      const otherResult = { answer: 'o'.repeat(70 * 1024) };
      const published = await fixture.store.setResult(other.record.operationId, {
        expectedVersion: other.record.recordVersion,
        result: otherResult,
      });
      otherPublication = { operationId: other.record.operationId, result: otherResult, published };
    }
    const statusBefore = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
    await crashJsonResult(
      fixture.root,
      created.record.operationId,
      created.record.recordVersion,
      result,
      crashStage,
    );
    ageCrashLocks(fixture.root, created.record.operationId);
    assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), statusBefore);
    const operationNames = fs.readdirSync(operationRoot);
    const handleRoot = path.join(fixture.root, 'result-handles');
    const handleNames = fs.existsSync(handleRoot) ? fs.readdirSync(handleRoot) : [];
    if (crashStage === 'before_result_rename') {
      assert.equal(operationNames.filter((name) => /^\.result\.json\.tmp-/.test(name)).length, 1);
      assert.equal(fs.existsSync(path.join(operationRoot, 'result.json')), false);
      assert.equal(handleNames.filter((name) => /\.json$/.test(name)).length, 0);
    } else if (crashStage === 'before_result_handle_index_rename') {
      assert.equal(fs.existsSync(path.join(operationRoot, 'result.json')), true);
      assert.equal(handleNames.filter((name) => /^\.[a-f0-9]{64}\.json\.tmp-/.test(name)).length, 1);
      assert.equal(handleNames.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length, 0);
    } else {
      assert.equal(fs.existsSync(path.join(operationRoot, 'result.json')), true);
      const fixedMappings = handleNames
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(handleRoot, name), 'utf8')));
      assert.equal(
        fixedMappings.filter((mapping) => mapping.operationId === created.record.operationId).length,
        1,
      );
      assert.equal(
        fixedMappings.filter((mapping) => mapping.operationId === otherPublication.operationId).length,
        1,
      );
      assert.equal(operationNames.filter((name) => /^\.status\.json\.tmp-/.test(name)).length, 1);
      const orphanEvents = fs.readFileSync(path.join(operationRoot, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(orphanEvents.map((event) => [event.sequence, event.type]), [[1, 'result_ready']]);
    }

    const retryStore = anotherStore(fixture);
    const recovered = await retryStore.setResult(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      result,
    });
    assert.ok(recovered.resultHandle);
    assert.deepEqual(await retryStore.getResult(created.record.operationId, {
      requesterAgent: 'jerry',
      resultHandle: recovered.resultHandle,
    }), result);
    assert.deepEqual(
      listFilesRecursive(fixture.root).filter((file) => path.basename(file).includes('.tmp-')),
      [],
    );
    const finalHandleFiles = fs.readdirSync(handleRoot)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    const finalMappings = finalHandleFiles
      .map((name) => JSON.parse(fs.readFileSync(path.join(handleRoot, name), 'utf8')));
    assert.equal(
      finalMappings.filter((mapping) => mapping.operationId === created.record.operationId).length,
      1,
    );
    if (otherPublication) {
      assert.equal(
        finalMappings.filter((mapping) => mapping.operationId === otherPublication.operationId).length,
        1,
      );
      assert.deepEqual(await retryStore.getResult(otherPublication.operationId, {
        requesterAgent: 'jerry',
        resultHandle: otherPublication.published.resultHandle,
      }), otherPublication.result);
    } else {
      assert.equal(finalHandleFiles.length, 1);
    }
    assert.deepEqual(
      (await anotherStore(fixture).readEvents(created.record.operationId, 0))
        .map((event) => [event.sequence, event.type]),
      [[1, 'result_ready']],
    );

    const terminal = await retryStore.transition(created.record.operationId, {
      expectedVersion: recovered.recordVersion,
      state: 'complete',
    });
    fixture.clock.now = Date.parse(terminal.metadataExpiresAt) + 1;
    await retryStore.collectGarbage();
    const postGcMappings = fs.existsSync(handleRoot)
      ? fs.readdirSync(handleRoot)
        .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(handleRoot, name), 'utf8')))
      : [];
    assert.equal(
      postGcMappings.filter((mapping) => mapping.operationId === created.record.operationId).length,
      0,
    );
    if (otherPublication) {
      assert.equal(
        postGcMappings.filter((mapping) => mapping.operationId === otherPublication.operationId).length,
        1,
      );
    } else {
      assert.equal(postGcMappings.length, 0);
    }
  }
});

test('post-status-rename durability failure never cleans file result bytes or exposed handle index', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'after_result_status_rename') {
        fail = false;
        throw Object.assign(new Error('status directory fsync uncertain'), { code: 'EIO' });
      }
    },
  });
  const { record } = await createOne(fixture, { requestId: 'result-post-status-rename' });
  await assert.rejects(() => fixture.store.setResult(record.operationId, {
    expectedVersion: record.recordVersion,
    result: { answer: 'u'.repeat(70 * 1024) },
  }), typedCode('durability_uncertain'));
  const published = await anotherStore(fixture).get(record.operationId);
  assert.ok(published.resultHandle);
  assert.equal(fs.existsSync(resultPath(fixture.root, record.operationId)), true);
  const hash = crypto.createHash('sha256').update(published.resultHandle).digest('hex');
  assert.equal(fs.existsSync(path.join(fixture.root, 'result-handles', `${hash}.json`)), true);
  assert.deepEqual(await anotherStore(fixture).getResult(record.operationId, {
    requesterAgent: 'jerry', resultHandle: published.resultHandle,
  }), { answer: 'u'.repeat(70 * 1024) });
});

test('cancellation-first rejects result; result-first can retain evidence in cancelled state', async (t) => {
  const fixture = makeFixture(t);
  const first = await createOne(fixture, { requestId: 'cancel-first' });
  const cancelled = await fixture.store.transition(first.record.operationId, {
    expectedVersion: first.record.recordVersion,
    state: 'cancelled',
  });
  await assert.rejects(() => fixture.store.setResult(first.record.operationId, {
    expectedVersion: first.record.recordVersion,
    result: { late: true },
  }), typedCode('operation_terminal'));
  assert.equal(fs.existsSync(resultPath(fixture.root, first.record.operationId)), false);
  assert.equal((await fixture.store.get(first.record.operationId)).recordVersion, cancelled.recordVersion);

  const second = await createOne(fixture, { requestId: 'result-first' });
  const result = await fixture.store.setResult(second.record.operationId, {
    expectedVersion: second.record.recordVersion,
    result: { evidence: true },
  });
  const laterCancelled = await fixture.store.transition(second.record.operationId, {
    expectedVersion: result.recordVersion,
    state: 'cancelled',
  });
  assert.deepEqual(laterCancelled.result, { evidence: true });
  await assert.rejects(() => fixture.store.transition(second.record.operationId, {
    expectedVersion: result.recordVersion,
    state: 'complete',
  }));
});

test('large-result versus cancel race is deterministic in both lock orders and never publishes late bytes', async (t) => {
  const cancellationFirst = makeFixture(t);
  const cancelledOperation = await createOne(cancellationFirst, { requestId: 'large-cancel-first' });
  const cancelled = await cancellationFirst.store.transition(cancelledOperation.record.operationId, {
    expectedVersion: cancelledOperation.record.recordVersion,
    state: 'cancelled',
  });
  await assert.rejects(() => cancellationFirst.store.setResult(cancelledOperation.record.operationId, {
    expectedVersion: cancelledOperation.record.recordVersion,
    result: { answer: 'x'.repeat(70 * 1024) },
  }), typedCode('operation_terminal'));
  assert.equal(cancelled.recordVersion, (await cancellationFirst.store.get(cancelledOperation.record.operationId)).recordVersion);
  assert.equal(fs.existsSync(resultPath(cancellationFirst.root, cancelledOperation.record.operationId)), false);
  assert.equal(fs.existsSync(path.join(cancellationFirst.root, 'result-handles')), false);

  let enteredResolve;
  let releaseResolve;
  const entered = new Promise((resolve) => { enteredResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const resultFirst = makeFixture(t, {
    crashInjector: async (stage) => {
      if (stage !== 'before_result_rename') return;
      enteredResolve();
      await release;
    },
  });
  const other = anotherStore(resultFirst);
  const created = await createOne(resultFirst, { requestId: 'large-result-first' });
  const resultPromise = resultFirst.store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result: { answer: 'x'.repeat(70 * 1024) },
  });
  await entered;
  const cancelPromise = other.transition(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    state: 'cancelled',
  });
  await new Promise((resolve) => setImmediate(resolve));
  releaseResolve();
  const [resultRace, cancelRace] = await Promise.allSettled([resultPromise, cancelPromise]);
  assert.equal(resultRace.status, 'fulfilled');
  assert.equal(cancelRace.status, 'rejected');
  assert.equal(cancelRace.reason?.code, 'version_conflict');
  const withResult = await resultFirst.store.get(created.record.operationId);
  assert.ok(withResult.resultHandle);
  const finalCancel = await other.transition(created.record.operationId, {
    expectedVersion: withResult.recordVersion,
    state: 'cancelled',
  });
  assert.equal(finalCancel.state, 'cancelled');
  assert.ok(finalCancel.resultHandle);
  await assert.rejects(() => resultFirst.store.transition(created.record.operationId, {
    expectedVersion: withResult.recordVersion,
    state: 'complete',
  }), typedCode('operation_terminal'));
});

test('streaming artifact adoption stays inside operation scratch and exposes no path', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, {
    requestId: 'graph',
    operationType: 'graph_export',
    requestParameters: { format: 'jsonl' },
    parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, record.operationId), 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const scratchPath = path.join(scratch, 'graph.jsonl');
  const bytes = Buffer.from(Array.from({ length: 5000 }, (_, index) =>
    JSON.stringify({ id: index, value: 'x'.repeat(40) }) + '\n').join(''));
  fs.writeFileSync(scratchPath, bytes);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const stored = await fixture.store.adoptResultArtifact(record.operationId, {
    expectedVersion: record.recordVersion,
    scratchPath,
    mediaType: 'application/x-ndjson',
    contentEncoding: 'identity',
    bytes: bytes.length,
    sha256,
  });
  assert.equal(fs.existsSync(scratchPath), false);
  assert.equal(stored.result, null);
  assert.match(stored.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.deepEqual(stored.resultArtifact, {
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length, sha256,
  });
  assert.equal(JSON.stringify(stored).includes(scratchPath), false);
  const opened = await fixture.store.openResultArtifact(record.operationId, {
    requesterAgent: 'jerry', resultHandle: stored.resultHandle,
  });
  assert.deepEqual(opened.metadata, stored.resultArtifact);
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  await assert.rejects(() => fixture.store.openResultArtifact(record.operationId, {
    requesterAgent: 'forrest', resultHandle: stored.resultHandle,
  }), typedCode('access_denied'));
  await assert.rejects(() => fixture.store.adoptResultArtifact(record.operationId, {
    expectedVersion: stored.recordVersion,
    scratchPath,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length, sha256,
  }), typedCode('result_conflict'));
});

test('artifact adoption and reads never materialize artifact bytes with readFile and reject cross-operation handles', async (t) => {
  const fixture = makeFixture(t);
  const first = await createOne(fixture, {
    requestId: 'stream-trap-one', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const second = await createOne(fixture, {
    requestId: 'stream-trap-two', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  async function adopt(created, value) {
    const scratch = path.join(operationDirectory(fixture.root, created.record.operationId), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const source = path.join(scratch, 'graph.jsonl');
    const bytes = Buffer.from(`${JSON.stringify({ value })}\n`.repeat(2000));
    fs.writeFileSync(source, bytes);
    return { source, bytes };
  }
  const firstFixture = await adopt(first, 'one');
  const secondFixture = await adopt(second, 'two');
  const forbidden = new Set([
    firstFixture.source,
    secondFixture.source,
    path.join(operationDirectory(fixture.root, first.record.operationId), 'result.artifact'),
    path.join(operationDirectory(fixture.root, second.record.operationId), 'result.artifact'),
  ]);
  const originalReadFile = fs.promises.readFile;
  fs.promises.readFile = async function trappedReadFile(candidate, ...args) {
    if (forbidden.has(String(candidate))) throw new Error('artifact readFile forbidden');
    return originalReadFile.call(this, candidate, ...args);
  };
  try {
    const firstResult = await fixture.store.adoptResultArtifact(first.record.operationId, {
      expectedVersion: first.record.recordVersion,
      scratchPath: firstFixture.source,
      mediaType: 'application/x-ndjson', contentEncoding: 'identity',
      bytes: firstFixture.bytes.length,
      sha256: crypto.createHash('sha256').update(firstFixture.bytes).digest('hex'),
    });
    const secondResult = await fixture.store.adoptResultArtifact(second.record.operationId, {
      expectedVersion: second.record.recordVersion,
      scratchPath: secondFixture.source,
      mediaType: 'application/x-ndjson', contentEncoding: 'identity',
      bytes: secondFixture.bytes.length,
      sha256: crypto.createHash('sha256').update(secondFixture.bytes).digest('hex'),
    });
    assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, first.record.operationId), 'result.artifact')), true);
    assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, first.record.operationId), 'result.json')), false);
    const opened = await fixture.store.openResultArtifact(first.record.operationId, {
      requesterAgent: 'jerry', resultHandle: firstResult.resultHandle,
    });
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), firstFixture.bytes);
    await assert.rejects(() => fixture.store.openResultArtifact(first.record.operationId, {
      requesterAgent: 'jerry', resultHandle: secondResult.resultHandle,
    }), typedCode('result_handle_invalid'));
    await assert.rejects(() => fixture.store.openResultArtifact(second.record.operationId, {
      requesterAgent: 'jerry', resultHandle: firstResult.resultHandle,
    }), typedCode('result_handle_invalid'));
  } finally {
    fs.promises.readFile = originalReadFile;
  }
});

test('openResultArtifact returns a pre-opened identity-bound stream and metadata exposes corruption hash', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, {
    requestId: 'secure-artifact-open', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, created.record.operationId), 'scratch');
  fs.mkdirSync(scratch);
  const source = path.join(scratch, 'graph.jsonl');
  const original = Buffer.from('{"secure":true}\n'.repeat(100));
  fs.writeFileSync(source, original);
  const stored = await fixture.store.adoptResultArtifact(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: original.length,
    sha256: crypto.createHash('sha256').update(original).digest('hex'),
  });
  const artifactPath = path.join(operationDirectory(fixture.root, created.record.operationId), 'result.artifact');
  const opened = await fixture.store.openResultArtifact(created.record.operationId, {
    requesterAgent: 'jerry', resultHandle: stored.resultHandle,
  });
  assert.equal(Number.isInteger(opened.stream.fd), true);
  assert.equal(opened.stream.path, undefined);
  fs.renameSync(artifactPath, `${artifactPath}.opened`);
  fs.writeFileSync(artifactPath, Buffer.alloc(original.length, 0x78));
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), original);

  fs.rmSync(artifactPath);
  fs.renameSync(`${artifactPath}.opened`, artifactPath);
  const corrupted = Buffer.alloc(original.length, 0x79);
  fs.writeFileSync(artifactPath, corrupted);
  const corruptOpen = await fixture.store.openResultArtifact(created.record.operationId, {
    requesterAgent: 'jerry', resultHandle: stored.resultHandle,
  });
  const corruptChunks = [];
  for await (const chunk of corruptOpen.stream) corruptChunks.push(chunk);
  assert.notEqual(
    crypto.createHash('sha256').update(Buffer.concat(corruptChunks)).digest('hex'),
    corruptOpen.metadata.sha256,
  );

  fs.rmSync(artifactPath);
  fs.symlinkSync(`${artifactPath}.opened`, artifactPath);
  await assert.rejects(() => fixture.store.openResultArtifact(created.record.operationId, {
    requesterAgent: 'jerry', resultHandle: stored.resultHandle,
  }), typedCode('result_corrupt'));
});

test('artifact adoption rejects outside, symlink, directory, metadata mismatch, and unsupported forms', async (t) => {
  const fixture = makeFixture(t);
  const cases = [
    { name: 'outside', mutate: ({ fixture: f }) => path.join(f.root, 'outside.jsonl') },
    { name: 'symlink', setup: ({ scratch, outside }) => {
      const link = path.join(scratch, 'link.jsonl');
      fs.symlinkSync(outside, link);
      return link;
    } },
    { name: 'directory', setup: ({ scratch }) => scratch },
    { name: 'wrong-bytes', input: { bytes: 99 } },
    { name: 'wrong-hash', input: { sha256: '0'.repeat(64) } },
    { name: 'gzip', input: { contentEncoding: 'gzip' } },
    { name: 'media', input: { mediaType: 'application/json' } },
    { name: 'oversize', input: { bytes: OPERATION_RESULT_ARTIFACT_MAX_BYTES + 1 } },
  ];
  for (const item of cases) {
    const { record } = await createOne(fixture, {
      requestId: `artifact-${item.name}`,
      operationType: 'graph_export',
      requestParameters: { format: 'jsonl' },
      parameters: { format: 'jsonl' },
    });
    const scratch = path.join(operationDirectory(fixture.root, record.operationId), 'scratch');
    fs.mkdirSync(scratch, { recursive: true });
    const source = path.join(scratch, 'source.jsonl');
    const outside = path.join(fixture.root, `outside-${item.name}.jsonl`);
    fs.writeFileSync(source, '{"id":1}\n');
    fs.writeFileSync(outside, '{"id":1}\n');
    const sourcePath = item.mutate?.({ fixture, scratch, source, outside })
      ?? item.setup?.({ fixture, scratch, source, outside })
      ?? source;
    const bytes = fs.statSync(source).size;
    const sha256 = crypto.createHash('sha256').update(fs.readFileSync(source)).digest('hex');
    await assert.rejects(() => fixture.store.adoptResultArtifact(record.operationId, {
      expectedVersion: record.recordVersion,
      scratchPath: sourcePath,
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes,
      sha256,
      ...item.input,
    }), typedCode('result_artifact_invalid'), item.name);
    assert.equal((await fixture.store.get(record.operationId)).resultHandle, null);
  }
});

test('artifact fault before rename leaves scratch bytes and no public handle', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_artifact_rename') {
        fail = false;
        throw Object.assign(new Error('injected'), { code: 'injected_crash' });
      }
    },
  });
  const { record } = await createOne(fixture, {
    operationType: 'graph_export',
    requestParameters: { format: 'jsonl' },
    parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, record.operationId), 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  const source = path.join(scratch, 'source.jsonl');
  fs.writeFileSync(source, '{"id":1}\n');
  const content = fs.readFileSync(source);
  await assert.rejects(() => fixture.store.adoptResultArtifact(record.operationId, {
    expectedVersion: record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson',
    contentEncoding: 'identity',
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  }), typedCode('injected_crash'));
  assert.equal(fs.existsSync(source), true);
  assert.equal((await fixture.store.get(record.operationId)).resultHandle, null);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, record.operationId), 'result.artifact')), false);
  assert.deepEqual(
    fs.readdirSync(operationDirectory(fixture.root, record.operationId)).filter((name) => name.includes('.tmp-')),
    [],
  );
  const handles = path.join(fixture.root, 'result-handles');
  assert.equal(fs.existsSync(handles) ? fs.readdirSync(handles).filter((name) => name.endsWith('.json')).length : 0, 0);
});

test('real process crash after artifact verification scavenges the full unpublished temp on exact retry', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, {
    requestId: 'artifact-process-crash-full-temp',
    operationType: 'graph_export',
    requestParameters: { format: 'jsonl' },
    parameters: { format: 'jsonl' },
  });
  const operationRoot = operationDirectory(fixture.root, created.record.operationId);
  const scratch = path.join(operationRoot, 'scratch');
  fs.mkdirSync(scratch);
  const source = path.join(scratch, 'source.jsonl');
  const bytes = Buffer.from('{"verified":true}\n'.repeat(500));
  fs.writeFileSync(source, bytes);
  const input = {
    expectedVersion: created.record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson',
    contentEncoding: 'identity',
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const statusBefore = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
  await crashArtifactAdoption(
    fixture.root,
    created.record.operationId,
    input,
    'after_artifact_verify',
  );
  ageCrashLocks(fixture.root, created.record.operationId);
  assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), statusBefore);
  assert.equal(fs.existsSync(path.join(operationRoot, 'result.artifact')), false);
  assert.equal(fs.existsSync(source), true);
  assert.equal(
    fs.readdirSync(operationRoot).filter((name) => /^\.result\.artifact\.tmp-/.test(name)).length,
    1,
  );

  const recovered = await anotherStore(fixture).adoptResultArtifact(
    created.record.operationId,
    input,
  );
  assert.ok(recovered.resultHandle);
  assert.equal(fs.existsSync(source), false);
  assert.deepEqual(
    listFilesRecursive(fixture.root).filter((file) => path.basename(file).includes('.tmp-')),
    [],
  );
  const handleRoot = path.join(fixture.root, 'result-handles');
  assert.equal(fs.readdirSync(handleRoot).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
  assert.deepEqual(
    (await anotherStore(fixture).readEvents(created.record.operationId, 0))
      .map((event) => [event.sequence, event.type]),
    [[1, 'result_ready']],
  );
});

test('real process crashes during artifact handle and status publication recover exact orphan authority', async (t) => {
  for (const [index, crashStage] of [
    'before_result_handle_index_rename',
    'before_status_rename',
  ].entries()) {
    const fixture = makeFixture(t);
    const created = await createOne(fixture, {
      requestId: `artifact-process-crash-${index}`,
      operationType: 'graph_export',
      requestParameters: { format: 'jsonl' },
      parameters: { format: 'jsonl' },
    });
    const operationRoot = operationDirectory(fixture.root, created.record.operationId);
    const scratch = path.join(operationRoot, 'scratch');
    fs.mkdirSync(scratch);
    const source = path.join(scratch, 'source.jsonl');
    const bytes = Buffer.from(`${JSON.stringify({ crashStage, value: 'x'.repeat(80) })}\n`.repeat(200));
    fs.writeFileSync(source, bytes);
    const input = {
      expectedVersion: created.record.recordVersion,
      scratchPath: source,
      mediaType: 'application/x-ndjson',
      contentEncoding: 'identity',
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
    const statusBefore = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
    await crashArtifactAdoption(
      fixture.root,
      created.record.operationId,
      input,
      crashStage,
    );
    ageCrashLocks(fixture.root, created.record.operationId);

    const artifactPath = path.join(operationRoot, 'result.artifact');
    assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), statusBefore);
    assert.deepEqual(fs.readFileSync(artifactPath), bytes);
    assert.equal(fs.existsSync(source), true);
    const orphanInode = fs.lstatSync(artifactPath).ino;
    const handleRoot = path.join(fixture.root, 'result-handles');
    const handleNames = fs.readdirSync(handleRoot);
    if (crashStage === 'before_result_handle_index_rename') {
      assert.equal(handleNames.filter((name) => /^\.[a-f0-9]{64}\.json\.tmp-/.test(name)).length, 1);
      assert.equal(handleNames.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length, 0);
      assert.equal(fs.existsSync(path.join(operationRoot, 'events.jsonl')), false);
    } else {
      assert.equal(handleNames.filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length, 1);
      assert.equal(handleNames.filter((name) => /^\.[a-f0-9]{64}\.json\.tmp-/.test(name)).length, 0);
      const orphanEvents = fs.readFileSync(path.join(operationRoot, 'events.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(orphanEvents.map((event) => [event.sequence, event.type]), [[1, 'result_ready']]);
      assert.equal(fs.readdirSync(operationRoot).filter((name) => /^\.status\.json\.tmp-/.test(name)).length, 1);
    }

    const retryStore = anotherStore(fixture);
    const differentBytes = Buffer.from('{"different":true}\n'.repeat(50));
    fs.writeFileSync(source, differentBytes);
    await assert.rejects(
      () => retryStore.adoptResultArtifact(created.record.operationId, {
        ...input,
        bytes: differentBytes.length,
        sha256: crypto.createHash('sha256').update(differentBytes).digest('hex'),
      }),
      typedCode('result_conflict'),
    );
    assert.equal((await retryStore.get(created.record.operationId)).resultHandle, null);
    assert.equal(fs.lstatSync(artifactPath).ino, orphanInode);
    assert.deepEqual(fs.readFileSync(artifactPath), bytes);

    fs.writeFileSync(source, bytes);
    const recovered = await retryStore.adoptResultArtifact(created.record.operationId, input);
    assert.equal(fs.lstatSync(artifactPath).ino, orphanInode);
    assert.equal(fs.existsSync(source), false);
    assert.deepEqual(recovered.resultArtifact, {
      mediaType: input.mediaType,
      contentEncoding: input.contentEncoding,
      bytes: input.bytes,
      sha256: input.sha256,
    });
    const recoveredEvents = await anotherStore(fixture).readEvents(created.record.operationId, 0);
    assert.deepEqual(recoveredEvents.map((event) => [event.sequence, event.type]), [[1, 'result_ready']]);
    assert.deepEqual(
      listFilesRecursive(fixture.root).filter((file) => path.basename(file).includes('.tmp-')),
      [],
    );
    const finalHandleFiles = fs.readdirSync(handleRoot)
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    assert.equal(finalHandleFiles.length, 1);
    const mapping = JSON.parse(fs.readFileSync(path.join(handleRoot, finalHandleFiles[0]), 'utf8'));
    assert.equal(mapping.operationId, created.record.operationId);
    const opened = await retryStore.openResultArtifact(created.record.operationId, {
      requesterAgent: 'jerry',
      resultHandle: recovered.resultHandle,
    });
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
  }
});

test('post-status-rename durability failure never restores or deletes an exposed artifact result', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'after_artifact_status_rename') {
        fail = false;
        throw Object.assign(new Error('artifact status durability uncertain'), { code: 'EIO' });
      }
    },
  });
  const { record } = await createOne(fixture, {
    requestId: 'artifact-post-status-rename', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, record.operationId), 'scratch');
  fs.mkdirSync(scratch);
  const source = path.join(scratch, 'source.jsonl');
  const bytes = Buffer.from('{"durability":"uncertain"}\n'.repeat(100));
  fs.writeFileSync(source, bytes);
  await assert.rejects(() => fixture.store.adoptResultArtifact(record.operationId, {
    expectedVersion: record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }), typedCode('durability_uncertain'));
  const published = await anotherStore(fixture).get(record.operationId);
  assert.ok(published.resultHandle);
  const artifactPath = path.join(operationDirectory(fixture.root, record.operationId), 'result.artifact');
  assert.equal(fs.existsSync(artifactPath), true);
  const opened = await anotherStore(fixture).openResultArtifact(record.operationId, {
    requesterAgent: 'jerry', resultHandle: published.resultHandle,
  });
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('artifact adoption binds the streamed inode across verify-to-rename path replacement', async (t) => {
  let source;
  let swapped = false;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (stage !== 'after_artifact_verify' || swapped) return;
      swapped = true;
      const original = fs.readFileSync(source);
      fs.renameSync(source, `${source}.verified`);
      fs.writeFileSync(source, Buffer.alloc(original.length, 0x7a));
    },
  });
  const { record } = await createOne(fixture, {
    requestId: 'artifact-inode-swap',
    operationType: 'graph_export',
    requestParameters: { format: 'jsonl' },
    parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, record.operationId), 'scratch');
  fs.mkdirSync(scratch, { recursive: true });
  source = path.join(scratch, 'source.jsonl');
  const verified = Buffer.from('{"verified":true}\n');
  fs.writeFileSync(source, verified);

  await assert.rejects(() => fixture.store.adoptResultArtifact(record.operationId, {
    expectedVersion: record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson',
    contentEncoding: 'identity',
    bytes: verified.length,
    sha256: crypto.createHash('sha256').update(verified).digest('hex'),
  }), typedCode('result_artifact_invalid'));
  assert.equal(swapped, true);
  assert.equal((await fixture.store.get(record.operationId)).resultHandle, null);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, record.operationId), 'result.artifact')), false);
});

test('artifact adoption rejects cross-operation hardlinks and never publishes a shared inode', async (t) => {
  const fixture = makeFixture(t);
  const first = await createOne(fixture, {
    requestId: 'artifact-hardlink-first', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const second = await createOne(fixture, {
    requestId: 'artifact-hardlink-second', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const firstScratch = path.join(operationDirectory(fixture.root, first.record.operationId), 'scratch');
  const secondScratch = path.join(operationDirectory(fixture.root, second.record.operationId), 'scratch');
  fs.mkdirSync(firstScratch);
  fs.mkdirSync(secondScratch);
  const source = path.join(firstScratch, 'shared.jsonl');
  const linked = path.join(secondScratch, 'shared.jsonl');
  const bytes = Buffer.from('{"shared":true}\n'.repeat(50));
  fs.writeFileSync(source, bytes);
  fs.linkSync(source, linked);
  assert.equal(fs.lstatSync(source).nlink, 2);
  await assert.rejects(() => fixture.store.adoptResultArtifact(second.record.operationId, {
    expectedVersion: second.record.recordVersion,
    scratchPath: linked,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }), typedCode('result_artifact_invalid'));
  assert.equal((await fixture.store.get(second.record.operationId)).resultHandle, null);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, second.record.operationId), 'result.artifact')), false);
});

test('artifact adoption copies into a new private inode immune to retained writable source descriptors', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, {
    requestId: 'artifact-private-inode', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, created.record.operationId), 'scratch');
  fs.mkdirSync(scratch);
  const source = path.join(scratch, 'source.jsonl');
  const bytes = Buffer.from('{"immutable":true}\n'.repeat(100));
  fs.writeFileSync(source, bytes);
  const retained = fs.openSync(source, 'r+');
  const sourceInode = fs.fstatSync(retained).ino;
  try {
    const stored = await fixture.store.adoptResultArtifact(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      scratchPath: source,
      mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    });
    const artifactPath = path.join(operationDirectory(fixture.root, created.record.operationId), 'result.artifact');
    assert.notEqual(fs.lstatSync(artifactPath).ino, sourceInode);
    fs.writeSync(retained, Buffer.alloc(bytes.length, 0x6d), 0, bytes.length, 0);
    fs.fsyncSync(retained);
    const opened = await fixture.store.openResultArtifact(created.record.operationId, {
      requesterAgent: 'jerry', resultHandle: stored.resultHandle,
    });
    const chunks = [];
    for await (const chunk of opened.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes);
  } finally {
    fs.closeSync(retained);
  }
});

test('post-verify in-place source mutation aborts artifact publication', async (t) => {
  let source;
  let mutated = false;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (stage !== 'after_artifact_verify' || mutated) return;
      mutated = true;
      const original = fs.readFileSync(source);
      fs.writeFileSync(source, Buffer.alloc(original.length, 0x71));
    },
  });
  const created = await createOne(fixture, {
    requestId: 'artifact-post-verify-mutation', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const scratch = path.join(operationDirectory(fixture.root, created.record.operationId), 'scratch');
  fs.mkdirSync(scratch);
  source = path.join(scratch, 'source.jsonl');
  const bytes = Buffer.from('{"verified":true}\n'.repeat(100));
  fs.writeFileSync(source, bytes);
  await assert.rejects(() => fixture.store.adoptResultArtifact(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }), typedCode('result_artifact_invalid'));
  assert.equal(mutated, true);
  assert.equal((await fixture.store.get(created.record.operationId)).resultHandle, null);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, created.record.operationId), 'result.artifact')), false);
});

test('store commits fail closed when parent-directory fsync fails', async (t) => {
  const fixture = makeFixture(t);
  const { record } = await createOne(fixture, { requestId: 'strict-directory-fsync' });
  const operationDir = operationDirectory(fixture.root, record.operationId);
  const originalOpen = fs.promises.open;
  fs.promises.open = async function injectedOpen(candidate, flags, ...args) {
    if (candidate === operationDir && flags === 'r') {
      const error = new Error('injected directory fsync failure');
      error.code = 'EIO';
      throw error;
    }
    return originalOpen.call(this, candidate, flags, ...args);
  };
  try {
    await assert.rejects(
      () => fixture.store.appendEvent(record.operationId, { type: 'heartbeat' }),
      (error) => error?.code === 'EIO',
    );
  } finally {
    fs.promises.open = originalOpen;
  }
});

test('seven-day GC retires terminal payloads but never nonterminal data', async (t) => {
  const fixture = makeFixture(t);
  const inline = await createOne(fixture, { requestId: 'gc-inline' });
  const inlineResult = await fixture.store.setResult(inline.record.operationId, {
    expectedVersion: inline.record.recordVersion,
    result: { answer: 'inline' },
  });
  const inlineTerminal = await fixture.store.transition(inline.record.operationId, {
    expectedVersion: inlineResult.recordVersion,
    state: 'complete',
  });

  const large = await createOne(fixture, { requestId: 'gc-large' });
  const largeResult = await fixture.store.setResult(large.record.operationId, {
    expectedVersion: large.record.recordVersion,
    result: { answer: 'x'.repeat(70 * 1024) },
  });
  fs.mkdirSync(path.join(operationDirectory(fixture.root, large.record.operationId), 'scratch'), { recursive: true });
  fs.writeFileSync(path.join(operationDirectory(fixture.root, large.record.operationId), 'scratch', 'temp'), 'scratch');
  const largeTerminal = await fixture.store.transition(large.record.operationId, {
    expectedVersion: largeResult.recordVersion,
    state: 'partial',
    error: { code: 'partial', message: 'partial evidence retained', retryable: true },
    sourceEvidence: { revision: 1 },
  });

  const nonterminal = await createOne(fixture, { requestId: 'gc-running' });
  const nonterminalResult = await fixture.store.setResult(nonterminal.record.operationId, {
    expectedVersion: nonterminal.record.recordVersion,
    result: { answer: 'x'.repeat(70 * 1024) },
  });
  fixture.clock.now = Date.parse(inlineTerminal.resultExpiresAt) + 1;
  const receipt = await fixture.store.collectGarbage();
  assert.ok(receipt.resultsExpired >= 2);

  const inlineAfter = await fixture.store.get(inline.record.operationId);
  assert.equal(inlineAfter.result, null);
  assert.ok(inlineAfter.resultExpiredAt);
  await assert.rejects(() => fixture.store.getResult(inline.record.operationId, {
    requesterAgent: 'jerry', resultHandle: null,
  }), typedCode('result_expired'));
  assert.equal(fs.existsSync(resultPath(fixture.root, large.record.operationId)), false);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, large.record.operationId), 'scratch')), false);
  const largeAfter = await fixture.store.get(large.record.operationId);
  assert.equal(largeAfter.state, 'partial');
  assert.deepEqual(largeAfter.error, largeTerminal.error);
  assert.deepEqual(largeAfter.sourceEvidence, largeTerminal.sourceEvidence);
  await assert.rejects(() => fixture.store.getResult(large.record.operationId, {
    requesterAgent: 'jerry', resultHandle: largeResult.resultHandle,
  }), typedCode('result_expired'));

  assert.equal(fs.existsSync(resultPath(fixture.root, nonterminal.record.operationId)), true);
  assert.equal((await fixture.store.get(nonterminal.record.operationId)).recordVersion, nonterminalResult.recordVersion);
});

test('retention timestamps and GC cover inline, JSON, artifact, scratch, handle indexes, and exact boundaries', async (t) => {
  const fixture = makeFixture(t);
  const terminalRows = [];

  const inline = await createOne(fixture, { requestId: 'retention-inline' });
  const inlineResult = await fixture.store.setResult(inline.record.operationId, {
    expectedVersion: inline.record.recordVersion, result: { inline: true },
  });
  terminalRows.push(await fixture.store.transition(inline.record.operationId, {
    expectedVersion: inlineResult.recordVersion, state: 'complete',
  }));

  const json = await createOne(fixture, { requestId: 'retention-json' });
  const jsonResult = await fixture.store.setResult(json.record.operationId, {
    expectedVersion: json.record.recordVersion, result: { answer: 'j'.repeat(70 * 1024) },
  });
  terminalRows.push(await fixture.store.transition(json.record.operationId, {
    expectedVersion: jsonResult.recordVersion, state: 'complete',
  }));

  const artifact = await createOne(fixture, {
    requestId: 'retention-artifact', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const artifactScratch = path.join(operationDirectory(fixture.root, artifact.record.operationId), 'scratch');
  fs.mkdirSync(artifactScratch, { recursive: true });
  const artifactSource = path.join(artifactScratch, 'graph.jsonl');
  const artifactBytes = Buffer.from('{"id":1}\n'.repeat(100));
  fs.writeFileSync(artifactSource, artifactBytes);
  const artifactResult = await fixture.store.adoptResultArtifact(artifact.record.operationId, {
    expectedVersion: artifact.record.recordVersion,
    scratchPath: artifactSource,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity',
    bytes: artifactBytes.length,
    sha256: crypto.createHash('sha256').update(artifactBytes).digest('hex'),
  });
  fs.writeFileSync(path.join(artifactScratch, 'scratch-extra'), 'temporary');
  terminalRows.push(await fixture.store.transition(artifact.record.operationId, {
    expectedVersion: artifactResult.recordVersion, state: 'partial',
  }));

  for (const terminal of terminalRows) {
    assert.equal(Date.parse(terminal.resultExpiresAt), Date.parse(terminal.completedAt) + 7 * DAY);
    assert.equal(Date.parse(terminal.metadataExpiresAt), Date.parse(terminal.completedAt) + 30 * DAY);
  }
  fixture.clock.now = Date.parse(terminalRows[0].resultExpiresAt) - 1;
  assert.deepEqual(await fixture.store.collectGarbage(), { resultsExpired: 0, metadataDeleted: 0 });
  assert.equal(fs.existsSync(resultPath(fixture.root, json.record.operationId)), true);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, artifact.record.operationId), 'result.artifact')), true);

  fixture.clock.now += 1;
  const expired = await fixture.store.collectGarbage();
  assert.equal(expired.resultsExpired, 3);
  assert.equal(fs.existsSync(resultPath(fixture.root, json.record.operationId)), false);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, artifact.record.operationId), 'result.artifact')), false);
  assert.equal(fs.existsSync(artifactScratch), false);
  for (const handle of [jsonResult.resultHandle, artifactResult.resultHandle]) {
    const hash = crypto.createHash('sha256').update(handle).digest('hex');
    assert.equal(fs.existsSync(path.join(fixture.root, 'result-handles', `${hash}.json`)), false);
  }
  assert.deepEqual((await fixture.store.get(artifact.record.operationId)).resultArtifact, artifactResult.resultArtifact);
  await assert.rejects(() => fixture.store.openResultArtifact(artifact.record.operationId, {
    requesterAgent: 'jerry', resultHandle: artifactResult.resultHandle,
  }), typedCode('result_expired'));

  fixture.clock.now = Date.parse(terminalRows[0].metadataExpiresAt);
  const removed = await fixture.store.collectGarbage();
  assert.equal(removed.metadataDeleted, 3);
  for (const operationId of [inline.record.operationId, json.record.operationId, artifact.record.operationId]) {
    assert.equal(fs.existsSync(operationDirectory(fixture.root, operationId)), false);
  }
});

test('nonterminal file and artifact payloads plus scratch survive far beyond retention windows', async (t) => {
  const fixture = makeFixture(t);
  const inline = await createOne(fixture, { requestId: 'nonterminal-inline-retention' });
  const inlineResult = await fixture.store.setResult(inline.record.operationId, {
    expectedVersion: inline.record.recordVersion,
    result: { answer: 'inline-stays' },
  });
  const json = await createOne(fixture, { requestId: 'nonterminal-json-retention' });
  const jsonResult = await fixture.store.setResult(json.record.operationId, {
    expectedVersion: json.record.recordVersion,
    result: { answer: 'n'.repeat(70 * 1024) },
  });
  const jsonScratch = path.join(operationDirectory(fixture.root, json.record.operationId), 'scratch');
  fs.mkdirSync(jsonScratch);
  fs.writeFileSync(path.join(jsonScratch, 'keep'), 'keep');

  const artifact = await createOne(fixture, {
    requestId: 'nonterminal-artifact-retention', operationType: 'graph_export',
    requestParameters: { format: 'jsonl' }, parameters: { format: 'jsonl' },
  });
  const artifactScratch = path.join(operationDirectory(fixture.root, artifact.record.operationId), 'scratch');
  fs.mkdirSync(artifactScratch);
  const source = path.join(artifactScratch, 'graph.jsonl');
  const bytes = Buffer.from('{"keep":true}\n');
  fs.writeFileSync(source, bytes);
  const artifactResult = await fixture.store.adoptResultArtifact(artifact.record.operationId, {
    expectedVersion: artifact.record.recordVersion,
    scratchPath: source,
    mediaType: 'application/x-ndjson', contentEncoding: 'identity', bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
  fixture.clock.now += 100 * DAY;
  assert.deepEqual(await fixture.store.collectGarbage(), { resultsExpired: 0, metadataDeleted: 0 });
  assert.deepEqual(await fixture.store.getResult(inline.record.operationId, {
    requesterAgent: 'jerry', resultHandle: inlineResult.resultHandle,
  }), { answer: 'inline-stays' });
  assert.equal(fs.existsSync(resultPath(fixture.root, json.record.operationId)), true);
  assert.equal(fs.existsSync(jsonScratch), true);
  assert.equal(fs.existsSync(path.join(operationDirectory(fixture.root, artifact.record.operationId), 'result.artifact')), true);
  assert.deepEqual(await fixture.store.getResult(json.record.operationId, {
    requesterAgent: 'jerry', resultHandle: jsonResult.resultHandle,
  }), { answer: 'n'.repeat(70 * 1024) });
  const opened = await fixture.store.openResultArtifact(artifact.record.operationId, {
    requesterAgent: 'jerry', resultHandle: artifactResult.resultHandle,
  });
  const chunks = [];
  for await (const chunk of opened.stream) chunks.push(chunk);
  assert.deepEqual(Buffer.concat(chunks), bytes);
});

test('result GC pre-marker failure leaves public status, bytes, handle index, and scratch untouched', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_gc_result_marker_rename') {
        fail = false;
        throw Object.assign(new Error('gc marker pre-rename crash'), { code: 'injected_crash' });
      }
    },
  });
  const created = await createOne(fixture, { requestId: 'gc-result-pre-marker' });
  const stored = await fixture.store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result: { answer: 'g'.repeat(70 * 1024) },
  });
  const scratch = path.join(operationDirectory(fixture.root, created.record.operationId), 'scratch');
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, 'keep'), 'keep');
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: stored.recordVersion,
    state: 'complete',
  });
  const before = fs.readFileSync(statusPath(fixture.root, created.record.operationId));
  const handleHash = crypto.createHash('sha256').update(stored.resultHandle).digest('hex');
  fixture.clock.now = Date.parse(terminal.resultExpiresAt);
  await assert.rejects(() => fixture.store.collectGarbage(), typedCode('injected_crash'));
  assert.deepEqual(fs.readFileSync(statusPath(fixture.root, created.record.operationId)), before);
  assert.equal(fs.existsSync(resultPath(fixture.root, created.record.operationId)), true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'result-handles', `${handleHash}.json`)), true);
  assert.equal(fs.existsSync(scratch), true);
});

test('result GC post-marker crash exposes expired status before deleting and resumes cleanup after reload', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'after_gc_result_marker') {
        fail = false;
        throw Object.assign(new Error('gc post-marker crash'), { code: 'injected_crash' });
      }
    },
  });
  const created = await createOne(fixture, { requestId: 'gc-result-post-marker' });
  const stored = await fixture.store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result: { answer: 'p'.repeat(70 * 1024) },
  });
  const scratch = path.join(operationDirectory(fixture.root, created.record.operationId), 'scratch');
  fs.mkdirSync(scratch);
  fs.writeFileSync(path.join(scratch, 'pending'), 'pending');
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: stored.recordVersion,
    state: 'complete',
  });
  const handleHash = crypto.createHash('sha256').update(stored.resultHandle).digest('hex');
  fixture.clock.now = Date.parse(terminal.resultExpiresAt);
  await assert.rejects(() => fixture.store.collectGarbage(), typedCode('injected_crash'));
  const marked = await anotherStore(fixture).get(created.record.operationId);
  assert.ok(marked.resultExpiredAt);
  assert.equal(marked.resultHandle, null);
  assert.equal(fs.existsSync(resultPath(fixture.root, created.record.operationId)), true);
  assert.equal(fs.existsSync(path.join(fixture.root, 'result-handles', `${handleHash}.json`)), true);
  assert.equal(fs.existsSync(scratch), true);
  const privateMarked = JSON.parse(fs.readFileSync(statusPath(fixture.root, created.record.operationId), 'utf8'));
  assert.deepEqual(privateMarked._resultCleanup, {
    handle: stored.resultHandle,
    kind: 'json-file',
    markedAt: marked.resultExpiredAt,
  });

  const receipt = await anotherStore(fixture).collectGarbage();
  assert.equal(receipt.resultsExpired, 1);
  assert.equal(fs.existsSync(resultPath(fixture.root, created.record.operationId)), false);
  assert.equal(fs.existsSync(path.join(fixture.root, 'result-handles', `${handleHash}.json`)), false);
  assert.equal(fs.existsSync(scratch), false);
  const cleaned = JSON.parse(fs.readFileSync(statusPath(fixture.root, created.record.operationId), 'utf8'));
  assert.equal(cleaned._resultCleanup, null);
});

test('day-30 GC removes metadata and idempotency only after source pin release', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'gc-pinned' });
  const descriptor = validDescriptor();
  const pinned = await fixture.store.attachSourcePin(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: pinned.recordVersion,
    state: 'complete',
  });
  fixture.clock.now = Date.parse(terminal.metadataExpiresAt) + 1;
  await fixture.store.collectGarbage();
  assert.equal(fs.existsSync(operationDirectory(fixture.root, created.record.operationId)), true);
  assert.equal((await fixture.store.listPinsPendingRelease()).length, 1);

  let calls = 0;
  const released = await Promise.all(Array.from({ length: 16 }, () =>
    fixture.store.releaseSourcePinOnce(created.record.operationId, new Date(fixture.clock.now).toISOString(), async () => {
      calls += 1;
    })));
  assert.equal(calls, 1);
  assert.equal(new Set(released.map((row) => row.sourcePinReleasedAt)).size, 1);
  await fixture.store.collectGarbage();
  assert.equal(fs.existsSync(operationDirectory(fixture.root, created.record.operationId)), false);

  const retry = await createOne(fixture, { requestId: 'gc-pinned' });
  assert.equal(retry.created, true);
  assert.notEqual(retry.record.operationId, created.record.operationId);
});

test('source-pin release crash after callback but before marker retries the idempotent provider callback', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_source_pin_release_status_rename') {
        fail = false;
        throw Object.assign(new Error('release marker crash'), { code: 'injected_crash' });
      }
    },
  });
  const created = await createOne(fixture, { requestId: 'release-marker-crash' });
  const descriptor = validDescriptor();
  const pinned = await fixture.store.attachSourcePin(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    descriptor,
    digest: descriptorDigest(descriptor),
  });
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: pinned.recordVersion,
    state: 'failed',
  });
  let callbacks = 0;
  const release = async () => { callbacks += 1; };
  await assert.rejects(
    () => fixture.store.releaseSourcePinOnce(
      created.record.operationId,
      terminal.completedAt,
      release,
    ),
    typedCode('injected_crash'),
  );
  assert.equal(callbacks, 1);
  assert.equal((await anotherStore(fixture).get(created.record.operationId)).sourcePinReleasedAt, null);
  const released = await anotherStore(fixture).releaseSourcePinOnce(
    created.record.operationId,
    terminal.completedAt,
    release,
  );
  assert.equal(callbacks, 2);
  assert.equal(released.sourcePinReleasedAt, terminal.completedAt);
});

test('metadata GC resumes a durable delete marker after an index-publication crash', async (t) => {
  let fail = true;
  const fixture = makeFixture(t, {
    crashInjector: async (stage) => {
      if (fail && stage === 'before_gc_index_rename') {
        fail = false;
        throw Object.assign(new Error('gc index crash'), { code: 'injected_crash' });
      }
    },
  });
  const created = await createOne(fixture, { requestId: 'gc-delete-resume' });
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    state: 'complete',
  });
  fixture.clock.now = Date.parse(terminal.metadataExpiresAt);
  await assert.rejects(() => fixture.store.collectGarbage(), typedCode('injected_crash'));
  const privateRecord = JSON.parse(fs.readFileSync(statusPath(fixture.root, created.record.operationId), 'utf8'));
  assert.equal(privateRecord._deleting, true);
  assert.equal(fs.existsSync(operationDirectory(fixture.root, created.record.operationId)), true);

  const reloaded = anotherStore(fixture);
  const receipt = await reloaded.collectGarbage();
  assert.equal(receipt.metadataDeleted, 1);
  assert.equal(fs.existsSync(operationDirectory(fixture.root, created.record.operationId)), false);
  const retry = await reloaded.create(validRequest({ requestId: 'gc-delete-resume' }));
  assert.equal(retry.created, true);
});

test('metadata GC resumes after operation-delete crash without removing a reused idempotency key', async (t) => {
  const fixture = makeFixture(t);
  const created = await createOne(fixture, { requestId: 'gc-delete-reused-key' });
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    state: 'complete',
  });
  fixture.clock.now = Date.parse(terminal.metadataExpiresAt) + 1;
  await crashCollectGarbage(fixture.root, fixture.clock.now, 'before_gc_operation_rm');
  ageCrashLocks(fixture.root, created.record.operationId);
  const deleting = JSON.parse(fs.readFileSync(statusPath(fixture.root, created.record.operationId), 'utf8'));
  assert.equal(deleting._deleting, true);
  const replacement = await fixture.store.create(validRequest({ requestId: 'gc-delete-reused-key' }));
  assert.equal(replacement.created, true);
  assert.notEqual(replacement.record.operationId, created.record.operationId);

  const receipt = await anotherStore(fixture).collectGarbage();
  assert.equal(receipt.metadataDeleted, 1);
  assert.equal(fs.existsSync(operationDirectory(fixture.root, created.record.operationId)), false);
  assert.equal(fs.existsSync(operationDirectory(fixture.root, replacement.record.operationId)), true);
  const key = buildBrainOperationIdempotencyKey('jerry', 'gc-delete-reused-key', 'query');
  const found = await anotherStore(fixture).findByIdempotencyKey(key);
  assert.equal(found.operationId, replacement.record.operationId);
});

test('non-source operations remain null-pinned through terminalization and reconciliation lists', async (t) => {
  const fixture = makeFixture(t);
  const first = await createOne(fixture, { requestId: 'non-source' });
  const terminal = await fixture.store.transition(first.record.operationId, {
    expectedVersion: first.record.recordVersion,
    state: 'failed',
    error: { code: 'worker_failed', message: 'worker failed', retryable: false },
  });
  assert.equal(terminal.sourcePinDescriptor, null);
  assert.equal(terminal.sourcePinDigest, null);
  assert.equal((await fixture.store.listPinsPendingRelease()).length, 0);

  const second = await createOne(fixture, { requestId: 'still-running' });
  const nonterminal = await fixture.store.listNonterminal();
  assert.deepEqual(nonterminal.map((row) => row.operationId), [second.record.operationId]);
});
