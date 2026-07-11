'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const {
  MANIFEST_FILE,
  MAX_MANIFEST_BYTES,
  readManifest,
  validateManifest,
} = require('./manifest.cjs');
const {
  createDescriptor,
  openMemorySource,
} = require('./reader.cjs');
const { PINNED_OPENED_FILES } = require('./private-capabilities.cjs');
const {
  projectLegacyResidentSidecars,
  verifyLegacySourceFingerprint,
} = require('./legacy-projection.cjs');
const {
  openConfinedRegularFile,
  portableFileIdentity,
  assertStableOpenedFile,
  assertOpenedFilePathIdentity,
  readOpenedFile,
  readConfinedFile,
} = require('./confined-file.cjs');
const {
  canonicalJson,
  sourceDescriptorDigest,
  memorySourceError,
  rethrowAbort,
  throwIfAborted,
} = require('./contracts.cjs');
const { assertOperationRoot, createOperationScratchQuota } = require('./scratch-quota.cjs');

const TRUSTED_PROVIDER_CONTEXT = Symbol('trusted-memory-source-provider-context');
const MAX_OPERATION_STATUS_BYTES = 1024 * 1024;
const MUTATION_BOUNDARY_KINDS = Object.freeze([
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
]);
const SOURCE_LOCK_OWNER_BYTES = 8 * 1024;
const SOURCE_LOCK_PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);
const SOURCE_LOCK_FALLBACK_IDENTITY = `unverifiable:${process.pid}:${SOURCE_LOCK_PROCESS_STARTED_AT}:${crypto.randomUUID()}`;
const execFileAsync = promisify(execFile);
let currentSourceLockIdentityPromise = null;

function boundedIdentityToken(value) {
  return typeof value === 'string' && value.length > 0
    && Buffer.byteLength(value, 'utf8') <= 512;
}

async function readDarwinProcessIdentity(pid) {
  let bootToken;
  try {
    ({ stdout: bootToken } = await execFileAsync(
      '/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        encoding: 'utf8',
        maxBuffer: 4096,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
    ));
  } catch {
    return null;
  }
  let processOutput;
  try {
    ({ stdout: processOutput } = await execFileAsync(
      '/bin/ps', ['-p', String(pid), '-o', 'pid=,lstart='], {
        encoding: 'utf8',
        maxBuffer: 4096,
        env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      },
    ));
  } catch (error) {
    if (error.code === 1) return false;
    return null;
  }
  const normalized = processOutput.trim().replace(/\s+/g, ' ');
  if (!normalized.startsWith(`${pid} `)) return null;
  return Object.freeze({
    bootToken: bootToken.trim(),
    processStartToken: normalized.slice(String(pid).length + 1),
  });
}

async function readLinuxProcessIdentity(pid) {
  let statText;
  let bootToken;
  try {
    statText = await fsp.readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return false;
    return null;
  }
  try {
    bootToken = await fsp.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
  } catch {
    return null;
  }
  const closeParen = statText.lastIndexOf(')');
  if (closeParen < 0) return null;
  const fields = statText.slice(closeParen + 1).trim().split(/\s+/);
  const processStartToken = fields[19];
  if (!processStartToken) return null;
  return Object.freeze({ bootToken: bootToken.trim(), processStartToken });
}

async function inspectSourceLockProcessIdentity(pid) {
  if (process.platform === 'darwin') return readDarwinProcessIdentity(pid);
  if (process.platform === 'linux') return readLinuxProcessIdentity(pid);
  return null;
}

function inspectCurrentSourceLockIdentity() {
  currentSourceLockIdentityPromise ||= inspectSourceLockProcessIdentity(process.pid);
  return currentSourceLockIdentityPromise;
}

async function createSourceLockOwner(canonicalRoot, now) {
  const exact = await inspectCurrentSourceLockIdentity();
  return Object.freeze({
    version: 1,
    canonicalRoot,
    pid: process.pid,
    processStartedAt: SOURCE_LOCK_PROCESS_STARTED_AT,
    bootToken: exact && exact !== false
      ? exact.bootToken
      : `unverifiable-boot:${SOURCE_LOCK_FALLBACK_IDENTITY}`,
    processStartToken: exact && exact !== false
      ? exact.processStartToken
      : `unverifiable-start:${SOURCE_LOCK_FALLBACK_IDENTITY}`,
    createdAt: new Date(now).toISOString(),
  });
}

function validateSourceLockOwner(owner, canonicalRoot) {
  const fields = [
    'version', 'canonicalRoot', 'pid', 'processStartedAt',
    'bootToken', 'processStartToken', 'createdAt',
  ];
  if (!owner || Array.isArray(owner) || typeof owner !== 'object'
      || Reflect.ownKeys(owner).length !== fields.length
      || fields.some((field) => !Object.hasOwn(owner, field))
      || owner.version !== 1
      || owner.canonicalRoot !== canonicalRoot
      || !Number.isSafeInteger(owner.pid) || owner.pid <= 0
      || !Number.isSafeInteger(owner.processStartedAt) || owner.processStartedAt < 0
      || !boundedIdentityToken(owner.bootToken)
      || !boundedIdentityToken(owner.processStartToken)
      || typeof owner.createdAt !== 'string'
      || Number.isNaN(Date.parse(owner.createdAt))) {
    return null;
  }
  return owner;
}

function sourceLockOwnerHasFallbackIdentity(owner) {
  return [owner.bootToken, owner.processStartToken].some((token) =>
    token.startsWith('unverifiable-') || token.startsWith('unverifiable:'));
}

async function defaultIsSourceLockOwnerAlive(owner) {
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return null;
  }
  if (sourceLockOwnerHasFallbackIdentity(owner)) return null;
  const exact = owner.pid === process.pid
    ? await inspectCurrentSourceLockIdentity()
    : await inspectSourceLockProcessIdentity(owner.pid);
  if (exact === false) return false;
  if (exact === null) return null;
  return exact.bootToken === owner.bootToken
    && exact.processStartToken === owner.processStartToken;
}

function abortableDelay(ms, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal.reason || Object.assign(new Error('cancelled'), {
        name: 'AbortError', code: 'cancelled',
      }));
    }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function validateOperationId(operationId) {
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(operationId)
      || operationId === '.' || operationId === '..') {
    throw memorySourceError('invalid_request', 'safe operation id required');
  }
  return operationId;
}

function durableBrainOperationRoot(home23Root, requesterAgent, operationId) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)
      || path.normalize(home23Root) !== home23Root || home23Root.includes('\0')
      || typeof requesterAgent !== 'string'
      || !/^[A-Za-z0-9_.-]+$/.test(requesterAgent)
      || requesterAgent === '.' || requesterAgent === '..') {
    throw memorySourceError('invalid_request', 'trusted durable operation root required');
  }
  validateOperationId(operationId);
  return path.join(
    home23Root,
    'instances',
    requesterAgent,
    'runtime',
    'brain-operations',
    'operations',
    operationId,
  );
}

function canonicalRootHash(canonicalRoot) {
  return crypto.createHash('sha256').update(canonicalRoot).digest('hex');
}

function coordinatorPinPath(operationRoot) {
  return path.join(operationRoot, 'coordinator-source-pin.json');
}

async function writeAtomicJson(filePath, value) {
  const directory = path.dirname(filePath);
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let temporaryIdentity = null;
  let handle = null;
  let published = false;
  try {
    handle = await fsp.open(
      temporaryPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
        | (fs.constants.O_NOFOLLOW || 0),
      0o600,
    );
    const opened = await handle.stat();
    if (!opened.isFile()) {
      throw memorySourceError('invalid_memory_source', 'coordinator pin temp is not regular', {
        retryable: false,
      });
    }
    temporaryIdentity = sourceLockIdentity(opened);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    const beforeRename = await fsp.lstat(temporaryPath);
    if (beforeRename.isSymbolicLink() || !beforeRename.isFile()
        || !sameSourceLockIdentity(beforeRename, temporaryIdentity)) {
      throw memorySourceError('invalid_memory_source', 'coordinator pin temp identity changed', {
        retryable: false,
      });
    }
    await fsp.rename(temporaryPath, filePath);
    published = true;
    await fsyncSourceLockDirectory(directory);
  } catch (error) {
    await handle?.close().catch(() => {});
    if (!published && temporaryIdentity) {
      const stat = await sourceLockLstatOptional(temporaryPath).catch(() => null);
      if (stat && !stat.isSymbolicLink() && stat.isFile()
          && sameSourceLockIdentity(stat, temporaryIdentity)) {
        await fsp.unlink(temporaryPath).catch(() => {});
        await fsyncSourceLockDirectory(directory).catch(() => {});
      }
    }
    throw error;
  }
}

async function readCoordinatorRecord(operationRoot) {
  return JSON.parse(await fsp.readFile(coordinatorPinPath(operationRoot), 'utf8'));
}

function physicalIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function samePhysicalIdentity(stat, expected) {
  return Boolean(expected
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino);
}

async function inspectPhysicalRoot(physicalRoot) {
  const [stat, canonical] = await Promise.all([
    fsp.lstat(physicalRoot, { bigint: true }),
    fsp.realpath(physicalRoot),
  ]);
  if (stat.isSymbolicLink() || !stat.isDirectory() || canonical !== physicalRoot) {
    throw memorySourceError('invalid_memory_source', 'physical source root is not canonical', {
      retryable: false,
    });
  }
  return { stat, canonical };
}

function descriptorMatchesDigest(descriptor, digest) {
  try {
    return typeof digest === 'string' && sourceDescriptorDigest(descriptor) === digest;
  } catch {
    return false;
  }
}

function descriptorsMatch(left, right) {
  try {
    return canonicalJson(left) === canonicalJson(right);
  } catch {
    return false;
  }
}

function protectedFileSpecs(manifest) {
  return [
    { role: 'manifest', file: MANIFEST_FILE },
    { role: 'nodes', file: manifest.activeBase.nodes.file },
    { role: 'edges', file: manifest.activeBase.edges.file },
    { role: 'delta', file: manifest.activeDelta.file },
    ...(manifest.ann.indexFile
      ? [{ role: 'ann-index', file: manifest.ann.indexFile }] : []),
    ...(manifest.ann.metaFile
      ? [{ role: 'ann-meta', file: manifest.ann.metaFile }] : []),
  ];
}

async function closeProtectedFiles(openedFiles) {
  await Promise.all([...new Set(openedFiles?.values() || [])].map(async (opened) => {
    await opened.handle.close().catch((error) => {
      if (error?.code !== 'EBADF') throw error;
    });
  }));
}

async function readManifestFromOpened(opened) {
  let manifest;
  try {
    const bytes = await readOpenedFile(opened, { maxBytes: MAX_MANIFEST_BYTES });
    manifest = validateManifest(JSON.parse(bytes.toString('utf8')));
  } catch (error) {
    if (error?.code) throw error;
    throw memorySourceError('source_unavailable', 'memory manifest unavailable', {
      cause: error,
      retryable: true,
    });
  }
  return manifest;
}

async function recheckProtectedFiles(openedFiles, identities) {
  for (const identity of identities) {
    const opened = openedFiles.get(identity.role);
    await assertStableOpenedFile(opened);
    await assertOpenedFilePathIdentity(opened, identity);
  }
}

async function captureProtectedFiles(physicalRoot, expectedManifest, { signal } = {}) {
  const openedFiles = new Map();
  try {
    const manifestOpened = await openConfinedRegularFile(
      physicalRoot,
      path.join(physicalRoot, MANIFEST_FILE),
      { flags: fs.constants.O_RDONLY, maxBytes: MAX_MANIFEST_BYTES, signal },
    );
    openedFiles.set('manifest', manifestOpened);
    const manifest = await readManifestFromOpened(manifestOpened);
    if (!descriptorsMatch(manifest, expectedManifest)) {
      throw memorySourceError('source_changed', 'manifest changed while pinning', {
        retryable: true,
      });
    }
    for (const spec of protectedFileSpecs(manifest).slice(1)) {
      const opened = await openConfinedRegularFile(
        physicalRoot,
        path.join(physicalRoot, spec.file),
        { flags: fs.constants.O_RDONLY, signal },
      );
      openedFiles.set(spec.role, opened);
    }
    if (Number(openedFiles.get('nodes').stat.size) !== manifest.activeBase.nodes.bytes
        || Number(openedFiles.get('edges').stat.size) !== manifest.activeBase.edges.bytes
        || Number(openedFiles.get('delta').stat.size) < manifest.activeDelta.committedBytes) {
      throw memorySourceError('source_changed', 'manifest file sizes changed while pinning', {
        retryable: true,
      });
    }
    const identities = protectedFileSpecs(manifest).map(({ role, file }) => ({
      role,
      file,
      ...portableFileIdentity(openedFiles.get(role).stat),
    }));
    await recheckProtectedFiles(openedFiles, identities);
    return { manifest, identities, openedFiles };
  } catch (error) {
    await closeProtectedFiles(openedFiles);
    throw error;
  }
}

function validateProtectedIdentity(value, spec) {
  return value && !Array.isArray(value) && typeof value === 'object'
    && Reflect.ownKeys(value).length === 5
    && value.role === spec.role
    && value.file === spec.file
    && /^(0|[1-9][0-9]*)$/.test(value.dev)
    && /^(0|[1-9][0-9]*)$/.test(value.ino)
    && /^(0|[1-9][0-9]*)$/.test(value.size);
}

function validateCoordinatorProtectedRecord(record) {
  let manifest;
  try {
    manifest = validateManifest(record.pinnedManifest);
  } catch {
    return null;
  }
  const specs = protectedFileSpecs(manifest);
  if (!Array.isArray(record.protectedFileIdentities)
      || record.protectedFileIdentities.length !== specs.length
      || record.protectedFileIdentities.some((identity, index) =>
        !validateProtectedIdentity(identity, specs[index]))
      || !Array.isArray(record.protectedFiles)
      || canonicalJson(record.protectedFiles) !== canonicalJson(specs.slice(1).map(({ file }) => file))
      || record.committedBytes !== manifest.activeDelta.committedBytes
      || !descriptorsMatch(createDescriptor(record.canonicalRoot, manifest), record.descriptor)) {
    return null;
  }
  return manifest;
}

async function openRecordedProtectedFiles(physicalRoot, record, { signal } = {}) {
  const manifest = validateCoordinatorProtectedRecord(record);
  if (!manifest) {
    throw memorySourceError('source_changed', 'coordinator protected-file record is invalid', {
      retryable: true,
    });
  }
  const openedFiles = new Map();
  try {
    for (const identity of record.protectedFileIdentities) {
      const opened = await openConfinedRegularFile(
        physicalRoot,
        path.join(physicalRoot, identity.file),
        {
          flags: fs.constants.O_RDONLY,
          ...(identity.role === 'manifest' ? { maxBytes: MAX_MANIFEST_BYTES } : {}),
          signal,
        },
      );
      openedFiles.set(identity.role, opened);
      await assertOpenedFilePathIdentity(opened, identity);
    }
    const openedManifest = await readManifestFromOpened(openedFiles.get('manifest'));
    if (!descriptorsMatch(openedManifest, manifest)) {
      throw memorySourceError('source_changed', 'pinned manifest contents changed', {
        retryable: true,
      });
    }
    await recheckProtectedFiles(openedFiles, record.protectedFileIdentities);
    return { manifest, openedFiles };
  } catch (error) {
    await closeProtectedFiles(openedFiles);
    rethrowAbort(error, signal);
    if (error?.code === 'source_changed') throw error;
    throw memorySourceError('source_changed', 'pinned protected file changed', {
      cause: error,
      retryable: true,
    });
  }
}

async function pinOperationSource({
  canonicalRoot,
  operationRoot,
  operationId,
  requesterAgent,
  lockRoot,
  scratchQuota,
  signal,
  _testHooks = {},
}) {
  validateOperationId(operationId);
  if (!_testHooks || Array.isArray(_testHooks) || typeof _testHooks !== 'object'
      || Object.values(_testHooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid source pin test hooks');
  }
  const canonical = await fsp.realpath(canonicalRoot);
  const root = await assertOperationRoot(operationRoot);
  return withMemorySourceLock(canonical, { lockRoot }, async () => {
    throwIfAborted(signal);
    const existing = await fsp.readFile(coordinatorPinPath(root), 'utf8').catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing !== null) {
      const record = JSON.parse(existing);
      if (record.canonicalRoot !== canonical || record.operationId !== operationId
          || record.requesterAgent !== requesterAgent
          || !descriptorMatchesDigest(record.descriptor, record.digest)
          || !validateCoordinatorProtectedRecord(record)) {
        throw memorySourceError('source_pin_conflict', 'source pin conflict');
      }
      const existingPhysicalRoot = await resolvePinnedPhysicalRoot({
        record,
        operationRoot: root,
        descriptor: record.descriptor,
      });
      throwIfAborted(signal);
      const opened = await openRecordedProtectedFiles(existingPhysicalRoot, record, { signal });
      try {
        throwIfAborted(signal);
        if (record.sourceFingerprint
            && !await verifyLegacySourceFingerprint(canonical, record.sourceFingerprint)) {
          throw memorySourceError(
            'source_changed',
            'legacy source changed after coordinator pin publication',
            { retryable: true },
          );
        }
        throwIfAborted(signal);
        await recheckProtectedFiles(opened.openedFiles, record.protectedFileIdentities);
        throwIfAborted(signal);
        return Object.freeze({ descriptor: record.descriptor, digest: record.digest });
      } finally {
        await closeProtectedFiles(opened.openedFiles);
      }
    }
    let manifest = await readManifest(canonical);
    let physicalRoot = canonical;
    let sourceFingerprint = null;
    if (!manifest) {
      if (!scratchQuota || scratchQuota.operationRoot !== root) {
        throw memorySourceError(
          'source_operation_required',
          'legacy source pin requires operation scratch quota',
          { retryable: false },
        );
      }
      const projected = await projectLegacyResidentSidecars({
        canonicalRoot: canonical,
        operationRoot: root,
        scratchQuota,
        signal,
      });
      manifest = projected.manifest;
      physicalRoot = projected.projectionRoot;
      sourceFingerprint = projected.sourceFingerprint;
    }
    throwIfAborted(signal);
    const physical = await inspectPhysicalRoot(physicalRoot);
    const captured = await captureProtectedFiles(physicalRoot, manifest, { signal });
    try {
      const descriptor = createDescriptor(canonical, captured.manifest);
      const digest = sourceDescriptorDigest(descriptor);
      const record = {
        version: 1,
        operationId,
        requesterAgent,
        canonicalRoot: canonical,
        descriptor,
        digest,
        pinnedManifest: captured.manifest,
        protectedFiles: captured.identities.slice(1).map(({ file }) => file),
        protectedFileIdentities: captured.identities,
        committedBytes: captured.manifest.activeDelta.committedBytes,
        physicalRoot,
        physicalRootIdentity: physicalIdentity(physical.stat),
        projectionRoot: sourceFingerprint ? physicalRoot : null,
        sourceFingerprint,
      };
      await _testHooks.beforeCoordinatorPublish?.({
        canonicalRoot: canonical,
        physicalRoot,
        manifest: captured.manifest,
      });
      throwIfAborted(signal);
      await recheckProtectedFiles(captured.openedFiles, captured.identities);
      if (sourceFingerprint
          && !await verifyLegacySourceFingerprint(canonical, sourceFingerprint)) {
        throw memorySourceError('source_changed', 'legacy source changed before pin publication', {
          retryable: true,
        });
      }
      await writeAtomicJson(coordinatorPinPath(root), record);
      return Object.freeze({ descriptor, digest });
    } finally {
      await closeProtectedFiles(captured.openedFiles);
    }
  });
}

const PROCESS_START_IDENTITY = `${process.pid}:${Math.max(
  0,
  Math.floor(Date.now() - (process.uptime() * 1000)),
)}`;

function defaultProcessIdentity() {
  const digest = crypto.createHash('sha256')
    .update(`${process.pid}\0${PROCESS_START_IDENTITY}`)
    .digest('hex')
    .slice(0, 20);
  return `node-${process.pid}-${digest}`;
}

function validateProcessIdentity(value) {
  const identity = value ?? defaultProcessIdentity();
  if (typeof identity !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(identity)
      || identity === '.'
      || identity === '..') {
    throw memorySourceError('invalid_request', 'safe process identity required');
  }
  return identity;
}

async function currentProcessPinOwnerIdentity() {
  const exact = await inspectCurrentSourceLockIdentity();
  if (exact && exact !== false) return exact;
  return Object.freeze({
    bootToken: `unverifiable-boot:${SOURCE_LOCK_FALLBACK_IDENTITY}`,
    processStartToken: `unverifiable-start:${SOURCE_LOCK_FALLBACK_IDENTITY}`,
  });
}

async function defaultIsProcessPinAlive(record) {
  if (!record || Array.isArray(record) || typeof record !== 'object'
      || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || !boundedIdentityToken(record.bootToken)
      || !boundedIdentityToken(record.processStartToken)) {
    return null;
  }
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code !== 'EPERM') return null;
  }
  if (sourceLockOwnerHasFallbackIdentity(record)) return null;
  const exact = record.pid === process.pid
    ? await inspectCurrentSourceLockIdentity()
    : await inspectSourceLockProcessIdentity(record.pid);
  if (exact === false) return false;
  if (exact === null) return null;
  return exact.bootToken === record.bootToken
    && exact.processStartToken === record.processStartToken;
}

function trustedLockRootForOperation(operationRoot) {
  const operationContainer = path.dirname(operationRoot);
  const brainOperationsRoot = path.basename(operationContainer) === 'operations'
    ? path.dirname(operationContainer)
    : operationContainer;
  const runtimeRoot = path.dirname(brainOperationsRoot);
  const agentRoot = path.dirname(runtimeRoot);
  const instancesRoot = path.dirname(agentRoot);
  const home23Root = path.dirname(instancesRoot);
  if (path.basename(brainOperationsRoot) !== 'brain-operations'
      || path.basename(runtimeRoot) !== 'runtime'
      || path.basename(instancesRoot) !== 'instances'
      || !/^[A-Za-z0-9_.-]+$/.test(path.basename(agentRoot))) {
    throw memorySourceError('invalid_request', 'trusted source lock root cannot be derived');
  }
  return path.join(home23Root, 'runtime', 'brain-source-locks');
}

const processPinReferences = new Map();

function operationPathIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameOperationPathIdentity(stat, identity) {
  return Boolean(stat && identity
    && String(stat.dev) === identity.dev
    && String(stat.ino) === identity.ino);
}

async function operationPathLstatOptional(candidate) {
  return fsp.lstat(candidate).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function captureExactOperationDirectory(directory, label, { optional = false } = {}) {
  const stat = await operationPathLstatOptional(directory);
  if (stat === null && optional) return null;
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()
      || await fsp.realpath(directory).catch(() => null) !== directory) {
    throw memorySourceError('invalid_memory_source', `${label} is not an exact directory`, {
      retryable: false,
    });
  }
  return operationPathIdentity(stat);
}

async function assertExactOperationDirectory(directory, identity, label) {
  const stat = await operationPathLstatOptional(directory);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()
      || !sameOperationPathIdentity(stat, identity)
      || await fsp.realpath(directory).catch(() => null) !== directory) {
    throw memorySourceError('invalid_memory_source', `${label} identity changed`, {
      retryable: false,
    });
  }
}

async function ensureExactOperationChildDirectory(parent, parentIdentity, child, label) {
  await assertExactOperationDirectory(parent, parentIdentity, `${label} parent`);
  try {
    await fsp.mkdir(child, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const identity = await captureExactOperationDirectory(child, label);
  await assertExactOperationDirectory(parent, parentIdentity, `${label} parent`);
  return identity;
}

async function captureExactOperationFile(filePath, label) {
  const stat = await operationPathLstatOptional(filePath);
  if (stat === null || stat.isSymbolicLink() || !stat.isFile()) {
    throw memorySourceError('invalid_memory_source', `${label} is not an exact regular file`, {
      retryable: false,
    });
  }
  return operationPathIdentity(stat);
}

async function captureProcessPinConfinement(pinFile, { operationIdentity = null } = {}) {
  const pinDir = path.dirname(pinFile);
  const pinsRoot = path.dirname(pinDir);
  const operationRoot = path.dirname(pinsRoot);
  const exactOperationIdentity = operationIdentity
    || await captureExactOperationDirectory(operationRoot, 'process-pin operation root');
  const pinsIdentity = await captureExactOperationDirectory(pinsRoot, 'process-pin root');
  const pinDirIdentity = await captureExactOperationDirectory(pinDir, 'process-pin owner root');
  const pinFileIdentity = await captureExactOperationFile(pinFile, 'process pin');
  await assertExactOperationDirectory(
    operationRoot,
    exactOperationIdentity,
    'process-pin operation root',
  );
  return Object.freeze({
    operationRoot,
    operationIdentity: exactOperationIdentity,
    pinsRoot,
    pinsIdentity,
    pinDir,
    pinDirIdentity,
    pinFile,
    pinFileIdentity,
  });
}

async function assertProcessPinConfinement(confinement) {
  await assertExactOperationDirectory(
    confinement.operationRoot,
    confinement.operationIdentity,
    'process-pin operation root',
  );
  await assertExactOperationDirectory(
    confinement.pinsRoot,
    confinement.pinsIdentity,
    'process-pin root',
  );
  await assertExactOperationDirectory(
    confinement.pinDir,
    confinement.pinDirIdentity,
    'process-pin owner root',
  );
}

async function readConfinedProcessPinRecord(confinement) {
  const opened = await openConfinedRegularFile(
    confinement.operationRoot,
    confinement.pinFile,
    { flags: fs.constants.O_RDONLY },
  );
  try {
    const record = JSON.parse((await readOpenedFile(opened, {
      maxBytes: MAX_OPERATION_STATUS_BYTES,
    })).toString('utf8'));
    await assertOpenedFilePathIdentity(opened, portableFileIdentity(opened.stat));
    return record;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

async function removeExactProcessPin(confinement) {
  await assertProcessPinConfinement(confinement);
  const stat = await operationPathLstatOptional(confinement.pinFile);
  if (stat !== null) {
    if (stat.isSymbolicLink() || !stat.isFile()
        || !sameOperationPathIdentity(stat, confinement.pinFileIdentity)) {
      throw memorySourceError('invalid_memory_source', 'process pin identity changed', {
        retryable: false,
      });
    }
    await fsp.unlink(confinement.pinFile);
    await fsyncSourceLockDirectory(confinement.pinDir);
  }
  await assertProcessPinConfinement(confinement);
  try {
    await fsp.rmdir(confinement.pinDir);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
  await fsyncSourceLockDirectory(confinement.pinsRoot);
  await assertExactOperationDirectory(
    confinement.operationRoot,
    confinement.operationIdentity,
    'process-pin operation root',
  );
  await assertExactOperationDirectory(
    confinement.pinsRoot,
    confinement.pinsIdentity,
    'process-pin root',
  );
}

const PROCESS_PIN_RECORD_KEYS = Object.freeze([
  'version',
  'operationId',
  'requesterAgent',
  'canonicalRoot',
  'generation',
  'revision',
  'digest',
  'protectedFiles',
  'committedBytes',
  'pid',
  'processIdentity',
  'bootToken',
  'processStartToken',
  'createdAt',
  'heartbeatAt',
]);

function validProcessPinTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function processPinRecordMatches(actual, expected) {
  return actual && !Array.isArray(actual) && typeof actual === 'object'
    && Reflect.ownKeys(actual).length === PROCESS_PIN_RECORD_KEYS.length
    && PROCESS_PIN_RECORD_KEYS.every((key) => Object.hasOwn(actual, key))
    && actual.version === 1
    && actual.operationId === expected.operationId
    && actual.requesterAgent === expected.requesterAgent
    && actual.canonicalRoot === expected.canonicalRoot
    && actual.generation === expected.generation
    && actual.revision === expected.revision
    && actual.digest === expected.digest
    && actual.pid === expected.pid
    && actual.processIdentity === expected.processIdentity
    && actual.bootToken === expected.bootToken
    && actual.processStartToken === expected.processStartToken
    && Array.isArray(actual.protectedFiles)
    && canonicalJson(actual.protectedFiles) === canonicalJson(expected.protectedFiles)
    && actual.committedBytes === expected.committedBytes
    && validProcessPinTimestamp(actual.createdAt)
    && validProcessPinTimestamp(actual.heartbeatAt)
    && Date.parse(actual.heartbeatAt) >= Date.parse(actual.createdAt);
}

function nextProcessPinTimestamp(previous, now = Date.now()) {
  const prior = previous && validProcessPinTimestamp(previous)
    ? Date.parse(previous)
    : -1;
  return new Date(Math.max(now, prior + 1)).toISOString();
}

async function readExistingProcessPin(operationRoot, pinFile) {
  const stat = await operationPathLstatOptional(pinFile);
  if (stat === null) return null;
  let opened = null;
  try {
    opened = await openConfinedRegularFile(operationRoot, pinFile, {
      flags: fs.constants.O_RDONLY,
    });
    return JSON.parse((await readOpenedFile(opened, {
      maxBytes: MAX_OPERATION_STATUS_BYTES,
    })).toString('utf8'));
  } catch (cause) {
    throw memorySourceError('source_pin_conflict', 'existing process pin is unreadable', {
      cause,
      retryable: true,
    });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

async function writeProcessPinExclusive(pinFile, pinDir, record, { beforePublish } = {}) {
  const pinsRoot = path.dirname(pinDir);
  const operationRoot = path.dirname(pinsRoot);
  const operationIdentity = await captureExactOperationDirectory(
    operationRoot,
    'process-pin operation root',
  );
  const pinsIdentity = await ensureExactOperationChildDirectory(
    operationRoot,
    operationIdentity,
    pinsRoot,
    'process-pin root',
  );
  await fsyncSourceLockDirectory(operationRoot);
  await ensureExactOperationChildDirectory(
    pinsRoot,
    pinsIdentity,
    pinDir,
    'process-pin owner root',
  );
  await fsyncSourceLockDirectory(pinsRoot);
  const existing = await readExistingProcessPin(operationRoot, pinFile);
  if (existing && !processPinRecordMatches(existing, record)) {
    throw memorySourceError('source_pin_conflict', 'existing process pin identity conflicts', {
      retryable: true,
    });
  }
  const createdAt = existing?.createdAt || nextProcessPinTimestamp(null);
  const next = Object.freeze({
    ...record,
    createdAt,
    heartbeatAt: nextProcessPinTimestamp(existing?.heartbeatAt || createdAt),
  });
  await beforePublish?.({
    operationRoot,
    pinFile,
    pinDir,
    existing: existing !== null,
    record: next,
  });
  await writeAtomicJson(pinFile, next);
  const confinement = await captureProcessPinConfinement(pinFile, { operationIdentity });
  await assertProcessPinConfinement(confinement);
  return Object.freeze({ confinement, record: next });
}

async function acquireProcessPin(pinFile, pinDir, record, options = {}) {
  let entry = processPinReferences.get(pinFile);
  if (entry) {
    entry.references += 1;
    try {
      entry.ready = entry.ready.then(() => writeProcessPinExclusive(
        pinFile,
        pinDir,
        record,
        options,
      ));
      await entry.ready;
    } catch (error) {
      entry.references -= 1;
      throw error;
    }
  } else {
    entry = { references: 1, ready: null };
    processPinReferences.set(pinFile, entry);
    entry.ready = writeProcessPinExclusive(pinFile, pinDir, record, options);
    try {
      await entry.ready;
    } catch (error) {
      if (processPinReferences.get(pinFile) === entry) processPinReferences.delete(pinFile);
      throw error;
    }
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if (processPinReferences.get(pinFile) !== entry) return;
    entry.references -= 1;
    if (entry.references > 0) return;
    processPinReferences.delete(pinFile);
    const published = await entry.ready;
    await removeExactProcessPin(published.confinement);
  };
}

function isConfinedOrEqual(root, candidate) {
  if (candidate === root) return true;
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function validateMutationBoundaries(target, canonicalRoot) {
  const boundaries = target?.mutationBoundaries;
  if (!Array.isArray(boundaries) || boundaries.length !== MUTATION_BOUNDARY_KINDS.length) {
    throw memorySourceError('access_denied', 'authorized mutation boundaries required');
  }
  const found = new Set();
  for (const boundary of boundaries) {
    if (!boundary || Array.isArray(boundary) || typeof boundary !== 'object'
        || !MUTATION_BOUNDARY_KINDS.includes(boundary.kind)
        || found.has(boundary.kind)
        || typeof boundary.path !== 'string'
        || !path.isAbsolute(boundary.path)
        || path.normalize(boundary.path) !== boundary.path
        || boundary.path.includes('\0')
        || !isConfinedOrEqual(canonicalRoot, boundary.path)) {
      throw memorySourceError('access_denied', 'mutation boundary escapes authorized brain');
    }
    found.add(boundary.kind);
  }
  if (found.size !== MUTATION_BOUNDARY_KINDS.length) {
    throw memorySourceError('access_denied', 'authorized mutation boundaries required');
  }
}

async function readAuthorizedMutationRecord({
  operationRoot,
  operationId,
  requesterAgent,
  descriptor,
  digest,
  ownBrainRoot,
  expectedOperationType,
  signal,
}) {
  throwIfAborted(signal);
  if (expectedOperationType !== 'synthesis' || descriptor.canonicalRoot !== ownBrainRoot) {
    throw memorySourceError('access_denied', 'source mutation is restricted to own-brain synthesis');
  }
  const statusPath = path.join(operationRoot, 'status.json');
  const bytes = await readConfinedFile(operationRoot, statusPath, {
    maxBytes: MAX_OPERATION_STATUS_BYTES,
    signal,
  });
  let status;
  try {
    status = JSON.parse(bytes.toString('utf8'));
  } catch (cause) {
    throw memorySourceError('access_denied', 'authorized operation record is unreadable', { cause });
  }
  const target = status?.target;
  if (!status || Array.isArray(status) || typeof status !== 'object'
      || status.operationId !== operationId
      || status.requesterAgent !== requesterAgent
      || status.operationType !== 'synthesis'
      || !['queued', 'running'].includes(status.state)
      || status.sourcePinReleasedAt !== null
      || status._deleting === true
      || status.sourcePinDigest !== digest
      || !descriptorsMatch(status.sourcePinDescriptor, descriptor)
      || !target || Array.isArray(target) || typeof target !== 'object'
      || target.domain !== 'brain'
      || target.canonicalRoot !== descriptor.canonicalRoot
      || target.accessMode !== 'own'
      || target.ownerAgent !== requesterAgent
      || target.kind !== 'resident'
      || target.lifecycle !== 'resident') {
    throw memorySourceError('access_denied', 'own-brain synthesis authorization is invalid');
  }
  validateMutationBoundaries(target, descriptor.canonicalRoot);
  throwIfAborted(signal);
  return status;
}

function attachPinnedSourceMutation(source, {
  descriptor,
  record,
  operationRoot,
  operationId,
  requesterAgent,
  expectedDigest,
  expectations,
}) {
  const providerContext = expectations[TRUSTED_PROVIDER_CONTEXT] || null;
  let releaseRequested = false;
  let activeMutation = null;

  async function compareAndSwap(commit) {
    if (typeof commit !== 'function') {
      throw memorySourceError('invalid_request', 'source CAS commit callback required');
    }
    if (releaseRequested) {
      throw memorySourceError('source_stale', 'pinned source has been released', { retryable: true });
    }
    if (activeMutation) {
      throw memorySourceError('source_busy', 'source CAS already active', { retryable: true });
    }
    if (!providerContext || record.projectionRoot !== null) {
      throw memorySourceError(
        record.projectionRoot !== null ? 'source_changed' : 'access_denied',
        'pinned source is read-only',
        { retryable: record.projectionRoot !== null },
      );
    }
    const mutation = (async () => {
      const ownBrainRoot = await fsp.realpath(providerContext.ownBrainPath).catch(() => null);
      if (!ownBrainRoot || releaseRequested) {
        throw memorySourceError('access_denied', 'own brain source is unavailable');
      }
      const { compareAndSwapSourceRevision } = require('./writer.cjs');
      return compareAndSwapSourceRevision(descriptor.canonicalRoot, {
        lockRoot: providerContext.lockRoot,
        expectedGeneration: descriptor.generation,
        expectedRevision: descriptor.cutoffRevision,
        expectedDigest,
        signal: expectations.signal,
        authorize: () => readAuthorizedMutationRecord({
          operationRoot,
          operationId,
          requesterAgent,
          descriptor,
          digest: expectedDigest,
          ownBrainRoot,
          expectedOperationType: expectations.operationType,
          signal: expectations.signal,
        }),
        commit,
      });
    })();
    activeMutation = mutation;
    try {
      return await mutation;
    } finally {
      if (activeMutation === mutation) activeMutation = null;
    }
  }

  return {
    compareAndSwap,
    requestRelease() { releaseRequested = true; },
    async waitForMutation() {
      if (activeMutation) await activeMutation.catch(() => {});
    },
  };
}

async function resolvePinnedPhysicalRoot({ record, operationRoot, descriptor }) {
  const physicalRoot = record.physicalRoot;
  if (typeof physicalRoot !== 'string' || !path.isAbsolute(physicalRoot)
      || physicalRoot.includes('\0') || path.normalize(physicalRoot) !== physicalRoot) {
    throw memorySourceError('source_changed', 'invalid pinned physical root', { retryable: true });
  }
  const isProjection = record.projectionRoot !== null;
  if (isProjection) {
    const projectionsRoot = path.join(operationRoot, 'source-projections');
    if (record.projectionRoot !== physicalRoot
        || path.dirname(physicalRoot) !== projectionsRoot
        || path.basename(physicalRoot) !== descriptor.generation
        || record.sourceFingerprint === null) {
      throw memorySourceError('source_changed', 'pinned projection mapping mismatch', {
        retryable: true,
      });
    }
  } else if (record.projectionRoot !== null
      || record.sourceFingerprint !== null
      || physicalRoot !== descriptor.canonicalRoot) {
    throw memorySourceError('source_changed', 'pinned native mapping mismatch', {
      retryable: true,
    });
  }
  let inspected;
  try {
    inspected = await inspectPhysicalRoot(physicalRoot);
  } catch (error) {
    throw memorySourceError('source_changed', 'pinned physical root unavailable', {
      cause: error,
      retryable: true,
    });
  }
  if (!samePhysicalIdentity(inspected.stat, record.physicalRootIdentity)) {
    throw memorySourceError('source_changed', 'pinned physical root identity changed', {
      retryable: true,
    });
  }
  return physicalRoot;
}

async function openPinnedSource(descriptor, expectations = {}) {
  if (!descriptor || descriptor.version !== 1) {
    throw memorySourceError('invalid_request', 'numeric v1 descriptor required');
  }
  const operationId = validateOperationId(expectations.operationId);
  if (typeof expectations.requesterAgent !== 'string'
      || !/^[A-Za-z0-9_.-]+$/.test(expectations.requesterAgent)
      || expectations.requesterAgent === '.' || expectations.requesterAgent === '..') {
    throw memorySourceError('invalid_request', 'safe requester required');
  }
  const operationRoot = await assertOperationRoot(expectations.operationRoot);
  if (!expectations.scratchQuota || expectations.scratchQuota.operationRoot !== operationRoot) {
    throw memorySourceError('invalid_request', 'scratch quota for exact operation root required');
  }
  const expectedDigest = expectations.expectedDigest;
  if (typeof expectedDigest !== 'string') {
    throw memorySourceError('source_changed', 'expected descriptor digest required', {
      retryable: true,
    });
  }
  if (expectedDigest !== sourceDescriptorDigest(descriptor)) {
    throw memorySourceError('source_changed', 'descriptor digest mismatch', { retryable: true });
  }
  if (expectations.expectedCanonicalRoot
      && expectations.expectedCanonicalRoot !== descriptor.canonicalRoot) {
    throw memorySourceError('source_changed', 'canonical root mismatch', { retryable: true });
  }
  if (expectations.expectedRevision !== undefined
      && expectations.expectedRevision !== descriptor.cutoffRevision) {
    throw memorySourceError('source_changed', 'revision mismatch', { retryable: true });
  }
  const processPinIdentity = validateProcessIdentity(expectations.processIdentity);
  const pinDir = path.join(operationRoot, 'pins', processPinIdentity);
  const pinFile = path.join(pinDir, `${canonicalRootHash(descriptor.canonicalRoot)}.json`);
  const lockRoot = expectations[TRUSTED_PROVIDER_CONTEXT]?.lockRoot
    || trustedLockRootForOperation(operationRoot);
  const processHooks = expectations._testHooks || {};
  if (!processHooks || Array.isArray(processHooks) || typeof processHooks !== 'object'
      || Object.values(processHooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid process pin test hooks');
  }
  let record = null;
  let source = null;
  let openedFiles = null;
  let releaseProcessPinUnderLock = null;
  try {
    await withMemorySourceLock(descriptor.canonicalRoot, {
      lockRoot,
      signal: expectations.signal,
    }, async () => {
      throwIfAborted(expectations.signal);
      record = await readCoordinatorRecord(operationRoot).catch((error) => {
        if (error.code === 'ENOENT') {
          throw memorySourceError('source_changed', 'coordinator pin missing', { retryable: true });
        }
        throw error;
      });
      if (record.version !== 1
          || record.operationId !== operationId
          || record.requesterAgent !== expectations.requesterAgent
          || record.digest !== expectedDigest
          || record.canonicalRoot !== descriptor.canonicalRoot
          || !descriptorMatchesDigest(record.descriptor, record.digest)
          || !descriptorsMatch(record.descriptor, descriptor)
          || !validateCoordinatorProtectedRecord(record)) {
        throw memorySourceError('source_changed', 'coordinator pin mismatch', { retryable: true });
      }
      const physicalRoot = await resolvePinnedPhysicalRoot({
        record,
        operationRoot,
        descriptor,
      });
      throwIfAborted(expectations.signal);
      const opened = await openRecordedProtectedFiles(physicalRoot, record, {
        signal: expectations.signal,
      });
      openedFiles = opened.openedFiles;
      const processOwner = await currentProcessPinOwnerIdentity();
      throwIfAborted(expectations.signal);
      await processHooks.beforeProcessPinPublish?.({
        operationRoot,
        pinFile,
        descriptor,
      });
      throwIfAborted(expectations.signal);
      releaseProcessPinUnderLock = await acquireProcessPin(pinFile, pinDir, {
        version: 1,
        operationId,
        requesterAgent: record.requesterAgent,
        canonicalRoot: descriptor.canonicalRoot,
        generation: descriptor.generation,
        revision: descriptor.cutoffRevision,
        digest: expectedDigest,
        protectedFiles: [...record.protectedFiles],
        committedBytes: record.committedBytes,
        pid: process.pid,
        processIdentity: processPinIdentity,
        bootToken: processOwner.bootToken,
        processStartToken: processOwner.processStartToken,
      });
      try {
        source = await openMemorySource(physicalRoot, {
          ...expectations,
          pinnedManifest: opened.manifest,
          logicalCanonicalRoot: descriptor.canonicalRoot,
          legacySourceFingerprint: record.sourceFingerprint || null,
          [PINNED_OPENED_FILES]: openedFiles,
        });
      } catch (error) {
        await closeProtectedFiles(openedFiles);
        openedFiles = null;
        await releaseProcessPinUnderLock();
        releaseProcessPinUnderLock = null;
        throw error;
      }
    });
  } catch (error) {
    await source?.close?.().catch(() => {});
    await closeProtectedFiles(openedFiles).catch(() => {});
    if (releaseProcessPinUnderLock) {
      await withMemorySourceLock(descriptor.canonicalRoot, { lockRoot }, async () => {
        await releaseProcessPinUnderLock();
      }).catch(() => {});
    }
    throw error;
  }
  const releaseProcessPin = async () => withMemorySourceLock(
    descriptor.canonicalRoot,
    { lockRoot },
    async () => releaseProcessPinUnderLock(),
  );
  const closeSource = source.close.bind(source);
  const mutation = attachPinnedSourceMutation(source, {
    descriptor,
    record,
    operationRoot,
    operationId,
    requesterAgent: expectations.requesterAgent,
    expectedDigest,
    expectations,
  });
  let closePromise = null;
  const closeOnce = () => {
    mutation.requestRelease();
    closePromise ||= Promise.resolve()
      .then(() => mutation.waitForMutation())
      .then(() => closeSource());
    return closePromise;
  };
  let releasePromise = null;
  return Object.assign(source, {
    descriptor,
    compareAndSwap: mutation.compareAndSwap,
    async release() {
      releasePromise ||= (async () => {
        try {
          await closeOnce();
        } finally {
          await releaseProcessPin();
        }
      })();
      return releasePromise;
    },
    async close() { await closeOnce(); },
  });
}

function sourceLockIdentity(stat) {
  return Object.freeze({ dev: String(stat.dev), ino: String(stat.ino) });
}

function sameSourceLockIdentity(stat, expected) {
  return Boolean(stat && expected
    && String(stat.dev) === expected.dev
    && String(stat.ino) === expected.ino);
}

async function sourceLockLstatOptional(filePath) {
  return fsp.lstat(filePath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function fsyncSourceLockDirectory(directory) {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertStableSourceLockDirectory(directory, expected, label) {
  const stat = await sourceLockLstatOptional(directory);
  if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()
      || !sameSourceLockIdentity(stat, expected)) {
    throw memorySourceError('invalid_memory_source', `${label} identity changed`, {
      retryable: false,
    });
  }
  return stat;
}

async function readPublishedSourceLock(lockDir, lockIdentity, canonicalRoot) {
  try {
    await assertStableSourceLockDirectory(lockDir, lockIdentity, 'source lock');
    const entries = await fsp.readdir(lockDir);
    if (entries.length !== 1 || entries[0] !== 'owner.json') return null;
    const ownerPath = path.join(lockDir, 'owner.json');
    const before = await sourceLockLstatOptional(ownerPath);
    if (before === null || before.isSymbolicLink() || !before.isFile()
        || before.size > SOURCE_LOCK_OWNER_BYTES) return null;
    const ownerIdentity = sourceLockIdentity(before);
    let handle;
    try {
      handle = await fsp.open(
        ownerPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== before.size
          || !sameSourceLockIdentity(opened, ownerIdentity)) return null;
      const text = await handle.readFile('utf8');
      const after = await sourceLockLstatOptional(ownerPath);
      if (after === null || after.isSymbolicLink() || !after.isFile()
          || !sameSourceLockIdentity(after, ownerIdentity)) return null;
      await assertStableSourceLockDirectory(lockDir, lockIdentity, 'source lock');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return null;
      }
      const owner = validateSourceLockOwner(parsed, canonicalRoot);
      return owner ? Object.freeze({ owner, ownerIdentity }) : null;
    } finally {
      await handle?.close().catch(() => {});
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function removeExactSourceLockDirectory(directory, directoryIdentity, files) {
  const stat = await sourceLockLstatOptional(directory);
  if (stat === null) return true;
  if (stat.isSymbolicLink() || !stat.isDirectory()
      || !sameSourceLockIdentity(stat, directoryIdentity)) return false;
  const entries = await fsp.readdir(directory);
  if (entries.length !== files.size || entries.some((name) => !files.has(name))) return false;
  for (const name of entries) {
    const filePath = path.join(directory, name);
    const fileStat = await sourceLockLstatOptional(filePath);
    const expected = files.get(name);
    if (fileStat === null || fileStat.isSymbolicLink() || !fileStat.isFile()
        || !sameSourceLockIdentity(fileStat, expected)) return false;
  }
  for (const name of entries) await fsp.unlink(path.join(directory, name));
  const latest = await sourceLockLstatOptional(directory);
  if (latest === null) return true;
  if (latest.isSymbolicLink() || !latest.isDirectory()
      || !sameSourceLockIdentity(latest, directoryIdentity)) return false;
  await fsp.rmdir(directory);
  return true;
}

async function moveExactSourceLockDirectory(directory, directoryIdentity, destination) {
  const before = await sourceLockLstatOptional(directory);
  if (before === null || before.isSymbolicLink() || !before.isDirectory()
      || !sameSourceLockIdentity(before, directoryIdentity)) return false;
  try {
    await fsp.rename(directory, destination);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  const moved = await sourceLockLstatOptional(destination);
  if (moved === null || moved.isSymbolicLink() || !moved.isDirectory()
      || !sameSourceLockIdentity(moved, directoryIdentity)) {
    throw memorySourceError('invalid_memory_source', 'source lock moved a different identity', {
      retryable: false,
    });
  }
  return true;
}

async function withMemorySourceLock(canonicalRoot, options = {}, callback) {
  const {
    lockRoot,
    signal,
    lockRetryMs = 10,
    lockJitterMs = 10,
    lockTimeoutMs = 30_000,
    isProcessAlive = defaultIsSourceLockOwnerAlive,
    clock = Date,
    random = Math.random,
    _testHooks = {},
  } = options || {};
  if (typeof callback !== 'function'
      || !Number.isSafeInteger(lockRetryMs) || lockRetryMs < 0
      || !Number.isSafeInteger(lockJitterMs) || lockJitterMs < 0
      || !Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0
      || typeof isProcessAlive !== 'function'
      || typeof clock?.now !== 'function'
      || typeof random !== 'function'
      || !_testHooks || Array.isArray(_testHooks) || typeof _testHooks !== 'object'
      || Object.values(_testHooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid source lock coordination options');
  }
  throwIfAborted(signal);
  const canonical = await fsp.realpath(canonicalRoot);
  const root = await assertOperationRoot(lockRoot);
  const relative = path.relative(canonical, root);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw memorySourceError('invalid_request', 'lock root must be outside target');
  }
  const rootStat = await fsp.lstat(root);
  const rootIdentity = sourceLockIdentity(rootStat);
  const lockDir = path.join(root, canonicalRootHash(canonical));
  const startedAt = clock.now();
  const owner = await createSourceLockOwner(canonical, startedAt);
  const ownerText = `${JSON.stringify(owner)}\n`;
  if (Buffer.byteLength(ownerText, 'utf8') > SOURCE_LOCK_OWNER_BYTES) {
    throw memorySourceError('invalid_request', 'source lock owner record is too large');
  }

  async function assertStableLockRoot() {
    return assertStableSourceLockDirectory(root, rootIdentity, 'source lock root');
  }

  async function waitForRetry(reason) {
    throwIfAborted(signal);
    const elapsedMs = Math.max(0, clock.now() - startedAt);
    if (elapsedMs >= lockTimeoutMs) {
      throw memorySourceError('source_busy', 'source lock busy', {
        retryable: true,
        reason,
      });
    }
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw memorySourceError('invalid_request', 'source lock random sample is invalid');
    }
    const jitter = Math.floor(sample * (lockJitterMs + 1));
    const delayMs = Math.min(lockRetryMs + jitter, lockTimeoutMs - elapsedMs);
    if (delayMs <= 0) {
      throw memorySourceError('source_busy', 'source lock busy', {
        retryable: true,
        reason,
      });
    }
    await _testHooks.beforeLockRetry?.({
      canonicalRoot: canonical,
      lockDir,
      delayMs,
      elapsedMs,
      reason,
    });
    await abortableDelay(delayMs, signal);
  }

  async function quarantinePublishedLock(lockIdentity, ownerIdentity, suffix) {
    await assertStableLockRoot();
    const quarantine = `${lockDir}.${suffix}-${process.pid}-${crypto.randomUUID()}`;
    if (!await moveExactSourceLockDirectory(lockDir, lockIdentity, quarantine)) return false;
    await fsyncSourceLockDirectory(root);
    const removed = await removeExactSourceLockDirectory(
      quarantine,
      lockIdentity,
      new Map([['owner.json', ownerIdentity]]),
    );
    if (!removed) {
      throw memorySourceError('invalid_memory_source', 'source lock quarantine changed', {
        retryable: false,
      });
    }
    await fsyncSourceLockDirectory(root);
    return true;
  }

  async function inspectPublishedLock() {
    await assertStableLockRoot();
    const stat = await sourceLockLstatOptional(lockDir);
    if (stat === null) return false;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await waitForRetry('published_lock_invalid');
      return true;
    }
    const lockIdentity = sourceLockIdentity(stat);
    const snapshot = await readPublishedSourceLock(lockDir, lockIdentity, canonical)
      .catch((error) => {
        if (error.code === 'invalid_memory_source') return null;
        throw error;
      });
    if (snapshot === null) {
      await waitForRetry('published_owner_invalid');
      return true;
    }
    let alive = null;
    try {
      const inspected = await isProcessAlive(snapshot.owner);
      if (inspected === true || inspected === false) alive = inspected;
    } catch {
      alive = null;
    }
    if (alive !== false) {
      await waitForRetry('published_owner_alive_or_unknown');
      return true;
    }
    const latest = await readPublishedSourceLock(lockDir, lockIdentity, canonical)
      .catch((error) => {
        if (error.code === 'invalid_memory_source') return null;
        throw error;
      });
    if (latest === null
        || !sameSourceLockIdentity(
          { dev: latest.ownerIdentity.dev, ino: latest.ownerIdentity.ino },
          snapshot.ownerIdentity,
        )
        || canonicalJson(latest.owner) !== canonicalJson(snapshot.owner)) {
      await waitForRetry('published_lock_turned_over');
      return true;
    }
    if (!await quarantinePublishedLock(lockIdentity, snapshot.ownerIdentity, 'stale')) {
      await waitForRetry('published_lock_turned_over');
      return true;
    }
    await _testHooks.afterStaleLockRecovered?.({
      canonicalRoot: canonical,
      lockDir,
      owner: snapshot.owner,
    });
    return true;
  }

  async function acquire() {
    async function cleanupUnpublishedCandidate(candidateDir, candidateIdentity, files) {
      if (!candidateIdentity) return;
      const removed = await removeExactSourceLockDirectory(
        candidateDir,
        candidateIdentity,
        files,
      );
      if (!removed) {
        throw memorySourceError('invalid_memory_source', 'source lock candidate cleanup changed', {
          retryable: false,
        });
      }
      await fsyncSourceLockDirectory(root);
    }

    for (;;) {
      throwIfAborted(signal);
      await assertStableLockRoot();
      if (await inspectPublishedLock()) continue;
      const candidateDir = `${lockDir}.candidate-${process.pid}-${crypto.randomUUID()}`;
      const ownerTemporaryName = `.owner.${process.pid}.${crypto.randomUUID()}.tmp`;
      let candidateIdentity = null;
      let ownerIdentity = null;
      let ownerTemporaryIdentity = null;
      let ownerHandle = null;
      let published = false;
      try {
        await fsp.mkdir(candidateDir, { mode: 0o700 });
        const candidateStat = await fsp.lstat(candidateDir);
        if (candidateStat.isSymbolicLink() || !candidateStat.isDirectory()) {
          throw memorySourceError('invalid_memory_source', 'source lock candidate is invalid', {
            retryable: false,
          });
        }
        candidateIdentity = sourceLockIdentity(candidateStat);
        const ownerTemporaryPath = path.join(candidateDir, ownerTemporaryName);
        ownerHandle = await fsp.open(
          ownerTemporaryPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | (fs.constants.O_NOFOLLOW || 0),
          0o600,
        );
        const openedOwner = await ownerHandle.stat();
        if (!openedOwner.isFile()) {
          throw memorySourceError('invalid_memory_source', 'source lock owner candidate is invalid', {
            retryable: false,
          });
        }
        ownerTemporaryIdentity = sourceLockIdentity(openedOwner);
        await ownerHandle.writeFile(ownerText, 'utf8');
        await ownerHandle.sync();
        await _testHooks.afterOwnerFsync?.({
          canonicalRoot: canonical,
          candidateDir,
          ownerTemporaryPath,
        });
        await ownerHandle.close();
        ownerHandle = null;
        await _testHooks.beforeOwnerRename?.({
          canonicalRoot: canonical,
          candidateDir,
          ownerTemporaryPath,
        });
        const ownerTemporaryStat = await fsp.lstat(ownerTemporaryPath);
        if (ownerTemporaryStat.isSymbolicLink() || !ownerTemporaryStat.isFile()
            || !sameSourceLockIdentity(ownerTemporaryStat, ownerTemporaryIdentity)) {
          throw memorySourceError('invalid_memory_source', 'source lock owner candidate changed', {
            retryable: false,
          });
        }
        const ownerPath = path.join(candidateDir, 'owner.json');
        await fsp.rename(ownerTemporaryPath, ownerPath);
        ownerIdentity = ownerTemporaryIdentity;
        ownerTemporaryIdentity = null;
        await fsyncSourceLockDirectory(candidateDir);
        await assertStableSourceLockDirectory(
          candidateDir,
          candidateIdentity,
          'source lock candidate',
        );
        const candidateSnapshot = await readPublishedSourceLock(
          candidateDir,
          candidateIdentity,
          canonical,
        );
        if (candidateSnapshot === null
            || canonicalJson(candidateSnapshot.owner) !== canonicalJson(owner)) {
          throw memorySourceError('invalid_memory_source', 'source lock candidate owner changed', {
            retryable: false,
          });
        }
        ownerIdentity = candidateSnapshot.ownerIdentity;
        await _testHooks.beforeFinalDirectoryRename?.({
          canonicalRoot: canonical,
          candidateDir,
          lockDir,
        });
        await assertStableLockRoot();
        if (await sourceLockLstatOptional(lockDir) !== null) {
          await cleanupUnpublishedCandidate(
            candidateDir,
            candidateIdentity,
            new Map([['owner.json', ownerIdentity]]),
          );
          candidateIdentity = null;
          continue;
        }
        try {
          await fsp.rename(candidateDir, lockDir);
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
          await cleanupUnpublishedCandidate(
            candidateDir,
            candidateIdentity,
            new Map([['owner.json', ownerIdentity]]),
          );
          candidateIdentity = null;
          continue;
        }
        published = true;
        const publishedStat = await fsp.lstat(lockDir);
        if (publishedStat.isSymbolicLink() || !publishedStat.isDirectory()
            || !sameSourceLockIdentity(publishedStat, candidateIdentity)) {
          throw memorySourceError('invalid_memory_source', 'source lock publication changed', {
            retryable: false,
          });
        }
        await fsyncSourceLockDirectory(root);
        await _testHooks.afterFinalDirectoryRename?.({
          canonicalRoot: canonical,
          lockDir,
        });
        return Object.freeze({ lockIdentity: candidateIdentity, ownerIdentity });
      } catch (error) {
        await ownerHandle?.close().catch(() => {});
        try {
          if (!published && candidateIdentity) {
            const files = new Map();
            if (ownerTemporaryIdentity) files.set(ownerTemporaryName, ownerTemporaryIdentity);
            if (ownerIdentity) files.set('owner.json', ownerIdentity);
            await cleanupUnpublishedCandidate(candidateDir, candidateIdentity, files);
          } else if (published && candidateIdentity && ownerIdentity) {
            if (!await quarantinePublishedLock(
              candidateIdentity,
              ownerIdentity,
              'failed-publication',
            )) {
              throw memorySourceError(
                'invalid_memory_source',
                'published source lock cleanup changed',
                { retryable: false },
              );
            }
          }
        } catch (cleanupError) {
          throw memorySourceError('invalid_memory_source', 'source lock cleanup failed closed', {
            retryable: false,
            cause: cleanupError,
            acquisitionCause: error,
          });
        }
        throw error;
      }
    }
  }

  const acquired = await acquire();
  try {
    return await callback();
  } finally {
    await assertStableLockRoot();
    const snapshot = await readPublishedSourceLock(
      lockDir,
      acquired.lockIdentity,
      canonical,
    );
    if (snapshot === null
        || !sameSourceLockIdentity(
          { dev: snapshot.ownerIdentity.dev, ino: snapshot.ownerIdentity.ino },
          acquired.ownerIdentity,
        )
        || canonicalJson(snapshot.owner) !== canonicalJson(owner)) {
      throw memorySourceError('invalid_memory_source', 'source lock ownership changed before release', {
        retryable: false,
      });
    }
    if (!await quarantinePublishedLock(
      acquired.lockIdentity,
      acquired.ownerIdentity,
      'release',
    )) {
      throw memorySourceError('invalid_memory_source', 'source lock disappeared before release', {
        retryable: false,
      });
    }
    try {
      await _testHooks.afterLockReleased?.({
        canonicalRoot: canonical,
        lockDir,
      });
    } catch (cause) {
      throw memorySourceError(
        'invalid_memory_source',
        'source lock post-release observer failed',
        {
          retryable: false,
          sourceLockReleased: true,
          cause,
        },
      );
    }
  }
}

async function discoverOperationPinFiles(home23Root) {
  const root = await fsp.realpath(home23Root);
  const instances = path.join(root, 'instances');
  const results = [];
  const agents = await fsp.readdir(instances, { withFileTypes: true }).catch(() => []);
  for (const agent of agents) {
    if (!agent.isDirectory() || !/^[A-Za-z0-9_.-]+$/.test(agent.name)) continue;
    const brainOperationsRoot = path.join(instances, agent.name, 'runtime', 'brain-operations');
    const containers = [
      { root: path.join(brainOperationsRoot, 'operations'), excludedName: null },
      { root: brainOperationsRoot, excludedName: 'operations' },
    ];
    for (const container of containers) {
      const containerStat = await fsp.lstat(container.root).catch(() => null);
      if (!containerStat?.isDirectory() || containerStat.isSymbolicLink()
          || await fsp.realpath(container.root).catch(() => null) !== container.root) continue;
      const operations = await fsp.readdir(container.root, { withFileTypes: true }).catch(() => []);
      for (const operation of operations) {
        if (operation.name === container.excludedName
            || !operation.isDirectory()
            || !/^[A-Za-z0-9_.-]+$/.test(operation.name)) continue;
        const operationRoot = path.join(container.root, operation.name);
        const operationStat = await fsp.lstat(operationRoot).catch(() => null);
        if (!operationStat?.isDirectory() || operationStat.isSymbolicLink()
            || await fsp.realpath(operationRoot).catch(() => null) !== operationRoot) continue;
        const coordinator = path.join(operationRoot, 'coordinator-source-pin.json');
        const coordinatorStat = await fsp.lstat(coordinator).catch(() => null);
        if (coordinatorStat?.isFile() && !coordinatorStat.isSymbolicLink()) {
          results.push({
            kind: 'coordinator',
            requesterAgent: agent.name,
            operationId: operation.name,
            path: coordinator,
          });
        }
        const pinsRoot = path.join(operationRoot, 'pins');
        const pinsStat = await fsp.lstat(pinsRoot).catch(() => null);
        if (!pinsStat?.isDirectory() || pinsStat.isSymbolicLink()
            || await fsp.realpath(pinsRoot).catch(() => null) !== pinsRoot) continue;
        const processes = await fsp.readdir(pinsRoot, { withFileTypes: true }).catch(() => []);
        for (const processDir of processes) {
          if (!processDir.isDirectory() || !/^[A-Za-z0-9_.-]+$/.test(processDir.name)) continue;
          const processRoot = path.join(pinsRoot, processDir.name);
          const processStat = await fsp.lstat(processRoot).catch(() => null);
          if (!processStat?.isDirectory() || processStat.isSymbolicLink()
              || await fsp.realpath(processRoot).catch(() => null) !== processRoot) continue;
          const files = await fsp.readdir(processRoot, { withFileTypes: true }).catch(() => []);
          for (const file of files) {
            if (file.isFile() && /^[a-f0-9]{64}\.json$/.test(file.name)) {
              results.push({
                kind: 'process',
                requesterAgent: agent.name,
                operationId: operation.name,
                processIdentity: processDir.name,
                path: path.join(processRoot, file.name),
              });
            }
          }
        }
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function pruneStalePins(home23Root, {
  getOperationState = async () => null,
  isProcessAlive = defaultIsProcessPinAlive,
} = {}) {
  const canonicalHome23Root = await fsp.realpath(home23Root);
  const lockRoot = path.join(canonicalHome23Root, 'runtime', 'brain-source-locks');
  const discovered = await discoverOperationPinFiles(canonicalHome23Root);
  const removed = [];
  for (const file of discovered) {
    if (file.kind !== 'process') continue;
    const confinement = await captureProcessPinConfinement(file.path);
    const record = await readConfinedProcessPinRecord(confinement);
    const sourceRoot = typeof record?.canonicalRoot === 'string'
      && path.isAbsolute(record.canonicalRoot)
      && path.normalize(record.canonicalRoot) === record.canonicalRoot
      && await fsp.realpath(record.canonicalRoot).catch(() => null) === record.canonicalRoot
      ? record.canonicalRoot
      : null;
    const inspectAndRemove = async () => {
      const currentConfinement = await captureProcessPinConfinement(file.path);
      const current = await readConfinedProcessPinRecord(currentConfinement);
      if (canonicalJson(current) !== canonicalJson(record)) return;
      const alive = await isProcessAlive(current);
      const state = await getOperationState(file.operationId);
      const terminal = state === null
        || ['complete', 'partial', 'failed', 'cancelled', 'interrupted'].includes(state);
      if (alive === false && terminal) {
        await removeExactProcessPin(currentConfinement);
        removed.push(file.path);
      }
    };
    if (sourceRoot) {
      await withMemorySourceLock(sourceRoot, { lockRoot }, inspectAndRemove);
    } else {
      // Legacy incomplete records cannot identify a source lock. They are
      // migration-only and retain the exact operation-root confinement checks.
      await inspectAndRemove();
    }
  }
  return removed;
}

async function removeExactOperationRegularFile(operationRoot, operationIdentity, filePath, label) {
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  const stat = await operationPathLstatOptional(filePath);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw memorySourceError('invalid_memory_source', `${label} is not a regular file`, {
      retryable: false,
    });
  }
  const identity = operationPathIdentity(stat);
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  const latest = await operationPathLstatOptional(filePath);
  if (latest === null || latest.isSymbolicLink() || !latest.isFile()
      || !sameOperationPathIdentity(latest, identity)) {
    throw memorySourceError('invalid_memory_source', `${label} identity changed`, {
      retryable: false,
    });
  }
  await fsp.unlink(filePath);
  await fsyncSourceLockDirectory(operationRoot);
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  return true;
}

async function removeExactOperationDirectoryTree(operationRoot, operationIdentity, directory, label) {
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  const stat = await operationPathLstatOptional(directory);
  if (stat === null) return false;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw memorySourceError('invalid_memory_source', `${label} is not a directory`, {
      retryable: false,
    });
  }
  const identity = operationPathIdentity(stat);
  const quarantine = path.join(
    operationRoot,
    `.source-release-${path.basename(directory)}-${process.pid}-${crypto.randomUUID()}`,
  );
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  await fsp.rename(directory, quarantine);
  await fsyncSourceLockDirectory(operationRoot);
  const moved = await operationPathLstatOptional(quarantine);
  if (moved === null || moved.isSymbolicLink() || !moved.isDirectory()
      || !sameOperationPathIdentity(moved, identity)) {
    throw memorySourceError('invalid_memory_source', `${label} identity changed`, {
      retryable: false,
    });
  }
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  await fsp.rm(quarantine, { recursive: true, force: false });
  await fsyncSourceLockDirectory(operationRoot);
  await assertExactOperationDirectory(operationRoot, operationIdentity, 'operation root');
  return true;
}

async function releaseOperationSource({ home23Root, requesterAgent, operationId }) {
  const canonicalHome23Root = await fsp.realpath(home23Root);
  const operationRoot = durableBrainOperationRoot(
    canonicalHome23Root,
    requesterAgent,
    operationId,
  );
  const operationIdentity = await captureExactOperationDirectory(
    operationRoot,
    'operation root',
    { optional: true },
  );
  if (operationIdentity === null) return;
  const pinsRoot = path.join(operationRoot, 'pins');
  const coordinator = await readCoordinatorRecord(operationRoot).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  const sourceRoot = typeof coordinator?.canonicalRoot === 'string'
    && path.isAbsolute(coordinator.canonicalRoot)
    && path.normalize(coordinator.canonicalRoot) === coordinator.canonicalRoot
    && await fsp.realpath(coordinator.canonicalRoot).catch(() => null) === coordinator.canonicalRoot
    ? coordinator.canonicalRoot
    : null;
  const cleanup = async () => {
    await removeExactOperationRegularFile(
      operationRoot,
      operationIdentity,
      coordinatorPinPath(operationRoot),
      'coordinator source pin',
    );
    await removeExactOperationDirectoryTree(
      operationRoot,
      operationIdentity,
      pinsRoot,
      'process pins root',
    );
    await removeExactOperationDirectoryTree(
      operationRoot,
      operationIdentity,
      path.join(operationRoot, 'source-projections'),
      'source projections root',
    );
    for (const pinFile of processPinReferences.keys()) {
      const relative = path.relative(pinsRoot, pinFile);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        processPinReferences.delete(pinFile);
      }
    }
  };
  if (sourceRoot) {
    await withMemorySourceLock(sourceRoot, {
      lockRoot: path.join(canonicalHome23Root, 'runtime', 'brain-source-locks'),
    }, cleanup);
  } else {
    await cleanup();
  }
}

function createMemorySourcePinProvider({ home23Root, requesterAgent }) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw memorySourceError('invalid_request', 'trusted home23 root required');
  }
  if (typeof requesterAgent !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(requesterAgent)) {
    throw memorySourceError('invalid_request', 'safe requester required');
  }
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  const ownBrainPath = path.join(home23Root, 'instances', requesterAgent, 'brain');
  const providerContext = Object.freeze({ lockRoot, ownBrainPath });
  return Object.freeze({
    async pin(canonicalRoot, operationId) {
      const operationRoot = durableBrainOperationRoot(home23Root, requesterAgent, operationId);
      const scratchQuota = await createOperationScratchQuota({ operationRoot });
      try {
        return await pinOperationSource({
          canonicalRoot,
          operationRoot,
          operationId,
          requesterAgent,
          lockRoot,
          scratchQuota,
        });
      } finally {
        await scratchQuota.close();
      }
    },
    async openPinnedSource(descriptor, expectations) {
      const operationId = validateOperationId(expectations?.operationId);
      const operationRoot = durableBrainOperationRoot(home23Root, requesterAgent, operationId);
      return openPinnedSource(descriptor, {
        ...expectations,
        operationId,
        operationRoot,
        requesterAgent,
        [TRUSTED_PROVIDER_CONTEXT]: providerContext,
      });
    },
    async releaseOperationPins(operationId) {
      return releaseOperationSource({ home23Root, requesterAgent, operationId });
    },
  });
}

module.exports = {
  validateOperationId,
  durableBrainOperationRoot,
  coordinatorPinPath,
  withMemorySourceLock,
  pinOperationSource,
  openPinnedSource,
  createMemorySourcePinProvider,
  discoverOperationPinFiles,
  pruneStalePins,
  releaseOperationSource,
};
