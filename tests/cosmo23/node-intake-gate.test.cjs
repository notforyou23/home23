'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { NetworkMemory } = require('../../cosmo23/engine/src/memory/network-memory.js');
const {
  NodeIntakeGate,
  TRUNCATION_MARKER,
} = require('../../cosmo23/engine/src/memory/node-intake-gate.js');
const { EventLedger } = require('../../cosmo23/engine/src/core/event-ledger.js');

const SILENT_LOGGER = { info() {}, warn() {}, debug() {}, error() {} };

const PREAMBLE_WRAPPED =
  '[AGENT: agent_x1] The user is asking me to analyze the corpus. '
  + 'Let me first ground the current state. '
  + 'Kolmogorov complexity bounds the compressibility of research transcripts; '
  + 'the measured ratio across 1483 nodes was 0.42 with variance 0.03.';
const PREAMBLE_WRAPPED_RESIDUAL =
  '[AGENT: agent_x1] Kolmogorov complexity bounds the compressibility of research transcripts; '
  + 'the measured ratio across 1483 nodes was 0.42 with variance 0.03.';
const PURE_PREAMBLE = 'Let me check the current state properly before answering anything else.';
const FAKE_TOOL_TRANSCRIPT =
  '[TOOL_CALL: query_brain] Retrieve prior findings about mitochondrial protein '
  + 'synthesis latency measured in the 2019 cohort.';
const OVERSIZED = `Synthesis of entropy-gradient findings across the corpus: ${'x'.repeat(12000)}`;

function createMemory(intakeConfig) {
  const config = {
    embedding: { model: 'test-embedding', dimensions: 2 },
    smallWorld: {},
    spreading: {},
    decay: { minimumWeight: 0.1 },
    hebbian: { enabled: false },
  };
  if (intakeConfig !== undefined) config.intake = intakeConfig;
  const memory = new NetworkMemory(config, SILENT_LOGGER, null, {
    getEmbeddingClient: () => ({ embeddings: { create: async () => ({ data: [] }) } }),
  });
  memory.tokenizer = null;
  const embedCalls = [];
  memory.embed = async (text) => {
    embedCalls.push(text);
    return [1, 0];
  };
  return { memory, embedCalls };
}

test('COSMO intake gate strips leading preamble, keeps residual, marks metadata, embeds final bytes', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true });

  const node = await memory.addNode(PREAMBLE_WRAPPED, 'analyst');

  assert.ok(node, 'substantive residual must be accepted');
  assert.equal(node.concept, PREAMBLE_WRAPPED_RESIDUAL);
  assert.equal(node.metadata.intake.stripped, true);
  assert.equal(node.metadata.intake.originalChars, PREAMBLE_WRAPPED.length);
  assert.deepEqual(embedCalls, [PREAMBLE_WRAPPED_RESIDUAL], 'embedding must cover the stored bytes');
  assert.equal(memory.getStats().intake.preambleStripped, 1);
  assert.equal(memory.getStats().intake.enabled, true);
});

test('COSMO intake gate rejects pure preamble with nothing substantive left', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true });

  const node = await memory.addNode(PURE_PREAMBLE, 'analyst');

  assert.equal(node, null);
  assert.deepEqual(embedCalls, [], 'rejected content must never reach the embedder');
  assert.equal(memory.getStats().intake.preambleRejected, 1);
  assert.equal(memory.nodes.size, 0);
});

test('COSMO intake gate rejects hallucinated tool-call transcripts', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true });

  const node = await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding');

  assert.equal(node, null);
  assert.deepEqual(embedCalls, []);
  assert.equal(memory.getStats().intake.toolCallRejected, 1);
});

test('COSMO intake gate truncates oversized concepts with a marked diet cap', async () => {
  const { memory, embedCalls } = createMemory({ enabled: true, maxConceptChars: 4000 });

  const node = await memory.addNode(OVERSIZED, 'synthesis_report');

  assert.ok(node);
  assert.ok(node.concept.length <= 4000, `capped length, got ${node.concept.length}`);
  assert.ok(node.concept.endsWith(TRUNCATION_MARKER), 'truncation must be marked');
  assert.equal(node.metadata.intake.truncated, true);
  assert.equal(node.metadata.intake.originalChars, OVERSIZED.length);
  assert.deepEqual(embedCalls, [node.concept], 'embedding must cover the truncated bytes');
  assert.equal(memory.getStats().intake.truncated, 1);
});

test('COSMO intake gate exempts pre-embedded, protected-evidence, and structural intake', async () => {
  const { memory } = createMemory({ enabled: true });

  const preEmbedded = await memory.addNode(PURE_PREAMBLE, 'analyst', [0.25, 0.75]);
  assert.ok(preEmbedded, 'pre-embedded inserts keep the existing intentional-bypass convention');
  assert.equal(preEmbedded.concept, PURE_PREAMBLE);

  const evidence = await memory.addNode(
    `Execution failed (exit 2): [TOOL_CALL: bash] ${PURE_PREAMBLE}`,
    'execution_failure',
  );
  assert.ok(evidence, 'execution evidence is protected from reshaping');
  assert.equal(evidence.concept, `Execution failed (exit 2): [TOOL_CALL: bash] ${PURE_PREAMBLE}`);
  assert.equal(evidence.metadata, null);

  const structural = await memory.addNode(
    '{"phase":1,"objective":"The user is asking me to map the corpus","tasks":["t1","t2"]}',
    'mission_plan',
  );
  assert.ok(structural, 'structural JSON must pass untouched');
  assert.equal(
    structural.concept,
    '{"phase":1,"objective":"The user is asking me to map the corpus","tasks":["t1","t2"]}',
  );

  const stats = memory.getStats().intake;
  assert.equal(stats.exempted, 2, 'evidence + structural exemptions counted (pre-embedded never consults the gate)');
  assert.equal(stats.preambleStripped + stats.preambleRejected + stats.toolCallRejected + stats.truncated, 0);
});

test('COSMO intake gate never strips past non-preamble content', () => {
  const gate = new NodeIntakeGate({});
  const config = { enabled: true };

  const midContent = 'Measured variance was 0.03 across 1483 nodes. Let me check the current state.';
  const untouched = gate.apply(midContent, 'analyst', config);
  assert.equal(untouched.action, 'accept');
  assert.equal(untouched.concept, midContent, 'stripping is leading-sentences-only');

  const insight = gate.apply(
    '[AGENT INSIGHT: a2] I should first check the corpus. Signal-to-noise measured 3.4 across all validated partitions.',
    'agent_insight',
    config,
  );
  assert.equal(insight.action, 'accept');
  assert.equal(
    insight.concept,
    '[AGENT INSIGHT: a2] Signal-to-noise measured 3.4 across all validated partitions.',
    'structural bracket prefix survives stripping',
  );
});

test('COSMO gates-off pin: default-off behavior is bit-identical to today', async () => {
  for (const intakeConfig of [undefined, { enabled: false }]) {
    const { memory, embedCalls } = createMemory(intakeConfig);

    const wrapped = await memory.addNode(PREAMBLE_WRAPPED, 'analyst');
    assert.equal(wrapped.concept, PREAMBLE_WRAPPED, 'no stripping when off');
    assert.equal(wrapped.metadata, null, 'metadata stays null when off');

    const toolCall = await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding');
    assert.equal(toolCall.concept, FAKE_TOOL_TRANSCRIPT, 'no tool-call rejection when off');

    const oversized = await memory.addNode(OVERSIZED, 'synthesis_report');
    assert.equal(oversized.concept, OVERSIZED, 'no diet cap when off');

    assert.deepEqual(
      embedCalls,
      [PREAMBLE_WRAPPED, FAKE_TOOL_TRANSCRIPT, OVERSIZED],
      'embedder sees the original bytes when off',
    );

    const stats = memory.getStats();
    assert.equal(stats.nodes, 3);
    assert.equal(stats.intake.enabled, false);
    assert.equal(stats.intake.examined, 0, 'gate is a pure no-op when off');
    assert.equal(
      stats.intake.preambleStripped + stats.intake.preambleRejected
        + stats.intake.toolCallRejected + stats.intake.truncated + stats.intake.exempted,
      0,
    );
  }
});

test('COSMO intake gate emits ONE aggregated ledger event per flush, none when idle', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-gate-ledger-'));
  try {
    const ledger = new EventLedger(dir, { logger: SILENT_LOGGER });
    await ledger.initialize();

    const { memory } = createMemory({ enabled: true, maxConceptChars: 4000 });
    await memory.addNode(PREAMBLE_WRAPPED, 'analyst'); // strip
    await memory.addNode(PURE_PREAMBLE, 'analyst'); // reject
    await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding'); // reject
    await memory.addNode(OVERSIZED, 'synthesis_report'); // truncate

    assert.equal(memory.intakeGate.flushToLedger(ledger, 7), true);
    assert.equal(memory.intakeGate.flushToLedger(ledger, 8), false, 'no second event without new activity');

    await memory.addNode(FAKE_TOOL_TRANSCRIPT, 'agent_finding');
    assert.equal(memory.intakeGate.flushToLedger(ledger, 9), true);

    await ledger.flush();
    await ledger.close();

    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((record) => record.type === 'memory_intake_gate');

    assert.equal(events.length, 2, 'one aggregated event per active cycle, never per-node spam');
    assert.equal(events[0].cycle, 7);
    assert.equal(events[0].examined, 4);
    assert.equal(events[0].preambleStripped, 1);
    assert.equal(events[0].preambleRejected, 1);
    assert.equal(events[0].toolCallRejected, 1);
    assert.equal(events[0].truncated, 1);
    assert.equal(events[0].totals.examined, 4);
    assert.equal(events[1].cycle, 9);
    assert.equal(events[1].examined, 1);
    assert.equal(events[1].toolCallRejected, 1);
    assert.equal(events[1].preambleStripped, 0);
    assert.equal(events[1].totals.toolCallRejected, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('COSMO intake gate keeps existing getStats surface intact (additive only)', async () => {
  const { memory } = createMemory({ enabled: true });
  await memory.addNode(PREAMBLE_WRAPPED, 'analyst');

  const stats = memory.getStats();
  for (const key of ['nodes', 'edges', 'clusters', 'averageWeight', 'activeNodes', 'averageDegree']) {
    assert.ok(key in stats, `existing stats key ${key} preserved`);
  }
  assert.equal(stats.nodes, 1);
  assert.equal(stats.intake.accepted, 1);
});
