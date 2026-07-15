import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryIngest, applyChannelCap, CHANNEL_CAPS } from '../../../engine/src/channels/memory-ingest.cjs';
import { makeTraceId } from '../../../engine/src/channels/contract.js';
import memoryAuthority from '../../../shared/memory-authority.cjs';
import authorityAttestation from '../../../shared/memory-authority-attestation.cjs';

const AUTHORITY_KEY = '4'.repeat(64);

test('CHANNEL_CAPS has the six channel-class methods', () => {
  for (const k of ['sensor_primary', 'sensor_derived', 'build_event', 'work_event', 'neighbor_gossip', 'zero_context_audit']) {
    assert.ok(typeof CHANNEL_CAPS[k] === 'number', `missing cap: ${k}`);
  }
});

test('applyChannelCap clamps confidence at the cap', () => {
  assert.equal(applyChannelCap('neighbor_gossip', 0.95), 0.70);
  assert.equal(applyChannelCap('build_event', 0.5), 0.5);
  assert.equal(applyChannelCap('unknown_method', 0.99), 0.99);
});

test('MemoryIngest.writeFromObservation creates a full MemoryObject and a receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'build.git',
    sourceRef: 'git:abc1234',
    receivedAt: '2026-04-21T15:00:00Z',
    producedAt: '2026-04-21T15:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.99,
    payload: { sha: 'abc1234', subject: 'feat: thing' },
    verifierId: 'git:log',
  };
  const draft = { method: 'build_event', type: 'observation', topic: 'git', tags: ['build', 'git'] };
  const mo = await ingest.writeFromObservation(obs, draft);
  assert.ok(mo.memory_id);
  assert.equal(mo.type, 'observation');
  assert.equal(mo.confidence.score, 0.9); // capped at build_event cap
  assert.equal(mo.provenance.generation_method, 'build_event');
  assert.ok(mo.provenance.source_refs.includes('git:abc1234'));
  assert.ok(existsSync(join(dir, 'memory-objects.json')));
  assert.ok(existsSync(join(dir, 'crystallization-receipts.jsonl')));
  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  assert.equal(raw.objects.length, 1);
  assert.equal(raw.objects[0].provenance.trace_id, makeTraceId('build.git', 'git:abc1234'));
  assert.ok(raw.objects[0].provenance.source_refs.includes(makeTraceId('build.git', 'git:abc1234')));
  assert.equal(raw.objects[0].provenance.authority.schema, 'home23.memory-authority.v1');
  assert.equal(raw.objects[0].provenance.authority.sourceIssue, 85);
  assert.equal(raw.objects[0].provenance.authority.sourceSurface, 'build.git');
  assert.equal(raw.objects[0].provenance.authority.presentTenseAuthority, false);
  assert.ok(raw.objects[0].provenance.authority.verificationBeforeReuse.includes('check_current_source_of_truth'));
  const receiptLines = readFileSync(join(dir, 'crystallization-receipts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(receiptLines.length, 1);
  const r = JSON.parse(receiptLines[0]);
  assert.equal(r.traceId, makeTraceId('build.git', 'git:abc1234'));
  assert.equal(r.channelId, 'build.git');
  assert.equal(r.memoryObjectId, mo.memory_id);
});

test('MemoryIngest classifies source role and doctrine posture before reuse', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-source-class-'));
  const ingest = new MemoryIngest({ brainDir: dir });

  const publicChange = await ingest.writeFromObservation({
    channelId: 'from-the-inside.publish',
    sourceRef: 'from-the-inside/099',
    receivedAt: '2026-05-11T14:16:15Z',
    producedAt: '2026-05-11T14:16:15Z',
    flag: 'COLLECTED',
    confidence: 0.99,
    payload: { subject: 'from-the-inside/099', published: true },
    verifierId: 'verify-from-the-inside-publish',
  }, {
    method: 'work_event',
    type: 'observation',
    topic: 'publish',
    tags: ['public-facing', 'publish', 'receipt:ev_099'],
  });

  assert.equal(publicChange.provenance.source_class, 'public_facing_change');
  assert.equal(publicChange.provenance.memory_role, 'public_record');
  assert.equal(publicChange.provenance.action_posture, 'verify_before_reuse');
  assert.equal(publicChange.provenance.doctrine_eligible, false);

  const lowProvenance = await ingest.writeFromObservation({
    channelId: 'notice.pass',
    sourceRef: 'notice:stale-cluster',
    receivedAt: '2026-05-11T14:16:15Z',
    producedAt: '2026-05-11T14:16:15Z',
    flag: 'ZERO_CONTEXT',
    confidence: 0.9,
    payload: { summary: 'maybe old context matters' },
  }, {
    method: 'zero_context_audit',
    type: 'observation',
    topic: 'memory',
    tags: ['orientation'],
  });

  assert.equal(lowProvenance.provenance.source_class, 'low_provenance');
  assert.equal(lowProvenance.provenance.action_posture, 'do_not_promote_to_doctrine');
  assert.equal(lowProvenance.provenance.doctrine_eligible, false);
});

test('MemoryIngest prevents affect-shaped telemetry from becoming personal fact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-affect-rails-'));
  const ingest = new MemoryIngest({ brainDir: dir });

  const mo = await ingest.writeFromObservation({
    channelId: 'machine.process',
    sourceRef: 'process:cpu-pressure',
    receivedAt: '2026-05-11T15:00:00Z',
    producedAt: '2026-05-11T15:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.95,
    payload: {
      summary: 'CPU pressure shows jtr is anxious and overwhelmed',
      cpuPct: 91,
    },
    verifierId: 'os:ps-top-cpu',
  }, {
    method: 'sensor_primary',
    type: 'observation',
    topic: 'machine',
    tags: ['machine', 'cpu', 'affect'],
  });

  assert.equal(mo.provenance.source_class, 'affect_inference');
  assert.equal(mo.provenance.memory_role, 'metaphor_or_interpretation');
  assert.equal(mo.provenance.action_posture, 'do_not_treat_as_personal_fact');
  assert.equal(mo.provenance.doctrine_eligible, false);
  assert.match(mo.provenance.boundary, /cannot infer jtr's interior state/);
});

test('MemoryIngest treats operational self-state language as event segmentation first', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-self-state-'));
  const ingest = new MemoryIngest({ brainDir: dir });

  const mo = await ingest.writeFromObservation({
    channelId: 'domain.good-life',
    sourceRef: 'good-life:self-report',
    receivedAt: '2026-05-11T15:20:00Z',
    producedAt: '2026-05-11T15:20:00Z',
    flag: 'COLLECTED',
    confidence: 0.88,
    payload: {
      summary: 'The loop feels stuck because memory is bad, but the queue advanced and publication state did not.',
      queueAdvanced: true,
      publicationStateAdvanced: false,
    },
    verifierId: 'good-life-ledger',
  }, {
    method: 'good_life',
    type: 'observation',
    topic: 'good-life',
    tags: ['good-life', 'self-state', 'loop'],
  });

  assert.equal(mo.provenance.source_class, 'operational_self_report');
  assert.equal(mo.provenance.memory_role, 'event_segmentation');
  assert.equal(mo.provenance.action_posture, 'verify_explanation_before_action');
  assert.equal(mo.provenance.doctrine_eligible, false);
  assert.match(mo.provenance.boundary, /Self-state language segments events/);
  assert.deepEqual(mo.provenance.required_corroboration, ['queue_state', 'publication_state', 'channel_evidence']);
});

test('MemoryIngest dedupes by {channelId, sourceRef} — same ref updates not duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-dedupe-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'build.git', sourceRef: 'git:same', receivedAt: '2026-04-21T00:00:00Z',
    producedAt: '2026-04-21T00:00:00Z', flag: 'COLLECTED', confidence: 0.9, payload: { sha: 'same' },
  };
  const draft = { method: 'build_event', type: 'observation', topic: 'git', tags: [] };
  const first = await ingest.writeFromObservation(obs, draft);
  const second = await ingest.writeFromObservation(obs, draft);
  assert.equal(first.memory_id, second.memory_id);
  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  assert.equal(raw.objects.length, 1);
});

test('MemoryIngest same-source updates leave before and after repair trace', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-repair-trace-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const draft = { method: 'sensor_primary', type: 'observation', topic: 'health', tags: ['health', 'freshness'] };

  const first = await ingest.writeFromObservation({
    channelId: 'domain.health',
    sourceRef: 'health:bridge',
    receivedAt: '2026-05-11T15:30:00Z',
    producedAt: '2026-05-11T15:30:00Z',
    flag: 'UNCERTIFIED',
    confidence: 0.4,
    payload: { summary: 'health bridge is stale', status: 'stale' },
  }, draft);

  const second = await ingest.writeFromObservation({
    channelId: 'domain.health',
    sourceRef: 'health:bridge',
    receivedAt: '2026-05-11T15:35:00Z',
    producedAt: '2026-05-11T15:35:00Z',
    flag: 'COLLECTED',
    confidence: 0.95,
    payload: { summary: 'health bridge is fresh', status: 'fresh' },
  }, draft);

  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  const receipts = readFileSync(join(dir, 'crystallization-receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const updateReceipt = receipts.at(-1);

  assert.equal(first.memory_id, second.memory_id);
  assert.equal(raw.objects.length, 1);
  assert.equal(raw.objects[0].state_delta.delta_class, 'updated_observation');
  assert.equal(raw.objects[0].state_delta.before.summary, 'health bridge is stale');
  assert.equal(raw.objects[0].state_delta.before.flag, 'UNCERTIFIED');
  assert.equal(raw.objects[0].state_delta.after.summary, 'health bridge is fresh');
  assert.equal(raw.objects[0].state_delta.after.flag, 'COLLECTED');
  assert.equal(raw.objects[0].state_delta.why, 'same source observation changed');
  assert.equal(updateReceipt.updateKind, 'updated_observation');
  assert.equal(updateReceipt.stateDelta.before.summary, 'health bridge is stale');
  assert.equal(updateReceipt.stateDelta.after.summary, 'health bridge is fresh');
});

test('MemoryIngest records substrate reinforcement when a source route repeats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-substrate-route-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const draft = { method: 'sensor_primary', type: 'observation', topic: 'pressure', tags: ['pressure', 'house'] };

  const first = await ingest.writeFromObservation({
    channelId: 'domain.pressure',
    sourceRef: 'pressure:bme280',
    receivedAt: '2026-05-11T16:00:00Z',
    producedAt: '2026-05-11T16:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.95,
    payload: { summary: 'pressure sample current', pressure_pa: 101234 },
  }, draft);
  const second = await ingest.writeFromObservation({
    channelId: 'domain.pressure',
    sourceRef: 'pressure:bme280',
    receivedAt: '2026-05-11T16:05:00Z',
    producedAt: '2026-05-11T16:05:00Z',
    flag: 'COLLECTED',
    confidence: 0.95,
    payload: { summary: 'pressure sample changed', pressure_pa: 101235 },
  }, draft);

  const receipts = readFileSync(join(dir, 'crystallization-receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const updateReceipt = receipts.at(-1);

  assert.equal(first.provenance.substrate.schema, 'home23.memory-substrate.v1');
  assert.equal(first.provenance.substrate.sourceIssue, 90);
  assert.equal(first.provenance.substrate.routeUseCount, 1);
  assert.equal(first.provenance.substrate.routeState, 'new_path');
  assert.equal(second.provenance.substrate.routeUseCount, 2);
  assert.equal(second.provenance.substrate.routeState, 'rerouted_path');
  assert.equal(second.reuse_count, 0);
  assert.equal(updateReceipt.substrate.routeUseCount, 2);
  assert.equal(updateReceipt.substrate.routeState, 'rerouted_path');
});

test('MemoryIngest records authority routing so stale memories cannot pose as live truth', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-authority-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const now = new Date().toISOString();

  const current = await ingest.writeFromObservation({
    channelId: 'machine.process',
    sourceRef: 'process:top',
    receivedAt: now,
    producedAt: now,
    flag: 'COLLECTED',
    confidence: 0.95,
    payload: { summary: 'process sample is current', topProcess: 'node' },
    verifierId: 'os:ps-top-cpu',
  }, {
    method: 'sensor_primary',
    type: 'observation',
    topic: 'machine',
    tags: ['machine', 'process'],
  });

  assert.equal(current.provenance.authority.temporalStatus, 'current');
  assert.equal(current.provenance.authority.presentTenseAuthority, true);
  assert.equal(current.provenance.authority.authorityOrder[0], 'live_machine_observation');
  assert.deepEqual(current.provenance.authority.verificationBeforeReuse, ['none_for_same-scope_context_reuse']);

  const historical = await ingest.writeFromObservation({
    channelId: 'memory.session',
    sourceRef: 'archive:sessions/old-health-shortcut',
    receivedAt: now,
    producedAt: '2026-01-01T00:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.9,
    payload: { summary: 'old note said the health shortcut was broken' },
  }, {
    method: 'work_event',
    type: 'observation',
    topic: 'memory',
    tags: ['historical-context', 'health'],
  });

  assert.equal(historical.provenance.source_class, 'historical_context');
  assert.equal(historical.provenance.authority.temporalStatus, 'historical');
  assert.equal(historical.provenance.authority.presentTenseAuthority, false);
  assert.equal(historical.provenance.authority.authorityOrder[0], 'append_only_history');
  assert.ok(historical.provenance.authority.verificationBeforeReuse.includes('must_not_override_current_evidence'));
  assert.match(historical.provenance.authority.wrongTenseGuard, /present-tense operational truth/);
});

test('MemoryIngest grants verified current state only when live verifier evidence is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-node-provenance-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const now = new Date().toISOString();
  const draft = {
    method: 'sensor_primary', type: 'observation', topic: 'machine', tags: ['machine', 'process'],
  };

  const unverified = await ingest.writeFromObservation({
    channelId: 'machine.process', sourceRef: 'process:no-verifier', receivedAt: now,
    producedAt: now, flag: 'COLLECTED', confidence: 0.95,
    payload: { summary: 'process is healthy' },
  }, draft);
  const verified = await ingest.writeFromObservation({
    channelId: 'machine.process', sourceRef: 'process:verified', receivedAt: now,
    producedAt: now, flag: 'COLLECTED', confidence: 0.95,
    payload: { summary: 'process is healthy' }, verifierId: 'os:ps-top-cpu',
  }, draft);

  assert.equal(unverified.provenance.node_profile.schema, 'home23.node-provenance.v1');
  assert.notEqual(unverified.provenance.node_profile.authorityClass, 'verified_current_state');
  assert.equal(unverified.provenance.node_profile.operationalAuthority, false);
  assert.equal(unverified.provenance.node_profile.requiresFreshVerification, true);
  assert.ok(unverified.provenance.node_profile.missingEvidence.includes('verifier_evidence'));
  assert.equal(verified.provenance.node_profile.authorityClass, 'verified_current_state');
  assert.equal(verified.provenance.node_profile.operationalAuthority, true);
  assert.equal(verified.provenance.node_profile.requiresFreshVerification, false);
  assert.deepEqual(verified.provenance.node_profile.evidenceRefs, ['verifier:os:ps-top-cpu']);
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(verified, AUTHORITY_KEY), false);
  assert.notEqual(
    memoryAuthority.classifyClaimAuthority(verified, { authorityKey: AUTHORITY_KEY }),
    'verified_current_state',
  );
});

test('MemoryIngest keeps generated reports narrative and bounds jtr corrections to semantic authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-generated-provenance-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const now = new Date().toISOString();

  const generated = await ingest.writeFromObservation({
    channelId: 'work.report', sourceRef: 'report:generated', receivedAt: now,
    producedAt: now, flag: 'COLLECTED', confidence: 0.9,
    payload: { summary: 'generated report says the deployment is healthy' },
    verifierId: 'report-generator',
  }, {
    method: 'reflection_synthesis', type: 'observation', topic: 'deployment', tags: ['generated-report'],
  });
  const correction = await ingest.writeFromObservation({
    channelId: 'machine.process', sourceRef: 'jtr:correction:process', receivedAt: now,
    producedAt: now, flag: 'COLLECTED', confidence: 0.99,
    payload: { summary: 'jtr says the process status is wrong' },
  }, {
    method: 'conversation', type: 'observation', topic: 'machine', tags: ['jtr-correction', 'machine'],
  });

  assert.equal(generated.provenance.node_profile.authorityClass, 'narrative');
  assert.equal(generated.provenance.node_profile.operationalAuthority, false);
  assert.equal(generated.provenance.node_profile.requiresFreshVerification, true);
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(generated, AUTHORITY_KEY), false);
  assert.equal(correction.provenance.node_profile.authorityClass, 'jtr_correction');
  assert.equal(correction.provenance.node_profile.operationalAuthority, false);
  assert.equal(correction.provenance.node_profile.requiresFreshVerification, true);
  assert.equal(authorityAttestation.verifyMemoryAuthorityAttestation(correction, AUTHORITY_KEY), false);
  assert.notEqual(
    memoryAuthority.classifyClaimAuthority(correction, { authorityKey: AUTHORITY_KEY }),
    'jtr_correction',
  );
});

test('MemoryIngest caps zero-context audit confidence hard', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-zc-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'domain.weather', sourceRef: 'weather:zero:t0', receivedAt: 't', producedAt: 't',
    flag: 'ZERO_CONTEXT', confidence: 0.9, payload: { __zeroContext: true },
  };
  const mo = await ingest.writeFromObservation(obs, { method: 'zero_context_audit', type: 'observation', topic: 'weather', tags: [] });
  assert.ok(mo.confidence.score <= 0.2);
});

test('MemoryIngest preserves cross-agent origin on memory object and receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-origin-'));
  const ingest = new MemoryIngest({ brainDir: dir });
  const obs = {
    channelId: 'neighbor.forrest',
    sourceRef: 'neighbor:forrest:2026-04-24T12:00:00Z',
    receivedAt: '2026-04-24T12:00:01Z',
    producedAt: '2026-04-24T12:00:00Z',
    flag: 'UNCERTIFIED',
    confidence: 0.7,
    payload: { agent: 'forrest', snapshotAt: '2026-04-24T12:00:00Z' },
    origin: {
      agent: 'forrest',
      peerName: 'forrest',
      peerSource: 'remote',
      url: 'http://forrest.local/__state/public.json',
      snapshotAt: '2026-04-24T12:00:00Z',
      protocol: 'home23-neighbor-state',
      protocolVersion: 1,
    },
  };
  const draft = {
    method: 'neighbor_gossip',
    type: 'observation',
    topic: 'neighbor-state',
    tags: ['neighbor', 'forrest', 'agent:forrest'],
  };

  const mo = await ingest.writeFromObservation(obs, draft);
  assert.equal(mo.provenance.origin.agent, 'forrest');
  assert.equal(mo.provenance.origin.peerSource, 'remote');
  assert.ok(mo.provenance.source_refs.includes('agent:forrest'));

  const receipt = JSON.parse(readFileSync(join(dir, 'crystallization-receipts.jsonl'), 'utf8').trim());
  assert.equal(receipt.origin.agent, 'forrest');
  assert.equal(receipt.origin.protocol, 'home23-neighbor-state');
});

test('MemoryIngest serializes concurrent bus writes through one process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mi-concurrent-'));
  const warnings = [];
  const ingest = new MemoryIngest({
    brainDir: dir,
    logger: {
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      error() {},
      info() {},
      debug() {},
    },
  });
  const draft = { method: 'build_event', type: 'observation', topic: 'test', tags: ['test'] };
  const obs = (i) => ({
    channelId: 'test.concurrent',
    sourceRef: `ref-${i}`,
    receivedAt: '2026-05-04T00:00:00Z',
    producedAt: '2026-05-04T00:00:00Z',
    flag: 'COLLECTED',
    confidence: 0.9,
    payload: { i },
  });

  const results = await Promise.allSettled(
    Array.from({ length: 80 }, (_, i) => ingest.writeFromObservation(obs(i), draft))
  );

  assert.equal(results.filter(r => r.status === 'rejected').length, 0);
  assert.equal(warnings.filter(w => w.includes('Lock file is already being held')).length, 0);
  const raw = JSON.parse(readFileSync(join(dir, 'memory-objects.json'), 'utf8'));
  assert.equal(raw.objects.length, 80);
});
