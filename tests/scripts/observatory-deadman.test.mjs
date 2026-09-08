import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, initialState, validateState, COOLDOWN_MS } from '../../scripts/lib/observatory-deadman.mjs';

const fail = (state, now = 100) => advance(state, false, now);
const threshold = (now = 100) => fail(fail(fail(initialState(), now).state, now).state, now);

test('a transient failure recovers silently and resets consecutive count', () => {
  const first = fail(initialState());
  assert.deepEqual(first.actions, []);
  const recovery = advance(first.state, true, 101);
  assert.deepEqual(recovery, { state: initialState(), actions: [] });
  assert.equal(fail(recovery.state).state.failures, 1);
});

test('only the third consecutive failure reserves one restart and outage alert', () => {
  const first = fail(initialState());
  const second = fail(first.state);
  assert.deepEqual(second.actions, []);
  const third = fail(second.state);
  assert.deepEqual(third.actions, ['restart', 'outage']);
  assert.equal(third.state.lastRestartAt, 100);
  assert.equal(third.state.incident.restartAttempted, true);
});

test('an ongoing incident never repeats its restart or outage, even after cooldown', () => {
  let { state } = threshold();
  for (const now of [101, COOLDOWN_MS + 100, COOLDOWN_MS * 10]) {
    const next = fail(JSON.parse(JSON.stringify(state)), now);
    assert.deepEqual(next.actions, []);
    state = next.state;
  }
});

test('recovery notice is reserved once, only after an acknowledged outage', () => {
  const { state } = threshold();
  assert.deepEqual(advance(state, true, 101).actions, []);
  state.incident.alerted = true;
  const recovery = advance(state, true, 101);
  assert.deepEqual(recovery.actions, ['recovery']);
  assert.deepEqual(advance(recovery.state, true, 102).actions, []);
  assert.equal(recovery.state.lastRestartAt, 100);
});

test('cooldown survives recovery and defers a new incident restart until its boundary', () => {
  let { state } = threshold();
  state = advance(state, true, 101).state;
  state = fail(fail(state, 102).state, 103).state;
  let next = fail(state, 104);
  assert.deepEqual(next.actions, ['outage']);
  next = fail(next.state, COOLDOWN_MS + 99);
  assert.deepEqual(next.actions, []);
  next = fail(next.state, COOLDOWN_MS + 100);
  assert.deepEqual(next.actions, ['restart']);
  assert.deepEqual(fail(next.state, COOLDOWN_MS * 3).actions, []);
});

test('failed restart/delivery retains reservations; no retry storm or false recovery', () => {
  const { state } = threshold(); // Reservations survive even if every effect fails.
  assert.deepEqual(fail(state, COOLDOWN_MS * 2).actions, []);
  assert.deepEqual(advance(state, true, COOLDOWN_MS * 2).actions, []);
});

test('backward wall clock does not bypass cooldown', () => {
  let { state } = threshold();
  state = advance(state, true, 101).state;
  state = fail(fail(state, 1).state, 2).state;
  assert.deepEqual(fail(state, 3).actions, ['outage']);
});

test('corrupt persisted state fails closed rather than discarding deduplication', () => {
  assert.deepEqual(validateState(initialState()), initialState());
  assert.deepEqual(validateState(threshold().state), threshold().state);
  for (const state of [{}, { ...initialState(), failures: -1 }, { ...initialState(), lastRestartAt: '100' },
    { ...initialState(), incident: { alerted: true, restartAttempted: true } }]) {
    assert.throws(() => validateState(state), /Invalid deadman state/);
  }
});
