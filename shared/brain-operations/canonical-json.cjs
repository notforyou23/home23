'use strict';

const { createHash } = require('node:crypto');
const { types: { isProxy } } = require('node:util');

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function canonicalJsonError(cause) {
  const error = new Error('canonical_json_invalid', cause ? { cause } : undefined);
  error.code = 'canonical_json_invalid';
  return error;
}

function normalize(value, ancestors) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw canonicalJsonError();
    return value;
  }
  if (typeof value !== 'object') throw canonicalJsonError();
  if (isProxy(value)) throw canonicalJsonError();
  if (ancestors.has(value)) throw canonicalJsonError();

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw canonicalJsonError();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length > 0) throw canonicalJsonError();
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw canonicalJsonError();
      }
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length
            || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw canonicalJsonError();
        }
      }
      return Array.from({ length: value.length }, (_, index) =>
        normalize(descriptors[String(index)].value, ancestors));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw canonicalJsonError();
    if (Object.getOwnPropertySymbols(value).length > 0) throw canonicalJsonError();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.hasOwn(descriptors, 'toJSON')) throw canonicalJsonError();
    const output = Object.create(null);
    for (const key of Object.keys(descriptors).sort()) {
      const descriptor = descriptors[key];
      if (DANGEROUS_KEYS.has(key) || !Object.hasOwn(descriptor, 'value')) {
        throw canonicalJsonError();
      }
      if (!descriptor.enumerable) continue;
      output[key] = normalize(descriptor.value, ancestors);
    }
    return output;
  } catch (error) {
    if (error?.code === 'canonical_json_invalid') throw error;
    throw canonicalJsonError(error);
  } finally {
    ancestors.delete(value);
  }
}

function canonicalJson(value) {
  try {
    return JSON.stringify(normalize(value, new WeakSet()));
  } catch (error) {
    if (error?.code === 'canonical_json_invalid') throw error;
    throw canonicalJsonError(error);
  }
}

function canonicalSha256(value) {
  return `sha256:${createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')}`;
}

module.exports = {
  canonicalJson,
  canonicalSha256,
};
