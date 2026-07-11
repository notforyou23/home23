'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { QueryEngine } = require('../../cosmo23/lib/query-engine');

function catalog() {
  return {
    version: 1,
    providers: {
      alpha: { models: [{
        id: 'answer-model', kind: 'chat', transport: 'responses',
        maxOutputTokens: 256, providerStallMs: 900_000,
      }] },
    },
    defaults: {},
  };
}

function sourcePin(canonicalRoot) {
  return {
    revision: 1,
    descriptor: { version: 1, canonicalRoot, cutoffRevision: 1 },
    async *iterateNodes() {
      yield { id: 'n1', content: 'immutable target evidence', salience: 1 };
    },
    async *iterateEdges() {},
    async summarize() { return { nodeCount: 1, edgeCount: 0, clusterCount: 0 }; },
    getEvidence(extra = {}) { return { sourceHealth: 'healthy', ...extra }; },
  };
}

async function snapshotTree(root) {
  const rows = [];
  async function visit(current, relative = '.') {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      rows.push([relative, 'symlink', await fs.readlink(current)]);
      return;
    }
    if (stat.isFile()) {
      const bytes = await fs.readFile(current);
      rows.push([relative, 'file', crypto.createHash('sha256').update(bytes).digest('hex')]);
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

function engineFor(root, calls) {
  const client = {
    providerId: 'alpha',
    async generate(options) {
      calls.push(options);
      return {
        content: 'read-only answer', terminalReceived: true, finishReason: 'completed',
        hadError: false, provider: 'alpha', model: 'answer-model',
      };
    },
  };
  return new QueryEngine(root, null, {
    operationMode: true,
    modelCatalog: catalog(),
    providerRegistry: { get() { return client; } },
  });
}

test('operation-mode Query leaves the complete target tree byte-identical', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-query-mutation-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'nested'));
  await fs.writeFile(path.join(root, 'brain.json'), '{"canary":true}\n');
  await fs.writeFile(path.join(root, 'nested', 'keep.txt'), 'preserve me\n');
  await fs.symlink('../brain.json', path.join(root, 'nested', 'brain-link'));
  const before = await snapshotTree(root);
  const calls = [];
  const engine = engineFor(root, calls);

  const result = await engine.executeEnhancedQuery('create a file from the evidence', {
    sourcePin: sourcePin(root),
    modelSelection: { provider: 'alpha', model: 'answer-model' },
    mutationPolicy: 'read-only',
    allowActions: false,
    signal: new AbortController().signal,
  });

  assert.equal(result.answer, 'read-only answer');
  assert.equal(calls.length, 1);
  assert.deepEqual(await snapshotTree(root), before);
});

test('read-only Query rejects forged action and write policies before provider work', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-query-policy-boundary-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const engine = engineFor(root, calls);
  const base = {
    sourcePin: sourcePin(root),
    modelSelection: { provider: 'alpha', model: 'answer-model' },
    signal: new AbortController().signal,
  };
  for (const options of [
    { ...base, mutationPolicy: 'read-only', allowActions: true },
    { ...base, mutationPolicy: 'write', allowActions: false },
  ]) {
    await assert.rejects(
      engine.executeEnhancedQuery('mutate target', options),
      error => error.code === 'access_denied',
    );
  }
  assert.equal(calls.length, 0);
});
