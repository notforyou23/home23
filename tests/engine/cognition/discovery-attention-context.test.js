import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConversationSalience } = require('../../../engine/src/cognition/conversation-salience');
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine');
const { DeepDive } = require('../../../engine/src/cognition/deep-dive');
const logger = { info() {}, warn() {} };
const graph = nodes => ({ nodes: new Map(nodes.map(node => [node.id, node])), edges: new Map(), clusters: new Map() });

function contact(index, voice, text) {
  return { ts: new Date(Date.now() - (1000 - index) * 1000).toISOString(),
    session: 'coordination:owner-home', contactId: `message:contact-${index}`,
    sourceRef: `coordination.message:contact-${index}`, voice,
    role: voice === 'self' ? 'assistant' : 'user',
    actor: { kind: voice === 'jtr' ? 'owner' : 'bot',
      principalId: voice === 'jtr' ? 'owner' : 'resident', displayName: voice === 'jtr' ? 'Jason' : 'Jerry' }, text };
}

function fixture(t, turns) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-attention-contact-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'conversation-stream.jsonl');
  fs.writeFileSync(file, turns.map(turn => JSON.stringify(turn)).join('\n') + '\n');
  return { file, salience: new ConversationSalience({ brainDir: root, conversationStreamPath: file, logger }) };
}

test('a current owner correction stays in bounded attention after many resident machine reports', t => {
  const turns = [contact(0, 'jtr', 'The Mac mini is working within its limits. Stop repeating the RAM samples unless something actually changes.'),
    ...Array.from({ length: 80 }, (_, i) => contact(i + 1, 'self', `Machine telemetry: memory normal. Sampling proposal number ${i}.`))];
  const { salience } = fixture(t, turns);
  assert.match(salience.getRecentContext(), /Owner Jason.*\nThe Mac mini is working within its limits/);
  assert.ok(salience.getRecentEntries().length <= salience.config.maxEntries);
  const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
  const [candidate] = discovery._probeConversation();
  assert.equal(candidate.conversation.eventId, 'message:contact-0');
  assert.match(candidate.conversation.summary, /Stop repeating the RAM samples/);
});

test('a resident reply does not reopen an already considered owner contact', t => {
  const { file, salience } = fixture(t, [contact(0, 'jtr', 'The Garcia MIDI guitar makes me think about recognizable phrasing.'),
    contact(1, 'self', 'The same phrasing can carry through a changed timbre.')]);
  const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
  discovery._enqueue(discovery._probeConversation()[0]);
  const [selected] = discovery.pop();
  fs.appendFileSync(file, JSON.stringify(contact(2, 'self', 'Machine telemetry: normal memory.')) + '\n');
  discovery._enqueue(discovery._probeConversation()[0]);
  assert.equal(discovery.peek().length, 0, 'unchanged owner contact has yielded its attention');
  fs.appendFileSync(file, JSON.stringify(contact(3, 'jtr', 'That connection surprised you. What else changes the instrument but keeps its voice?')) + '\n');
  discovery._enqueue(discovery._probeConversation()[0]);
  assert.notEqual(discovery.peek()[0].key, selected.key);
});

test('resident-only machine contact is context rather than a new owner conversation starter', t => {
  const { salience } = fixture(t, [contact(1, 'self', 'Machine telemetry: memory normal. Re-sample it.')]);
  const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
  assert.match(salience.getRecentContext(), /Resident Jerry/);
  assert.deepEqual(discovery._probeConversation(), []);
});

test('current owner contact shapes later machine conduct without changing sensor evidence', t => {
  const { salience } = fixture(t, [contact(0, 'jtr', 'The Mac mini is working within its limits. Stop the repeated RAM warnings.'),
    contact(1, 'self', 'Agreed. A normal sample alone does not establish a problem.')]);
  const dive = new DeepDive({ memory: graph([]), unifiedClient: {}, logger, getConversationContext: () => salience.getRecentContext() });
  const result = dive._buildPrompt({ signal: 'observation-delta', nodeIds: [], observation: {
    channelId: 'machine.memory', sourceRef: 'memory:now', flag: 'COLLECTED', payload: { pressureFreePct: 70 },
  } }, { nodes: [], edges: [] }, {}, null);
  assert.match(result.input, /Owner contact affecting conduct/);
  assert.match(result.input, /Stop the repeated RAM warnings/);
  assert.match(result.instructions, /does not change the sensor facts/);
  assert.match(result.instructions, /Do not infer what jtr is doing/);
  assert.match(result.input, /"pressureFreePct": 70/);
});

test('a spontaneous watch observation receives remembered cold context without requiring a task', t => {
  const { salience } = fixture(t, [contact(0, 'jtr', 'I have a cold this weekend.'), contact(1, 'self', 'Take it easy.')]);
  const dive = new DeepDive({ memory: graph([]), unifiedClient: {}, logger, getConversationContext: () => salience.getRecentContext() });
  const result = dive._buildPrompt({ signal: 'observation-delta', nodeIds: [], observation: {
    channelId: 'domain.health', sourceRef: 'watch:now', flag: 'COLLECTED', payload: { oxygenSaturation: 94 },
  } }, { nodes: [], edges: [] }, {}, null);
  assert.match(result.input, /Owner Jason.*\nI have a cold/);
  assert.match(result.input, /"oxygenSaturation": 94/);
  assert.match(result.instructions, /need not become a task/);
  assert.match(result.instructions, /Do not invent personal facts/);
});

test('oversized current owner correction is disclosed by discovery rather than reviving older speech', t => {
  const { salience } = fixture(t, [contact(0, 'jtr', 'OLDER STORY'),
    contact(1, 'jtr', 'This correction is too large for the bounded context. '.repeat(500))]);
  const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
  const [candidate] = discovery._probeConversation();
  assert.equal(candidate.conversation.eventId, 'message:contact-1');
  assert.match(candidate.conversation.summary, /Contact omitted from this bounded view/);
  assert.doesNotMatch(candidate.conversation.summary, /OLDER STORY/);
});

test('recurring CPU and health samples yield to a waiting real conversation rather than satisfying exploration fairness', t => {
  const { salience } = fixture(t, [contact(0, 'jtr', 'Garcia MIDI guitar connects recognizable phrasing with a changed instrument.')]);
  const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger,
    config: { observationDedupe: { enabled: false } } });
  discovery._enqueue(discovery._probeConversation()[0]);
  discovery.injectObservation({ channelId: 'machine.cpu', sourceRef: 'cpu:1', flag: 'COLLECTED', confidence: 1,
    payload: { cpuCount: 10, loadAvg: [5] } });
  discovery.injectObservation({ channelId: 'domain.health', sourceRef: 'watch:1', flag: 'COLLECTED', confidence: 0.95,
    payload: { oxygenSaturation: 98 } });
  assert.equal(discovery.pop()[0].observation.channelId, 'machine.cpu');
  // In the failing production ordering, health scores 1.425 against contact
  // 1.25, resets the operational streak, and lets CPU then health repeat forever.
  assert.equal(discovery.pop()[0].signal, 'conversation');
  assert.equal(discovery.pop()[0].observation.channelId, 'domain.health');
  discovery.injectObservation({ channelId: 'domain.health', sourceRef: 'watch:2', flag: 'COLLECTED', confidence: 0.95,
    payload: { oxygenSaturation: 97 } });
  assert.equal(discovery.pop()[0].observation.channelId, 'domain.health', 'with no real material waiting, observations remain available');
});

test('critical corroborated machine evidence keeps precedence and survives a small full queue', () => {
  const discovery = new DiscoveryEngine({ memory: graph([]), logger, config: { queueCapacity: 2 } });
  for (let i = 0; i < 5; i++) discovery._enqueue({ key: `music-${i}`, signal: 'exploration',
    attentionKind: 'exploration', score: 10 + i, nodeIds: [] });
  discovery.consecutiveOperational = 1;
  discovery.injectObservation({ channelId: 'machine.memory', sourceRef: 'memory:critical', flag: 'COLLECTED', confidence: 0.95,
    payload: { pressureFreePct: 3, memoryPressure: { available: true, source: 'memory_pressure -Q' } } });
  assert.equal(discovery.pop()[0].observation.channelId, 'machine.memory');
  assert.equal(discovery.pop()[0].signal, 'exploration');
});

test('raw-only and explicitly unavailable memory pressure cannot bypass waiting owner inquiry', () => {
  for (const payload of [{ rawFreePct: 1.8 }, { pressureFreePct: 3, memoryPressure: { available: false } },
    { pressureFreePct: -5 }, { pressureFreePct: '3' }]) {
    const discovery = new DiscoveryEngine({ memory: graph([]), logger, config: { observationDedupe: { enabled: false } } });
    discovery._enqueue({ key: 'owner-music', signal: 'conversation', attentionKind: 'exploration', score: 1.25, nodeIds: [] });
    discovery.consecutiveOperational = 1;
    discovery.injectObservation({ channelId: 'machine.memory', sourceRef: 'memory:raw', flag: 'COLLECTED', confidence: 1, payload });
    assert.equal(discovery.pop()[0].key, 'owner-music');
    assert.equal(discovery.pop()[0].observation.channelId, 'machine.memory', 'uncorroborated observation remains inspectable');
  }
});
