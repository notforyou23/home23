import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AgencyKernel } from '../../../engine/src/agency/resident-kernel.js';
import { reconcileCanonicalWork } from '../../../engine/src/agency/canonical-work.js';

test('projected inquiry without assignment state keeps resident ticks working without manufacturing an agency task', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-canonical-initiative-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kernel = new AgencyKernel({ brainDir: dir, config: { enabled: true, mode: 'live' } });
  const file = join(dir, 'jerry.work.json');
  writeFileSync(file, JSON.stringify({ schema: 'home23.resident.work.v1', resident: 'jerry', assignments: [
    { id: 'wrk_music', title: 'Compare a musical idea', origin: 'resident_initiative', purpose: 'exploration',
      state: 'succeeded', residentMove: 'Make one sourced comparison.', conclusion: null },
  ] }));
  assert.deepEqual(reconcileCanonicalWork(kernel, file, 'jerry'), { available: true, changed: 0 });
  assert.equal(kernel.store.listTasks({ limit: 20 }).length, 0);
  assert.equal((await kernel.tick()).nextAction.kind, 'rest');
  assert.deepEqual(reconcileCanonicalWork(kernel, file, 'jerry'), { available: true, changed: 0 });
});
