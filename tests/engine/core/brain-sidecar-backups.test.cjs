'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { gzipSync } = require('node:zlib');
const { withCommunityBackup, MANIFEST } = require('../../../engine/src/core/brain-sidecar-backups.js');
const { writeMemorySidecars } = require('../../../engine/src/core/memory-sidecar');
const { openMemorySource } = require('../../../shared/memory-source');

async function fixture(t, { linked = false, residentId = 'jerry' } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'community-backup-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const brainDir = path.join(root, residentId, 'brain');
  await fs.mkdir(brainDir, { recursive: true });
  await fs.writeFile(path.join(brainDir, 'brain-snapshot.json'), JSON.stringify({ format: 'fixture' }));
  await fs.writeFile(path.join(brainDir, 'state.json.gz'), gzipSync('{"state":true}'));
  await fs.writeFile(path.join(brainDir, 'memory-nodes.jsonl.gz'), gzipSync('{"id":"one"}\n'));
  await fs.writeFile(path.join(brainDir, 'memory-edges.jsonl.gz'), gzipSync(''));
  const backups = linked ? path.join(root, 'external-backups') : path.join(brainDir, 'backups');
  await fs.mkdir(backups);
  if (linked) await fs.symlink(backups, path.join(brainDir, 'backups'));
  const options = { brainDir, residentId, operation: async () => ({ applied: true }), inspectOpenFiles: async () => [] };
  return { root, brainDir, backups, options };
}
async function snapshot(f, date, extra = {}) {
  return withCommunityBackup({ ...f.options, now: new Date(date), ...extra });
}
async function dirs(f) {
  return (await fs.readdir(f.backups)).filter((n) => n.endsWith('-brain-communities') && !n.startsWith('.'));
}
async function manifest(result) { return JSON.parse(await fs.readFile(result.backup.manifest, 'utf8')); }
async function exists(p) { return fs.lstat(p).then(() => true, () => false); }

test('publishes a verified complete copy before mutation and marks successful operation', async (t) => {
  const f = await fixture(t);
  const result = await snapshot(f, '2026-01-01', { operation: async (backup) => {
    const m = JSON.parse(await fs.readFile(backup.manifest, 'utf8'));
    assert.equal(m.status, 'complete');
    assert.equal(m.operation.status, 'pending');
    assert.equal(m.files.length, 4);
    assert.ok(m.files.every((row) => /^[a-f0-9]{64}$/.test(row.sha256)));
    assert.deepEqual(await fs.readFile(path.join(backup.path, 'state.json.gz')), await fs.readFile(path.join(f.brainDir, 'state.json.gz')));
    return 'applied';
  } });
  assert.equal(result.value, 'applied');
  assert.equal((await manifest(result)).operation.status, 'succeeded');
  assert.equal(await exists(path.join(f.backups, '.community-backup.lock')), false);
});

test('newest seven and four older weekly anchors are retained; deletion receipts survive', async (t) => {
  const f = await fixture(t);
  for (let day = 0; day < 45; day++) await snapshot(f, new Date(Date.UTC(2026, 0, day + 1)));
  const remaining = await dirs(f);
  assert.equal(remaining.length, 11);
  for (let day = 38; day < 45; day++) {
    const prefix = new Date(Date.UTC(2026, 0, day + 1)).toISOString().slice(0, 10);
    assert.ok(remaining.some((name) => name.startsWith(prefix)), prefix);
  }
  const receipts = (await fs.readdir(path.join(f.backups, '.community-retention-receipts'))).filter((name) => !name.endsWith('.complete.json'));
  assert.ok(receipts.length >= 30);
  const receipt = JSON.parse(await fs.readFile(path.join(f.backups, '.community-retention-receipts', receipts[0]), 'utf8'));
  assert.equal(receipt.status, 'removed');
  assert.equal(receipt.manifest.operation.status, 'succeeded');
});

test('failed mutation preserves snapshot and does not prune previous recoveries', async (t) => {
  const f = await fixture(t);
  const old = await snapshot(f, '2026-01-01');
  await assert.rejects(snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0, operation: async () => { throw new Error('save failed'); } }), /save failed/);
  assert.equal(await exists(old.backup.path), true);
  const names = await dirs(f);
  assert.equal(names.length, 2);
  const newest = names.find((name) => name.startsWith('2026-02-01'));
  const m = JSON.parse(await fs.readFile(path.join(f.backups, newest, MANIFEST), 'utf8'));
  assert.equal(m.operation.status, 'failed');
  const success = await snapshot(f, '2026-03-01', { keepRecent: 1, keepWeekly: 0 });
  assert.equal(await exists(path.join(f.backups, newest)), true);
  assert.equal(await exists(success.backup.path), true);
});

test('legacy, in-progress, pinned and other cleanup reasons remain untouched', async (t) => {
  const f = await fixture(t);
  const legacy = path.join(f.backups, '2025-01-01T00-00-00-000Z-brain-communities');
  const temporary = path.join(f.backups, '.tmp-interrupted-brain-communities');
  const other = path.join(f.backups, '2025-01-01-brain-cleanup-preamble');
  for (const p of [legacy, temporary, other]) { await fs.mkdir(p); await fs.writeFile(path.join(p, 'unique.txt'), 'keep'); }
  const pinned = await snapshot(f, '2026-01-01');
  await fs.writeFile(path.join(pinned.backup.path, '.retention-pin'), 'incident hold');
  await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0 });
  for (const p of [legacy, temporary, other, pinned.backup.path]) assert.equal(await exists(p), true);
});

test('edited or replaced payloads and extra content are preserved', async (t) => {
  const f = await fixture(t);
  const changed = await snapshot(f, '2026-01-01');
  await fs.writeFile(path.join(changed.backup.path, 'brain-snapshot.json'), '{"edited":true}');
  const extra = await snapshot(f, '2026-01-02');
  await fs.writeFile(path.join(extra.backup.path, 'notes.txt'), 'unique evidence');
  const editedManifest = await snapshot(f, '2026-01-03');
  const receipt = await manifest(editedManifest);
  receipt.createdAt = '2025-01-01T00:00:00.000Z';
  await fs.writeFile(editedManifest.backup.manifest, JSON.stringify(receipt));
  await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0 });
  assert.equal(await exists(changed.backup.path), true);
  assert.equal(await exists(extra.backup.path), true);
  assert.equal(await exists(editedManifest.backup.path), true);
});

test('owned backup-root symlinks work without following links within snapshots', async (t) => {
  const f = await fixture(t, { linked: true });
  const old = await snapshot(f, '2026-01-01');
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'keep.txt'), 'keep');
  await fs.symlink(outside, path.join(old.backup.path, 'nested-link'));
  const current = await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0 });
  assert.ok(current.backup.path.startsWith(await fs.realpath(f.backups)));
  assert.equal(await exists(old.backup.path), true);
  assert.equal(await fs.readFile(path.join(outside, 'keep.txt'), 'utf8'), 'keep');
});

test('concurrent operations refuse the root lock and unique names avoid timestamp collision', async (t) => {
  const f = await fixture(t);
  let enter, release;
  const entered = new Promise((resolve) => { enter = resolve; });
  const held = new Promise((resolve) => { release = resolve; });
  const first = snapshot(f, '2026-01-01', { operation: async () => { enter(); await held; } });
  await entered;
  await assert.rejects(snapshot(f, '2026-01-01'), /community_backup_locked/);
  release();
  const result = await first;
  const second = await snapshot(f, '2026-01-01');
  assert.notEqual(result.backup.path, second.backup.path);
});

test('missing, corrupt or linked sidecars fail before mutation and preserve failed staging', async (t) => {
  const f = await fixture(t);
  let applied = false;
  await fs.writeFile(path.join(f.brainDir, 'state.json.gz'), 'not gzip');
  await assert.rejects(snapshot(f, '2026-01-01', { operation: async () => { applied = true; } }));
  assert.equal(applied, false);
  assert.ok((await fs.readdir(f.backups)).some((n) => n.startsWith('.tmp-')));
  await fs.rm(path.join(f.brainDir, 'state.json.gz'));
  await assert.rejects(snapshot(f, '2026-01-02'), /missing-source:state/);
  await fs.symlink(path.join(f.brainDir, 'memory-nodes.jsonl.gz'), path.join(f.brainDir, 'state.json.gz'));
  await assert.rejects(snapshot(f, '2026-01-03'), /missing-source:state/);
});

test('changed root target during operation prevents pruning and keeps old root lock for inspection', async (t) => {
  const f = await fixture(t, { linked: true });
  const old = await snapshot(f, '2026-01-01');
  const replacement = path.join(f.root, 'replacement'); await fs.mkdir(replacement);
  const result = await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0, operation: async () => {
    await fs.unlink(path.join(f.brainDir, 'backups'));
    await fs.symlink(replacement, path.join(f.brainDir, 'backups'));
    return 'saved';
  } });
  assert.equal(result.value, 'saved');
  assert.ok(result.backup.retention.errors.some((error) => error.includes('root_changed')));
  assert.equal(await exists(old.backup.path), true);
  assert.equal(await exists(path.join(f.backups, '.community-backup.lock')), true);
});

test('manifest generation is copied portably and opens as a complete recovery source', async (t) => {
  const f = await fixture(t);
  const sidecars = await writeMemorySidecars(f.brainDir, {
    nodes: [{ id: 'native-one', concept: 'recovery fixture' }], edges: [],
  });
  const result = await snapshot(f, '2026-01-01');
  const m = await manifest(result);
  assert.equal(m.source, 'memory-manifest');
  assert.ok(m.files.some((r) => r.name === sidecars.manifest.activeBase.nodes.file));
  assert.ok(m.files.some((r) => r.name === sidecars.manifest.activeDelta.file));
  assert.ok(!m.files.some((r) => r.name === 'memory-nodes.jsonl.gz'));
  const portable = JSON.parse(await fs.readFile(path.join(result.backup.path, 'memory-manifest.json'), 'utf8'));
  assert.equal(Object.hasOwn(portable.activeDelta, 'fileIdentity'), false);
  assert.equal(Object.hasOwn(portable.activeDelta, 'appendFrom'), false);
  assert.deepEqual(portable.ann, { indexFile: null, metaFile: null, builtFromRevision: null });
  const recovered = await openMemorySource(result.backup.path);
  try {
    assert.equal(recovered.getEvidence().sourceHealth, 'healthy');
    assert.deepEqual(await recovered.summarize(), { nodes: 1, edges: 0, clusters: 0 });
    const found = await recovered.searchKeyword({ query: 'recovery fixture', topK: 3 });
    assert.deepEqual(found.results.map((node) => node.id), ['native-one']);
  } finally { await recovered.close(); }
});

test('insufficient free space and missing legacy graph files fail before copying or mutation', async (t) => {
  const f = await fixture(t);
  let applied = false;
  await assert.rejects(snapshot(f, '2026-01-01', {
    availableBytes: async () => 0,
    operation: async () => { applied = true; },
  }), /insufficient_disk/);
  assert.equal(applied, false);
  assert.deepEqual(await fs.readdir(f.backups), []);
  await fs.unlink(path.join(f.brainDir, 'memory-edges.jsonl.gz'));
  await assert.rejects(snapshot(f, '2026-01-02'), /missing-source:memory-edges/);
  assert.deepEqual(await fs.readdir(f.backups), []);
});

test('retain-all policy and a pinned root prevent automatic expiry', async (t) => {
  const f = await fixture(t);
  const old = await snapshot(f, '2026-01-01');
  const current = await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0, retainAll: true });
  assert.equal(await exists(old.backup.path), true);
  assert.equal(current.backup.retention.retained[0].reason, 'retain-all policy');
  await fs.writeFile(path.join(f.backups, '.retention-pin'), 'incident hold');
  const pinned = await snapshot(f, '2026-03-01', { keepRecent: 1, keepWeekly: 0 });
  assert.equal(await exists(old.backup.path), true);
  assert.equal(await exists(current.backup.path), true);
  assert.equal(pinned.backup.retention.retained[0].reason, 'backup root pinned');
});

test('retention errors after successful operation do not report mutation failure', async (t) => {
  const f = await fixture(t);
  const old = await snapshot(f, '2026-01-01');
  await fs.writeFile(old.backup.manifest, '{bad json');
  const result = await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0 });
  assert.deepEqual(result.value, { applied: true });
  assert.ok(result.backup.retention.errors.length);
  assert.equal(await exists(old.backup.path), true);
});

test('active recovery reads and unavailable open-file discovery defer deletion', async (t) => {
  const f = await fixture(t);
  const old = await snapshot(f, '2026-01-01');
  const active = await snapshot(f, '2026-02-01', { keepRecent: 1, keepWeekly: 0, inspectOpenFiles: async () => [path.join(old.backup.path, 'state.json.gz')] });
  assert.equal(await exists(old.backup.path), true);
  assert.ok(active.backup.retention.retained.some((r) => r.reason === 'snapshot currently open'));
  const deferred = await snapshot(f, '2026-03-01', { keepRecent: 1, keepWeekly: 0, inspectOpenFiles: async () => { throw new Error('unavailable'); } });
  assert.ok(deferred.backup.retention.errors.some((e) => e.includes('no expiry')));
  assert.equal(await exists(old.backup.path), true);
  assert.equal(await exists(active.backup.path), true);
});
