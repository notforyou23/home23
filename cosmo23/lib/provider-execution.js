'use strict';

const { boundedJsonStringify } = require('./bounded-json');

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function typed(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable });
}

function abortReason(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  return Object.assign(new Error('Operation cancelled'), { name: 'AbortError', code: 'cancelled' });
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function rethrowCancellation(error, signal) {
  if (signal?.aborted) throw abortReason(signal);
  if (error?.name === 'AbortError') throw error;
}

function requireMaxOutputTokens(value, provider, model) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw typed(
      'model_capability_invalid',
      `Invalid maxOutputTokens for ${provider || '?'}/${model || '?'}`,
      false,
    );
  }
  return value;
}

function requireMaxOutputBytes(value, provider, model) {
  if (value === undefined || value === null) return DEFAULT_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_MAX_OUTPUT_BYTES) {
    throw typed(
      'model_capability_invalid',
      `Invalid maxOutputBytes for ${provider || '?'}/${model || '?'}`,
      false,
    );
  }
  return value;
}

function resultTooLarge(label, maxBytes) {
  return typed(
    'result_too_large',
    `${label || 'Provider output'} exceeds the ${maxBytes}-byte limit`,
    false,
  );
}

function boundedOutputJson(value, maxBytes, label = 'Provider output') {
  const serialized = boundedJsonStringify(value, { maxBytes, label });
  if (typeof serialized.json !== 'string') {
    throw typed('provider_execution_invalid', `${label} is not JSON serializable`, false);
  }
  return serialized.json;
}

/**
 * Tracks the UTF-8 bytes retained across several independently accumulated
 * fields. Every append is checked before concatenation, so a hostile stream
 * cannot first grow a string and only then discover that it crossed the cap.
 */
function createUtf8OutputBudget(maxBytes, label = 'Provider output') {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0
      || maxBytes > MAX_MAX_OUTPUT_BYTES) {
    throw typed('provider_execution_invalid', 'Invalid UTF-8 output budget', false);
  }
  const slots = new Map();
  let usedBytes = 0;

  const trailingHighSurrogate = (text) => {
    if (!text) return false;
    const code = text.charCodeAt(text.length - 1);
    return code >= 0xD800 && code <= 0xDBFF;
  };

  const leadingLowSurrogate = (text) => {
    if (!text) return false;
    const code = text.charCodeAt(0);
    return code >= 0xDC00 && code <= 0xDFFF;
  };

  const slotBytes = (key) => slots.get(key)?.bytes || 0;

  function set(key, value, field = label) {
    const text = value == null ? '' : String(value);
    const nextBytes = Buffer.byteLength(text, 'utf8');
    const priorBytes = slotBytes(key);
    if (usedBytes - priorBytes + nextBytes > maxBytes) {
      throw resultTooLarge(field, maxBytes);
    }
    usedBytes = usedBytes - priorBytes + nextBytes;
    slots.set(key, {
      bytes: nextBytes,
      trailingHighSurrogate: trailingHighSurrogate(text),
    });
    return text;
  }

  function append(key, current, value, field = label) {
    const existing = current == null ? '' : String(current);
    if (!slots.has(key)) set(key, existing, field);
    const delta = value == null ? '' : String(value);
    const deltaBytes = Buffer.byteLength(delta, 'utf8');
    const combinesSurrogatePair = slots.get(key)?.trailingHighSurrogate === true
      && leadingLowSurrogate(delta);
    const addedBytes = deltaBytes - (combinesSurrogatePair ? 2 : 0);
    if (usedBytes + addedBytes > maxBytes) {
      throw resultTooLarge(field, maxBytes);
    }
    usedBytes += addedBytes;
    slots.set(key, {
      bytes: slotBytes(key) + addedBytes,
      trailingHighSurrogate: trailingHighSurrogate(delta)
        || (delta.length === 0 && slots.get(key)?.trailingHighSurrogate === true),
    });
    return existing + delta;
  }

  function reserve(key, bytes, field = label) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw typed('provider_execution_invalid', 'Invalid retained output size', false);
    }
    const priorBytes = slotBytes(key);
    if (usedBytes - priorBytes + bytes > maxBytes) {
      throw resultTooLarge(field, maxBytes);
    }
    usedBytes = usedBytes - priorBytes + bytes;
    slots.set(key, { bytes, trailingHighSurrogate: false });
  }

  function clear(key) {
    const priorBytes = slotBytes(key);
    usedBytes -= priorBytes;
    slots.delete(key);
  }

  return Object.freeze({
    append,
    clear,
    get maxBytes() { return maxBytes; },
    reserve,
    set,
    get usedBytes() { return usedBytes; },
  });
}

function rethrowNonRetryable(error) {
  if (error?.retryable === false) throw error;
}

function ignoreAsyncCleanup(result) {
  if (result && typeof result.then === 'function') {
    result.catch(() => {});
  }
}

/** Best-effort cancellation must never replace the primary failure/cancel. */
function cancelAsyncProviderStream(stream, iterator, reason) {
  const called = new Set();
  const invoke = (owner, method) => {
    if (!owner || typeof owner[method] !== 'function') return;
    const fn = owner[method];
    if (called.has(fn)) return;
    called.add(fn);
    try {
      ignoreAsyncCleanup(fn.call(owner, reason));
    } catch {}
  };
  invoke(iterator, 'return');
  invoke(stream, 'abort');
  invoke(stream, 'cancel');
}

/** Best-effort WHATWG reader cleanup with exact primary-error preservation. */
function cancelReadableStreamReader(reader, reason) {
  if (!reader || typeof reader.cancel !== 'function') return;
  try {
    ignoreAsyncCleanup(reader.cancel(reason));
  } catch {}
}

function reportProviderActivity(callback, event) {
  if (typeof callback !== 'function') return;
  callback(event);
}

async function awaitWithCancellation(start, signal) {
  if (typeof start !== 'function') throw typed('provider_execution_invalid', 'Await factory required');
  throwIfAborted(signal);
  let removeAbort = () => {};
  try {
    const operation = Promise.resolve().then(start);
    const result = signal
      ? await Promise.race([
        operation,
        new Promise((_, reject) => {
          const abort = () => reject(abortReason(signal));
          if (signal.aborted) abort();
          else {
            signal.addEventListener('abort', abort, { once: true });
            removeAbort = () => signal.removeEventListener('abort', abort);
          }
        }),
      ])
      : await operation;
    throwIfAborted(signal);
    return result;
  } catch (error) {
    if (signal?.aborted) throw abortReason(signal);
    throw error;
  } finally {
    removeAbort();
  }
}

async function abortableDelay(milliseconds, signal) {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw typed('provider_execution_invalid', 'Invalid retry delay');
  }
  throwIfAborted(signal);
  if (milliseconds === 0) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const abort = () => finish(abortReason(signal));
    function finish(error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    }
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
  throwIfAborted(signal);
}

module.exports = {
  DEFAULT_MAX_OUTPUT_BYTES,
  abortReason,
  abortableDelay,
  awaitWithCancellation,
  boundedOutputJson,
  cancelAsyncProviderStream,
  cancelReadableStreamReader,
  createUtf8OutputBudget,
  reportProviderActivity,
  requireMaxOutputBytes,
  requireMaxOutputTokens,
  rethrowCancellation,
  rethrowNonRetryable,
  resultTooLarge,
  throwIfAborted,
};
