'use strict';

const {
  enrichEvidenceIdentity,
  isAbortError,
  memorySourceError,
  throwIfAborted,
} = require('../../../../shared/memory-source');

function canonicalIdentity(context) {
  const target = context.target || {};
  const descriptor = context.sourcePin?.descriptor || context.sourcePinDescriptor;
  if (!context.sourcePin || descriptor?.canonicalRoot !== target.canonicalRoot) {
    throw memorySourceError('source_changed', 'operation source pin does not match canonical target', {
      retryable: true,
    });
  }
  return {
    requesterAgent: context.requesterAgent,
    targetAgent: target.ownerAgent || null,
    brainId: target.brainId || target.id,
    canonicalRoot: target.canonicalRoot,
    catalogRevision: target.catalogRevision,
    kind: target.kind,
    sourceType: context.sourcePin.manifest?.sourceMode === 'legacy_projection'
      ? 'legacy-projection'
      : 'memory-manifest',
    accessMode: target.accessMode,
    operationId: context.operationId,
  };
}

function failureEnvelope(error, context) {
  const cancelled = isAbortError(error, context.signal);
  return {
    state: cancelled ? 'cancelled' : 'failed',
    result: null,
    resultArtifact: null,
    error: {
      code: cancelled ? 'cancelled' : (error?.code || 'source_unavailable'),
      message: error?.message || (cancelled ? 'cancelled' : 'source unavailable'),
      retryable: error?.retryable !== false,
    },
    sourceEvidence: context.sourcePin?.getEvidence?.() || null,
  };
}

function reportProgress(context, stage) {
  if (typeof context.reportEvent !== 'function') return;
  throwIfAborted(context.signal);
  context.reportEvent(Object.freeze({
    type: 'progress',
    phase: context.operationType,
    stage,
    sourceRevision: context.sourcePin.revision,
  }));
}

async function execute(context, fn) {
  try {
    throwIfAborted(context.signal);
    const identity = canonicalIdentity(context);
    reportProgress(context, 'source_pin_verified');
    const result = await fn(identity);
    reportProgress(context, 'source_operation_finished');
    return result;
  } catch (error) {
    return failureEnvelope(error, context);
  }
}

function standardComplete(result, sourceEvidence) {
  return {
    state: 'complete',
    result,
    resultArtifact: null,
    error: null,
    sourceEvidence,
  };
}

function createSourceOperationExecutors({
  searchService,
  brainSourceService,
  graphExportExecutor,
}) {
  return new Map([
    ['search', (context) => execute(context, async (identity) => {
      const { query, topK, minSimilarity, noiseFloor, tag } = context.parameters || {};
      const result = await searchService.search({
        query,
        topK,
        minSimilarity,
        noiseFloor,
        tag,
        sourcePin: context.sourcePin,
        signal: context.signal,
        identity,
      });
      return standardComplete(result, result.evidence);
    })],

    ['status', (context) => execute(context, async (identity) => {
      const result = await brainSourceService.status({
        sourcePin: context.sourcePin,
        signal: context.signal,
        identity,
      });
      if (!result.ok || result.evidence?.sourceHealth === 'unavailable') {
        return {
          state: 'failed',
          result: null,
          resultArtifact: null,
          error: {
            code: 'source_unavailable',
            message: 'Authoritative brain source is unavailable',
            retryable: true,
          },
          sourceEvidence: result.evidence,
        };
      }
      return standardComplete(result, result.evidence);
    })],

    ['graph', (context) => execute(context, async (identity) => {
      const { view, nodeLimit, limit, edgeLimit, clusterId, minWeight, full } = context.parameters || {};
      const result = view === 'pgs_partitions'
        ? await brainSourceService.pgsPartitions({
          sourcePin: context.sourcePin,
          signal: context.signal,
          identity,
        })
        : await brainSourceService.graph({
        nodeLimit: nodeLimit ?? limit,
        edgeLimit,
        clusterId,
        minWeight,
        full,
        sourcePin: context.sourcePin,
        signal: context.signal,
        identity,
      });
      return standardComplete(result, result.evidence);
    })],

    ['graph_export', (context) => execute(context, async (identity) => {
      const exported = await graphExportExecutor({ ...context, identity });
      const evidence = enrichEvidenceIdentity(exported.evidence, identity);
      return {
        state: 'complete',
        result: null,
        resultArtifact: exported.resultArtifact,
        error: null,
        sourceEvidence: evidence,
      };
    })],
  ]);
}

module.exports = {
  canonicalIdentity,
  createSourceOperationExecutors,
};
