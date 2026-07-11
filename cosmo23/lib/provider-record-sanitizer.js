'use strict';

// Numeric retrieval vectors are useful to search/routing, but they are not
// textual evidence for answer models. Exact field names keep textual uses of
// words such as "vector" intact unless their value is actually numeric vector
// data.
const PROVIDER_OMITTED_VECTOR_FIELDS = new Set([
  'embedding',
  'embeddings',
  'vector',
  'vectors',
]);

function typed(code, message) {
  return Object.assign(new Error(message), { code, retryable: false });
}

function isNumericVectorPayload(value, ancestors = new Set()) {
  if (value === null) return true;
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return false;
    for (let index = 0; index < value.length; index += 1) {
      if (typeof value[index] !== 'number') return false;
    }
    return true;
  }
  if (!Array.isArray(value) || ancestors.has(value)) return false;
  ancestors.add(value);
  try {
    // JSON serializes array holes as null. Inspect only present array-index
    // properties so sparse numeric vectors are still recognized and omitted
    // instead of crossing the provider boundary as misleading null vectors.
    for (const key of Object.keys(value)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('Accessor-backed vector payload is unsafe');
      }
      const item = descriptor.value;
      if (typeof item === 'number') continue;
      if (!isNumericVectorPayload(item, ancestors)) return false;
    }
    return true;
  } finally {
    ancestors.delete(value);
  }
}

function providerRecordReplacer(key, value) {
  const descriptor = Object.getOwnPropertyDescriptor(this, key);
  if (descriptor && !Object.hasOwn(descriptor, 'value')) {
    // JSON has already invoked an enumerable getter exactly once to obtain
    // `value`; rejecting here avoids a second read while failing closed.
    throw new TypeError('Accessor-backed provider evidence is unsafe');
  }
  const rawValue = descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : value;
  return PROVIDER_OMITTED_VECTOR_FIELDS.has(key) && isNumericVectorPayload(rawValue)
    ? undefined
    : value;
}

function serializeProviderRecord(record, {
  maxBytes,
  label = 'Pinned provider record',
} = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw typed('source_invalid', `${label} must be an object`);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw typed('invalid_request', `${label} byte limit is invalid`);
  }
  let json;
  try {
    // The holder descriptor exposes an exact field's raw value before a
    // Buffer or typed vector's native toJSON result reaches the replacer.
    json = JSON.stringify(record, providerRecordReplacer);
  } catch (cause) {
    throw typed('source_invalid', `${label} is not serializable`);
  }
  if (typeof json !== 'string') {
    throw typed('source_invalid', `${label} is not serializable`);
  }
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) {
    throw typed('result_too_large', `${label} exceeds the byte limit`);
  }
  let value;
  try {
    value = JSON.parse(json);
  } catch (cause) {
    throw typed('source_invalid', `${label} is not serializable`);
  }
  return Object.freeze({ value, json, bytes });
}

module.exports = {
  isNumericVectorPayload,
  serializeProviderRecord,
};
