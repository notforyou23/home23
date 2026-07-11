'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { readManifest, validateManifest } = require('./manifest.cjs');
const { createDescriptor, openMemorySource } = require('./reader.cjs');
const { projectLegacyResidentSidecars } = require('./legacy-projection.cjs');
const { readConfinedFile } = require('./confined-file.cjs');
const {
  canonicalJson,
  sourceDescriptorDigest,
  memorySourceError,
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
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(operationId)) {
    throw memorySourceError('invalid_request', 'safe operation id required');
  }
  return operationId;
}

function canonicalRootHash(canonicalRoot) {
  return crypto.createHash('sha256').update(canonicalRoot).digest('hex');
}

function coordinatorPinPath(operationRoot) {
  return path.join(operationRoot, 'coordinator-source-pin.json');
}

async function writeAtomicJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(tmp, filePath);
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

async function pinOperationSource({
  canonicalRoot,
  operationRoot,
  operationId,
  requesterAgent,
  lockRoot,
  scratchQuota,
  signal,
}) {
  validateOperationId(operationId);
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
          || !descriptorMatchesDigest(record.descriptor, record.digest)) {
        throw memorySourceError('source_pin_conflict', 'source pin conflict');
      }
      return Object.freeze({ descriptor: record.descriptor, digest: record.digest });
    }
    let manifest = await readManifest(canonical);
    let descriptor;
    let physicalRoot = canonical;
    let sourceFingerprint = null;
    if (manifest) {
      descriptor = createDescriptor(canonical, manifest);
    } else {
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
      descriptor = projected.descriptor;
      physicalRoot = projected.projectionRoot;
      sourceFingerprint = projected.sourceFingerprint;
    }
    throwIfAborted(signal);
    const digest = sourceDescriptorDigest(descriptor);
    const physical = await inspectPhysicalRoot(physicalRoot);
    const record = {
      version: 1,
      operationId,
      requesterAgent,
      canonicalRoot: canonical,
      descriptor,
      digest,
      protectedFiles: [
        manifest.activeBase.nodes.file,
        manifest.activeBase.edges.file,
        manifest.activeDelta.file,
        manifest.ann.indexFile,
        manifest.ann.metaFile,
      ].filter(Boolean),
      committedBytes: manifest.activeDelta.committedBytes,
      physicalRoot,
      physicalRootIdentity: physicalIdentity(physical.stat),
      projectionRoot: sourceFingerprint ? physicalRoot : null,
      sourceFingerprint,
    };
    await writeAtomicJson(coordinatorPinPath(root), record);
    return Object.freeze({ descriptor, digest });
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

const processPinReferences = new Map();

function processPinRecordMatches(actual, expected) {
  return actual?.version === 1
    && actual.operationId === expected.operationId
    && actual.requesterAgent === expected.requesterAgent
    && actual.canonicalRoot === expected.canonicalRoot
    && actual.generation === expected.generation
    && actual.revision === expected.revision
    && actual.digest === expected.digest
    && actual.pid === expected.pid
    && actual.processIdentity === expected.processIdentity;
}

async function writeProcessPinExclusive(pinFile, record) {
  await fsp.mkdir(path.dirname(pinFile), { recursive: true, mode: 0o700 });
  try {
    await fsp.writeFile(pinFile, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let existing;
    try {
      existing = JSON.parse(await fsp.readFile(pinFile, 'utf8'));
    } catch (cause) {
      throw memorySourceError('source_pin_conflict', 'existing process pin is unreadable', {
        cause,
        retryable: true,
      });
    }
    if (!processPinRecordMatches(existing, record)) {
      throw memorySourceError('source_pin_conflict', 'existing process pin identity conflicts', {
        retryable: true,
      });
    }
  }
}

async function acquireProcessPin(pinFile, pinDir, record) {
  let entry = processPinReferences.get(pinFile);
  if (entry) {
    entry.references += 1;
    try {
      await entry.ready;
    } catch (error) {
      entry.references -= 1;
      throw error;
    }
  } else {
    entry = { references: 1, ready: null };
    processPinReferences.set(pinFile, entry);
    entry.ready = writeProcessPinExclusive(pinFile, record);
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
    await fsp.rm(pinFile, { force: true }).catch(() => {});
    await fsp.rmdir(pinDir).catch(() => {});
  };
}

function pinnedManifestFromDescriptor(descriptor) {
  const actualKeys = Object.keys(descriptor || {}).sort();
  const expectedKeys = [
    'activeBase',
    'activeDelta',
    'baseRevision',
    'canonicalRoot',
    'cutoffRevision',
    'generation',
    'summary',
    'version',
  ];
  if (actualKeys.length !== expectedKeys.length
      || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw memorySourceError('source_changed', 'descriptor shape mismatch', { retryable: true });
  }
  return validateManifest({
    formatVersion: 1,
    generation: descriptor.generation,
    baseRevision: descriptor.baseRevision,
    currentRevision: descriptor.cutoffRevision,
    activeDeltaEpoch: descriptor.activeDelta?.epoch,
    activeBase: descriptor.activeBase,
    activeDelta: descriptor.activeDelta,
    ann: { indexFile: null, metaFile: null, builtFromRevision: null },
    summary: descriptor.summary,
  });
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

  async function compareAndSwap(commit, options = {}) {
    if (typeof commit !== 'function') {
      throw memorySourceError('invalid_request', 'source CAS commit callback required');
    }
    if (!options || Array.isArray(options) || typeof options !== 'object'
        || Reflect.ownKeys(options).some((key) => key !== 'rollback')
        || (options.rollback !== undefined && typeof options.rollback !== 'function')) {
      throw memorySourceError('invalid_request', 'source CAS rollback contract is invalid');
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
        rollback: options.rollback,
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
      || !/^[A-Za-z0-9_.-]+$/.test(expectations.requesterAgent)) {
    throw memorySourceError('invalid_request', 'safe requester required');
  }
  const operationRoot = await assertOperationRoot(expectations.operationRoot);
  if (!expectations.scratchQuota || expectations.scratchQuota.operationRoot !== operationRoot) {
    throw memorySourceError('invalid_request', 'scratch quota for exact operation root required');
  }
  const pinnedManifest = pinnedManifestFromDescriptor(descriptor);
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
  const record = await readCoordinatorRecord(operationRoot).catch((error) => {
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
      || !descriptorsMatch(record.descriptor, descriptor)) {
    throw memorySourceError('source_changed', 'coordinator pin mismatch', { retryable: true });
  }
  const physicalRoot = await resolvePinnedPhysicalRoot({
    record,
    operationRoot,
    descriptor,
  });
  const processPinIdentity = validateProcessIdentity(expectations.processIdentity);
  const pinDir = path.join(operationRoot, 'pins', processPinIdentity);
  const pinFile = path.join(pinDir, `${canonicalRootHash(descriptor.canonicalRoot)}.json`);
  const releaseProcessPin = await acquireProcessPin(pinFile, pinDir, {
    version: 1,
    operationId,
    requesterAgent: record.requesterAgent,
    canonicalRoot: descriptor.canonicalRoot,
    generation: descriptor.generation,
    revision: descriptor.cutoffRevision,
    digest: expectedDigest,
    pid: process.pid,
    processIdentity: processPinIdentity,
    createdAt: new Date().toISOString(),
  });
  let source;
  try {
    source = await openMemorySource(physicalRoot, {
      ...expectations,
      pinnedManifest,
      logicalCanonicalRoot: descriptor.canonicalRoot,
      legacySourceFingerprint: record.sourceFingerprint || null,
    });
  } catch (error) {
    await releaseProcessPin();
    throw error;
  }
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
          await removeExactSourceLockDirectory(
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
          await removeExactSourceLockDirectory(
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
        if (!published && candidateIdentity) {
          const files = new Map();
          if (ownerTemporaryIdentity) files.set(ownerTemporaryName, ownerTemporaryIdentity);
          if (ownerIdentity) files.set('owner.json', ownerIdentity);
          await removeExactSourceLockDirectory(candidateDir, candidateIdentity, files).catch(() => {});
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
  }
}

async function discoverOperationPinFiles(home23Root) {
  const root = await fsp.realpath(home23Root);
  const instances = path.join(root, 'instances');
  const results = [];
  const agents = await fsp.readdir(instances, { withFileTypes: true }).catch(() => []);
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const operationsRoot = path.join(instances, agent.name, 'runtime', 'brain-operations');
    const operations = await fsp.readdir(operationsRoot, { withFileTypes: true }).catch(() => []);
    for (const operation of operations) {
      if (!operation.isDirectory() || !/^[A-Za-z0-9_.-]+$/.test(operation.name)) continue;
      const operationRoot = path.join(operationsRoot, operation.name);
      const coordinator = path.join(operationRoot, 'coordinator-source-pin.json');
      if (await fsp.access(coordinator).then(() => true).catch(() => false)) {
        results.push({ kind: 'coordinator', requesterAgent: agent.name, operationId: operation.name, path: coordinator });
      }
      const pinsRoot = path.join(operationRoot, 'pins');
      const processes = await fsp.readdir(pinsRoot, { withFileTypes: true }).catch(() => []);
      for (const processDir of processes) {
        if (!processDir.isDirectory()) continue;
        const files = await fsp.readdir(path.join(pinsRoot, processDir.name), { withFileTypes: true }).catch(() => []);
        for (const file of files) {
          if (file.isFile() && /^[a-f0-9]{64}\.json$/.test(file.name)) {
            results.push({
              kind: 'process',
              requesterAgent: agent.name,
              operationId: operation.name,
              processIdentity: processDir.name,
              path: path.join(pinsRoot, processDir.name, file.name),
            });
          }
        }
      }
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

async function pruneStalePins(home23Root, {
  getOperationState = async () => null,
  isProcessAlive = async () => true,
} = {}) {
  const discovered = await discoverOperationPinFiles(home23Root);
  const removed = [];
  for (const file of discovered) {
    if (file.kind !== 'process') continue;
    const record = JSON.parse(await fsp.readFile(file.path, 'utf8').catch(() => '{}'));
    const alive = await isProcessAlive(record);
    const state = await getOperationState(file.operationId);
    const terminal = state === null
      || ['complete', 'partial', 'failed', 'cancelled', 'interrupted'].includes(state);
    if (!alive && terminal) {
      await fsp.rm(file.path, { force: true });
      await fsp.rmdir(path.dirname(file.path)).catch(() => {});
      removed.push(file.path);
    }
  }
  return removed;
}

async function releaseOperationSource({ home23Root, requesterAgent, operationId }) {
  validateOperationId(operationId);
  const operationRoot = path.join(home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations', operationId);
  const pinsRoot = path.join(operationRoot, 'pins');
  for (const pinFile of processPinReferences.keys()) {
    const relative = path.relative(pinsRoot, pinFile);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
      processPinReferences.delete(pinFile);
    }
  }
  await fsp.rm(coordinatorPinPath(operationRoot), { force: true }).catch(() => {});
  await fsp.rm(pinsRoot, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(operationRoot, 'source-projections'), { recursive: true, force: true }).catch(() => {});
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
      validateOperationId(operationId);
      const operationRoot = path.join(home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations', operationId);
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
      const operationRoot = path.join(
        home23Root,
        'instances',
        requesterAgent,
        'runtime',
        'brain-operations',
        operationId,
      );
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
  coordinatorPinPath,
  withMemorySourceLock,
  pinOperationSource,
  openPinnedSource,
  createMemorySourcePinProvider,
  discoverOperationPinFiles,
  pruneStalePins,
  releaseOperationSource,
};
