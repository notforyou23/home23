import test from 'node:test';
import assert from 'node:assert/strict';
import { ActivityLease } from '../../src/agent/activity-lease.js';

class ManualClock {
  nowMs = 0;
  tasks = new Map<number, { at: number; fn: () => void }>();
  nextId = 1;
  now = (): number => this.nowMs;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.tasks.set(id, { at: this.nowMs + ms, fn });
    return id;
  };
  clearTimeout = (id: number): void => { this.tasks.delete(id); };
  advance(ms: number): void {
    this.nowMs += ms;
    for (;;) {
      const due = [...this.tasks.entries()]
        .filter(([, task]) => task.at <= this.nowMs)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0]);
      if (due.length === 0) return;
      for (const [id, task] of due) {
        if (!this.tasks.delete(id)) continue;
        task.fn();
      }
    }
  }
}

test('monotonic brain-operation activity renews inactivity without moving the hard deadline', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({
    inactivityMs: 15,
    hardDurationMs: 60,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: reason => expirations.push(reason),
  });
  lease.start();
  clock.advance(10);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 1 }), true);
  clock.advance(10);
  assert.equal(expirations.length, 0);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 2 }), true);
  clock.advance(14);
  assert.equal(expirations.length, 0);
  clock.advance(1);
  assert.deepEqual(expirations, ['inactivity_timeout']);
});

test('duplicate or regressed operation sequence cannot renew the lease', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({
    inactivityMs: 10,
    hardDurationMs: 100,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: reason => expirations.push(reason),
  });
  lease.start();
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 2 }), true);
  clock.advance(8);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 2 }), false);
  assert.equal(lease.observe({ operationId: 'op-1', sequence: 1 }), false);
  clock.advance(3);
  assert.deepEqual(expirations, ['inactivity_timeout']);
});

test('verified activity never moves the immutable hard deadline', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({
    inactivityMs: 10,
    hardDurationMs: 30,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: reason => expirations.push(reason),
  });
  lease.start();
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    clock.advance(8);
    assert.equal(lease.observe({ operationId: 'op-hard', sequence }), true);
  }
  clock.advance(6);
  assert.deepEqual(expirations, ['hard_timeout']);
});

test('close is idempotent and rejects all later activity', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({
    inactivityMs: 10,
    hardDurationMs: 30,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: reason => expirations.push(reason),
  });
  lease.start();
  lease.close();
  lease.close();
  assert.equal(lease.observe({ operationId: 'op-closed', sequence: 1 }), false);
  clock.advance(100);
  assert.deepEqual(expirations, []);
});

test('an overdue immutable hard deadline wins when timer delivery is delayed', () => {
  const clock = new ManualClock();
  const expirations: string[] = [];
  const lease = new ActivityLease({
    inactivityMs: 10,
    hardDurationMs: 30,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onExpire: reason => expirations.push(reason),
  });
  lease.start();
  clock.advance(30);
  assert.deepEqual(expirations, ['hard_timeout']);
});
