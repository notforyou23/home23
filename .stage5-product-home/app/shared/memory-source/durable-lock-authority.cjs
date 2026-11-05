'use strict';

// Deliberately private to the source-lock integration.  A plain object with the
// same fields is not authority: only objects branded in this module can widen
// the generic 30-second source-lock wait used by public callers.
const controls = new WeakMap();

function authorityError(message) {
  return Object.assign(new Error(message), {
    code: 'invalid_request',
    retryable: false,
  });
}

function normalizeControl(control) {
  const keys = control && !Array.isArray(control) && typeof control === 'object'
    ? Reflect.ownKeys(control)
    : [];
  if (!control || Array.isArray(control) || typeof control !== 'object'
      || keys.some((key) => typeof key !== 'string')
      || keys.sort().join(',') !== 'cleanupSignal,hardDeadlineAt,signal'
      || !(control.signal === null || control.signal instanceof AbortSignal)
      || !(control.cleanupSignal === null || control.cleanupSignal instanceof AbortSignal)) {
    throw authorityError('trusted durable operation lock control required');
  }
  const hardDeadlineAt = Date.parse(control.hardDeadlineAt);
  if (!Number.isFinite(hardDeadlineAt)
      || new Date(hardDeadlineAt).toISOString() !== control.hardDeadlineAt) {
    throw authorityError('valid durable operation hard deadline required');
  }
  return Object.freeze({
    hardDeadlineAt: control.hardDeadlineAt,
    signal: control.signal,
    cleanupSignal: control.cleanupSignal,
  });
}

function createDurableOperationLockCapability(control) {
  const capability = Object.freeze(Object.create(null));
  controls.set(capability, normalizeControl(control));
  return capability;
}

function readDurableOperationLockCapability(capability) {
  if (capability === null || capability === undefined) return null;
  const control = (typeof capability === 'object' && capability !== null)
    ? controls.get(capability)
    : null;
  if (!control) throw authorityError('trusted durable operation lock capability required');
  return control;
}

module.exports = {
  createDurableOperationLockCapability,
  readDurableOperationLockCapability,
};
