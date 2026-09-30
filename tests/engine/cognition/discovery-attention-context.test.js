import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { HeartbeatChannel } from '../../../engine/src/channels/work/heartbeat-channel.js';

const require = createRequire(import.meta.url);
const { ConversationSalience } = require('../../../engine/src/cognition/conversation-salience');
const { DiscoveryEngine } = require('../../../engine/src/cognition/discovery-engine');
const { DeepDive } = require('../../../engine/src/cognition/deep-dive');
const { ThinkingMachine } = require('../../../engine/src/cognition/thinking-machine');
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
  const [health] = discovery.pop();
  assert.equal(health.observation.channelId, 'domain.health');
  assert.equal(health.score, 0.95 * 1.5, 'domain observation scoring is unchanged');
  // Health remains above contact, but does not satisfy the material turn.
  assert.equal(discovery.pop()[0].signal, 'conversation');
  assert.equal(discovery.pop()[0].observation.channelId, 'machine.cpu');
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

const ordinaryMachineSamples = [
  ['machine.cpu', { cpuCount: 10, loadAvg: [6.13] }],
  ['machine.memory', { pressureFreePct: 70 }],
  ['machine.disk', { mount: '/', usagePct: 34 }],
  ['machine.swap', { swap: { usedPct: 20 } }],
];

function observation(channelId, payload, sourceRef = `${channelId}:sample`, confidence = 1) {
  return { channelId, payload, sourceRef, confidence, flag: 'COLLECTED', producedAt: new Date().toISOString() };
}

async function heartbeatObservation(channel = new HeartbeatChannel({ getEngineState: () => ({ at: new Date().toISOString() }) })) {
  const [raw] = await channel.poll();
  return channel.verify(channel.parse(raw));
}

test('verified informational heartbeat yields to eligible owner contact with accurate selection metadata', async t => {
  const { salience } = fixture(t, [contact(0, 'jtr', 'Which musical phrases remain recognizable through a changed instrument?')]);
  const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
  const heartbeat = await heartbeatObservation();
  assert.deepEqual(Object.keys(heartbeat.payload).sort(), ['at', 'tick'], 'use the actual installed producer shape');
  discovery._enqueue(discovery._probeConversation()[0]);
  discovery.injectObservation(heartbeat);
  assert.equal(discovery.peek()[0].signal, 'conversation');
  const [inquiry, fallback] = discovery.pop(2);
  assert.equal(inquiry.signal, 'conversation');
  assert.deepEqual(inquiry.attentionSelection, { eligibleCount: 2, materialInquiryCount: 1,
    routineMachineCount: 0, routineHeartbeatCount: 1, criticalObservationCount: 0,
    highestEligibleScore: 1.35, materialScoreFloor: 1.25, selectedRankScore: 1.25,
    reason: 'material_before_routine_heartbeat', nonMaterialStreakBefore: 0, nonMaterialStreakAfter: 0 });
  assert.deepEqual(fallback.observation, heartbeat, 'the source observation remains intact');
  assert.equal(fallback.score, 1.35);
  assert.equal(fallback.observation.confidence, 0.9);
  assert.equal(fallback.attentionSelection.materialScoreFloor, null);
  assert.equal(fallback.attentionSelection.selectedRankScore, fallback.score);
});

test('changing informational heartbeat ticks yield to remembered inquiry at its actual finite score', async () => {
  const memory = graph(Array.from({ length: 3 }, (_, i) => ({ id: `heartbeat-interest-${i}`,
    concept: `A remembered musical question ${i}.`, created: '1970-01-01T00:00:00.000Z' })));
  const discovery = new DiscoveryEngine({ memory, logger });
  const channel = new HeartbeatChannel({ getEngineState: () => ({ at: new Date().toISOString() }) });
  for (let i = 0; i < 3; i++) {
    const material = discovery._probeExploration().find(candidate => candidate.nodeIds[0] === `heartbeat-interest-${i}`);
    const score = i === 0 ? material.score : i === 1 ? 0.025 : 0;
    if (i === 0) assert.ok(score >= 0.65 && score < 0.651);
    discovery._enqueue({ ...material, score });
    assert.equal(discovery.injectObservation(await heartbeatObservation(channel)), true);
    const [selected] = discovery.pop();
    assert.equal(selected.key, material.key, `changing tick ${i + 1}`);
    assert.equal(selected.score, score);
    assert.equal(selected.attentionSelection.materialScoreFloor, score);
    assert.equal(selected.attentionSelection.routineHeartbeatCount, i + 1);
    assert.equal(selected.attentionSelection.routineMachineCount, 0);
    assert.equal(discovery.consecutiveOperational, 0);
  }
  const fallback = discovery.pop(3);
  assert.deepEqual(fallback.map(candidate => candidate.observation.sourceRef), ['hb:1', 'hb:2', 'hb:3']);
  assert.ok(fallback.every(candidate => candidate.score === 1.35 && candidate.attentionSelection.materialScoreFloor === null));
});

test('informational heartbeat retains raw-score fallback when no material is eligible', async () => {
  const discovery = new DiscoveryEngine({ memory: graph([]), logger });
  discovery._enqueue({ key: 'other-ops', signal: 'anomaly', score: 0.9, nodeIds: [] });
  discovery.injectObservation(await heartbeatObservation());
  discovery.consecutiveOperational = 5;
  const [selected] = discovery.pop();
  assert.equal(selected.observation.channelId, 'work.heartbeat');
  assert.equal(selected.score, 1.35);
  assert.equal(selected.attentionSelection.selectedRankScore, 1.35);
  assert.equal(selected.attentionSelection.materialScoreFloor, null);
  assert.equal(selected.attentionSelection.routineMachineCount, 0);
  assert.equal(selected.attentionSelection.routineHeartbeatCount, 1);
  assert.equal(selected.attentionSelection.reason, 'ranked_score');
  assert.equal(discovery.pop()[0].key, 'other-ops');
});

test('heartbeat with additional Work state or unfamiliar fields retains priority and material fairness', async t => {
  for (const state of [{ work: { id: 'fixture-work', status: 'running' } }, { unfamiliarState: null }]) {
    const { salience } = fixture(t, [contact(0, 'jtr', 'A musical question worth remembering.')]);
    const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
    discovery._enqueue(discovery._probeConversation()[0]);
    const channel = new HeartbeatChannel({ getEngineState: () => state });
    discovery.injectObservation(await heartbeatObservation(channel));
    const [selected] = discovery.pop();
    assert.equal(selected.observation.channelId, 'work.heartbeat');
    assert.equal(selected.score, 1.35);
    assert.equal(selected.attentionSelection.routineHeartbeatCount, 0);
    assert.equal(selected.attentionSelection.routineMachineCount, 0);
    assert.equal(selected.attentionSelection.reason, 'ranked_score');
    const [inquiry] = discovery.pop();
    assert.equal(inquiry.signal, 'conversation');
    assert.equal(inquiry.attentionSelection.reason, 'material_fairness');
  }
});

test('invalid or unfamiliar heartbeat shapes and other Work channels retain existing ranking', async () => {
  const heartbeat = await heartbeatObservation();
  const invalid = [
    { ...heartbeat, payload: { tick: 0, at: heartbeat.payload.at } },
    { ...heartbeat, payload: { tick: -1, at: heartbeat.payload.at } },
    { ...heartbeat, payload: { tick: 1.5, at: heartbeat.payload.at } },
    { ...heartbeat, payload: { tick: '1', at: heartbeat.payload.at } },
    { ...heartbeat, payload: { tick: Number.MAX_SAFE_INTEGER + 1, at: heartbeat.payload.at } },
    { ...heartbeat, payload: { tick: 1, at: 'not-a-date' }, producedAt: 'not-a-date' },
    { ...heartbeat, payload: { tick: 1, at: '2026-09-30' }, producedAt: '2026-09-30' },
    { ...heartbeat, payload: { tick: 1 } }, { ...heartbeat, payload: null },
    { ...heartbeat, payload: [1, heartbeat.payload.at] },
    { ...heartbeat, producedAt: '2026-09-30T00:00:00.000Z' },
    { ...heartbeat, sourceRef: 'hb:other' }, { ...heartbeat, verifierId: null },
    { ...heartbeat, verifierId: 'other' }, { ...heartbeat, flag: 'UNCERTIFIED' },
    ...['work.agenda', 'work.worker-runs', 'work.live-problems', 'work.queue'].map(channelId => ({ ...heartbeat, channelId })),
  ];
  for (const source of invalid) {
    const discovery = new DiscoveryEngine({ memory: graph([]), logger });
    discovery._enqueue({ key: 'owner-inquiry', signal: 'conversation', attentionKind: 'exploration', score: 1.25, nodeIds: [] });
    discovery.injectObservation(source);
    const [selected] = discovery.pop();
    assert.equal(selected.observation?.sourceRef, source.sourceRef);
    assert.equal(selected.score, 1.35);
    assert.equal(selected.attentionSelection.routineHeartbeatCount, 0);
    assert.equal(selected.attentionSelection.routineMachineCount, 0);
    assert.equal(selected.attentionSelection.reason, 'ranked_score');
  }
});

test('corroborated critical evidence precedes informational heartbeat and waiting owner inquiry', async () => {
  const discovery = new DiscoveryEngine({ memory: graph([]), logger });
  discovery._enqueue({ key: 'owner-inquiry', signal: 'conversation', attentionKind: 'exploration', score: 1.25, nodeIds: [] });
  discovery.injectObservation(await heartbeatObservation());
  discovery.injectObservation(observation('machine.memory', { pressureFreePct: 3, memoryPressure: { available: true } }, 'memory:critical', 0.1));
  const [critical] = discovery.pop();
  assert.equal(critical.observation.channelId, 'machine.memory');
  assert.equal(critical.attentionSelection.criticalObservationCount, 1);
  assert.equal(critical.attentionSelection.routineMachineCount, 0);
  assert.equal(critical.attentionSelection.routineHeartbeatCount, 1);
  assert.equal(critical.attentionSelection.reason, 'critical_observation');
  const [inquiry] = discovery.pop();
  assert.equal(inquiry.key, 'owner-inquiry');
  assert.equal(inquiry.attentionSelection.reason, 'material_fairness');
  assert.equal(discovery.pop()[0].observation.channelId, 'work.heartbeat');
});

test('ordinary machine telemetry yields immediately to eligible owner contact without changing confidence or raw scores', t => {
  for (const [channelId, payload] of ordinaryMachineSamples) {
    const { salience } = fixture(t, [contact(0, 'jtr', 'Which musical phrases stay recognizable across an instrument change?')]);
    const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
    discovery._enqueue(discovery._probeConversation()[0]);
    discovery.injectObservation(observation(channelId, payload));
    assert.equal(discovery.consecutiveOperational, 0);
    assert.equal(discovery.peek()[0].signal, 'conversation');
    const [inquiry, routine] = discovery.pop(2);
    assert.equal(inquiry.signal, 'conversation', channelId);
    assert.equal(inquiry.attentionSelection.reason, 'material_before_routine_machine');
    assert.equal(inquiry.attentionSelection.highestEligibleScore, 1.5);
    assert.equal(routine.observation.channelId, channelId);
    assert.equal(routine.score, 1.5, 'ranking preserves the observation score');
    assert.equal(routine.observation.confidence, 1);
    assert.equal(routine.attentionSelection.materialScoreFloor, null, 'the next selection restores ordinary ranking when material is consumed');
  }
});

test('ordinary machine ranking uses actual finite inquiry scores including the oldest remembered material', () => {
  const memory = graph([{ id: 'old-interest', concept: 'The sound of a guitar phrase through different instruments.', created: '1970-01-01T00:00:00.000Z' }]);
  const discovery = new DiscoveryEngine({ memory, logger });
  const [remembered] = discovery._probeExploration();
  assert.ok(remembered.score >= 0.65 && remembered.score < 0.651, 'actual exploration approaches its existing minimum');
  for (const score of [remembered.score, 0.025, 0]) {
    const d = new DiscoveryEngine({ memory, logger });
    d._enqueue({ ...remembered, score });
    d.injectObservation(observation('machine.disk', { mount: '/', usagePct: 34 }));
    const [selected] = d.pop();
    assert.equal(selected.key, remembered.key, `material score ${score}`);
    assert.equal(selected.score, score);
    assert.equal(selected.attentionSelection.materialScoreFloor, score);
  }
});

test('alternating ordinary CPU and memory buckets and fresh disk samples cannot retake a material inquiry turn', async () => {
  const memory = graph(Array.from({ length: 4 }, (_, i) => ({ id: `interest-${i}`, concept: `Remembered musical question ${i}.`, created: '2000-01-01T00:00:00.000Z' })));
  const discovery = new DiscoveryEngine({ memory, logger });
  const base = Date.now() - 4 * 60000;
  for (let i = 0; i < 4; i++) {
    await discovery._runProbe();
    const producedAt = new Date(base + i * 60000).toISOString();
    for (const [channelId, payload] of [
      ['machine.cpu', { cpuCount: 10, loadAvg: [i % 2 ? 6 : 2] }],
      ['machine.memory', { pressureFreePct: i % 2 ? 18 : 70 }],
      ['machine.disk', { mount: '/', usagePct: 34 + i }],
    ]) {
      assert.equal(discovery.injectObservation({ ...observation(channelId, payload, `${channelId}:${i}`), producedAt }), true);
    }
    assert.equal(discovery.pop()[0].key, `material:interest-${i}`);
    assert.equal(discovery.consecutiveOperational, 0, 'a material turn must not let ordinary telemetry win again');
    assert.ok(discovery.queue.size <= discovery.config.queueCapacity);
  }
  const [fallback] = discovery.pop();
  assert.match(fallback.observation.channelId, /^machine\./);
  assert.equal(fallback.score, 1.5);
  assert.equal(fallback.attentionSelection.materialInquiryCount, 0);
});

test('without eligible material ordinary machine telemetry retains its original ordering and fallback', () => {
  const discovery = new DiscoveryEngine({ memory: graph([]), logger });
  discovery._enqueue({ key: 'other-ops', signal: 'anomaly', score: 0.9, nodeIds: [] });
  discovery.injectObservation(observation('machine.cpu', { cpuCount: 10, loadAvg: [2] }));
  discovery.injectObservation(observation('domain.health', { oxygenSaturation: 98 }, 'watch:fallback', 0.95));
  const [first] = discovery.pop();
  assert.equal(first.observation.channelId, 'machine.cpu');
  assert.equal(first.score, 1.5);
  assert.equal(first.attentionSelection.reason, 'ranked_score');
  assert.equal(first.attentionSelection.materialScoreFloor, null);
  assert.equal(discovery.pop()[0].observation.channelId, 'domain.health');
  assert.equal(discovery.pop()[0].key, 'other-ops');
});

test('non-machine domain and operational observations retain score ordering and existing material fairness', t => {
  for (const channelId of ['domain.health', 'domain.weather', 'work.queue', 'notify.alert']) {
    const { salience } = fixture(t, [contact(0, 'jtr', 'A remembered question about musical phrasing.')]);
    const discovery = new DiscoveryEngine({ memory: graph([]), getConversationSalience: () => salience, logger });
    discovery._enqueue(discovery._probeConversation()[0]);
    discovery.injectObservation(observation(channelId, { status: 'available' }));
    const [selected] = discovery.pop();
    assert.equal(selected.observation.channelId, channelId);
    assert.equal(selected.score, 1.5);
    assert.equal(selected.attentionSelection.routineMachineCount, 0);
    const [inquiry] = discovery.pop();
    assert.equal(inquiry.signal, 'conversation');
    assert.equal(inquiry.attentionSelection.reason, 'material_fairness');
  }
});

test('corroborated critical CPU and memory observations retain immediate priority and bounded queue reservation', () => {
  const criticalSamples = [
    ['machine.cpu', { cpuCount: 10, loadAvg: [11.5], cpuUtilization: { available: true,
      aggregate: { busyPct: 92, idlePct: 8 }, perCore: Array.from({ length: 10 }, () => ({ busyPct: 92, idlePct: 8 })) },
      scheduler: { available: true, runnableProcesses: 1 } }],
    ['machine.memory', { pressureFreePct: 3, memoryPressure: { available: true } }],
  ];
  for (const [channelId, payload] of criticalSamples) {
    const discovery = new DiscoveryEngine({ memory: graph([]), logger, config: { queueCapacity: 2 } });
    for (let i = 0; i < 4; i++) discovery._enqueue({ key: `inquiry-${i}`, signal: 'exploration', attentionKind: 'exploration', score: 1.15, nodeIds: [] });
    discovery.injectObservation(observation(channelId, payload, `${channelId}:critical`, 0.1));
    assert.equal(discovery.queue.size, 2);
    const [selected] = discovery.pop();
    assert.equal(selected.observation.channelId, channelId);
    assert.equal(selected.attentionSelection.reason, 'critical_observation');
    assert.equal(selected.attentionSelection.criticalObservationCount, 1);
    assert.ok(selected.score < discovery.peek()[0].score, 'critical precedence must not depend on winning a confidence score');
    assert.equal(discovery.pop()[0].signal, 'exploration');
  }
});

test('disk usage and allocated swap bands cannot claim the corroborated CPU or memory critical override', () => {
  const cases = [
    ['machine.disk', { usagePct: 99 }], ['machine.swap', { swap: { usedPct: 95 } }],
    ['machine.disk', { usagePct: 94.99 }], ['machine.swap', { swap: { usedPct: 89.99 } }],
    ['machine.disk', { usagePct: '99' }], ['machine.disk', { usagePct: 101 }], ['machine.disk', { usagePct: Infinity }],
    ['machine.swap', { swap: { usedPct: '95' } }], ['machine.swap', { swap: { usedPct: 101 } }],
    ['machine.swap', { swap: { usedPct: 95, error: 'sample unavailable' } }],
  ];
  for (const [channelId, payload] of cases) {
    const discovery = new DiscoveryEngine({ memory: graph([]), logger });
    discovery._enqueue({ key: 'material', signal: 'exploration', attentionKind: 'exploration', score: 0.65, nodeIds: [] });
    discovery.injectObservation(observation(channelId, payload));
    assert.equal(discovery.pop()[0].key, 'material');
  }
  const discovery = new DiscoveryEngine({ memory: graph([]), logger });
  discovery._enqueue({ key: 'material', signal: 'exploration', attentionKind: 'exploration', score: 0.65, nodeIds: [] });
  discovery.injectObservation({ ...observation('machine.disk', { usagePct: 99 }), flag: 'UNCERTIFIED' });
  assert.equal(discovery.pop()[0].key, 'material');
});

test('repeated high allocated swap cannot starve inquiry with healthy or unavailable memory pressure', async () => {
  for (const pressure of [{ pressureFreePct: 70, memoryPressure: { available: true } },
    { rawFreePct: 1.8, memoryPressure: { available: false, source: 'memory_pressure -Q' } }]) {
    const memory = graph(Array.from({ length: 3 }, (_, i) => ({ id: `question-${i}`, concept: `Remembered musical question ${i}.`, created: '2000-01-01T00:00:00.000Z' })));
    const discovery = new DiscoveryEngine({ memory, logger });
    for (let i = 0; i < 3; i++) {
      await discovery._runProbe();
      assert.equal(discovery.injectObservation(observation('machine.swap', { swap: { usedPct: 95 } }, `swap:${i}`)), true);
      discovery.injectObservation(observation('machine.memory', pressure, `memory:${i}`));
      const [selected] = discovery.pop();
      assert.equal(selected.key, `material:question-${i}`);
      assert.equal(selected.attentionSelection.criticalObservationCount, 0);
      assert.ok(selected.attentionSelection.routineMachineCount >= 2);
      assert.equal(discovery.consecutiveOperational, 0);
    }
    assert.equal(discovery.pop()[0].observation.channelId, 'machine.swap', 'high swap remains inspectable after material has yielded');
  }
});

test('ThoughtEmerged records a bounded noncontent snapshot of actual eligible attention across revisions', async t => {
  const { salience } = fixture(t, [contact(0, 'jtr', 'PRIVATE OWNER FIXTURE: a musical question.')]);
  const memory = graph([]);
  const discovery = new DiscoveryEngine({ memory, getConversationSalience: () => salience, logger });
  discovery._enqueue(discovery._probeConversation()[0]);
  discovery.injectObservation(observation('machine.cpu', { cpuCount: 10, loadAvg: [6.13] }));
  discovery.injectObservation(observation('machine.disk', { usagePct: 34 }, 'disk:private-fixture', 0.95));
  const heartbeat = new HeartbeatChannel({ getEngineState: () => ({ at: new Date().toISOString() }) });
  discovery.injectObservation(await heartbeatObservation(heartbeat));
  const [candidate] = discovery.pop();
  const ledger = [];
  const machine = new ThinkingMachine({ unifiedClient: {}, memory, discoveryEngine: discovery, logger,
    config: { eventLedger: { record: (eventType, _sessionId, payload) => ledger.push({ eventType, payload }) } } });
  let dives = 0;
  machine.deepDive = { async think() {
    dives++;
    if (dives === 1) {
      discovery.injectObservation(observation('machine.swap', { swap: { usedPct: 95 } }, 'swap:after-selection'));
      discovery.injectObservation(await heartbeatObservation(heartbeat));
    }
    return { text: 'PRIVATE THOUGHT FIXTURE: compare the musical phrase with its remembered context.', referencedNodes: [], usage: {} };
  } };
  machine.pgsAdapter = { async connect() { return { available: false, perspectives: [], candidateEdges: [], connectionNotes: [], usage: {} }; } };
  let critiques = 0;
  machine.critique = { async evaluate() { return ++critiques === 1
    ? { verdict: 'revise', confidence: 0.6, rationale: 'Check the musical comparison.', gaps: ['Resolve the comparison.'] }
    : { verdict: 'discard', confidence: 0.9, rationale: 'Comparison remains unsettled.', gaps: [] }; } };
  await machine._runCycle(candidate);
  const events = ledger.filter(event => event.eventType === 'ThoughtEmerged');
  assert.equal(events.length, 2);
  const expected = { eligibleCount: 4, materialInquiryCount: 1, routineMachineCount: 2, routineHeartbeatCount: 1, criticalObservationCount: 0,
    highestEligibleScore: 1.5, materialScoreFloor: 1.25, selectedRankScore: 1.25, reason: 'material_before_routine_machine_and_heartbeat',
    nonMaterialStreakBefore: 0, nonMaterialStreakAfter: 0 };
  for (const { payload } of events) {
    assert.equal(payload.candidate.signal, 'conversation');
    assert.deepEqual(payload.attentionSelection, expected);
    assert.doesNotMatch(JSON.stringify(payload.attentionSelection), /PRIVATE|disk:|swap:|hb:|tick|usagePct|oxygen/);
  }
  assert.ok(discovery.queue.size > expected.eligibleCount - 1, 'new observations do not rewrite the selection snapshot');
});
