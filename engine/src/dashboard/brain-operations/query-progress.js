'use strict';

const QUERY_PROGRESS_STAGES = Object.freeze([
  'queued',
  'preparing_source',
  'selecting_work',
  'sweeping',
  'synthesizing',
  'finalizing',
  'terminal',
]);

const SNAPSHOT_FIELDS = Object.freeze([
  'version',
  'stage',
  'eventSequence',
  'sourceNodes',
  'sourceEdges',
  'candidateWorkUnits',
  'selected',
  'completed',
  'successful',
  'failed',
  'reused',
  'pending',
  'retryable',
  'total',
  'synthesisLevel',
  'synthesisBatch',
  'synthesisBatches',
  'lastProviderActivityAt',
  'lastProgressAt',
]);

const COUNTER_FIELDS = Object.freeze([
  'sourceNodes',
  'sourceEdges',
  'candidateWorkUnits',
  'selected',
  'completed',
  'successful',
  'failed',
  'reused',
  'pending',
  'retryable',
  'total',
  'synthesisLevel',
  'synthesisBatch',
  'synthesisBatches',
]);

const CUMULATIVE_COUNTER_FIELDS = Object.freeze([
  'sourceNodes',
  'sourceEdges',
  'candidateWorkUnits',
  'selected',
  'completed',
  'successful',
  'failed',
  'reused',
  'retryable',
  'total',
]);

const RAW_STAGE_MAP = Object.freeze({
  projection_started: 'preparing_source',
  projection_complete: 'preparing_source',
  work_selected: 'selecting_work',
  sweep_batch_complete: 'sweeping',
  sweep_complete: 'sweeping',
  synthesis_started: 'synthesizing',
  synthesis_reduction_started: 'synthesizing',
  synthesis_reduction_truncated: 'synthesizing',
  synthesis_reduction_complete: 'synthesizing',
  synthesis_batch_complete: 'synthesizing',
  synthesis_complete: 'finalizing',
});

const SETTLED_COUNTER_FIELDS = Object.freeze([
  'selected',
  'completed',
  'successful',
  'failed',
  'reused',
  'pending',
  'retryable',
  'total',
]);

function progressError(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function canonicalIso(value, code) {
  if (typeof value !== 'string') throw progressError(code);
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw progressError(code);
  }
  return value;
}

function safeCounterSum(left, right, code) {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw progressError(code);
  return sum;
}

function validateQueryProgressSnapshot(value, code = 'progress_snapshot_invalid') {
  if (!value || Array.isArray(value) || typeof value !== 'object') throw progressError(code);
  const allowed = new Set(SNAPSHOT_FIELDS);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw progressError(code);
  }
  if (value.version !== 1
      || !QUERY_PROGRESS_STAGES.includes(value.stage)
      || !Number.isSafeInteger(value.eventSequence)
      || value.eventSequence < 0) {
    throw progressError(code);
  }
  for (const field of COUNTER_FIELDS) {
    if (value[field] !== undefined
        && (!Number.isSafeInteger(value[field]) || value[field] < 0)) {
      throw progressError(code);
    }
  }
  for (const field of ['lastProviderActivityAt', 'lastProgressAt']) {
    if (value[field] !== undefined) canonicalIso(value[field], code);
  }
  if (value.reused !== undefined
      && value.successful !== undefined
      && value.reused > value.successful) {
    throw progressError(code);
  }
  if (value.retryable !== undefined
      && value.failed !== undefined
      && value.retryable > value.failed) {
    throw progressError(code);
  }
  const minimumSuccessful = value.successful ?? value.reused ?? 0;
  const minimumFailed = value.failed ?? value.retryable ?? 0;
  const impliedCompleted = safeCounterSum(minimumSuccessful, minimumFailed, code);
  if (value.completed !== undefined
      && (value.completed < impliedCompleted
        || (value.successful !== undefined
          && value.failed !== undefined
          && value.completed !== impliedCompleted))) {
    throw progressError(code);
  }
  const completedFloor = Math.max(value.completed ?? 0, impliedCompleted);
  const selectedFloor = value.pending === undefined
    ? completedFloor
    : safeCounterSum(completedFloor, value.pending, code);
  const exactCompleted = value.completed
    ?? (value.successful !== undefined && value.failed !== undefined ? impliedCompleted : undefined);
  if (value.selected !== undefined
      && (value.selected < selectedFloor
        || (exactCompleted !== undefined
          && value.pending !== undefined
          && value.selected !== safeCounterSum(exactCompleted, value.pending, code)))) {
    throw progressError(code);
  }
  const totalFloor = Math.max(value.selected ?? 0, selectedFloor);
  if (value.total !== undefined && value.total < totalFloor) {
    throw progressError(code);
  }
  if (value.synthesisBatch !== undefined
      && value.synthesisBatches !== undefined
      && value.synthesisBatch > value.synthesisBatches) {
    throw progressError(code);
  }
  return Object.freeze({ ...value });
}

function eventTime(event, context, code) {
  if (event.at !== undefined) return canonicalIso(event.at, code);
  if (!Number.isFinite(context.now)) throw progressError(code);
  const value = new Date(context.now).toISOString();
  return canonicalIso(value, code);
}

function setIfPresent(target, outputKey, source, inputKey = outputKey) {
  if (Object.hasOwn(source, inputKey)) target[outputKey] = source[inputKey];
}

function setMaximumIfPresent(target, outputKey, source, inputKey = outputKey) {
  if (!Object.hasOwn(source, inputKey)) return;
  const value = source[inputKey];
  if (target[outputKey] === undefined
      || !Number.isSafeInteger(value)
      || value < 0) {
    target[outputKey] = value;
    return;
  }
  target[outputKey] = Math.max(target[outputKey], value);
}

function applyStageCounters(next, event, code, previous) {
  if (event.stage === 'projection_complete') {
    setIfPresent(next, 'sourceNodes', event, 'nodeCount');
    setIfPresent(next, 'sourceEdges', event, 'edgeCount');
    setIfPresent(next, 'candidateWorkUnits', event, 'workUnitCount');
  } else if (event.stage === 'work_selected') {
    if (previous !== null
        && QUERY_PROGRESS_STAGES.indexOf(previous.stage)
          >= QUERY_PROGRESS_STAGES.indexOf('selecting_work')) {
      setMaximumIfPresent(next, 'candidateWorkUnits', event, 'candidateWorkUnits');
    } else {
      setIfPresent(next, 'candidateWorkUnits', event, 'candidateWorkUnits');
    }
    setIfPresent(next, 'selected', event, 'selectedWorkUnitsTotal');
    if (Number.isSafeInteger(next.selected) && Number.isSafeInteger(next.completed)) {
      next.pending = next.selected - next.completed;
    }
  } else if (event.stage === 'sweep_batch_complete') {
    if (SETTLED_COUNTER_FIELDS.some((field) => !Object.hasOwn(event, field))) {
      throw progressError(code);
    }
    for (const field of SETTLED_COUNTER_FIELDS) next[field] = event[field];
  } else if (event.stage === 'synthesis_reduction_started'
      || event.stage === 'synthesis_reduction_truncated'
      || event.stage === 'synthesis_reduction_complete'
      || event.stage === 'synthesis_batch_complete') {
    setIfPresent(next, 'synthesisLevel', event, 'level');
    setIfPresent(next, 'synthesisBatch', event, 'batch');
    setIfPresent(next, 'synthesisBatches', event, 'batches');
  } else if (event.stage === 'synthesis_complete') {
    setIfPresent(next, 'synthesisLevel', event, 'levels');
  }
}

function assertMonotonic(previous, next, code, {
  allowCandidateReplacement = false,
  allowPendingIncrease = false,
} = {}) {
  if (QUERY_PROGRESS_STAGES.indexOf(next.stage) < QUERY_PROGRESS_STAGES.indexOf(previous.stage)) {
    throw progressError(code);
  }
  for (const field of CUMULATIVE_COUNTER_FIELDS) {
    if (field === 'candidateWorkUnits' && allowCandidateReplacement) continue;
    if (next[field] !== undefined
        && previous[field] !== undefined
        && next[field] < previous[field]) {
      throw progressError(code);
    }
  }
  if (next.pending !== undefined
      && previous.pending !== undefined
      && !allowPendingIncrease
      && next.pending > previous.pending) {
    throw progressError(code);
  }
  if (next.synthesisLevel !== undefined
      && previous.synthesisLevel !== undefined
      && next.synthesisLevel < previous.synthesisLevel) {
    throw progressError(code);
  }
  const sameSynthesisLevel = next.synthesisLevel === previous.synthesisLevel;
  if (sameSynthesisLevel
      && next.synthesisBatch !== undefined
      && previous.synthesisBatch !== undefined
      && next.synthesisBatch < previous.synthesisBatch) {
    throw progressError(code);
  }
  if (sameSynthesisLevel
      && next.synthesisBatches !== undefined
      && previous.synthesisBatches !== undefined
      && next.synthesisBatches < previous.synthesisBatches) {
    throw progressError(code);
  }
  for (const field of ['lastProviderActivityAt', 'lastProgressAt']) {
    if (next[field] !== undefined
        && previous[field] !== undefined
        && next[field].localeCompare(previous[field]) < 0) {
      throw progressError(code);
    }
  }
}

function reduceQueryProgressSnapshot(previous, event, context) {
  const code = 'progress_snapshot_invalid';
  if (previous !== null) validateQueryProgressSnapshot(previous, code);
  if (!event || Array.isArray(event) || typeof event !== 'object'
      || !context || Array.isArray(context) || typeof context !== 'object'
      || typeof context.operationType !== 'string'
      || !Number.isSafeInteger(context.nextSequence) || context.nextSequence < 0) {
    throw progressError(code);
  }
  if (context.operationType !== 'query' && context.operationType !== 'pgs') return previous;
  if (previous !== null && context.nextSequence <= previous.eventSequence) {
    throw progressError(code);
  }

  const terminal = context.terminal === true;
  const queued = event.type === 'state' && event.state === 'queued';
  const progress = event.type === 'progress' || event.type === 'progress_update';
  const providerActivity = event.type === 'provider_activity';
  const mappedStage = progress && typeof event.stage === 'string'
    ? RAW_STAGE_MAP[event.stage]
    : null;
  if (!terminal && !queued && !progress && !providerActivity) return previous;
  if (previous === null && !terminal && !queued && mappedStage === null) return null;

  const selectedAfterSweeping = mappedStage === 'selecting_work' && previous?.stage === 'sweeping';
  const firstWorkSelection = mappedStage === 'selecting_work'
    && previous !== null
    && QUERY_PROGRESS_STAGES.indexOf(previous.stage)
      < QUERY_PROGRESS_STAGES.indexOf('selecting_work');
  const next = {
    ...(previous ?? {}),
    version: 1,
    stage: terminal
      ? 'terminal'
      : (selectedAfterSweeping ? 'sweeping' : (mappedStage ?? previous?.stage ?? 'queued')),
    eventSequence: context.nextSequence,
  };
  if (progress) {
    next.lastProgressAt = eventTime(event, context, code);
    if (mappedStage !== null) applyStageCounters(next, event, code, previous);
  }
  if (providerActivity) {
    next.lastProviderActivityAt = eventTime(event, context, code);
  }
  if (previous !== null) {
    assertMonotonic(previous, next, code, {
      allowCandidateReplacement: firstWorkSelection,
      allowPendingIncrease: selectedAfterSweeping,
    });
  }
  return validateQueryProgressSnapshot(next, code);
}

module.exports = {
  QUERY_PROGRESS_STAGES,
  reduceQueryProgressSnapshot,
  validateQueryProgressSnapshot,
};
