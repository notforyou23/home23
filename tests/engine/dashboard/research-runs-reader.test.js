import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createResearchRunsReader } = require('../../../engine/src/dashboard/brain-operations/research-runs-reader.js');
const { writeCanonicalRunMetadataAtomic } = require('../../../cosmo23/server/lib/research-run-metadata.js');

async function fixture() {
  const home23Root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'home23-research-runs-reader-')),
  );
  const runsRoot = path.join(home23Root, 'instances/jerry/workspace/research-runs');
  await fs.mkdir(runsRoot, { recursive: true, mode: 0o700 });
  const add = async (runId, state, updatedAt) => {
    const canonicalRoot = path.join(runsRoot, runId);
    await fs.mkdir(canonicalRoot, { mode: 0o700 });
    await writeCanonicalRunMetadataAtomic(canonicalRoot, {
      version: 1,
      runId,
      ownerAgent: 'jerry',
      operationId: `brop_${runId.padEnd(32, 'x').slice(0, 32)}`,
      canonicalRoot,
      topic: `${runId} topic`,
      parameters: { topic: `${runId} topic` },
      state,
      createdAt: '2026-07-12T10:00:00.000Z',
      updatedAt,
    });
  };
  await add('active-run', 'active', '2026-07-12T12:00:00.000Z');
  await add('completed-run', 'completed', '2026-07-12T11:00:00.000Z');
  return { home23Root };
}

test('lists bounded canonical requester-owned research runs and current active authority', async (t) => {
  const { home23Root } = await fixture();
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  const reader = createResearchRunsReader({ home23Root, requesterAgent: 'jerry' });
  const recent = await reader.list({ state: 'recent', limit: 10 });
  assert.deepEqual(recent.runs.map((run) => [run.runId, run.state]), [
    ['active-run', 'active'],
    ['completed-run', 'completed'],
  ]);
  assert.equal(Object.hasOwn(recent.runs[0], 'canonicalRoot'), false);
  const active = await reader.getActive();
  assert.equal(active.active, true);
  assert.equal(active.runName, 'active-run');
  assert.equal(active.topic, 'active-run topic');
});
