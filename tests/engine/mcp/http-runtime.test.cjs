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
