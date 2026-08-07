/**
 * Scarce global workspace (Cut 2).
 *
 * Cells do not all speak to all models or to jtr. A narrow workspace admits at
 * most WORKSPACE_CAPACITY cells per cycle, and only when their pressure
 * genuinely crosses threshold. Inhibition is first-class: non-admitted active
 * cells are damped so pressure cannot ratchet forever. Silence is an explicit,
 * receipted outcome — the Seed deciding NOT to escalate is a real transition.
 *
 * Everything here is a pure function of cell state — no wall clock, no
 * randomness. The SeedProcess wraps outcomes in receipted commits.
 */

import type {
  SituationCell,
  SeedDispositions,
  CellAdmissionScore,
  WorkspaceOutcome,
  WorkspacePacket,
  TensionProjection,
  PredictionProjection,
} from './types.js';

/** Maximum cells admitted to the workspace per cycle. Scarcity is the point. */
export const WORKSPACE_CAPACITY = 2;

/** Pressure multiplier for admitted cells — admission spends the pressure. */
export const ADMISSION_RELEASE = 0.3;

/** Pressure multiplier for active but non-admitted cells — inhibition damps. */
export const INHIBITION_DAMP = 0.85;

/** Reality refs carried into a packet per admitted cell (most recent last). */
const PACKET_REFS_PER_CELL = 8;

/**
 * Deterministic admission score. Pressure is the CURRENCY of admission —
 * multiplicative, so a cell with spent pressure cannot hold the stage on
 * energy or uncertainty alone (admission must be re-earned through contact).
 * Uncertainty and energy modulate how loudly pressure counts; open intention
 * tension is an independent additive claim (unfinishedness may speak even
 * from a low-pressure cell); the cell's inhibition disposition pulls down.
 */
export function admissionScore(cell: SituationCell): number {
  const openTension = Math.min(
    1,
    cell.intentions.filter((i) => i.open).reduce((s, i) => s + i.magnitude, 0),
  );
  const modulation = 0.55 + 0.25 * cell.uncertainty + 0.2 * cell.energy.current;
  const score =
    cell.workspacePressure * modulation
    + 0.25 * openTension
    - 0.25 * cell.dispositions.inhibitionLevel;
  return Math.max(0, Math.min(1, score));
}

export function scoreCells(cells: Iterable<SituationCell>, dispositions: SeedDispositions): CellAdmissionScore[] {
  const scored: CellAdmissionScore[] = [];
  for (const cell of cells) {
    const score = admissionScore(cell);
    scored.push({
      cellId: cell.id,
      score,
      admitted:
        score >= dispositions.globalWakeThreshold
        && score >= cell.dispositions.wakeThreshold,
    });
  }
  // Deterministic order: score desc, then cellId asc for exact ties.
  scored.sort((a, b) => (b.score - a.score) || a.cellId.localeCompare(b.cellId));
  // Enforce scarcity: only the top WORKSPACE_CAPACITY stay admitted.
  let admittedCount = 0;
  for (const s of scored) {
    if (s.admitted) {
      admittedCount++;
      if (admittedCount > WORKSPACE_CAPACITY) s.admitted = false;
    }
  }
  return scored;
}

export function buildPacket(admitted: SituationCell[], dispositions: SeedDispositions): WorkspacePacket {
  const tensions: TensionProjection[] = [];
  const predictions: PredictionProjection[] = [];
  for (const cell of admitted) {
    for (const t of cell.intentions) {
      if (t.open) tensions.push({ tensionId: t.tensionId, cellId: cell.id, magnitude: t.magnitude, direction: t.direction });
    }
    for (const p of cell.predictions) {
      if (p.resolvedAt === undefined) {
        predictions.push({ predictionId: p.predictionId, cellId: cell.id, claim: p.claim, confidence: p.confidence });
      }
    }
  }
  const uncertainty = admitted.length === 0
    ? 0
    : Math.max(...admitted.map((c) => c.uncertainty));

  return {
    activeCellIds: admitted.map((c) => c.id),
    eventRefs: admitted.flatMap((c) => c.realityRefs.slice(-PACKET_REFS_PER_CELL)),
    tensions,
    predictions,
    uncertainty,
    requestedCapability: 'lobe.recruit.model',
    // 'propose': lobes may stage typed deltas — but only through validation
    // and the receipted commit path. Nothing above propose exists yet.
    authorityCeiling: 'propose',
    tokenBudget: 2000,
    outputContract: {
      allowedOutputKinds: ['observations', 'interpretations', 'predictions', 'stateDeltas'],
      maxTokenBudget: 2000,
    },
  };
}

/**
 * Evaluate the workspace over the given cells. Returns the outcome AND the set
 * of staged pressure mutations (admitted cells release, active non-admitted
 * cells are damped) — the caller commits them through a receipted transition.
 * The `mutations` map contains CLONES with updated pressure; untouched cells
 * are absent.
 */
export function evaluateWorkspace(
  cells: Map<string, SituationCell>,
  dispositions: SeedDispositions,
  cloneCell: (cell: SituationCell) => SituationCell,
): { outcome: WorkspaceOutcome; mutations: Map<string, SituationCell> } {
  const scores = scoreCells(cells.values(), dispositions);
  const admittedIds = scores.filter((s) => s.admitted).map((s) => s.cellId);
  const mutations = new Map<string, SituationCell>();

  if (admittedIds.length === 0) {
    // Explicit silence. Damp any cell that is carrying real pressure so an
    // un-admittable cell cannot ratchet forever.
    for (const s of scores) {
      const cell = cells.get(s.cellId);
      if (cell !== undefined && cell.workspacePressure > 0.01) {
        const staged = cloneCell(cell);
        staged.workspacePressure = staged.workspacePressure * INHIBITION_DAMP;
        mutations.set(s.cellId, staged);
      }
    }
    return {
      outcome: {
        kind: 'silence',
        reason: scores.length === 0 ? 'no-active-cells' : 'below-threshold',
        topScore: scores[0]?.score ?? 0,
        threshold: dispositions.globalWakeThreshold,
        scores,
      },
      mutations,
    };
  }

  const admittedCells: SituationCell[] = [];
  for (const s of scores) {
    const cell = cells.get(s.cellId);
    if (cell === undefined) continue;
    if (s.admitted) {
      const staged = cloneCell(cell);
      staged.workspacePressure = staged.workspacePressure * ADMISSION_RELEASE;
      mutations.set(s.cellId, staged);
      admittedCells.push(staged);
    } else if (cell.workspacePressure > 0.01) {
      const staged = cloneCell(cell);
      staged.workspacePressure = staged.workspacePressure * INHIBITION_DAMP;
      mutations.set(s.cellId, staged);
    }
  }

  return {
    outcome: {
      kind: 'workspace',
      packet: buildPacket(admittedCells, dispositions),
      scores,
    },
    mutations,
  };
}
