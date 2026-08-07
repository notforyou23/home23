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
import { CONTINUOUS_STATE_DIM, INITIAL_CELL_IDS } from './types.js';

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

export function makeInitialCells(now: string): Map<string, SituationCell> {
  const cells = new Map<string, SituationCell>();
  for (const id of INITIAL_CELL_IDS) {
    cells.set(id, makeInitialCell(id, now));
  }
  // After formation, set first four to 'living'; periphery stays 'forming'
  for (const [id, cell] of cells) {
    if (!id.startsWith('periphery.')) {
      cell.status = 'living';
    }
  }
  return cells;
}

// ─── Routing heuristic ────────────────────────────────────────────────────────

/** Route an event to a cell id when targetCellId is not specified. */
export function routeEvent(event: SourceEvent, cellIds: string[]): string {
  if (event.targetCellId && cellIds.includes(event.targetCellId)) {
    return event.targetCellId;
  }
  // Simple category-based routing for Cut 1
  switch (event.category) {
    case 'correction':
      return 'contact.jtr-jerry';
    case 'observation':
      return 'world.home23';
    case 'consequence':
      return 'project.shakedown';
    case 'interpretation':
      return 'frontier.substrate-os';
    default:
      return 'periphery.open-field';
  }
}

// ─── Continuous state update ──────────────────────────────────────────────────

/**
 * Compute an 8-element fingerprint from the event. Deterministic.
 * Maps sha256 bytes → float32 values in [-1, 1].
 */
function eventFingerprint(event: SourceEvent): Float32Array {
  const digest = createHash('sha256')
    .update(`${event.sourceRef}:${event.producedAt}:${event.category}`, 'utf-8')
    .digest();
  const fp = new Float32Array(8);
  for (let i = 0; i < 8; i++) {
    const byteIndex = i * 4;
    // Read 4 bytes big-endian as int32, normalize to [-1, 1]
    const b0 = digest[byteIndex] ?? 0;
    const b1 = digest[byteIndex + 1] ?? 0;
    const b2 = digest[byteIndex + 2] ?? 0;
    const b3 = digest[byteIndex + 3] ?? 0;
    const int32 = ((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >> 0;
    fp[i] = int32 / 2_147_483_648; // INT32_MAX
  }
  return fp;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Apply one deterministic transition to a cell's continuous state.
 * Mutates the cell in-place. Returns the cell for chaining.
 */
export function applyTransition(cell: SituationCell, event: SourceEvent, now: string): SituationCell {
  const decay = cell.dispositions.decayRate;
  const state = cell.continuousState;

  // Decay all floats
  for (let i = 0; i < state.length; i++) {
    const v = state[i] ?? 0;
    state[i] = v * (1 - decay);
  }

  // Add event fingerprint to slots [0..7]
  const fp = eventFingerprint(event);
  for (let i = 0; i < 8; i++) {
    const current = state[i] ?? 0;
    const delta = fp[i] ?? 0;
    state[i] = clamp(current + delta * 0.5, -1, 1);
  }

  // Energy spike
  const prevEnergy = cell.energy.current;
  const energyBoost = 0.1 + Math.abs(fp[0] ?? 0) * 0.2;
  cell.energy.current = clamp(prevEnergy + energyBoost, 0, 1);
  if (cell.energy.current > cell.energy.peak) {
    cell.energy.peak = cell.energy.current;
    cell.energy.lastSpikeAt = now;
  }

  // Workspace pressure increases with uncertainty-weighted activity
  cell.workspacePressure = clamp(cell.workspacePressure + 0.05 * cell.uncertainty, 0, 1);

  cell.generation += 1;
  cell.status = 'living';
  cell.lastTransitionAt = now;

  return cell;
}

/**
 * Copy a cell for a staged transition. Must copy every surface applyTransition
 * mutates (continuousState, energy, and top-level scalars via the spread) so a
 * failed ledger append can discard the staged copy leaving the original
 * untouched. dispositions/modelAffinities are copied too so a staged cell never
 * aliases mutable structures with the committed one.
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
