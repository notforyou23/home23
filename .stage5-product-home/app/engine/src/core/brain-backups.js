/**
 * Brain backup rotator — copies one coherent legacy source view or one pinned
 * manifest generation into a timestamped directory and rotates old backups.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const fsp = fs.promises;
const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  durableBrainOperationRoot,
  createDescriptor,
  readManifest,
  sourceDescriptorDigest,
  validateManifest,
  withMemorySourceLock,
} = require('../../../shared/memory-source');

const BACKUPS_DIR = 'backups';
const BACKUP_FILES = [
  'state.json.gz',
  'memory-nodes.jsonl.gz',
  'memory-edges.jsonl.gz',
  'brain-snapshot.json',
];
const OPTIONAL_BACKUP_FILES = [
  'memory-delta.jsonl',
];
const DEFAULT_RETENTION = 2;
const DEFAULT_INTERVAL_HOURS = 6;
const DEFAULT_MIN_FREE_BYTES = 4 * 1024 ** 3;
const SOURCE_CHANGED = 'BACKUP_SOURCE_CHANGED';

function backupsRoot(brainDir) {
  return path.join(brainDir, BACKUPS_DIR);
}

function inferInstallationContext(canonicalBrainDir) {
  const agentRoot = path.dirname(canonicalBrainDir);
  const instancesRoot = path.dirname(agentRoot);
  const agent = path.basename(agentRoot);
  if (path.basename(canonicalBrainDir) === 'brain'
      && path.basename(instancesRoot) === 'instances'
      && /^[A-Za-z0-9_.-]+$/.test(agent)
      && agent !== '.' && agent !== '..') {
    return { home23Root: path.dirname(instancesRoot), requesterAgent: agent };
  }
  const environmentAgent = process.env.HOME23_AGENT;
  return {
    home23Root: path.dirname(canonicalBrainDir),
    requesterAgent: typeof environmentAgent === 'string'
      && /^[A-Za-z0-9_.-]+$/.test(environmentAgent)
      && environmentAgent !== '.' && environmentAgent !== '..'
      ? environmentAgent
      : 'backup',
  };
}

function listBackups(brainDir) {
  const root = backupsRoot(brainDir);
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => name.startsWith('backup-') && !name.includes('.tmp'))
    .map(name => ({ name, path: path.join(root, name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function mostRecentBackupTime(brainDir) {
  const list = listBackups(brainDir);
  if (list.length === 0) return 0;
  const last = list[list.length - 1];
  try {
    return fs.statSync(last.path).mtimeMs;
  } catch {
    return 0;
  }
}

function sourceChanged(message) {
  return Object.assign(new Error(message), { code: SOURCE_CHANGED });
}

function sameLegacyIdentity(stat, expected) {
  return stat.isFile()
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino
    && String(stat.size) === expected.size
    && String(stat.mtimeNs) === expected.mtimeNs;
}

async function captureLegacySources(brainDir) {
  const identities = {};
  for (const file of BACKUP_FILES) {
    const full = path.join(brainDir, file);
    let stat;
    try {
      stat = await fsp.lstat(full, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { ok: false, result: { created: false, reason: `missing-source:${file}` } };
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return { ok: false, result: { created: false, reason: `missing-source:${file}` } };
    }
    identities[file] = {
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
    };
  }
  for (const file of OPTIONAL_BACKUP_FILES) {
    const full = path.join(brainDir, file);
    let stat;
    try {
      stat = await fsp.lstat(full, { bigint: true });
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw sourceChanged(`unsafe legacy source:${file}`);
    identities[file] = {
      dev: String(stat.dev),
      ino: String(stat.ino),
      size: String(stat.size),
      mtimeNs: String(stat.mtimeNs),
    };
  }
  const files = Object.keys(identities);
  return {
    ok: true,
    sourceSet: {
      source: 'legacy-sidecars',
      physicalRoot: brainDir,
      files,
      descriptor: null,
      descriptorDigest: null,
      sourceFingerprint: { files: identities },
      projectedBytes: files.reduce((total, file) => total + Number(identities[file].size), 0),
      async assertCurrent() {
        for (const file of files) {
          let current;
          try {
            current = await fsp.lstat(path.join(brainDir, file), { bigint: true });
          } catch (error) {
            if (error.code === 'ENOENT') throw sourceChanged(`legacy source disappeared:${file}`);
            throw error;
          }
          if (!sameLegacyIdentity(current, identities[file])) {
            throw sourceChanged(`legacy source changed:${file}`);
          }
        }
      },
    },
  };
}

async function withNativeBackupSources(brainDir, options, callback) {
  const { home23Root, requesterAgent, logger } = options;
  const operationId = `backup-${process.pid}-${Date.now()}-${crypto.randomUUID()}`;
  const operationRoot = durableBrainOperationRoot(home23Root, requesterAgent, operationId);
  const operationsRoot = path.dirname(operationRoot);
  await fsp.mkdir(operationsRoot, { recursive: true, mode: 0o700 });
  const operationsRootStat = await fsp.lstat(operationsRoot, { bigint: true });
  if (!operationsRootStat.isDirectory() || operationsRootStat.isSymbolicLink()) {
    throw sourceChanged('backup operations root is unsafe');
  }
  const operationsRootIdentity = directoryIdentity(operationsRootStat);
  await fsp.mkdir(operationRoot, { recursive: false, mode: 0o700 });
  const operationRootStat = await fsp.lstat(operationRoot, { bigint: true });
  if (!operationRootStat.isDirectory() || operationRootStat.isSymbolicLink()) {
    throw sourceChanged('backup operation root is unsafe');
  }
  const operationRootIdentity = directoryIdentity(operationRootStat);
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent });
  let pinned = null;
  let scratchQuota = null;
  let source = null;
  try {
    pinned = await provider.pin(brainDir, operationId);
    scratchQuota = await createOperationScratchQuota({ operationRoot });
    source = await provider.openPinnedSource(pinned.descriptor, {
      operationId,
      scratchQuota,
      processIdentity: `backup-${process.pid}`,
      expectedCanonicalRoot: pinned.descriptor.canonicalRoot,
      expectedRevision: pinned.descriptor.cutoffRevision,
      expectedDigest: pinned.digest,
    });
    const ann = source.manifest?.ann;
    const annValues = [ann?.indexFile, ann?.metaFile, ann?.builtFromRevision];
    const annIsNull = annValues.every((value) => value === null);
    const annIsComplete = typeof ann?.indexFile === 'string'
      && typeof ann?.metaFile === 'string'
      && Number.isSafeInteger(ann?.builtFromRevision)
      && ann.builtFromRevision >= 0
      && ann.builtFromRevision <= source.manifest.currentRevision;
    if (!annIsNull && !annIsComplete) {
      throw sourceChanged('native ANN descriptor is incomplete');
    }
    const annFiles = new Set();
    if (annIsComplete) {
      const expectedIndex = `memory-ann.${ann.builtFromRevision}.index`;
      const expectedMeta = `memory-ann.${ann.builtFromRevision}.meta.json`;
      if (ann.indexFile !== expectedIndex || ann.metaFile !== expectedMeta) {
        throw sourceChanged('native ANN descriptor is not canonical');
      }
      const authoritativeFiles = new Set([
        'state.json.gz',
        'brain-snapshot.json',
        'memory-manifest.json',
        source.manifest.activeBase.nodes.file,
        source.manifest.activeBase.edges.file,
        source.manifest.activeDelta.file,
      ]);
      if (authoritativeFiles.has(ann.indexFile) || authoritativeFiles.has(ann.metaFile)) {
        throw sourceChanged('native ANN descriptor collides with authoritative source');
      }
      annFiles.add(ann.indexFile);
      annFiles.add(ann.metaFile);
    }
    const files = new Set(['state.json.gz', 'brain-snapshot.json', 'memory-manifest.json']);
    for (const filePath of source.physicalFiles || []) {
      const file = path.basename(filePath);
      if (!annFiles.has(file)) files.add(file);
    }
    for (const file of files) {
      if (file === 'memory-manifest.json') continue;
      let stat;
      try {
        stat = await fsp.lstat(path.join(brainDir, file), { bigint: true });
      } catch (error) {
        if (error.code === 'ENOENT') {
          return { created: false, reason: `missing-source:${file}` };
        }
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return { created: false, reason: `missing-source:${file}` };
      }
    }
    const {
      fileIdentity: _sourceDeltaFileIdentity,
      appendFrom: _sourceDeltaAppendFrom,
      ...portableActiveDelta
    } = source.manifest.activeDelta;
    const backupSourceManifest = {
      ...source.manifest,
      // Device/inode identities belong to the live source tree. The copied
      // delta keeps its cryptographic chain authority but must not inherit
      // private pathname identity from the original installation.
      activeDelta: portableActiveDelta,
      ann: { indexFile: null, metaFile: null, builtFromRevision: null },
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(backupSourceManifest, null, 2)}\n`);
    let projectedBytes = manifestBytes.length;
    for (const file of files) {
      if (file === 'memory-manifest.json') continue;
      projectedBytes += Number((await fsp.stat(path.join(brainDir, file), { bigint: true })).size);
    }
    return await callback({
      source: 'memory-manifest',
      physicalRoot: brainDir,
      files: [...files].sort(),
      descriptor: source.descriptor,
      descriptorDigest: pinned.digest,
      sourceFingerprint: null,
      omittedDerivedFiles: [...annFiles].sort(),
      manifestBytes,
      projectedBytes,
      async assertCurrent() {},
    });
  } finally {
    await Promise.resolve(source?.release?.()).catch((error) => {
      logger?.warn?.('[brain-backup] source pin release failed', { error: error.message });
    });
    await Promise.resolve(scratchQuota?.close?.()).catch((error) => {
      logger?.warn?.('[brain-backup] scratch quota close failed', { error: error.message });
    });
    if (pinned) {
      await provider.releaseOperationPins(operationId).catch((error) => {
        logger?.warn?.('[brain-backup] coordinator pin release failed', { error: error.message });
      });
    }
    await removeOwnedTemporaryDirectory({
      root: operationsRoot,
      rootIdentity: operationsRootIdentity,
      tmpDir: operationRoot,
      tmpIdentity: operationRootIdentity,
    }).catch((error) => {
      logger?.warn?.('[brain-backup] operation root cleanup failed closed', {
        error: error.message,
      });
    });
  }
}

async function withBackupSources(brainDir, options, callback) {
  const lockRoot = path.join(options.home23Root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(lockRoot, { recursive: true, mode: 0o700 });
  if (await readManifest(brainDir)) {
    return withNativeBackupSources(brainDir, options, callback);
  }
  const locked = await withMemorySourceLock(brainDir, { lockRoot }, async () => {
    if (await readManifest(brainDir)) return { retryNative: true };
    const captured = await captureLegacySources(brainDir);
    if (!captured.ok) return { result: captured.result };
    return { result: await callback(captured.sourceSet) };
  });
  if (locked.retryNative) return withNativeBackupSources(brainDir, options, callback);
  return locked.result;
}

function validateMinFreeBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('minFreeBytes must be a nonnegative safe integer');
  }
  return value;
}

async function availableBytesAt(directory) {
  const stat = await fsp.statfs(directory);
  return BigInt(stat.bavail) * BigInt(stat.bsize);
}

async function fsyncDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function directoryIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function sameDirectoryIdentity(stat, expected) {
  return stat.isDirectory()
    && !stat.isSymbolicLink()
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino;
}

async function lstatOptional(filePath) {
  return fsp.lstat(filePath, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function assertOwnedDirectory(directory, expected, label) {
  const stat = await lstatOptional(directory);
  if (stat === null || !sameDirectoryIdentity(stat, expected)) {
    throw sourceChanged(`${label} identity changed`);
  }
  return stat;
}

async function publishOwnedDirectory({ root, rootIdentity, tmpDir, tmpIdentity, finalDir }) {
  await assertOwnedDirectory(root, rootIdentity, 'backups root');
  await assertOwnedDirectory(tmpDir, tmpIdentity, 'backup temporary directory');
  if (await lstatOptional(finalDir) !== null) {
    throw sourceChanged('backup final name already exists');
  }
  await assertOwnedDirectory(root, rootIdentity, 'backups root');
  await assertOwnedDirectory(tmpDir, tmpIdentity, 'backup temporary directory');
  await fsp.rename(tmpDir, finalDir);
  await assertOwnedDirectory(finalDir, tmpIdentity, 'published backup directory');
}

async function removeOwnedTemporaryDirectory({ root, rootIdentity, tmpDir, tmpIdentity }) {
  if (!tmpIdentity) return true;
  await assertOwnedDirectory(root, rootIdentity, 'backups root');
  const current = await lstatOptional(tmpDir);
  if (current === null) return true;
  if (!sameDirectoryIdentity(current, tmpIdentity)) return false;
  const quarantine = path.join(
    root,
    `.backup-cleanup-${tmpIdentity.dev}-${tmpIdentity.ino}-${crypto.randomUUID()}`,
  );
  if (await lstatOptional(quarantine) !== null) return false;
  await assertOwnedDirectory(tmpDir, tmpIdentity, 'backup temporary directory');
  await fsp.rename(tmpDir, quarantine);
  await fsyncDirectory(root);
  const moved = await lstatOptional(quarantine);
  if (moved === null || !sameDirectoryIdentity(moved, tmpIdentity)) return false;
  await fsp.rm(quarantine, { recursive: true, force: false });
  await fsyncDirectory(root);
  return true;
}

async function hashAndSyncFile(filePath) {
  const handle = await fsp.open(filePath, 'r');
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    await handle.sync();
    const stat = await handle.stat();
    return { bytes: stat.size, sha256: `sha256:${hash.digest('hex')}` };
  } finally {
    await handle.close();
  }
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function readBoundRegularFile(filePath, { maxBytes = 1024 * 1024 } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)
      || path.normalize(filePath) !== filePath || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('backup receipt path is invalid');
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > BigInt(maxBytes) || fs.realpathSync(filePath) !== filePath) {
    throw new Error('backup receipt must be a bounded canonical regular file');
  }
  if (!Number.isInteger(fs.constants.O_NOFOLLOW)) {
    throw new Error('backup receipt validation requires O_NOFOLLOW');
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.nlink !== 1n) {
      throw new Error('backup receipt identity changed during validation');
    }
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('backup receipt identity changed during readback');
    }
    return Object.freeze({
      bytes,
      binding: Object.freeze({
        path: filePath,
        dev: String(opened.dev),
        ino: String(opened.ino),
        size: String(opened.size),
        mtimeNs: String(opened.mtimeNs),
        ctimeNs: String(opened.ctimeNs),
        digest: sha256Bytes(bytes),
        rehashOnAssert: true,
      }),
    });
  } finally {
    fs.closeSync(fd);
  }
}

function assertBoundRegularFile(binding, label = 'backup file') {
  const stat = fs.lstatSync(binding.path, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1n
      || String(stat.dev) !== binding.dev || String(stat.ino) !== binding.ino
      || String(stat.size) !== binding.size || String(stat.mtimeNs) !== binding.mtimeNs
      || (!binding.ignoreCtime && String(stat.ctimeNs) !== binding.ctimeNs)
      || fs.realpathSync(binding.path) !== binding.path
      || (binding.rehashOnAssert && sha256Bytes(fs.readFileSync(binding.path)) !== binding.digest)) {
    throw sourceChanged(`${label} changed after validation`);
  }
}

function fsyncDirectorySync(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function retainBackupBindingsAt(bindings, guardDirectory, backupIdentity) {
  if (typeof guardDirectory !== 'string' || !path.isAbsolute(guardDirectory)
      || path.normalize(guardDirectory) !== guardDirectory) {
    throw new Error('backup guard path must be canonical and absolute');
  }
  const parent = path.dirname(guardDirectory);
  const parentStat = fs.lstatSync(parent, { bigint: true });
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
      || fs.realpathSync(parent) !== parent) {
    throw new Error('backup guard parent must be a canonical nonsymlink directory');
  }
  fs.mkdirSync(guardDirectory, { mode: 0o700 });
  const guardStat = fs.lstatSync(guardDirectory, { bigint: true });
  if (!guardStat.isDirectory() || guardStat.isSymbolicLink()
      || fs.realpathSync(guardDirectory) !== guardDirectory) {
    throw new Error('backup guard directory is unsafe');
  }
  const retained = [];
  try {
    for (const binding of bindings) {
      assertBoundRegularFile(binding);
      const retainedPath = path.join(guardDirectory, path.basename(binding.path));
      fs.linkSync(binding.path, retainedPath);
      const retainedStat = fs.lstatSync(retainedPath, { bigint: true });
      if (!retainedStat.isFile() || retainedStat.isSymbolicLink()
          || String(retainedStat.dev) !== binding.dev || String(retainedStat.ino) !== binding.ino) {
        throw new Error('backup guard hard link identity mismatch');
      }
      retained.push(Object.freeze({
        ...binding,
        path: retainedPath,
        size: String(retainedStat.size),
        mtimeNs: String(retainedStat.mtimeNs),
        ctimeNs: String(retainedStat.ctimeNs),
        ignoreCtime: true,
      }));
    }
    fsyncDirectorySync(guardDirectory);
    fsyncDirectorySync(parent);
  } catch (error) {
    const current = fs.lstatSync(guardDirectory, { bigint: true });
    if (current.dev === guardStat.dev && current.ino === guardStat.ino) {
      fs.rmSync(guardDirectory, { recursive: true, force: false });
      fsyncDirectorySync(parent);
    }
    throw error;
  }
  const identity = sha256Bytes(Buffer.from(JSON.stringify({
    backupIdentity,
    files: retained.map((binding) => ({
      file: path.basename(binding.path),
      bytes: Number(binding.size),
      sha256: binding.digest,
    })),
  })));
  return Object.freeze({
    identity,
    assertCurrent() {
      for (const binding of retained) assertBoundRegularFile(binding, 'retained backup file');
      return true;
    },
    release() {
      const current = fs.lstatSync(guardDirectory, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink()
          || current.dev !== guardStat.dev || current.ino !== guardStat.ino) {
        throw new Error('backup guard identity changed before cleanup');
      }
      fs.rmSync(guardDirectory, { recursive: true, force: false });
      fsyncDirectorySync(parent);
    },
  });
}

function hashBoundRegularFile(filePath, expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error('backup copied file size is invalid');
  }
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size !== BigInt(expectedBytes) || fs.realpathSync(filePath) !== filePath) {
    throw new Error('backup copied file must be an exact canonical regular file');
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
        || opened.size !== before.size || opened.nlink !== 1n) {
      throw new Error('backup copied file identity changed during validation');
    }
    while (position < expectedBytes) {
      const read = fs.readSync(fd, buffer, 0, Math.min(buffer.length, expectedBytes - position), position);
      if (!Number.isSafeInteger(read) || read <= 0) {
        throw new Error('backup copied file is truncated');
      }
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    if (fs.readSync(fd, buffer, 0, 1, position) !== 0) {
      throw new Error('backup copied file grew during validation');
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
        || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new Error('backup copied file changed during validation');
    }
    return Object.freeze({
      path: filePath,
      dev: String(opened.dev),
      ino: String(opened.ino),
      size: String(opened.size),
      mtimeNs: String(opened.mtimeNs),
      ctimeNs: String(opened.ctimeNs),
      digest: `sha256:${hash.digest('hex')}`,
      rehashOnAssert: false,
    });
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Verify a create-new native backup receipt and every copied byte before a
 * destructive or metadata-mutating operation relies on it.
 */
function validateCoherentBackupReceipt({
  brainDir,
  receiptFile,
  expectedDigest,
  expectedGeneration,
  expectedRevision,
} = {}) {
  if (typeof receiptFile !== 'string' || !receiptFile) {
    throw new Error('backup receipt file is required');
  }
  if (typeof expectedDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new Error('backup receipt digest is required');
  }
  const canonicalBrain = fs.realpathSync(brainDir);
  const expectedBackups = path.join(canonicalBrain, BACKUPS_DIR);
  const backupsStat = fs.lstatSync(expectedBackups);
  if (!backupsStat.isDirectory() || backupsStat.isSymbolicLink()
      || fs.realpathSync(expectedBackups) !== expectedBackups) {
    throw new Error('backup root must be a canonical nonsymlink directory inside the brain');
  }
  const canonicalBackups = expectedBackups;
  const suppliedReceipt = path.resolve(receiptFile);
  const suppliedReceiptStat = fs.lstatSync(suppliedReceipt);
  if (!suppliedReceiptStat.isFile() || suppliedReceiptStat.isSymbolicLink()) {
    throw new Error('backup receipt must be a canonical nonsymlink regular file');
  }
  const canonicalReceipt = fs.realpathSync(suppliedReceipt);
  const backupDir = path.dirname(canonicalReceipt);
  const backupDirStat = fs.lstatSync(backupDir);
  if (!backupDirStat.isDirectory() || backupDirStat.isSymbolicLink()
      || fs.realpathSync(backupDir) !== backupDir
      || path.dirname(backupDir) !== canonicalBackups
      || !path.basename(backupDir).startsWith('backup-')
      || path.basename(canonicalReceipt) !== 'backup-manifest.json') {
    throw new Error('backup receipt must be inside one canonical brain backup directory');
  }
  const openedReceipt = readBoundRegularFile(canonicalReceipt);
  if (openedReceipt.binding.digest !== expectedDigest) {
    throw new Error('backup receipt digest mismatch');
  }
  let receipt;
  try {
    receipt = JSON.parse(openedReceipt.bytes.toString('utf8'));
  } catch {
    throw new Error('backup receipt is malformed');
  }
  const receiptKeys = [
    'copiedBytes', 'descriptorDigest', 'fileRecords', 'files', 'generation',
    'omittedDerivedFiles', 'revision', 'source', 'sourceFingerprint', 'version',
  ].sort();
  if (!receipt || Array.isArray(receipt)
      || Object.keys(receipt).sort().join(',') !== receiptKeys.join(',')
      || receipt.version !== 2
      || receipt.source !== 'memory-manifest'
      || receipt.generation !== expectedGeneration
      || receipt.revision !== expectedRevision
      || typeof receipt.descriptorDigest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(receipt.descriptorDigest)
      || receipt.sourceFingerprint !== null
      || !Array.isArray(receipt.omittedDerivedFiles)
      || !Array.isArray(receipt.files) || !Array.isArray(receipt.fileRecords)
      || receipt.files.length < 1 || receipt.files.length !== receipt.fileRecords.length) {
    throw new Error('backup receipt source generation or revision is invalid');
  }
  const seen = new Set();
  const bindings = [openedReceipt.binding];
  let copiedBytes = 0;
  for (let index = 0; index < receipt.fileRecords.length; index += 1) {
    const record = receipt.fileRecords[index];
    const file = receipt.files[index];
    if (!record || Array.isArray(record) || Object.keys(record).sort().join(',') !== 'bytes,file,sha256'
        || record.file !== file || typeof file !== 'string'
        || path.basename(file) !== file || path.isAbsolute(file) || seen.has(file)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 0
        || typeof record.sha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(record.sha256)) {
      throw new Error('backup receipt file records are invalid');
    }
    seen.add(file);
    const binding = hashBoundRegularFile(path.join(backupDir, file), record.bytes);
    if (Number(binding.size) !== record.bytes || binding.digest !== record.sha256) {
      throw new Error('backup copied file digest or size mismatch');
    }
    copiedBytes += record.bytes;
    bindings.push(binding);
  }
  if (copiedBytes !== receipt.copiedBytes || !seen.has('memory-manifest.json')) {
    throw new Error('backup copied byte accounting is invalid');
  }
  const copiedManifestBytes = fs.readFileSync(path.join(backupDir, 'memory-manifest.json'));
  let copiedManifest;
  try {
    copiedManifest = JSON.parse(copiedManifestBytes.toString('utf8'));
    validateManifest(copiedManifest);
  } catch {
    throw new Error('backup memory manifest is invalid');
  }
  const requiredFiles = [
    'state.json.gz',
    'brain-snapshot.json',
    'memory-manifest.json',
    copiedManifest.activeBase.nodes.file,
    copiedManifest.activeBase.edges.file,
    copiedManifest.activeDelta.file,
  ].sort();
  const receivedFiles = [...receipt.files].sort();
  if (requiredFiles.length !== receivedFiles.length
      || requiredFiles.some((file, index) => file !== receivedFiles[index])) {
    throw new Error('backup receipt authoritative file set is incomplete');
  }
  if (copiedManifest.generation !== expectedGeneration
      || copiedManifest.currentRevision !== expectedRevision
      || sourceDescriptorDigest(createDescriptor(canonicalBrain, copiedManifest))
        !== receipt.descriptorDigest) {
    throw new Error('backup memory manifest source identity mismatch');
  }
  const backupIdentity = sha256Bytes(Buffer.from(JSON.stringify({
    descriptorDigest: receipt.descriptorDigest,
    generation: receipt.generation,
    revision: receipt.revision,
    files: receipt.fileRecords,
  })));
  return Object.freeze({
    digest: openedReceipt.binding.digest,
    identity: backupIdentity,
    generation: receipt.generation,
    revision: receipt.revision,
    receiptFile: canonicalReceipt,
    assertCurrent() {
      for (const binding of bindings) assertBoundRegularFile(binding);
      return true;
    },
    retainAt(guardDirectory) {
      for (const binding of bindings) assertBoundRegularFile(binding);
      return retainBackupBindingsAt(bindings, guardDirectory, backupIdentity);
    },
  });
}

async function copySourceFile(sourceSet, file, destination) {
  if (file === 'memory-manifest.json' && sourceSet.manifestBytes) {
    await fsp.writeFile(destination, sourceSet.manifestBytes, { mode: 0o600 });
  } else {
    await fsp.copyFile(path.join(sourceSet.physicalRoot, file), destination);
  }
  return hashAndSyncFile(destination);
}

/**
 * Create a new backup if enough time has elapsed since the last one.
 *
 * @param {string} brainDir
 * @param {{ intervalHours?: number, retention?: number, logger?: any, force?: boolean,
 *   home23Root?: string, requesterAgent?: string, minFreeBytes?: number }} opts
 * @returns {Promise<{ created: boolean, reason?: string, backupName?: string, pruned?: number }>}
 */
async function maybeBackup(brainDir, opts = {}) {
  const {
    intervalHours = DEFAULT_INTERVAL_HOURS,
    retention = DEFAULT_RETENTION,
    logger,
    force = false,
    minFreeBytes = DEFAULT_MIN_FREE_BYTES,
  } = opts;
  validateMinFreeBytes(minFreeBytes);
  const inferred = inferInstallationContext(await fsp.realpath(brainDir));
  const home23Root = opts.home23Root === undefined ? inferred.home23Root : opts.home23Root;
  const requesterAgent = opts.requesterAgent === undefined
    ? inferred.requesterAgent
    : opts.requesterAgent;

  const root = backupsRoot(brainDir);
  fs.mkdirSync(root, { recursive: true });
  const rootStat = await fsp.lstat(root, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('backups root must be a regular directory');
  }
  const rootIdentity = directoryIdentity(rootStat);

  if (!force) {
    const lastMs = mostRecentBackupTime(brainDir);
    const sinceMs = Date.now() - lastMs;
    if (lastMs > 0 && sinceMs < intervalHours * 3600 * 1000) {
      return { created: false, reason: 'within-interval' };
    }
  }

  return withBackupSources(brainDir, { home23Root, requesterAgent, logger }, async (sourceSet) => {
    const availableBytes = await availableBytesAt(root);
    const requiredBytes = BigInt(sourceSet.projectedBytes) + BigInt(minFreeBytes);
    if (requiredBytes > availableBytes) {
      return {
        created: false,
        reason: 'insufficient-disk',
        projectedBytes: sourceSet.projectedBytes,
        minFreeBytes,
        availableBytes: Number(availableBytes),
      };
    }

    const stamp = new Date().toISOString().replace(/:/g, '-');
    const backupName = `backup-${stamp}-${process.pid}-${crypto.randomUUID()}`;
    const tmpDir = path.join(root, `${backupName}.tmp`);
    const finalDir = path.join(root, backupName);

    let copiedBytes = 0;
    const fileRecords = [];
    let tmpIdentity = null;
    try {
      await assertOwnedDirectory(root, rootIdentity, 'backups root');
      await fsp.mkdir(tmpDir, { mode: 0o700 });
      const tmpStat = await fsp.lstat(tmpDir, { bigint: true });
      if (!tmpStat.isDirectory() || tmpStat.isSymbolicLink()) {
        throw sourceChanged('backup temporary directory is unsafe');
      }
      tmpIdentity = directoryIdentity(tmpStat);
      for (const file of sourceSet.files) {
        const destination = path.join(tmpDir, file);
        await fsp.mkdir(path.dirname(destination), { recursive: true });
        const copied = await copySourceFile(sourceSet, file, destination);
        copiedBytes += copied.bytes;
        fileRecords.push({ file, bytes: copied.bytes, sha256: copied.sha256 });
      }
      await sourceSet.assertCurrent();
      const backupManifest = {
        version: 2,
        source: sourceSet.source,
        generation: sourceSet.descriptor?.generation || null,
        revision: sourceSet.descriptor?.cutoffRevision ?? null,
        sourceFingerprint: sourceSet.sourceFingerprint,
        descriptorDigest: sourceSet.descriptorDigest,
        omittedDerivedFiles: sourceSet.omittedDerivedFiles || [],
        copiedBytes,
        files: fileRecords.map(({ file }) => file),
        fileRecords,
      };
      const backupManifestPath = path.join(tmpDir, 'backup-manifest.json');
      await fsp.writeFile(backupManifestPath, `${JSON.stringify(backupManifest, null, 2)}\n`, {
        mode: 0o600,
      });
      await hashAndSyncFile(backupManifestPath);
      await fsyncDirectory(tmpDir);
      await sourceSet.assertCurrent();
      await publishOwnedDirectory({ root, rootIdentity, tmpDir, tmpIdentity, finalDir });
      await fsyncDirectory(finalDir);
      await fsyncDirectory(root);
    } catch (error) {
      await removeOwnedTemporaryDirectory({
        root,
        rootIdentity,
        tmpDir,
        tmpIdentity,
      }).then((removed) => {
        if (!removed) {
          logger?.warn?.('[brain-backup] skipped cleanup of replaced temporary path', { tmpDir });
        }
      }).catch((cleanupError) => {
        logger?.warn?.('[brain-backup] temporary cleanup failed closed', {
          tmpDir,
          error: cleanupError.message,
        });
      });
      logger?.warn?.('[brain-backup] create failed', { error: error.message });
      return {
        created: false,
        reason: error.code === SOURCE_CHANGED ? 'source-changed' : `copy-failed:${error.message}`,
      };
    }

    let pruned = 0;
    const all = listBackups(brainDir);
    if (all.length > retention) {
      for (const old of all.slice(0, all.length - retention)) {
        try {
          await fsp.rm(old.path, { recursive: true, force: true });
          pruned += 1;
        } catch (error) {
          logger?.warn?.('[brain-backup] prune failed', { backup: old.name, error: error.message });
        }
      }
    }

    logger?.info?.('[brain-backup] created', {
      name: backupName,
      sizeMB: +(copiedBytes / 1048576).toFixed(1),
      kept: Math.min(all.length, retention),
      pruned,
    });
    return {
      created: true,
      backupName,
      pruned,
      sizeMB: +(copiedBytes / 1048576).toFixed(1),
    };
  });
}

module.exports = {
  maybeBackup,
  listBackups,
  BACKUPS_DIR,
  BACKUP_FILES,
  OPTIONAL_BACKUP_FILES,
  DEFAULT_MIN_FREE_BYTES,
  withBackupSources,
  validateCoherentBackupReceipt,
};
