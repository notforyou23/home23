'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
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

async function withMemorySourceLock(canonicalRoot, { lockRoot } = {}, callback) {
  const canonical = await fsp.realpath(canonicalRoot);
  const root = await assertOperationRoot(lockRoot);
  const relative = path.relative(canonical, root);
  if (!relative || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    throw memorySourceError('invalid_request', 'lock root must be outside target');
  }
  const lockDir = path.join(root, canonicalRootHash(canonical));
  await fsp.mkdir(lockDir, { mode: 0o700 }).catch((error) => {
    if (error.code === 'EEXIST') throw memorySourceError('source_busy', 'source lock busy', { retryable: true });
    throw error;
  });
  try {
    await fsp.writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify({
      pid: process.pid,
      canonicalRoot: canonical,
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    return await callback();
  } finally {
    await fsp.rm(lockDir, { recursive: true, force: true }).catch(() => {});
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
    const terminal = state === null || ['complete', 'failed', 'cancelled', 'interrupted'].includes(state);
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
