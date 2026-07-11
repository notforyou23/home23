'use strict';

const { TextDecoder } = require('node:util');

const DEFAULT_MAX_JSON_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_EVENT_BYTES = 512 * 1024;
const DEFAULT_SOURCE_OPERATION_TYPES = Object.freeze([
  'query',
  'pgs',
  'research_compile',
  'research_intelligence',
]);

function clientError(code, message = code, options = {}) {
  return Object.assign(new Error(message), {
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
  sourceOperationTypes = DEFAULT_SOURCE_OPERATION_TYPES,
} = {}) {
  const origin = normalizeLoopbackBaseUrl(baseUrl);
  if (typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(maxJsonBytes) || maxJsonBytes < 1024
      || !Number.isSafeInteger(maxEventBytes) || maxEventBytes < 1024
      || !Array.isArray(sourceOperationTypes)
      || sourceOperationTypes.some((value) => typeof value !== 'string' || !value)) {
    throw clientError('worker_configuration_invalid');
  }
  const supportedSourceOperations = new Set(sourceOperationTypes);

  function endpoint(operationId, action, query = '') {
    return `${origin}/api/internal/brain-operations/${assertOperationId(operationId)}/${action}${query}`;
  }

  async function requestJson(operationId, action, capability, {
    method = 'GET',
    body,
  } = {}) {
    const headers = {
      accept: 'application/json',
      authorization: `Bearer ${assertCapability(capability)}`,
    };
    const options = { method, headers };
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
    const envelope = await readBoundedJson(response, maxJsonBytes);
    if (!response.ok) throw remoteError(response, envelope);
    return envelope;
  }

  return Object.freeze({
    supportsSourceOperations: true,
    supportsSourceOperation(operationType) {
      return supportedSourceOperations.has(operationType);
    },
    start(context, capability) {
      return requestJson(context?.operationId, 'start', capability, {
        method: 'POST',
        body: context,
      });
    },
    status(operationId, capability) {
      return requestJson(operationId, 'status', capability);
    },
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
        throw error;
      }
      if (buffered.trim()) {
        throw clientError('worker_event_invalid', 'COSMO worker event stream ended mid-frame', {
          retryable: true,
        });
      }
    },
    result(operationId, capability) {
      return requestJson(operationId, 'result', capability);
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
