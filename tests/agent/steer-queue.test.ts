import test from 'node:test';
import assert from 'node:assert/strict';
import { SteerQueue, takeOperatorSteer } from '../../src/agent/steer-queue.ts';

test('enqueue rejects empty text and overflow past 8', () => {
  const queue = new SteerQueue();
  assert.deepEqual(queue.enqueue('chat-1', '   '), { ok: false, error: 'empty' });
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(queue.enqueue('chat-1', `note ${i}`), { ok: true });
  }
  assert.deepEqual(queue.enqueue('chat-1', 'one more'), { ok: false, error: 'overflow' });
  assert.equal(queue.pendingCount('chat-1'), 8);
});

test('drain returns queued notes once and prefixes them', () => {
  const queue = new SteerQueue();
  queue.enqueue('chat-a', 'do not restart nginx');
  queue.enqueue('chat-a', 'read the logs');
  queue.enqueue('chat-b', 'other chat');
  assert.deepEqual(queue.drain('chat-a'), [
    'do not restart nginx',
    'read the logs',
  ]);
  assert.deepEqual(queue.drain('chat-a'), []);
  assert.equal(queue.pendingCount('chat-b'), 1);
});

test('takeOperatorSteer joins drained notes with the operator prefix', () => {
  const queue = new SteerQueue();
  queue.enqueue('s1', 'stop');
  queue.enqueue('s1', 'try grep instead');
  const text = takeOperatorSteer('s1', queue);
  assert.equal(text, '[Operator steer] stop\n\n[Operator steer] try grep instead');
  assert.equal(takeOperatorSteer('s1', queue), null);
});
