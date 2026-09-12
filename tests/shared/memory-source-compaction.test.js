import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  appendMemoryRevision,
  compactMemoryBase,
  createDescriptor,
  discoverOperationPinFiles,
  openMemorySource,
  readManifest,
  rewriteMemoryBase,
  rewriteMemoryBaseFromSnapshot,
  sourceDescriptorDigest,
} = require('../../shared/memory-source');

async function fixture(t) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-compaction-'));
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const brainDir = path.join(home23Root, 'instances', 'ada', 'brain');
  await fsp.mkdir(brainDir, { recursive: true });
  const options = { home23Root, lockRoot: path.join(home23Root, 'runtime', 'brain-source-locks') };
  await rewriteMemoryBase(brainDir, {
    nodes: [
      { id: '1', cluster: 1, concept: 'first', embedding: [0.5, -0.25], future: { nested: ['keep', { yes: true }] } },
      { id: '2', cluster: 1, concept: 'delete me' },
      { id: '3', cluster: 2, concept: 'keep me', unknown: 'retained' },
    ],
    edges: [
      { source: '1', target: '2', type: 'related', future: { proof: 23 } },
      { source: '1', target: '3', type: 'related', future: { proof: 24 } },
    ],
    summary: { nodeCount: 3, edgeCount: 2, clusterCount: 2 },
  }, options);
  return { brainDir, home23Root, options };
}

async function records(brainDir) {
  const source = await openMemorySource(brainDir);
  try {
    const nodes = [];
    const edges = [];
    for await (const node of source.iterateNodes()) nodes.push(node);
    for await (const edge of source.iterateEdges()) edges.push(edge);
    nodes.sort((a, b) => a.id.localeCompare(b.id));
    edges.sort((a, b) => `${a.source}-${a.target}`.localeCompare(`${b.source}-${b.target}`));
    return { nodes, edges };
  } finally {
    await source.close();
  }
}

async function assertReleased(home23Root) {
  assert.deepEqual(await discoverOperationPinFiles(home23Root), []);
  const operations = path.join(home23Root, 'instances', 'memory-compaction', 'runtime', 'brain-operations', 'operations');
  assert.deepEqual(await fsp.readdir(operations), []);
}

test('compaction streams the complete logical graph with unknown fields, replacements and tombstones', async (t) => {
  const { brainDir, home23Root, options } = await fixture(t);
  await appendMemoryRevision(brainDir, {
    nodes: [{ id: '4', cluster: 3, concept: 'new', future: { values: [1, 2, 3] } }],
    removedNodeIds: ['2'],
    removedEdgeKeys: ['1->3'],
    edges: [{ source: '3', target: '4', type: 'custom', future: { proof: 25 } }],
  }, { ...options, summary: { nodeCount: 3, edgeCount: 1, clusterCount: 3 } });
  const expected = await records(brainDir);
  const before = await readManifest(brainDir);
  const oldBytes = await fsp.readFile(path.join(brainDir, before.activeBase.nodes.file));
  const result = await compactMemoryBase(brainDir, { ...options, maxOverlayMemoryBytes: 0 });
  assert.deepEqual(await records(brainDir), expected);
  assert.equal(result.baseRevision, before.currentRevision + 1);
  assert.equal(result.manifest.activeDelta.count, 0);
  assert.equal(result.manifest.activeDelta.committedBytes, 0);
  assert.deepEqual(result.manifest.summary, before.summary);
  assert.equal(result.manifest.ann.builtFromRevision, null);
  assert.ok(Number.isFinite(Date.parse(result.manifest.baseWrittenAt)));
  assert.deepEqual(await fsp.readFile(path.join(brainDir, before.activeBase.nodes.file)), oldBytes);
  await assertReleased(home23Root);
});

test('compaction refuses an expected revision that changed before capture', async (t) => {
  const { brainDir, home23Root, options } = await fixture(t);
  const before = await readManifest(brainDir);
  const expectedDigest = sourceDescriptorDigest(createDescriptor(await fsp.realpath(brainDir), before));
  await appendMemoryRevision(brainDir, { nodes: [{ id: '1', cluster: 1, concept: 'newer' }] }, {
    ...options, summary: before.summary,
  });
  const current = await readManifest(brainDir);
  await assert.rejects(compactMemoryBase(brainDir, {
    ...options,
    expectedGeneration: before.generation,
    expectedRevision: before.currentRevision,
    expectedDigest,
  }), { code: 'source_changed' });
  assert.deepEqual(await readManifest(brainDir), current);
  await assertReleased(home23Root);
});

test('compaction rejects a concurrent append and removes only its unpublished files', async (t) => {
  const { brainDir, home23Root, options } = await fixture(t);
  const before = await readManifest(brainDir);
  const filesBefore = await fsp.readdir(brainDir);
  await assert.rejects(compactMemoryBase(brainDir, {
    ...options,
    _testHooks: {
      async afterBaseFiles() {
        assert.ok((await discoverOperationPinFiles(home23Root)).length > 0);
        await appendMemoryRevision(brainDir, { nodes: [{ id: '1', cluster: 1, concept: 'concurrent' }] }, {
          ...options, summary: before.summary,
        });
      },
    },
  }), { code: 'source_changed', retryable: true });
  const after = await readManifest(brainDir);
  assert.equal(after.generation, before.generation);
  assert.equal(after.currentRevision, before.currentRevision + 1);
  assert.equal((await records(brainDir)).nodes[0].concept, 'concurrent');
  assert.deepEqual((await fsp.readdir(brainDir)).sort(), filesBefore.sort());
  await assertReleased(home23Root);
});

for (const faultAt of ['afterSourceSnapshot', 'afterBaseFiles', 'beforeManifestRename']) {
  test(`compaction failure at ${faultAt} preserves committed bytes and releases its source`, async (t) => {
    const { brainDir, home23Root, options } = await fixture(t);
    const before = await fsp.readFile(path.join(brainDir, 'memory-manifest.json'));
    const filesBefore = (await fsp.readdir(brainDir)).sort();
    await assert.rejects(compactMemoryBase(brainDir, { ...options, faultAt }), new RegExp(`injected:${faultAt}`));
    assert.deepEqual(await fsp.readFile(path.join(brainDir, 'memory-manifest.json')), before);
    assert.deepEqual((await fsp.readdir(brainDir)).sort(), filesBefore);
    await assertReleased(home23Root);
  });
}

test('compaction refuses incorrect logical counts and clusters before publication', async (t) => {
  for (const summary of [
    { nodeCount: 4, edgeCount: 2, clusterCount: 2 },
    { nodeCount: 3, edgeCount: 3, clusterCount: 2 },
    { nodeCount: 3, edgeCount: 2, clusterCount: 1 },
    { nodeCount: 3, edgeCount: 2, clusterCount: 3 },
  ]) {
    const { brainDir, home23Root, options } = await fixture(t);
    const manifest = await readManifest(brainDir);
    await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({ ...manifest, summary }));
    const before = await fsp.readFile(path.join(brainDir, 'memory-manifest.json'));
    await assert.rejects(compactMemoryBase(brainDir, options), { code: 'source_unavailable' });
    assert.deepEqual(await fsp.readFile(path.join(brainDir, 'memory-manifest.json')), before);
    await assertReleased(home23Root);
  }
});

test('compaction remains bounded when numeric graph data exceeds the child heap', async (t) => {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-compaction-heap-'));
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const script = String.raw`
    const path = require('node:path');
    const fs = require('node:fs/promises');
    const { compactMemoryBase, rewriteMemoryBaseFromSnapshot, writeJsonlGzAtomic, writeManifestAtomic } = require(process.env.MEMORY_SOURCE_MODULE);
    (async () => {
      const root = process.env.COMPACTION_HOME;
      const dir = path.join(root, 'brain');
      await fs.mkdir(dir);
      async function* rows() {
        for (let id = 0; id < 12000; id++) yield { id: String(id), cluster: id % 4, embedding: Array(1024).fill(0.125) };
      }
      const nodes = await writeJsonlGzAtomic(path.join(dir, 'memory-nodes.base-1.jsonl.gz'), rows());
      const edges = await writeJsonlGzAtomic(path.join(dir, 'memory-edges.base-1.jsonl.gz'), []);
      await fs.writeFile(path.join(dir, 'memory-delta.e2.jsonl'), '');
      await writeManifestAtomic(dir, {
        formatVersion: 1, generation: 'g1', baseRevision: 1, currentRevision: 1,
        activeDeltaEpoch: 'e2',
        activeBase: { nodes: {file:'memory-nodes.base-1.jsonl.gz', ...nodes}, edges:{file:'memory-edges.base-1.jsonl.gz', ...edges} },
        activeDelta: {epoch:'e2',file:'memory-delta.e2.jsonl',fromRevision:2,toRevision:1,count:0,committedBytes:0},
        ann: {indexFile:null,metaFile:null,builtFromRevision:null},
        summary:{nodeCount:12000,edgeCount:0,clusterCount:4}
      });
      const result = await compactMemoryBase(dir, {home23Root:root});
      if (result.nodes.count !== 12000) throw Error('incomplete compaction');
      const streamed = await rewriteMemoryBaseFromSnapshot(dir, {generation:1, summary:result.manifest.summary, fullView:{nodes:rows(),edges:[]}, validate(){}}, {lockRoot:path.join(root,'runtime','brain-source-locks')});
      process.stdout.write(JSON.stringify({count:streamed.nodes.count, heap:process.memoryUsage().heapUsed}));
    })().catch(error => { console.error(error); process.exitCode=1; });
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=40', '-e', script], {
    env: { ...process.env, MEMORY_SOURCE_MODULE: require.resolve('../../shared/memory-source'), COMPACTION_HOME: home23Root },
    encoding: 'utf8', timeout: 45000,
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.equal(JSON.parse(child.stdout).count, 12000);
});

function streamingSnapshot({ mutateDuringNodes = false, empty = false } = {}) {
  let generation = 1;
  const assertGeneration = () => {
    if (generation !== 1) throw Object.assign(new Error('snapshot generation changed'), { code: 'source_changed' });
  };
  return {
    mutate() { generation++; },
    snapshot: {
      generation: 1,
      summary: { nodeCount: empty ? 0 : 2, edgeCount: 0, clusterCount: empty ? 0 : 1 },
      fullView: {
        nodes: {
          *[Symbol.iterator]() {
            if (empty) return;
            assertGeneration();
            yield { id: 'a', cluster: 1, embedding: [0.25, -0.5], future: { field: 'preserved' } };
            if (mutateDuringNodes) generation++;
            assertGeneration();
            yield { id: 'b', cluster: 1 };
          },
        },
        edges: [],
      },
      validate: assertGeneration,
    },
  };
}

test('resident snapshot rewrite accepts iterables and preserves record fields', async (t) => {
  const { brainDir, options } = await fixture(t);
  const { snapshot } = streamingSnapshot();
  const result = await rewriteMemoryBaseFromSnapshot(brainDir, snapshot, options);
  assert.equal(result.nodes.count, 2);
  assert.deepEqual((await records(brainDir)).nodes[0], {
    id: 'a', cluster: 1, embedding: [0.25, -0.5], future: { field: 'preserved' },
  });
});

test('resident snapshot mutation during iteration refuses publication and removes staged files', async (t) => {
  const { brainDir, options } = await fixture(t);
  const before = await readManifest(brainDir);
  const filesBefore = (await fsp.readdir(brainDir)).sort();
  await assert.rejects(rewriteMemoryBaseFromSnapshot(brainDir,
    streamingSnapshot({ mutateDuringNodes: true }).snapshot, options), { code: 'source_changed' });
  assert.deepEqual(await readManifest(brainDir), before);
  assert.deepEqual((await fsp.readdir(brainDir)).sort(), filesBefore);
});

test('resident snapshot validates empty streams and detects mutations while files finish', async (t) => {
  const { brainDir, options } = await fixture(t);
  const before = await readManifest(brainDir);
  const { snapshot, mutate } = streamingSnapshot({ empty: true });
  await assert.rejects(rewriteMemoryBaseFromSnapshot(brainDir, snapshot, {
    ...options, _testHooks: { afterSourceSnapshot: mutate },
  }), { code: 'source_changed' });
  assert.deepEqual(await readManifest(brainDir), before);
});

test('resident mutation after complete staging leaves the immutable staged generation publishable', async (t) => {
  const { brainDir, options } = await fixture(t);
  const { snapshot, mutate } = streamingSnapshot();
  const result = await rewriteMemoryBaseFromSnapshot(brainDir, snapshot, {
    ...options, _testHooks: { afterBaseFiles: mutate },
  });
  assert.equal(result.nodes.count, 2);
  assert.throws(snapshot.validate, { code: 'source_changed' });
});


test('resident snapshot rewrite refuses a disk revision changed after capture', async (t) => {
  const { brainDir, options } = await fixture(t);
  const before = await readManifest(brainDir);
  const expectedDigest = sourceDescriptorDigest(createDescriptor(await fsp.realpath(brainDir), before));
  await assert.rejects(rewriteMemoryBaseFromSnapshot(brainDir, streamingSnapshot().snapshot, {
    ...options,
    expectedGeneration: before.generation,
    expectedRevision: before.currentRevision,
    expectedDigest,
    async beforeLock() {
      await appendMemoryRevision(brainDir, { nodes: [{ id: '1', cluster: 1, concept: 'concurrent disk authority' }] }, {
        ...options, summary: before.summary,
      });
    },
  }), { code: 'source_changed' });
  assert.equal((await readManifest(brainDir)).currentRevision, before.currentRevision + 1);
  assert.equal((await records(brainDir)).nodes[0].concept, 'concurrent disk authority');
});

test('initial resident snapshot rewrite refuses a concurrently created source', async (t) => {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-compaction-initial-'));
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const brainDir = path.join(home23Root, 'brain');
  await fsp.mkdir(brainDir);
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await assert.rejects(rewriteMemoryBaseFromSnapshot(brainDir, streamingSnapshot().snapshot, {
    lockRoot,
    expectedSourceAbsent: true,
    async beforeLock() {
      await rewriteMemoryBase(brainDir, {
        nodes: [{ id: 'external', cluster: 1 }], edges: [],
        summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
      }, { lockRoot });
    },
  }), { code: 'source_changed' });
  assert.equal((await records(brainDir)).nodes[0].id, 'external');
});

test('cancelled compaction releases source pins and preserves the committed manifest', async (t) => {
  const { brainDir, home23Root, options } = await fixture(t);
  const before = await readManifest(brainDir);
  const controller = new AbortController();
  const reason = Object.assign(new Error('compaction cancelled'), { code: 'cancelled' });
  await assert.rejects(compactMemoryBase(brainDir, {
    ...options, signal: controller.signal,
    _testHooks: { afterBaseFiles() { controller.abort(reason); } },
  }), { code: 'cancelled' });
  assert.deepEqual(await readManifest(brainDir), before);
  await assertReleased(home23Root);
});


async function aliasFixture(t, { delta = false } = {}) {
  const { brainDir, home23Root, options } = await fixture(t);
  await rewriteMemoryBase(brainDir, {
    nodes: [
      { id: 42, cluster: 1, concept: 'old alias', unknown: { old: true }, embedding: [0.25] },
      { id: '42', cluster: 2, concept: 'winning alias', unknown: { future: ['complete', 23] }, embedding: [-0.5, 0.75] },
      ...(delta ? [{ id: '43', cluster: 2, concept: 'before delta' }] : []),
    ],
    edges: delta ? [{ source: '42', target: '43', type: 'relation', unknown: { keep: 23 } }] : [],
    summary: { nodeCount: delta ? 3 : 2, edgeCount: delta ? 1 : 0, clusterCount: 2 },
  }, options);
  if (delta) {
    await appendMemoryRevision(brainDir, {
      nodes: [{ id: '43', cluster: 2, concept: 'after delta', extra: 'latest' }],
    }, { ...options, summary: { nodeCount: 2, edgeCount: 1, clusterCount: 1 } });
  } else {
    const current = await readManifest(brainDir);
    await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({
      ...current, summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
    }));
  }
  return { brainDir, home23Root, options };
}

for (const delta of [false, true]) {
  test(`compaction canonicalizes proven historical node aliases with last-row fields (delta=${delta})`, async (t) => {
    const { brainDir, home23Root, options } = await aliasFixture(t, { delta });
    const before = await readManifest(brainDir);
    const oldNodes = await fsp.readFile(path.join(brainDir, before.activeBase.nodes.file));
    let aliasProofs = 0;
    const result = await compactMemoryBase(brainDir, {
      ...options, maxOverlayMemoryBytes: 0,
      _testHooks: { afterAliasProof() { aliasProofs++; } },
    });
    assert.equal(aliasProofs, 1);
    assert.deepEqual(result.manifest.summary, before.summary);
    assert.equal(result.nodes.count, delta ? 2 : 1);
    const canonical = await records(brainDir);
    assert.deepEqual(canonical.nodes[0], {
      id: '42', cluster: 2, concept: 'winning alias', unknown: { future: ['complete', 23] }, embedding: [-0.5, 0.75],
    });
    if (delta) {
      assert.deepEqual(canonical.nodes[1], { id: '43', cluster: 2, concept: 'after delta', extra: 'latest' });
      assert.deepEqual(canonical.edges, [{ source: '42', target: '43', type: 'relation', unknown: { keep: 23 } }]);
    }
    assert.deepEqual(await fsp.readFile(path.join(brainDir, before.activeBase.nodes.file)), oldNodes);
    await assertReleased(home23Root);
  });
}

test('compaction never treats an unexplained node-count reduction as historical alias repair', async (t) => {
  const { brainDir, home23Root, options } = await fixture(t);
  const current = await readManifest(brainDir);
  await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({
    ...current, summary: { ...current.summary, nodeCount: 2 },
  }));
  const before = await readManifest(brainDir);
  const filesBefore = (await fsp.readdir(brainDir)).sort();
  await assert.rejects(compactMemoryBase(brainDir, {
    ...options, maxOverlayMemoryBytes: 0,
    _testHooks: { afterAliasProof() { throw new Error('unproven alias repair reached'); } },
  }), { code: 'source_unavailable' });
  assert.deepEqual(await readManifest(brainDir), before);
  assert.deepEqual((await fsp.readdir(brainDir)).sort(), filesBefore);
  await assertReleased(home23Root);
});

test('proven aliases cannot bypass unrelated final edge or cluster summary mismatches', async (t) => {
  for (const summaryPatch of [{ edgeCount: 1 }, { clusterCount: 0 }]) {
    const { brainDir, home23Root, options } = await aliasFixture(t);
    const current = await readManifest(brainDir);
    await fsp.writeFile(path.join(brainDir, 'memory-manifest.json'), JSON.stringify({
      ...current, summary: { ...current.summary, ...summaryPatch },
    }));
    const before = await readManifest(brainDir);
    await assert.rejects(compactMemoryBase(brainDir, options), { code: 'source_unavailable' });
    assert.deepEqual(await readManifest(brainDir), before);
    await assertReleased(home23Root);
  }
});

test('concurrent append during alias repair remains authoritative and all retry files are removed', async (t) => {
  const { brainDir, home23Root, options } = await aliasFixture(t, { delta: true });
  const before = await readManifest(brainDir);
  const filesBefore = (await fsp.readdir(brainDir)).sort();
  await assert.rejects(compactMemoryBase(brainDir, {
    ...options, maxOverlayMemoryBytes: 0,
    _testHooks: {
      async afterAliasProof() {
        await appendMemoryRevision(brainDir, {
          nodes: [{ id: '44', cluster: 2, concept: 'concurrent committed node' }],
        }, { ...options, summary: { nodeCount: 3, edgeCount: 1, clusterCount: 1 } });
      },
    },
  }), { code: 'source_changed' });
  const after = await readManifest(brainDir);
  assert.equal(after.generation, before.generation);
  assert.equal(after.currentRevision, before.currentRevision + 1);
  assert.equal((await records(brainDir)).nodes.at(-1).concept, 'concurrent committed node');
  assert.deepEqual((await fsp.readdir(brainDir)).sort(), filesBefore);
  await assertReleased(home23Root);
});
