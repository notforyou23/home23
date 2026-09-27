import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Orchestrator } = require('../../../engine/src/core/orchestrator');
const { MotorCortex } = require('../../../engine/src/cognition/motor-cortex');
const { outreachEvidenceRefs, normalizeOwnerOutreach } = require('../../../engine/src/cognition/owner-outreach');
const { OwnerOutreachOutbox } = require('../../../engine/src/cognition/owner-outreach-outbox');
const { attestMemoryAuthority } = require('../../../shared/memory-authority-attestation.cjs');
const logger = { info() {}, warn() {}, error() {} };

async function fixture(t) {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-outreach-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  const requests = [];
  let response = { statusCode: 200, body: { status: 'committed', messageIds: ['message-1'], channelId: 'owner-dm', notification: 'not_confirmed' } };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
    res.writeHead(response.statusCode, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldPort = process.env.BRIDGE_PORT;
  const oldToken = process.env.BRIDGE_TOKEN;
  process.env.BRIDGE_PORT = String(server.address().port);
  process.env.BRIDGE_TOKEN = 'private-fixture-token';
  t.after(async () => {
    if (oldPort === undefined) delete process.env.BRIDGE_PORT; else process.env.BRIDGE_PORT = oldPort;
    if (oldToken === undefined) delete process.env.BRIDGE_TOKEN; else process.env.BRIDGE_TOKEN = oldToken;
    await new Promise(resolve => server.close(resolve));
  });
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logger = logger;
  orchestrator.logsDir = brainDir;
  orchestrator.conversationSalience = {
    getRecentContext: () => '[Owner Jason]: That guitar melody leaves room for another voice.',
    getRecentEntries: () => [{ source: 'seed_contact', eventId: 'message:real-contact' }],
  };
  const graph = { nodes: new Map([['guitar', { id: 'guitar', concept: 'A guitar lesson treats silence as an invitation.', tag: 'historical' }]]), edges: new Map(), clusters: new Map() };
  const messages = []; const events = []; const prompts = []; let actions = 0;
  let verdict = {
    verdict: 'keep', confidence: 0.9, gaps: [], rationale: 'A grounded question for the owner, not an operational obligation.', agendaCandidates: [],
    ownerOutreach: { category: 'question', text: 'Does that open space in the melody feel like an invitation to answer?', reason: 'Your comment about the guitar melody connects to the old lesson about silence.', evidenceRefs: ['message:real-contact', 'memory:guitar'] },
  };
  const makeMachine = () => {
    const machine = orchestrator.createThinkingMachine({
      unifiedClient: { generate: async args => {
        prompts.push(args);
        return { content: args.component === 'critique' ? JSON.stringify(verdict) : 'The guitar lesson and your melody suggest that silence can make room for another voice, though I do not know how it feels to you.' };
      } },
      memory: graph, discoveryEngine: { pop: () => [] }, logger,
      emitThought: thought => messages.push(thought),
      config: {
        getLivedState: () => 'FAILED HYPOTHESIS: watcher silence predicted contact tension; repeated error. Do not assert it as fact.',
        eventLedger: { record: (eventType, sessionId, payload) => events.push({ eventType, payload }) },
        motorCortex: new MotorCortex({ logger, canAct: () => true, executeAgendaItem: async () => { actions++; } }),
        agendaStore: { add: () => assert.fail('A question must not be converted into a task') },
      },
    });
    machine.pgsAdapter = { connect: async () => ({ available: false, perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} }) };
    orchestrator.thinkingMachine = machine;
    return machine;
  };
  const candidate = { signal: 'exploration', score: 0.9, nodeIds: ['guitar'], rationale: 'A remembered guitar lesson connects to current conversation.' };
  return { brainDir, orchestrator, requests, messages, events, prompts, candidate, makeMachine, actions: () => actions,
    setVerdict: next => { verdict = next; }, getVerdict: () => verdict, setResponse: next => { response = next; } };
}

test('actual factory sends explicit kept outreach to the authenticated resident bridge without agenda work', async t => {
  const f = await fixture(t);
  const machine = f.makeMachine();
  await machine._runCycle(f.candidate);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, '/api/owner-outreach');
  assert.equal(f.requests[0].authorization, 'Bearer private-fixture-token');
  assert.equal(f.requests[0].body.deliveryId, `outreach:${f.messages[0].id}`);
  assert.deepEqual(f.requests[0].body.evidenceRefs, ['message:real-contact', 'memory:guitar']);
  assert.equal(f.messages[0].ownerOutreach.status, 'committed');
  assert.equal(f.messages[0].ownerOutreach.notification, 'not_confirmed');
  assert.equal(f.messages[0].ownerOutreach.category, 'question');
  assert.equal(f.actions(), 0);
  assert.deepEqual(f.messages[0].agendaIds, []);
  const critiquePrompt = f.prompts.find(prompt => prompt.component === 'critique');
  assert.match(critiquePrompt.messages[0].content, /FAILED HYPOTHESIS/);
  assert.match(critiquePrompt.messages[0].content, /Owner Jason/);
  assert.match(critiquePrompt.instructions, /Never present a failed, superseded, or unverified hypothesis as a current fact/);
  await machine._runCycle(f.candidate);
  assert.equal(f.requests.length, 1, 'same accepted message and evidence do not get sent each cycle');
  assert.equal(f.messages[1].ownerOutreach.status, 'suppressed');
  // Restart retries have the same ID; the harness owns durable deduplication.
  await f.makeMachine()._runCycle(f.candidate);
  assert.equal(f.requests[1].body.deliveryId, f.requests[0].body.deliveryId);
});

test('discard, explicit no outreach, and unsupported references never contact the owner', async t => {
  const f = await fixture(t);
  const original = f.getVerdict();
  f.setVerdict({ ...original, verdict: 'discard' });
  await f.makeMachine()._runCycle(f.candidate);
  f.setVerdict({ ...original, ownerOutreach: null });
  await f.makeMachine()._runCycle(f.candidate);
  f.setVerdict({ ...original, ownerOutreach: { ...original.ownerOutreach, evidenceRefs: ['invented:watcher-proof'] } });
  await f.makeMachine()._runCycle(f.candidate);
  assert.equal(f.requests.length, 0);
  assert.equal(f.actions(), 0);
  assert.equal(f.messages.every(thought => !thought.ownerOutreach), true);
});

test('queued and failed delivery remain honest and a missing resident port cannot fall back to another home', async t => {
  const f = await fixture(t);
  f.setResponse({ statusCode: 200, body: { status: 'queued' } });
  await f.makeMachine()._runCycle(f.candidate);
  assert.equal(f.messages[0].ownerOutreach.status, 'queued');
  assert.equal(f.messages[0].ownerOutreach.notification, 'not_confirmed');
  f.setResponse({ statusCode: 503, body: { error: 'unavailable' } });
  await f.makeMachine()._runCycle(f.candidate);
  assert.equal(f.messages[1].ownerOutreach.status, 'pending');
  assert.equal(f.messages[1].ownerOutreach.transport, 'not_accepted');
  assert.match(f.messages[1].ownerOutreach.detail, /503/);
  delete process.env.BRIDGE_PORT;
  await f.makeMachine()._runCycle(f.candidate);
  assert.equal(f.requests.length, 2);
  assert.match(f.messages[2].ownerOutreach.detail, /bridge port unavailable/);
  assert.ok(f.events.some(event => event.eventType === 'OwnerOutreachRouted' && event.payload.status === 'pending'));
});

test('unaccepted outreach survives process loss and empty-discovery heartbeats retry the original delivery', async t => {
  const f = await fixture(t);
  f.setResponse({ statusCode: 503, body: { error: 'temporarily down' } });
  await f.makeMachine()._runCycle(f.candidate);
  const request = f.requests[0].body;
  assert.equal(fs.readdirSync(path.join(f.brainDir, 'owner-outreach-pending')).length, 1);
  const restored = Object.create(Orchestrator.prototype);
  restored.logsDir = f.brainDir; restored.logger = logger;
  const machine = restored.createThinkingMachine({ unifiedClient: {}, memory: {}, discoveryEngine: { pop: () => [] }, logger });
  restored.thinkingMachine = machine;
  machine.running = true;
  f.setResponse({ statusCode: 200, body: { status: 'committed', messageIds: ['recovered-message'] } });
  await machine._heartbeat();
  assert.deepEqual(f.requests[1].body, request, 'recovery reuses the same durable content and idempotency key');
  assert.equal(fs.readdirSync(path.join(f.brainDir, 'owner-outreach-pending')).length, 0);
  await machine._heartbeat();
  assert.equal(f.requests.length, 2, 'accepted message is removed from local retry queue');
});

test('superseded claims cannot be the admitted evidence basis for outreach', () => {
  const key = '6'.repeat(64);
  const previous = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = key;
  try {
    const stale = { id: 'stale', concept: 'Watcher silence proves contact tension.', tag: 'deep_thought', asserted_at: '2026-07-01T00:00:00Z' };
    const correction = attestMemoryAuthority({ id: 'correction', concept: 'The watcher explanation is wrong.', asserted_at: '2026-07-02T00:00:00Z', actor: 'jtr',
      metadata: { actor: 'jtr', correction: true, supersedes: ['stale'] },
      provenance: { schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction', sourceRefs: ['turn:user:correction'], evidenceRefs: ['turn:user:correction'] },
    }, key);
    const refs = outreachEvidenceRefs({ nodes: new Map([['stale', stale], ['correction', correction]]) }, {}, { referencedNodes: ['stale', 'correction'] });
    assert.deepEqual(refs, ['memory:correction']);
    assert.equal(normalizeOwnerOutreach({ category: 'insight', text: 'The watcher proves tension.', reason: 'An old explanation repeats without fresh support.', evidenceRefs: ['memory:stale'] }, refs), null);
  } finally {
    if (previous === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
    else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = previous;
  }
});

test('invalid content is refused and pending retry rotates past permanently rejected messages', async t => {
  assert.equal(normalizeOwnerOutreach({ category: 'question', text: 'invalid\0content', reason: 'This is a fixture reason.', evidenceRefs: ['memory:one'] }, ['memory:one']), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-outreach-fair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let accepting = false;
  const seen = [];
  const box = new OwnerOutreachOutbox(dir, async input => {
    seen.push(input.deliveryId);
    if (!accepting) throw new Error('not accepting');
    return { status: 'committed', notification: 'not_confirmed' };
  });
  for (let i = 0; i < 6; i++) await box.send({ deliveryId: `test-${i}`, text: 'A question', reason: 'A grounded reason for this question.' });
  seen.length = 0;
  await box.retry();
  await box.retry();
  assert.equal(new Set(seen).size, 6, 'persistent failures cannot monopolize the retry batch');
  accepting = true;
  await box.retry(); await box.retry();
  assert.equal(fs.readdirSync(path.join(dir, 'owner-outreach-pending')).length, 0);
});
