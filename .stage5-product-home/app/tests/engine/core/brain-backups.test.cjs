const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  BACKUP_FILES,
  listBackups,
  maybeBackup,
} = require('../../../engine/src/core/brain-backups');
const { writeMemorySidecars } = require('../../../engine/src/core/memory-sidecar');
const {
  appendMemoryRevision,
  openMemorySource,
  retireUnpinnedSources,
  rewriteMemoryBase,
  sourceDescriptorDigest,
} = require('../../../shared/memory-source');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHomeFixture(prefix) {
  const home23Root = mkdtempSync(path.join(tmpdir(), prefix));
  const brainDir = path.join(home23Root, 'instances', 'target', 'brain');
  mkdirSync(brainDir, { recursive: true });
  return { home23Root, brainDir };
}

function seedRequiredFiles(brainDir) {
  for (const file of BACKUP_FILES) writeFileSync(path.join(brainDir, file), `${file}\n`);
}

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
    const result = await maybeBackup(dir, { force: true, retention: 2, minFreeBytes: 0 });
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
  const { home23Root, brainDir: dir } = createHomeFixture('brain-backup-manifest-');
  writeFileSync(path.join(dir, 'state.json.gz'), 'state\n');
  writeFileSync(path.join(dir, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  const sidecars = await writeMemorySidecars(dir, {
    nodes: [{ id: 'n1', concept: 'manifest canary' }],
    edges: [],
  });

  const result = await maybeBackup(dir, {
    force: true,
    retention: 2,
    home23Root,
    requesterAgent: 'backup',
    minFreeBytes: 0,
  });
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
  assert.match(manifest.descriptorDigest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.sourceFingerprint, null);
  assert.equal(manifest.copiedBytes, manifest.fileRecords.reduce((total, file) => total + file.bytes, 0));
  assert.deepEqual(manifest.fileRecords.map((file) => file.file), manifest.files);
  for (const file of manifest.fileRecords) {
    assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(fs.statSync(path.join(backupPath, file.file)).size, file.bytes);
  }
});

test('native backup omits rebuildable ANN bytes and publishes a self-consistent null ANN manifest', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-derived-ann-');
  writeFileSync(path.join(brainDir, 'state.json.gz'), 'state\n');
  writeFileSync(path.join(brainDir, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  const sidecars = await writeMemorySidecars(brainDir, {
    nodes: [{ id: 'n1', concept: 'derived ANN backup canary' }],
    edges: [],
  });
  const indexFile = `memory-ann.${sidecars.manifest.currentRevision}.index`;
  const metaFile = `memory-ann.${sidecars.manifest.currentRevision}.meta.json`;
  writeFileSync(path.join(brainDir, indexFile), 'rebuildable-index\n');
  writeFileSync(path.join(brainDir, metaFile), '{"rebuildable":true}\n');
  writeFileSync(path.join(brainDir, 'memory-manifest.json'), `${JSON.stringify({
    ...sidecars.manifest,
    ann: {
      indexFile,
      metaFile,
      builtFromRevision: sidecars.manifest.currentRevision,
    },
  }, null, 2)}\n`);

  const result = await maybeBackup(brainDir, {
    force: true,
    retention: 1,
    home23Root,
    requesterAgent: 'target',
    minFreeBytes: 0,
  });
  assert.equal(result.created, true);
  const backupPath = path.join(brainDir, 'backups', result.backupName);
  assert.equal(fs.existsSync(path.join(backupPath, indexFile)), false);
  assert.equal(fs.existsSync(path.join(backupPath, metaFile)), false);
  const copiedSourceManifest = JSON.parse(
    fs.readFileSync(path.join(backupPath, 'memory-manifest.json'), 'utf8'),
  );
  assert.deepEqual(copiedSourceManifest.ann, {
    indexFile: null,
    metaFile: null,
    builtFromRevision: null,
  });
  assert.equal(Object.hasOwn(copiedSourceManifest.activeDelta, 'fileIdentity'), false);
  assert.equal(Object.hasOwn(copiedSourceManifest.activeDelta, 'appendFrom'), false);
  assert.match(copiedSourceManifest.activeDelta.chainDigest, /^[a-f0-9]{64}$/);
  const backupManifest = JSON.parse(
    fs.readFileSync(path.join(backupPath, 'backup-manifest.json'), 'utf8'),
  );
  assert.deepEqual(backupManifest.omittedDerivedFiles.sort(), [indexFile, metaFile].sort());
  assert.equal(backupManifest.files.includes(indexFile), false);
  assert.equal(backupManifest.files.includes(metaFile), false);
  assert.deepEqual(
    backupManifest.omittedDerivedFiles.filter((file) => backupManifest.files.includes(file)),
    [],
  );
  const copiedManifestBytes = fs.readFileSync(path.join(backupPath, 'memory-manifest.json'));
  const copiedManifestRecord = backupManifest.fileRecords.find(
    (record) => record.file === 'memory-manifest.json',
  );
  assert.equal(copiedManifestRecord.bytes, copiedManifestBytes.length);
  assert.equal(
    copiedManifestRecord.sha256,
    `sha256:${crypto.createHash('sha256').update(copiedManifestBytes).digest('hex')}`,
  );
  let restored = await openMemorySource(backupPath);
  assert.equal(restored.getEvidence().implementation, 'manifest-v1');
  assert.equal(restored.getEvidence().sourceHealth, 'healthy');
  assert.match(backupManifest.descriptorDigest, /^sha256:[a-f0-9]{64}$/);
  assert.match(sourceDescriptorDigest(restored.descriptor), /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await restored.summarize(), { nodes: 1, edges: 0, clusters: 0 });
  const canary = await restored.searchKeyword({ query: 'derived ANN backup canary', topK: 3 });
  assert.deepEqual(canary.results.map((row) => row.id), ['n1']);
  await restored.close();

  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  mkdirSync(lockRoot, { recursive: true });
  await appendMemoryRevision(backupPath, {
    nodes: [{ id: 'n2', concept: 'restored writer canary' }],
  }, { lockRoot });
  restored = await openMemorySource(backupPath);
  const appended = await restored.searchKeyword({ query: 'restored writer canary', topK: 3 });
  assert.equal(appended.results.some((row) => row.id === 'n2'), true);
  await restored.close();
});

test('native backup never classifies an authoritative source file as rebuildable ANN', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-ann-collision-');
  writeFileSync(path.join(brainDir, 'state.json.gz'), 'state\n');
  writeFileSync(path.join(brainDir, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  const sidecars = await writeMemorySidecars(brainDir, {
    nodes: [{ id: 'n1', concept: 'ANN collision canary' }],
    edges: [],
  });
  const metaFile = `memory-ann.${sidecars.manifest.currentRevision}.meta.json`;
  writeFileSync(path.join(brainDir, metaFile), '{"rebuildable":true}\n');
  writeFileSync(path.join(brainDir, 'memory-manifest.json'), `${JSON.stringify({
    ...sidecars.manifest,
    ann: {
      indexFile: sidecars.manifest.activeBase.nodes.file,
      metaFile,
      builtFromRevision: sidecars.manifest.currentRevision,
    },
  }, null, 2)}\n`);

  await assert.rejects(() => maybeBackup(brainDir, {
    force: true,
    retention: 1,
    home23Root,
    requesterAgent: 'target',
    minFreeBytes: 0,
  }), { code: 'BACKUP_SOURCE_CHANGED' });
  assert.deepEqual(listBackups(brainDir), []);
});

test('maybeBackup rejects a legacy backup when a raw source mutates during copy', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-legacy-mutation-');
  seedRequiredFiles(brainDir);
  const originalCopyFile = fs.promises.copyFile;
  let mutated = false;
  fs.promises.copyFile = async (source, destination) => {
    await originalCopyFile(source, destination);
    if (!mutated) {
      mutated = true;
      await fs.promises.appendFile(path.join(brainDir, 'state.json.gz'), 'concurrent mutation\n');
    }
  };
  try {
    const result = await maybeBackup(brainDir, {
      force: true,
      home23Root,
      requesterAgent: 'backup',
      minFreeBytes: 0,
    });
    assert.equal(result.created, false);
    assert.equal(result.reason, 'source-changed');
    assert.deepEqual(listBackups(brainDir), []);
  } finally {
    fs.promises.copyFile = originalCopyFile;
  }
});

test('maybeBackup refuses projected bytes that would breach the configured free-space reserve', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-capacity-');
  seedRequiredFiles(brainDir);
  const projectedBytes = BACKUP_FILES.reduce(
    (total, file) => total + fs.statSync(path.join(brainDir, file)).size,
    0,
  );
  const minFreeBytes = 1024;
  const originalStatfs = fs.promises.statfs;
  fs.promises.statfs = async () => ({ bsize: 1, bavail: projectedBytes + minFreeBytes - 1 });
  try {
    const result = await maybeBackup(brainDir, {
      force: true,
      home23Root,
      requesterAgent: 'backup',
      minFreeBytes,
    });
    assert.equal(result.created, false);
    assert.equal(result.reason, 'insufficient-disk');
    assert.equal(result.projectedBytes, projectedBytes);
    assert.equal(result.minFreeBytes, minFreeBytes);
    assert.deepEqual(listBackups(brainDir), []);
  } finally {
    fs.promises.statfs = originalStatfs;
  }
});

test('maybeBackup keeps a native source pin until rename so retirement cannot remove copied files', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-native-retirement-');
  writeFileSync(path.join(brainDir, 'state.json.gz'), 'state\n');
  writeFileSync(path.join(brainDir, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  const initial = await writeMemorySidecars(brainDir, {
    nodes: [{ id: 'n1', concept: 'pinned backup canary' }],
    edges: [],
  });
  const oldNodeFile = initial.manifest.activeBase.nodes.file;
  const oldEdgeFile = initial.manifest.activeBase.edges.file;
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  mkdirSync(lockRoot, { recursive: true });

  const copyEntered = deferred();
  const releaseCopy = deferred();
  const originalCopyFile = fs.promises.copyFile;
  fs.promises.copyFile = async (source, destination) => {
    if (path.basename(source) === oldNodeFile) {
      copyEntered.resolve();
      await releaseCopy.promise;
    }
    return originalCopyFile(source, destination);
  };

  try {
    const backupPromise = maybeBackup(brainDir, {
      force: true,
      minFreeBytes: 0,
    });
    await Promise.race([
      copyEntered.promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('native copy did not pause')), 1000)),
    ]);
    assert.equal(
      fs.existsSync(path.join(home23Root, 'instances', 'target', 'runtime', 'brain-operations')),
      true,
    );
    assert.equal(fs.existsSync(path.join(home23Root, 'instances', 'backup')), false);
    await rewriteMemoryBase(brainDir, {
      nodes: [{ id: 'n2', concept: 'replacement generation' }],
      edges: [],
      summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
    }, { lockRoot });
    const retirement = await retireUnpinnedSources(brainDir, { home23Root, lockRoot });
    assert.equal(retirement.retired.includes(oldNodeFile), false);
    assert.equal(retirement.retired.includes(oldEdgeFile), false);
    releaseCopy.resolve();

    const result = await backupPromise;
    assert.equal(result.created, true);
    const backupPath = path.join(brainDir, 'backups', result.backupName);
    assert.equal(fs.existsSync(path.join(backupPath, oldNodeFile)), true);
    assert.equal(fs.existsSync(path.join(backupPath, oldEdgeFile)), true);
    const copiedManifest = JSON.parse(
      fs.readFileSync(path.join(backupPath, 'memory-manifest.json'), 'utf8'),
    );
    assert.equal(copiedManifest.generation, initial.manifest.generation);
    assert.equal(copiedManifest.currentRevision, initial.manifest.currentRevision);
  } finally {
    releaseCopy.resolve();
    fs.promises.copyFile = originalCopyFile;
  }
});

test('concurrent native backups publish distinct backups without sharing temporary paths', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-concurrent-native-');
  writeFileSync(path.join(brainDir, 'state.json.gz'), 'state\n');
  writeFileSync(path.join(brainDir, 'brain-snapshot.json'), '{"nodeCount":1}\n');
  await writeMemorySidecars(brainDir, {
    nodes: [{ id: 'n1', concept: 'concurrent backup canary' }],
    edges: [],
  });

  const OriginalDate = global.Date;
  const fixed = '2026-07-12T12:34:56.000Z';
  global.Date = class FixedBackupDate extends OriginalDate {
    constructor(...args) {
      super(args.length === 0 ? fixed : args[0]);
    }

    static now() {
      return OriginalDate.now();
    }
  };
  try {
    const settled = await Promise.allSettled([
      maybeBackup(brainDir, { force: true, retention: 2, minFreeBytes: 0 }),
      maybeBackup(brainDir, { force: true, retention: 2, minFreeBytes: 0 }),
    ]);
    assert.deepEqual(settled.map((entry) => entry.status), ['fulfilled', 'fulfilled']);
    const results = settled.map((entry) => entry.value);
    assert.deepEqual(results.map((result) => result.created), [true, true]);
    assert.equal(new Set(results.map((result) => result.backupName)).size, 2);
    for (const result of results) {
      assert.equal(
        fs.existsSync(path.join(brainDir, 'backups', result.backupName, 'backup-manifest.json')),
        true,
      );
    }
    assert.equal(listBackups(brainDir).length, 2);
    assert.deepEqual(
      fs.readdirSync(path.join(brainDir, 'backups')).filter((name) => name.endsWith('.tmp')),
      [],
    );
  } finally {
    global.Date = OriginalDate;
  }
});

test('failed backup cleanup never removes a replacement at its temporary path', async () => {
  const { home23Root, brainDir } = createHomeFixture('brain-backup-owned-cleanup-');
  seedRequiredFiles(brainDir);
  const originalCopyFile = fs.promises.copyFile;
  let replacementPath = null;
  let displacedPath = null;
  fs.promises.copyFile = async (source, destination) => {
    await originalCopyFile(source, destination);
    if (replacementPath === null) {
      replacementPath = path.dirname(destination);
      displacedPath = `${replacementPath}.displaced`;
      await fs.promises.rename(replacementPath, displacedPath);
      await fs.promises.mkdir(replacementPath);
      await fs.promises.writeFile(path.join(replacementPath, 'replacement-canary.txt'), 'retain\n');
      throw new Error('injected copy failure after temp replacement');
    }
  };
  try {
    const result = await maybeBackup(brainDir, {
      force: true,
      home23Root,
      requesterAgent: 'backup',
      minFreeBytes: 0,
    });
    assert.equal(result.created, false);
    assert.match(result.reason, /^copy-failed:/);
    assert.notEqual(replacementPath, null);
    assert.equal(
      fs.readFileSync(path.join(replacementPath, 'replacement-canary.txt'), 'utf8'),
      'retain\n',
    );
    assert.deepEqual(listBackups(brainDir), []);
  } finally {
    fs.promises.copyFile = originalCopyFile;
    if (replacementPath) await fs.promises.rm(replacementPath, { recursive: true, force: true });
    if (displacedPath) await fs.promises.rm(displacedPath, { recursive: true, force: true });
  }
});
