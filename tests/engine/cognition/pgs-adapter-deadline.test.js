import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PGSAdapter, DEFAULT_BUDGET } = require('../../../engine/src/cognition/pgs-adapter.js');
const { PGSEngine } = require('../../../shared/research-runtime/pgs-engine/src/index.js');
const { UnifiedClient } = require('../../../engine/src/core/unified-client.js');
const { OpenAICodexClient } = require('../../../engine/src/services/openai-codex-oauth-engine.js');
const logger = { info() {}, warn() {} };
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

function fixture(generate) {
  const nodes = new Map(Array.from({ length: 12 }, (_, i) => [String(i + 1), {
    id: String(i + 1), concept: `Connection material ${i + 1}`, tag: 'general',
  }]));
  const edges = new Map([['1->2', { weight: 1 }], ['1->3', { weight: 1 }], ['2->4', { weight: 1 }]]);
  const adapter = new PGSAdapter({ unifiedClient: { generate }, memory: { nodes, edges }, logger });
  assert.equal(adapter.available, true);
  adapter.engine._getOrCreatePartitions = async () => [{
    id: 'one', nodeIds: [...nodes.keys()], nodeCount: nodes.size,
    summary: 'A connected partition', keywords: ['connection'], adjacentPartitions: [],
  }];
  let sessionWrites = 0;
  adapter.engine.sessions.save = async () => { sessionWrites++; };
  const events = [];
  const execute = adapter.engine.execute.bind(adapter.engine);
  adapter.engine.execute = (query, graph, options) => execute(query, graph, {
    ...options, onEvent(event) { events.push(event.type); options.onEvent?.(event); },
  });
  return { adapter, events, sessionWrites: () => sessionWrites };
}

const args = {
  thought: 'Find meaningful connections in the supplied material.', referencedNodes: ['1'],
};

test('frontier synthesis can finish after the sweep-sized window without mutating engine config', async () => {
  const calls = [];
  const { adapter } = fixture(async options => {
    calls.push(options);
    await delay(options.component === 'pgsSweep' ? 15 : 55);
    return { content: '## A connection\nNode 1 connects to Node 2 across the material.' };
  });
  const originalConfig = { ...adapter.engine.config };
  const result = await adapter.connect({ ...args,
    budget: { timeoutMs: 200, sweepTimeoutMs: 50, synthesisTimeoutMs: 120 },
  });
  assert.equal(result.available, true);
  assert.ok(result.usage.durationMs > 50, 'synthesis must receive time beyond the sweep-only envelope');
  assert.equal(result.candidateEdges.length, 1);
  assert.deepEqual(calls.map(call => call.component), ['pgsSweep', 'pgsSynthesis']);
  assert.equal(calls[0].signal, calls[1].signal);
  assert.equal(calls[1].signal.aborted, false);
  assert.deepEqual(adapter.engine.config, originalConfig);
  await delay(140);
  assert.equal(calls[1].signal.aborted, false, 'successful execution must clear its deadline timer');
  assert.equal(DEFAULT_BUDGET.timeoutMs, DEFAULT_BUDGET.sweepTimeoutMs + DEFAULT_BUDGET.synthesisTimeoutMs);
});

test('expired sweep cannot write a late session, begin synthesis, or overlap unresolved provider work', async () => {
  const pending = deferred();
  const calls = [];
  const { adapter, events, sessionWrites } = fixture(async options => {
    calls.push(options);
    if (calls.length === 1) return pending.promise; // Deliberately ignores AbortSignal.
    return { content: 'Node 1 connects to Node 2.' };
  });
  const originalConfig = { ...adapter.engine.config };
  const result = await adapter.connect({ ...args,
    budget: { timeoutMs: 100, sweepTimeoutMs: 20, synthesisTimeoutMs: 60 },
  });
  assert.equal(result.available, false);
  assert.equal(result.note, 'timeout');
  assert.equal(calls[0].signal.aborted, true);
  assert.equal((await adapter.connect(args)).note, 'busy');
  assert.equal(calls.length, 1);
  assert.equal(sessionWrites(), 0);
  pending.resolve({ content: 'A late sweep result.' });
  await delay(5);
  assert.equal(sessionWrites(), 0);
  assert.equal(events.includes('synthesizing'), false);
  assert.equal(events.includes('complete'), false);
  assert.deepEqual(adapter.engine.config, originalConfig);
  assert.equal((await adapter.connect(args)).available, true, 'settled transport releases the busy guard');
});

test('synthesis deadline stays clipped to the original total deadline and rejects late output', async () => {
  const pending = deferred();
  const calls = [];
  const { adapter, events, sessionWrites } = fixture(async options => {
    calls.push(options);
    if (options.component === 'pgsSweep') {
      await delay(20);
      return { content: 'Findings ready for synthesis.' };
    }
    return pending.promise;
  });
  const result = await adapter.connect({ ...args,
    budget: { timeoutMs: 70, sweepTimeoutMs: 50, synthesisTimeoutMs: 150 },
  });
  assert.equal(result.note, 'timeout');
  assert.ok(result.usage.durationMs >= 65);
  assert.ok(result.usage.durationMs < 140, 'stage reset must not extend the total deadline');
  assert.deepEqual(calls.map(call => call.component), ['pgsSweep', 'pgsSynthesis']);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal((await adapter.connect(args)).note, 'busy');
  assert.equal(sessionWrites(), 1, 'completed sweeps were recorded before synthesis expired');
  pending.resolve({ content: 'Node 1 connects to Node 2 in late synthesis.' });
  await delay(5);
  assert.equal(events.includes('complete'), false);
  assert.equal(adapter.stats.successCount, 0);
  assert.equal(sessionWrites(), 1);
});

test('isolated candidates still skip without starting providers or a deadline', async () => {
  let calls = 0;
  const { adapter } = fixture(async () => { calls++; });
  const result = await adapter.connect({ ...args, referencedNodes: ['12'] });
  assert.equal(result.note, 'skipped_isolated');
  assert.equal(calls, 0);
  assert.equal(adapter._executionInFlight, false);
});

test('direct PGS cancellation prevents later sweep batches and late session writes', async () => {
  const pending = deferred();
  const started = deferred();
  const controller = new AbortController();
  let calls = 0;
  let writes = 0;
  const engine = new PGSEngine({
    sweepProvider: { async generate() { calls++; started.resolve(); return pending.promise; } },
    synthesisProvider: { async generate() { throw new Error('Synthesis must not start'); } },
    config: { maxConcurrentSweeps: 1, maxSweepPartitions: 2 },
  });
  engine._getOrCreatePartitions = async () => ['one', 'two'].map(id => ({
    id, nodeIds: ['1'], nodeCount: 1, keywords: [], adjacentPartitions: [],
  }));
  engine.sessions.save = async () => { writes++; };
  const running = engine.execute('Find connections', {
    nodes: [{ id: '1', concept: 'Material' }], edges: [],
  }, { signal: controller.signal });
  await started.promise;
  const reason = new Error('Owner cancelled PGS');
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
  pending.resolve({ content: 'Late provider output' });
  await delay(5);
  assert.equal(calls, 1);
  assert.equal(writes, 0);
});

for (const cached of [null, JSON.stringify({ partitions: [{ id: 'late-cache-hit' }] })]) {
  test(`PGS cancellation during a deferred partition cache ${cached ? 'hit' : 'miss'} prevents late cache effects`, async () => {
    const pendingRead = deferred();
    const reading = deferred();
    const controller = new AbortController();
    let partitions = 0;
    let writes = 0;
    let providers = 0;
    const provider = { async generate() { providers++; throw new Error('Provider must not run'); } };
    const engine = new PGSEngine({
      sweepProvider: provider, synthesisProvider: provider,
      storage: {
        async read() { reading.resolve(); return pendingRead.promise; },
        async write() { writes++; },
      },
    });
    engine.partition = () => { partitions++; return []; };
    const running = engine.execute('Find connections', { nodes: [], edges: [] }, { signal: controller.signal });
    await reading.promise;
    const reason = new Error('PGS expired during partition cache read');
    controller.abort(reason);
    await assert.rejects(running, error => error === reason);
    pendingRead.resolve(cached);
    await delay(5);
    assert.equal(partitions, 0);
    assert.equal(writes, 0);
    assert.equal(providers, 0);
    assert.equal(engine._partitionCache.size, 0);
  });
}

function routedClient(assignment) {
  const client = Object.create(UnifiedClient.prototype);
  client.logger = { info() {}, warn() {}, error() {} };
  client.getModelAssignment = () => assignment;
  return client;
}

test('UnifiedClient cancellation stops retries and configured fallback providers', async () => {
  const controller = new AbortController();
  const reason = new Error('PGS expired');
  let calls = 0;
  let fallbackCalls = 0;
  const client = routedClient({ provider: 'xai', model: 'primary', fallback: { provider: 'openai-codex', model: 'fallback' } });
  client.generateXAI = async () => {
    calls++;
    controller.abort(reason);
    throw new Error('Provider failed after expiry');
  };
  client.generateOpenAICodex = async () => { fallbackCalls++; return { content: 'Must not run' }; };
  await assert.rejects(client.generate({ signal: controller.signal }, 3), error => error === reason);
  assert.equal(calls, 1);
  assert.equal(fallbackCalls, 0);
});

test('UnifiedClient fallback cancellation cannot move to another provider', async () => {
  const controller = new AbortController();
  const reason = new Error('PGS expired while trying a fallback');
  let calls = 0;
  const client = routedClient(null);
  client.generateXAI = async () => {
    calls++;
    controller.abort(reason);
    throw new Error('Fallback transport failed');
  };
  client.generateLocal = async () => { calls++; throw new Error('Second fallback must not run'); };
  await assert.rejects(client.resolveFallbackChain([
    { provider: 'xai', model: 'one' }, { provider: 'local', model: 'two' },
  ], { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
});

test('UnifiedClient cancellation interrupts retry backoff before another call', async () => {
  const retrying = deferred();
  const controller = new AbortController();
  const reason = new Error('PGS expired during retry backoff');
  let calls = 0;
  const client = routedClient({ provider: 'xai', model: 'primary' });
  client.logger.info = text => { if (text.startsWith('Retrying after')) retrying.resolve(); };
  client.generateXAI = async () => { calls++; throw new Error('Retryable provider failure'); };
  const running = client.generate({ signal: controller.signal }, 2);
  await retrying.promise;
  controller.abort(reason);
  await assert.rejects(running, error => error === reason);
  assert.equal(calls, 1);
});

test('UnifiedClient cancellation cannot turn an Anthropic auth failure into a retry', async () => {
  const controller = new AbortController();
  const reason = new Error('401 unauthorized after deadline');
  let calls = 0;
  const client = routedClient({ provider: 'anthropic', model: 'primary' });
  client._ensureAnthropicClient = () => {};
  client.anthropic = {};
  client.generateAnthropicCompatible = async () => {
    calls++;
    controller.abort(reason);
    throw reason;
  };
  await assert.rejects(client.generate({ signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
});

const credentials = { accessToken: 'test-token', accountId: 'test-account', authMode: 'oauth' };

test('Codex cancellation aborts the fetch request instead of leaving its transport pending', async () => {
  const oldFetch = global.fetch;
  const controller = new AbortController();
  const started = deferred();
  const reason = new Error('PGS fetch deadline');
  let released = false;
  try {
    global.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      assert.equal(options.signal, controller.signal);
      options.signal.addEventListener('abort', () => {
        released = true;
        reject(options.signal.reason);
      }, { once: true });
      started.resolve();
    });
    const client = new OpenAICodexClient({}, logger);
    const running = client._generateAttempt({ query: 'Connect material', signal: controller.signal }, credentials);
    await started.promise;
    controller.abort(reason);
    await assert.rejects(running, error => error === reason);
    assert.equal(released, true);
  } finally { global.fetch = oldFetch; }
});

test('Codex expiry cancels an open SSE reader and rejects its partial answer', async () => {
  const oldFetch = global.fetch;
  const controller = new AbortController();
  const reading = deferred();
  const pendingRead = deferred();
  const reason = new Error('PGS synthesis deadline');
  let reads = 0;
  let cancels = 0;
  let releases = 0;
  try {
    global.fetch = async (_url, options) => {
      assert.equal(options.signal, controller.signal);
      return { ok: true, body: { getReader() { return {
        async read() {
          reads++;
          if (reads === 1) return { done: false, value: Buffer.from('data: {"type":"response.output_text.delta","delta":"A partial connection"}\n\n') };
          reading.resolve();
          return pendingRead.promise;
        },
        cancel(error) { assert.equal(error, reason); cancels++; pendingRead.resolve({ done: true }); },
        releaseLock() { releases++; },
      }; } } };
    };
    const client = new OpenAICodexClient({}, logger);
    const running = client._generateAttempt({ query: 'Connect material', signal: controller.signal }, credentials);
    await reading.promise;
    controller.abort(reason);
    await assert.rejects(running, error => error === reason);
    assert.equal(cancels, 1);
    assert.equal(releases, 1);
  } finally { global.fetch = oldFetch; }
});

test('already cancelled Codex request fails before credentials or fetch', async () => {
  const oldFetch = global.fetch;
  const controller = new AbortController();
  const reason = new Error('Cancelled before provider admission');
  controller.abort(reason);
  let fetches = 0;
  try {
    global.fetch = async () => { fetches++; throw new Error('Fetch must not run'); };
    const client = new OpenAICodexClient({}, logger);
    await assert.rejects(client.generate({ query: 'Connect material', signal: controller.signal }), error => error === reason);
    assert.equal(fetches, 0);
  } finally { global.fetch = oldFetch; }
});
