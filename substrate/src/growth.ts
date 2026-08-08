/**
 * Growth pressure (Cut 5) — anatomy under strain, detected from receipts.
 *
 * The anatomy a Seed is born with is a hypothesis about its world. Reality
 * votes through routing: which cells earn admissions, which starve, what
 * the periphery keeps catching. This module reads a window of the Seed's
 * OWN chain and computes typed growth proposals — split, merge, specialize,
 * dissolve, crystallize — each carrying its numeric evidence, a shadow
 * trial run through the REAL router against the window's actual events,
 * and a full rollback representation (before-anatomy included verbatim).
 *
 * Nothing here mutates anything. Proposals are receipted with zero state
 * change and applied only by operator decision — an anatomy change is an
 * identity change, and identity changes are never automatic. Nothing is
 * accepted merely because it is novel; nothing is proposed merely because
 * the machinery exists — every detector has a floor sized so that only
 * repeated real pressure clears it.
 *
 * Deterministic: pure functions of (window records, cells, anatomy).
 */

import type { LedgerRecord, AnatomyCellSpec, SerializedCell, SourceEvent, EventCategory } from './types.js';
import { routeEvent, routingFromAnatomy } from './cells.js';
import { emptyCellPlasticState } from './plasticity.js';
import type { DevelopmentalState } from './plasticity.js';

// ─── Pressure floors (all named; sized for repeated pressure, not noise) ─────

/** Minimum transitions in the window before ANY detector may speak. */
export const GROWTH_MIN_WINDOW_TRANSITIONS = 40;
/** Split: one cell holds at least this share of the window's admissions… */
export const SPLIT_ADMISSION_SHARE = 0.8;
/** …with at least this many admissions… */
export const SPLIT_MIN_ADMISSIONS = 4;
/** …and at least two source clusters each carrying this share of its traffic. */
export const SPLIT_CLUSTER_MIN_SHARE = 0.25;
/** Crystallize: a single source prefix holds this share of periphery traffic… */
export const CRYSTALLIZE_PREFIX_SHARE = 0.5;
/** …across at least this many transitions. */
export const CRYSTALLIZE_MIN_TRANSITIONS = 8;
/** Starvation: a non-periphery cell with zero contact while the window saw
 * at least GROWTH_MIN_WINDOW_TRANSITIONS. Two starving cells → merge
 * proposal; one → dissolve proposal. */
export const SPECIALIZE_PREFIX_SHARE = 0.7;
/** Specialize also requires this much traffic so a quiet cell can't qualify. */
export const SPECIALIZE_MIN_TRANSITIONS = 12;
/** Affinity seeds a proposal grants its new/narrowed cells in shadow trials —
 * above routeEvent's 0.15 floor, far below the 1.0 ceiling. */
export const PROPOSAL_SEED_AFFINITY = 0.3;
/** Proposals per evaluation, hard cap. */
export const MAX_PROPOSALS_PER_EVAL = 2;
/** A proposal for the same (op, target) within this many seqs is a duplicate. */
export const PROPOSAL_COOLDOWN_SEQS = 200;

// ─── growth.v2 — governed self-application (SELF-FORMATION-PROTOCOL v1.1) ────
// A BIRTH property (genesis selfFormation: true). Crystallize only — strictly
// additive; split/merge/dissolve/specialize remain operator-only. Passing
// whims do not get organs: only weather that keeps returning does.

/** The same periphery cluster must have been proposed at least this often… */
export const SELF_APPLY_MIN_PROPOSALS = 3;
/** …spanning at least this much EVENT-time between first and last proposal… */
export const SELF_APPLY_MIN_SPAN_MS = 48 * 3600 * 1000;
/** …with the qualifying proposal's shadow capture at least this high. */
export const SELF_APPLY_MIN_CAPTURE = 0.9;
/** Evidence gate tolerance: each proposal's cluster count must stay at or
 * above this fraction of the prior maximum. Pure non-decrease is fragile to
 * window saturation (a full window plateaus and can dip by a record or two
 * while the pressure is entirely real); collapse below 80% of peak is the
 * signal that the weather actually left. */
export const SELF_APPLY_EVIDENCE_FLOOR = 0.8;
/** Covenant: hard ceiling on total cells (born with 2 → at most 6 organs). */
export const SELF_APPLY_MAX_CELLS = 8;

/** The cluster a crystallize proposal is about (its top periphery prefix). */
export function crystallizeClusterPrefix(proposal: GrowthProposal): string | null {
  if (proposal.op !== 'crystallize') return null;
  const entries = Object.entries(proposal.evidence.prefixCounts);
  return entries.length > 0 ? (entries[0] as [string, number])[0] : null;
}

export interface PriorCrystallizeProposal {
  seq: number;
  asOf: string;
  clusterPrefix: string;
  clusterCount: number;
}

export interface SelfApplicationGateResult {
  qualifies: boolean;
  reason: string;
  priorCount: number;
  spanMs: number;
}

/** The persistence gates. Pure; the caller supplies the chain's history of
 * crystallize proposals for the same cluster (including the current one). */
export function evaluateSelfApplicationGates(
  history: readonly PriorCrystallizeProposal[],
  current: GrowthProposal,
  currentCellCount: number,
): SelfApplicationGateResult {
  const no = (reason: string, spanMs = 0): SelfApplicationGateResult =>
    ({ qualifies: false, reason, priorCount: history.length, spanMs });

  if (current.op !== 'crystallize') return no('covenant: only crystallize may self-apply');
  if (currentCellCount >= SELF_APPLY_MAX_CELLS) return no('covenant: cell ceiling reached');
  if (!current.proposedAnatomy.some((c) => c.role === 'periphery')) return no('covenant: periphery must survive');
  for (const before of current.beforeAnatomy) {
    if (!current.proposedAnatomy.some((c) => c.id === before.id)) return no('covenant: self-application must be additive');
  }
  if (current.shadowTrial.clusterCapture < SELF_APPLY_MIN_CAPTURE) {
    return no(`gate: capture ${current.shadowTrial.clusterCapture.toFixed(2)} < ${SELF_APPLY_MIN_CAPTURE}`);
  }
  if (history.length < SELF_APPLY_MIN_PROPOSALS) {
    return no(`gate: ${history.length}/${SELF_APPLY_MIN_PROPOSALS} proposals`);
  }
  const times = history.map((h) => Date.parse(h.asOf)).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  const spanMs = (times[times.length - 1] ?? 0) - (times[0] ?? 0);
  if (spanMs < SELF_APPLY_MIN_SPAN_MS) {
    return no(`gate: span ${(spanMs / 3600000).toFixed(1)}h < ${SELF_APPLY_MIN_SPAN_MS / 3600000}h of event-time`, spanMs);
  }
  const counts = history.map((h) => h.clusterCount);
  let peak = counts[0] ?? 0;
  for (let i = 1; i < counts.length; i++) {
    const count = counts[i] ?? 0;
    if (count < peak * SELF_APPLY_EVIDENCE_FLOOR) return no('gate: cluster evidence collapsed below floor', spanMs);
    peak = Math.max(peak, count);
  }
  return { qualifies: true, reason: 'all gates passed', priorCount: history.length, spanMs };
}

export type GrowthOp = 'split' | 'merge' | 'specialize' | 'dissolve' | 'crystallize';

export interface GrowthEvidence {
  windowTransitions: number;
  windowAdmissions: number;
  cellTransitions: number;
  cellAdmissions: number;
  admissionShare: number;
  /** Source prefix → transition count for the cell(s) under pressure. */
  prefixCounts: Record<string, number>;
}

export interface ShadowTrialResult {
  /** Share of window events the periphery caught under current anatomy. */
  peripheryShareBefore: number;
  /** Same share under the proposed anatomy (with seed affinities). */
  peripheryShareAfter: number;
  /** For split/crystallize/specialize: fraction of the targeted cluster's
   * events that land on the intended cell under the proposal. */
  clusterCapture: number;
  eventsTried: number;
}

export interface GrowthProposal {
  op: GrowthOp;
  /** Cells the operation acts on (existing ids). */
  targetCellIds: string[];
  /** Anatomy as it is — the rollback representation, verbatim. */
  beforeAnatomy: AnatomyCellSpec[];
  /** Anatomy as proposed. */
  proposedAnatomy: AnatomyCellSpec[];
  /** Routing affinity seeds the proposal would grant (cellId → prefix → value).
   * These are part of the proposal's typed content: what would need to be
   * granted for the new anatomy to route as intended. */
  seedAffinities: Record<string, Record<string, number>>;
  evidence: GrowthEvidence;
  shadowTrial: ShadowTrialResult;
}

// ─── Window statistics ───────────────────────────────────────────────────────

interface WindowStats {
  transitions: number;
  admissions: number;
  perCellTransitions: Map<string, number>;
  perCellAdmissions: Map<string, number>;
  perCellPrefixCounts: Map<string, Map<string, number>>;
  /** Reconstructed minimal events for shadow routing (explicit targetCellId
   * hints are not recoverable from transition receipts — receipts record the
   * ROUTED target; sense-stream events carry no hints, so this is faithful
   * for them and approximate for hinted events). */
  events: SourceEvent[];
}

function collectWindowStats(records: readonly LedgerRecord[]): WindowStats {
  const stats: WindowStats = {
    transitions: 0,
    admissions: 0,
    perCellTransitions: new Map(),
    perCellAdmissions: new Map(),
    perCellPrefixCounts: new Map(),
    events: [],
  };
  for (const record of records) {
    if (record.category === 'transition') {
      const cellId = record.payload?.['targetCellId'];
      const originalCategory = record.payload?.['originalCategory'];
      const producedAt = record.payload?.['producedAt'];
      if (typeof cellId !== 'string') continue;
      stats.transitions++;
      stats.perCellTransitions.set(cellId, (stats.perCellTransitions.get(cellId) ?? 0) + 1);
      const prefix = prefixOf(record.sourceRef);
      const cellPrefixes = stats.perCellPrefixCounts.get(cellId) ?? new Map<string, number>();
      cellPrefixes.set(prefix, (cellPrefixes.get(prefix) ?? 0) + 1);
      stats.perCellPrefixCounts.set(cellId, cellPrefixes);
      stats.events.push({
        eventId: `shadow_${record.seq}`,
        category: (typeof originalCategory === 'string' ? originalCategory : 'observation') as EventCategory,
        sourceAuthority: 'seed.internal',
        sourceRef: record.sourceRef,
        payload: {},
        producedAt: typeof producedAt === 'string' ? producedAt : '1970-01-01T00:00:00.000Z',
      });
    } else if (record.category === 'workspace') {
      const admitted = record.payload?.['admittedCellIds'];
      if (Array.isArray(admitted)) {
        stats.admissions++;
        for (const cellId of admitted) {
          if (typeof cellId === 'string') {
            stats.perCellAdmissions.set(cellId, (stats.perCellAdmissions.get(cellId) ?? 0) + 1);
          }
        }
      }
    }
  }
  return stats;
}

function prefixOf(sourceRef: string): string {
  const idx = sourceRef.indexOf(':');
  return idx > 0 ? sourceRef.slice(0, idx) : sourceRef;
}

function sortedPrefixEntries(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function prefixRecord(counts: Map<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  if (counts === undefined) return out;
  for (const [k, v] of sortedPrefixEntries(counts)) out[k] = v;
  return out;
}

/** Derive a stable child cell id from a parent id and a source prefix. */
function childCellId(parentId: string, prefix: string): string {
  const leaf = prefix.replace(/[^a-zA-Z0-9.]+/g, '-').split('.').pop() ?? prefix;
  return `${parentId}.${leaf}`;
}

// ─── Shadow trial: the proposed anatomy vs the window's real events ──────────

function developmentWithSeeds(cellIds: readonly string[], seeds: Record<string, Record<string, number>>): DevelopmentalState {
  const dev: DevelopmentalState = {};
  for (const id of cellIds) {
    const state = emptyCellPlasticState();
    const cellSeeds = seeds[id];
    if (cellSeeds !== undefined) {
      for (const [prefix, value] of Object.entries(cellSeeds)) state.routingAffinity[prefix] = value;
    }
    dev[id] = state;
  }
  return dev;
}

export function runShadowTrial(
  events: readonly SourceEvent[],
  beforeAnatomy: readonly AnatomyCellSpec[],
  proposedAnatomy: readonly AnatomyCellSpec[],
  seedAffinities: Record<string, Record<string, number>>,
  clusterPrefixes: readonly string[],
  intendedCellByPrefix: Record<string, string>,
): ShadowTrialResult {
  const beforeRouting = routingFromAnatomy(beforeAnatomy);
  const proposedRouting = routingFromAnatomy(proposedAnatomy);
  const beforeIds = beforeAnatomy.map((c) => c.id);
  const proposedIds = proposedAnatomy.map((c) => c.id);
  const shadowDev = developmentWithSeeds(proposedIds, seedAffinities);

  let peripheryBefore = 0;
  let peripheryAfter = 0;
  let clusterEvents = 0;
  let clusterCaptured = 0;
  for (const event of events) {
    const before = routeEvent(event, beforeIds, undefined, beforeRouting);
    const after = routeEvent(event, proposedIds, shadowDev, proposedRouting);
    if (before === beforeRouting.peripheryId) peripheryBefore++;
    if (after === proposedRouting.peripheryId) peripheryAfter++;
    const prefix = prefixOf(event.sourceRef);
    const intended = intendedCellByPrefix[prefix];
    if (clusterPrefixes.includes(prefix)) {
      clusterEvents++;
      if (intended !== undefined && after === intended) clusterCaptured++;
    }
  }
  const total = events.length;
  return {
    peripheryShareBefore: total > 0 ? peripheryBefore / total : 0,
    peripheryShareAfter: total > 0 ? peripheryAfter / total : 0,
    clusterCapture: clusterEvents > 0 ? clusterCaptured / clusterEvents : 0,
    eventsTried: total,
  };
}

// ─── Detectors ───────────────────────────────────────────────────────────────

function detectSplit(stats: WindowStats, anatomy: readonly AnatomyCellSpec[]): GrowthProposal | null {
  if (stats.admissions < SPLIT_MIN_ADMISSIONS) return null;
  for (const spec of anatomy) {
    if (spec.role === 'periphery') continue;
    const admissions = stats.perCellAdmissions.get(spec.id) ?? 0;
    const share = stats.admissions > 0 ? admissions / stats.admissions : 0;
    if (share < SPLIT_ADMISSION_SHARE || admissions < SPLIT_MIN_ADMISSIONS) continue;
    const cellTransitions = stats.perCellTransitions.get(spec.id) ?? 0;
    if (cellTransitions === 0) continue;
    const clusters = sortedPrefixEntries(stats.perCellPrefixCounts.get(spec.id) ?? new Map())
      .filter(([, count]) => count / cellTransitions >= SPLIT_CLUSTER_MIN_SHARE);
    if (clusters.length < 2) continue;

    const [clusterA, clusterB] = [clusters[0] as [string, number], clusters[1] as [string, number]];
    const childA = childCellId(spec.id, clusterA[0]);
    const childB = childCellId(spec.id, clusterB[0]);
    const proposedAnatomy: AnatomyCellSpec[] = anatomy.flatMap((c) =>
      c.id === spec.id
        ? [{ id: childA, role: c.role }, { id: childB, role: c.role }]
        : [{ ...c }],
    );
    const seedAffinities = {
      [childA]: { [clusterA[0]]: PROPOSAL_SEED_AFFINITY },
      [childB]: { [clusterB[0]]: PROPOSAL_SEED_AFFINITY },
    };
    const shadowTrial = runShadowTrial(
      stats.events, anatomy, proposedAnatomy, seedAffinities,
      [clusterA[0], clusterB[0]],
      { [clusterA[0]]: childA, [clusterB[0]]: childB },
    );
    return {
      op: 'split',
      targetCellIds: [spec.id],
      beforeAnatomy: anatomy.map((c) => ({ ...c })),
      proposedAnatomy,
      seedAffinities,
      evidence: {
        windowTransitions: stats.transitions,
        windowAdmissions: stats.admissions,
        cellTransitions,
        cellAdmissions: admissions,
        admissionShare: share,
        prefixCounts: prefixRecord(stats.perCellPrefixCounts.get(spec.id)),
      },
      shadowTrial,
    };
  }
  return null;
}

function detectCrystallize(stats: WindowStats, anatomy: readonly AnatomyCellSpec[]): GrowthProposal | null {
  const periphery = anatomy.find((c) => c.role === 'periphery');
  if (periphery === undefined) return null;
  const peripheryTransitions = stats.perCellTransitions.get(periphery.id) ?? 0;
  if (peripheryTransitions < CRYSTALLIZE_MIN_TRANSITIONS) return null;
  const top = sortedPrefixEntries(stats.perCellPrefixCounts.get(periphery.id) ?? new Map())[0];
  if (top === undefined || top[1] / peripheryTransitions < CRYSTALLIZE_PREFIX_SHARE || top[1] < CRYSTALLIZE_MIN_TRANSITIONS) return null;

  const newId = childCellId('world', top[0]);
  const proposedAnatomy: AnatomyCellSpec[] = [
    ...anatomy.filter((c) => c.role !== 'periphery').map((c) => ({ ...c })),
    { id: newId, role: 'observation' as const },
    { ...periphery },
  ];
  const seedAffinities = { [newId]: { [top[0]]: PROPOSAL_SEED_AFFINITY } };
  const shadowTrial = runShadowTrial(
    stats.events, anatomy, proposedAnatomy, seedAffinities,
    [top[0]], { [top[0]]: newId },
  );
  return {
    op: 'crystallize',
    targetCellIds: [periphery.id],
    beforeAnatomy: anatomy.map((c) => ({ ...c })),
    proposedAnatomy,
    seedAffinities,
    evidence: {
      windowTransitions: stats.transitions,
      windowAdmissions: stats.admissions,
      cellTransitions: peripheryTransitions,
      cellAdmissions: stats.perCellAdmissions.get(periphery.id) ?? 0,
      admissionShare: 0,
      prefixCounts: prefixRecord(stats.perCellPrefixCounts.get(periphery.id)),
    },
    shadowTrial,
  };
}

function detectStarvation(stats: WindowStats, anatomy: readonly AnatomyCellSpec[]): GrowthProposal | null {
  const starving = anatomy.filter((c) =>
    c.role !== 'periphery'
    && (stats.perCellTransitions.get(c.id) ?? 0) === 0
    && (stats.perCellAdmissions.get(c.id) ?? 0) === 0,
  );
  if (starving.length === 0) return null;
  const evidence = (cells: AnatomyCellSpec[]): GrowthEvidence => ({
    windowTransitions: stats.transitions,
    windowAdmissions: stats.admissions,
    cellTransitions: 0,
    cellAdmissions: 0,
    admissionShare: 0,
    prefixCounts: Object.fromEntries(cells.map((c) => [c.id, 0])),
  });
  if (starving.length >= 2) {
    const [a, b] = [starving[0] as AnatomyCellSpec, starving[1] as AnatomyCellSpec];
    const mergedId = `${a.id}+${b.id}`;
    const proposedAnatomy: AnatomyCellSpec[] = anatomy.flatMap((c) => {
      if (c.id === a.id) return [{ id: mergedId, role: a.role }];
      if (c.id === b.id) return [];
      return [{ ...c }];
    });
    return {
      op: 'merge',
      targetCellIds: [a.id, b.id],
      beforeAnatomy: anatomy.map((c) => ({ ...c })),
      proposedAnatomy,
      seedAffinities: {},
      evidence: evidence([a, b]),
      shadowTrial: runShadowTrial(stats.events, anatomy, proposedAnatomy, {}, [], {}),
    };
  }
  const target = starving[0] as AnatomyCellSpec;
  const proposedAnatomy = anatomy.filter((c) => c.id !== target.id).map((c) => ({ ...c }));
  return {
    op: 'dissolve',
    targetCellIds: [target.id],
    beforeAnatomy: anatomy.map((c) => ({ ...c })),
    proposedAnatomy,
    seedAffinities: {},
    evidence: evidence([target]),
    shadowTrial: runShadowTrial(stats.events, anatomy, proposedAnatomy, {}, [], {}),
  };
}

function detectSpecialize(stats: WindowStats, anatomy: readonly AnatomyCellSpec[]): GrowthProposal | null {
  for (const spec of anatomy) {
    if (spec.role === 'periphery') continue;
    const cellTransitions = stats.perCellTransitions.get(spec.id) ?? 0;
    if (cellTransitions < SPECIALIZE_MIN_TRANSITIONS) continue;
    const entries = sortedPrefixEntries(stats.perCellPrefixCounts.get(spec.id) ?? new Map());
    const top = entries[0];
    if (top === undefined || entries.length < 2) continue;
    if (top[1] / cellTransitions < SPECIALIZE_PREFIX_SHARE) continue;
    const narrowedId = childCellId(spec.id, top[0]);
    const proposedAnatomy: AnatomyCellSpec[] = anatomy.map((c) =>
      c.id === spec.id ? { id: narrowedId, role: c.role } : { ...c },
    );
    const seedAffinities = { [narrowedId]: { [top[0]]: PROPOSAL_SEED_AFFINITY } };
    return {
      op: 'specialize',
      targetCellIds: [spec.id],
      beforeAnatomy: anatomy.map((c) => ({ ...c })),
      proposedAnatomy,
      seedAffinities,
      evidence: {
        windowTransitions: stats.transitions,
        windowAdmissions: stats.admissions,
        cellTransitions,
        cellAdmissions: stats.perCellAdmissions.get(spec.id) ?? 0,
        admissionShare: stats.admissions > 0 ? (stats.perCellAdmissions.get(spec.id) ?? 0) / stats.admissions : 0,
        prefixCounts: prefixRecord(stats.perCellPrefixCounts.get(spec.id)),
      },
      shadowTrial: runShadowTrial(stats.events, anatomy, proposedAnatomy, seedAffinities, [top[0]], { [top[0]]: narrowedId }),
    };
  }
  return null;
}

// ─── Rent accounting ─────────────────────────────────────────────────────────

export interface CellRent {
  cellId: string;
  transitions: number;
  admissions: number;
  developmentReceipts: number;
  intentionsOpen: number;
  predictionsOpen: number;
  /** What the cell pays back: admissions earned + development attributed +
   * open commitments. A cell with rentPaid 0 across windows is dissolution
   * pressure — it costs routing and state and returns nothing. */
  rentPaid: number;
}

export function computeRent(records: readonly LedgerRecord[], cells: readonly SerializedCell[]): CellRent[] {
  const stats = collectWindowStats(records);
  const devCounts = new Map<string, number>();
  for (const record of records) {
    if (record.category !== 'development') continue;
    const cellId = record.payload?.['cellId'];
    if (typeof cellId === 'string') devCounts.set(cellId, (devCounts.get(cellId) ?? 0) + 1);
  }
  return cells.map((cell) => {
    const transitions = stats.perCellTransitions.get(cell.id) ?? 0;
    const admissions = stats.perCellAdmissions.get(cell.id) ?? 0;
    const developmentReceipts = devCounts.get(cell.id) ?? 0;
    const intentionsOpen = cell.intentions.filter((i) => i.open).length;
    const predictionsOpen = cell.predictions.filter((p) => p.resolvedAt === undefined).length;
    return {
      cellId: cell.id,
      transitions,
      admissions,
      developmentReceipts,
      intentionsOpen,
      predictionsOpen,
      rentPaid: admissions + developmentReceipts + intentionsOpen + predictionsOpen,
    };
  });
}

// ─── Evaluation entry point ──────────────────────────────────────────────────

/** Prior proposal keys (op + primary target) with their seqs, for cooldown. */
export function proposalKey(op: GrowthOp, targetCellIds: readonly string[]): string {
  return `${op}:${[...targetCellIds].sort().join('+')}`;
}

export function evaluateGrowthPressure(
  records: readonly LedgerRecord[],
  anatomy: readonly AnatomyCellSpec[],
  priorProposals: ReadonlyMap<string, number>,
  currentSeq: number,
): GrowthProposal[] {
  const stats = collectWindowStats(records);
  if (stats.transitions < GROWTH_MIN_WINDOW_TRANSITIONS) return [];

  const candidates = [
    detectSplit(stats, anatomy),
    detectCrystallize(stats, anatomy),
    detectSpecialize(stats, anatomy),
    detectStarvation(stats, anatomy),
  ].filter((p): p is GrowthProposal => p !== null);

  const fresh = candidates.filter((p) => {
    const lastSeq = priorProposals.get(proposalKey(p.op, p.targetCellIds));
    return lastSeq === undefined || currentSeq - lastSeq > PROPOSAL_COOLDOWN_SEQS;
  });
  return fresh.slice(0, MAX_PROPOSALS_PER_EVAL);
}
