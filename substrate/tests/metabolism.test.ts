import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mulberry32,
  generateReservoir,
  encodeEvent,
  metabolicStep,
  computeReadouts,
  eventDeltaSeconds,
  INPUT_DIM,
} from '../src/metabolism.js';
import { CONTINUOUS_STATE_DIM } from '../src/types.js';
import type { SourceEvent, CellDispositions } from '../src/types.js';

function makeEvent(overrides: Partial<SourceEvent> = {}): SourceEvent {
  return {
    eventId: 'evt_m',
    category: 'observation',
    sourceAuthority: 'seed.adapter',
    sourceRef: 'ref-metabolism',
    payload: {},
    producedAt: '2026-08-07T12:00:00.000Z',
    ...overrides,
  };
}

function makeDispositions(): CellDispositions {
  return { wakeThreshold: 0.3, salienceWeight: 0.6, inhibitionLevel: 0.2, decayRate: 0.05, modelAffinities: {} };
}

test('mulberry32 is deterministic and seed-sensitive', () => {
  const a1 = mulberry32(42);
  const a2 = mulberry32(42);
  const b = mulberry32(43);
  const seqA1 = [a1(), a1(), a1()];
  const seqA2 = [a2(), a2(), a2()];
  const seqB = [b(), b(), b()];
  assert.deepEqual(seqA1, seqA2);
  assert.notDeepEqual(seqA1, seqB);
});

test('same seed generates byte-identical reservoirs; different seeds diverge', () => {
  const r1 = generateReservoir(1234);
  const r2 = generateReservoir(1234);
  const r3 = generateReservoir(1235);
  assert.deepEqual(Array.from(r1.weights), Array.from(r2.weights));
  assert.deepEqual(Array.from(r1.readoutSalience), Array.from(r2.readoutSalience));
  assert.notDeepEqual(Array.from(r1.weights), Array.from(r3.weights));
});

test('reservoir dynamics are fading (echo-state): free-run activity contracts', () => {
  const r = generateReservoir(777);
  const state = new Float32Array(CONTINUOUS_STATE_DIM).fill(0.8);
  const silentInput = new Float64Array(INPUT_DIM); // no drive at all
  const dispositions = makeDispositions();
  let prevNorm = Math.hypot(...Array.from(state));
  let contracted = 0;
  for (let i = 0; i < 20; i++) {
    metabolicStep(state, r, silentInput, 60, dispositions);
    const norm = Math.hypot(...Array.from(state));
    if (norm < prevNorm) contracted++;
    prevNorm = norm;
  }
  assert.ok(contracted >= 15, `activity should contract without input drive (contracted ${contracted}/20 steps)`);
  assert.ok(prevNorm < 4, `norm should have decayed substantially (got ${prevNorm})`);
});

test('metabolicStep is deterministic: same state, event, Δt → identical bytes', () => {
  const r = generateReservoir(99);
  const dispositions = makeDispositions();
  const s1 = new Float32Array(CONTINUOUS_STATE_DIM);
  const s2 = new Float32Array(CONTINUOUS_STATE_DIM);
  const u = encodeEvent(makeEvent(), 30);
  for (let i = 0; i < 5; i++) {
    metabolicStep(s1, r, u, 30, dispositions);
    metabolicStep(s2, r, u, 30, dispositions);
  }
  for (let i = 0; i < s1.length; i++) {
    assert.ok(Object.is(s1[i], s2[i]), `slot ${i} diverged`);
  }
});

test('elapsed event-time matters: same event at different Δt produces different state', () => {
  const r = generateReservoir(99);
  const dispositions = makeDispositions();
  const s1 = new Float32Array(CONTINUOUS_STATE_DIM);
  const s2 = new Float32Array(CONTINUOUS_STATE_DIM);
  // Prime both with the same first event
  const prime = encodeEvent(makeEvent({ sourceRef: 'prime' }), 0);
  metabolicStep(s1, r, prime, 0, dispositions);
  metabolicStep(s2, r, prime, 0, dispositions);
  // Same second event, but one arrives a minute later, the other a week later
  const eventSoon = encodeEvent(makeEvent({ sourceRef: 'later' }), 60);
  const eventLate = encodeEvent(makeEvent({ sourceRef: 'later' }), 7 * 24 * 3600);
  metabolicStep(s1, r, eventSoon, 60, dispositions);
  metabolicStep(s2, r, eventLate, 7 * 24 * 3600, dispositions);
  const different = Array.from(s1).some((v, i) => !Object.is(v, s2[i]));
  assert.ok(different, 'a week of silence must leave a different interior than a minute');
});

test('event order matters: A-then-B differs from B-then-A', () => {
  const r = generateReservoir(555);
  const dispositions = makeDispositions();
  const sAB = new Float32Array(CONTINUOUS_STATE_DIM);
  const sBA = new Float32Array(CONTINUOUS_STATE_DIM);
  const uA = encodeEvent(makeEvent({ sourceRef: 'event-A', category: 'correction' }), 10);
  const uB = encodeEvent(makeEvent({ sourceRef: 'event-B', category: 'observation' }), 10);
  metabolicStep(sAB, r, uA, 10, dispositions);
  metabolicStep(sAB, r, uB, 10, dispositions);
  metabolicStep(sBA, r, uB, 10, dispositions);
  metabolicStep(sBA, r, uA, 10, dispositions);
  const different = Array.from(sAB).some((v, i) => !Object.is(v, sBA[i]));
  assert.ok(different, 'order must be causal — a queue replay in any order would hash the same otherwise');
});

test('readouts are bounded and respond to movement', () => {
  const r = generateReservoir(2026);
  const dispositions = makeDispositions();
  const state = new Float32Array(CONTINUOUS_STATE_DIM);
  const before = new Float32Array(state);
  const u = encodeEvent(makeEvent({ category: 'correction' }), 5);
  metabolicStep(state, r, u, 5, dispositions);
  const readouts = computeReadouts(before, state, r);
  for (const [k, v] of Object.entries(readouts)) {
    assert.ok(v >= 0 && v <= 1, `${k} out of [0,1]: ${v}`);
  }
  assert.ok(readouts.novelty > 0, 'a first event into a silent state must register as movement');
});

test('eventDeltaSeconds clamps out-of-order and garbage timestamps to 0', () => {
  assert.equal(eventDeltaSeconds('2026-08-07T12:00:00.000Z', '2026-08-07T12:01:00.000Z'), 60);
  assert.equal(eventDeltaSeconds('2026-08-07T12:01:00.000Z', '2026-08-07T12:00:00.000Z'), 0);
  assert.equal(eventDeltaSeconds('not-a-time', '2026-08-07T12:00:00.000Z'), 0);
});
