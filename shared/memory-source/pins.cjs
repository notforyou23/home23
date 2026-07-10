'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { readManifest } = require('./manifest.cjs');
const { createDescriptor, openMemorySource } = require('./reader.cjs');
const {
  sourceDescriptorDigest,
  memorySourceError,
} = require('./contracts.cjs');
const { assertOperationRoot } = require('./scratch-quota.cjs');

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

async function pinOperationSource({ canonicalRoot, operationRoot, operationId, requesterAgent }) {
  validateOperationId(operationId);
  const canonical = await fsp.realpath(canonicalRoot);
  const root = await assertOperationRoot(operationRoot);
  const existing = await fsp.readFile(coordinatorPinPath(root), 'utf8').catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    const record = JSON.parse(existing);
    if (record.canonicalRoot !== canonical || record.operationId !== operationId
        || record.requesterAgent !== requesterAgent
        || record.digest !== sourceDescriptorDigest(record.descriptor)) {
      throw memorySourceError('source_pin_conflict', 'source pin conflict');
    }
    return Object.freeze({ descriptor: record.descriptor, digest: record.digest });
  }
  const manifest = await readManifest(canonical);
  if (!manifest) throw memorySourceError('source_unavailable', 'source unavailable', { retryable: true });
  const descriptor = createDescriptor(canonical, manifest);
  const digest = sourceDescriptorDigest(descriptor);
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
    physicalRoot: canonical,
  };
  await writeAtomicJson(coordinatorPinPath(root), record);
  return Object.freeze({ descriptor, digest });
}

function processIdentity() {
  return `pid-${process.pid}`;
}

async function openPinnedSource(descriptor, expectations = {}) {
  if (!descriptor || descriptor.version !== 1) {
    throw memorySourceError('invalid_request', 'numeric v1 descriptor required');
  }
  const operationRoot = await assertOperationRoot(expectations.operationRoot);
  if (!expectations.scratchQuota || expectations.scratchQuota.operationRoot !== operationRoot) {
    throw memorySourceError('invalid_request', 'scratch quota for exact operation root required');
  }
  const expectedDigest = expectations.expectedDigest || sourceDescriptorDigest(descriptor);
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
  if (record.digest !== expectedDigest || record.canonicalRoot !== descriptor.canonicalRoot) {
    throw memorySourceError('source_changed', 'coordinator pin mismatch', { retryable: true });
  }
  const pinDir = path.join(operationRoot, 'pins', processIdentity());
  const pinFile = path.join(pinDir, `${canonicalRootHash(descriptor.canonicalRoot)}.json`);
  await writeAtomicJson(pinFile, {
    version: 1,
    operationId: expectations.operationId || record.operationId,
    requesterAgent: record.requesterAgent,
    canonicalRoot: descriptor.canonicalRoot,
    generation: descriptor.generation,
    revision: descriptor.cutoffRevision,
    digest: expectedDigest,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  }).catch(async (error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const source = await openMemorySource(record.physicalRoot, expectations);
  const closeSource = source.close.bind(source);
  const release = async () => {
    await fsp.rm(pinFile, { force: true }).catch(() => {});
    await fsp.rmdir(pinDir).catch(() => {});
  };
  return Object.assign(source, {
    descriptor,
    async release() {
      await release();
      await closeSource();
    },
    async close() { await closeSource(); },
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
  await fsp.rm(coordinatorPinPath(operationRoot), { force: true }).catch(() => {});
  await fsp.rm(path.join(operationRoot, 'pins'), { recursive: true, force: true }).catch(() => {});
  await fsp.rm(path.join(operationRoot, 'source-projections'), { recursive: true, force: true }).catch(() => {});
}

function createMemorySourcePinProvider({ home23Root, requesterAgent }) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw memorySourceError('invalid_request', 'trusted home23 root required');
  }
  if (typeof requesterAgent !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(requesterAgent)) {
    throw memorySourceError('invalid_request', 'safe requester required');
  }
  return Object.freeze({
    async pin(canonicalRoot, operationId) {
      validateOperationId(operationId);
      const operationRoot = path.join(home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations', operationId);
      return pinOperationSource({ canonicalRoot, operationRoot, operationId, requesterAgent });
    },
    async openPinnedSource(descriptor, expectations) {
      return openPinnedSource(descriptor, expectations);
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
