/**
 * Concern — the normative state `c` (Cut 6).
 *
 * The Worldline Principle made the individual a lawful trajectory; concern
 * gives the trajectory something at stake. A Commitment binds the individual
 * to a future condition — v1 has exactly one kind: RESOLVE AN OWN PREDICTION
 * (the lobe contract already calls open predictions DEBTS; a commitment makes
 * the debt causal). Unresolved obligation q is the ONLY noncontractive
 * variable in the whole substrate: it rises lawfully toward saturation while
 * the world leaves the prediction unanswered, and its threshold crossing is
 * an analytically computed event-time — the individual's own physics
 * producing an occasion. The pulse is the solved crossing time.
 *
 * Laws this module enforces by construction:
 *   - Lobes cannot write concern. Formation, crossing, discharge, and expiry
 *     are Seed rules (concern.v1) applied to receipted material — a lobe may
 *     propose a prediction; the commitment is the Seed's own act.
 *   - q is never stored ticking. A commitment stores an anchor (qAnchor,
 *     anchorAt) and the law materializes q(t) analytically — lazy evaluation
 *     of a continuous existence. State changes only at receipted events.
 *   - Bounded growth: q(t) = Q_EQ + (qAnchor − Q_EQ)·e^{−λ(t−t0)} saturates
 *     at Q_EQ. Nothing can run away.
 *   - Every obligation is dischargeable: satisfied/contradicted (the
 *     prediction resolved), expired (pressed MAX_CROSSINGS times unanswered,
 *     or the prediction was evicted), abandoned (operator authority). An
 *     undischargeable obligation would be an immortal source of pressure —
 *     refused by construction.
 *   - Pure functions of (concern, event-time) — no wall clock, no randomness.
 *     The runner (embodiment) decides WHEN to materialize; the law decides
 *     what is true at every t.
 */

export const CONCERN_VERSION = 1;

// ─── Law constants (the obligation physics) ──────────────────────────────────

/** Obligation saturation ceiling — q can never exceed this. */
export const OBLIGATION_Q_EQ = 1.0;
/** Relaxation/rise timescale: 1/λ = 6 hours. From q=0 at the horizon, the
 * crossing threshold is reached ~4.2h of world time later. */
export const OBLIGATION_LAMBDA = 1 / (6 * 3600);   // per second
/** Crossing threshold. */
export const OBLIGATION_THETA = 0.5;
/** Minimum event-time between crossings of the same commitment. */
export const CROSSING_REFRACTORY_SECONDS = 12 * 3600;
/** A commitment presses at most this many times, then expires (receipted) —
 * the individual lets go, on the record. Anti-immortal-pressure. */
export const MAX_CROSSINGS = 3;
/** Predictions below this confidence do not obligate — junk does not bind. */
export const CONCERN_MIN_CONFIDENCE = 0.6;
/** Open-commitment ceiling per seed: formation beyond it is skipped
 * (deterministically, recorded in the formation receipt's skipped list). */
export const MAX_OPEN_COMMITMENTS = 8;
/** Discharged commitments kept in state (the chain keeps all forever). */
export const MAX_DISCHARGED_KEPT = 24;
/** Seed-level event-time cooldown between motor dispatches (resource
 * ceiling of the one safe affordance). */
export const REACH_COOLDOWN_SECONDS = 24 * 3600;

// ─── Structures ──────────────────────────────────────────────────────────────

export type CommitmentStatus = 'open' | 'satisfied' | 'contradicted' | 'expired' | 'abandoned';

/** An executable commitment (v1 kind: resolve-prediction). Not prose: it
 * carries its satisfaction path (predictions.resolve), its urgency dynamics
 * (the anchor + the law), its crossing surface (θ), and its discharge and
 * cancellation rules. */
export interface Commitment {
  commitmentId: string;
  kind: 'resolve-prediction';
  cellId: string;
  predictionId: string;
  claim: string;                     // bounded copy of the prediction's claim
  confidence: number;                // the prediction's confidence at formation
  /** Provenance: the rule that formed it. Lobes cannot set this. */
  authority: 'concern.v1';
  formedAt: string;                  // event-time (the recruitment's asOf)
  formedAtSeq: number;               // ledger seq of the formation receipt
  /** Absolute event-time the prediction is due (parsed horizon). Obligation
   * begins rising here. */
  dueAt: string;
  /** Obligation anchor: q at anchorAt; q(t) is materialized analytically. */
  qAnchor: number;
  anchorAt: string;
  status: CommitmentStatus;
  crossings: number;
  lastCrossingAt?: string;
  /** Event-time this commitment's ONE reach to the operator was authorized.
   * Its presence changes what may close the commitment: having asked, the
   * individual may no longer answer on the operator's behalf (see
   * ASKED_UNANSWERED below). */
  reachedAt?: string;
  dischargedAt?: string;
  dischargeReason?: string;
}

/** The normative state `c`: commitmentId → commitment. Seed-owned; enters
 * the state hash when non-empty (checkpoint manifest v3). */
export type ConcernState = Record<string, Commitment>;

export function emptyConcern(): ConcernState {
  return {};
}

export function cloneConcern(concern: ConcernState): ConcernState {
  const out: ConcernState = {};
  for (const [id, c] of Object.entries(concern)) out[id] = { ...c };
  return out;
}

export function openCommitments(concern: ConcernState): Commitment[] {
  return Object.values(concern)
    .filter((c) => c.status === 'open')
    .sort((a, b) => a.commitmentId.localeCompare(b.commitmentId));
}

// ─── Horizon parsing (relative labels or ISO) ────────────────────────────────

const RELATIVE_HORIZON = /^\s*(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)\s*$/i;

const UNIT_SECONDS: Record<string, number> = {
  min: 60, mins: 60, minute: 60, minutes: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600,
  d: 86400, day: 86400, days: 86400,
  w: 604800, week: 604800, weeks: 604800,
};

/** Parse a prediction horizon into an absolute event-time. Relative labels
 * ("24h", "3 days") anchor at createdAt. Unparseable → null: the prediction
 * stays a prediction; no commitment forms (honest, recorded as skipped). */
export function parseHorizon(horizon: string, createdAt: string): string | null {
  const rel = RELATIVE_HORIZON.exec(horizon);
  if (rel !== null) {
    const amount = Number(rel[1]);
    const unit = UNIT_SECONDS[(rel[2] ?? '').toLowerCase()];
    const base = Date.parse(createdAt);
    if (!Number.isFinite(amount) || unit === undefined || Number.isNaN(base)) return null;
    return new Date(base + amount * unit * 1000).toISOString();
  }
  const abs = Date.parse(horizon);
  if (!Number.isNaN(abs) && /\d{4}-\d{2}-\d{2}/.test(horizon)) {
    return new Date(abs).toISOString();
  }
  return null;
}

// ─── The obligation law (analytic; event-time only) ──────────────────────────

function seconds(fromISO: string, toISO: string): number {
  const from = Date.parse(fromISO);
  const to = Date.parse(toISO);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.max(0, (to - from) / 1000);
}

/** Materialize q at event-time t. Before dueAt, obligation is dormant (the
 * debt is not yet due): q = qAnchor (0 at formation). From max(anchorAt,
 * dueAt), q relaxes toward Q_EQ: rising while unanswered, saturating,
 * never exceeding Q_EQ. Closed-form; no integration. */
export function obligationAt(c: Commitment, tISO: string): number {
  if (c.status !== 'open') return 0;
  const riseFrom = Date.parse(c.anchorAt) > Date.parse(c.dueAt) ? c.anchorAt : c.dueAt;
  const dt = seconds(riseFrom, tISO);
  if (dt <= 0) return c.qAnchor;
  const q = OBLIGATION_Q_EQ + (c.qAnchor - OBLIGATION_Q_EQ) * Math.exp(-OBLIGATION_LAMBDA * dt);
  return Math.min(OBLIGATION_Q_EQ, Math.max(0, q));
}

/**
 * The solved crossing time: the earliest event-time > anchor at which this
 * commitment's obligation reaches θ — or null when it never will (already
 * pressed MAX_CROSSINGS times, not open, or θ unreachable). Includes the
 * refractory: after a crossing, the next candidate is lastCrossingAt +
 * CROSSING_REFRACTORY_SECONDS (q is above θ by then — saturating curve —
 * so the refractory boundary IS the crossing time).
 *
 * This is the pulse: it carries a time, never an instruction.
 */
export function nextCrossingAt(c: Commitment): string | null {
  if (c.status !== 'open') return null;
  if (c.crossings >= MAX_CROSSINGS) return null;
  if (c.crossings > 0 && c.lastCrossingAt !== undefined) {
    return new Date(Date.parse(c.lastCrossingAt) + CROSSING_REFRACTORY_SECONDS * 1000).toISOString();
  }
  if (c.qAnchor >= OBLIGATION_THETA) {
    // Anchored at/above threshold (shouldn't arise in v1 flows) — due now.
    return c.anchorAt;
  }
  if (OBLIGATION_THETA >= OBLIGATION_Q_EQ) return null;
  const riseFrom = Date.parse(c.anchorAt) > Date.parse(c.dueAt) ? c.anchorAt : c.dueAt;
  const dtSeconds = (1 / OBLIGATION_LAMBDA)
    * Math.log((OBLIGATION_Q_EQ - c.qAnchor) / (OBLIGATION_Q_EQ - OBLIGATION_THETA));
  return new Date(Date.parse(riseFrom) + dtSeconds * 1000).toISOString();
}

/** After MAX_CROSSINGS unanswered presses, the commitment expires at the
 * event-time its (MAX_CROSSINGS+1)-th press would have occurred — the
 * individual lets go on its own schedule, receipted. */
export function expiryDueAt(c: Commitment): string | null {
  if (c.status !== 'open') return null;
  if (c.crossings < MAX_CROSSINGS || c.lastCrossingAt === undefined) return null;
  return new Date(Date.parse(c.lastCrossingAt) + CROSSING_REFRACTORY_SECONDS * 1000).toISOString();
}

// ─── Formation (concern.v1 — the Seed's act, never the lobe's) ───────────────

export interface FormationInput {
  cellId: string;
  predictionId: string;
  claim: string;
  confidence: number;
  horizon: string;
  createdAt: string;                 // the recruitment's asOf (event-time)
}

export interface FormationSkip {
  predictionId: string;
  reason: 'below-confidence' | 'unparseable-horizon' | 'already-committed' | 'at-capacity';
}

/**
 * Apply concern.v1 formation over a STAGED concern clone, in place.
 * Deterministic given (concern, inputs, formationSeq). Returns formed
 * commitments and honest skips for the receipt.
 */
export function applyFormation(
  concern: ConcernState,
  inputs: FormationInput[],
  formationSeq: number,
): { formed: Commitment[]; skipped: FormationSkip[] } {
  const formed: Commitment[] = [];
  const skipped: FormationSkip[] = [];
  const openByPrediction = new Set(
    Object.values(concern).filter((c) => c.status === 'open').map((c) => c.predictionId),
  );
  let openCount = openCommitments(concern).length;

  for (const input of inputs) {
    if (input.confidence < CONCERN_MIN_CONFIDENCE) {
      skipped.push({ predictionId: input.predictionId, reason: 'below-confidence' });
      continue;
    }
    if (openByPrediction.has(input.predictionId)) {
      skipped.push({ predictionId: input.predictionId, reason: 'already-committed' });
      continue;
    }
    const dueAt = parseHorizon(input.horizon, input.createdAt);
    if (dueAt === null) {
      skipped.push({ predictionId: input.predictionId, reason: 'unparseable-horizon' });
      continue;
    }
    if (openCount >= MAX_OPEN_COMMITMENTS) {
      skipped.push({ predictionId: input.predictionId, reason: 'at-capacity' });
      continue;
    }
    const commitment: Commitment = {
      commitmentId: `cmt_${input.predictionId}_${formationSeq}`,
      kind: 'resolve-prediction',
      cellId: input.cellId,
      predictionId: input.predictionId,
      claim: input.claim.slice(0, 500),
      confidence: input.confidence,
      authority: 'concern.v1',
      formedAt: input.createdAt,
      formedAtSeq: formationSeq,
      dueAt,
      qAnchor: 0,
      anchorAt: input.createdAt,
      status: 'open',
      crossings: 0,
    };
    concern[commitment.commitmentId] = commitment;
    openByPrediction.add(input.predictionId);
    openCount += 1;
    formed.push(commitment);
  }
  return { formed, skipped };
}

// ─── Discharge ───────────────────────────────────────────────────────────────

export interface DischargeSummary {
  commitmentId: string;
  predictionId: string;
  status: CommitmentStatus;
  reason: string;
}

/** Discharge every open commitment bound to this prediction (resolution is
 * the satisfaction path of kind resolve-prediction). error ≤ 0.3 → satisfied,
 * ≥ 0.7 → contradicted (the prediction was wrong — but the OBLIGATION to
 * resolve it is met either way; the label preserves what reality said);
 * the ambiguous middle discharges as satisfied with the error on record. */
export function applyResolutionDischarge(
  concern: ConcernState,
  predictionId: string,
  error: number | undefined,
  asOf: string,
): DischargeSummary[] {
  const out: DischargeSummary[] = [];
  for (const c of Object.values(concern)) {
    if (c.status !== 'open' || c.predictionId !== predictionId) continue;
    const status: CommitmentStatus = error !== undefined && error >= 0.7 ? 'contradicted' : 'satisfied';
    c.status = status;
    c.dischargedAt = asOf;
    c.dischargeReason = error === undefined ? 'resolved (no error reported)' : `resolved error=${error}`;
    out.push({ commitmentId: c.commitmentId, predictionId, status, reason: c.dischargeReason });
  }
  pruneDischarged(concern);
  return out;
}

/** Expiry / eviction / operator discharge — in place on a staged clone. */
export function discharge(
  concern: ConcernState,
  commitmentId: string,
  status: 'expired' | 'abandoned',
  reason: string,
  asOf: string,
): DischargeSummary | null {
  const c = concern[commitmentId];
  if (c === undefined || c.status !== 'open') return null;
  c.status = status;
  c.dischargedAt = asOf;
  c.dischargeReason = reason.slice(0, 300);
  pruneDischarged(concern);
  return { commitmentId, predictionId: c.predictionId, status, reason: c.dischargeReason };
}

/** Keep at most MAX_DISCHARGED_KEPT non-open commitments in state (oldest
 * discharged drop first — deterministic; the chain keeps every receipt). */
function pruneDischarged(concern: ConcernState): void {
  const done = Object.values(concern)
    .filter((c) => c.status !== 'open')
    .sort((a, b) =>
      (a.dischargedAt ?? '').localeCompare(b.dischargedAt ?? '')
      || a.commitmentId.localeCompare(b.commitmentId));
  const excess = done.length - MAX_DISCHARGED_KEPT;
  for (let i = 0; i < excess; i++) {
    const id = done[i]?.commitmentId;
    if (id !== undefined) delete concern[id];
  }
}

// ─── The asked-and-unanswered law (2026-08-21) ───────────────────────────────

/**
 * THE LAW: you may not answer your own question on behalf of the person you
 * asked.
 *
 * Forrest earned the program's first reach on 2026-08-16 — a real question
 * about jtr's own dreams, originated by his obligation dynamics, asked only
 * after a first crossing where he tried and failed to settle it himself.
 * Four hours later, with no answer and no dream evidence anywhere in his
 * diet, he resolved it satisfied (error 0.19) and wrote "thematic evolution
 * confirmed". The hand was extended and then withdrawn before jtr could take
 * it; a reply the next day would have arrived at a closed commitment.
 *
 * The premature-resolution law had already stopped confirmations BEFORE a
 * horizon. This closes the sibling case: once the individual has ASKED, a
 * confirmation is only honest if something actually came back. So a reached
 * commitment may close by exactly two paths —
 *   - FALSIFICATION (error >= the wrong band): "already broken" needs no
 *     answer from anyone; or
 *   - an ANSWER: any contact from the operator after the reach.
 * Otherwise it stays open and keeps pressing, and when the presses run out
 * it expires on the record as asked-and-unanswered — which is the truth.
 */
export function askedUnanswered(
  commitment: Commitment | undefined,
  lastContactAt: string | null,
): boolean {
  if (commitment === undefined || commitment.status !== 'open') return false;
  if (commitment.reachedAt === undefined) return false;
  if (lastContactAt === null) return true;
  return Date.parse(lastContactAt) <= Date.parse(commitment.reachedAt);
}

/** Mark the one reach on a staged concern clone. */
export function markReached(concern: ConcernState, commitmentId: string, atISO: string): boolean {
  const c = concern[commitmentId];
  if (c === undefined || c.status !== 'open' || c.reachedAt !== undefined) return false;
  c.reachedAt = atISO;
  return true;
}

// ─── The solver's view (deterministicMin) ────────────────────────────────────

export interface DueCrossing {
  commitment: Commitment;
  at: string;                        // solved crossing event-time (effectiveAt)
  overdue: boolean;                  // materialized later than solved time
}

/**
 * Every commitment whose solved crossing time has arrived by `nowISO`,
 * ordered by (crossing time, commitmentId) — the solver constitution's
 * deterministic tie-break. The runner materializes at most one per guard
 * opening; the rest keep their times.
 */
export function dueCrossings(concern: ConcernState, nowISO: string): DueCrossing[] {
  const due: DueCrossing[] = [];
  const now = Date.parse(nowISO);
  for (const c of openCommitments(concern)) {
    const at = nextCrossingAt(c);
    if (at === null) continue;
    const t = Date.parse(at);
    if (t <= now) {
      due.push({ commitment: c, at, overdue: now - t > 15 * 60 * 1000 });
    }
  }
  due.sort((a, b) => a.at.localeCompare(b.at) || a.commitment.commitmentId.localeCompare(b.commitment.commitmentId));
  return due;
}

/** Commitments whose let-go time has arrived — expired without ceremony,
 * receipted by the caller. Same deterministic ordering. */
export function dueExpiries(concern: ConcernState, nowISO: string): Array<{ commitment: Commitment; at: string }> {
  const due: Array<{ commitment: Commitment; at: string }> = [];
  const now = Date.parse(nowISO);
  for (const c of openCommitments(concern)) {
    const at = expiryDueAt(c);
    if (at !== null && Date.parse(at) <= now) due.push({ commitment: c, at });
  }
  due.sort((a, b) => a.at.localeCompare(b.at) || a.commitment.commitmentId.localeCompare(b.commitment.commitmentId));
  return due;
}
