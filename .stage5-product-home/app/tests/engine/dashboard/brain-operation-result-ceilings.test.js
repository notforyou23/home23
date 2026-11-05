import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrainOperationStore } = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const { canonicalJson } = require('../../../shared/brain-operations/canonical-json.cjs');

function exactJsonPayload(bytes) {
  const overhead = Buffer.byteLength(canonicalJson({ payload: '' }), 'utf8');
  const value = { payload: 'x'.repeat(bytes - overhead) };
  assert.equal(Buffer.byteLength(canonicalJson(value), 'utf8'), bytes);
  return value;
}

function target(root) {
  return {
    domain: 'brain', brainId: 'brain-jerry', canonicalRoot: root,
    accessMode: 'own', ownerAgent: 'jerry', displayName: 'Jerry',
    kind: 'resident', lifecycle: 'resident', catalogRevision: 'catalog-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: [
      { kind: 'brain', path: root }, { kind: 'run', path: root },
      { kind: 'pgs', path: path.join(root, 'pgs') },
      { kind: 'session', path: path.join(root, 'sessions') },
      { kind: 'cache', path: path.join(root, 'cache') },
      { kind: 'export', path: path.join(root, 'exports') },
      { kind: 'agency', path: path.join(root, 'agency') },
    ],
  };
}

test('near-ceiling Query and PGS results externalize and read back through dashboard storage', async t => {
  const MiB = 1024 * 1024;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'home23-result-ceilings-')));
  const canonicalRoot = path.join(root, 'brain');
  fs.mkdirSync(canonicalRoot);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new BrainOperationStore({
    root: path.join(root, 'operations-store'), requesterAgent: 'jerry',
  });

  for (const [operationType, bytes] of [['query', 8 * MiB], ['pgs', 24 * MiB]]) {
    const created = await store.create({
      requestId: `near-ceiling-${operationType}`,
      requesterAgent: 'jerry',
      target: target(canonicalRoot),
      operationType,
      requestParameters: { query: 'canary' },
      parameters: { query: 'canary' },
      sourcePinDescriptor: null,
      sourcePinDigest: null,
      canonicalEvidence: true,
    });
    const result = exactJsonPayload(bytes);
    const stored = await store.setResult(created.record.operationId, {
      expectedVersion: created.record.recordVersion,
      result,
    });
    assert.equal(stored.result, null);
    assert.match(stored.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
    assert.equal(stored.resultArtifact.bytes, bytes);
    const readBack = await store.getResult(created.record.operationId, {
      requesterAgent: 'jerry', resultHandle: stored.resultHandle,
    });
    assert.equal(Buffer.byteLength(canonicalJson(readBack), 'utf8'), bytes);
    assert.equal(readBack.payload.length, result.payload.length);
  }
});
