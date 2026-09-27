import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine.js');
const { DeepDive } = require('../../../engine/src/cognition/deep-dive.js');
const { ConversationSalience } = require('../../../engine/src/cognition/conversation-salience.js');
const { ThinkingMachine } = require('../../../engine/src/cognition/thinking-machine.js');
const { MotorCortex } = require('../../../engine/src/cognition/motor-cortex.js');
const { Orchestrator } = require('../../../engine/src/core/orchestrator.js');
const { toPgsGraph } = require('../../../engine/src/cognition/pgs-adapter.js');
const { attestMemoryAuthority } = require('../../../shared/memory-authority-attestation.cjs');

const logger = { info() {}, warn() {}, error() {} };
const memory = (nodes = [], edges = [], clusters = []) => ({
  nodes: new Map(nodes.map(node => [node.id, node])),
  edges: new Map(edges), clusters: new Map(clusters),
});
const node = (id, concept, fields = {}) => ({ id, concept, created: new Date().toISOString(), ...fields });
function conversations(t, entries) {
  const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-aperture-'));
  t.after(() => fs.rmSync(brainDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(brainDir, 'conversation-salience.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
  return new ConversationSalience({ brainDir, logger, config: { reloadIntervalMs: 0 } });
}

// Uses the real discovery, prompt construction, critique parser, motor compiler,
// and persistence routing. Only the model and PGS service boundaries are fakes.
test('conversation and historical music material reach a kept thought without creating work', async t => {
  const history = node('guitar-memory', 'The old guitar lesson described phrasing as leaving silence for another player to answer.', {
    tag: 'historical', created: '2020-01-01T00:00:00.000Z', metadata: { source_path: '/notes/guitar-lesson.md' },
  });
  const graph = memory([
    history,
    node('melody', 'Garcia lets a melody breathe instead of filling every pause.', { tag: 'conversation' }),
    node('concert-news', 'The concert recording reveals a patient improvisation.', { tag: 'news', metadata: { source_path: '/intake/concert.json' } }),
    node('ops', 'The engine process is running.', { tag: 'raw_log' }),
  ], [['guitar-memory->melody', { weight: 1 }], ['guitar-memory->concert-news', { weight: 0.5 }]]);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-canonical-aperture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brainDir = path.join(root, 'brain');
  fs.mkdirSync(brainDir);
  fs.mkdirSync(path.join(root, 'substrate'));
  const canonicalTurns = [
    { role: 'user', voice: 'jtr', actor: { principalId: 'owner-jason', kind: 'owner', displayName: 'Jason' }, text: 'That Garcia melody makes me think about how leaving space changes a conversation.' },
    { role: 'assistant', voice: 'self', actor: { principalId: 'resident-jerry', kind: 'bot', displayName: 'Jerry' }, text: 'There might be something in the guitar lesson about silence.' },
  ].map((turn, i) => ({ ...turn, ts: new Date(Date.now() - (2 - i) * 1000).toISOString(),
    session: 'coordination:home-jason', contactId: `message:contact-${i}`, sourceRef: `coordination.message:contact-${i}` }));
  fs.writeFileSync(path.join(root, 'substrate', 'conversation-stream.jsonl'), canonicalTurns.map(turn => JSON.stringify(turn)).join('\n') + '\n');
  // A compiled session must not replace the resident's more current canonical contact.
  fs.writeFileSync(path.join(brainDir, 'conversation-salience.jsonl'), JSON.stringify({ ts: new Date().toISOString(), chatId: 'older-session', summary: 'STALE COMPILED WATCHER STORY' }) + '\n');
  const orchestrator = Object.create(Orchestrator.prototype);
  orchestrator.logger = logger;
  orchestrator.conversationSalience = orchestrator.createConversationSalience({ workspacePath: path.join(root, 'workspace'), brainDir });
  const salience = orchestrator.conversationSalience;
  assert.equal(salience.getRecentEntries()[0].source, 'seed_contact');
  assert.doesNotMatch(salience.getRecentContext(), /STALE COMPILED/);
  const discovery = new DiscoveryEngine({ memory: graph, logger, getConversationSalience: () => salience });
  await discovery._runProbe();
  const candidates = discovery.peek(100);
  const candidate = candidates.find(row => row.signal === 'conversation');
  assert.ok(candidate);
  assert.ok(candidate.nodeIds.includes('guitar-memory'));
  assert.ok(candidates.some(row => row.signal === 'exploration' && row.nodeIds.includes('concert-news')));
  // Curiosity admission has not changed the current-state authority gate.
  assert.deepEqual(discovery._authorityEligibleIds(new Set(graph.nodes.keys())), ['ops']);

  const calls = [];
  const emitted = [];
  const connections = [];
  let executed = 0;
  const machine = orchestrator.createThinkingMachine({
    unifiedClient: { async generate(args) {
      calls.push(args);
      return { model: 'fixture', content: args.component === 'critique'
        ? JSON.stringify({ verdict: 'keep', confidence: 0.9, rationale: 'A grounded question without a required task.', gaps: [], agendaCandidates: [] })
        : 'The guitar lesson makes silence look like an invitation: an unfinished melody can leave room for another voice. I wonder whether a conversation has the same kind of phrasing.' };
    } },
    memory: graph, discoveryEngine: discovery, logger,
    emitThought: thought => emitted.push(thought),
    config: {
      motorCortex: new MotorCortex({ logger, canAct: () => true, executeAgendaItem: async () => { executed++; } }),
      agendaStore: { add() { assert.fail('An open question must not create an agenda obligation'); } },
    },
  });
  machine.pgsAdapter = { async connect(args) {
    connections.push(args);
    return { available: false, note: 'fixture', perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} };
  } };
  await machine._runCycle(candidate);

  assert.equal(emitted.length, 1);
  assert.equal(executed, 0);
  assert.deepEqual(emitted[0].agendaIds, []);
  assert.equal(emitted[0].motorActions[0].status, 'no_action');
  assert.ok(connections[0].referencedNodes.includes('guitar-memory'), 'prose need not recite node IDs to retain provenance');
  for (const call of calls.filter(call => ['deepDive', 'critique'].includes(call.component))) {
    assert.match(call.messages[0].content, /Garcia melody/);
    assert.match(call.messages[0].content, /Owner Jason/);
    assert.match(call.messages[0].content, /Resident Jerry/);
    assert.doesNotMatch(call.messages[0].content, /STALE COMPILED/);
    assert.match(call.messages[0].content, /old guitar lesson/);
    assert.match(call.messages[0].content, /project_history; artifact_log/);
  }
  assert.match(calls[0].instructions, /need not become a task, prediction, diagnosis/);
});

test('contact can start inquiry without a graph match; absent or expired contact is not invented', t => {
  const graph = memory();
  const salience = conversations(t, [{
    ts: new Date().toISOString(), chatId: 'home:jason', summary: '**User:** That chord surprised me.',
  }, {
    ts: '2020-01-01T00:00:00.000Z', chatId: 'old', summary: 'EXPIRED CONTACT',
  }]);
  const discovery = new DiscoveryEngine({ memory: graph, logger, getConversationSalience: () => salience });
  const [candidate] = discovery._probeConversation();
  assert.equal(candidate.conversation.chatId, 'home:jason');
  assert.deepEqual(candidate.nodeIds, []);
  const dive = new DeepDive({ unifiedClient: {}, memory: graph, logger });
  const prompt = dive._buildPrompt(candidate, { nodes: [], edges: [] }, {}, null);
  assert.match(prompt.input, /That chord surprised me/);
  assert.doesNotMatch(prompt.input, /EXPIRED CONTACT|no node content retrievable/);
  assert.deepEqual(new DiscoveryEngine({ memory: graph, logger })._probeConversation(), []);
  assert.equal(salience.getRecentContext(new Date(Date.now() + 4 * 86400000)), null);
});

test('matching memories beyond cluster insertion prefixes remain available to conversation', t => {
  const nodes = Array.from({ length: 40 }, (_, i) => node(`op-${i}`, 'Routine process status and telemetry'));
  nodes.push(node('music-late', 'Garcia guitar melody and silence'));
  const ids = new Set(nodes.map(n => n.id));
  const graph = memory(nodes, [], [[1, ids]]);
  const salience = conversations(t, [{ ts: new Date().toISOString(), chatId: 'home:jason', summary: 'Garcia guitar melody silence' }]);
  assert.deepEqual(salience.relevantNodeIds(graph, 'Garcia guitar melody silence', 3, ids), ['music-late']);
  // Direct contact candidates do not depend on whole-cluster token averaging.
  const discovery = new DiscoveryEngine({ memory: graph, logger, getConversationSalience: () => salience });
  assert.deepEqual(discovery._probeConversation()[0].nodeIds, ['music-late']);
});

test('operational streams cannot crowd out meaningful material and unchanged evidence yields attention', () => {
  const graph = memory([node('music', 'A question about guitar phrasing and silence')]);
  const discovery = new DiscoveryEngine({ memory: graph, logger });
  const exploratory = discovery._probeExploration()[0];
  discovery._enqueue({ key: 'ops-1', signal: 'observation-delta', score: 9, nodeIds: [] });
  discovery._enqueue({ key: 'ops-2', signal: 'observation-delta', score: 8, nodeIds: [] });
  discovery._enqueue(exploratory);
  assert.equal(discovery.pop()[0].key, 'ops-1');
  assert.equal(discovery.pop()[0].key, exploratory.key);
  discovery._enqueue({ ...exploratory, discoveredAt: new Date().toISOString(), score: 20 });
  assert.equal(discovery.peek(10).some(row => row.key === exploratory.key), false);
  // A changed substantive source, not a rediscovery timestamp, reopens admission.
  graph.nodes.get('music').concept += ' A new conversation connects it to call and response.';
  discovery._enqueue(discovery._probeExploration()[0]);
  assert.equal(discovery.peek(10).some(row => row.key === exploratory.key), true);
  discovery.pop(10);
  const refreshed = exploratory;
  discovery.consumedEvidence.set(discovery._evidenceFingerprint(refreshed), Date.now() - discovery.config.consumedEvidenceCooldownMs - 1);
  discovery._enqueue(refreshed);
  assert.equal(discovery.peek(10).some(row => row.key === refreshed.key), true, 'yielding is temporary, not erasure');
});

test('a corrected claim is excluded as a fresh thought starter and labeled when related history recalls it', () => {
  const key = '7'.repeat(64);
  const previous = process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
  process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = key;
  try {
    const stale = node('stale', 'The watcher failure means Jason has lost interest.', {
      tag: 'deep_thought', asserted_at: '2026-07-01T00:00:00.000Z',
    });
    const correction = attestMemoryAuthority(node('correction', 'Jason said the watcher story was wrong.', {
      asserted_at: '2026-07-02T00:00:00.000Z', actor: 'jtr',
      metadata: { actor: 'jtr', correction: true, supersedes: ['stale'] },
      provenance: { schema: 'home23.node-provenance.v1', authorityClass: 'jtr_correction', sourceRefs: ['turn:user:correction'], evidenceRefs: ['turn:user:correction'] },
    }), key);
    const graph = memory([stale, correction], [['correction->stale', { weight: 1 }]]);
    const discovery = new DiscoveryEngine({ memory: graph, logger });
    assert.equal(discovery._probeExploration().some(row => row.nodeIds.includes('stale')), false);
    assert.deepEqual(discovery._authorityEligibleIds(new Set(['stale', 'correction'])), ['correction']);
    const dive = new DeepDive({ unifiedClient: {}, memory: graph, logger });
    const neighborhood = dive._gatherNeighborhood(['correction']);
    const prompt = dive._buildPrompt({ signal: 'exploration', nodeIds: ['correction'] }, neighborhood, {}, null);
    assert.match(prompt.input, /narrative; SUPERSEDED by correction/);
    assert.match(prompt.instructions, /Superseded or closed claims are counterevidence, never current facts/);
    const pgsGraph = toPgsGraph(graph, ['correction']);
    assert.match(pgsGraph.nodes.find(row => row.id === 'stale').concept, /narrative; SUPERSEDED by correction; not current fact/);
    assert.match(pgsGraph.nodes.find(row => row.id === 'correction').concept, /jtr_correction/);
  } finally {
    if (previous === undefined) delete process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY;
    else process.env.HOME23_MEMORY_AUTHORITY_ATTESTATION_KEY = previous;
  }
});

test('an explicit empty agenda never turns action-shaped speculation into work', () => {
  const motor = new MotorCortex({ logger, canAct: () => true });
  const plan = motor.compileMotorIntents({
    thoughtText: 'Investigate the health shortcut when this becomes a real question; for now I am only wondering about the metaphor.',
    finalVerdict: { verdict: 'keep', agendaCandidates: [], raw: '{"verdict":"keep","agendaCandidates":[]}' },
  });
  assert.deepEqual(plan.accepted, []);
  assert.deepEqual(plan.decisions.map(row => row.status), ['no_action']);
});


test('consumed leading candidates do not hide other remembered material behind the per-signal cap', async () => {
  const graph = memory(Array.from({ length: 12 }, (_, i) => node(`memory-${i}`, `An ordinary memory about music number ${i}`)));
  const discovery = new DiscoveryEngine({ memory: graph, logger, config: { perSignalCap: 2 } });
  const seen = new Set();
  for (let i = 0; i < 6; i++) {
    await discovery._runProbe();
    for (const candidate of discovery.pop(2)) seen.add(candidate.nodeIds[0]);
  }
  assert.equal(seen.size, 12);
});

test('provider failure releases selected material for a later heartbeat', async () => {
  const graph = memory([node('music', 'A remembered melody opens an unresolved question about silence')]);
  const discovery = new DiscoveryEngine({ memory: graph, logger });
  discovery._enqueue(discovery._probeExploration()[0]);
  const [candidate] = discovery.pop();
  const machine = new ThinkingMachine({
    memory: graph, discoveryEngine: discovery, logger,
    unifiedClient: { async generate() { throw new Error('provider temporarily unavailable'); } },
  });
  await machine._runCycle(candidate);
  assert.equal(discovery._recentlyConsumed(candidate), false);
  discovery._enqueue(candidate);
  assert.equal(discovery.peek()[0].key, candidate.key);
});

test('oversized latest contact is disclosed rather than replaced by an older story', () => {
  const scorer = new ConversationSalience({ brainDir: '/unused-fixture', logger });
  scorer.getRecentEntries = () => [
    { ts: '2026-09-26T10:00:00Z', chatId: 'home', eventId: 'older', summary: '[Owner Jason]\nOLDER STORY' },
    { ts: '2026-09-26T10:01:00Z', chatId: 'home', eventId: 'correction', summary: '[Owner Jason]\n' + 'A substantive correction. '.repeat(1000) },
  ];
  assert.match(scorer.getRecentContext(), /Contact omitted.*correction/);
  assert.match(scorer.getRecentContext(), /do not infer it or treat older context as the latest contact/);
  assert.doesNotMatch(scorer.getRecentContext(), /OLDER STORY/);
});
