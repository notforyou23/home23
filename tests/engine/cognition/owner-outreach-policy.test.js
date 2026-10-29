import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { OwnerOutreachPolicy } = require('../../../engine/src/cognition/owner-outreach-policy');
const { OwnerOutreachOutbox } = require('../../../engine/src/cognition/owner-outreach-outbox');
const { normalizeOwnerOutreach } = require('../../../engine/src/cognition/owner-outreach');

function directory(t) {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-owner-attention-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  return brainDir;
}

function intent(policy, { deliveryId = 'outreach:one', observation, kind = 'problem', text = 'A verified operational condition needs attention.', refs = [] } = {}) {
  const evidenceRefs = [...(observation ? [observation.sourceRef] : []), ...refs];
  const outreach = { category: 'insight', text, reason: 'This contact has a specific grounded operational consequence.', evidenceRefs,
    attention: { kind, consequence: 'This verified condition changes a specific operational consequence.', evidenceRefs } };
  return { request: { deliveryId, text, reason: outreach.reason, evidenceRefs },
    attentionIntent: policy.buildIntent(outreach, { candidate: { observation }, memory: {}, deliveryId }) };
}

test('pending content precedes reservation, survives a crash there, and retries without new cognition', async t => {
  const brainDir = directory(t);
  const policy = new OwnerOutreachPolicy({ brainDir });
  const data = intent(policy, { observation: { channelId: 'machine.memory', sourceRef: 'mem:critical', payload: { pressureFreePct: 4 } } });
  const originalReserve = policy.reserve.bind(policy);
  let crash = true;
  policy.reserve = (...args) => { if (crash) throw new Error('simulated process loss before admission'); return originalReserve(...args); };
  const delivered = [];
  const box = new OwnerOutreachOutbox(brainDir, async request => { delivered.push(request); return { status: 'committed' }; }, { policy });
  const result = await box.send(data.request, data.attentionIntent);
  assert.equal(result.status, 'pending');
  assert.equal(delivered.length, 0);
  assert.equal(fs.readdirSync(path.join(brainDir, 'owner-outreach-pending')).length, 1);
  crash = false;
  const recovered = new OwnerOutreachOutbox(brainDir, async request => { delivered.push(request); return { status: 'committed' }; },
    { policy: new OwnerOutreachPolicy({ brainDir }) });
  await recovered.retry();
  assert.deepEqual(delivered, [data.request]);
  assert.equal(fs.readdirSync(path.join(brainDir, 'owner-outreach-pending')).length, 0);
});

test('uncertain acknowledgement retries the original delivery identity and blocks fresh repeats', async t => {
  const brainDir = directory(t);
  const policy = new OwnerOutreachPolicy({ brainDir });
  const data = intent(policy, { observation: { channelId: 'machine.memory', sourceRef: 'mem:critical', payload: { pressureFreePct: 4 } } });
  policy.complete = () => { throw new Error('simulated process loss after harness acceptance'); };
  const received = []; const committed = new Set();
  const transport = async request => { received.push(request); committed.add(request.deliveryId); return { status: 'committed' }; };
  assert.equal((await new OwnerOutreachOutbox(brainDir, transport, { policy }).send(data.request, data.attentionIntent)).status, 'pending');
  const restored = new OwnerOutreachPolicy({ brainDir });
  assert.equal(restored.preview(data.attentionIntent).allow, false, 'a new cognitive cycle cannot reserve another message for the pending condition');
  await new OwnerOutreachOutbox(brainDir, transport, { policy: restored }).retry();
  assert.deepEqual(received, [data.request, data.request]);
  assert.equal(committed.size, 1, 'receiver can apply its existing delivery-id idempotency');
});

test('legacy and rejected pending content is held with a durable reason while legitimate delivery can continue', async t => {
  const brainDir = directory(t);
  const policy = new OwnerOutreachPolicy({ brainDir });
  const legacy = { schema: 'home23.owner-outreach-pending.v1', request: { deliveryId: 'outreach:legacy', text: 'Repeated RAM sample.', reason: 'A fresh sample exists.', evidenceRefs: ['mem:old'] } };
  fs.mkdirSync(path.join(brainDir, 'owner-outreach-pending'));
  fs.writeFileSync(path.join(brainDir, 'owner-outreach-pending', `${'a'.repeat(64)}.json`), JSON.stringify(legacy));
  const received = [];
  const box = new OwnerOutreachOutbox(brainDir, async request => { received.push(request); return { status: 'committed' }; }, { policy });
  const [result] = await box.retry();
  assert.equal(result.status, 'suppressed');
  assert.equal(result.durableState, 'held');
  assert.equal(result.attentionDecision.reason, 'attention_intent_unavailable');
  const held = JSON.parse(fs.readFileSync(path.join(brainDir, 'owner-outreach-held', `${'a'.repeat(64)}.json`), 'utf8'));
  assert.deepEqual(held.entry, legacy, 'legacy content is preserved for inspection, never inferred to be approved');
  assert.equal(fs.readdirSync(path.join(brainDir, 'owner-outreach-pending')).length, 0);
  const data = intent(policy, { deliveryId: 'outreach:useful', observation: { channelId: 'machine.memory', sourceRef: 'mem:critical', payload: { pressureFreePct: 4 } } });
  assert.equal((await box.send(data.request, data.attentionIntent)).status, 'committed');
  assert.deepEqual(received, [data.request]);
});

test('graph provenance remains machine-derived when a candidate adds unrelated conversational evidence', t => {
  const policy = new OwnerOutreachPolicy({ brainDir: directory(t) });
  const memory = { nodes: new Map([['ram', { id: 'ram', concept: 'A summarized memory pressure sample.',
    provenance: { sourceRefs: ['machine.memory', 'mem:prior-sample'] } }]]) };
  const outreach = { text: 'Another RAM notice.', evidenceRefs: ['memory:unrelated'],
    attention: { kind: 'connection', consequence: 'A purported connection to a nearby remembered idea.', evidenceRefs: ['memory:unrelated'] } };
  const pending = policy.buildIntent(outreach, { candidate: { nodeIds: ['ram'] }, memory, deliveryId: 'outreach:graph' });
  assert.equal(pending.conditions[0].topic, 'machine.memory');
  assert.equal(policy.preview(pending).reason, 'machine_condition_unavailable');
});

test('severity oscillation and timestamp refresh cannot repeat a problem; actual escalation and recovery can', t => {
  const policy = new OwnerOutreachPolicy({ brainDir: directory(t) });
  const sample = (value, id) => ({ channelId: 'machine.memory', sourceRef: `mem:${id}`, payload: { pressureFreePct: value } });
  const reserve = (value, id, kind = 'problem') => {
    const observation = sample(value, id); policy.observe({ observation }, {});
    const data = intent(policy, { observation, deliveryId: `outreach:${id}`, kind });
    return policy.reserve(data.attentionIntent, data.request);
  };
  assert.equal(reserve(9, 'severe').allow, true);
  assert.equal(reserve(4.9, 'critical').allow, true);
  assert.equal(reserve(5.1, 'jitter').allow, false);
  assert.equal(reserve(4.8, 'critical-again').allow, false);
  assert.equal(reserve(49, 'recovered', 'recovery').allow, true);
  assert.equal(reserve(48, 'normal-again', 'recovery').allow, false);
  assert.equal(reserve(4, 'new-episode').allow, true);
});

test('CPU load and restart counter changes do not assert new actionable consequences', t => {
  const policy = new OwnerOutreachPolicy({ brainDir: directory(t) });
  const first = { channelId: 'os.pm2', sourceRef: 'pm2:jerry:stopped:1', payload: { name: 'jerry', status: 'stopped', restartCount: 1 } };
  const data = intent(policy, { observation: first });
  policy.observe({ observation: first }, {});
  assert.equal(policy.reserve(data.attentionIntent, data.request).allow, true);
  const fresh = { ...first, sourceRef: 'pm2:jerry:stopped:20', payload: { ...first.payload, restartCount: 20 } };
  const repeated = intent(policy, { observation: fresh, deliveryId: 'outreach:restarted', text: 'A fresh restart counter sample.' });
  policy.observe({ observation: fresh }, {});
  assert.equal(policy.preview(repeated.attentionIntent).allow, false);
  const cpu = { channelId: 'machine.cpu', sourceRef: 'cpu:high-load-only', payload: { cpuCount: 10, loadAvg: [10, 9, 8] } };
  const cpuData = intent(policy, { observation: cpu, deliveryId: 'outreach:cpu' });
  assert.equal(cpuData.attentionIntent.conditions[0].condition, 'cpu:load-pressure', 'load alone is not saturation evidence');
  assert.equal(policy.preview({ ...cpuData.attentionIntent, attention: null }).reason, 'machine_consequence_missing');
  const rawOnly = { channelId: 'machine.memory', sourceRef: 'mem:raw-only', payload: { rawFreePct: 1.8, freePct: 1.8 } };
  const rawData = intent(policy, { observation: rawOnly, deliveryId: 'outreach:raw-free' });
  assert.equal(policy.preview(rawData.attentionIntent).reason, 'machine_condition_unavailable', 'raw free RAM cannot be promoted to critical memory pressure');
});

test('attention consequence references are constrained to the actual admitted message basis', () => {
  const base = { category: 'insight', text: 'A grounded connection.', reason: 'This is a grounded reason for contact.', evidenceRefs: ['message:owner'] };
  assert.equal(normalizeOwnerOutreach({ ...base, attention: { kind: 'connection', consequence: 'A useful connection to something you told me.', evidenceRefs: ['invented:ref'] } }, ['message:owner']), null);
  assert.ok(normalizeOwnerOutreach({ ...base, attention: { kind: 'connection', consequence: 'A useful connection to something you told me.', evidenceRefs: ['message:owner'] } }, ['message:owner']));
});

function quietRoutineMemoryLesson() {
  return { version: 1, seq: 42, decisions: [], lessons: [{
    lessonId: 'lesson:owner-routine-memory', scope: 'owner.outreach:machine.memory',
    tags: ['unsolicited', 'routine', 'mild'], excludes: ['critical', 'requested'],
    sourceRefs: ['message:owner-feedback'], value: -0.25, basis: 'owner-feedback', authority: 'owner',
    criterion: 'owner-value', decisionId: 'outreach:earlier', createdAt: '2026-10-29T18:00:00Z',
    corroborations: 0, active: true,
  }] };
}

test('scoped Seed learning changes an otherwise eligible actual send with identical evidence and candidate', async t => {
  const snapshot = quietRoutineMemoryLesson();
  const observation = { channelId: 'machine.memory', sourceRef: 'mem:first-mild', payload: { pressureFreePct: 19 } };
  const deliveries = [];
  for (const [name, learning] of [['learned', snapshot], ['ablated', { ...snapshot, lessons: [] }]]) {
    const policy = new OwnerOutreachPolicy({ brainDir: directory(t), readLearning: () => learning });
    const data = intent(policy, { observation, deliveryId: 'outreach:same-choice', text: 'Mild memory pressure appeared; no failure has been observed.' });
    const box = new OwnerOutreachOutbox(path.dirname(policy.file), async request => { deliveries.push({ name, request }); return { status: 'committed' }; }, { policy });
    const result = await box.send(data.request, data.attentionIntent);
    assert.equal(result.status, name === 'learned' ? 'suppressed' : 'committed');
    if (name === 'learned') {
      assert.equal(result.attentionDecision.reason, 'learned_scoped_attenuation');
      assert.deepEqual(result.attentionDecision.learning.lessonIds, ['lesson:owner-routine-memory']);
      assert.equal(result.attentionDecision.learning.seq, 42);
    }
  }
  assert.deepEqual(deliveries.map(item => item.name), ['ablated'], 'only removing learned state changes this real transport callback');
});

test('learned routine scope transfers across wording without suppressing critical, mixed evidence or recovery paths', t => {
  const policy = new OwnerOutreachPolicy({ brainDir: directory(t), readLearning: quietRoutineMemoryLesson });
  for (const [id, text] of [['one', 'An initial mild pressure observation.'], ['two', 'There is a modest reclaimable-headroom change.']]) {
    const data = intent(policy, { deliveryId: `outreach:${id}`, observation: { channelId: 'machine.memory', sourceRef: `mem:${id}`, payload: { pressureFreePct: 18 } }, text });
    assert.equal(policy.preview(data.attentionIntent).allow, false);
  }
  const critical = intent(policy, { deliveryId: 'outreach:critical', observation: { channelId: 'machine.memory', sourceRef: 'mem:critical', payload: { pressureFreePct: 4 } } });
  assert.equal(policy.reserve(critical.attentionIntent, critical.request).allow, true);
  const recoveredObservation = { channelId: 'machine.memory', sourceRef: 'mem:recovery', payload: { pressureFreePct: 48 } };
  policy.observe({ observation: recoveredObservation }, {});
  const recovery = intent(policy, { deliveryId: 'outreach:recovery', observation: recoveredObservation, kind: 'recovery' });
  assert.equal(policy.preview(recovery.attentionIntent).allow, true);
  const mixed = intent(policy, { deliveryId: 'outreach:mixed', observation: { channelId: 'machine.memory', sourceRef: 'mem:mixed', payload: { pressureFreePct: 19 } },
    refs: ['message:owner-project'], kind: 'connection' });
  assert.equal(policy.preview(mixed.attentionIntent).allow, true, 'a meaningful machine/person connection is outside routine measurement commentary');
  const watch = intent(policy, { deliveryId: 'outreach:watch', observation: { channelId: 'domain.health', sourceRef: 'health:watch', payload: {} }, refs: ['message:owner-cold'], kind: 'connection' });
  assert.equal(policy.preview(watch.attentionIntent).allow, true);
});

test('real measurement producers establish measurement-only scope; other evidence and attention kinds retain authored judgment', async t => {
  const { MemoryChannel } = await import('../../../engine/src/channels/machine/memory-channel.js');
  const channel = new MemoryChannel({ platform: 'darwin', sampleRawMemory: () => ({ total: 1000, free: 10 }),
    sampleDarwinPressure: async () => ({ source: 'memory_pressure -Q', freePct: 19, totalBytes: 1000 }) });
  const observation = channel.verify(channel.parse((await channel.poll())[0]));
  assert.equal(observation.payload.pressureFreePct, 19);
  assert.equal('impact' in observation.payload || 'oomCount' in observation.payload, false, 'the actual producer does not attest impact absence');
  const policy = new OwnerOutreachPolicy({ brainDir: directory(t), readLearning: quietRoutineMemoryLesson });
  const routine = intent(policy, { observation });
  assert.equal(policy.preview(routine.attentionIntent).allow, false);
  assert.ok(routine.attentionIntent.learningDecisions[0].tags.includes('attention:problem'));
  assert.ok(routine.attentionIntent.learningDecisions[0].tags.includes('context:measurement-only'));
  assert.ok(routine.attentionIntent.learningDecisions[0].tags.includes('impact:unestablished'), 'lack of incident evidence is not a claim that no incident exists');
  for (const kind of ['connection', 'decision', 'progress']) {
    const mixed = intent(policy, { deliveryId: `outreach:${kind}`, observation, kind, refs: ['message:owner-next-action'] });
    assert.equal(policy.preview(mixed.attentionIntent).allow, true, `routine feedback cannot suppress grounded ${kind} context`);
    assert.deepEqual(mixed.attentionIntent.learningDecisions, []);
  }
  for (const evidenceRef of ['coordination.event:work-terminal', 'action-receipt:execution-failed']) {
    const impacted = intent(policy, { deliveryId: `outreach:${evidenceRef}`, observation, refs: [evidenceRef] });
    assert.equal(policy.preview(impacted.attentionIntent).allow, true, 'a nonmeasurement consequence basis retains the existing policy, even for problem contact');
    assert.deepEqual(impacted.attentionIntent.learningDecisions, []);
  }
});

test('an admitted delivery keeps its exact learning witness across uncertain completion and later learning', async t => {
  let learning = { ...quietRoutineMemoryLesson(), lessons: [] };
  const brainDir = directory(t);
  const policy = new OwnerOutreachPolicy({ brainDir, readLearning: () => learning });
  const data = intent(policy, { deliveryId: 'outreach:reserved-before-feedback', observation: { channelId: 'machine.memory', sourceRef: 'mem:mild', payload: { pressureFreePct: 19 } } });
  policy.complete = () => { throw new Error('lost acknowledgement after acceptance'); };
  const sent = [];
  const transport = async request => { sent.push(request.deliveryId); return { status: 'committed' }; };
  assert.equal((await new OwnerOutreachOutbox(brainDir, transport, { policy }).send(data.request, data.attentionIntent)).status, 'pending');
  learning = quietRoutineMemoryLesson();
  const restored = new OwnerOutreachPolicy({ brainDir, readLearning: () => learning });
  const [result] = await new OwnerOutreachOutbox(brainDir, transport, { policy: restored }).retry();
  assert.equal(result.status, 'committed');
  assert.deepEqual(result.attentionDecision.learning.lessonIds, [], 'retry does not reinterpret an already reserved choice using a later lesson');
  assert.deepEqual(sent, [data.request.deliveryId, data.request.deliveryId]);
});

test('structured disk scopes retain mount identity without broadening a lesson to other situations', t => {
  let snapshot = { version: 1, available: true, lessons: [] };
  const policy = new OwnerOutreachPolicy({ brainDir: directory(t), readLearning: () => snapshot });
  const disk = mount => ({ channelId: 'machine.disk', sourceRef: `disk:${mount}`, payload: { mount, usagePct: 88 } });
  const first = intent(policy, { observation: disk('/fixture/data'), deliveryId: 'outreach:data-disk' });
  const decision = first.attentionIntent.learningDecisions[0];
  assert.ok(decision, 'a path-bearing topic must still produce a bounded learning scope');
  snapshot = { ...quietRoutineMemoryLesson(), lessons: [{ ...quietRoutineMemoryLesson().lessons[0], scope: decision.scope }] };
  assert.equal(policy.preview(first.attentionIntent).allow, false);
  const other = intent(policy, { observation: disk('/fixture/system'), deliveryId: 'outreach:system-disk' });
  assert.notEqual(other.attentionIntent.learningDecisions[0].scope, decision.scope);
  assert.equal(policy.preview(other.attentionIntent).allow, true, 'one mounted volume cannot silently teach another volume');
});

test('durable outreach intent recovers a failed decision append before sending, without duplicate witnesses', async t => {
  const { appendSeedProjectionOnce } = require('../../../shared/seed-source-projection.cjs');
  for (const crashAfterAppend of [false, true]) {
    const brainDir = directory(t), policy = new OwnerOutreachPolicy({ brainDir });
    const data = intent(policy, { deliveryId: `outreach:projection-${crashAfterAppend}`,
      observation: { channelId: 'machine.memory', sourceRef: 'mem:real-basis', payload: { pressureFreePct: 19 } } });
    const sent = [];
    const transport = async request => { sent.push(request); return { status: 'committed' }; };
    const broken = new OwnerOutreachOutbox(brainDir, transport, { policy,
      appendDecision: (file, event, options) => {
        if (crashAfterAppend) appendSeedProjectionOnce(file, event, options);
        throw new Error('fixture interrupted decision projection');
      } });
    assert.equal((await broken.send(data.request, data.attentionIntent)).status, 'pending');
    assert.equal(sent.length, 0, 'the message cannot escape before its source witness is durable');
    const pendingFile = path.join(brainDir, 'owner-outreach-pending', fs.readdirSync(path.join(brainDir, 'owner-outreach-pending'))[0]);
    const saved = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
    assert.deepEqual(saved.attentionIntent.learningDecisionEvents, data.attentionIntent.learningDecisionEvents);
    assert.equal(saved.decisionProjection.attempted.length, 1);
    const [recovered] = await new OwnerOutreachOutbox(brainDir, transport, { policy: new OwnerOutreachPolicy({ brainDir }) }).retry();
    assert.equal(recovered.status, 'committed');
    assert.equal(sent.length, 1);
    const witnesses = fs.readFileSync(path.join(brainDir, 'event-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
      .filter(row => row.event_type === 'LearningDecisionObserved');
    assert.deepEqual(witnesses, data.attentionIntent.learningDecisionEvents, 'canonical identity and time survive both failure points');
  }
});
