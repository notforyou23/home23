/**
 * Cell factory and Float32 continuous state operations.
 *
 * The continuous state is a real Float32Array — not reconstructed from prose.
 * It carries timing, salience, associative residue, and transition tendencies.
 *
 * Deterministic transition rule (Cut 1):
 *   - Compute sha256 of `${event.sourceRef}:${event.producedAt}:${event.category}`
 *   - Unpack first 32 bytes as 8 big-endian float32 values in [-1, 1]
 *   - Apply decay: all floats *= (1 - dispositions.decayRate)
 *   - Add 8 fingerprint floats to slots [0..7], clamped to [-1, 1]
 *
 * This is explicitly NOT a neural network. It is the simplest continuous state
 * that satisfies: deterministic, inspectable, non-zero after events, and cannot
 * be reconstructed from prose.
 */

import { createHash } from 'node:crypto';
import type {
  SituationCell,
  SerializedCell,
  CellDispositions,
  CellStatus,
  SourceEvent,
} from './types.js';
import { CONTINUOUS_STATE_DIM, requireNamedAnatomy } from './types.js';
import type { AnatomyCellSpec } from './types.js';
import type { Reservoir, Readouts } from './metabolism.js';
import { encodeEvent, metabolicStep, computeReadouts } from './metabolism.js';
import type { CellPlasticState, DevelopmentalState } from './plasticity.js';
import { effectiveSalienceWeights, effectiveNoveltyWeights, sourcePrefix, trustFor } from './plasticity.js';

// ─── Default dispositions per cell ───────────────────────────────────────────

function defaultDispositions(cellId: string): CellDispositions {
  // periphery has strict inhibition; others start permissive
  const isPeriphery = cellId.startsWith('periphery.');
  return {
    wakeThreshold: isPeriphery ? 0.7 : 0.3,
    salienceWeight: isPeriphery ? 0.4 : 0.6,
    inhibitionLevel: isPeriphery ? 0.6 : 0.2,
    decayRate: isPeriphery ? 0.15 : 0.05,
    modelAffinities: {},
  };
}

// ─── Factory ─────────────────────────────────────────────────────────────────

export function makeInitialCell(id: string, now: string): SituationCell {
  return {
    id,
    generation: 0,
    status: 'forming' as CellStatus,
    realityRefs: [],
    estimates: [],
    intentions: [],
    predictions: [],
    continuousState: new Float32Array(CONTINUOUS_STATE_DIM),
    dispositions: defaultDispositions(id),
    associations: [],
    lobeAffinities: {},
    workspacePressure: 0,
    interruptionPressure: 0,
    uncertainty: 0.5,
    energy: { current: 0.5, peak: 0.5 },
    developmentalLineage: [],
    lastTransitionAt: now,
  };
}

export function makeInitialCells(now: string, anatomy: readonly AnatomyCellSpec[]): Map<string, SituationCell> {
  const named = requireNamedAnatomy(anatomy);
  const cells = new Map<string, SituationCell>();
  for (const spec of named) {
    const cell = makeInitialCell(spec.id, now);
    // Periphery keeps the strict default dispositions keyed off its id prefix;
    // non-prefix peripheries get them explicitly from their ROLE.
    if (spec.role === 'periphery' && !spec.id.startsWith('periphery.')) {
      cell.dispositions = { wakeThreshold: 0.7, salienceWeight: 0.4, inhibitionLevel: 0.6, decayRate: 0.15, modelAffinities: {} };
    }
    cells.set(spec.id, cell);
  }
  // After formation, non-periphery cells wake to 'living'; periphery forms.
  const peripheryId = named.find((a) => a.role === 'periphery')?.id;
  for (const [id, cell] of cells) {
    if (id !== peripheryId) cell.status = 'living';
  }
  return cells;
}

/** Category → cellId routing table from an anatomy. */
export function routingFromAnatomy(anatomy: readonly AnatomyCellSpec[]): { byCategory: Record<string, string>; peripheryId: string } {
  const byCategory: Record<string, string> = {};
  let peripheryId = anatomy[anatomy.length - 1]?.id ?? 'periphery.open-field';
  for (const spec of anatomy) {
    if (spec.role === 'periphery') peripheryId = spec.id;
    else byCategory[spec.role] = spec.id;
  }
  return { byCategory, peripheryId };
}

// ─── Routing heuristic ────────────────────────────────────────────────────────

/** Route an event to a cell id when targetCellId is not specified. */
/** Static category routing, with a bounded LEARNED override (Cut 3): a cell
 * whose routing affinity for this source prefix was earned through receipted
 * development (≥ 0.15, clearly above the static target's own affinity) takes
 * the event instead. Deterministic — sorted iteration, explicit margins. */
export function routeEvent(
  event: SourceEvent,
  cellIds: string[],
  development?: DevelopmentalState,
  routing?: { byCategory: Record<string, string>; peripheryId: string },
): string {
  if (event.targetCellId && cellIds.includes(event.targetCellId)) {
    return event.targetCellId;
  }
  if (routing === undefined) {
    throw new Error('routeEvent requires routing from named anatomy — refusing to invent a person');
  }
  const table = routing;
  const staticTarget = table.byCategory[event.category] ?? table.peripheryId;
  if (development !== undefined) {
    const key = sourcePrefix(event);
    let bestId = staticTarget;
    let bestAffinity = development[staticTarget]?.routingAffinity[key] ?? 0;
    for (const id of [...cellIds].sort()) {
      const affinity = development[id]?.routingAffinity[key] ?? 0;
      if (affinity >= 0.15 && affinity > bestAffinity + 0.05) {
        bestId = id;
        bestAffinity = affinity;
      }
    }
    return bestId;
  }
  return staticTarget;
}

// ─── Continuous state update (Cut 2: reservoir metabolism, event-time) ───────

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Cell energy half-life in seconds of event-time without contact. */
const ENERGY_HALF_LIFE_SECONDS = 2 * 3600;

/** Reality refs a cell retains (most recent last). */
const MAX_CELL_REALITY_REFS = 32;

/**
 * Apply one metabolic transition to a cell, in place. Deterministic given
 * (cell state, event, Δt, reservoir): time comes from event `producedAt`
 * deltas, never the wall clock — replaying the same events from the same
 * checkpoint reproduces byte-identical state. Returns the step's readouts so
 * the caller can receipt them and drive workspace admission.
 */
export function applyMetabolicTransition(
  cell: SituationCell,
  event: SourceEvent,
  reservoir: Reservoir,
  dtSeconds: number,
  plastic?: CellPlasticState,
): Readouts {
  const before = new Float32Array(cell.continuousState);
  const input = encodeEvent(event, dtSeconds, reservoir.inputDim);
  // Learned trust in this source scales its drive into the state — a source
  // that earned trust through corrections/consequences literally moves this
  // cell more than a neutral one.
  metabolicStep(cell.continuousState, reservoir, input, dtSeconds, cell.dispositions, trustFor(plastic, event));
  // Readouts run over FROZEN base weights plus the cell's plastic deltas —
  // this is where development changes what later contact means.
  const readouts = computeReadouts(before, cell.continuousState, reservoir, {
    salience: effectiveSalienceWeights(reservoir.readoutSalience, plastic),
    novelty: effectiveNoveltyWeights(reservoir.readoutNovelty, plastic),
  });

  // Energy: event-time decay, novelty-driven boost, event-time spike stamp.
  const energyDecay = Math.exp((-Math.LN2 * Math.max(0, dtSeconds)) / ENERGY_HALF_LIFE_SECONDS);
  const decayed = cell.energy.current * energyDecay;
  cell.energy.current = clamp(decayed + 0.05 + readouts.novelty * 0.25, 0, 1);
  if (cell.energy.current > cell.energy.peak) {
    cell.energy.peak = cell.energy.current;
    cell.energy.lastSpikeAt = event.producedAt;
  }

  // Workspace pressure: salience-driven with a leaky floor; inhibition is
  // applied by the workspace layer, not here.
  cell.workspacePressure = clamp(
    cell.workspacePressure * 0.8
      + readouts.salience * cell.dispositions.salienceWeight * 0.5
      + cell.uncertainty * 0.05,
    0,
    1,
  );

  // Uncertainty drifts toward observed novelty — surprising contact raises it,
  // quiet familiar contact settles it.
  cell.uncertainty = clamp(cell.uncertainty * 0.9 + readouts.novelty * 0.1, 0, 1);

  // Accumulate the reality reference (bounded) — workspace packets carry
  // actual refs into recruited lobes, never re-narrated history. When the
  // event's payload carries a text head (real language perceived at the
  // source), the ref carries it too — bounded — so a recruited mind reads
  // the life, not just its reference metadata.
  const head = event.payload['head'];
  cell.realityRefs.push({
    refId: event.eventId,
    sourceAuthority: event.sourceAuthority,
    sourceRef: event.sourceRef,
    observedAt: event.producedAt,
    confidence: event.category === 'correction' ? 1 : 0.8,
    flag: 'COLLECTED',
    ...(typeof head === 'string' && head.length > 0 ? { head: head.slice(0, 160) } : {}),
  });
  if (cell.realityRefs.length > MAX_CELL_REALITY_REFS) {
    cell.realityRefs.splice(0, cell.realityRefs.length - MAX_CELL_REALITY_REFS);
  }

  cell.generation += 1;
  cell.status = cell.energy.current < 0.05 ? 'quiet' : 'living';
  cell.lastTransitionAt = event.producedAt;

  return readouts;
}

/**
 * Copy a cell for a staged transition. Must copy every surface
 * applyMetabolicTransition mutates (continuousState, energy, and top-level
 * scalars via the spread) so a failed ledger append can discard the staged
 * copy leaving the original untouched. dispositions/modelAffinities are copied
 * too so a staged cell never aliases mutable structures with the committed one.
 */
export function cloneCell(cell: SituationCell): SituationCell {
  return {
    ...cell,
    continuousState: new Float32Array(cell.continuousState),
    energy: { ...cell.energy },
    dispositions: {
      ...cell.dispositions,
      modelAffinities: { ...cell.dispositions.modelAffinities },
    },
    lobeAffinities: { ...cell.lobeAffinities },
    // Array copies: transitions APPEND to these on the staged copy, so sharing
    // the array with the committed cell would leak mutations past a failed
    // receipt. Elements are shared — staged code must REPLACE an element to
    // change it, never mutate one in place.
    realityRefs: [...cell.realityRefs],
    estimates: [...cell.estimates],
    intentions: [...cell.intentions],
    predictions: [...cell.predictions],
    associations: [...cell.associations],
    developmentalLineage: [...cell.developmentalLineage],
  };
}

// ─── Serialization ────────────────────────────────────────────────────────────

export function serializeCell(cell: SituationCell): SerializedCell {
  const buf = Buffer.from(cell.continuousState.buffer);
  return {
    ...cell,
    continuousState: buf.toString('base64'),
    continuousStateDimension: cell.continuousState.length,
  };
}

export function deserializeCell(s: SerializedCell): SituationCell {
  const buf = Buffer.from(s.continuousState, 'base64');
  const dim = s.continuousStateDimension;
  const arr = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  if (arr.length !== dim) {
    throw new Error(`Continuous state dimension mismatch: got ${arr.length}, expected ${dim}`);
  }
  return {
    ...s,
    continuousState: arr,
  };
}

/** Stable canonical bytes for the continuous state, used in state hashing. */
export function continuousStateHash(cell: SituationCell): string {
  const buf = Buffer.from(cell.continuousState.buffer);
  return createHash('sha256').update(buf).digest('hex');
}
