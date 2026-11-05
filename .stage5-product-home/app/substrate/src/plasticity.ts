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
export const CONSEQUENCE_ETA_FACTOR = 0.5;   // outcomes teach at half correction rate
export const CONSEQUENCE_TRUST_STEP = 0.03;
// attenuation.v1 — "that was noise, care less". The inverse teacher.
export const ATTENUATION_ETA_FACTOR = 1.0;   // care-less teaches at full correction rate
export const ATTENUATION_WAKE_STEP = 0.015;  // per-attenuation wake HARDENING
// resolution.v1 — a resolved prediction is the purest consequence signal.
export const RESOLUTION_ETA_FACTOR = 0.5;    // same tempo as other outcomes
export const RESOLUTION_ACCURATE_MAX = 0.3;  // error ≤ this → corroboration
export const RESOLUTION_WRONG_MIN = 0.7;     // error ≥ this → negative trace
// Between the two bands, resolution teaches NOTHING — ambiguity is not a teacher.
/** Event-time gap that counts as quiet time; consolidation fires on the
 * transition that ENDS the gap (derivable from the stream → replayable). */
export const QUIET_GAP_SECONDS = 30 * 60;
/** Consolidation retention floor: fully uncorroborated learning keeps this
 * fraction per quiet gap; fully corroborated learning keeps everything. */
export const CONSOLIDATION_RETENTION_FLOOR = 0.6;
export const MAX_LINEAGE_ENTRIES = 16;

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
  /** Corrections since the last consolidation — the provisional load. */
  updatesSinceConsolidation: number;
  /** Consequences landed since the last consolidation — corroboration that
   * reality responded without correcting. */
  corroborations: number;
  consolidations: number;
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
    updatesSinceConsolidation: 0,
    corroborations: 0,
    consolidations: 0,
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
    updatesSinceConsolidation: p.updatesSinceConsolidation,
    corroborations: p.corroborations,
    consolidations: p.consolidations,
  };
}

/** Fill counter fields missing from development stored by earlier plasticity
 * shapes (the live resident's first v2 checkpoints) — restore-time normalize;
 * stored bytes are validated as-written, normalization is in-memory only. */
export function normalizeDevelopment(dev: DevelopmentalState): DevelopmentalState {
  const out: DevelopmentalState = {};
  for (const [cellId, p] of Object.entries(dev)) {
    out[cellId] = {
      ...emptyCellPlasticState(p.readoutSalience?.length ?? CONTINUOUS_STATE_DIM),
      ...p,
      updatesSinceConsolidation: p.updatesSinceConsolidation ?? 0,
      corroborations: p.corroborations ?? 0,
      consolidations: p.consolidations ?? 0,
    };
  }
  return out;
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
  rule: 'correction.v1' | 'consequence.v1' | 'attenuation.v1' | 'resolution.v1';
  salienceDeltaNorm: number;
  wakeThresholdDelta: number;
  routingKey: string;
  routingAffinity: number;
  trustKey: string;
  trust: number;
  updateCount: number;
  /** resolution.v1 only: which prediction resolved, and how wrong it was. */
  predictionId?: string;
  predictionError?: number;
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
  plastic.updatesSinceConsolidation += 1;

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

/**
 * Consequence-driven plastic update: reality responded. Teaches at half the
 * correction rate along the same state direction, nudges trust in the source,
 * and — the consolidation input — counts as CORROBORATION: learning that was
 * in play when reality responded without correcting has earned its keep.
 * No wake easing: outcomes should not make cells trigger-happy.
 */
export function applyConsequencePlasticity(
  dev: DevelopmentalState,
  cell: SituationCell,
  event: SourceEvent,
  readouts: Readouts,
): PlasticUpdateSummary {
  const plastic = dev[cell.id] ?? emptyCellPlasticState(cell.continuousState.length);
  dev[cell.id] = plastic;

  const eta = LEARNING_RATE * CONSEQUENCE_ETA_FACTOR * (0.5 + readouts.novelty * 0.5);
  let deltaNormSq = 0;
  for (let i = 0; i < cell.continuousState.length; i++) {
    const x = cell.continuousState[i] ?? 0;
    const step = eta * x;
    const next = clip((plastic.readoutSalience[i] ?? 0) + step, -READOUT_WEIGHT_CLIP, READOUT_WEIGHT_CLIP);
    deltaNormSq += (next - (plastic.readoutSalience[i] ?? 0)) ** 2;
    plastic.readoutSalience[i] = next;
  }

  const key = sourcePrefix(event);
  plastic.trust[key] = clip((plastic.trust[key] ?? 1) + CONSEQUENCE_TRUST_STEP, TRUST_MIN, TRUST_MAX);
  plastic.updateCount += 1;
  plastic.corroborations += 1;

  return {
    cellId: cell.id,
    rule: 'consequence.v1',
    salienceDeltaNorm: Math.sqrt(deltaNormSq),
    wakeThresholdDelta: plastic.wakeThresholdDelta,
    routingKey: key,
    routingAffinity: plastic.routingAffinity[key] ?? 0,
    trustKey: key,
    trust: plastic.trust[key] ?? 1,
    updateCount: plastic.updateCount,
  };
}

/**
 * attenuation.v1 — "that was noise, care less." The inverse of correction.v1,
 * with two deliberate asymmetries:
 *   - the TEACHER keeps their trust and their routing: care-less is about the
 *     CONTEXT (the current continuous state, Hebbian locality), never about
 *     the channel that taught it;
 *   - the update is provisional like all learning — if reality keeps making
 *     this context matter, consolidation decays the attenuation back out.
 * Effects: negative salience trace along current state, bounded wake
 * HARDENING. Nothing else moves.
 */
export function applyAttenuationPlasticity(
  dev: DevelopmentalState,
  cell: SituationCell,
  event: SourceEvent,
  readouts: Readouts,
): PlasticUpdateSummary {
  const plastic = dev[cell.id] ?? emptyCellPlasticState(cell.continuousState.length);
  dev[cell.id] = plastic;

  const eta = LEARNING_RATE * ATTENUATION_ETA_FACTOR * (0.5 + readouts.novelty * 0.5);
  let deltaNormSq = 0;
  for (let i = 0; i < cell.continuousState.length; i++) {
    const x = cell.continuousState[i] ?? 0;
    const step = -eta * x;
    const next = clip((plastic.readoutSalience[i] ?? 0) + step, -READOUT_WEIGHT_CLIP, READOUT_WEIGHT_CLIP);
    deltaNormSq += (next - (plastic.readoutSalience[i] ?? 0)) ** 2;
    plastic.readoutSalience[i] = next;
  }

  plastic.wakeThresholdDelta = clip(plastic.wakeThresholdDelta + ATTENUATION_WAKE_STEP, WAKE_DELTA_MIN, WAKE_DELTA_MAX);
  plastic.updateCount += 1;
  plastic.updatesSinceConsolidation += 1;

  const key = sourcePrefix(event);
  return {
    cellId: cell.id,
    rule: 'attenuation.v1',
    salienceDeltaNorm: Math.sqrt(deltaNormSq),
    wakeThresholdDelta: plastic.wakeThresholdDelta,
    routingKey: key,
    routingAffinity: plastic.routingAffinity[key] ?? 0,   // unchanged, by design
    trustKey: key,
    trust: plastic.trust[key] ?? 1,                        // unchanged, by design
    updateCount: plastic.updateCount,
  };
}

/**
 * resolution.v1 — a resolved prediction is the purest consequence signal a
 * Seed has: it made a falsifiable claim and reality answered.
 *   - accurate (error ≤ RESOLUTION_ACCURATE_MAX): corroboration — positive
 *     salience trace scaled by (1 − error), corroborations += 1 (survives
 *     consolidation fully);
 *   - wrong (error ≥ RESOLUTION_WRONG_MIN): negative trace scaled by error,
 *     provisional (decays if not later corroborated);
 *   - ambiguous middle band: returns null — NO development, no receipt.
 * No wake change, no routing change, no trust change: being right or wrong
 * about the world alters what this state-context is worth, not how easily
 * the world gets in.
 */
export function applyResolutionPlasticity(
  dev: DevelopmentalState,
  cell: SituationCell,
  predictionId: string,
  error: number,
): PlasticUpdateSummary | null {
  if (!Number.isFinite(error)) return null;
  const accurate = error <= RESOLUTION_ACCURATE_MAX;
  const wrong = error >= RESOLUTION_WRONG_MIN;
  if (!accurate && !wrong) return null;

  const plastic = dev[cell.id] ?? emptyCellPlasticState(cell.continuousState.length);
  dev[cell.id] = plastic;

  const eta = LEARNING_RATE * RESOLUTION_ETA_FACTOR * (accurate ? (1 - error) : error);
  const sign = accurate ? 1 : -1;
  let deltaNormSq = 0;
  for (let i = 0; i < cell.continuousState.length; i++) {
    const x = cell.continuousState[i] ?? 0;
    const step = sign * eta * x;
    const next = clip((plastic.readoutSalience[i] ?? 0) + step, -READOUT_WEIGHT_CLIP, READOUT_WEIGHT_CLIP);
    deltaNormSq += (next - (plastic.readoutSalience[i] ?? 0)) ** 2;
    plastic.readoutSalience[i] = next;
  }

  plastic.updateCount += 1;
  if (accurate) plastic.corroborations += 1;
  else plastic.updatesSinceConsolidation += 1;

  return {
    cellId: cell.id,
    rule: 'resolution.v1',
    salienceDeltaNorm: Math.sqrt(deltaNormSq),
    wakeThresholdDelta: plastic.wakeThresholdDelta,
    routingKey: 'self.prediction',
    routingAffinity: 0,
    trustKey: 'self.prediction',
    trust: 1,
    updateCount: plastic.updateCount,
    predictionId,
    predictionError: error,
  };
}

// ─── Quiet-time consolidation (fires on the transition that ends a gap) ──────

export interface ConsolidationCellSummary {
  cellId: string;
  retention: number;
  corroborationRatio: number;
  magnitudeBefore: number;
  magnitudeAfter: number;
}

function cellMagnitude(p: CellPlasticState): number {
  let sum = 0;
  for (const w of p.readoutSalience) sum += Math.abs(w);
  for (const w of p.readoutNovelty) sum += Math.abs(w);
  sum += Math.abs(p.wakeThresholdDelta) + Math.abs(p.salienceWeightDelta) + Math.abs(p.inhibitionDelta);
  for (const v of Object.values(p.routingAffinity)) sum += Math.abs(v);
  for (const v of Object.values(p.trust)) sum += Math.abs(v - 1);
  return sum;
}

/**
 * Consolidation rule (consolidation.v1). Pure function of the development
 * state alone — the gap that triggers it is read from the EVENT STREAM
 * (dt > QUIET_GAP_SECONDS on the arriving transition), never from the wall
 * clock, so replay reproduces every consolidation exactly.
 *
 * Learning whose provisional load was corroborated by consequences retains
 * fully; uncorroborated learning decays toward the retention floor. This IS
 * the rollback path for bad deltas: unearned changes fade across quiet gaps
 * instead of compounding. Cells with no provisional load are untouched.
 */
export function applyConsolidation(dev: DevelopmentalState): ConsolidationCellSummary[] {
  const summaries: ConsolidationCellSummary[] = [];
  for (const cellId of Object.keys(dev).sort()) {
    const p = dev[cellId];
    if (p === undefined || p.updatesSinceConsolidation === 0) continue;
    const magnitudeBefore = cellMagnitude(p);
    const corroborationRatio = Math.min(1, p.corroborations / p.updatesSinceConsolidation);
    const retention = CONSOLIDATION_RETENTION_FLOOR + (1 - CONSOLIDATION_RETENTION_FLOOR) * corroborationRatio;

    for (let i = 0; i < p.readoutSalience.length; i++) p.readoutSalience[i] = (p.readoutSalience[i] ?? 0) * retention;
    for (let i = 0; i < p.readoutNovelty.length; i++) p.readoutNovelty[i] = (p.readoutNovelty[i] ?? 0) * retention;
    p.wakeThresholdDelta *= retention;
    p.salienceWeightDelta *= retention;
    p.inhibitionDelta *= retention;
    for (const k of Object.keys(p.routingAffinity)) p.routingAffinity[k] = (p.routingAffinity[k] ?? 0) * retention;
    for (const k of Object.keys(p.trust)) p.trust[k] = 1 + ((p.trust[k] ?? 1) - 1) * retention;

    p.updatesSinceConsolidation = 0;
    p.corroborations = 0;
    p.consolidations += 1;

    summaries.push({
      cellId,
      retention,
      corroborationRatio,
      magnitudeBefore,
      magnitudeAfter: cellMagnitude(p),
    });
  }
  return summaries;
}

/** Trust multiplier a cell's development assigns to a source (1 = neutral). */
export function trustFor(plastic: CellPlasticState | undefined, event: SourceEvent): number {
  if (plastic === undefined) return 1;
  return plastic.trust[sourcePrefix(event)] ?? 1;
}
