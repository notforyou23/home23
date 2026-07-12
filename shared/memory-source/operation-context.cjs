'use strict';

const fsp = require('node:fs').promises;
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { openMemorySource } = require('./reader.cjs');
const { withMemorySourceLock } = require('./pins.cjs');
const { createOperationScratchQuota } = require('./scratch-quota.cjs');
const { memorySourceError, throwIfAborted } = require('./contracts.cjs');

function safeSegment(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)
      || value === '.' || value === '..') {
    throw memorySourceError('invalid_request', `safe ${label} required`);
  }
  return value;
}

function invalidOperationTree(message, cause) {
  return memorySourceError('invalid_memory_source', message, {
    retryable: false,
    ...(cause ? { cause } : {}),
  });
}

function sameIdentity(stat, identity) {
  return Boolean(stat && identity && stat.dev === identity.dev && stat.ino === identity.ino);
}

async function lstatOptional(candidate) {
  return fsp.lstat(candidate, { bigint: true }).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
}

async function bindCanonicalDirectory(directory, label) {
  const before = await lstatOptional(directory);
  if (before === null || before.isSymbolicLink() || !before.isDirectory()) {
    throw invalidOperationTree(`${label} is not a nonsymlink directory`);
  }
  const canonical = await fsp.realpath(directory).catch((error) => {
    throw invalidOperationTree(`${label} canonicalization failed`, error);
  });
  const after = await lstatOptional(directory);
  if (after === null || after.isSymbolicLink() || !after.isDirectory()
      || !sameIdentity(after, before) || canonical !== directory) {
    throw invalidOperationTree(`${label} identity changed`);
  }
  return Object.freeze({ path: directory, dev: before.dev, ino: before.ino });
}

async function assertDirectoryBinding(binding, label) {
  const current = await lstatOptional(binding?.path);
  if (current === null || current.isSymbolicLink() || !current.isDirectory()
      || !sameIdentity(current, binding)
      || await fsp.realpath(binding.path).catch(() => null) !== binding.path) {
    throw invalidOperationTree(`${label} identity changed`);
  }
}

async function createCanonicalDirectoryChild(parent, segment, label) {
  await assertDirectoryBinding(parent, `${label} parent`);
  const child = path.join(parent.path, safeSegment(segment, label));
  await fsp.mkdir(child, { mode: 0o700 }).catch((error) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await assertDirectoryBinding(parent, `${label} parent`);
  return bindCanonicalDirectory(child, label);
}

function assertOperationPlacement(homeRoot, canonicalBrain, candidate) {
  const beneathHome = path.relative(homeRoot, candidate);
  const crossingBrain = path.relative(canonicalBrain, candidate);
  if (!beneathHome || beneathHome.startsWith('..') || path.isAbsolute(beneathHome)
      || !crossingBrain
      || (!crossingBrain.startsWith('..') && !path.isAbsolute(crossingBrain))) {
    throw invalidOperationTree('operation scratch placement is invalid');
  }
}

async function createOwnedOperationRoot(operationsDirectory, operationId) {
  await assertDirectoryBinding(operationsDirectory, 'operations root');
  const operationRoot = path.join(operationsDirectory.path, operationId);
  try {
    await fsp.mkdir(operationRoot, { mode: 0o700 });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw memorySourceError('source_busy', 'operation scratch already exists', {
        retryable: true,
      });
    }
    throw error;
  }
  await assertDirectoryBinding(operationsDirectory, 'operations root');
  return bindCanonicalDirectory(operationRoot, 'owned operation root');
}

async function restoreTurnedOverRoot(operationRoot, quarantine, moved) {
  if (await lstatOptional(operationRoot) !== null) return;
  await fsp.rename(quarantine, operationRoot);
  const restored = await lstatOptional(operationRoot);
  if (restored === null || !sameIdentity(restored, moved)) {
    throw invalidOperationTree('replacement operation root restoration changed identity');
  }
}

async function removeOwnedOperationRoot(operationsDirectory, identity, hooks) {
  if (!identity) return;
  await assertDirectoryBinding(operationsDirectory, 'operations root');
  const operationRoot = identity.path;
  const stat = await lstatOptional(operationRoot);
  if (stat === null) {
    throw invalidOperationTree('owned operation root disappeared before cleanup');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev !== identity.dev || stat.ino !== identity.ino) {
    throw invalidOperationTree('owned operation root identity changed');
  }
  await hooks.beforeOperationRootQuarantine?.({ operationRoot });
  await assertDirectoryBinding(operationsDirectory, 'operations root');
  const quarantine = path.join(
    operationsDirectory.path,
    `.${path.basename(operationRoot)}.cleanup-${process.pid}-${randomUUID()}`,
  );
  try {
    await fsp.rename(operationRoot, quarantine);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw invalidOperationTree('owned operation root disappeared before quarantine', error);
    }
    throw error;
  }
  await assertDirectoryBinding(operationsDirectory, 'operations root');
  const moved = await lstatOptional(quarantine);
  if (moved === null || moved.isSymbolicLink() || !moved.isDirectory()
      || !sameIdentity(moved, identity)) {
    if (moved !== null) await restoreTurnedOverRoot(operationRoot, quarantine, moved);
    throw invalidOperationTree('owned operation root changed before quarantine');
  }
  if (await lstatOptional(operationRoot) !== null) {
    throw invalidOperationTree('operation root pathname turned over during cleanup');
  }
  await fsp.rm(quarantine, { recursive: true, force: true });
  if (await lstatOptional(quarantine) !== null) {
    throw invalidOperationTree('owned operation root quarantine remained after cleanup');
  }
  await assertDirectoryBinding(operationsDirectory, 'operations root');
}

async function withEphemeralMemorySource({
  brainDir,
  home23Root,
  requesterAgent,
  identity = {},
  signal,
  prefix = 'local',
  uuid = randomUUID,
  _testHooks = {},
} = {}, callback) {
  if (typeof callback !== 'function') throw memorySourceError('invalid_request', 'callback required');
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)) {
    throw memorySourceError('invalid_request', 'trusted home23 root required');
  }
  if (!_testHooks || Array.isArray(_testHooks) || typeof _testHooks !== 'object'
      || Object.keys(_testHooks).some((key) => key !== 'beforeOperationRootQuarantine')
      || Object.values(_testHooks).some((hook) => typeof hook !== 'function')) {
    throw memorySourceError('invalid_request', 'invalid operation context test hooks');
  }
  const homeRoot = await fsp.realpath(home23Root).catch(async () => {
    await fsp.mkdir(home23Root, { recursive: true, mode: 0o700 });
    return fsp.realpath(home23Root);
  });
  const canonicalBrain = await fsp.realpath(brainDir);
  const safeRequester = safeSegment(requesterAgent, 'requester');
  const safePrefix = safeSegment(prefix, 'prefix');
  const intendedOperationsRoot = path.join(
    homeRoot,
    'instances',
    safeRequester,
    'runtime',
    'brain-operations',
  );
  const crossing = path.relative(canonicalBrain, intendedOperationsRoot);
  if (!crossing || (!crossing.startsWith('..') && !path.isAbsolute(crossing))) {
    throw memorySourceError('invalid_request', 'operation root must not cross target');
  }
  const homeDirectory = await bindCanonicalDirectory(homeRoot, 'home root');
  const instancesDirectory = await createCanonicalDirectoryChild(
    homeDirectory, 'instances', 'instances root',
  );
  const requesterDirectory = await createCanonicalDirectoryChild(
    instancesDirectory, safeRequester, 'requester runtime root',
  );
  const requesterRuntimeDirectory = await createCanonicalDirectoryChild(
    requesterDirectory, 'runtime', 'requester runtime directory',
  );
  const operationsDirectory = await createCanonicalDirectoryChild(
    requesterRuntimeDirectory, 'brain-operations', 'operations root',
  );
  assertOperationPlacement(homeRoot, canonicalBrain, operationsDirectory.path);
  const runtimeDirectory = await createCanonicalDirectoryChild(
    homeDirectory, 'runtime', 'home runtime root',
  );
  const sourceLockDirectory = await createCanonicalDirectoryChild(
    runtimeDirectory, 'brain-source-locks', 'source lock root',
  );
  const admissionLockDirectory = await createCanonicalDirectoryChild(
    runtimeDirectory,
    'brain-source-compatibility-admission-locks',
    'compatibility admission lock root',
  );
  const lockRoot = sourceLockDirectory.path;
  const admissionLockRoot = admissionLockDirectory.path;
  // Admit every compatibility open, not only sources currently detected as
  // legacy: preclassification would race a source transition into projection.
  return withMemorySourceLock(canonicalBrain, {
    lockRoot: admissionLockRoot,
    signal,
    lockRetryMs: 0,
    lockJitterMs: 0,
    lockTimeoutMs: 0,
  }, async () => {
    throwIfAborted(signal);
    const operationId = `${safePrefix}-${safeSegment(uuid(), 'uuid')}`;
    let operationIdentity = null;
    let scratchQuota = null;
    let source = null;
    try {
      operationIdentity = await createOwnedOperationRoot(operationsDirectory, operationId);
      const operationRoot = operationIdentity.path;
      assertOperationPlacement(homeRoot, canonicalBrain, operationRoot);
      scratchQuota = await createOperationScratchQuota({ operationRoot, signal });
      const effectiveIdentity = Object.freeze({
        ...identity,
        canonicalRoot: canonicalBrain,
        operationId,
      });
      source = await openMemorySource(canonicalBrain, {
        operationId,
        requesterAgent,
        identity: effectiveIdentity,
        signal,
        operationRoot,
        lockRoot,
        scratchQuota,
      });
      return await callback(source, {
        operationId,
        operationRoot,
        lockRoot,
        scratchQuota,
        identity: effectiveIdentity,
      });
    } finally {
      await source?.close?.().catch(() => {});
      scratchQuota?.close();
      await removeOwnedOperationRoot(operationsDirectory, operationIdentity, _testHooks);
    }
  });
}

function createInstalledLocalSourceContext({
  home23Root,
  requesterAgent,
  brainDir,
  activeRunPath = null,
  buildCatalog,
} = {}) {
  if (typeof home23Root !== 'string' || !path.isAbsolute(home23Root)
      || typeof brainDir !== 'string' || !path.isAbsolute(brainDir)) {
    throw memorySourceError('invalid_request', 'trusted roots required');
  }
  safeSegment(requesterAgent, 'requester');
  return Object.freeze({
    home23Root,
    requesterAgent,
    brainDir,
    async resolveTargetContext(selector = {}) {
      if (Object.keys(selector).length !== 0) {
        throw memorySourceError('invalid_request', 'public selectors are not accepted');
      }
      const canonicalRoot = await fsp.realpath(brainDir);
      const catalog = typeof buildCatalog === 'function' ? await buildCatalog() : { revision: 'local', entries: [] };
      const entries = catalog.entries || catalog.targets || [];
      const matches = entries.filter((entry) => entry?.canonicalRoot === canonicalRoot
        || entry?.target?.canonicalRoot === canonicalRoot);
      if (matches.length > 1) throw memorySourceError('invalid_request', 'ambiguous local source context');
      const target = matches[0]?.target || matches[0] || {
        canonicalRoot,
        requesterAgent,
        brainId: requesterAgent,
        kind: activeRunPath ? 'run' : 'resident',
      };
      return Object.freeze({
        catalogRevision: catalog.revision || catalog.catalogRevision || 'local',
        target: Object.freeze({ ...target, canonicalRoot }),
        accessMode: activeRunPath ? 'owned-run' : 'own',
      });
    },
  });
}

module.exports = {
  withEphemeralMemorySource,
  createInstalledLocalSourceContext,
};
