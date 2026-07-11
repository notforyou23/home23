import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  createInstalledLocalSourceContext,
  withEphemeralMemorySource,
  withMemorySourceLock,
  writeJsonlGzAtomic,
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeManifestBrain() {
  const brain = await tempDir('home23-memory-source-context-brain-');
  const nodes = await writeJsonlGzAtomic(path.join(brain, 'nodes.gz'), [{ id: 1, concept: 'context canary' }]);
  const edges = await writeJsonlGzAtomic(path.join(brain, 'edges.gz'), []);
  await fsp.writeFile(path.join(brain, 'delta.jsonl'), '');
  await fsp.writeFile(path.join(brain, 'memory-manifest.json'), `${JSON.stringify({
    formatVersion: 1,
    generation: 'g1',
    baseRevision: 1,
    currentRevision: 1,
    activeDeltaEpoch: 'e0',
    activeBase: {
      nodes: { file: 'nodes.gz', count: 1, bytes: nodes.bytes },
      edges: { file: 'edges.gz', count: 0, bytes: edges.bytes },
    },
    activeDelta: { epoch: 'e0', file: 'delta.jsonl', fromRevision: 2, toRevision: 1, count: 0, committedBytes: 0 },
    ann: { indexFile: null, metaFile: null, builtFromRevision: 1 },
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, null, 2)}\n`);
  return brain;
}

async function collect(iterator) {
  const rows = [];
  for await (const row of iterator) rows.push(row);
  return rows;
}

test('withEphemeralMemorySource derives operation roots, opens source, and removes only operation scratch', async () => {
  const home23Root = await tempDir('home23-memory-source-context-home-');
  const brainDir = await writeManifestBrain();
  let captured;
  const concepts = await withEphemeralMemorySource({
    brainDir,
    home23Root,
    requesterAgent: 'jerry',
    identity: { brainId: 'jerry' },
    uuid: () => 'abc123',
  }, async (source, context) => {
    captured = context;
    return (await collect(source.iterateNodes())).map((node) => node.concept);
  });
  assert.deepEqual(concepts, ['context canary']);
  assert.equal(captured.operationId, 'local-abc123');
  const canonicalHome = await fsp.realpath(home23Root);
  assert.equal(captured.operationRoot.startsWith(path.join(canonicalHome, 'instances', 'jerry')), true);
  assert.equal(captured.lockRoot, path.join(canonicalHome, 'runtime', 'brain-source-locks'));
  assert.equal(await fsp.access(captured.operationRoot).then(() => true).catch(() => false), false);
  assert.equal(await fsp.access(brainDir).then(() => true).catch(() => false), true);
});

test('local source contexts reject dot-segment requester and generated path components', async () => {
  const home23Root = await tempDir('home23-memory-source-context-safe-home-');
  const brainDir = await writeManifestBrain();
  for (const requesterAgent of ['.', '..']) {
    await assert.rejects(withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent,
      uuid: () => 'abc123',
    }, async () => null), { code: 'invalid_request' });
    assert.throws(() => createInstalledLocalSourceContext({
      home23Root,
      requesterAgent,
      brainDir,
    }), { code: 'invalid_request' });
  }
  for (const [prefix, uuid] of [['.', 'abc123'], ['local', '..']]) {
    await assert.rejects(withEphemeralMemorySource({
      brainDir,
      home23Root,
      requesterAgent: 'jerry',
      prefix,
      uuid: () => uuid,
    }, async () => null), { code: 'invalid_request' });
  }
});

test('createInstalledLocalSourceContext rejects public selectors and resolves exact canonical root', async () => {
  const home23Root = await tempDir('home23-memory-source-context-home-');
  const brainDir = await writeManifestBrain();
  const context = createInstalledLocalSourceContext({
    home23Root,
    requesterAgent: 'jerry',
    brainDir,
    buildCatalog: async () => ({
      revision: 'catalog-1',
      entries: [{ target: { canonicalRoot: await fsp.realpath(brainDir), brainId: 'jerry', requesterAgent: 'jerry' } }],
    }),
  });
  const resolved = await context.resolveTargetContext();
  assert.equal(resolved.catalogRevision, 'catalog-1');
  assert.equal(resolved.accessMode, 'own');
  assert.equal(resolved.target.canonicalRoot, await fsp.realpath(brainDir));
  await assert.rejects(() => context.resolveTargetContext({ agent: 'other' }), { code: 'invalid_request' });
});

test('withMemorySourceLock uses an external lock root and leaves target tree unchanged', async () => {
  const brainDir = await writeManifestBrain();
  const home23Root = await tempDir('home23-memory-source-context-home-');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const before = (await fsp.readdir(brainDir)).sort();
  const value = await withMemorySourceLock(brainDir, { lockRoot }, async () => {
    assert.equal((await fsp.readdir(lockRoot)).length, 1);
    return 42;
  });
  assert.equal(value, 42);
  assert.deepEqual((await fsp.readdir(brainDir)).sort(), before);
  assert.deepEqual(await fsp.readdir(lockRoot), []);
});
