'use strict';

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
  abortReason,
  abortableDelay,
  awaitWithCancellation,
  reportProviderActivity,
  requireMaxOutputTokens,
  rethrowCancellation,
  throwIfAborted,
};
