import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DeepDive } = require('../../../engine/src/cognition/deep-dive.js');

test('DeepDive prompt includes bus observation payload when candidate has no graph nodes', () => {
  const deepDive = new DeepDive({
    unifiedClient: { generate: async () => ({ content: '' }) },
    memory: { nodes: new Map(), edges: new Map(), clusters: new Map() },
    logger: { warn() {} },
  });

  const candidate = {
    signal: 'observation-delta',
    score: 0.92,
    rationale: 'bus observation domain.health',
    nodeIds: [],
    observation: {
      channelId: 'domain.health',
      sourceRef: 'health:daily:2026-05-01',
      traceId: 'trace:0123456789abcdef01234567',
      flag: 'COLLECTED',
      confidence: 0.92,
      payload: {
        summary: 'Resting heart rate is 3 bpm above the 14-day average',
        metric: 'resting_hr',
      },
    },
  };

  const { input } = deepDive._buildPrompt(candidate, { nodes: [], edges: [], seedCount: 0 }, {}, null);

  assert.match(input, /Verified observation to think about/);
  assert.match(input, /domain\.health/);
  assert.match(input, /health:daily:2026-05-01/);
  assert.match(input, /Resting heart rate is 3 bpm above the 14-day average/);
  assert.doesNotMatch(input, /no node content retrievable/);
});

test('DeepDive prompt bounds Good Life observations to engine operations', () => {
  const deepDive = new DeepDive({
    unifiedClient: { generate: async () => ({ content: '' }) },
    memory: { nodes: new Map(), edges: new Map(), clusters: new Map() },
    logger: { warn() {} },
  });

  const candidate = {
    signal: 'good-life',
    score: 1,
    rationale: 'bus observation domain.good-life',
    nodeIds: [],
    observation: {
      channelId: 'domain.good-life',
      sourceRef: 'good-life:repair:2026-05-01T18:00:00.000Z',
      traceId: 'trace:goodlife',
      flag: 'COLLECTED',
      confidence: 0.88,
      payload: {
        summary: 'repair - critical viability drift',
        policy: { mode: 'repair', reason: 'critical viability drift' },
        lanes: { viability: { status: 'critical', reasons: ['5 unresolved live problem(s)'] } },
      },
    },
  };

  const { instructions, input } = deepDive._buildPrompt(candidate, { nodes: [], edges: [], seedCount: 0 }, {}, null);

  assert.match(instructions, /Home23 engine Good Life telemetry/);
  assert.match(instructions, /not as a diagnosis of jtr's life/);
  assert.match(instructions, /Do not infer jtr's feelings/);
  assert.match(input, /bounded Home23 engine telemetry/);
  assert.doesNotMatch(input, /Focus on what it means for jtr's world/);
});

test('DeepDive prompt bounds machine observations to host operations', () => {
  const deepDive = new DeepDive({
    unifiedClient: { generate: async () => ({ content: '' }) },
    memory: { nodes: new Map(), edges: new Map(), clusters: new Map() },
    logger: { warn() {} },
    getConversationContext: () => 'jtr said he is deep in a creative session',
  });

  const candidate = {
    signal: 'observation-delta',
    score: 1,
    rationale: 'bus observation machine.memory entered memory:severe',
    nodeIds: [],
    observation: {
      channelId: 'machine.memory',
      sourceRef: 'memory:2026-05-01T18:35:00.000Z',
      traceId: 'trace:memory',
      flag: 'COLLECTED',
      confidence: 0.9,
      payload: {
        freePct: 3.1,
        freeBytes: 500_000_000,
        totalBytes: 16_000_000_000,
        processes: [
          {
            pm2Name: 'home23-jerry',
            script: '/Users/jtr/_JTR23_/release/home23/engine/src/index.js',
            topology: {
              agentName: 'jerry',
              role: 'agent-engine',
              expectedParallelRole: true,
              duplicateCandidate: false,
            },
          },
          {
            pm2Name: 'home23-jerry-harness',
            script: '/Users/jtr/_JTR23_/release/home23/dist/home.js',
            topology: {
              agentName: 'jerry',
              role: 'agent-harness',
              expectedParallelRole: true,
              duplicateCandidate: false,
            },
          },
        ],
      },
    },
  };

  const { instructions, input } = deepDive._buildPrompt(
    candidate,
    { nodes: [], edges: [], seedCount: 0 },
    {
      now: '2026-05-01T18:35:00.000Z',
      jtrTime: { phase: 'afternoon', dayType: 'weekday', dayName: 'Friday', activeRhythms: ['deep-work'] },
      loopDuration: { continuousRunMs: 15 * 60 * 1000, lastConversationMs: 60 * 60 * 1000 },
    },
    null
  );

  assert.match(instructions, /Home23 machine telemetry/);
  assert.match(instructions, /Process topology metadata is authoritative/);
  assert.match(instructions, /expected sibling process roles are not duplicates/i);
  assert.match(instructions, /not as a diagnosis of jtr's life/);
  assert.match(instructions, /Do not infer what jtr is doing/);
  assert.match(input, /bounded Home23 operational telemetry/);
  assert.doesNotMatch(input, /Jtr's time/);
  assert.doesNotMatch(input, /Recent conversation with jtr/);
  assert.doesNotMatch(input, /Focus on what it means for jtr's world/);
});
