import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IngestionManifest } = require('../../../engine/src/ingestion/ingestion-manifest.js');

for (const [label, Manifest] of [
  ['root', IngestionManifest],
]) {
  test(`${label} ingestion metadata is committed through patchNode without a direct record write`, async (t) => {
    const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-ingestion-barrier-'));
    t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

    const target = { id: 'node-1', concept: 'durable chunk', metadata: {} };
    const guardedNode = new Proxy(target, {
      set() {
        throw new Error('direct_node_write_forbidden');
      },
    });
    const patchCalls = [];
    const memory = {
      removeNode() { return false; },
      async addNode() { return guardedNode; },
      patchNode(nodeId, patch, options) {
        patchCalls.push({ nodeId, patch, options });
        assert.equal(options.expectedNode, guardedNode);
        target.metadata = patch.metadata;
        return guardedNode;
      },
      addEdge() {},
    };
    const manifest = new Manifest({
      runPath,
      memory,
      embeddingFn: async () => [0.1, 0.2],
      config: { batchSize: 20 },
      logger: { info() {}, warn() {}, debug() {} },
    });
    manifest._pending = [{
      filePath: '/workspace/source.md',
      sourcePath: '/workspace/source.md#chunk-0',
      chunkIndex: 0,
      totalChunks: 1,
      label: 'source',
      tag: 'source',
      content: 'durable chunk',
      heading: 'Heading',
      blockType: 'paragraph',
      blockPath: '0',
      blockId: 'block-0',
      docFamily: 'notes',
      docFamilyConfidence: 0.9,
      parseStatus: 'ok',
      embedding: [0.1, 0.2],
      contentHash: 'hash-16',
      hash: 'full-hash',
      ingestedAt: '2026-07-11T00:00:00.000Z',
      relationships: [],
      provenance: {
        schema: 'home23.node-provenance.v1',
        authorityClass: 'generated_doctrine',
        retrievalDomain: 'project_history',
        semanticTime: '2026-07-10T00:00:00.000Z',
        sourceRefs: ['/workspace/source.md'],
        evidenceRefs: ['sha256:full-hash', 'adopted-doctrine-receipt:self-asserted'],
        generationMethod: 'document_compiler_synthesis',
        sourcePath: '/workspace/source.md',
        contentHash: 'full-hash',
        scope: ['source'],
        expiresAt: null,
        operationalAuthority: true,
        requiresFreshVerification: false,
      },
    }];

    await manifest.flush('barrier-regression');

    assert.equal(patchCalls.length, 1);
    assert.equal(patchCalls[0].nodeId, 'node-1');
    assert.equal(patchCalls[0].patch.metadata.source, 'document-feeder');
    assert.equal(patchCalls[0].patch.metadata.chunkKey, '/workspace/source.md#chunk-0');
    if (label === 'root') {
      assert.equal(patchCalls[0].patch.metadata.provenance.schema, 'home23.node-provenance.v1');
      assert.equal(patchCalls[0].patch.metadata.provenance.authorityClass, 'narrative');
      assert.equal(patchCalls[0].patch.metadata.provenance.operationalAuthority, false);
      assert.equal(patchCalls[0].patch.metadata.provenance.requiresFreshVerification, true);
      assert.deepEqual(patchCalls[0].patch.metadata.provenance.derivedNodeIds, ['node-1']);
    }
    assert.deepEqual(manifest._manifest['/workspace/source.md'].nodeIds, ['node-1']);
    if (label === 'root') {
      assert.equal(
        manifest._manifest['/workspace/source.md'].provenance.generationMethod,
        'document_compiler_synthesis'
      );
      assert.deepEqual(manifest._manifest['/workspace/source.md'].provenance.derivedNodeIds, ['node-1']);
    }
  });
}

test('a flush deferred by an active brain save runs again about 2 s after the save clears', async (t) => {
  // The file-event debounce had already fired, so a deferred batch used to
  // wait for the 300 s interval flush before reaching memory (H23-003).
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-ingestion-deferred-'));
  const nodes = new Map();
  const memory = {
    persistenceSaveActive: true,
    nodes,
    async addNode(value) {
      const node = { id: `node-${nodes.size + 1}`, concept: value.concept, metadata: value.metadata };
      nodes.set(node.id, node);
      return node;
    },
    patchNode(id, patch) { Object.assign(nodes.get(id), patch); return nodes.get(id); },
    removeNode(id) { return nodes.delete(id); },
    addEdge() {},
  };
  const flushed = [];
  const manifest = new IngestionManifest({
    runPath,
    memory,
    embeddingFn: async () => [0.1, 0.2],
    config: { batchSize: 20 },
    logger: { info() {}, warn() {}, debug() {} },
    onFlushed: (flush) => flushed.push(flush),
  });
  t.after(async () => {
    await manifest.shutdown();
    fs.rmSync(runPath, { recursive: true, force: true });
  });
  await manifest.enqueue('/workspace/note.md', 'notes', 'full-hash-0123456789', [
    { index: 0, text: 'deferred chunk', totalChunks: 1, heading: null, depth: 0 },
  ], []);

  assert.deepEqual(await manifest.flush('file-event'), { flushed: 0, deferred: true });
  assert.deepEqual(await manifest.flush('interval'), { flushed: 0, deferred: true });
  assert.equal(nodes.size, 0, 'nothing enters memory during the save');
  const clearedAt = Date.now();
  memory.persistenceSaveActive = false;

  const deadline = Date.now() + 3_000;
  while (nodes.size === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  const elapsed = Date.now() - clearedAt;
  assert.equal(nodes.size, 1, 'the deferred batch reached memory');
  assert.ok(elapsed < 2_700, `re-ran ${elapsed} ms after the save cleared`);
  assert.deepEqual(flushed, [{ reason: 'file-event:after-save', flushed: 1 }], 'one coalesced retry');
  assert.equal(manifest.getEntry('/workspace/note.md').nodeIds.length, 1);
});
