'use strict';

const { BrainOperationWorker } = require('./brain-operation-worker');
const {
  VERIFIED_FOLLOW_UP_WORKER_SUPPORT,
  createQueryOperationExecutor,
} = require('./query-operation-worker');
const { QueryEngine } = require('../../lib/query-engine');
const { createMemorySourcePinProvider } = require('../../../shared/memory-source');
const {
  VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT,
} = require('../../../shared/query/verified-follow-up-support.cjs');

const EXPECTED_QUERY_WORKER_SUPPORT = Object.freeze({
  version: 1,
  maxUtf16: 20_000,
  validatesCanonicalContext: true,
});
const EXPECTED_QUERY_ENGINE_SUPPORT = Object.freeze({
  version: 1,
  maxUtf16: 20_000,
  initialPrompt: true,
  expansionPrompt: true,
  cacheIdentity: true,
});

function runtimeError(code, message = code, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function clone(value) {
  return structuredClone(value);
}

function exactFrozenSupport(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
      || Object.getPrototypeOf(value) !== Object.prototype
      || !Object.isFrozen(value)) return false;
  const actual = Reflect.ownKeys(value);
  const wanted = Object.keys(expected);
  if (actual.some((key) => typeof key !== 'string') || actual.length !== wanted.length) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return wanted.every((key) => {
    const descriptor = descriptors[key];
    return descriptor
      && Object.hasOwn(descriptor, 'value')
      && descriptor.enumerable === true
      && descriptor.writable === false
      && descriptor.configurable === false
      && Object.is(descriptor.value, expected[key]);
  });
}

function createSharedWorkerSourcePins({ home23Root, providerFactory = createMemorySourcePinProvider } = {}) {
  if (typeof home23Root !== 'string' || !home23Root.startsWith('/')
      || typeof providerFactory !== 'function') {
    throw runtimeError('worker_configuration_invalid');
  }
  return Object.freeze({
    openPinnedSource(descriptor, expectations = {}, operationLockCapability = null) {
      const requesterAgent = expectations.requesterAgent;
      if (typeof requesterAgent !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requesterAgent)) {
        throw runtimeError('invalid_request', 'Trusted requester identity is required');
      }
      return providerFactory({ home23Root, requesterAgent })
        .openPinnedSource(descriptor, expectations, operationLockCapability);
    },
  });
}

function createBrainOperationTargetResolver({
  buildCatalog,
  resolveCanonicalTarget,
  resolveOwnedRun,
  buildOwnedRunTarget,
} = {}) {
  if (typeof buildCatalog !== 'function' || typeof resolveCanonicalTarget !== 'function') {
    throw runtimeError('worker_configuration_invalid');
  }
  return async function resolveTarget({ requesterAgent, target } = {}) {
    if (typeof requesterAgent !== 'string' || !requesterAgent
        || !target || Array.isArray(target) || typeof target !== 'object') {
      throw runtimeError('access_denied');
    }
    if (target.domain === 'requester') {
      if (Object.keys(target).sort().join(',') !== 'domain,requesterAgent'
          || target.requesterAgent !== requesterAgent) {
        throw runtimeError('access_denied');
      }
      return Object.freeze({ domain: 'requester', requesterAgent });
    }
    if (target.domain === 'owned-run') {
      if (typeof resolveOwnedRun !== 'function' || typeof buildOwnedRunTarget !== 'function') {
        throw runtimeError('target_not_available', 'Research run operations are unavailable', true);
      }
      const run = await resolveOwnedRun({ runId: target.runId, requesterAgent });
      if (!run) throw runtimeError('target_not_found');
      return Object.freeze(buildOwnedRunTarget(run));
    }
    if (target.domain !== 'brain' || typeof target.brainId !== 'string') {
      throw runtimeError('access_denied');
    }
    const catalog = await buildCatalog();
    const entry = resolveCanonicalTarget(catalog, requesterAgent, { brainId: target.brainId });
    const accessMode = entry.kind === 'resident'
      && entry.lifecycle === 'resident'
      && entry.ownerAgent === requesterAgent
      ? 'own'
      : 'read-only';
    return Object.freeze({
      domain: 'brain',
      brainId: entry.id,
      canonicalRoot: entry.canonicalRoot,
      accessMode,
      ownerAgent: entry.ownerAgent ?? null,
      displayName: entry.displayName,
      kind: entry.kind,
      lifecycle: entry.lifecycle,
      catalogRevision: catalog.catalogRevision,
      route: entry.route,
      mutationBoundaries: clone(entry.mutationBoundaries),
    });
  };
}

function createCosmoBrainOperationRuntime({
  home23Root,
  capabilityKey,
  buildCatalog,
  resolveCanonicalTarget,
  resolveOwnedRun,
  buildOwnedRunTarget,
  modelCatalog,
  providerRegistry,
  queryEngine,
  extraExecutors = new Map(),
  sourcePins = createSharedWorkerSourcePins({ home23Root }),
  nonceStore,
  clock,
} = {}) {
  if (typeof capabilityKey !== 'string' || !capabilityKey
      || !modelCatalog?.providers || !providerRegistry
      || !queryEngine || !(extraExecutors instanceof Map)) {
    throw runtimeError('worker_configuration_invalid');
  }
  queryEngine.modelCatalog = modelCatalog;
  queryEngine.providerRegistry = providerRegistry;
  const queryExecutor = createQueryOperationExecutor({ queryEngine });
  const verifiedFollowUpSupport = Object.getPrototypeOf(queryEngine)?.constructor === QueryEngine
    && exactFrozenSupport(
      VERIFIED_FOLLOW_UP_WORKER_SUPPORT,
      EXPECTED_QUERY_WORKER_SUPPORT,
    ) && exactFrozenSupport(
      queryEngine.constructor?.verifiedFollowUpSupport,
      EXPECTED_QUERY_ENGINE_SUPPORT,
    )
    ? VERIFIED_FOLLOW_UP_RUNTIME_SUPPORT
    : null;
  const executors = new Map([
    ['query', queryExecutor],
    ['pgs', queryExecutor],
  ]);
  for (const [operationType, executor] of extraExecutors) {
    if (executors.has(operationType)) throw runtimeError('executor_conflict');
    executors.set(operationType, executor);
  }
  const worker = new BrainOperationWorker({
    home23Root,
    capabilityKey,
    resolveTarget: createBrainOperationTargetResolver({
      buildCatalog,
      resolveCanonicalTarget,
      resolveOwnedRun,
      buildOwnedRunTarget,
    }),
    sourcePins,
    executors,
    verifiedFollowUpSupport,
    nonceStore,
    clock,
  });
  return Object.freeze({ executors, sourcePins, worker });
}

module.exports = {
  createBrainOperationTargetResolver,
  createCosmoBrainOperationRuntime,
  createSharedWorkerSourcePins,
};
