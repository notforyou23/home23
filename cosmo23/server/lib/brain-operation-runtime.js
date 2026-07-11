'use strict';

const { BrainOperationWorker } = require('./brain-operation-worker');
const { createQueryOperationExecutor } = require('./query-operation-worker');
const { createMemorySourcePinProvider } = require('../../../shared/memory-source');

function runtimeError(code, message = code, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function clone(value) {
  return structuredClone(value);
}

function createSharedWorkerSourcePins({ home23Root, providerFactory = createMemorySourcePinProvider } = {}) {
  if (typeof home23Root !== 'string' || !home23Root.startsWith('/')
      || typeof providerFactory !== 'function') {
    throw runtimeError('worker_configuration_invalid');
  }
  return Object.freeze({
    openPinnedSource(descriptor, expectations = {}) {
      const requesterAgent = expectations.requesterAgent;
      if (typeof requesterAgent !== 'string'
          || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(requesterAgent)) {
        throw runtimeError('invalid_request', 'Trusted requester identity is required');
      }
      return providerFactory({ home23Root, requesterAgent })
        .openPinnedSource(descriptor, expectations);
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
