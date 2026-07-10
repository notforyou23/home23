const assert = require('node:assert/strict');
const fs = require('node:fs');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { BACKUP_FILES, maybeBackup } = require('../../../engine/src/core/brain-backups');
const { writeMemorySidecars } = require('../../../engine/src/core/memory-sidecar');

test('maybeBackup creates coherent snapshots without synchronous copy calls', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brain-backup-async-'));
  for (const file of BACKUP_FILES) {
    writeFileSync(path.join(dir, file), `${file}\n`);
  }

  const originalCopyFileSync = fs.copyFileSync;
  fs.copyFileSync = () => {
    throw new Error('sync copy should not be used for brain backups');
  };

  try {
    const result = await maybeBackup(dir, { force: true, retention: 2 });
    assert.equal(result.created, true);
    const backupPath = path.join(dir, 'backups', result.backupName);
    assert.equal(fs.existsSync(backupPath), true);
    for (const file of BACKUP_FILES) {
      assert.equal(fs.existsSync(path.join(backupPath, file)), true);
    }
  } finally {
    fs.copyFileSync = originalCopyFileSync;
  }
});

test('maybeBackup copies manifest-v1 active source files and writes backup manifest', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'brain-backup-manifest-'));
  writeFileSync(path.join(dir, 'state.json.gz'), 'state\n');
  writeFileSync(path.join(dir, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  const sidecars = await writeMemorySidecars(dir, {
    nodes: [{ id: 'n1', concept: 'manifest canary' }],
    edges: [],
  });

  const result = await maybeBackup(dir, { force: true, retention: 2 });
  assert.equal(result.created, true);
  const backupPath = path.join(dir, 'backups', result.backupName);
  for (const file of [
    'state.json.gz',
    'brain-snapshot.json',
    'memory-manifest.json',
    sidecars.manifest.activeBase.nodes.file,
    sidecars.manifest.activeBase.edges.file,
    sidecars.manifest.activeDelta.file,
    'backup-manifest.json',
  ]) {
    assert.equal(fs.existsSync(path.join(backupPath, file)), true, file);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(backupPath, 'backup-manifest.json'), 'utf8'));
  assert.equal(manifest.source, 'memory-manifest');
  assert.equal(manifest.generation, sidecars.manifest.generation);
  assert.equal(manifest.revision, sidecars.manifest.currentRevision);
  assert.equal(manifest.files.includes('memory-nodes.jsonl.gz'), false);
});
