'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');
const {
  createEngine: createPgsEngine,
  operationOptions,
  scratchFixture,
  sourcePin: pgsSourcePin,
} = require('./helpers/pinned-pgs-fixture.cjs');

async function snapshotTree(root) {
  const rows = [];
  async function visit(current, relative = '.') {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      rows.push([relative, 'symlink', await fs.readlink(current)]);
      return;
    }
    if (stat.isFile()) {
      rows.push([
        relative,
        'file',
        crypto.createHash('sha256').update(await fs.readFile(current)).digest('hex'),
      ]);
      return;
    }
    rows.push([relative, 'directory']);
    for (const name of (await fs.readdir(current)).sort()) {
      await visit(path.join(current, name), relative === '.' ? name : `${relative}/${name}`);
    }
  }
  await visit(root);
  return rows;
}

function querySourcePin(canonicalRoot) {
  return {
    revision: 9,
    descriptor: { version: 1, canonicalRoot, cutoffRevision: 9 },
    async *iterateNodes() {
      yield { id: 'n1', content: 'cross brain canary evidence', salience: 1 };
      yield { id: 'n2', content: 'supporting immutable evidence', salience: 0.5 };
    },
    async *iterateEdges() { yield { source: 'n1', target: 'n2', type: 'supports' }; },
    async summarize() { return { nodeCount: 2, edgeCount: 1, clusterCount: 0 }; },
    getEvidence(extra = {}) {
      return { sourceHealth: 'healthy', deltaWatermark: { revision: 9 }, ...extra };
    },
  };
}

function createQueryEngine(targetRoot) {
  const client = {
    providerId: 'alpha',
    async generate() {
      return {
        content: 'cross-brain answer', terminalReceived: true, finishReason: 'completed',
        hadError: false, provider: 'alpha', model: 'answer-model',
      };
    },
  };
  return new QueryEngine(targetRoot, null, {
    operationMode: true,
    modelCatalog: {
      version: 1,
      providers: { alpha: { models: [{
        id: 'answer-model', kind: 'chat', transport: 'responses',
        maxOutputTokens: 256, contextWindowTokens: 128_000, providerStallMs: 900_000,
      }] } },
      defaults: {},
    },
    providerRegistry: { get() { return client; } },
  });
}

test('resident and completed-research Query/PGS reads never mutate the target tree', async t => {
  for (const targetKind of ['resident', 'completed-research']) {
    await t.test(targetKind, async t => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `home23-cross-${targetKind}-`));
      const targetRoot = path.join(root, 'target-brain');
      await fs.mkdir(path.join(targetRoot, 'nested'), { recursive: true });
      await fs.writeFile(path.join(targetRoot, 'state.json'), '{"revision":9}\n');
      await fs.writeFile(path.join(targetRoot, 'nested', 'unknown.txt'), 'keep unknown\n');
      await fs.symlink('../state.json', path.join(targetRoot, 'nested', 'state-link'));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const before = await snapshotTree(targetRoot);

      const query = await createQueryEngine(targetRoot).executeEnhancedQuery('cross brain canary', {
        sourcePin: querySourcePin(targetRoot),
        modelSelection: { provider: 'alpha', model: 'answer-model' },
        mutationPolicy: 'read-only',
        accessMode: 'read-only',
        allowActions: false,
        signal: new AbortController().signal,
      });
      assert.equal(query.answer, 'cross-brain answer');

      const scratch = await scratchFixture(t, `home23-cross-pgs-${targetKind}-`);
      const pgs = createPgsEngine();
      const envelope = await pgs.engine.runPinnedOperation(operationOptions(
        pgsSourcePin({ canonicalRoot: targetRoot }),
        scratch,
        {
          mutationPolicy: 'read-only',
          accessMode: 'read-only',
          allowActions: false,
        },
      ));
      assert.equal(envelope.state, 'complete');
      assert.equal((await fs.readdir(scratch.scratchDir)).includes('pgs'), true);
      assert.deepEqual(await snapshotTree(targetRoot), before);
    });
  }
});
