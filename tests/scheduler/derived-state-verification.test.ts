import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyOwnBrainDerivedStateFreshness, type DerivedStateFreshnessContract } from '../../src/scheduler/derived-state-verification.js';

const require = createRequire(import.meta.url);
const { canonicalJson } = require('../../shared/brain-operations/canonical-json.cjs');
const NOW = Date.parse('2026-10-08T10:07:00.000Z');
const contract: DerivedStateFreshnessContract = { kind: 'own_brain_derived_state_freshness', maxAgeSeconds: 21600 };

async function brain(t: any) {
  const root = await fs.mkdtemp(join(tmpdir(), 'home23-derived-verification-'));
  const brainDir = join(root, 'brain'); await fs.mkdir(brainDir);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, brainDir, file: join(brainDir, 'brain-state.json') };
}
function committed(generatedAt = new Date(NOW - 1000).toISOString()) {
  const state = { generatedAt, generationMarker: 'generation-2-' + 'a'.repeat(24),
    operationId: 'brop_' + 'A'.repeat(32), sourceRevision: 2, sourceGeneration: 'fixture-generation',
    startedAt: new Date(NOW - 2000).toISOString(), provider: 'fixture', model: 'fixture',
    selfUnderstanding: { summary: 'Private test fixture.' } };
  return { ...state, brainStateSha256: 'sha256:' + createHash('sha256').update(canonicalJson(state)).digest('hex') };
}
async function write(file: string, state = committed()) { await fs.writeFile(file, canonicalJson(state) + '\n', { mode: 0o600 }); }
function noArtifacts(result: Awaited<ReturnType<typeof verifyOwnBrainDerivedStateFreshness>>) { assert.equal(result.artifacts?.length ?? 0, 0); }

test('a real verified fresh artifact satisfies the objective with original snapshot evidence', async t => {
  const fx = await brain(t), state = committed(); await write(fx.file, state);
  const before = await fs.readFile(fx.file);
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'satisfied'); assert.deepEqual(result.artifacts, [fx.file]);
  assert.equal(result.outcomeLayers?.artifact?.status, 'success'); assert.equal(result.outcomeLayers?.intent?.status, 'success');
  const evidence = result.outcomeLayers?.artifact?.evidence;
  assert.equal(evidence?.path, fx.file); assert.equal(evidence?.generatedAt, state.generatedAt);
  assert.equal(evidence?.sourceRevision, 2); assert.equal(evidence?.sourceGeneration, 'fixture-generation');
  assert.equal(evidence?.brainStateSha256, state.brainStateSha256); assert.equal(evidence?.operationId, state.operationId);
  assert.equal(evidence?.ageSeconds, 1); assert.equal(evidence?.maxAgeSeconds, 21600);
  assert.deepEqual(await fs.readFile(fx.file), before, 'verification cannot change artifact bytes');
});

for (const ageMs of [21600000, 21600001, 363200 * 1000]) test(`age ${ageMs}ms is stale, including equality at the bound`, async t => {
  const fx = await brain(t); await write(fx.file, committed(new Date(NOW - ageMs).toISOString()));
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'failed'); assert.equal(result.outcomeLayers?.artifact?.status, 'failed');
  assert.equal(result.outcomeLayers?.intent?.status, 'failed'); assert.match(result.outcomeLayers!.artifact!.reason, /stale/i); noArtifacts(result);
});

test('the last millisecond below the age bound is fresh', async t => {
  const fx = await brain(t); await write(fx.file, committed(new Date(NOW - 21599999).toISOString()));
  assert.equal((await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW)).semanticStatus, 'satisfied');
});

test('an older valid artifact without source generation remains verifiable', async t => {
  const fx = await brain(t); const state: any = committed(); delete state.sourceGeneration; delete state.startedAt; delete state.brainStateSha256;
  state.brainStateSha256 = 'sha256:' + createHash('sha256').update(canonicalJson(state)).digest('hex'); await write(fx.file, state);
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'satisfied'); assert.equal(result.outcomeLayers?.artifact?.evidence?.sourceRevision, 2);
});

test('missing artifact is an objective failure, not proof of fresh state', async t => {
  const fx = await brain(t); const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'failed'); assert.match(result.outcomeLayers!.artifact!.reason, /missing/i); noArtifacts(result);
});

for (const corruption of ['json', 'hash', 'timestamp']) test(`real reader rejects ${corruption} corruption without reporting an artifact`, async t => {
  const fx = await brain(t);
  if (corruption === 'json') await fs.writeFile(fx.file, '{bad-json');
  else { const state = committed(); if (corruption === 'hash') state.brainStateSha256 = 'sha256:' + '0'.repeat(64); else state.generatedAt = 'not-a-date'; await write(fx.file, state); }
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'failed'); assert.equal(result.outcomeLayers?.artifact?.status, 'failed'); noArtifacts(result);
});

test('an artifact symlink cannot use a valid outside hash to forge success', async t => {
  const fx = await brain(t), outside = join(fx.root, 'outside-state.json'); await write(outside); await fs.symlink(outside, fx.file);
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'failed'); noArtifacts(result); assert.equal((await fs.lstat(fx.file)).isSymbolicLink(), true);
});

test('unbound directories remain unknown, including nonabsolute and symlink roots', async t => {
  const fx = await brain(t); await write(fx.file);
  const link = join(fx.root, 'brain-link'); await fs.symlink(fx.brainDir, link);
  for (const path of ['', 'relative/brain', join(fx.root, 'absent-brain'), link]) {
    const result = await verifyOwnBrainDerivedStateFreshness(path, contract, NOW);
    assert.equal(result.semanticStatus, 'unknown'); assert.equal(result.outcomeLayers?.artifact?.status, 'unknown'); noArtifacts(result);
  }
});

test('unreadable artifact stays unknown rather than becoming a fabricated pass', async t => {
  if (process.getuid?.() === 0) { t.skip('Root can bypass file read permissions'); return; }
  const fx = await brain(t); await write(fx.file); await fs.chmod(fx.file, 0o000);
  try {
    const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
    assert.equal(result.semanticStatus, 'unknown'); assert.equal(result.outcomeLayers?.intent?.status, 'unknown'); noArtifacts(result);
  } finally { await fs.chmod(fx.file, 0o600); }
});

test('a valid-hash future timestamp fails the objective', async t => {
  const fx = await brain(t); await write(fx.file, committed(new Date(NOW + 1).toISOString()));
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, NOW);
  assert.equal(result.semanticStatus, 'failed'); assert.match(result.outcomeLayers!.artifact!.reason, /future/i); noArtifacts(result);
});

test('runtime-tampered contracts fail before reading an artifact or accepting a path', async t => {
  const fx = await brain(t); await write(fx.file);
  for (const value of [0, -1, NaN, Infinity, -Infinity, '21600', null, undefined]) {
    const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, { ...contract, maxAgeSeconds: value } as any, NOW);
    assert.equal(result.semanticStatus, 'failed'); noArtifacts(result);
  }
  for (const value of [null, {}, { ...contract, kind: 'other' }, { ...contract, path: fx.file }, Object.create(contract)]) {
    const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, value as any, NOW);
    assert.equal(result.semanticStatus, 'failed'); noArtifacts(result);
  }
});

test('invalid verification clocks cannot label an artifact fresh', async t => {
  const fx = await brain(t); await write(fx.file);
  for (const value of [NaN, Infinity, -Infinity, 'now']) {
    const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, contract, value as any);
    assert.equal(result.semanticStatus, 'failed'); noArtifacts(result);
  }
});

test('runtime proxy reads cannot replace the validated age bound with infinity', async t => {
  const fx = await brain(t); await write(fx.file, committed(new Date(NOW - 21600001).toISOString()));
  const changed = new Proxy({ ...contract }, { get(target, key, receiver) { return key === 'maxAgeSeconds' ? Infinity : Reflect.get(target, key, receiver); } });
  const result = await verifyOwnBrainDerivedStateFreshness(fx.brainDir, changed, NOW);
  assert.equal(result.semanticStatus, 'failed'); noArtifacts(result);
});
