const test = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs').promises;
const os = require('node:os');
const path = require('node:path');

const {
  MAX_SCALAR_SNAPSHOT_BYTES,
  createMcpReadinessController,
  createSnapshotScalarStateReader,
} = require('../../../shared/memory-source/mcp-http-runtime.cjs');

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-mcp-runtime-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

test('scalar MCP state reads only the bounded brain snapshot projection', async (t) => {
  const brainDir = await fixture(t);
  await fsp.writeFile(path.join(brainDir, 'brain-snapshot.json'), JSON.stringify({
    savedAt: '2026-07-10T21:00:00.000Z',
    cycle: 42,
    nodeCount: 100,
    edgeCount: 200,
    goalCounts: { active: 1, completed: 2, archived: 3 },
    activeGoalSummaries: [{ id: 'g1', description: 'bounded', status: 'active' }],
  }));
  // A poisonous legacy state file proves the reader does not inspect it.
  await fsp.writeFile(path.join(brainDir, 'state.json.gz'), 'not a gzip stream');

  const state = await createSnapshotScalarStateReader({ brainDir })();
  assert.equal(state.cycleCount, 42);
  assert.deepEqual(state.goals.counts, { active: 1, completed: 2, archived: 3 });
  assert.equal(state.goals.active[0][0], 'g1');
  assert.equal(state.scalarProjection.source, 'brain-snapshot');
  assert.equal(state.scalarProjection.capabilities.goals.status, 'degraded');
  assert.deepEqual(state.scalarProjection.capabilities.goals.available, [
    'activeSummaries', 'counts',
  ]);
  for (const capability of ['agentActivity', 'journal', 'dreams', 'oscillator']) {
    assert.equal(state.scalarProjection.capabilities[capability].status, 'unsupported');
    assert.equal(
      state.scalarProjection.capabilities[capability].error.code,
      'snapshot_capability_unsupported',
    );
  }
  assert.equal(Object.hasOwn(state, 'memory'), false);
});

test('missing scalar snapshot reports unsupported capabilities instead of false zero state', async (t) => {
  const brainDir = await fixture(t);

  const state = await createSnapshotScalarStateReader({ brainDir })();

  assert.equal(state.goals.active, null);
  assert.equal(state.goals.completed, null);
  assert.equal(state.goals.archived, null);
  assert.deepEqual(state.goals.counts, {
    active: null, completed: null, archived: null,
  });
  assert.equal(state.scalarProjection.sourceHealth, 'unavailable');
  for (const capability of ['goals', 'agentActivity', 'journal', 'dreams', 'oscillator']) {
    assert.equal(state.scalarProjection.capabilities[capability].status, 'unsupported');
    assert.equal(
      state.scalarProjection.capabilities[capability].error.code,
      'snapshot_capability_unsupported',
    );
  }
});

test('scalar MCP state rejects an oversized snapshot before parsing it', async (t) => {
  const brainDir = await fixture(t);
  await fsp.writeFile(
    path.join(brainDir, 'brain-snapshot.json'),
    Buffer.alloc(MAX_SCALAR_SNAPSHOT_BYTES + 1, 0x20),
  );
  await assert.rejects(
    createSnapshotScalarStateReader({ brainDir })(),
    (error) => error.code === 'scalar_snapshot_unavailable',
  );
});

test('readiness is starting until source proof and retries unavailable checks', async () => {
  let now = 100;
  let calls = 0;
  const memoryTools = {
    async checkReadiness() {
      calls += 1;
      if (calls === 1) return {
        ok: false,
        sourceHealth: 'unavailable',
        error: { code: 'source_unavailable', retryable: true },
      };
      return { ok: true, sourceHealth: 'healthy', revision: 4 };
    },
  };
  const readiness = createMcpReadinessController({
    memoryTools,
    retryMs: 50,
    now: () => now,
    logger: { warn() {} },
  });
  assert.equal(readiness.status().sourceHealth, 'starting');
  await readiness.refresh();
  assert.equal(readiness.status().sourceHealth, 'unavailable');
  now += 51;
  readiness.status();
  await readiness.refresh();
  assert.equal(readiness.status().ok, true);
  assert.equal(readiness.status().revision, 4);
  readiness.close();
});

test('expired healthy readiness fails closed while bounded refresh is pending', async () => {
  let now = 100;
  let revision = 4;
  let releaseRefresh = null;
  const memoryTools = {
    async checkReadiness() {
      if (releaseRefresh) await new Promise((resolve) => { releaseRefresh = resolve; });
      return {
        ok: true,
        sourceHealth: 'healthy',
        revision,
        totals: { nodes: revision, edges: revision * 2 },
      };
    },
  };
  const readiness = createMcpReadinessController({
    memoryTools,
    retryMs: 50,
    now: () => now,
    logger: { warn() {} },
  });
  await readiness.refresh();
  assert.equal(readiness.status().revision, 4);

  revision = 5;
  now += 51;
  releaseRefresh = true;
  assert.deepEqual(readiness.status(), {
    ok: false,
    protocolVersion: '2025-03-26',
    sourceHealth: 'unavailable',
    error: {
      code: 'source_refresh_pending',
      message: 'canonical source readiness refresh is pending',
      retryable: true,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseRefresh, 'function');
  releaseRefresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(readiness.status(), {
    ok: true,
    protocolVersion: '2025-03-26',
    sourceHealth: 'healthy',
    revision: 5,
    totals: { nodes: 5, edges: 10 },
  });
  readiness.close();
});

test('readiness freshness begins when a slow canonical source check completes', async () => {
  let now = 100;
  const readiness = createMcpReadinessController({
    memoryTools: {
      async checkReadiness() {
        now += 75;
        return {
          ok: true,
          sourceHealth: 'healthy',
          revision: 8,
        };
      },
    },
    retryMs: 50,
    now: () => now,
    logger: { warn() {} },
  });

  await readiness.refresh();
  assert.deepEqual(readiness.status(), {
    ok: true,
    protocolVersion: '2025-03-26',
    sourceHealth: 'healthy',
    revision: 8,
  });
  readiness.close();
});

test('direct refresh invalidates an expired healthy proof before its check completes', async () => {
  let now = 100;
  let calls = 0;
  let releaseRefresh;
  const readiness = createMcpReadinessController({
    memoryTools: {
      async checkReadiness() {
        calls += 1;
        if (calls > 1) await new Promise((resolve) => { releaseRefresh = resolve; });
        return { ok: true, sourceHealth: 'healthy', revision: calls };
      },
    },
    retryMs: 50,
    now: () => now,
    logger: { warn() {} },
  });
  await readiness.refresh();
  assert.equal(readiness.status().revision, 1);

  now += 51;
  const pending = readiness.refresh();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseRefresh, 'function');
  assert.equal(readiness.status().ok, false);
  assert.equal(readiness.status().error.code, 'source_refresh_pending');
  releaseRefresh();
  await pending;
  assert.equal(readiness.status().revision, 2);
  readiness.close();
});

test('healthy readiness proactively renews across TTLs and clears its unref timer', async () => {
  let now = 100;
  let calls = 0;
  const timers = [];
  const readiness = createMcpReadinessController({
    memoryTools: {
      async checkReadiness() {
        calls += 1;
        if (calls === 3) return {
          ok: false,
          sourceHealth: 'unavailable',
          error: { code: 'source_unavailable', retryable: true },
        };
        return { ok: true, sourceHealth: 'healthy', revision: calls };
      },
    },
    retryMs: 100,
    refreshIntervalMs: 50,
    now: () => now,
    setTimeoutImpl(callback, delay) {
      const timer = {
        callback,
        delay,
        cleared: false,
        unrefCalls: 0,
        unref() { this.unrefCalls += 1; },
      };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timer.cleared = true; },
    logger: { warn() {} },
  });
  await readiness.refresh();
  assert.equal(readiness.status().revision, 1);
  assert.equal(timers[0].delay, 50);
  assert.equal(timers[0].unrefCalls, 1);

  now = 150;
  timers[0].callback();
  await readiness.refresh();
  assert.equal(readiness.status().revision, 2);
  assert.equal(timers[1].unrefCalls, 1);

  now = 200;
  timers[1].callback();
  await readiness.refresh();
  assert.equal(readiness.status().ok, false);
  assert.equal(readiness.status().error.code, 'source_unavailable');

  readiness.close();
  assert.equal(timers[2].cleared, true);
});

test('slow proactive readiness refresh becomes 503 only when the old proof expires', async () => {
  let now = 100;
  let calls = 0;
  let scheduled = null;
  let releaseRefresh;
  const readiness = createMcpReadinessController({
    memoryTools: {
      async checkReadiness() {
        calls += 1;
        if (calls > 1) await new Promise((resolve) => { releaseRefresh = resolve; });
        return { ok: true, sourceHealth: 'healthy', revision: calls };
      },
    },
    retryMs: 100,
    refreshIntervalMs: 50,
    now: () => now,
    setTimeoutImpl(callback) {
      scheduled = callback;
      return { unref() {} };
    },
    clearTimeoutImpl() {},
    logger: { warn() {} },
  });
  await readiness.refresh();
  now = 150;
  scheduled();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof releaseRefresh, 'function');
  assert.equal(readiness.status().ok, true);

  now = 201;
  assert.equal(readiness.status().ok, false);
  assert.equal(readiness.status().error.code, 'source_refresh_pending');
  releaseRefresh();
  await readiness.refresh();
  assert.equal(readiness.status().ok, true);
  assert.equal(readiness.status().revision, 2);
  readiness.close();
});

test('transient proactive busy retains but never extends the original healthy TTL', async () => {
  let now = 100;
  let calls = 0;
  const timers = [];
  const readiness = createMcpReadinessController({
    memoryTools: {
      async checkReadiness() {
        calls += 1;
        if (calls === 1) return {
          ok: true, sourceHealth: 'healthy', revision: 1,
        };
        return {
          ok: false,
          sourceHealth: 'unavailable',
          error: { code: 'source_busy', retryable: true },
        };
      },
    },
    retryMs: 100,
    refreshIntervalMs: 50,
    now: () => now,
    setTimeoutImpl(callback, delay) {
      const timer = { callback, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl() {},
    logger: { warn() {} },
  });
  await readiness.refresh();
  assert.equal(readiness.status().revision, 1);

  now = 150;
  timers[0].callback();
  await readiness.refresh();
  assert.equal(readiness.status().ok, true);
  assert.equal(readiness.status().revision, 1);

  now = 199;
  assert.equal(readiness.status().ok, true);
  assert.equal(readiness.status().revision, 1);

  now = 200;
  assert.equal(readiness.status().ok, false);
  assert.equal(readiness.status().error.code, 'source_refresh_pending');
  await readiness.refresh();
  assert.equal(readiness.status().ok, false);
  assert.equal(readiness.status().error.code, 'source_busy');
  readiness.close();
});
