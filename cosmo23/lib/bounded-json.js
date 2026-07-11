'use strict';

const STRING_CHUNK_CODE_UNITS = 2 * 1024;

function typed(code, message, details = {}) {
  return Object.assign(new Error(message), { code, retryable: false, ...details });
}

function requireLimit(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw typed('invalid_request', `${label} must be a nonnegative safe integer`);
  }
  return value;
}

function boundedJsonStringify(value, {
  maxBytes,
  reservedBytes = 0,
  label = 'JSON value',
} = {}) {
  const maximum = requireLimit(maxBytes, 'maxBytes');
  const reserved = requireLimit(reservedBytes, 'reservedBytes');
  if (reserved > maximum) {
    throw typed('result_too_large', `${label} exceeds the byte limit`, {
      bytesExamined: reserved,
    });
  }

  const pieces = [];
  let totalBytes = reserved;
  let jsonBytes = 0;
  const ancestors = new Set();

  function append(text) {
    const chunk = String(text);
    const bytes = Buffer.byteLength(chunk, 'utf8');
    if (totalBytes + bytes > maximum) {
      throw typed('result_too_large', `${label} exceeds the byte limit`, {
        bytesExamined: totalBytes + bytes,
      });
    }
    pieces.push(chunk);
    totalBytes += bytes;
    jsonBytes += bytes;
  }

  function appendString(text) {
    append('"');
    const source = String(text);
    for (let offset = 0; offset < source.length;) {
      let end = Math.min(source.length, offset + STRING_CHUNK_CODE_UNITS);
      if (end < source.length) {
        const tail = source.charCodeAt(end - 1);
        const next = source.charCodeAt(end);
        if (tail >= 0xD800 && tail <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
          end -= 1;
        }
      }
      const escaped = JSON.stringify(source.slice(offset, end)).slice(1, -1);
      append(escaped);
      offset = end;
    }
    append('"');
  }

  function appendValue(input, arrayElement = false) {
    let current = input;
    if (current && typeof current === 'object' && typeof current.toJSON === 'function') {
      current = current.toJSON();
    }
    if (current === null) {
      append('null');
      return true;
    }
    switch (typeof current) {
      case 'string':
        appendString(current);
        return true;
      case 'boolean':
        append(current ? 'true' : 'false');
        return true;
      case 'number':
        append(Number.isFinite(current) ? String(current) : 'null');
        return true;
      case 'bigint':
        throw new TypeError('Do not know how to serialize a BigInt');
      case 'undefined':
      case 'function':
      case 'symbol':
        if (arrayElement) append('null');
        return arrayElement;
      case 'object':
        break;
      default:
        return false;
    }

    if (ancestors.has(current)) throw new TypeError('Converting circular structure to JSON');
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        append('[');
        for (let index = 0; index < current.length; index += 1) {
          if (index) append(',');
          appendValue(current[index], true);
        }
        append(']');
        return true;
      }
      append('{');
      let emitted = 0;
      for (const key of Object.keys(current)) {
        const child = current[key];
        if (child === undefined || typeof child === 'function' || typeof child === 'symbol') continue;
        if (emitted) append(',');
        appendString(key);
        append(':');
        appendValue(child, false);
        emitted += 1;
      }
      append('}');
      return true;
    } finally {
      ancestors.delete(current);
    }
  }

  if (!appendValue(value, false)) return { json: undefined, jsonBytes: 0, totalBytes: reserved };
  return Object.freeze({
    json: pieces.join(''),
    jsonBytes,
    totalBytes,
  });
}

module.exports = {
  boundedJsonStringify,
};
