import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyScheduledArtifactResult } from '../../src/scheduler/artifact-result.js';
import { CronScheduler, type CronJob, type JobPayload, type JobResult } from '../../src/scheduler/cron.js';

const payload: JobPayload = { kind: 'agentTurn', message: 'Maintain freshness',
  artifactContract: { kind: 'own_brain_derived_state_freshness', maxAgeSeconds: 21_600 } };

test('pending canonical work and failed turns cannot acquire a freshness success', async () => {
  for (const result of [{ status: 'error', canonicalRunPending: true, durationMs: 1, semanticStatus: 'unknown' },
    { status: 'ok', durationMs: 1, semanticStatus: 'failed' },
    { status: 'error', durationMs: 1, semanticStatus: 'failed', error: 'deadline' }] as JobResult[]) {
    assert.equal(await verifyScheduledArtifactResult('/missing-private-brain', payload, result), result);
  }
});

test('jobs without an explicit artifact contract preserve their existing outcome', async () => {
  const result: JobResult = { status: 'ok', durationMs: 1, semanticStatus: 'unknown' };
  assert.equal(await verifyScheduledArtifactResult('/missing', { kind: 'agentTurn', message: 'hello' }, result), result);
  assert.equal(await verifyScheduledArtifactResult('/missing', { kind: 'systemEvent', text: 'hello' }, result), result);
});

for (const contract of [null, false, 0, '']) test(`explicit invalid contract ${JSON.stringify(contract)} cannot bypass verification`, async () => {
  const result = await verifyScheduledArtifactResult('/missing', { ...payload, artifactContract: contract } as any,
    { status: 'ok', durationMs: 1, semanticStatus: 'satisfied', artifacts: ['/unverified-output'] });
  assert.equal(result.status, 'ok');
  assert.equal(result.semanticStatus, 'failed');
  assert.equal(result.outcomeLayers?.artifact?.evidence?.condition, 'invalid_contract');
  assert.deepEqual(result.artifacts ?? [], []);
});

test('a mechanically successful refresh with no artifact records semantic failure durably', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-artifact-receipt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const job: CronJob = { id: 'freshness', name: 'Freshness', enabled: true,
    schedule: { kind: 'every', everyMs: 60_000 }, sessionTarget: 'isolated', wakeMode: 'now', payload,
    state: { nextRunAtMs: Date.now() - 1000, consecutiveErrors: 0 } };
  writeFileSync(join(dir, 'cron-jobs.json'), JSON.stringify([job]));
  const scheduler = new CronScheduler({ jobsFile: 'cron-jobs.json', runsDir: 'cron-runs', timezone: 'UTC' },
    async current => verifyScheduledArtifactResult(dir, current.payload,
      { status: 'ok', response: 'Done, refreshed it.', durationMs: 7,
        artifacts: [join(dir, 'unverified-output.json')],
        outcomeLayers: { task: { status: 'success', reason: 'turn completed' } } }), dir);
  t.after(() => scheduler.stop());
  const result = await scheduler.runJobNow(job.id);
  assert.equal(result.status, 'ok');
  assert.equal(result.semanticStatus, 'failed');
  assert.deepEqual(result.artifacts ?? [], []);
  assert.equal(result.outcomeLayers?.task?.status, 'success');
  const rows = readFileSync(join(dir, 'cron-runs/freshness.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.equal(rows.at(-1).outcome.mechanicalStatus, 'ok');
  assert.equal(rows.at(-1).outcome.semanticStatus, 'failed');
  assert.equal(rows.at(-1).outcome.layers.artifact.status, 'failed');
  assert.equal(rows.at(-1).outcome.layers.intent.status, 'failed');
  assert.equal(JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))[0].state.lastSemanticStatus, 'failed');
});

test('a verified recent artifact satisfies freshness without claiming this turn produced it', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-artifact-result-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state: Record<string, unknown> = { operationId: 'brop_' + 'A'.repeat(32), sourceRevision: 7,
    generationMarker: 'generation-7-' + 'a'.repeat(24), provider: 'fixture', model: 'fixture',
    generatedAt: new Date(Date.now() - 60_000).toISOString(), summary: 'existing artifact' };
  const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  state.brainStateSha256 = 'sha256:' + createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
  writeFileSync(join(dir, 'brain-state.json'), JSON.stringify(state));
  const result = await verifyScheduledArtifactResult(dir, payload, { status: 'ok', response: 'Already fresh', durationMs: 2 });
  assert.equal(result.semanticStatus, 'satisfied');
  assert.deepEqual(result.artifacts, [join(dir, 'brain-state.json')]);
  assert.equal(result.outcomeLayers?.artifact?.evidence?.operationId, state.operationId);
});

test('both isolated and canonical terminal cron turns use the same runtime brain verifier', () => {
  const home = readFileSync(new URL('../../src/home.ts', import.meta.url), 'utf8');
  assert.match(home, /const verified = await verifyScheduledArtifactResult\(BRAIN_DIR, job.payload, result\)/);
  assert.match(home, /jobResult = await verifyScheduledArtifactResult\(BRAIN_DIR, job.payload, jobResult\)/);
});
