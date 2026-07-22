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
