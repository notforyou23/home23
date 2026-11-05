import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChannelClass,
  Channel,
  ensureTraceId,
  makeTraceId,
  makeObservation,
  validateObservation,
  VERIFICATION_FLAGS,
} from '../../../engine/src/channels/contract.js';

test('ChannelClass enum lists the six classes', () => {
  assert.deepEqual(Object.keys(ChannelClass).sort(), [
    'BUILD', 'DOMAIN', 'MACHINE', 'NEIGHBOR', 'OS', 'WORK',
  ]);
});

test('VERIFICATION_FLAGS mirrors the harness enum', () => {
  assert.deepEqual([...VERIFICATION_FLAGS].sort(), [
    'COLLECTED', 'UNCERTIFIED', 'UNKNOWN', 'ZERO_CONTEXT',
  ]);
});

test('makeObservation builds a well-formed record', () => {
  const obs = makeObservation({
    channelId: 'build.git',
    sourceRef: 'commit:deadbeef',
    payload: { sha: 'deadbeef' },
    flag: 'COLLECTED',
    confidence: 0.9,
    producedAt: '2026-04-21T15:00:00Z',
  });
  assert.equal(obs.channelId, 'build.git');
  assert.equal(obs.flag, 'COLLECTED');
  assert.equal(obs.traceId, makeTraceId('build.git', 'commit:deadbeef'));
  assert.ok(obs.receivedAt);
  assert.equal(obs.verifierId, null);
});

test('makeObservation traceId is deterministic from channelId and sourceRef', () => {
  const a = makeTraceId('machine.cpu', 'cpu:2026-04-21T00:00:00Z');
  const b = makeTraceId('machine.cpu', 'cpu:2026-04-21T00:00:00Z');
  const c = makeTraceId('machine.memory', 'cpu:2026-04-21T00:00:00Z');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^trace:[0-9a-f]{24}$/);
});

test('ensureTraceId preserves existing trace ids and fills missing ones', () => {
  assert.equal(ensureTraceId({ traceId: 'trace:custom' }).traceId, 'trace:custom');
  const obs = ensureTraceId({ channelId: 'x.y', sourceRef: 's' });
  assert.equal(obs.traceId, makeTraceId('x.y', 's'));
});

test('validateObservation accepts complete observations', () => {
  const obs = makeObservation({
    channelId: 'build.git',
    sourceRef: 'commit:abc',
    payload: {},
    flag: 'COLLECTED',
    confidence: 0.8,
    producedAt: '2026-04-21T00:00:00Z',
  });
  assert.equal(validateObservation(obs), obs);
});

test('validateObservation rejects malformed observations', () => {
  assert.throws(() => validateObservation(null), /must be an object/);
  assert.throws(() => validateObservation({
    traceId: 'bad',
    channelId: 'x.y',
    sourceRef: 's',
    payload: {},
    flag: 'COLLECTED',
    confidence: 0.5,
    producedAt: 't',
    receivedAt: 't',
  }), /traceId invalid/);
  assert.throws(() => validateObservation({
    traceId: makeTraceId('x.y', 's'),
    channelId: '',
    sourceRef: 's',
    payload: {},
    flag: 'COLLECTED',
    confidence: 0.5,
    producedAt: 't',
    receivedAt: 't',
  }), /channelId is required/);
});

test('makeObservation rejects invalid verification flag', () => {
  assert.throws(() => makeObservation({
    channelId: 'x.y', sourceRef: 's', payload: {}, flag: 'MAYBE', confidence: 0.5, producedAt: '2026-04-21T00:00:00Z',
  }), /invalid verification flag/);
});

test('makeObservation rejects out-of-range confidence', () => {
  assert.throws(() => makeObservation({
    channelId: 'x.y', sourceRef: 's', payload: {}, flag: 'COLLECTED', confidence: 1.5, producedAt: '2026-04-21T00:00:00Z',
  }), /confidence must be/);
});

test('Channel abstract methods throw when not overridden', async () => {
  const c = new Channel({ id: 'x.y', class: ChannelClass.BUILD });
  await assert.rejects(() => Promise.resolve().then(() => c.source()), /not implemented/);
  assert.throws(() => c.parse({}), /not implemented/);
});
