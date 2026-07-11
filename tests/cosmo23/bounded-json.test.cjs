'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  boundedJsonStringify,
} = require('../../cosmo23/lib/bounded-json');

test('bounded JSON construction matches JSON.stringify without materializing past its ceiling', () => {
  const value = {
    query: 'canary \u{1f9ea}',
    source: {
      nodes: [{ id: 'n1', content: 'line one\nline two' }],
      omitted: undefined,
    },
    values: [true, null, undefined, 12.5],
  };
  const expected = JSON.stringify(value);
  const result = boundedJsonStringify(value, {
    maxBytes: Buffer.byteLength(expected, 'utf8') + 9,
    reservedBytes: 9,
    label: 'Query prompt',
  });
  assert.equal(result.json, expected);
  assert.equal(result.jsonBytes, Buffer.byteLength(expected, 'utf8'));
  assert.equal(result.totalBytes, Buffer.byteLength(expected, 'utf8') + 9);
});

test('bounded JSON rejects a huge string after crossing the configured byte ceiling', () => {
  const maximum = 64 * 1024;
  const huge = 'x'.repeat(32 * 1024 * 1024);
  assert.throws(
    () => boundedJsonStringify({ huge }, {
      maxBytes: maximum,
      reservedBytes: 17,
      label: 'Query prompt',
    }),
    error => error.code === 'result_too_large'
      && error.retryable === false
      && error.bytesExamined <= maximum + (16 * 1024),
  );
});

test('bounded JSON honors the exact UTF-8 boundary', () => {
  const value = { text: '\u{1f9ea}'.repeat(10) };
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  assert.equal(boundedJsonStringify(value, { maxBytes: bytes }).jsonBytes, bytes);
  assert.throws(
    () => boundedJsonStringify(value, { maxBytes: bytes - 1 }),
    error => error.code === 'result_too_large',
  );
});

test('bounded JSON matches native toJSON key and omission semantics', () => {
  const value = {
    kept: { toJSON(key) { return `value:${key}`; } },
    omitted: { toJSON() { return undefined; } },
    array: [{ toJSON(key) { return `index:${key}`; } }, { toJSON() { return undefined; } }],
  };
  const expected = JSON.stringify(value);
  const result = boundedJsonStringify(value, { maxBytes: 4096 });
  assert.equal(result.json, expected);
  assert.doesNotThrow(() => JSON.parse(result.json));
});

test('bounded JSON matches native boxed primitive and boxed BigInt behavior', () => {
  const value = {
    text: new String('ab'),
    number: new Number(7),
    boolean: new Boolean(true),
  };
  assert.equal(
    boundedJsonStringify(value, { maxBytes: 4096 }).json,
    JSON.stringify(value),
  );
  assert.throws(
    () => boundedJsonStringify({ value: Object(1n) }, { maxBytes: 4096 }),
    error => error instanceof TypeError,
  );
});
