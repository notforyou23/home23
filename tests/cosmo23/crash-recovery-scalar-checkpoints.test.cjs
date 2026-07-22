'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { CrashRecoveryManager } = require('../../cosmo23/engine/src/core/crash-recovery-manager');
const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

async function makeRuntimeDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo23-crash-recovery-'));
  t.after(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeGzState(dir, state) {
  await fsp.writeFile(
    path.join(dir, 'state.json.gz'),
    zlib.gzipSync(JSON.stringify(state)),
  );
}

async function writeLegacyFullGraphCheckpoint(dir, cycle) {
  const checkpointsDir = path.join(dir, 'checkpoints');
  await fsp.mkdir(checkpointsDir, { recursive: true });
  const legacyCheckpoint = {
    cycle,
    timestamp: new Date().toISOString(),
    state: {
      cycleCount: cycle,
      journal: [
        { cycle: cycle - 2, thought: 'checkpoint thought one' },
        { cycle: cycle - 1, thought: 'checkpoint thought two' },
        { cycle, thought: 'checkpoint thought three' },
      ],
      lastSummarization: cycle - 3,
      memory: {
        nodes: [{ id: 9001, concept: 'stale checkpoint node', embedding: [0.1, 0.2, 0.3] }],
        edges: [{ source: 9001, target: 9002, weight: 0.5 }],
        clusters: [],
      },
      goals: { goals: [] },
      guidedMissionPlan: { plan: { phases: [{ name: 'phase-1' }] } },
      completionTracker: { objectives: [{ completed: false }] },
    },
  };
  await fsp.writeFile(
    path.join(checkpointsDir, `checkpoint-${cycle}.json`),
    JSON.stringify(legacyCheckpoint),
  );
  return legacyCheckpoint;
}

test('crash detection treats a gz-only state as a crashed run, not a first run', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 10 });

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();

  assert.equal(manager.crashDetected, true, 'state.json.gz without clean marker must classify as crash');
});

test('crash detection still honors legacy uncompressed state.json', async (t) => {
  const dir = await makeRuntimeDir(t);
  await fsp.writeFile(path.join(dir, 'state.json'), JSON.stringify({ cycleCount: 3 }));

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();

  assert.equal(manager.crashDetected, true);
});

test('crash detection with no state artifacts is a first run', async (t) => {
  const dir = await makeRuntimeDir(t);

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();

  assert.equal(manager.crashDetected, false);
});

test('clean shutdown marker suppresses crash detection even with state.json.gz', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 10 });
  await fsp.writeFile(path.join(dir, '.clean_shutdown'), new Date().toISOString());

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();

  assert.equal(manager.crashDetected, false);
});

test('recovery always calls loadState and applies the checkpoint as a scalar overlay only', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 10 });
  await writeLegacyFullGraphCheckpoint(dir, 15);

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();
  assert.equal(manager.crashDetected, true);

  const hydratedNodes = new Map([
    ['brain-a', { id: 'brain-a' }],
    ['brain-b', { id: 'brain-b' }],
  ]);
  const stub = {
    crashRecovery: manager,
    logger: silentLogger,
    cycleCount: 0,
    journal: [],
    lastSummarization: 0,
    guidedMissionPlan: null,
    completionTracker: null,
    memory: { nodes: hydratedNodes, edges: new Map(), clusters: new Map() },
    loadStateCalls: 0,
    async loadState() {
      this.loadStateCalls += 1;
      this.cycleCount = 10;
      this.journal = [{ cycle: 10, thought: 'from state file' }];
      this.lastSummarization = 8;
    },
  };

  await Orchestrator.prototype.restoreFromPersistence.call(stub);

  assert.equal(stub.loadStateCalls, 1, 'loadState must ALWAYS run during recovery');

  // Checkpoint (cycle 15) is strictly fresher than loaded state (cycle 10):
  // scalar overlay applies.
  assert.equal(stub.cycleCount, 15);
  assert.equal(stub.lastSummarization, 12);
  assert.equal(stub.journal.length, 3);
  assert.deepEqual(stub.guidedMissionPlan, { phases: [{ name: 'phase-1' }] });
  assert.deepEqual(stub.completionTracker, { objectives: [{ completed: false }] });

  // Memory from the legacy full-graph checkpoint is IGNORED — the graph
  // hydrated by loadState() stays untouched.
  assert.equal(stub.memory.nodes, hydratedNodes, 'memory container must not be replaced');
  assert.equal(stub.memory.nodes.size, 2);
  assert.equal(stub.memory.nodes.has(9001), false, 'checkpoint node must not leak into memory');
  assert.equal(stub.memory.edges.size, 0);
});

test('a stale checkpoint never regresses scalars restored by loadState', async (t) => {
  const dir = await makeRuntimeDir(t);
  await writeGzState(dir, { cycleCount: 40 });
  await writeLegacyFullGraphCheckpoint(dir, 15);

  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.initialize();
  assert.equal(manager.crashDetected, true);

  const stub = {
    crashRecovery: manager,
    logger: silentLogger,
    cycleCount: 0,
    journal: [],
    lastSummarization: 0,
    guidedMissionPlan: { phases: [{ name: 'phase-from-state' }] },
    completionTracker: { objectives: [{ completed: true }] },
    memory: { nodes: new Map([['n1', {}]]), edges: new Map(), clusters: new Map() },
    loadStateCalls: 0,
    async loadState() {
      this.loadStateCalls += 1;
      this.cycleCount = 40;
      this.journal = [
        { cycle: 37, thought: 'a' },
        { cycle: 38, thought: 'b' },
        { cycle: 39, thought: 'c' },
        { cycle: 40, thought: 'd' },
      ];
      this.lastSummarization = 35;
    },
  };

  await Orchestrator.prototype.restoreFromPersistence.call(stub);

  assert.equal(stub.loadStateCalls, 1);
  assert.equal(stub.cycleCount, 40, 'stale checkpoint must not roll the cycle counter back');
  assert.equal(stub.lastSummarization, 35);
  assert.equal(stub.journal.length, 4);
  assert.deepEqual(stub.guidedMissionPlan, { phases: [{ name: 'phase-from-state' }] });
  assert.deepEqual(stub.completionTracker, { objectives: [{ completed: true }] });
});

test('clean start skips checkpoint recovery but still loads state exactly once', async () => {
  const stub = {
    crashRecovery: {
      crashDetected: false,
      async recover() {
        throw new Error('recover() must not run without a detected crash');
      },
    },
    logger: silentLogger,
    cycleCount: 0,
    journal: [],
    lastSummarization: 0,
    guidedMissionPlan: null,
    completionTracker: null,
    memory: { nodes: new Map(), edges: new Map(), clusters: new Map() },
    loadStateCalls: 0,
    async loadState() {
      this.loadStateCalls += 1;
    },
  };

  await Orchestrator.prototype.restoreFromPersistence.call(stub);

  assert.equal(stub.loadStateCalls, 1);
});

test('buildCheckpointState emits scalars plus memory count summary, never graph arrays', async (t) => {
  const stub = {
    cycleCount: 20,
    journal: Array.from({ length: 150 }, (_, i) => ({ cycle: i, thought: `t${i}` })),
    lastSummarization: 18,
    guidedMissionPlan: { phases: [{ name: 'phase-1' }] },
    completionTracker: { objectives: [] },
    memory: {
      nodes: new Map([[1, { id: 1, embedding: new Array(512).fill(0.1) }]]),
      edges: new Map([['1->2', { source: 1, target: 2 }]]),
      clusters: new Map(),
      exportGraph() {
        throw new Error('checkpoints must never export the memory graph');
      },
    },
  };

  const checkpointState = Orchestrator.prototype.buildCheckpointState.call(stub);

  assert.equal(checkpointState.cycleCount, 20);
  assert.equal(checkpointState.journal.length, 100, 'journal capped at last 100 entries');
  assert.equal(checkpointState.lastSummarization, 18);
  assert.equal(checkpointState.recoverySource, 'state.json.gz');
  assert.deepEqual(checkpointState.memorySummary, { nodes: 1, edges: 1, clusters: 0 });
  assert.equal('memory' in checkpointState, false, 'no memory graph in checkpoints');
  assert.equal('goals' in checkpointState, false);
  assert.equal('roles' in checkpointState, false);
  assert.equal('agentExecutor' in checkpointState, false);
  assert.equal('coordinator' in checkpointState, false);

  // The persisted checkpoint file carries no nodes/edges arrays either.
  const dir = await makeRuntimeDir(t);
  const manager = new CrashRecoveryManager({}, silentLogger, dir);
  await manager.saveCheckpoint(checkpointState, 20);

  const written = JSON.parse(await fsp.readFile(
    path.join(dir, 'checkpoints', 'checkpoint-20.json'),
    'utf8',
  ));
  assert.equal(written.cycle, 20);
  assert.equal(written.state.memory, undefined);
  assert.deepEqual(written.state.memorySummary, { nodes: 1, edges: 1, clusters: 0 });
  const raw = JSON.stringify(written);
  assert.equal(raw.includes('"embedding"'), false, 'no embeddings serialized into checkpoints');

  // Audit artifact reports counts from memorySummary.
  const audit = JSON.parse(await fsp.readFile(
    path.join(dir, 'checkpoints', 'checkpoint-20_audit.json'),
    'utf8',
  ));
  assert.equal(audit.state_snapshot.memoryNodes, 1);
  assert.equal(audit.state_snapshot.memoryEdges, 1);
});

test('recover() ignores checkpoint audit artifacts', async (t) => {
  const dir = await makeRuntimeDir(t);
  const manager = new CrashRecoveryManager({}, silentLogger, dir);

  // A real checkpoint written through saveCheckpoint also writes the
  // checkpoint-20_audit.json sidecar next to it.
  await manager.saveCheckpoint(
    { cycleCount: 20, memorySummary: { nodes: 1, edges: 0, clusters: 0 } },
    20,
  );

  const listed = await manager.listCheckpoints();
  assert.deepEqual(listed, ['checkpoint-20.json'],
    'audit sidecar must not be listed as a checkpoint');

  const recovered = await manager.recover();
  assert.equal(recovered.cycleCount, 20, 'real checkpoint state must be recovered');

  // A directory containing ONLY an audit artifact has no recoverable
  // checkpoint: recover() must return null, not a spurious success parsed
  // out of the audit file.
  const auditOnlyDir = await makeRuntimeDir(t);
  const auditOnly = new CrashRecoveryManager({}, silentLogger, auditOnlyDir);
  await fsp.mkdir(path.join(auditOnlyDir, 'checkpoints'), { recursive: true });
  await fsp.writeFile(
    path.join(auditOnlyDir, 'checkpoints', 'checkpoint-5_audit.json'),
    JSON.stringify({
      schema_version: 'cosmo-audit-v1',
      checkpoint_cycle: 5,
      state_snapshot: { cycleCount: 5, memoryNodes: 0 },
    }),
  );

  const result = await auditOnly.recover();
  assert.equal(result, null,
    'audit-only checkpoints dir must not produce a spurious recovery');
});

test('recover() falls back to an older valid checkpoint when the newest is corrupt', async (t) => {
  const dir = await makeRuntimeDir(t);
  const manager = new CrashRecoveryManager({}, silentLogger, dir);

  await manager.saveCheckpoint(
    { cycleCount: 10, memorySummary: { nodes: 2, edges: 1, clusters: 0 } },
    10,
  );
  // A newer checkpoint that crashed mid-write: invalid JSON on disk.
  await fsp.writeFile(
    path.join(dir, 'checkpoints', 'checkpoint-15.json'),
    '{"cycle": 15, "state": {truncated',
  );

  const recovered = await manager.recover();
  assert.notEqual(recovered, null, 'an older valid checkpoint must be usable');
  assert.equal(recovered.cycleCount, 10,
    'recovery must fall back to the older valid checkpoint');
});

test('orchestrator wiring uses restoreFromPersistence and buildCheckpointState', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../cosmo23/engine/src/core/orchestrator.js'),
    'utf8',
  );
  assert.equal(source.includes('await this.restoreFromPersistence();'), true,
    'initialize() must route recovery through restoreFromPersistence');
  assert.equal(source.includes('const checkpointState = this.buildCheckpointState();'), true,
    'executeCycle checkpoint path must use buildCheckpointState');
});
