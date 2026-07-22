'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { maybeBackupBrain, listBackups } = require('../../cosmo23/engine/src/core/brain-backups');
const { persistResearchState } = require('../../cosmo23/lib/memory-sidecar');

const silentLogger = { info() {}, warn() {}, error() {} };
const HOUR = 60 * 60 * 1000;

async function makeFixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo23-brain-backups-'));
  const runDir = path.join(root, 'run');
  const lockRoot = path.join(root, 'locks');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(lockRoot, { recursive: true });
  t.after(() => fsp.rm(root, { recursive: true, force: true }));

  // Persist a real manifest generation so the backup set includes the
  // active base sidecars the manifest references.
  const graph = {
    nodes: [{ id: 1, concept: 'backup me', embedding: [0.1, 0.9], weight: 1 }],
    edges: [],
    clusters: [],
    nextNodeId: 2,
    nextClusterId: 1,
  };
  const statePath = path.join(runDir, 'state.json');
  const outcome = await persistResearchState(runDir, { cycleCount: 3, memory: graph }, {
    lockRoot,
    saveState: async (captured) => {
      await fsp.writeFile(`${statePath}.gz`, zlib.gzipSync(JSON.stringify(captured)));
      return { compressed: true, size: 1 };
    },
  });
  assert.equal(outcome.degraded, false, 'fixture manifest commit must succeed');
  await fsp.writeFile(path.join(runDir, 'brain-snapshot.json'), JSON.stringify({
    nodes: 1, edges: 0, savedAt: new Date().toISOString(), generation: outcome.revision,
    nodeCount: 1, edgeCount: 0,
  }));
  return { runDir, lockRoot };
}

test('first backup copies the coherent artifact set into a timestamped dir', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const result = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: Date.now() });

  assert.equal(result.created, true);
  const backups = listBackups(runDir);
  assert.equal(backups.length, 1);
  const contents = fs.readdirSync(backups[0].path, { recursive: true }).map(String);
  assert.equal(contents.includes('state.json.gz'), true);
  assert.equal(contents.includes('memory-manifest.json'), true);
  assert.equal(contents.includes('brain-snapshot.json'), true);

  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'memory-manifest.json'), 'utf8'));
  const baseNodesFile = manifest.activeBase.nodes.file;
  assert.equal(
    fs.existsSync(path.join(backups[0].path, baseNodesFile)), true,
    `active base nodes file ${baseNodesFile} must be in the backup`,
  );
  assert.equal(fs.existsSync(backups[0].path + '.tmp'), false, 'tmp staging dir must be renamed away');
});

test('a second backup within the interval is skipped', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const now = Date.now();
  const first = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now });
  assert.equal(first.created, true);

  const second = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: now + HOUR });
  assert.equal(second.created, false);
  assert.equal(second.skipped, 'interval');
  assert.equal(listBackups(runDir).length, 1);
});

test('backups past the interval rotate down to the retention count', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const now = Date.now();

  const r1 = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now });
  const r2 = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: now + 7 * HOUR });
  const r3 = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: now + 14 * HOUR });
  assert.equal(r1.created && r2.created && r3.created, true, 'interval-passed backups must all be created');
  assert.equal(r3.rotated, 1, 'third backup must rotate the oldest out');

  const names = listBackups(runDir).map(({ name }) => name);
  assert.equal(names.length, 2, 'retention default keeps 2');
  assert.equal(names.includes(path.basename(r1.path)), false, 'oldest backup must be gone');
});

test('low free disk skips the backup instead of filling the volume', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const result = await maybeBackupBrain(runDir, {
    lockRoot, logger: silentLogger, now: Date.now(),
    minFreeBytes: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(result.created, false);
  assert.equal(result.skipped, 'low_disk');
  assert.equal(listBackups(runDir).length, 0);
});

test('a dir with no state artifacts fails cleanly with no tmp leftovers', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo23-brain-backups-empty-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  // Same layout as makeFixture: the run dir and lock root are siblings —
  // the memory-source lock structurally rejects a lock root INSIDE the
  // locked target ('lock root must be outside target').
  const runDir = path.join(root, 'run');
  const lockRoot = path.join(root, 'locks');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(lockRoot, { recursive: true });

  const result = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: Date.now() });
  assert.equal(result.created, false);
  assert.match(result.error, /no state artifacts/);
  const leftovers = fs.readdirSync(path.join(runDir, 'backups')).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, [], 'failed backup must clean its tmp staging dir');
});

test('low free disk accounts for the projected copy size, not just the floor', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  // free (10) clears the bare floor (5) but cannot hold the copy set too:
  // the skip must come from the size-aware in-lock check and report the
  // projected bytes it computed.
  const result = await maybeBackupBrain(runDir, {
    lockRoot, logger: silentLogger, now: Date.now(),
    minFreeBytes: 5,
    freeBytesOverride: 10,
  });
  assert.equal(result.created, false);
  assert.equal(result.skipped, 'low_disk');
  assert.equal(result.freeBytes, 10);
  assert.equal(
    Number.isSafeInteger(result.projectedBytes) && result.projectedBytes > 0, true,
    'size-aware skip must report the projected copy size',
  );
  assert.equal(listBackups(runDir).length, 0);
});

test('stale kill-9 orphaned tmp staging dirs are swept; fresh ones survive', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const backupsDir = path.join(runDir, 'backups');
  const stale = path.join(backupsDir, 'backup-stale.tmp');
  const fresh = path.join(backupsDir, 'backup-fresh.tmp');
  await fsp.mkdir(stale, { recursive: true });
  await fsp.mkdir(fresh, { recursive: true });
  const oldTime = new Date(Date.now() - 2 * HOUR);
  fs.utimesSync(stale, oldTime, oldTime);

  const result = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: Date.now() });
  assert.equal(result.created, true);
  assert.equal(result.sweptTmp, 1, 'exactly the stale tmp dir must be swept');
  assert.equal(fs.existsSync(stale), false, 'stale orphaned tmp dir must be removed');
  assert.equal(fs.existsSync(fresh), true, 'fresh tmp dir may belong to a live copy and must survive');
});

test('manifest file entries with path traversal are ignored, not copied', async (t) => {
  const { runDir, lockRoot } = await makeFixture(t);
  const manifestPath = path.join(runDir, 'memory-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.activeDelta.file = '../evil.jsonl';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  await fsp.writeFile(path.join(path.dirname(runDir), 'evil.jsonl'), 'evil');

  const result = await maybeBackupBrain(runDir, { lockRoot, logger: silentLogger, now: Date.now() });
  assert.equal(result.created, true, 'backup must still succeed without the bad entry');
  const backups = listBackups(runDir);
  assert.equal(backups.length, 1);
  const contents = fs.readdirSync(backups[0].path, { recursive: true }).map(String);
  assert.equal(contents.some((name) => name.includes('evil')), false,
    'traversal entry must not be copied into the backup');
  assert.equal(fs.existsSync(path.join(runDir, 'backups', 'evil.jsonl')), false,
    'traversal must not write outside the staging dir');
});

// --- shutdown-await coverage (live-proof finding 2026-07-22: the only save on
// short guided runs is the shutdown save, so a purely fire-and-forget backup
// dies with the process ~10ms later and never lands) ---

const { Orchestrator } = require('../../cosmo23/engine/src/core/orchestrator');

test('_saveStateUnlocked stashes the backup promise for shutdown to await', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cosmo23-backup-stash-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, 'run');
  const lockRoot = path.join(root, 'locks');
  await fsp.mkdir(runDir, { recursive: true });
  await fsp.mkdir(lockRoot, { recursive: true });

  const graph = {
    nodes: [{ id: 1, concept: 'stash me', embedding: [0.2, 0.8], weight: 1 }],
    edges: [], clusters: [], nextNodeId: 2, nextClusterId: 1,
  };
  const fake = {
    evaluation: null,
    cycleCount: 1,
    journal: [],
    memory: { exportGraph: () => graph },
    goals: { export: () => [], goals: new Map(), completedGoals: [] },
    roles: { getRoles: () => [] },
    reflection: { export: () => ({}) },
    oscillator: { getStats: () => ({}) },
    stateModulator: { getState: () => ({}) },
    temporal: null, coordinator: null, agentExecutor: null, forkSystem: null,
    topicQueue: null, goalCurator: null, executiveRing: null,
    guidedMissionPlan: null, completionTracker: null, planProgressEvents: [],
    lastSummarization: 0, reasoningHistory: [], webSearchCount: 0,
    goalAllocator: null, clusterSync: null, clusterCoordinator: null,
    sessionNumber: 0, logsDir: runDir,
    logger: silentLogger,
    config: { memorySource: { lockRoot } },
    generateSessionSummary: () => ({ cycleCount: 1 }),
    getProgressMarkers: () => [],
    writeProgressFile: async () => {},
    _saveStatePromise: null,
  };

  const result = await Orchestrator.prototype._saveStateUnlocked.call(fake);
  assert.equal(result.saved, true);
  assert.ok(fake._backupPromise && typeof fake._backupPromise.then === 'function',
    'successful save must stash the backup promise on this._backupPromise');
  const backupOutcome = await fake._backupPromise;
  assert.equal(backupOutcome.created, true, 'stashed promise resolves to the backup result');
  assert.equal(listBackups(runDir).length, 1);
});

test('awaitPendingBackupForShutdown awaits a pending backup and is bounded', async () => {
  const logs = [];
  const logger = { info(m, f) { logs.push(m); }, warn(m, f) { logs.push(m); }, error() {} };

  // No pending backup: no-op.
  const idle = { logger, config: {}, _backupPromise: null };
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(idle);

  // Pending backup that resolves quickly: awaited to completion.
  let settled = false;
  const quick = {
    logger, config: {},
    _backupPromise: new Promise((resolve) => setTimeout(() => {
      settled = true;
      resolve({ created: true, path: '/tmp/x', rotated: 0 });
    }, 30)),
  };
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(quick);
  assert.equal(settled, true, 'shutdown must wait for a fast in-flight backup');

  // Hung backup: bounded by shutdownBackupTimeoutMs, never blocks shutdown.
  const hung = {
    logger,
    config: { shutdownBackupTimeoutMs: 40 },
    _backupPromise: new Promise(() => {}),
  };
  const started = Date.now();
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(hung);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, `bounded wait must not hang (took ${elapsed}ms)`);
});

test('awaitPendingBackupForShutdown caps its bound at the remaining shutdown budget', async () => {
  // Phase-1 polish (a): with a handler-stamped deadline nearly exhausted,
  // the backup wait shrinks to the 1s floor instead of its 4s config —
  // the sum of shutdown steps must stay inside the hard-kill budget.
  const hung = {
    logger: silentLogger,
    config: { shutdownBackupTimeoutMs: 4000 },
    shutdownDeadline: Date.now() + 50, // almost no budget left → 1s floor
    _backupPromise: new Promise(() => {}),
  };
  const started = Date.now();
  await Orchestrator.prototype.awaitPendingBackupForShutdown.call(hung);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2500,
    `deadline-capped wait must fire near the 1s floor, not the 4s config (took ${elapsed}ms)`);
});
