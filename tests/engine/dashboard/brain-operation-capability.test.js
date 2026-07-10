import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  canonicalJson,
  canonicalSha256,
} = require('../../../shared/brain-operations/canonical-json.cjs');
const {
  CAPABILITY_MAX_TTL_MS,
  issueCapability,
  verifyCapability,
} = require('../../../shared/brain-operations/capability.cjs');
const { CapabilityNonceStore } = require('../../../cosmo23/server/lib/capability-nonce-store.js');

const TEST_KEY = '1'.repeat(64);
const NOW = 1_700_000;

function claims(overrides = {}) {
  return {
    requesterAgent: 'jerry',
    targetDomain: 'brain',
    targetBrainId: 'brain-forrest',
    targetRunId: null,
    targetRequesterAgent: null,
    canonicalRoot: '/brains/forrest',
    accessMode: 'read-only',
    operationType: 'query',
    operationId: 'op-123',
    sourcePinDigest: `sha256:${'a'.repeat(64)}`,
    issuedAt: NOW,
    expiresAt: NOW + 60_000,
    nonce: 'nonce-1',
    ...overrides,
  };
}

function expected(value = claims(), overrides = {}) {
  return { ...value, now: NOW, ...overrides };
}

function signedPayload(value, key = TEST_KEY) {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function signedRawPayload(bytes, key = TEST_KEY) {
  const payload = Buffer.from(bytes).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

test('canonical JSON is recursive, deterministic, and keeps array order significant', () => {
  const left = {
    z: [{ beta: 2, alpha: 1 }, 3],
    a: { zebra: false, nested: { y: null, x: 'value' } },
  };
  const right = {
    a: { nested: { x: 'value', y: null }, zebra: false },
    z: [{ alpha: 1, beta: 2 }, 3],
  };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalSha256(left), canonicalSha256(right));
  assert.match(canonicalSha256(left), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test('canonical JSON rejects values or descriptors that can execute or drift', () => {
  let getterCalls = 0;
  let toJSONCalls = 0;
  const getter = {};
  Object.defineProperty(getter, 'secret', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'leaked';
    },
  });
  const toJSON = {};
  Object.defineProperty(toJSON, 'toJSON', {
    enumerable: false,
    value() {
      toJSONCalls += 1;
      return { changed: true };
    },
  });
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 2;
  sparse[1] = 'present';
  const dangerous = JSON.parse('{"__proto__":"nope"}');

  const invalid = [
    cycle,
    sparse,
    NaN,
    Infinity,
    -Infinity,
    undefined,
    { missing: undefined },
    1n,
    () => {},
    Symbol('x'),
    new Date(),
    getter,
    toJSON,
    dangerous,
    JSON.parse('{"constructor":"nope"}'),
    JSON.parse('{"prototype":"nope"}'),
  ];
  for (const value of invalid) {
    assert.throws(() => canonicalJson(value), (error) => error?.code === 'canonical_json_invalid');
  }
  assert.equal(getterCalls, 0);
  assert.equal(toJSONCalls, 0);
});

test('canonical JSON rejects proxies and Array subclasses without invoking user code', () => {
  let traps = 0;
  const proxy = new Proxy({ safe: true }, {
    get() { traps += 1; throw new Error('proxy get invoked'); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('proxy descriptor invoked'); },
    getPrototypeOf() { traps += 1; throw new Error('proxy prototype invoked'); },
    ownKeys() { traps += 1; throw new Error('proxy keys invoked'); },
  });
  assert.throws(
    () => canonicalJson(proxy),
    (error) => error?.code === 'canonical_json_invalid',
  );
  assert.equal(traps, 0);

  class ArraySubclass extends Array {}
  assert.throws(() => canonicalJson(new ArraySubclass(1, 2)), /canonical_json_invalid/);
  const alteredPrototype = [1, 2];
  Object.setPrototypeOf(alteredPrototype, null);
  assert.throws(() => canonicalJson(alteredPrototype), /canonical_json_invalid/);
});

test('capability verifies signature, time, source, target, and every durable binding', () => {
  assert.equal(CAPABILITY_MAX_TTL_MS, 120_000);
  const value = claims();
  const token = issueCapability(TEST_KEY, value);
  assert.deepEqual(verifyCapability(TEST_KEY, token, expected(value)), value);

  for (const [field, replacement] of [
    ['requesterAgent', 'forrest'],
    ['targetDomain', 'owned-run'],
    ['targetBrainId', 'brain-other'],
    ['targetRunId', 'run-other'],
    ['targetRequesterAgent', 'other'],
    ['canonicalRoot', '/brains/other'],
    ['accessMode', 'write'],
    ['operationType', 'pgs'],
    ['operationId', 'op-999'],
    ['sourcePinDigest', `sha256:${'b'.repeat(64)}`],
    ['issuedAt', value.issuedAt - 1],
    ['expiresAt', value.expiresAt + 1],
    ['nonce', 'nonce-other'],
  ]) {
    assert.throws(
      () => verifyCapability(TEST_KEY, token, expected(value, { [field]: replacement })),
      (error) => error?.code === 'capability_mismatch',
      field,
    );
  }
});

test('capability supports exact brain, owned-run, requester, and source-free bindings', () => {
  const variants = [
    claims(),
    claims({
      targetDomain: 'owned-run',
      targetBrainId: null,
      targetRunId: 'run-7',
      canonicalRoot: '/runs/run-7',
      nonce: 'nonce-run',
    }),
    claims({
      targetDomain: 'requester',
      targetBrainId: null,
      targetRequesterAgent: 'jerry',
      canonicalRoot: null,
      sourcePinDigest: null,
      operationType: 'stored-result-export',
      nonce: 'nonce-requester',
    }),
  ];

  for (const value of variants) {
    const token = issueCapability(TEST_KEY, value);
    assert.deepEqual(verifyCapability(TEST_KEY, token, expected(value)), value);
  }
});

test('capability parsing is strict base64url and converts all malformed forms to typed errors', () => {
  const valid = claims();
  const malformedTokens = [
    '',
    null,
    'one-part',
    'a.b.c',
    '.signature',
    'payload.',
    '+w.signature',
    signedPayload('not-an-object'),
    signedPayload(null),
    signedPayload([]),
    signedRawPayload('{definitely-not-json'),
  ];
  for (const token of malformedTokens) {
    assert.throws(
      () => verifyCapability(TEST_KEY, token, expected(valid)),
      (error) => typeof error?.code === 'string' && error.code.startsWith('capability_'),
    );
  }

  const good = issueCapability(TEST_KEY, valid);
  const [payload, signature] = good.split('.');
  const altered = `${payload}.${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => verifyCapability(TEST_KEY, altered, expected(valid)), /capability_invalid/);
  assert.throws(() => verifyCapability('2'.repeat(64), good, expected(valid)), /capability_invalid/);
  assert.throws(() => verifyCapability(TEST_KEY, `${payload}=.${signature}`, expected(valid)), /capability_invalid/);
  assert.throws(() => verifyCapability(TEST_KEY, `${payload}.${signature}=`, expected(valid)), /capability_invalid/);
});

test('capability claims fail closed for every malformed structural and time case', () => {
  const base = claims();
  const malformed = [
    { ...base, v: 2 },
    { ...base, requesterAgent: '' },
    { ...base, requesterAgent: 7 },
    { ...base, accessMode: '' },
    { ...base, operationType: null },
    { ...base, operationId: '   ' },
    { ...base, nonce: '' },
    { ...base, targetDomain: 'other' },
    { ...base, targetBrainId: null },
    { ...base, targetRunId: 'run-too' },
    { ...base, canonicalRoot: null },
    { ...base, canonicalRoot: 'relative/path' },
    { ...base, targetBrainId: 8 },
    { ...base, sourcePinDigest: 'sha256:nope' },
    { ...base, issuedAt: 'now' },
    { ...base, issuedAt: NOW + 5_001 },
    { ...base, expiresAt: 'later' },
    { ...base, expiresAt: NOW },
    { ...base, expiresAt: NOW - 1 },
    { ...base, issuedAt: NOW + 2, expiresAt: NOW + 1 },
    { ...base, expiresAt: NOW + CAPABILITY_MAX_TTL_MS + 1 },
    {
      ...base,
      targetDomain: 'owned-run',
      targetBrainId: null,
      targetRunId: 'run-7',
      targetRequesterAgent: 'jerry',
      canonicalRoot: '/runs/run-7',
    },
    {
      ...base,
      targetDomain: 'requester',
      targetBrainId: null,
      targetRequesterAgent: 'forrest',
      canonicalRoot: null,
    },
    {
      ...base,
      targetDomain: 'requester',
      targetBrainId: null,
      targetRequesterAgent: 'jerry',
      canonicalRoot: '/must-be-null',
    },
    { ...base, unexpected: 'not-authorized' },
    JSON.parse(`{"requesterAgent":"jerry","targetDomain":"brain","targetBrainId":"brain-forrest","targetRunId":null,"targetRequesterAgent":null,"canonicalRoot":"/brains/forrest","accessMode":"read-only","operationType":"query","operationId":"op-123","sourcePinDigest":"sha256:${'a'.repeat(64)}","issuedAt":${NOW},"expiresAt":${NOW + 60_000},"nonce":"nonce-1","__proto__":"danger"}`),
  ];

  for (const missing of Object.keys(base)) {
    const value = { ...base };
    delete value[missing];
    malformed.push(value);
  }

  for (const value of malformed) {
    const withVersion = value.v === undefined ? { v: 1, ...value } : value;
    const token = signedPayload(withVersion);
    assert.throws(
      () => verifyCapability(TEST_KEY, token, expected(base)),
      (error) => typeof error?.code === 'string' && error.code.startsWith('capability_'),
    );
  }
  const token = issueCapability(TEST_KEY, base);
  assert.throws(() => verifyCapability(TEST_KEY, token, { ...base }), /capability_invalid/);
});

test('capability issue and verify reject missing keys or non-object claims without leaking native errors', () => {
  for (const key of ['', null, undefined]) {
    assert.throws(() => issueCapability(key, claims()), /capability_unavailable/);
    assert.throws(() => verifyCapability(key, 'a.b', expected()), /capability_unavailable/);
  }
  for (const value of [null, [], 'claims', 7]) {
    assert.throws(
      () => issueCapability(TEST_KEY, value),
      (error) => error?.code === 'capability_invalid',
    );
  }
  const withGetter = { ...claims() };
  Object.defineProperty(withGetter, 'nonce', {
    enumerable: true,
    get() { throw new Error('getter must not run'); },
  });
  for (const value of [
    { ...claims(), unexpected: true },
    { ...claims(), v: 1 },
    withGetter,
  ]) {
    assert.throws(
      () => issueCapability(TEST_KEY, value),
      (error) => error?.code === 'capability_invalid',
    );
  }
});

test('nonce store accepts one of 32 concurrent consumes and rejects replay', async () => {
  let now = NOW;
  const store = new CapabilityNonceStore({ now: () => now });
  const attempts = await Promise.allSettled(
    Array.from({ length: 32 }, () => Promise.resolve().then(() => store.consume({
      nonce: 'shared-nonce',
      operationId: 'op-123',
      expiresAt: NOW + 60_000,
    }))),
  );
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter((result) => result.reason?.code === 'capability_replay').length, 31);

  now = NOW + 60_001;
  assert.equal(store.consume({ nonce: 'shared-nonce', operationId: 'op-new', expiresAt: now + 1_000 }), true);
});

test('nonce store prunes expired entries and fails closed at live capacity', () => {
  let now = NOW;
  const store = new CapabilityNonceStore({ now: () => now, maxEntries: 2 });
  assert.equal(store.consume({ nonce: 'n1', operationId: 'op-1', expiresAt: now + 100 }), true);
  assert.equal(store.consume({ nonce: 'n2', operationId: 'op-2', expiresAt: now + 100 }), true);
  assert.throws(
    () => store.consume({ nonce: 'n3', operationId: 'op-3', expiresAt: now + 100 }),
    (error) => error?.code === 'capability_nonce_capacity',
  );
  assert.throws(
    () => store.consume({ nonce: 'n1', operationId: 'other', expiresAt: now + 100 }),
    (error) => error?.code === 'capability_replay',
  );
  now += 101;
  assert.equal(store.consume({ nonce: 'n3', operationId: 'op-3', expiresAt: now + 100 }), true);
});

test('nonce store defaults to 100000 and rejects invalid or already-expired records', () => {
  const store = new CapabilityNonceStore({ now: () => NOW });
  assert.equal(store.maxEntries, 100_000);
  for (const record of [
    null,
    {},
    { nonce: '', operationId: 'op', expiresAt: NOW + 1 },
    { nonce: 'nonce', operationId: '', expiresAt: NOW + 1 },
    { nonce: 'nonce', operationId: 'op', expiresAt: 'later' },
    { nonce: 'nonce', operationId: 'op', expiresAt: NOW },
  ]) {
    assert.throws(
      () => store.consume(record),
      (error) => error?.code === 'capability_invalid' || error?.code === 'capability_expired',
    );
  }
});

test('nonce store rejects a nonfinite injected clock without accepting a replay marker', () => {
  const store = new CapabilityNonceStore({ now: () => Number.NaN });
  assert.throws(
    () => store.consume({ nonce: 'nonce', operationId: 'op', expiresAt: NOW + 1 }),
    (error) => error?.code === 'capability_invalid',
  );
  assert.equal(store.entries.size, 0);
});
