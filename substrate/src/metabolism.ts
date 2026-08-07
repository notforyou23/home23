/**
 * Metabolism — the continuous temporal core (Cut 2).
 *
 * Mechanism (decided 2026-08-07, jtr-approved; see
 * instances/jerry/workspace/research/home23-substrate-os/CUT2-GROUNDWORK-AND-DECISIONS.md):
 * a FIXED deterministic reservoir with STATIC readouts. The reservoir supplies
 * temporal dynamics — decay, recurrence, order-sensitivity, associative
 * residue. Nothing in this file learns. Plasticity arrives in Cut 3 as
 * receipted deltas over the readout weights, and ONLY there — that separation
 * is what makes the ablation knife sharp: zero the learned readout deltas,
 * keep the reservoir, the episodes, and the retrieval surfaces, and replay.
 *
 * Determinism contract (hard):
 *   - every update is a pure function of (state, encoded event, event-time Δt)
 *   - no wall-clock reads, no unseeded randomness
 *   - the reservoir is generated from a recorded seed (ledger genesis payload)
 *   - replaying the same events from the same checkpoint reproduces
 *     byte-identical Float32 state and identical state hashes
 *
 * This is still explicitly NOT a neural network being trained. It is the
 * simplest continuous mechanism with a real temporal interior.
 */

import { createHash } from 'node:crypto';
import type { SourceEvent, CellDispositions } from './types.js';
import { CONTINUOUS_STATE_DIM } from './types.js';

export const METABOLISM_VERSION = 1;
export const INPUT_DIM = 32;

/** Spectral radius the recurrent weights are scaled to. <1 keeps dynamics
 * fading (echo-state property): the past matters and dissolves, both. */
const TARGET_SPECTRAL_RADIUS = 0.9;
/** Connections per reservoir row. Sparse keeps dynamics structured. */
const ROW_CONNECTIONS = 10;
/** Continuous-state decay half-life in seconds when events stop arriving. */
const DECAY_HALF_LIFE_SECONDS = 6 * 3600;

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Reservoir ───────────────────────────────────────────────────────────────

export interface Reservoir {
  readonly seed: number;
  readonly dim: number;
  readonly inputDim: number;
  readonly version: number;
  /** dim × dim recurrent weights, row-major, spectral radius ≈ TARGET. Frozen. */
  readonly weights: Float64Array;
  /** dim × inputDim input weights. Frozen. */
  readonly inputWeights: Float64Array;
  /** Static readout weights (salience, novelty). Frozen in Cut 2; Cut 3 layers
   * receipted plastic deltas OVER these — never mutates them. */
  readonly readoutSalience: Float64Array;
  readonly readoutNovelty: Float64Array;
}

/** Generate the frozen reservoir from a recorded seed. Same seed → identical
 * matrices, on any machine, forever. */
export function generateReservoir(seed: number, dim = CONTINUOUS_STATE_DIM, inputDim = INPUT_DIM): Reservoir {
  const rand = mulberry32(seed);

  // Sparse recurrent matrix
  const weights = new Float64Array(dim * dim);
  for (let row = 0; row < dim; row++) {
    for (let k = 0; k < ROW_CONNECTIONS; k++) {
      const col = Math.floor(rand() * dim);
      weights[row * dim + col] = rand() * 2 - 1;
    }
  }

  // Scale to target spectral radius via deterministic power iteration.
  let v = new Float64Array(dim);
  for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
  let radius = 0;
  for (let iter = 0; iter < 50; iter++) {
    const next = new Float64Array(dim);
    for (let r = 0; r < dim; r++) {
      let sum = 0;
      for (let c = 0; c < dim; c++) sum += (weights[r * dim + c] ?? 0) * (v[c] ?? 0);
      next[r] = sum;
    }
    radius = Math.sqrt(next.reduce((s, x) => s + x * x, 0));
    if (radius === 0) break;
    for (let i = 0; i < dim; i++) next[i] = (next[i] ?? 0) / radius;
    v = next;
  }
  if (radius > 0) {
    const scale = TARGET_SPECTRAL_RADIUS / radius;
    for (let i = 0; i < weights.length; i++) weights[i] = (weights[i] ?? 0) * scale;
  }

  const inputWeights = new Float64Array(dim * inputDim);
  for (let i = 0; i < inputWeights.length; i++) inputWeights[i] = (rand() * 2 - 1) * 0.5;

  // Static readouts from a separated stream of the same seed.
  const readoutRand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const readoutSalience = new Float64Array(dim);
  const readoutNovelty = new Float64Array(dim);
  for (let i = 0; i < dim; i++) {
    readoutSalience[i] = (readoutRand() * 2 - 1) / Math.sqrt(dim);
    readoutNovelty[i] = (readoutRand() * 2 - 1) / Math.sqrt(dim);
  }

  return Object.freeze({
    seed,
    dim,
    inputDim,
    version: METABOLISM_VERSION,
    weights,
    inputWeights,
    readoutSalience,
    readoutNovelty,
  });
}

// ─── Event encoding ──────────────────────────────────────────────────────────

const CATEGORY_CHANNEL: Record<string, number> = {
  observation: 0.1,
  interpretation: 0.2,
  proposal: 0.3,
  act: 0.4,
  consequence: 0.6,
  correction: 0.9,   // corrections are the strongest contact signal
  transition: 0.05,
  checkpoint: 0.0,
  genesis: 0.0,
  stop: 0.0,
};

/** Deterministically encode an event into the reservoir's input vector.
 * Content channels come from a sha256 of the event's identity — stable,
 * content-addressed, no wall clock. */
export function encodeEvent(event: SourceEvent, dtSeconds: number, inputDim = INPUT_DIM): Float64Array {
  const u = new Float64Array(inputDim);
  const digest = createHash('sha256')
    .update(`${event.sourceRef}:${event.producedAt}:${event.category}:${event.sourceAuthority}`, 'utf-8')
    .digest();
  const contentChannels = inputDim - 4;
  for (let i = 0; i < contentChannels; i++) {
    const b = digest[i % digest.length] ?? 0;
    u[i] = (b / 127.5) - 1; // [-1, 1]
  }
  u[inputDim - 4] = CATEGORY_CHANNEL[event.category] ?? 0.5;
  u[inputDim - 3] = event.sourceAuthority === 'seed.internal' ? -0.5 : 0.5;
  // Elapsed event-time, log-compressed: 1s→~0.03, 1h→~0.35, 1d→~0.49, capped 1.
  u[inputDim - 2] = Math.min(1, Math.log1p(Math.max(0, dtSeconds)) / 23);
  u[inputDim - 1] = 1; // bias
  return u;
}

// ─── Metabolic update ────────────────────────────────────────────────────────

/**
 * One metabolic step for a cell's continuous state, in place:
 *   1. event-time decay:  x *= exp(-λ·Δt)   (unattended state fades)
 *   2. leaky reservoir:   x = (1-α)x + α·tanh(Wx + W_in·u)
 * Pure in (state bytes, encoded input, Δt); Float32 storage keeps the result
 * byte-reproducible across replay.
 */
export function metabolicStep(
  state: Float32Array,
  reservoir: Reservoir,
  input: Float64Array,
  dtSeconds: number,
  dispositions: CellDispositions,
): void {
  const dim = reservoir.dim;
  const lambda = Math.LN2 / DECAY_HALF_LIFE_SECONDS;
  const decay = Math.exp(-lambda * Math.max(0, dtSeconds));
  // Cell-level decayRate disposition steepens or softens the ambient decay.
  const effectiveDecay = decay * (1 - dispositions.decayRate * 0.1);

  const x = new Float64Array(dim);
  for (let i = 0; i < dim; i++) x[i] = (state[i] ?? 0) * effectiveDecay;

  const leak = 0.35;
  for (let r = 0; r < dim; r++) {
    let pre = 0;
    for (let c = 0; c < dim; c++) pre += (reservoir.weights[r * dim + c] ?? 0) * (x[c] ?? 0);
    for (let c = 0; c < reservoir.inputDim; c++) pre += (reservoir.inputWeights[r * reservoir.inputDim + c] ?? 0) * (input[c] ?? 0);
    state[r] = Math.fround((1 - leak) * (x[r] ?? 0) + leak * Math.tanh(pre));
  }
}

// ─── Readouts (static in Cut 2) ──────────────────────────────────────────────

export interface Readouts {
  /** 0..1 — how much this state currently wants attention. */
  salience: number;
  /** 0..1 — how far the state moved this step (surprise proxy). */
  novelty: number;
  /** mean |x| — gross activation level. */
  arousal: number;
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export function computeReadouts(
  before: Float32Array,
  after: Float32Array,
  reservoir: Reservoir,
): Readouts {
  let sal = 0;
  let nov = 0;
  let arousal = 0;
  let deltaMag = 0;
  for (let i = 0; i < reservoir.dim; i++) {
    const a = after[i] ?? 0;
    sal += (reservoir.readoutSalience[i] ?? 0) * a;
    nov += (reservoir.readoutNovelty[i] ?? 0) * a;
    arousal += Math.abs(a);
    const d = a - (before[i] ?? 0);
    deltaMag += d * d;
  }
  arousal /= reservoir.dim;
  const movement = Math.min(1, Math.sqrt(deltaMag / reservoir.dim) * 4);
  return {
    salience: sigmoid(sal * 3),
    novelty: Math.min(1, sigmoid(nov * 3) * 0.5 + movement * 0.5),
    arousal,
  };
}

// ─── Event-time helpers ──────────────────────────────────────────────────────

/** Δt in seconds between two ISO timestamps, clamped ≥ 0 (out-of-order events
 * contribute zero elapsed time rather than negative decay). */
export function eventDeltaSeconds(previousIso: string, currentIso: string): number {
  const prev = Date.parse(previousIso);
  const curr = Date.parse(currentIso);
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return 0;
  return Math.max(0, (curr - prev) / 1000);
}
