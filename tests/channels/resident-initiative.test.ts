import test from 'node:test';
import assert from 'node:assert/strict';
import { createResidentInitiativeHandler, createResidentInitiativeStatusHandler } from '../../src/channels/resident-initiative.js';

const request = { initiationId: 'move-1', pursuitId: 'ap_music', snapshotDigest: 'a'.repeat(64), purpose: 'exploration',
  nextMove: 'Compare two sourced musical examples.', stopCondition: 'Stop after one comparison or missing evidence.', evidenceRefs: ['memory:guitar'], timeoutMs: 300000 };
test('engine initiative requires bearer authority and leaves conversation identity to signed Core', async () => {
  const admitted: unknown[] = [];
  const handler = createResidentInitiativeHandler({ token: 'fixture-secret', initiate: async input => { admitted.push(input); return { initiationId: input.initiationId, state: 'queued', workId: 'work-1' }; } });
  let status = 200; let body: any;
  const res = { status(value: number) { status = value; return this; }, json(value: unknown) { body = value; } };
  await handler({ headers: {}, body: request }, res);
  assert.equal(status, 401); assert.equal(admitted.length, 0);
  status = 200;
  await handler({ headers: { authorization: 'Bearer fixture-secret' }, body: { ...request, residentSlug: 'forrest' } }, res);
  assert.equal(status, 400); assert.equal(admitted.length, 0);
  status = 200;
  await handler({ headers: { authorization: 'Bearer fixture-secret' }, body: request }, res);
  assert.equal(status, 200); assert.equal(body.workId, 'work-1'); assert.deepEqual(admitted, [request]);
});

test('initiative status bridge authenticates and only accepts an identity for read-only observation', async () => {
  const reads: unknown[] = [];
  const handler = createResidentInitiativeStatusHandler({ token: 'fixture-secret', status: async input => {
    reads.push(input); return { ...input, state: 'not_admitted' };
  } });
  let status = 200; let body: any;
  const res = { status(value: number) { status = value; return this; }, json(value: unknown) { body = value; } };
  await handler({ headers: {}, body: { initiationId: 'move-1' } }, res); assert.equal(status, 401);
  for (const input of [{ initiationId: 'move-1', nextMove: 'Run this' }, { initiationId: 'x'.repeat(129) }, [], { initiationId: 'bad\0id' }]) {
    status = 200; await handler({ headers: { authorization: 'Bearer fixture-secret' }, body: input }, res); assert.equal(status, 400);
  }
  assert.equal(reads.length, 0);
  status = 200; await handler({ headers: { authorization: 'Bearer fixture-secret' }, body: { initiationId: 'move-1' } }, res);
  assert.equal(status, 200); assert.equal(body.state, 'not_admitted'); assert.deepEqual(reads, [{ initiationId: 'move-1' }]);
});
