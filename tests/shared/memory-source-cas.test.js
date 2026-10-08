import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  appendMemoryRevision,
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  enumerateMemoryMutationBoundaries,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function makeManifestBrain(brainDir) {
  await fsp.mkdir(brainDir, { recursive: true });
  const nodes = await writeJsonlGzAtomic(path.join(brainDir, 'nodes.gz'), [
    { id: 'n1', concept: 'trusted CAS canary' },
  ]);
  const edges = await writeJsonlGzAtomic(path.join(brainDir, 'edges.gz'), []);
  await fsp.writeFile(path.join(brainDir, 'delta.jsonl'), '');
  await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 2,
    currentRevision: 2,
    activeDeltaEpoch: 'e1',
    activeBase: {
      nodes: { file: 'nodes.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'edges.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: {
      epoch: 'e1',
      file: 'delta.jsonl',
      fromRevision: 3,
      toRevision: 2,
      count: 0,
      committedBytes: 0,
    },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 2 },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, null, 2)}\n`);
}

async function makeLegacyBrain(brainDir) {
  await fsp.mkdir(brainDir, { recursive: true });
  await writeJsonlGzAtomic(path.join(brainDir, 'memory-nodes.jsonl.gz'), [
    { id: 'n1', concept: 'legacy canary' },
  ]);
  await writeJsonlGzAtomic(path.join(brainDir, 'memory-edges.jsonl.gz'), []);
  await fsp.writeFile(path.join(brainDir, 'memory-delta.jsonl'), '');
}

async function fixture(t, {
  requesterAgent = 'jerry',
  ownerAgent = requesterAgent,
  operationType = 'synthesis',
  accessMode = ownerAgent === requesterAgent ? 'own' : 'read-only',
  legacy = false,
  statusTransform = (record) => record,
  operationId = `brop_cas_${ownerAgent}_${operationType}`,
} = {}) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-memory-source-cas-'));
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const brainDir = path.join(home23Root, 'instances', ownerAgent, 'brain');
  if (legacy) await makeLegacyBrain(brainDir);
  else await makeManifestBrain(brainDir);
  const canonicalRoot = await fsp.realpath(brainDir);
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent });
  const pinned = await provider.pin(canonicalRoot, operationId);
  const operationRoot = path.join(
    home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations', 'operations', operationId,
  );
  await fsp.mkdir(operationRoot, { recursive: true });
  const status = statusTransform({
    operationId,
    requesterAgent,
    operationType,
    state: 'running',
    target: {
      domain: 'brain',
      brainId: `brain-${ownerAgent}`,
      canonicalRoot,
      accessMode,
      ownerAgent,
      displayName: ownerAgent,
      kind: 'resident',
      lifecycle: 'resident',
      catalogRevision: 'catalog-test',
      route: `agent:${ownerAgent}`,
      mutationBoundaries: enumerateMemoryMutationBoundaries(canonicalRoot),
    },
    sourcePinDescriptor: pinned.descriptor,
    sourcePinDigest: pinned.digest,
    sourcePinReleasedAt: null,
    _deleting: false,
  });
  await fsp.writeFile(path.join(operationRoot, 'status.json'), `${JSON.stringify(status)}\n`, {
    mode: 0o600,
  });
  const scratchQuota = await createOperationScratchQuota({ operationRoot });
  const source = await provider.openPinnedSource(pinned.descriptor, {
    operationId,
    operationType,
    operationRoot,
    scratchQuota,
    expectedCanonicalRoot: canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
  });
  t.after(async () => {
    await source.release().catch(() => {});
    await Promise.resolve(scratchQuota.close()).catch(() => {});
  });
  return {
    home23Root,
    brainDir,
    canonicalRoot,
    operationId,
    operationRoot,
    pinned,
    provider,
    scratchQuota,
    source,
  };
}

test('trusted own-brain synthesis source delegates an exact durable source CAS', async (t) => {
  const fx = await fixture(t);
  const statePath = path.join(fx.brainDir, 'brain-state.json');
  const value = `${JSON.stringify({ generationMarker: 'generation-2-test', sourceRevision: 2 })}\n`;
  let commits = 0;

  const result = await fx.source.compareAndSwap(async () => {
    commits += 1;
    const temporary = `${statePath}.tmp`;
    await fsp.writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await fsp.rename(temporary, statePath);
    return 'published';
  });

  assert.equal(result.committed, true);
  assert.equal(result.value, 'published');
  assert.equal(result.manifest.generation, fx.pinned.descriptor.generation);
  assert.equal(result.manifest.currentRevision, fx.pinned.descriptor.cutoffRevision);
  assert.equal(commits, 1);
  assert.equal(await fsp.readFile(statePath, 'utf8'), value);
});

test('authorized queued synthesis remains writable across the local worker start boundary', async (t) => {
  const fx = await fixture(t, {
    statusTransform(record) {
      record.state = 'queued';
      return record;
    },
  });
  let commits = 0;
  const result = await fx.source.compareAndSwap(async () => { commits += 1; });
  assert.equal(result.committed, true);
  assert.equal(commits, 1);
});

test('stale pinned revision returns source_changed without invoking the mutation', async (t) => {
  const fx = await fixture(t);
  const lockRoot = path.join(fx.home23Root, 'runtime', 'brain-source-locks');
  await appendMemoryRevision(fx.brainDir, {
    nodes: [{ id: 'n2', concept: 'newer source' }],
  }, {
    lockRoot,
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  let commits = 0;
  const result = await fx.source.compareAndSwap(async () => { commits += 1; });
  assert.deepEqual({ committed: result.committed, reason: result.reason }, {
    committed: false,
    reason: 'source_changed',
  });
  assert.equal(commits, 0);
});

test('own synthesis publishes its pinned derived revision after ordinary memory append without weakening source CAS', async (t) => {
  const fx = await fixture(t);
  await appendMemoryRevision(fx.brainDir, { nodes: [{ id: 'n2', concept: 'concurrent growth' }] }, {
    lockRoot: path.join(fx.home23Root, 'runtime', 'brain-source-locks'),
    summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
  });
  let sourceMutations = 0;
  const strict = await fx.source.compareAndSwap(() => { sourceMutations += 1; });
  assert.equal(strict.committed, false);
  assert.equal(sourceMutations, 0);
  let publications = 0;
  const result = await fx.source.publishDerivedState(async () => {
    publications += 1;
    await fsp.writeFile(path.join(fx.brainDir, 'brain-state.json'), JSON.stringify({ sourceRevision: 2 }));
    return 'derived';
  });
  assert.equal(result.committed, true);
  assert.equal(result.manifest.currentRevision, 3);
  assert.equal(result.value, 'derived');
  assert.equal(publications, 1);
  assert.equal(JSON.parse(await fsp.readFile(path.join(fx.brainDir, 'brain-state.json'))).sourceRevision, 2);
});

test('derived synthesis publication refuses a replaced source generation', async (t) => {
  const fx = await fixture(t);
  const file = path.join(fx.brainDir, 'memory-manifest.json');
  const manifest = JSON.parse(await fsp.readFile(file));
  manifest.generation = 'replacement-generation';
  await fsp.writeFile(file, JSON.stringify(manifest));
  let publications = 0;
  const result = await fx.source.publishDerivedState(() => { publications += 1; });
  assert.equal(result.committed, false);
  assert.equal(result.reason, 'source_changed');
  assert.equal(publications, 0);
});

test('derived synthesis publication retains exact operation authority, lifecycle and own-brain restrictions', async (t) => {
  for (const [label, options] of [
    ['query', { operationType: 'query' }],
    ['cross brain', { ownerAgent: 'forrest' }],
    ['legacy projection', { legacy: true }],
    ['terminal', { statusTransform: r => ({ ...r, state: 'failed' }) }],
    ['forged digest', { statusTransform: r => ({ ...r, sourcePinDigest: 'sha256:' + '0'.repeat(64) }) }],
  ]) {
    await t.test(label, async subtest => {
      const fx = await fixture(subtest, options);
      let publications = 0;
      await assert.rejects(() => fx.source.publishDerivedState(() => { publications += 1; }), error =>
        ['access_denied', 'source_changed'].includes(error.code));
      assert.equal(publications, 0);
    });
  }
  const fx = await fixture(t);
  await fx.source.release();
  await assert.rejects(() => fx.source.publishDerivedState(() => {}), { code: 'source_stale' });
});

test('real pinned synthesis finishes after concurrent growth and preserves its original source revision', async (t) => {
  const fx = await fixture(t, { operationId: `brop_${'C'.repeat(32)}` });
  const { SynthesisAgent, readCommittedSynthesisState } = require('../../engine/src/synthesis/synthesis-agent.js');
  const workspacePath = path.join(fx.home23Root, 'instances/jerry/workspace');
  await fsp.mkdir(workspacePath, { recursive: true });
  let calls = 0;
  const agent = new SynthesisAgent({ brainDir: fx.brainDir, workspacePath, providerAdapter: {
    provider: 'minimax', model: 'MiniMax-M3', capabilities: { maxOutputTokens: 32768, providerStallMs: 900000 },
    async generate() {
      calls += 1;
      await appendMemoryRevision(fx.brainDir, { nodes: [{ id: 'n2', concept: 'growth during provider work' }] }, {
        lockRoot: path.join(fx.home23Root, 'runtime', 'brain-source-locks'), summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 },
      });
      return { content: JSON.stringify({ selfUnderstanding: { summary: 'Pinned source.', currentObsessions: [], relationship: 'Support.' }, consolidatedInsights: [], recentActivity: [] }), terminalReceived: true, finishReason: 'stop', hadError: false };
    },
  }});
  let claims = 0;
  const result = await agent.runOperation({ operationId: fx.operationId, sourcePin: fx.source, claimCompletion: async claim => { claims += 1; return claim; } });
  const state = await readCommittedSynthesisState({ brainDir: fx.brainDir });
  assert.equal(calls, 1);
  assert.equal(claims, 1);
  assert.equal(state.sourceRevision, 2);
  assert.equal(state.sourceGeneration, 'g1');
  assert.equal(state.operationId, result.operationId);
  assert.equal(state.brainStateSha256, result.brainStateSha256);
});

test('read-only, cross-brain, legacy, and escaped-boundary sources cannot mutate', async (t) => {
  const cases = [
    ['read-only operation', { operationType: 'query' }],
    ['cross-brain operation', { ownerAgent: 'forrest', operationType: 'synthesis' }],
    ['legacy projection', { legacy: true }],
    ['escaped boundary', {
      statusTransform(record) {
        record.target.mutationBoundaries = record.target.mutationBoundaries.map((boundary) =>
          boundary.kind === 'agency'
            ? { ...boundary, path: path.join(path.dirname(record.target.canonicalRoot), 'escape') }
            : boundary);
        return record;
      },
    }],
  ];
  for (const [label, options] of cases) {
    await t.test(label, async (subtest) => {
      const fx = await fixture(subtest, options);
      let commits = 0;
      await assert.rejects(
        () => fx.source.compareAndSwap(async () => { commits += 1; }),
        (error) => ['access_denied', 'source_changed'].includes(error?.code),
      );
      assert.equal(commits, 0);
    });
  }
});

test('CAS cancellation releases the external lock and release waits for an active mutation', async (t) => {
  const fx = await fixture(t);
  let enter;
  const entered = new Promise((resolve) => { enter = resolve; });
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  const cancellation = Object.assign(new Error('cancelled during CAS'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  const mutation = fx.source.compareAndSwap(async () => {
    enter();
    await blocked;
    throw cancellation;
  });
  await entered;
  await assert.rejects(
    () => fx.source.compareAndSwap(async () => 'must not run'),
    { code: 'source_busy' },
  );
  let released = false;
  const release = fx.source.release().then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false);
  unblock();
  await assert.rejects(() => mutation, (error) => error === cancellation);
  await release;

  const lockRoot = path.join(fx.home23Root, 'runtime', 'brain-source-locks');
  assert.deepEqual(await fsp.readdir(lockRoot), []);
  let commits = 0;
  await assert.rejects(
    () => fx.source.compareAndSwap(async () => { commits += 1; }),
    { code: 'source_stale' },
  );
  assert.equal(commits, 0);
});
