import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { IngestionManifest } = require('../../../engine/src/ingestion/ingestion-manifest.js');
const { IngestionManifest: CosmoIngestionManifest } = require('../../../cosmo23/engine/src/ingestion/ingestion-manifest.js');

for (const [label, Manifest] of [
  ['root', IngestionManifest],
  ['COSMO', CosmoIngestionManifest],
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
