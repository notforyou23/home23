import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  canonicalJson,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  SynthesisAgent,
  Utf8BudgetWriter,
  extractJsonObject,
  readCommittedSynthesisState,
} = require('../../../engine/src/synthesis/synthesis-agent.js');

const OPERATION_ID = `brop_${'A'.repeat(32)}`;
const GENERATED_AT_MS = Date.parse('2026-07-10T12:00:00.000Z');

function completeContent(extra = {}) {
  return JSON.stringify({
    selfUnderstanding: {
      summary: 'A grounded brain.',
      currentObsessions: ['brain reliability'],
      relationship: 'It supports its owner.',
    },
    consolidatedInsights: [{
      title: 'Pinned truth',
      excerpt: 'Reliable retrieval begins from one pinned source.',
      source: 'memory',
      themes: ['reliability'],
    }],
    recentActivity: ['Brain operations were hardened.'],
    ...extra,
  });
}

async function fixture(t, options = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-synthesis-'));
  const brainDir = path.join(root, 'instances', 'jerry', 'brain');
  const workspacePath = path.join(root, 'instances', 'jerry', 'workspace');
  await fsp.mkdir(brainDir, { recursive: true });
  await fsp.mkdir(workspacePath, { recursive: true });
  const canonicalBrainDir = await fsp.realpath(brainDir);
  await fsp.writeFile(path.join(workspacePath, 'SOUL.md'), '# Soul\nReliable and direct.\n');
  await fsp.writeFile(path.join(workspacePath, 'MISSION.md'), '# Mission\nProtect source truth.\n');
  await fsp.writeFile(path.join(workspacePath, 'BRAIN_INDEX.md'), [
    '# Brain Index',
    'Documents compiled: 2',
    '## Brain reliability',
    '## Operations',
  ].join('\n'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  let releaseCalls = 0;
  let compareCalls = 0;
  const revision = options.revision ?? 51;
  const sourcePin = {
    descriptor: {
      version: 1,
      canonicalRoot: canonicalBrainDir,
      generation: 'generation-51',
      cutoffRevision: revision,
      summary: { nodeCount: 2, edgeCount: 1, clusterCount: 1 },
    },
    revision,
    async summarize({ signal } = {}) {
      if (options.onSummarize) await options.onSummarize(signal);
      return { nodes: 2, edges: 1, clusters: 1 };
    },
    async searchKeyword({ query, signal }) {
      if (options.onSearch) await options.onSearch(query, signal);
      return { results: [{ id: `node-${query.length}`, concept: `Evidence for ${query}` }] };
    },
    async compareAndSwap(commit) {
      compareCalls += 1;
      if (options.beforeCompare) await options.beforeCompare();
      if (options.commit === false) return { committed: false, reason: 'source_changed' };
      const value = await commit();
      return { committed: true, value };
    },
    getEvidence() {
      return { sourceHealth: 'healthy', authoritativeTotals: { nodes: 2, edges: 1 } };
    },
    async release() { releaseCalls += 1; },
  };

  const providerCalls = [];
  const adapter = {
    provider: 'minimax',
    model: 'MiniMax-M3',
    capabilities: { maxOutputTokens: 32768, providerStallMs: 900000 },
    async generate(request) {
      providerCalls.push(request);
      if (options.generate) return options.generate(request);
      request.onProviderActivity?.({
        type: 'content_delta',
        at: '2026-07-10T12:00:01.000Z',
      });
      return {
        content: completeContent(),
        terminalReceived: true,
        finishReason: 'stop',
        hadError: false,
      };
    },
  };
  const agent = new SynthesisAgent({
    brainDir,
    workspacePath,
    providerAdapter: adapter,
    limits: options.limits || {},
    hooks: options.hooks || {},
    clock: { now: () => GENERATED_AT_MS },
  });
  return {
    root,
    brainDir,
    workspacePath,
    sourcePin,
    adapter,
    agent,
    providerCalls,
    get releaseCalls() { return releaseCalls; },
    get compareCalls() { return compareCalls; },
  };
}

test('extractJsonObject retains bounded compatibility for fenced and balanced JSON', () => {
  assert.equal(extractJsonObject('```json\n{"ok":true}\n```').ok, true);
  assert.deepEqual(extractJsonObject('prefix {"a":{"b":"brace }"}} suffix'), {
    a: { b: 'brace }' },
  });
});

test('UTF-8 prompt writer accepts the exact boundary and rejects one byte over', () => {
  const exact = new Utf8BudgetWriter(4).append('test');
  assert.equal(exact.toString(), 'test');
  assert.throws(() => exact.append('x'), { code: 'result_too_large', retryable: false });
  assert.throws(() => new Utf8BudgetWriter(4).append('💡x'), {
    code: 'result_too_large',
  });
});

test('runOperation emits correlated provider events and commits a verifiable marker under source CAS', async (t) => {
  const fx = await fixture(t);
  const events = [];
  const result = await fx.agent.runOperation({
    operationId: OPERATION_ID,
    trigger: 'manual',
    sourcePin: fx.sourcePin,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(events.map((event) => event.type), [
    'provider_selected', 'provider_activity', 'provider_call_terminal',
  ]);
  assert.deepEqual(events[0], {
    type: 'provider_selected',
    phase: 'synthesis',
    provider: 'minimax',
    model: 'MiniMax-M3',
    providerStallMs: 900000,
    providerCallId: 'synthesis',
    sourceRevision: 51,
  });
  assert.equal(events[1].providerCallId, 'synthesis');
  assert.equal(events[1].childEventType, 'content_delta');
  assert.equal(events[2].outcome, 'complete');
  assert.equal(fx.providerCalls.length, 1);
  assert.match(fx.providerCalls[0].input, /Pinned brain stats: 2 nodes, 1 edges, 1 clusters/);
  assert.equal(fx.compareCalls, 1);
  assert.equal(fx.releaseCalls, 0);

  const expectedMarker = `generation-51-${createHash('sha256')
    .update(OPERATION_ID).update('\0')
    .update('2026-07-10T12:00:00.000Z').update('\0')
    .update('minimax').update('\0').update('MiniMax-M3')
    .digest('hex').slice(0, 24)}`;
  assert.equal(result.generationMarker, expectedMarker);
  const state = await readCommittedSynthesisState({ brainDir: fx.brainDir });
  assert.equal(state.generationMarker, result.generationMarker);
  assert.equal(state.operationId, OPERATION_ID);
  const { brainStateSha256, ...withoutHash } = state;
  assert.equal(
    brainStateSha256,
    `sha256:${createHash('sha256').update(canonicalJson(withoutHash)).digest('hex')}`,
  );
  assert.equal(result.brainStateSha256, brainStateSha256);

  state.selfUnderstanding.summary = 'tampered';
  await fsp.writeFile(path.join(fx.brainDir, 'brain-state.json'), JSON.stringify(state));
  await assert.rejects(() => readCommittedSynthesisState({ brainDir: fx.brainDir }), {
    code: 'synthesis_state_invalid',
  });
});

test('source change prevents the durable write and publishes no prospective marker', async (t) => {
  const fx = await fixture(t, { commit: false });
  const previous = '{"generationMarker":"old"}\n';
  await fsp.writeFile(path.join(fx.brainDir, 'brain-state.json'), previous);
  await assert.rejects(() => fx.agent.runOperation({
    operationId: OPERATION_ID,
    sourcePin: fx.sourcePin,
  }), { code: 'source_changed' });
  assert.equal(await fsp.readFile(path.join(fx.brainDir, 'brain-state.json'), 'utf8'), previous);
  assert.equal(fx.releaseCalls, 0);
});

test('exact cancellation identity is preserved at source, provider, JSON, and CAS boundaries', async (t) => {
  for (const boundary of ['summarize', 'provider', 'json', 'cas']) {
    const controller = new AbortController();
    const reason = Object.assign(new Error(`sentinel-${boundary}`), { name: 'AbortError' });
    const options = {};
    if (boundary === 'summarize') {
      options.onSummarize = () => controller.abort(reason);
    } else if (boundary === 'provider') {
      options.generate = async () => {
        controller.abort(reason);
        return { content: completeContent(), terminalReceived: true, finishReason: 'stop', hadError: false };
      };
    } else if (boundary === 'json') {
      options.hooks = { beforeJsonExtract: () => controller.abort(reason) };
    } else {
      options.hooks = { beforeCompareAndSwap: () => controller.abort(reason) };
    }
    const fx = await fixture(t, options);
    await assert.rejects(() => fx.agent.runOperation({
      operationId: OPERATION_ID,
      sourcePin: fx.sourcePin,
      signal: controller.signal,
    }), (error) => error === reason);
    assert.equal(fx.releaseCalls, 0);
    if (boundary !== 'cas') {
      assert.equal(await fsp.access(path.join(fx.brainDir, 'brain-state.json')).then(() => true).catch(() => false), false);
    }
  }
});

test('oversized workspace input fails before allocation/provider work and symlinks fail closed', async (t) => {
  const fx = await fixture(t, { limits: { maxPromptBytes: 4096 } });
  await fsp.writeFile(path.join(fx.workspacePath, 'SOUL.md'), 'x'.repeat(4097));
  await assert.rejects(() => fx.agent.runOperation({
    operationId: OPERATION_ID,
    sourcePin: fx.sourcePin,
  }), { code: 'result_too_large', retryable: false });
  assert.equal(fx.providerCalls.length, 0);

  await fsp.rm(path.join(fx.workspacePath, 'SOUL.md'));
  await fsp.symlink(path.join(fx.workspacePath, 'MISSION.md'), path.join(fx.workspacePath, 'SOUL.md'));
  await assert.rejects(() => fx.agent.runOperation({
    operationId: OPERATION_ID,
    sourcePin: fx.sourcePin,
  }), { code: 'invalid_memory_source' });
  assert.equal(fx.providerCalls.length, 0);
});

test('provider output exact boundary passes and one byte over fails before parse/CAS', async (t) => {
  const content = completeContent({ padding: 'x'.repeat(1000) });
  const exactBytes = Buffer.byteLength(content, 'utf8');
  const exact = await fixture(t, {
    limits: { maxProviderOutputBytes: exactBytes },
    generate: async () => ({
      content, terminalReceived: true, finishReason: 'stop', hadError: false,
    }),
  });
  await exact.agent.runOperation({ operationId: OPERATION_ID, sourcePin: exact.sourcePin });
  assert.equal(exact.compareCalls, 1);

  const over = await fixture(t, {
    limits: { maxProviderOutputBytes: exactBytes - 1 },
    generate: async () => ({
      content, terminalReceived: true, finishReason: 'stop', hadError: false,
    }),
  });
  const previous = '{"generationMarker":"prior"}\n';
  await fsp.writeFile(path.join(over.brainDir, 'brain-state.json'), previous);
  await assert.rejects(() => over.agent.runOperation({
    operationId: OPERATION_ID,
    sourcePin: over.sourcePin,
  }), { code: 'result_too_large', retryable: false });
  assert.equal(over.compareCalls, 0);
  assert.equal(await fsp.readFile(path.join(over.brainDir, 'brain-state.json'), 'utf8'), previous);
});

test('brain-state one byte over fails before durable CAS and leaves prior state byte-identical', async (t) => {
  const baseline = await fixture(t);
  await baseline.agent.runOperation({ operationId: OPERATION_ID, sourcePin: baseline.sourcePin });
  const bytes = (await fsp.readFile(path.join(baseline.brainDir, 'brain-state.json'))).length;

  const over = await fixture(t, { limits: { maxBrainStateBytes: bytes - 1 } });
  const previous = '{"generationMarker":"prior"}\n';
  await fsp.writeFile(path.join(over.brainDir, 'brain-state.json'), previous);
  await assert.rejects(() => over.agent.runOperation({
    operationId: OPERATION_ID,
    sourcePin: over.sourcePin,
  }), { code: 'result_too_large', retryable: false });
  assert.equal(over.compareCalls, 0);
  assert.equal(await fsp.readFile(path.join(over.brainDir, 'brain-state.json'), 'utf8'), previous);
});

test('descriptor summary mismatch blocks provider work', async (t) => {
  const fx = await fixture(t);
  fx.sourcePin.descriptor.summary.nodeCount = 3;
  await assert.rejects(() => fx.agent.runOperation({
    operationId: OPERATION_ID,
    sourcePin: fx.sourcePin,
  }), { code: 'source_changed' });
  assert.equal(fx.providerCalls.length, 0);
});

test('legacy helper behavior remains bounded without carrying full index content', async (t) => {
  const fx = await fixture(t);
  const digest = fx.agent._buildIndexDigest(`# Brain Index\nDocuments compiled: 3\n\n## Trading\nsecret volume\n## Trading\nmore\n## Architecture\nagency spine\n`);
  assert.match(digest, /Trading \(2 index sections\)/);
  assert.match(digest, /Architecture \(1 index sections\)/);
  assert.match(digest, /Counts are not salience/);
  assert.doesNotMatch(digest, /secret volume/);
  const themes = fx.agent._collectSearchThemes('## Trading\n## Architecture\n');
  assert.equal(themes[0], 'direct user conversation jtr current request');
  assert.equal(themes[2], 'brain cleanup memory retrieval consolidation salience');
  assert.ok(themes.includes('Trading'));
});
