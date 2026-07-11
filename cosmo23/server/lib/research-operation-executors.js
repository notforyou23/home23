'use strict';

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const CANONICAL_RUN_TARGET_KEYS = Object.freeze([
  'canonicalRoot', 'catalogRevision', 'domain', 'mutationBoundaries',
  'ownerAgent', 'route', 'runId', 'runState',
]);

function failure(code, message, retryable = false) {
  return {
    state: 'failed',
    result: null,
    resultArtifact: null,
    error: { code, message, retryable },
    sourceEvidence: null,
  };
}

function configurationError(message) {
  return Object.assign(new Error(message), {
    code: 'worker_configuration_invalid',
    retryable: false,
  });
}

function exactRunId(target) {
  if (!target || Array.isArray(target) || typeof target !== 'object') return null;
  const keys = Reflect.ownKeys(target);
  if (keys.some((key) => typeof key !== 'string')) return null;
  const sorted = [...keys].sort();
  const rawSelector = sorted.length === 1 && sorted[0] === 'runId';
  const canonicalSelector = sorted.length === CANONICAL_RUN_TARGET_KEYS.length
    && sorted.every((key, index) => key === CANONICAL_RUN_TARGET_KEYS[index]);
  if (!rawSelector && !canonicalSelector) return null;
  if (canonicalSelector && target.domain !== 'owned-run') return null;
  return typeof target.runId === 'string' && RUN_ID_PATTERN.test(target.runId)
    ? target.runId
    : null;
}

function throwIfAborted(signal) {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
    return;
  }
  if (signal.aborted) {
    throw signal.reason || Object.assign(new Error('Operation cancelled'), {
      name: 'AbortError', code: 'operation_cancelled', retryable: false,
    });
  }
}

function createResearchOperationExecutors({
  processManager,
  resolveOwnedRun,
  readPinnedIntelligence,
  createRequesterOutputWriter,
  compileSectionWithProvider,
} = {}) {
  for (const [name, fn] of Object.entries({
    resolveOwnedRun,
    readPinnedIntelligence,
    createRequesterOutputWriter,
    compileSectionWithProvider,
  })) {
    if (typeof fn !== 'function') throw configurationError(`${name} is required`);
  }
  for (const method of ['createOwnedRun', 'start', 'continue', 'stopAndWait', 'watch']) {
    if (!processManager || typeof processManager[method] !== 'function') {
      throw configurationError(`processManager.${method} is required`);
    }
  }

  async function ownedRun(context) {
    const runId = exactRunId(context.target);
    if (!runId) {
      return { error: failure('invalid_request', 'Exact research runId target is required') };
    }
    const run = await resolveOwnedRun({
      runId,
      requesterAgent: context.requesterAgent,
    });
    if (!run) {
      return { error: failure('target_not_found', `Unknown research run: ${runId}`) };
    }
    if (!run.ownerAgent || run.ownerAgent !== context.requesterAgent) {
      return { error: failure('access_denied', 'Research run belongs to another requester') };
    }
    if (context.target?.ownerAgent !== undefined
        && context.target.ownerAgent !== run.ownerAgent) {
      return { error: failure('target_changed', 'Research run ownership changed') };
    }
    return { run };
  }

  return new Map([
    ['research_launch', async (context) => {
      throwIfAborted(context.signal);
      const runId = `research-${context.operationId}`;
      const metadata = await processManager.createOwnedRun({
        runId,
        ownerAgent: context.requesterAgent,
        operationId: context.operationId,
        topic: String(context.parameters.topic || ''),
        parameters: context.parameters,
      });
      throwIfAborted(context.signal);
      const started = await processManager.start(metadata.runId, { signal: context.signal });
      throwIfAborted(context.signal);
      return {
        state: 'complete',
        result: {
          ...started,
          runId: metadata.runId,
          ownerAgent: metadata.ownerAgent,
        },
        resultArtifact: null,
        error: null,
        sourceEvidence: null,
      };
    }],
    ['research_continue', async (context) => {
      const selected = await ownedRun(context);
      if (selected.error) return selected.error;
      throwIfAborted(context.signal);
      const result = await processManager.continue(
        selected.run.runId,
        context.parameters,
        { signal: context.signal },
      );
      throwIfAborted(context.signal);
      return {
        state: 'complete', result, resultArtifact: null, error: null, sourceEvidence: null,
      };
    }],
    ['research_stop', async (context) => {
      const selected = await ownedRun(context);
      if (selected.error) return selected.error;
      throwIfAborted(context.signal);
      const result = await processManager.stopAndWait(
        selected.run.runId,
        { signal: context.signal },
      );
      throwIfAborted(context.signal);
      return {
        state: result?.terminal === true ? 'complete' : 'partial',
        result,
        resultArtifact: null,
        error: null,
        sourceEvidence: null,
      };
    }],
    ['research_watch', async (context) => {
      const selected = await ownedRun(context);
      if (selected.error) return selected.error;
      throwIfAborted(context.signal);
      const after = Number.isSafeInteger(context.parameters.after)
        ? context.parameters.after
        : 0;
      const result = await processManager.watch(selected.run.runId, {
        after,
        limit: context.parameters.limit,
        filter: context.parameters.filter,
      });
      throwIfAborted(context.signal);
      return {
        state: 'complete',
        result: { ...result, latest: result.latest },
        resultArtifact: null,
        error: null,
        sourceEvidence: null,
      };
    }],
    ['research_intelligence', async (context) => {
      throwIfAborted(context.signal);
      if (!context.sourcePin) {
        return failure('source_pin_required', 'Pinned source is required');
      }
      const result = await readPinnedIntelligence(context.sourcePin, {
        kind: 'intelligence',
        include: context.parameters.include,
      }, {
        signal: context.signal,
        maxNodes: 2_000,
        maxEdges: 8_000,
        maxBytes: 8 * 1024 * 1024,
      });
      throwIfAborted(context.signal);
      return {
        state: 'complete',
        result,
        resultArtifact: null,
        error: null,
        sourceEvidence: context.sourcePin.getEvidence(),
      };
    }],
    ['research_compile', async (context) => {
      const selection = context.parameters.kind === 'section'
        ? {
          kind: 'section',
          section: context.parameters.section,
          sectionId: context.parameters.sectionId,
        }
        : { kind: 'brain' };
      throwIfAborted(context.signal);
      if (!context.sourcePin) {
        return failure('source_pin_required', 'Pinned source is required');
      }
      const section = await readPinnedIntelligence(context.sourcePin, selection, {
        signal: context.signal,
        maxNodes: 2_000,
        maxEdges: 8_000,
        maxBytes: 8 * 1024 * 1024,
      });
      throwIfAborted(context.signal);
      if (!section) return failure('section_not_found', 'Requested intelligence section was not found');
      context.reportEvent({
        type: 'progress',
        phase: 'research_compile',
        stage: 'source_projection_complete',
      });
      const writer = await createRequesterOutputWriter({
        requesterAgent: context.requesterAgent,
        operationId: context.operationId,
        signal: context.signal,
      });
      throwIfAborted(context.signal);
      const compiled = await compileSectionWithProvider({
        context,
        sectionContent: section.content,
        sectionSelection: selection,
        sourceEvidence: section.evidence,
        writer,
      });
      throwIfAborted(context.signal);
      if (compiled?.state === 'complete') {
        context.reportEvent({
          type: 'progress',
          phase: 'research_compile',
          stage: 'requester_artifact_published',
        });
      }
      return compiled;
    }],
  ]);
}

module.exports = {
  createResearchOperationExecutors,
  failure,
};
