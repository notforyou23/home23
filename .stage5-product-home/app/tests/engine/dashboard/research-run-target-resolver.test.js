import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  createResearchRunTargetResolver,
} = require('../../../engine/src/dashboard/brain-operations/research-run-target-resolver.js');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-research-target-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const runId = 'research-op-1';
  const canonicalRoot = path.join(
    root, 'instances', 'jerry', 'workspace', 'research-runs', runId,
  );
  await fs.mkdir(canonicalRoot, { recursive: true });
  return { root, runId, canonicalRoot };
}

function metadata({ runId, canonicalRoot }, overrides = {}) {
  return {
    version: 1,
    runId,
    ownerAgent: 'jerry',
    operationId: 'op-1',
    canonicalRoot,
    topic: 'evidence',
    parameters: { topic: 'evidence' },
    state: 'active',
    createdAt: '2026-07-10T00:00:00.000Z',
    updatedAt: '2026-07-10T00:00:01.000Z',
    ...overrides,
  };
}

test('resolves only the requester-owned canonical run into an authority target', async (t) => {
  const fx = await fixture(t);
  let loadedPath = null;
  const resolve = createResearchRunTargetResolver({
    home23Root: fx.root,
    requesterAgent: 'jerry',
    loadMetadata: async (runRoot) => {
      loadedPath = runRoot;
      return metadata(fx);
    },
  });
  const target = await resolve({ runId: fx.runId });
  assert.equal(loadedPath, fx.canonicalRoot);
  assert.equal(target.domain, 'owned-run');
  assert.equal(target.runId, fx.runId);
  assert.equal(target.ownerAgent, 'jerry');
  assert.equal(target.canonicalRoot, fx.canonicalRoot);
  assert.equal(target.runState, 'active');
});

test('returns null only for a genuinely missing canonical metadata record', async (t) => {
  const fx = await fixture(t);
  const resolve = createResearchRunTargetResolver({
    home23Root: fx.root,
    requesterAgent: 'jerry',
    loadMetadata: async () => {
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
  });
  assert.equal(await resolve({ runId: fx.runId }), null);
});

test('rejects wildcard, aliases, path escape, owner mismatch, and root mismatch', async (t) => {
  const fx = await fixture(t);
  const base = {
    home23Root: fx.root,
    requesterAgent: 'jerry',
  };
  const valid = createResearchRunTargetResolver({
    ...base,
    loadMetadata: async () => metadata(fx),
  });
  for (const selector of [undefined, {}, { runId: '*' }, { runId: '../cosmo' }, { brainId: fx.runId }]) {
    await assert.rejects(valid(selector), { code: 'invalid_request' });
  }
  const wrongOwner = createResearchRunTargetResolver({
    ...base,
    loadMetadata: async () => metadata(fx, { ownerAgent: 'cosmo' }),
  });
  await assert.rejects(wrongOwner({ runId: fx.runId }), { code: 'access_denied' });
  const wrongRoot = createResearchRunTargetResolver({
    ...base,
    loadMetadata: async () => metadata(fx, { canonicalRoot: path.join(fx.root, 'elsewhere', fx.runId) }),
  });
  await assert.rejects(wrongRoot({ runId: fx.runId }), { code: 'access_denied' });
});
