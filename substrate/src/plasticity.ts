/**
 * Plasticity — development as receipted deltas (Cut 3).
 *
 * The reservoir stays FROZEN. What learns:
 *   - per-cell readout deltas over the continuous state (salience, novelty)
 *   - bounded disposition deltas (wake threshold, salience weight, inhibition)
 *   - routing affinities by source prefix
 *   - trust calibration by source prefix
 *
 * The learning rule is a PURE function of (development, cell state, event,
 * readouts) — no wall clock, no randomness — so replaying the same event
 * stream reproduces identical development, and the ablation knife has a crisp
 * target: zero this structure, keep every episode, replay, diff behavior.
 *
 * Every applied update is receipted as a 'development' record before it
 * becomes live (the ONE commit path). Deltas begin 'provisional'; Cut 3's
 * consolidation loop may later promote or roll them back — also receipted.
 */

import type { SituationCell, SourceEvent, CellDispositions } from './types.js';
import { CONTINUOUS_STATE_DIM } from './types.js';
import type { Readouts } from './metabolism.js';

export const PLASTICITY_VERSION = 1;

// ─── Bounds (the anti-drift constitution of learning) ────────────────────────

export const LEARNING_RATE = 0.05;
export const READOUT_WEIGHT_CLIP = 0.5;      // per-weight |w| ceiling
export const WAKE_DELTA_MIN = -0.15;         // corrections can lower wake threshold this far
export const WAKE_DELTA_MAX = 0.15;
export const DISPOSITION_DELTA_CLIP = 0.2;
export const ROUTING_AFFINITY_CLIP = 0.3;
export const TRUST_MIN = 0.5;
export const TRUST_MAX = 1.5;
export const WAKE_STEP = 0.015;              // per-correction wake easing
export const ROUTING_STEP = 0.05;

// ─── Structures ──────────────────────────────────────────────────────────────

/** Per-cell plastic state. Arrays are plain number[] — small, JSON-exact,
 * checkpoint-friendly. All values bounded by the constants above. */
export interface CellPlasticState {
  readoutSalience: number[];                 // CONTINUOUS_STATE_DIM
  readoutNovelty: number[];
  wakeThresholdDelta: number;
  salienceWeightDelta: number;
  inhibitionDelta: number;
  routingAffinity: Record<string, number>;   // source prefix → bias
  trust: Record<string, number>;             // source prefix → multiplier
  updateCount: number;
}

/** Seed-level development: cellId → plastic state. THE ablation target. */
export type DevelopmentalState = Record<string, CellPlasticState>;

export function emptyCellPlasticState(dim = CONTINUOUS_STATE_DIM): CellPlasticState {
  return {
    readoutSalience: new Array(dim).fill(0),
    readoutNovelty: new Array(dim).fill(0),
    wakeThresholdDelta: 0,
    salienceWeightDelta: 0,
    inhibitionDelta: 0,
    routingAffinity: {},
    trust: {},
    updateCount: 0,
  };
}

export function emptyDevelopment(): DevelopmentalState {
  return {};
}

export function cloneCellPlasticState(p: CellPlasticState): CellPlasticState {
  return {
    readoutSalience: [...p.readoutSalience],
    readoutNovelty: [...p.readoutNovelty],
    wakeThresholdDelta: p.wakeThresholdDelta,
    salienceWeightDelta: p.salienceWeightDelta,
    inhibitionDelta: p.inhibitionDelta,
    routingAffinity: { ...p.routingAffinity },
    trust: { ...p.trust },
    updateCount: p.updateCount,
  };
}

export function cloneDevelopment(dev: DevelopmentalState): DevelopmentalState {
  const out: DevelopmentalState = {};
  for (const [cellId, p] of Object.entries(dev)) out[cellId] = cloneCellPlasticState(p);
  return out;
}

/** Total learned mass — used by inspection and the field journal, and by
 * tests asserting ablation actually removed something. */
export function developmentMagnitude(dev: DevelopmentalState): number {
  let sum = 0;
  for (const p of Object.values(dev)) {
    for (const w of p.readoutSalience) sum += Math.abs(w);
    for (const w of p.readoutNovelty) sum += Math.abs(w);
    sum += Math.abs(p.wakeThresholdDelta) + Math.abs(p.salienceWeightDelta) + Math.abs(p.inhibitionDelta);
    for (const v of Object.values(p.routingAffinity)) sum += Math.abs(v);
    for (const v of Object.values(p.trust)) sum += Math.abs(v - 1);
  }
  return sum;
}

// ─── Source prefix (routing/trust key) ───────────────────────────────────────

/** Stable coarse key for a source: the event_type-ish prefix before ':'. */
export function sourcePrefix(event: SourceEvent): string {
  const ref = event.sourceRef;
  const idx = ref.indexOf(':');
  return idx > 0 ? ref.slice(0, idx) : ref;
}

// ─── The learning rule (corrections teach) ───────────────────────────────────

function clip(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export interface PlasticUpdateSummary {
  cellId: string;
  rule: 'correction.v1';
  salienceDeltaNorm: number;
  wakeThresholdDelta: number;
  routingKey: string;
  routingAffinity: number;
  trustKey: string;
  trust: number;
  updateCount: number;
}

/**
 * Apply one correction-driven plastic update, in place on a STAGED development
 * clone. Deterministic given (plastic, cell.continuousState, event, readouts).
 *
 * The rule: a correction means this state-context mattered more than the
 * Seed's salience said. So —
 *   - raise the salience readout along the CURRENT continuous-state direction
 *     (Hebbian-flavored: Δw_i = η · x_i), per-weight clipped;
 *   - ease the cell's wake threshold a bounded step;
 *   - lean routing toward this cell for this source prefix;
 *   - nudge trust in this source upward (a source that corrects us is one
 *     reality flows through).
 * Returns a summary for the development receipt.
 */
export function applyCorrectionPlasticity(
  dev: DevelopmentalState,
  cell: SituationCell,
  event: SourceEvent,
  readouts: Readouts,
): PlasticUpdateSummary {
  const plastic = dev[cell.id] ?? emptyCellPlasticState(cell.continuousState.length);
  dev[cell.id] = plastic;

  // Salience readout: Hebbian along current state, scaled by how much the
  // step actually moved (novelty) so stale repeats teach less than surprises.
  const eta = LEARNING_RATE * (0.5 + readouts.novelty * 0.5);
  let deltaNormSq = 0;
  for (let i = 0; i < cell.continuousState.length; i++) {
    const x = cell.continuousState[i] ?? 0;
    const step = eta * x;
    const next = clip((plastic.readoutSalience[i] ?? 0) + step, -READOUT_WEIGHT_CLIP, READOUT_WEIGHT_CLIP);
    deltaNormSq += (next - (plastic.readoutSalience[i] ?? 0)) ** 2;
    plastic.readoutSalience[i] = next;
  }

  plastic.wakeThresholdDelta = clip(plastic.wakeThresholdDelta - WAKE_STEP, WAKE_DELTA_MIN, WAKE_DELTA_MAX);

  const key = sourcePrefix(event);
  plastic.routingAffinity[key] = clip((plastic.routingAffinity[key] ?? 0) + ROUTING_STEP, 0, ROUTING_AFFINITY_CLIP);
  plastic.trust[key] = clip((plastic.trust[key] ?? 1) + 0.05, TRUST_MIN, TRUST_MAX);
  plastic.updateCount += 1;

  return {
    cellId: cell.id,
    rule: 'correction.v1',
    salienceDeltaNorm: Math.sqrt(deltaNormSq),
    wakeThresholdDelta: plastic.wakeThresholdDelta,
    routingKey: key,
    routingAffinity: plastic.routingAffinity[key] ?? 0,
    trustKey: key,
    trust: plastic.trust[key] ?? 1,
    updateCount: plastic.updateCount,
  };
}

// ─── Effective values (frozen base + plastic delta, at every use site) ───────

export function effectiveSalienceWeights(
  base: Float64Array,
  plastic: CellPlasticState | undefined,
): Float64Array {
  if (plastic === undefined) return base;
  const out = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = (base[i] ?? 0) + (plastic.readoutSalience[i] ?? 0);
  return out;
}

export function effectiveNoveltyWeights(
  base: Float64Array,
  plastic: CellPlasticState | undefined,
): Float64Array {
  if (plastic === undefined) return base;
  const out = new Float64Array(base.length);
  for (let i = 0; i < base.length; i++) out[i] = (base[i] ?? 0) + (plastic.readoutNovelty[i] ?? 0);
  return out;
}

export function effectiveDispositions(
  dispositions: CellDispositions,
  plastic: CellPlasticState | undefined,
): CellDispositions {
  if (plastic === undefined) return dispositions;
  return {
    ...dispositions,
    wakeThreshold: clip(dispositions.wakeThreshold + plastic.wakeThresholdDelta, 0.05, 0.95),
    salienceWeight: clip(dispositions.salienceWeight + plastic.salienceWeightDelta, 0.05, 1),
    inhibitionLevel: clip(dispositions.inhibitionLevel + plastic.inhibitionDelta, 0, 0.9),
  };
}
