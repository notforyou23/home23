# Fix 1.4 — cosmo23 crash-recovery overhaul: both-artifact crash detection, loadState-always recovery with scalar-only checkpoint overlay, scalar checkpoints

## Target current state

BUG (a) — detection misses state.json.gz. /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/crash-recovery-manager.js:70-79:
```js
      // Check if state.json exists to differentiate
      const statePath = path.join(this.logsDir, 'state.json');
      try {
        await fs.access(statePath);
        // State exists but no clean marker = crash
        return true;
      } catch (error) {
        // No state file = first run
        return false;
      }
```
But the orchestrator saves compressed state: orchestrator.js:8104-8110 routes through `StateCompression.saveCompressed(statePath, capturedState, { compress: true, ... })` which produces state.json.gz (loadState at orchestrator.js:8366-8373 explicitly checks both `statePath + '.gz'` and `statePath`). A crashed gz-only run therefore returns false from detectCrash → classified as first run → recovery never attempted.

BUG (b) — checkpoint recovery skips loadState (memory=0 class). /Users/jtr/_JTR23_/release/home23/cosmo23/engine/src/core/orchestrator.js:457-486:
```js
    // Phase A: Attempt recovery if crash detected
    if (this.crashRecovery.crashDetected) {
      this.logger.warn('🔄 Crash detected, attempting recovery from checkpoint...');
      const recoveredState = await this.crashRecovery.recover();
      if (recoveredState) {
        this.logger.info('✅ State recovered from checkpoint');
        // Import recovered state
        this.cycleCount = recoveredState.cycleCount || 0;
        this.journal = recoveredState.journal || [];
        this.lastSummarization = recoveredState.lastSummarization || 0;
        ... (guidedMissionPlan / completionTracker import) ...
      } else {
        this.logger.warn('⚠️  No checkpoint available, loading from state file');
        await this.loadState();
      }
    } else {
      await this.loadState();
    }
```
`loadState()` is only called on the two non-recovery branches. When a checkpoint IS recovered, `this.memory` is never hydrated — the run resumes at the checkpoint's cycleCount with 0 nodes.

BUG (c) — full-graph checkpoints. orchestrator.js:3226-3244 (inside executeCycle, every 5 cycles):
```js
          // Build checkpoint state (same structure as saveState())
          const checkpointState = {
            cycleCount: this.cycleCount,
            journal: this.journal.slice(-100),
            memory: this.memory.exportGraph(),
            goals: this.goals.export(),
            roles: this.roles.getRoles(),
            reflection: this.reflection.export(),
            oscillator: this.oscillator.getStats(),
            coordinator: this.coordinator ? this.coordinator.export() : null,
            agentExecutor: this.agentExecutor ? this.agentExecutor.exportState() : null,
            forkSystem: this.forkSystem ? this.forkSystem.export() : null,
            topicQueue: this.topicQueue ? this.topicQueue.export() : null,
            goalCurator: this.goalCurator ? this.goalCurator.export() : null,
            guidedMissionPlan: this.guidedMissionPlan || null,
            completionTracker: this.completionTracker || null,
            lastSummarization: this.lastSummarization
          };
          await this.crashRecovery.saveCheckpoint(checkpointState, this.cycleCount);
```
Serialized through one `JSON.stringify(checkpointData, null, 2)` at crash-recovery-manager.js:108 and read back with one `JSON.parse(data)` at crash-recovery-manager.js:150-151 — full graph + embeddings duplicated to disk every 5 cycles, and the read side hits the same V8 string limits on large brains.

Donors verified: /Users/jtr/_JTR23_/release/home23/engine/src/core/crash-recovery-manager.js:63-89 (both-artifact detection loop over ['state.json.gz','state.json']), 114-166 (deep-streaming checkpoint writer), 405-416 (stream sha256); /Users/jtr/_JTR23_/release/home23/engine/src/core/orchestrator.js:390-429 (always-loadState + strictly-fresher scalar overlay), 3871-3903 (scalar-only checkpoint with memorySummary counts + recoverySource marker).

## CHANGE: cosmo23/engine/src/core/crash-recovery-manager.js

Fix (a): detectCrash() checks both state artifacts ['state.json.gz','state.json'] before classifying as first run (direct port of donor engine/src/core/crash-recovery-manager.js:63-89). Replace the catch block of detectCrash() at lines 63-81.

### Anchor
```
    } catch (error) {
      // File doesn't exist = previous shutdown was clean OR first run
      // Check if state.json exists to differentiate
      const statePath = path.join(this.logsDir, 'state.json');
      try {
        await fs.access(statePath);
        // State exists but no clean marker = crash
        return true;
      } catch (error) {
        // No state file = first run
        return false;
      }
    }
  }
```

### Code
```js
    } catch (error) {
      // File doesn't exist = previous shutdown was clean OR first run
      // Check if a persisted state artifact exists to differentiate. The
      // engine saves the real runtime state as state.json.gz; older runs
      // (and some tests) may still have a plain state.json.
      const stateArtifacts = [
        path.join(this.logsDir, 'state.json.gz'),
        path.join(this.logsDir, 'state.json'),
      ];
      for (const statePath of stateArtifacts) {
        try {
          await fs.access(statePath);
          // State exists but no clean marker = crash
          return true;
        } catch (accessError) {
          // Try the next known state artifact
        }
      }
      // No state file = first run
      return false;
    }
  }
```

## CHANGE: cosmo23/engine/src/core/crash-recovery-manager.js

Keep checkpoint audit artifacts truthful once checkpoints are scalar-only: state_snapshot node/edge counts read the new memorySummary first, falling back to legacy full-graph arrays. Edit inside generateAuditArtifact() at lines 340-343.

### Anchor
```
        state_snapshot: {
          cycleCount: state.cycleCount || 0,
          memoryNodes: state.memory?.nodes?.length || 0,
          memoryEdges: state.memory?.edges?.length || 0,
```

### Code
```js
        state_snapshot: {
          cycleCount: state.cycleCount || 0,
          // Scalar checkpoints carry counts in memorySummary; legacy
          // full-graph checkpoints carried the arrays themselves.
          memoryNodes: state.memorySummary?.nodes ?? (state.memory?.nodes?.length || 0),
          memoryEdges: state.memorySummary?.edges ?? (state.memory?.edges?.length || 0),
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Add two new methods to the Orchestrator class, inserted immediately BEFORE the `async initialize()` doc comment at line 439 (`async initialize() {` is unique in the file, verified by grep). restoreFromPersistence() is the recovery+hydration path (contract #6); buildCheckpointState() is the scalar-only checkpoint payload. Extracted as methods so tests can drive them via Orchestrator.prototype.<method>.call(stub). The code below is the full insertion INCLUDING the existing initialize() opening lines it attaches to — the anchor text is replaced by this block.

### Anchor
```
  /**
   * Initialize
   */
  async initialize() {
```

### Code
```js
  /**
   * Restore persisted state at startup.
   *
   * loadState() ALWAYS runs — state.json.gz is the only memory source. When
   * a crash was detected, the recovered checkpoint is applied strictly as a
   * scalar overlay (cycleCount, journal, lastSummarization,
   * guidedMissionPlan, completionTracker) and only when fresher than what
   * loadState() restored. Checkpoint memory payloads (legacy full-graph
   * checkpoints) are deliberately ignored — hydrating memory from a
   * checkpoint is the memory=0 bug class.
   */
  async restoreFromPersistence() {
    let recoveredState = null;
    if (this.crashRecovery.crashDetected) {
      this.logger.warn('🔄 Crash detected, attempting recovery from checkpoint...');
      recoveredState = await this.crashRecovery.recover();
      if (recoveredState) {
        this.logger.info('✅ Checkpoint scalars recovered — loading full brain from state file next');
      } else {
        this.logger.warn('⚠️  No checkpoint available, loading from state file only');
      }
    }

    // ALWAYS hydrate from the persisted state file. Skipping loadState() on
    // checkpoint recovery boots with memory=0.
    await this.loadState();

    if (!recoveredState) {
      return;
    }

    const checkpointIsFresher =
      typeof recoveredState.cycleCount === 'number' &&
      recoveredState.cycleCount > (this.cycleCount || 0);

    // Scalar overlay — only when strictly fresher than what loadState()
    // just restored. Never regress backward.
    if (checkpointIsFresher) {
      this.cycleCount = recoveredState.cycleCount;
    }
    if (Array.isArray(recoveredState.journal) &&
        recoveredState.journal.length > (this.journal?.length || 0)) {
      this.journal = recoveredState.journal;
    }
    if (typeof recoveredState.lastSummarization === 'number' &&
        recoveredState.lastSummarization > (this.lastSummarization || 0)) {
      this.lastSummarization = recoveredState.lastSummarization;
    }

    // Guided plan + completion tracker are small JSON payloads; restore them
    // when the checkpoint is fresher or loadState() left them empty. This
    // preserves the original fix preventing plan recreation on restart.
    if (recoveredState.guidedMissionPlan && (checkpointIsFresher || !this.guidedMissionPlan)) {
      this.guidedMissionPlan = recoveredState.guidedMissionPlan.plan || recoveredState.guidedMissionPlan;
      this.logger.info('✅ Guided mission plan restored from checkpoint', {
        phaseCount: this.guidedMissionPlan?.taskPhases?.length || this.guidedMissionPlan?.phases?.length || 0
      });
    }
    if (recoveredState.completionTracker && (checkpointIsFresher || !this.completionTracker)) {
      this.completionTracker = recoveredState.completionTracker;
    }

    if (recoveredState.memory) {
      // Legacy full-graph checkpoint — its memory payload is NOT applied.
      this.logger.warn('⚠️  Legacy checkpoint carried a memory payload — ignored (checkpoints are scalar overlays only)', {
        checkpointNodes: Array.isArray(recoveredState.memory.nodes) ? recoveredState.memory.nodes.length : 0,
        loadedNodes: this.memory?.nodes?.size || 0
      });
    }
  }

  /**
   * Build the crash-recovery checkpoint payload — SCALARS ONLY.
   *
   * The authoritative brain (memory graph + embeddings) is persisted every
   * cycle by saveState() into state.json.gz; checkpoints exist so a crashed
   * run can resume at the right cycle with its guided plan intact. They must
   * NEVER carry the graph: recovery applies them only as a scalar overlay
   * (see restoreFromPersistence()), and full-graph checkpoints were the
   * multi-hundred-MB JSON.stringify-every-5-cycles bug.
   */
  buildCheckpointState() {
    return {
      cycleCount: this.cycleCount,
      journal: this.journal.slice(-100),
      lastSummarization: this.lastSummarization,
      guidedMissionPlan: this.guidedMissionPlan || null,
      completionTracker: this.completionTracker || null,
      savedAt: new Date().toISOString(),
      recoverySource: 'state.json.gz',
      memorySummary: {
        nodes: this.memory?.nodes?.size || 0,
        edges: this.memory?.edges?.size || 0,
        clusters: this.memory?.clusters?.size || 0
      }
    };
  }

  /**
   * Initialize
   */
  async initialize() {
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Fix (b): replace the branching recovery block in initialize() (current lines 457-486, i.e. everything from the `// Phase A: Attempt recovery if crash detected` comment through the closing `} else { await this.loadState(); }`) with a single call to restoreFromPersistence(). loadState() now ALWAYS runs; a recovered checkpoint is only a scalar overlay. NOTE: the `await this.crashRecovery.initialize();` line directly above stays unchanged; nearby blank lines 453/456 carry 4 trailing spaces — match the anchor starting at the comment line.

### Anchor
```
    // Phase A: Attempt recovery if crash detected
    if (this.crashRecovery.crashDetected) {
      this.logger.warn('🔄 Crash detected, attempting recovery from checkpoint...');
      const recoveredState = await this.crashRecovery.recover();
      if (recoveredState) {
        this.logger.info('✅ State recovered from checkpoint');
        // Import recovered state
        this.cycleCount = recoveredState.cycleCount || 0;
        this.journal = recoveredState.journal || [];
        this.lastSummarization = recoveredState.lastSummarization || 0;

        // FIX: Import guidedMissionPlan to prevent plan recreation on restart
        if (recoveredState.guidedMissionPlan) {
          this.guidedMissionPlan = recoveredState.guidedMissionPlan.plan || recoveredState.guidedMissionPlan;
          this.logger.info('✅ Guided mission plan restored from checkpoint', {
            phaseCount: this.guidedMissionPlan?.taskPhases?.length || this.guidedMissionPlan?.phases?.length || 0
          });
        }

        // FIX: Import completionTracker to preserve progress tracking
        if (recoveredState.completionTracker) {
          this.completionTracker = recoveredState.completionTracker;
        }
      } else {
        this.logger.warn('⚠️  No checkpoint available, loading from state file');
        await this.loadState();
      }
    } else {
      await this.loadState();
    }
```

### Code
```js
    // Phase A: Attempt recovery if crash detected.
    // loadState() ALWAYS runs — a recovered checkpoint is applied only as a
    // scalar overlay, never as a memory source (see restoreFromPersistence).
    await this.restoreFromPersistence();
```

## CHANGE: cosmo23/engine/src/core/orchestrator.js

Fix (c): replace the full-graph checkpointState assembly in executeCycle (current lines 3226-3244) with the scalar-only builder. The surrounding `if (this.cycleCount % 5 === 0) { try {` / catch scaffolding stays unchanged. The exact line `const checkpointState = this.buildCheckpointState();` must be kept verbatim — the test suite asserts this wiring at source level.

### Anchor
```
          // Build checkpoint state (same structure as saveState())
          const checkpointState = {
            cycleCount: this.cycleCount,
            journal: this.journal.slice(-100),
            memory: this.memory.exportGraph(),
            goals: this.goals.export(),
            roles: this.roles.getRoles(),
            reflection: this.reflection.export(),
            oscillator: this.oscillator.getStats(),
            coordinator: this.coordinator ? this.coordinator.export() : null,
            agentExecutor: this.agentExecutor ? this.agentExecutor.exportState() : null,
            forkSystem: this.forkSystem ? this.forkSystem.export() : null,
            topicQueue: this.topicQueue ? this.topicQueue.export() : null,
            goalCurator: this.goalCurator ? this.goalCurator.export() : null,
            guidedMissionPlan: this.guidedMissionPlan || null,
            completionTracker: this.completionTracker || null,
            lastSummarization: this.lastSummarization
          };
          await this.crashRecovery.saveCheckpoint(checkpointState, this.cycleCount);
```

### Code
```js
          // Build checkpoint state — SCALARS ONLY (checkpoints are a scalar
          // overlay for recovery, never a memory source). The full brain is
          // already persisted every cycle by saveState() → state.json.gz;
          // serializing memory.exportGraph() here through JSON.stringify was
          // the multi-hundred-MB checkpoint bug.
          const checkpointState = this.buildCheckpointState();
          await this.crashRecovery.saveCheckpoint(checkpointState, this.cycleCount);
```

## CHANGE: package.json

Register the new test file in the cosmo23 node --test chain (contract #7; enforced pattern). Insert immediately after cluster-snapshot-merger-parity.test.cjs in the second `node --test` segment of scripts.test.

### Anchor
```
tests/cosmo23/cluster-snapshot-merger-parity.test.cjs tests/cosmo23/legacy-query-operation-adapter.test.cjs
```

### Code
```js
tests/cosmo23/cluster-snapshot-merger-parity.test.cjs tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs tests/cosmo23/legacy-query-operation-adapter.test.cjs
```

## CHANGE: tests/cosmo23/package-test-registration.test.cjs

Add the new suite to the exactly-once registration enforcement list so future edits to scripts.test can't silently drop it.

### Anchor
```
    'tests/cosmo23/cluster-snapshot-merger-parity.test.cjs',
```

### Code
```js
    'tests/cosmo23/cluster-snapshot-merger-parity.test.cjs',
    'tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs',
```

## TEST FILE: tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs

```js
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

```

## API NOTES

VERIFIED, NOT SPECULATIVE: all proposed code was applied to the real tree, the new suite passed 9/9 (`node --test --test-concurrency=1 tests/cosmo23/crash-recovery-scalar-checkpoints.test.cjs`), and the vendored engine's own suites stayed green (cosmo23/engine: `npx mocha tests/unit/crash-recovery-manager.test.js` 13 pass; `npx mocha tests/single-instance/crash-recovery.test.js` 8 pass). Edits were then reverted so the implementer applies them from this plan.

Donor-vs-target decisions:
1. Donor's deep-streaming checkpoint writer (home23 crash-recovery-manager.js:114-166) and stream-sha256 hasher (:405-416) are NOT ported — YAGNI. That machinery exists only because home23 once wrote 346MB full-graph checkpoints; after fix (c) cosmo23 checkpoints are KB-scale scalars, so the existing simple atomic write (JSON.stringify + tmp/rename, cosmo23 crash-recovery-manager.js:106-109) and readFile-based hash are correct and simpler.
2. Donor's recover() also clears `this.crashDetected = false` after successful recovery (home23 orchestrator's Good Life layer treats the flag as an active condition). Not ported — cosmo23 has no Good Life; getStats().crashDetected semantics unchanged.
3. Overlay policy: cycleCount/journal/lastSummarization use donor's strictly-fresher rule. guidedMissionPlan/completionTracker (required by contract #6's overlay set) apply when the checkpoint is fresher OR loadState() left them empty — cosmo23's loadState already restores both from the state file (orchestrator.js:8716-8718), so this preserves the original "prevent plan recreation on restart" fix without letting a stale checkpoint clobber a fresher state-file plan. Note: donor checkpoints store only plan/tracker COUNT summaries; cosmo23 keeps the full (small) objects because its overlay must be able to restore them.

Composition with other Phase-1 fixes: restoreFromPersistence() awaits this.loadState() unconditionally and adds no try/catch — when the loadState fix lands (contract #3 streaming hydration via cosmo23/lib/memory-sidecar.js + contract #4 BRAIN_LOAD_EMPTY throw), the fail-loud error propagates out of initialize() as required. Contract #1 (saveState structured result) and #5 (shutdown) are untouched by this fix; saveCheckpoint remains fire-and-forget non-fatal. An untracked sibling-fix file `cosmo23/engine/src/core/state-hydration.js` appeared in the worktree during this session — none of these anchors collide with it.

Wiring constraints: keep the exact source lines `await this.restoreFromPersistence();` and `const checkpointState = this.buildCheckpointState();` — the test suite asserts them at source level. Anchor gotchas: in orchestrator.js initialize(), blank lines 453/456 carry 4 trailing spaces; anchors above start at grep-unique comment lines (`// Phase A: Attempt recovery if crash detected` and `// Build checkpoint state (same structure as saveState())`, both single-occurrence, verified). `async initialize() {` occurs exactly once in orchestrator.js.

Legacy checkpoints already on disk: they still parse; their memory payload is ignored with an emoji-prefixed warn (`⚠️  Legacy checkpoint carried a memory payload — ignored...`). One caveat: the FIRST restart after upgrade may still JSON.parse an old multi-hundred-MB checkpoint inside recover() (slow, and on the largest brains potentially the same V8 string limit on read). It self-heals — cleanupOldCheckpoints rotates legacy files out after 3 new scalar checkpoints — but for jerry-scale brains the implementer may want to delete `<logsDir>/checkpoints/checkpoint-*.json` once during deploy.

memorySummary reads `this.memory.nodes.size` / `.edges.size` / `.clusters.size` (NetworkMemory Maps — confirmed by loadState's `.clear()`/`.set()` usage); `exportGraph()` is never called on the checkpoint path and the test enforces that with a throwing trap. Audit artifacts stay truthful via the memorySummary-first fallback in generateAuditArtifact. New checkpoint payload keys: cycleCount, journal(<=100), lastSummarization, guidedMissionPlan, completionTracker, savedAt (ISO), recoverySource ('state.json.gz' — cosmo23 has no JSONL sidecar mirror of home23's 'state.json.gz+sidecars' marker), memorySummary {nodes, edges, clusters}.
