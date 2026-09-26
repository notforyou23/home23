import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PersistenceScheduler } = require('../../../engine/src/core/persistence-scheduler.js');

// A manual clock: timers fire only when the test advances time.
function fakeClock(start = Date.parse('2026-09-26T12:00:00Z')) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].callback();
        for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
      }
      now = until;
      for (let i = 0; i < 5; i += 1) await new Promise(setImmediate);
    },
  };
}

// A resident brain and the orchestrator's saveState contract: every save
// reports its outcome through recordSave.
function harness(options = {}) {
  const clock = fakeClock();
  const brain = { dirty: false, saves: [], outcomes: [...(options.outcomes || [])], hold: null };
  const scheduler = new PersistenceScheduler({
    isDirty: () => brain.dirty,
    isSaving: () => Boolean(brain.hold),
    save: async (reason) => {
      brain.saves.push({ reason, at: clock.now() });
      if (options.holdSaves) await new Promise((resolve) => { brain.hold = resolve; });
      brain.hold = null;
      const outcome = brain.outcomes.shift() || { saved: true, memoryRevision: 100 + brain.saves.length };
      if (outcome.saved === true && !outcome.searchStale) brain.dirty = false;
      scheduler.recordSave(outcome);
      return outcome;
    },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...options.scheduler,
  });
  return { clock, brain, scheduler };
}

test('a graph left dirty with no cycles is saved within maxDirtyAgeMs', async () => {
  const { clock, brain, scheduler } = harness();
  scheduler.start();
  await clock.advance(30_000);
  assert.equal(brain.saves.length, 0, 'nothing to save while clean');
  brain.dirty = true; // a discarded cycle, a thrown cycle, or a paused engine
  await clock.advance(60_000);
  assert.equal(brain.saves.length, 0, 'not yet a minute since it was seen dirty');
  await clock.advance(15_000);
  assert.equal(brain.saves.length, 1);
  assert.equal(brain.saves[0].reason, 'dirty-age');
  const status = scheduler.status();
  assert.equal(status.dirty, false);
  assert.equal(status.persistedRevision, 101);
  assert.equal(status.consecutiveRefusals, 0);
  assert.equal(status.lastPersistedAt, new Date(brain.saves[0].at).toISOString());
  await clock.advance(10 * 60_000);
  assert.equal(brain.saves.length, 1, 'no saves while clean');
});

test('a feeder request saves within requestDelayMs and coalesces', async () => {
  const { clock, brain, scheduler } = harness();
  scheduler.start();
  brain.dirty = true;
  scheduler.request('feeder');
  scheduler.request('feeder');
  await clock.advance(4_999);
  assert.equal(brain.saves.length, 0);
  await clock.advance(1);
  assert.deepEqual(brain.saves.map((save) => save.reason), ['feeder']);
  brain.dirty = true;
  scheduler.request('feeder');
  await clock.advance(5_000);
  assert.equal(brain.saves.length, 1, 'held to minIntervalMs after the last attempt');
  await clock.advance(10_000);
  assert.equal(brain.saves.length, 2);
  scheduler.request('feeder');
  await clock.advance(60_000);
  assert.equal(brain.saves.length, 2, 'a request with nothing unsaved is ignored');
});

test('a request during an in-progress save joins it and does not save twice', async () => {
  const { clock, brain, scheduler } = harness({ holdSaves: true });
  scheduler.start();
  brain.dirty = true;
  scheduler.request('feeder');
  await clock.advance(5_000);
  assert.equal(brain.saves.length, 1);
  scheduler.request('feeder');
  await clock.advance(120_000);
  assert.equal(brain.saves.length, 1, 'nothing starts while a save runs');
  assert.equal(scheduler.status().saving, true);
  brain.hold();
  await clock.advance(120_000);
  assert.equal(brain.saves.length, 1, 'the running save covered the request');
  assert.equal(scheduler.status().dirty, false);
});

test('a save started elsewhere satisfies a pending request', async () => {
  const { clock, brain, scheduler } = harness();
  scheduler.start();
  brain.dirty = true;
  scheduler.request('feeder');
  brain.hold = () => {}; // a cycle's saveState is running
  await clock.advance(20_000);
  assert.equal(brain.saves.length, 0);
  brain.hold = null;
  brain.dirty = false;
  scheduler.recordSave({ saved: true, memoryRevision: 7 }); // what saveState reports
  await clock.advance(120_000);
  assert.equal(brain.saves.length, 0);
  assert.equal(scheduler.status().persistedRevision, 7);
});

test('a refused save backs off and status counts consecutive refusals', async () => {
  const refusal = { saved: false, reason: 'memory_sidecar_write_failed', error: 'graph summary mismatch' };
  // A small brain saved inline after its sidecar failed: search is stale.
  const inline = { saved: true, sidecars: 'inline', searchStale: true };
  const { clock, brain, scheduler } = harness({ outcomes: [refusal, inline, refusal] });
  scheduler.start();
  brain.dirty = true;
  scheduler.request('feeder');
  await clock.advance(5_000);
  assert.equal(brain.saves.length, 1);
  assert.equal(scheduler.status().consecutiveRefusals, 1);
  await clock.advance(29_000);
  assert.equal(brain.saves.length, 1, 'backing off 30 s after the first refusal');
  await clock.advance(46_000); // the dirty-age floor fires at 65 s
  assert.equal(brain.saves.length, 2);
  let status = scheduler.status();
  assert.equal(status.consecutiveRefusals, 2, 'an inline fallback is not a persisted save');
  assert.equal(status.searchStale, true);
  assert.equal(status.dirty, true);
  await clock.advance(44_000);
  assert.equal(brain.saves.length, 2, 'the back-off doubles to 60 s');
  await clock.advance(1_000);
  assert.equal(brain.saves.length, 3);
  status = scheduler.status();
  assert.equal(status.consecutiveRefusals, 3);
  assert.equal(status.lastSaveResult.reason, 'memory_sidecar_write_failed');
  assert.equal(status.lastSaveResult.error, 'graph summary mismatch');
  assert.equal(status.unpersistedForMs, 125_000, 'unpersisted age keeps growing across refusals');
  assert.equal(status.nextSaveNotBefore, new Date(clock.now() + 120_000).toISOString());
  await clock.advance(10 * 60_000);
  status = scheduler.status();
  assert.equal(status.consecutiveRefusals, 0, 'the next save persisted');
  assert.equal(status.dirty, false);
});

test('stop clears the timer and later ticks and requests do nothing', async () => {
  const { clock, brain, scheduler } = harness();
  scheduler.start();
  assert.equal(clock.pending(), 1);
  scheduler.stop();
  assert.equal(clock.pending(), 0);
  brain.dirty = true;
  scheduler.request('feeder');
  await clock.advance(30 * 60_000);
  assert.equal(brain.saves.length, 0);
  assert.equal(clock.pending(), 0);
  assert.equal(scheduler.status().running, false);
});
