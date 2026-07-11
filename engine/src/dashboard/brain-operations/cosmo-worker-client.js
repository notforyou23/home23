'use strict';

const { TextDecoder } = require('node:util');
const {
  PGS_OPERATION_LIMITS,
  QUERY_OPERATION_LIMITS,
} = require('../../../../cosmo23/lib/brain-operation-limits');

const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;
const DEFAULT_MAX_OPERATION_TYPE_ENTRIES = 4096;
const RESULT_CONTROL_HEADROOM_BYTES = 256 * 1024;
const TERMINAL_RESULT_STATES = new Set([
  'complete', 'partial', 'failed', 'cancelled', 'interrupted',
]);
const DEFAULT_SOURCE_OPERATION_TYPES = Object.freeze([
  'query',
  'pgs',
  'research_compile',
  'research_intelligence',
]);

function clientError(code, message = code, options = {}) {
  return Object.assign(new Error(message, options.cause ? { cause: options.cause } : undefined), {
    code,
    retryable: options.retryable === true,
    statusCode: options.statusCode,
  });
}

function normalizeLoopbackBaseUrl(rawBaseUrl) {
  let url;
  try {
    url = new URL(rawBaseUrl);
  } catch (error) {
    throw clientError('worker_configuration_invalid', 'COSMO worker URL is invalid', {
      cause: error,
    });
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'http:' || !loopback || url.username || url.password
      || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw clientError(
      'worker_configuration_invalid',
      'COSMO worker URL must be an uncredentialed loopback HTTP origin',
    );
  }
  url.pathname = '';
  return url.origin;
}

function assertCapability(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value.length > 16_384) {
    throw clientError('capability_invalid');
  }
  return value;
}

function assertOperationId(value) {
  if (typeof value !== 'string' || !/^brop_[A-Za-z0-9_-]{32}$/.test(value)) {
    throw clientError('operation_id_invalid');
  }
  return value;
}

function resultLimitForOperation(operationType) {
  if (operationType === 'query') return QUERY_OPERATION_LIMITS.maxResultBytes;
  if (operationType === 'pgs') return PGS_OPERATION_LIMITS.maxResultBytes;
  return DEFAULT_MAX_JSON_BYTES;
}

async function *responseChunks(body) {
  if (!body) return;
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield Buffer.from(chunk);
    return;
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const row = await reader.read();
        if (row.done) return;
        yield Buffer.from(row.value);
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  throw clientError('worker_transport_invalid', 'COSMO response body is not streamable', {
    retryable: true,
  });
}

async function readBoundedJson(response, maxBytes = DEFAULT_MAX_JSON_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of responseChunks(response.body)) {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      throw clientError('worker_response_too_large', 'COSMO worker response exceeded its limit');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'));
  } catch (error) {
    throw clientError('worker_transport_invalid', 'COSMO worker returned invalid JSON', {
      retryable: true,
      cause: error,
    });
  }
}

function remoteError(response, envelope) {
  const payload = envelope?.error;
  const code = typeof payload?.code === 'string' ? payload.code : 'worker_transport_failed';
  const message = typeof payload?.message === 'string' ? payload.message : code;
  return clientError(code, message, {
    statusCode: response.status,
    retryable: response.status >= 500 || response.status === 408 || response.status === 429,
  });
}

function createCosmoBrainOperationWorkerClient({
  baseUrl = `http://127.0.0.1:${Number(process.env.COSMO23_PORT || 43210)}`,
  fetchImpl = globalThis.fetch,
  maxJsonBytes = DEFAULT_MAX_JSON_BYTES,
  maxEventBytes = DEFAULT_MAX_EVENT_BYTES,
  maxOperationTypeEntries = DEFAULT_MAX_OPERATION_TYPE_ENTRIES,
  sourceOperationTypes = DEFAULT_SOURCE_OPERATION_TYPES,
} = {}) {
  const origin = normalizeLoopbackBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1024
      || !Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1024
      || !Number.isSafeInteger(maxOperationTypeEntries) || maxOperationTypeEntries < 1
      || !Array.isArray(sourceOperationTypes)
      || sourceOperationTypes.some((value) => typeof value !== 'string' || !value)) {
    throw clientError('worker_configuration_invalid');
  }
  const supportedSourceOperations = new Set(sourceOperationTypes);
  const operationTypes = new Map();

  function rememberOperationType(operationId, operationType) {
    if (typeof operationType !== 'string' || !supportedSourceOperations.has(operationType)) {
      throw clientError('worker_transport_invalid', 'COSMO worker operation type is invalid', {
        retryable: true,
      });
    }
    const known = operationTypes.get(operationId);
    if (known !== undefined && known !== operationType) {
      throw clientError('worker_transport_invalid', 'COSMO worker operation type changed', {
        retryable: true,
      });
    }
    operationTypes.delete(operationId);
    operationTypes.set(operationId, operationType);
    while (operationTypes.size > maxOperationTypeEntries) {
      operationTypes.delete(operationTypes.keys().next().value);
    }
  }

  function rememberStatusOperationType(operationId, result) {
    const reference = result?.reference;
    if (reference === undefined || reference === null) return;
    const operationType = reference?.operationType;
    if (!reference || Array.isArray(reference) || typeof reference !== 'object'
        || result?.operationId !== operationId
        || reference.version !== 1
        || reference.workerType !== 'cosmo'
        || typeof reference.workerId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/.test(reference.workerId)
        || typeof operationType !== 'string'
        || !supportedSourceOperations.has(operationType)
        || (result.operationType !== undefined && result.operationType !== operationType)) {
      throw clientError('worker_transport_invalid', 'COSMO worker status identity is invalid', {
        retryable: true,
      });
    }
    rememberOperationType(operationId, operationType);
  }

  function endpoint(operationId, action, query = '') {
    return `${origin}/api/internal/brain-operations/${assertOperationId(operationId)}/${action}${query}`;
  }

  async function requestJson(operationId, action, capability, {
    method = 'GET',
    body,
    responseMaxBytes = maxJsonBytes,
  } = {}) {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${assertCapability(capability)}`,
    };
    const options = { method, headers, redirect: 'error' };
    if (body !== undefined) {
      const encoded = JSON.stringify(body);
      if (Buffer.byteLength(encoded, 'utf8') > maxJsonBytes) {
        throw clientError('worker_request_too_large');
      }
      headers['content-type'] = 'application/json';
      options.body = encoded;
    }
    let response;
    try {
      response = await fetchImpl(endpoint(operationId, action), options);
    } catch (error) {
      throw clientError('worker_transport_failed', 'COSMO worker is unavailable', {
        retryable: true,
        cause: error,
      });
    }
    const envelope = await readBoundedJson(response, responseMaxBytes);
    if (!response.ok) throw remoteError(response, envelope);
    return envelope;
  }

  async function status(operationId, capability) {
    const result = await requestJson(operationId, 'status', capability);
    rememberStatusOperationType(operationId, result);
    return result;
  }

  return Object.freeze({
    supportsSourceOperations: true,
    supportsSourceOperation(operationType) {
      return supportedSourceOperations.has(operationType);
    },
    async start(context, capability) {
      const result = await requestJson(context?.operationId, 'start', capability, {
        method: 'POST',
        body: context,
      });
      if (typeof context?.operationType !== 'string' || !context.operationType) {
        throw clientError('worker_transport_invalid');
      }
      if (result?.operationType !== undefined && result.operationType !== context.operationType) {
        throw clientError('worker_transport_invalid');
      }
      rememberOperationType(context.operationId, context.operationType);
      if (result?.reference !== undefined && result?.reference !== null) {
        rememberStatusOperationType(context.operationId, result);
      }
      return result;
    },
    status,
    async *events(operationId, { afterSequence, signal }, capability) {
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0
          || !(signal instanceof AbortSignal)) {
        throw clientError('worker_event_cursor_invalid');
      }
      let response;
      try {
        response = await fetchImpl(endpoint(
          operationId,
          'events',
          `?afterSequence=${afterSequence}`,
        ), {
          method: 'GET',
          headers: {
            accept: 'application/x-ndjson',
            authorization: `Bearer ${assertCapability(capability)}`,
          },
          redirect: 'error',
          signal,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw clientError('worker_transport_failed', 'COSMO worker event stream is unavailable', {
          retryable: true,
          cause: error,
        });
      }
      if (!response.ok) {
        throw remoteError(response, await readBoundedJson(response, maxJsonBytes));
      }
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let buffered = '';
      try {
        for await (const chunk of responseChunks(response.body)) {
          if (signal.aborted) throw signal.reason;
          buffered += decoder.decode(chunk, { stream: true });
          if (Buffer.byteLength(buffered, 'utf8') > maxEventBytes
              && !buffered.includes('\n')) {
            throw clientError('worker_event_too_large');
          }
          let newline;
          while ((newline = buffered.indexOf('\n')) >= 0) {
            const line = buffered.slice(0, newline);
            buffered = buffered.slice(newline + 1);
            if (!line) continue;
            if (Buffer.byteLength(line, 'utf8') > maxEventBytes) {
              throw clientError('worker_event_too_large');
            }
            let event;
            try { event = JSON.parse(line); } catch (error) {
              throw clientError('worker_event_invalid', 'COSMO worker returned invalid NDJSON', {
                retryable: true,
                cause: error,
              });
            }
            if (event?.error && !event.type) throw remoteError(response, event);
            yield event;
          }
        }
        buffered += decoder.decode();
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (typeof error?.code === 'string') throw error;
        throw clientError('worker_event_invalid', 'COSMO worker event stream is invalid', {
          retryable: true,
          cause: error,
        });
      }
      if (buffered.trim()) {
        throw clientError('worker_event_invalid', 'COSMO worker event stream ended mid-frame', {
          retryable: true,
        });
      }
    },
    async result(operationId, capability, statusCapability) {
      let operationType = operationTypes.get(operationId);
      if (!operationType) {
        await status(operationId, statusCapability);
        operationType = operationTypes.get(operationId);
      }
      const resultLimit = resultLimitForOperation(operationType);
      const envelope = await requestJson(operationId, 'result', capability, {
        responseMaxBytes: resultLimit + Math.max(maxJsonBytes, RESULT_CONTROL_HEADROOM_BYTES),
      });
      if (envelope?.result !== null && envelope?.result !== undefined) {
        let resultBytes;
        try { resultBytes = Buffer.byteLength(JSON.stringify(envelope.result), 'utf8'); } catch (error) {
          throw clientError('worker_transport_invalid', 'COSMO worker result is invalid', {
            retryable: true, cause: error,
          });
        }
        if (resultBytes > resultLimit) {
          throw clientError('worker_response_too_large', 'COSMO worker result exceeded its limit');
        }
      }
      if (TERMINAL_RESULT_STATES.has(envelope?.state)) operationTypes.delete(operationId);
      return envelope;
    },
    cancel(operationId, capability) {
      return requestJson(operationId, 'cancel', capability, { method: 'POST', body: {} });
    },
  });
}

module.exports = {
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_JSON_BYTES,
  createCosmoBrainOperationWorkerClient,
  normalizeLoopbackBaseUrl,
  readBoundedJson,
};
