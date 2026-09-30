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
