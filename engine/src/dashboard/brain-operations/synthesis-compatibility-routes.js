'use strict';

const crypto = require('node:crypto');

const ACTIVE_STATES = new Set(['queued', 'running']);
const SUMMARY_FIELDS = Object.freeze([
  'operationId', 'requestId', 'operationType', 'state', 'phase',
  'createdAt', 'updatedAt', 'startedAt', 'terminalAt',
]);

function routeError(code, message = code, status = 400, retryable = false) {
  return Object.assign(new Error(message), { code, status, retryable });
}

function sendError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return res.status(status).json({
    ok: false,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'synthesis_internal',
      message: typeof error?.message === 'string' ? error.message : 'synthesis_internal',
      retryable: error?.retryable === true,
    },
  });
}

function exactObject(value, allowed) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    throw routeError('invalid_request');
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) {
    throw routeError('invalid_request');
  }
  return value;
}

function boundedText(value, name, { required = false, maxBytes = 256 } = {}) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || value.includes('\0') || (required && !value.trim())
      || Buffer.byteLength(value, 'utf8') > maxBytes) {
    throw routeError('invalid_request', `${name} is invalid`);
  }
  return value;
}

function generationMarkerFromQuery(query) {
  exactObject(query || {}, new Set(['generationMarker']));
  if (!Object.hasOwn(query, 'generationMarker')) return null;
  return boundedText(query.generationMarker, 'generationMarker', {
    required: true,
    maxBytes: 256,
  });
}

function summarizeOperation(record) {
  if (!record || Array.isArray(record) || typeof record !== 'object') return null;
  const summary = {};
  for (const field of SUMMARY_FIELDS) {
    const value = record[field];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      summary[field] = value;
    }
  }
  return Object.freeze(summary);
}

function sortOperations(records) {
  return [...records].sort((left, right) =>
    String(left.updatedAt || '').localeCompare(String(right.updatedAt || ''))
      || String(left.operationId || '').localeCompare(String(right.operationId || '')));
}

function synthesisResultFromState(state) {
  if (!state || Array.isArray(state) || typeof state !== 'object') return null;
  const result = {};
  for (const field of [
    'generationMarker', 'generatedAt', 'sourceRevision', 'provider', 'model',
    'operationId', 'brainStateSha256',
  ]) result[field] = state[field];
  return result;
}

function claimMatchesState(claim, state) {
  const result = synthesisResultFromState(state);
  if (!result || !claim || Array.isArray(claim) || typeof claim !== 'object') return false;
  if (claim.version !== 1) return false;
  return Object.entries(result).every(([field, value]) => claim[field] === value);
}

function sameResult(left, right) {
  if (!left || !right || Array.isArray(left) || Array.isArray(right)
      || typeof left !== 'object' || typeof right !== 'object') return false;
  const keys = [
    'generationMarker', 'generatedAt', 'sourceRevision', 'provider', 'model',
    'operationId', 'brainStateSha256',
  ];
  return Reflect.ownKeys(left).length === keys.length
    && keys.every((key) => left[key] === right[key]);
}

async function correlateCommittedState({ committed, operations, requesterAgent, store }) {
  const result = synthesisResultFromState(committed);
  if (!result || typeof result.operationId !== 'string'
      || typeof store.getSynthesisCompletionClaim !== 'function') return null;
  const operation = operations.find((record) => record.operationId === result.operationId);
  if (!operation
      || operation.requesterAgent !== requesterAgent
      || operation.operationType !== 'synthesis'
      || operation.target?.domain !== 'brain'
      || operation.target.accessMode !== 'own'
      || operation.target.ownerAgent !== requesterAgent) return null;
  let claim;
  try {
    claim = await store.getSynthesisCompletionClaim(operation.operationId);
  } catch {
    return null;
  }
  if (!claimMatchesState(claim, committed)) return null;
  if (ACTIVE_STATES.has(operation.state)) return committed;
  if (operation.state !== 'complete') return null;
  let persisted = operation.result;
  if (persisted === null && operation.resultHandle && typeof store.getResult === 'function') {
    try {
      persisted = await store.getResult(operation.operationId, {
        requesterAgent,
        resultHandle: operation.resultHandle,
      });
    } catch {
      return null;
    }
  }
  return sameResult(persisted, result) ? committed : null;
}

function createRequestId(now, randomBytes) {
  const bytes = randomBytes(12);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 12) {
    throw routeError('synthesis_unavailable', 'Synthesis request identity is unavailable', 503, true);
  }
  return `synthesis-${now()}-${bytes.toString('base64url')}`;
}

function registerSynthesisCompatibilityRoutes({
  app,
  requesterAgent,
  synthesisRuntime,
  coordinator,
  store,
  now = Date.now,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function'
      || typeof requesterAgent !== 'string' || !requesterAgent
      || typeof now !== 'function' || typeof randomBytes !== 'function') {
    throw routeError('synthesis_configuration_invalid', 'Synthesis compatibility routes are unavailable', 503);
  }

  app.get('/api/synthesis/state', async (req, res) => {
    try {
      const requested = generationMarkerFromQuery(req.query);
      if (!synthesisRuntime || typeof synthesisRuntime.readState !== 'function'
          || typeof synthesisRuntime.getReadiness !== 'function'
          || !store || typeof store.list !== 'function') {
        throw routeError('synthesis_unavailable', 'Synthesis runtime is unavailable', 503, true);
      }
      const readiness = synthesisRuntime.getReadiness();
      if (readiness?.ready !== true) {
        throw routeError(
          readiness?.code || 'synthesis_unavailable',
          'Synthesis runtime is unavailable',
          503,
          readiness?.retryable === true,
        );
      }
      const [committed, listed] = await Promise.all([
        synthesisRuntime.readState(),
        store.list(),
      ]);
      if (!Array.isArray(listed)) throw routeError('operation_corrupt', 'Operation list is invalid', 500);
      const operations = sortOperations(listed.filter((record) =>
        record?.requesterAgent === requesterAgent && record?.operationType === 'synthesis'));
      const latest = operations.at(-1) || null;
      const active = operations.filter((record) => ACTIVE_STATES.has(record.state)).at(-1) || null;
      const correlated = await correlateCommittedState({
        committed,
        operations,
        requesterAgent,
        store,
      });
      const current = typeof correlated?.generationMarker === 'string'
        ? correlated.generationMarker
        : null;
      return res.json({
        ready: true,
        requestedGenerationMarker: requested,
        currentGenerationMarker: current,
        markerStatus: !requested
          ? 'unrequested'
          : !current
            ? 'absent'
            : requested === current ? 'matched' : 'changed',
        latestOperation: summarizeOperation(latest),
        activeOperation: summarizeOperation(active),
      });
    } catch (error) {
      return sendError(res, error);
    }
  });

  app.post('/api/synthesis/run', async (req, res) => {
    try {
      const body = exactObject(req.body || {}, new Set(['trigger', 'reason']));
      if (!synthesisRuntime || typeof synthesisRuntime.getReadiness !== 'function'
          || synthesisRuntime.getReadiness()?.ready !== true
          || !coordinator || typeof coordinator.start !== 'function') {
        throw routeError('synthesis_unavailable', 'Synthesis runtime is unavailable', 503, true);
      }
      const trigger = boundedText(body.trigger, 'trigger', { maxBytes: 256 }) || 'manual';
      const reason = boundedText(body.reason, 'reason', { maxBytes: 4_000 });
      const record = await coordinator.start({
        requestId: createRequestId(now, randomBytes),
        operationType: 'synthesis',
        target: undefined,
        parameters: {
          trigger,
          ...(reason !== undefined ? { reason } : {}),
        },
      });
      return res.status(202).json({
        operationId: record.operationId,
        state: record.state,
      });
    } catch (error) {
      return sendError(res, error);
    }
  });
}

module.exports = {
  correlateCommittedState,
  generationMarkerFromQuery,
  registerSynthesisCompatibilityRoutes,
  summarizeOperation,
};
