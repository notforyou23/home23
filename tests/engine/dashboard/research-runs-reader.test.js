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

// ── stale-active reconciliation (2026-07-20) ──────────────────────────
// Run metadata says what the run WAS; a cosmo23 restart kills its runs
// without updating records, so jerry's 07-19 run reported 'active' for 30
// hours. With a probe wired, the reader demotes confidently-dead actives
// to a continuable 'interrupted'; without one, behavior is unchanged.

test('a dead active run is demoted to a continuable interrupted state', async (t) => {
  const { home23Root } = await fixture();
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  let probes = 0;
  const reader = createResearchRunsReader({
    home23Root,
    requesterAgent: 'jerry',
    probeLiveRun: async () => { probes += 1; return { active: false, runName: null }; },
  });
  const recent = await reader.list({ state: 'recent', limit: 10 });
  const demoted = recent.runs.find((run) => run.runId === 'active-run');
  assert.equal(demoted.state, 'interrupted');
  assert.equal(demoted.continuable, true, 'an interrupted run must be resumable');
  assert.equal(demoted.stoppable, false);
  assert.equal(demoted.error.code, 'run_not_live');
  assert.equal(probes, 1, 'exactly one lazy probe per listing');

  const active = await reader.getActive();
  assert.equal(active.active, false, 'a demoted run is not the active authority');
});

test('a live matching run stays active; a different live run demotes the record', async (t) => {
  const { home23Root } = await fixture();
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  const readerSame = createResearchRunsReader({
    home23Root,
    requesterAgent: 'jerry',
    probeLiveRun: async () => ({ active: true, runName: 'active-run' }),
  });
  const same = await readerSame.list({ state: 'active', limit: 10 });
  assert.deepEqual(same.runs.map((run) => [run.runId, run.state]), [['active-run', 'active']]);

  const readerOther = createResearchRunsReader({
    home23Root,
    requesterAgent: 'jerry',
    probeLiveRun: async () => ({ active: true, runName: 'some-other-run' }),
  });
  const other = await readerOther.list({ state: 'active', limit: 10 });
  assert.equal(other.count, 0, 'a different live run cannot vouch for this record');
});

test('an unidentifiable live run keeps the record active rather than guessing', async (t) => {
  const { home23Root } = await fixture();
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  const reader = createResearchRunsReader({
    home23Root,
    requesterAgent: 'jerry',
    probeLiveRun: async () => ({ active: true, runName: null }),
  });
  const active = await reader.list({ state: 'active', limit: 10 });
  assert.deepEqual(active.runs.map((run) => run.runId), ['active-run']);
});

test('completed-only listings never probe', async (t) => {
  const { home23Root } = await fixture();
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  await fs.rm(path.join(home23Root, 'instances/jerry/workspace/research-runs/active-run'),
    { recursive: true, force: true });
  let probes = 0;
  const reader = createResearchRunsReader({
    home23Root,
    requesterAgent: 'jerry',
    probeLiveRun: async () => { probes += 1; return { active: false, runName: null }; },
  });
  await reader.list({ state: 'recent', limit: 10 });
  assert.equal(probes, 0);
});
