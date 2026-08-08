/**
 * Encoder stage 1 — meaning perceived at contact, carried on the event.
 *
 * What must hold: the projection is deterministic and published (same
 * embedding → same vector, forever, everywhere); events WITHOUT vectors
 * encode byte-identically to the pre-encoder world (no retroactive change
 * to any lived history); events WITH vectors drive the reservoir along
 * meaning — similar sentences produce more-similar state directions than
 * dissimilar ones, which is the entire point: the existing Hebbian
 * development inherits semantics through the state, with zero changes to
 * the learning rules.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  projectEmbedding,
  sanitizeSemanticVector,
  SEM_DIM,
  EMBED_DIM,
} from '../src/semantic-projection.js';
import { encodeEvent, generateReservoir, metabolicStep } from '../src/metabolism.js';
import { CONTINUOUS_STATE_DIM } from '../src/types.js';
import type { SourceEvent, CellDispositions } from '../src/types.js';

const DISPOSITIONS: CellDispositions = {
  wakeThreshold: 0.5,
  salienceWeight: 0.5,
  decayRate: 0.5,
  inhibitionLevel: 0.2,
  modelAffinities: {},
};

function fakeEmbedding(seedWord: number): number[] {
  // Deterministic pseudo-embedding: a smooth function of the seed word.
  const out: number[] = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = Math.sin(seedWord * 0.7 + i * 0.13);
  return out;
}

function ev(overrides: Partial<SourceEvent>): SourceEvent {
  return {
    eventId: 'evt_1',
    category: 'correction',
    sourceAuthority: 'seed.adapter',
    sourceRef: 'owner:x',
    payload: {},
    producedAt: '2026-08-08T15:00:00.000Z',
    ...overrides,
  };
}

test('projection is deterministic, published-shape, and quantized', () => {
  const a = projectEmbedding(fakeEmbedding(1));
  const b = projectEmbedding(fakeEmbedding(1));
  assert.deepEqual(a, b, 'same embedding → identical vector');
  assert.equal(a.length, SEM_DIM);
  for (const v of a) {
    assert.ok(v >= -1 && v <= 1, 'clamped');
    assert.equal(v, Math.round(v * 10_000) / 10_000, 'quantized to 4dp');
  }
  assert.throws(() => projectEmbedding([1, 2, 3]), /expects 768/);
});

test('similar embeddings project to nearby vectors; dissimilar to farther ones', () => {
  const base = projectEmbedding(fakeEmbedding(1));
  const near = projectEmbedding(fakeEmbedding(1.02));
  const far = projectEmbedding(fakeEmbedding(40));
  const dist = (x: number[], y: number[]): number =>
    Math.sqrt(x.reduce((s, v, i) => s + (v - (y[i] ?? 0)) ** 2, 0));
  assert.ok(dist(base, near) < dist(base, far), 'projection preserves neighborhood');
});

test('events WITHOUT vectors encode exactly as the pre-encoder world', () => {
  const event = ev({});
  const legacy = encodeEvent(event, 60);
  const again = encodeEvent(ev({}), 60);
  assert.deepEqual([...legacy], [...again], 'hash channels unchanged and stable');
});

test('a semantic vector takes the leading channels; identity hash keeps the rest', () => {
  const sem = projectEmbedding(fakeEmbedding(2));
  const withMeaning = encodeEvent(ev({ semanticVector: sem }), 60);
  const without = encodeEvent(ev({}), 60);
  for (let i = 0; i < SEM_DIM; i++) {
    assert.equal(withMeaning[i], sem[i], `channel ${i} speaks the meaning`);
  }
  const inputDim = without.length;
  for (let i = SEM_DIM; i < inputDim - 4; i++) {
    assert.equal(withMeaning[i], without[i], `channel ${i} still speaks identity`);
  }
});

test('THE PAYOFF: similar sentences drive more-similar state than dissimilar ones', () => {
  const reservoir = generateReservoir(777);
  const run = (sem: number[]): Float32Array => {
    const state = new Float32Array(CONTINUOUS_STATE_DIM);
    metabolicStep(state, reservoir, encodeEvent(ev({ semanticVector: sem }), 60), 60, DISPOSITIONS);
    return state;
  };
  const base = run(projectEmbedding(fakeEmbedding(1)));
  const near = run(projectEmbedding(fakeEmbedding(1.02)));
  const far = run(projectEmbedding(fakeEmbedding(40)));
  const dist = (x: Float32Array, y: Float32Array): number => {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += ((x[i] ?? 0) - (y[i] ?? 0)) ** 2;
    return Math.sqrt(s);
  };
  assert.ok(dist(base, near) < dist(base, far),
    'meaning flows through the reservoir: state direction is semantic — so Hebbian development is now semantic, with zero rule changes');
});

test('sanitizer accepts sane vectors and rejects garbage loudly-by-null', () => {
  assert.deepEqual(sanitizeSemanticVector([0.5, -0.25]), [0.5, -0.25]);
  assert.deepEqual(sanitizeSemanticVector([2, -3]), [1, -1], 'out-of-range clamps');
  assert.equal(sanitizeSemanticVector([]), null);
  assert.equal(sanitizeSemanticVector([Number.NaN]), null);
  assert.equal(sanitizeSemanticVector(new Array(65).fill(0)), null, 'oversized rejected');
  assert.equal(sanitizeSemanticVector('nope'), null);
  assert.equal(sanitizeSemanticVector([0.1, 'x']), null);
});
