/**
 * SeedProcess — the resident Substrate OS process.
 *
 * API:
 *   SeedProcess.initialize(stateDir, budget?) — fresh seed with five cells
 *   SeedProcess.restore(stateDir, checkpointId?) — resume from checkpoint
 *   seed.ingest(event)      — write source event to ledger (membrane-gated)
 *   seed.transition(event)  — ingest + deterministic cell state update
 *   seed.checkpoint()       — write checkpoint, return checkpointId
 *   seed.stop()             — checkpoint + stop record to ledger
 *   seed.getState()         — current state snapshot (read-only)
 *   seed.getContinuousState(cellId) — Float32Array for a cell
 *
 * The model call is inside transition(); it does not instantiate the Seed.
 * Cut 1 uses only deterministic transitions — no model calls.
 */

import { createHash, randomUUID } from 'node:crypto';
import { cpSync } from 'node:fs';
import type {
  SituationCell,
  SeedState,
  SeedDispositions,
  SourceEvent,
  LedgerRecord,
  TransitionResult,
  ResourceBudget,
  EventCategory,
  SourceAuthority,
  WorkspaceOutcome,
} from './types.js';
import { CapabilityDeniedError } from './types.js';
import { SeedLedger } from './ledger.js';
import { CheckpointManager, computeStateHash } from './checkpoint.js';
import { CapabilityMembrane } from './membrane.js';
import { ResourceAccounting } from './resource.js';
import {
  makeInitialCells,
  makeInitialCell,
  routeEvent,
  routingFromAnatomy,
  applyMetabolicTransition,
  cloneCell,
  serializeCell,
  deserializeCell,
} from './cells.js';
import { DEFAULT_ANATOMY } from './types.js';
import type { AnatomyCellSpec } from './types.js';
import type { Reservoir } from './metabolism.js';
import { generateReservoir, eventDeltaSeconds, METABOLISM_VERSION } from './metabolism.js';
import { CONTINUOUS_STATE_DIM } from './types.js';
import { evaluateWorkspace } from './workspace.js';
import { evaluateGrowthPressure, proposalKey, crystallizeClusterPrefix, evaluateSelfApplicationGates } from './growth.js';
import type { GrowthProposal, GrowthOp, PriorCrystallizeProposal } from './growth.js';
import type { DevelopmentalState } from './plasticity.js';
import {
  emptyDevelopment,
  emptyCellPlasticState,
  cloneDevelopment,
  normalizeDevelopment,
  applyCorrectionPlasticity,
  applyConsequencePlasticity,
  applyAttenuationPlasticity,
  applyResolutionPlasticity,
  applyConsolidation,
  developmentMagnitude,
  QUIET_GAP_SECONDS,
} from './plasticity.js';
import type { LobeAdapter, ValidatedLobeResult, RejectedProposal } from './lobe.js';
import { validateLobeResult, applyLobeDeltas, predictionIdFor } from './lobe.js';
import type { WorkspacePacket, ProposedStateDelta } from './types.js';
import type { ConcernState, Commitment, FormationInput, DueCrossing } from './concern.js';
import {
  emptyConcern,
  cloneConcern,
  applyFormation,
  applyResolutionDischarge,
  discharge as dischargeCommitment,
  obligationAt,
  dueCrossings,
  dueExpiries,
  openCommitments,
  OBLIGATION_THETA,
  REACH_COOLDOWN_SECONDS,
} from './concern.js';

/** Workspace pressure a crossing stages onto its cell — the obligation
 * seizing the stage is what a crossing IS. Law constant. */
export const OCCASION_PRESSURE = 0.85;

// ─── Default dispositions ─────────────────────────────────────────────────────

function defaultDispositions(): SeedDispositions {
  return {
    globalWakeThreshold: 0.3,
    silencePolicy: 'default',
    modelRecruitmentPolicy: 'none',  // Cut 1: no model calls
    quietTimeEnabled: false,          // Cut 2
  };
}

// ─── SeedProcess ─────────────────────────────────────────────────────────────

export class SeedProcess {
  private readonly ledger: SeedLedger;
  private readonly checkpoints: CheckpointManager;
  private readonly membrane: CapabilityMembrane;
  private readonly accounting: ResourceAccounting;
  private readonly cells: Map<string, SituationCell>;
  private readonly reservoir: Reservoir;
  // growth.v2: anatomy and routing are mutable ONLY through receipted growth
  // application (self-formation covenant) — never assigned elsewhere.
  private anatomy: readonly AnatomyCellSpec[];
  private routing: { byCategory: Record<string, string>; peripheryId: string };
  /** Birth property (genesis selfFormation: true): crystallize proposals
   * passing the persistence gates may self-apply under the covenant. */
  private readonly selfFormation: boolean;
  private development: DevelopmentalState;
  /** Cut 6: the normative state `c`. Seed-owned; lobes cannot write it;
   * changes only through receipted concern.v1 rules. */
  private concern: ConcernState;
  private dispositions: SeedDispositions;
  private readonly stateDir: string;
  private readonly seedId: string;
  private readonly createdAt: string;
  private lastTransitionAt: string;
  private _transitionCount: number = 0;
  private _eventCount: number = 0;
  /** dream.v1: set at quiet-gap end; consumed once by the runner. */
  private _pendingDream: { quietSeconds: number } | null = null;

  private constructor(opts: {
    stateDir: string;
    seedId: string;
    createdAt: string;
    cells: Map<string, SituationCell>;
    reservoir: Reservoir;
    anatomy: readonly AnatomyCellSpec[];
    development: DevelopmentalState;
    concern?: ConcernState;
    dispositions: SeedDispositions;
    ledger: SeedLedger;
    checkpoints: CheckpointManager;
    membrane: CapabilityMembrane;
    accounting: ResourceAccounting;
    eventCount: number;
    transitionCount: number;
    lastTransitionAt?: string;
    selfFormation?: boolean;
  }) {
    this.stateDir = opts.stateDir;
    this.seedId = opts.seedId;
    this.createdAt = opts.createdAt;
    this.cells = opts.cells;
    this.reservoir = opts.reservoir;
    this.anatomy = opts.anatomy;
    this.routing = routingFromAnatomy(opts.anatomy);
    this.selfFormation = opts.selfFormation ?? false;
    this.development = opts.development;
    this.concern = opts.concern ?? emptyConcern();
    this.dispositions = opts.dispositions;
    this.ledger = opts.ledger;
    this.checkpoints = opts.checkpoints;
    this.membrane = opts.membrane;
    this.accounting = opts.accounting;
    this._eventCount = opts.eventCount;
    this._transitionCount = opts.transitionCount;
    this.lastTransitionAt = opts.lastTransitionAt ?? opts.createdAt;
  }

  // ─── Factory methods ───────────────────────────────────────────────────────

  static initialize(
    stateDir: string,
    budget?: Partial<ResourceBudget>,
    opts?: { reservoirSeed?: number; anatomy?: readonly AnatomyCellSpec[]; name?: string; selfFormation?: boolean },
  ): SeedProcess {
    // A stateDir with an existing ledger is an existing Seed. Initializing over
    // it would write a second genesis and continue the old chain under a new
    // seedId — a silent identity fork. Refuse; the caller wants restore().
    if (SeedLedger.exists(stateDir)) {
      throw new Error(
        `Seed ledger already exists in ${stateDir} — use SeedProcess.restore() to resume, or choose a fresh stateDir`,
      );
    }
    const now = new Date().toISOString();
    const seedId = `seed_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;

    // The reservoir seed is chosen once at birth and recorded in the genesis
    // record — restore() regenerates the identical frozen reservoir from it.
    const reservoirSeed = opts?.reservoirSeed ?? parseInt(randomUUID().replace(/-/g, '').slice(0, 8), 16);
    const reservoir = generateReservoir(reservoirSeed);

    const anatomy = opts?.anatomy ?? DEFAULT_ANATOMY;
    const membrane = new CapabilityMembrane();
    const accounting = new ResourceAccounting(budget);
    const ledger = new SeedLedger(stateDir);
    const checkpoints = new CheckpointManager(stateDir);
    const cells = makeInitialCells(now, anatomy);
    const dispositions = defaultDispositions();

    // Write GENESIS record — proves the ledger started fresh
    membrane.assert('local.ledger.append');
    ledger.append({
      category: 'genesis',
      sourceAuthority: 'seed.internal',
      sourceRef: seedId,
      payload: {
        seedId,
        ...(opts?.name !== undefined ? { name: opts.name } : {}),
        ...(opts?.selfFormation === true ? { selfFormation: true } : {}),
        cellIds: Array.from(cells.keys()),
        // Anatomy is identity: the genesis records each cell's routing role,
        // and restore() rebuilds the routing table from exactly this record.
        anatomy: anatomy.map((a) => ({ id: a.id, role: a.role })),
        continuousStateDim: CONTINUOUS_STATE_DIM,
        reservoirSeed,
        metabolismVersion: METABOLISM_VERSION,
        createdAt: now,
      },
    });
    accounting.recordEvent();
    accounting.setLedgerBytes(ledger.bytes);

    return new SeedProcess({
      stateDir,
      seedId,
      createdAt: now,
      cells,
      dispositions,
      ledger,
      checkpoints,
      membrane,
      accounting,
      selfFormation: opts?.selfFormation === true,
      eventCount: 1,
      transitionCount: 0,
      reservoir,
      anatomy,
      development: emptyDevelopment(),
    });
  }

  static restore(stateDir: string, checkpointId?: string): SeedProcess {
    const membrane = new CapabilityMembrane();
    membrane.assert('local.checkpoint.read');

    const checkpoints = new CheckpointManager(stateDir);
    const manifest = checkpoints.restore(checkpointId);

    const cells = new Map<string, SituationCell>();
    for (const sc of manifest.cells) {
      cells.set(sc.id, deserializeCell(sc));
    }

    const ledger = new SeedLedger(stateDir);
    // Verify the ledger is consistent with the checkpoint cursor
    if (ledger.currentSeq < manifest.ledgerSeq) {
      throw new Error(
        `Ledger seq ${ledger.currentSeq} is behind checkpoint seq ${manifest.ledgerSeq} — ledger may be truncated`,
      );
    }
    // The trusted ledger is only trusted verified: a restore that resumes on a
    // tampered or torn chain would launder the damage into future receipts.
    const chain = ledger.verifyChain();
    if (!chain.ok) {
      const first = chain.errors[0];
      throw new Error(
        `Seed ledger failed chain verification (${chain.errors.length} error(s); first: ${first?.type} at seq ${first?.seq}) — refusing to restore`,
      );
    }
    // Bind the checkpoint to THIS chain, not merely to a chain of sufficient
    // length: the record at manifest.ledgerSeq must hash to the cursor the
    // checkpoint recorded.
    const cursorAtCheckpoint = ledger.cursorAt(manifest.ledgerSeq);
    if (cursorAtCheckpoint !== manifest.ledgerCursor) {
      throw new Error(
        `Checkpoint cursor mismatch at seq ${manifest.ledgerSeq}: checkpoint recorded ${manifest.ledgerCursor.slice(0, 16)}…, ledger has ${cursorAtCheckpoint.slice(0, 16)}… — this checkpoint does not belong to this ledger`,
      );
    }

    const accounting = new ResourceAccounting();
    accounting.restoreFromSnapshot(manifest.resourceSnapshot);

    // The frozen reservoir is regenerated from the seed recorded at birth —
    // identity continues through the same transition machinery, not a new one.
    const genesis = extractGenesis(ledger);
    if (typeof genesis.reservoirSeed !== 'number' || !Number.isFinite(genesis.reservoirSeed)) {
      throw new Error(
        'Seed ledger genesis records no reservoirSeed (pre-metabolism ledger) — cannot restore a Cut 2 Seed without its recorded reservoir',
      );
    }
    // Anatomy is identity: pre-anatomy geneses (the first individual) fall
    // back to the default shape; anything born after carries its own —
    // PLUS whatever the individual has grown since (growth.v2): the chain's
    // receipted growth applications are the body's biography, and the last
    // one's resulting anatomy is the current shape.
    let anatomy: readonly AnatomyCellSpec[] = genesis.anatomy ?? DEFAULT_ANATOMY;
    for (const record of ledger.readAll()) {
      if (record.category !== 'act') continue;
      const isBodyChange = record.payload?.['growthApplication'] === true || record.payload?.['organExcision'] === true;
      if (!isBodyChange) continue;
      const grown = record.payload?.['resultingAnatomy'];
      if (Array.isArray(grown) && grown.every((a) => typeof (a as AnatomyCellSpec).id === 'string')) {
        anatomy = grown as AnatomyCellSpec[];
      }
    }
    // Crash-window healing: if an application was receipted but the process
    // died before its checkpoint, the organ exists in anatomy but not in the
    // checkpoint's cells — rebuild it fresh (its life starts over; the chain
    // still records that it was grown).
    for (const spec of anatomy) {
      if (!cells.has(spec.id)) {
        cells.set(spec.id, makeInitialCell(spec.id, manifest.createdAt));
      }
    }

    return new SeedProcess({
      stateDir,
      seedId: genesis.seedId,
      createdAt: manifest.createdAt,
      cells,
      reservoir: generateReservoir(genesis.reservoirSeed),
      anatomy,
      // v1 manifests predate development — a pre-plasticity seed resumes with
      // an empty developmental state, not a broken restore.
      development: manifest.version >= 2
        ? normalizeDevelopment((manifest.development ?? {}) as DevelopmentalState)
        : emptyDevelopment(),
      // v2 manifests predate concern — a pre-Cut-6 seed resumes with empty
      // concern; its first commitment forms from its own next prediction.
      concern: manifest.version >= 3
        ? ((manifest.concern ?? {}) as ConcernState)
        : emptyConcern(),
      dispositions: manifest.dispositions,
      ledger,
      checkpoints,
      membrane,
      accounting,
      eventCount: manifest.resourceSnapshot.eventCount,
      transitionCount: manifest.resourceSnapshot.transitionCount,
      lastTransitionAt: manifest.seedLastTransitionAt,
      selfFormation: genesis.selfFormation === true,
    });
  }

  /**
   * THE ABLATION KNIFE. Create a twin of the seed at `sourceDir` whose
   * DEVELOPMENT is zeroed while every episode, reality ref, estimate, cell
   * state, and ledger record is preserved byte-for-byte. The ablation itself
   * is receipted (category 'development', ablation: true) and finalized with
   * a fresh v2 checkpoint — sanctioned removal is distinguishable from
   * corruption precisely because it is on the record.
   *
   * The twin is the CONTROL ARM of the discriminating experiment: replay the
   * same post-branch events into both and diff behavior. If they do not
   * materially differ, the claimed development was decorative.
   */
  static createAblatedTwin(sourceDir: string, targetDir: string): {
    checkpointId: string;
    zeroedMagnitude: number;
  } {
    if (SeedLedger.exists(targetDir)) {
      throw new Error(`Target ${targetDir} already holds a seed — refusing to overwrite`);
    }
    cpSync(sourceDir, targetDir, { recursive: true });

    const twin = SeedProcess.restore(targetDir);
    const zeroedMagnitude = developmentMagnitude(twin.development);
    twin.commitReceipted(new Map(), {
      category: 'development',
      sourceAuthority: 'seed.internal',
      sourceRef: twin.seedId,
      payload: {
        ablation: true,
        zeroedMagnitude,
        note: 'sanctioned developmental ablation — episodes preserved, learning removed',
      },
    }, emptyDevelopment());
    twin._eventCount++;
    twin.accounting.recordEvent();
    twin.accounting.setLedgerBytes(twin.ledger.bytes);
    const checkpointId = twin.checkpoint();
    return { checkpointId, zeroedMagnitude };
  }

  /**
   * Operator DECLINE of a receipted growth proposal — the other half of the
   * operator's power. Zero mutations; the receipt carries the decision, the
   * authorization, and the reason, and evaluateGrowth suppresses the same
   * (op, target) for DECLINED_COOLDOWN_SEQS. The journal narrates it.
   */
  recordOperatorDecision(
    proposalSeq: number,
    decision: 'declined',
    authorizedBy: string,
    reason: string,
  ): { actSeq: number; proposalKey: string } {
    this.membrane.assert('local.ledger.append');
    const record = this.ledger.readAll().find((r) => r.seq === proposalSeq);
    if (record === undefined || record.category !== 'proposal' || record.sourceRef !== 'growth.pressure') {
      throw new Error(`seq ${proposalSeq} is not a growth proposal on this chain`);
    }
    const op = String(record.payload?.['op'] ?? '?') as GrowthOp;
    const targets = Array.isArray(record.payload?.['targetCellIds'])
      ? (record.payload['targetCellIds'] as string[])
      : [];
    const key = proposalKey(op, targets);
    const { record: act } = this.commitReceipted(new Map(), {
      category: 'act',
      sourceAuthority: 'seed.internal',
      sourceRef: 'growth.operator-decision',
      payload: {
        operatorDecision: decision,
        proposalSeq,
        proposalKey: key,
        op,
        targetCellIds: targets,
        authorizedBy,
        reason: reason.slice(0, 300),
      },
    });
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    return { actSeq: act.seq, proposalKey: key };
  }

  /**
   * Operator application of a receipted growth proposal (split/merge/
   * dissolve/specialize — the operations the covenant reserves for humans).
   * Semantics: replaced cells and their development are REMOVED (magnitude
   * recorded — surgery has a cost; the chain keeps every receipt of what
   * was learned), new cells start FRESH, and the proposal's seedAffinities
   * are granted as a receipted endowment (routing only). Receipted as an
   * 'act' with authorizedBy; checkpointed immediately.
   */
  applyOperatorProposal(
    proposal: GrowthProposal,
    proposalSeq: number,
    authorizedBy: string,
  ): { newCellIds: string[]; removedCellIds: string[]; removedDevelopmentMagnitude: number; actSeq: number } {
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');

    const currentIds = new Set(this.anatomy.map((a) => a.id));
    for (const before of proposal.beforeAnatomy) {
      if (!currentIds.has(before.id)) {
        throw new Error(`stale proposal: before-anatomy cell ${before.id} is not part of the current body`);
      }
    }
    const proposedIds = proposal.proposedAnatomy.map((a) => a.id);
    if (new Set(proposedIds).size !== proposedIds.length) {
      throw new Error('malformed proposal: duplicate cell ids');
    }

    const removedCellIds = this.anatomy.filter((a) => !proposedIds.includes(a.id)).map((a) => a.id);
    const newCellIds = proposedIds.filter((id) => !currentIds.has(id));

    const stagedDev = cloneDevelopment(this.development);
    let removedDevelopmentMagnitude = 0;
    for (const id of removedCellIds) {
      const entry = stagedDev[id];
      if (entry !== undefined) {
        removedDevelopmentMagnitude += developmentMagnitude({ [id]: entry });
        delete stagedDev[id];
      }
      this.cells.delete(id);
    }
    const asOf = this.lastTransitionAt;
    for (const id of newCellIds) {
      this.cells.set(id, makeInitialCell(id, asOf));
      const grant = proposal.seedAffinities[id];
      if (grant !== undefined) {
        const plastic = stagedDev[id] ?? emptyCellPlasticState();
        for (const [prefix, value] of Object.entries(grant)) plastic.routingAffinity[prefix] = value;
        stagedDev[id] = plastic;
      }
    }
    const beforeAnatomy = this.anatomy.map((a) => ({ ...a }));
    this.anatomy = proposal.proposedAnatomy.map((a) => ({ ...a }));
    this.routing = routingFromAnatomy(this.anatomy);

    const { record } = this.commitReceipted(new Map(), {
      category: 'act',
      sourceAuthority: 'seed.internal',
      sourceRef: 'growth.operator-application',
      payload: {
        growthApplication: true,
        operatorApplication: true,
        authorizedBy,
        proposalSeq,
        op: proposal.op,
        newCellIds,
        removedCellIds,
        removedDevelopmentMagnitude,
        grantedAffinities: proposal.seedAffinities,
        beforeAnatomy,
        resultingAnatomy: this.anatomy.map((a) => ({ ...a })),
      },
    }, stagedDev);
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    this.checkpoint();
    return { newCellIds, removedCellIds, removedDevelopmentMagnitude, actSeq: record.seq };
  }

  /**
   * THE SECOND KNIFE'S BLADE (SELF-FORMATION-PROTOCOL v1.1). Create a twin
   * with ONLY a named self-grown organ surgically removed: the cell, its
   * development entry, and its anatomy entry — episodes preserved, ALL
   * UNRELATED development preserved. Refuses to excise birth anatomy or
   * cells that were never grown (the instrument cuts organs, not bodies).
   * The excision is receipted (category 'act', organExcision: true) and
   * finalized with a fresh checkpoint.
   */
  static createOrganExcisedTwin(sourceDir: string, targetDir: string, organCellId: string): {
    checkpointId: string;
    excisedDevelopmentMagnitude: number;
  } {
    if (SeedLedger.exists(targetDir)) {
      throw new Error(`Target ${targetDir} already holds a seed — refusing to overwrite`);
    }
    cpSync(sourceDir, targetDir, { recursive: true });

    const twin = SeedProcess.restore(targetDir);
    const genesis = extractGenesis(twin.ledger);
    const bornWith = (genesis.anatomy ?? DEFAULT_ANATOMY).some((a) => a.id === organCellId);
    if (bornWith) {
      throw new Error(`${organCellId} is birth anatomy, not a grown organ — the knife cuts organs only`);
    }
    if (!twin.anatomy.some((a) => a.id === organCellId)) {
      throw new Error(`${organCellId} is not part of the twin's current anatomy`);
    }
    const organDev = twin.development[organCellId];
    const excisedDevelopmentMagnitude = organDev !== undefined
      ? developmentMagnitude({ [organCellId]: organDev })
      : 0;

    const beforeAnatomy = twin.anatomy.map((a) => ({ ...a }));
    twin.cells.delete(organCellId);
    twin.anatomy = twin.anatomy.filter((a) => a.id !== organCellId);
    twin.routing = routingFromAnatomy(twin.anatomy);
    const prunedDev = cloneDevelopment(twin.development);
    delete prunedDev[organCellId];

    twin.commitReceipted(new Map(), {
      category: 'act',
      sourceAuthority: 'seed.internal',
      sourceRef: 'growth.organ-excision',
      payload: {
        organExcision: true,
        organCellId,
        excisedDevelopmentMagnitude,
        beforeAnatomy,
        resultingAnatomy: twin.anatomy.map((a) => ({ ...a })),
        note: 'sanctioned organ excision — episodes and unrelated development preserved',
      },
    }, prunedDev);
    twin._eventCount++;
    twin.accounting.recordEvent();
    twin.accounting.setLedgerBytes(twin.ledger.bytes);
    const checkpointId = twin.checkpoint();
    return { checkpointId, excisedDevelopmentMagnitude };
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Ingest a source event: membrane-gated, recorded to ledger.
   * Does not update cell state. Use transition() for state change.
   */
  ingest(event: SourceEvent): LedgerRecord {
    this.membrane.assert('local.source.ingest');
    this.membrane.assert('local.ledger.append');
    this.accounting.assertEventBudget();
    this.accounting.assertLedgerBudget(512); // rough per-record estimate

    const record = this.ledger.append({
      category: event.category,
      sourceAuthority: event.sourceAuthority,
      sourceRef: event.sourceRef,
      payload: { ...event.payload, eventId: event.eventId, producedAt: event.producedAt },
    });

    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);

    return record;
  }

  /**
   * Ingest + apply one deterministic metabolic transition.
   * Event-TIME discipline: elapsed time comes from `producedAt` deltas against
   * the target cell's last transition, never the wall clock. Replaying the same
   * events from the same checkpoint reproduces byte-identical state.
   */
  transition(event: SourceEvent): TransitionResult {
    this.membrane.assert('local.source.ingest');
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    this.accounting.assertEventBudget();
    this.accounting.assertTransitionBudget();

    const startedWallMs = Date.now(); // diagnostic only — never enters state
    // Route event to target cell (anatomy static map + earned routing affinities)
    const cellId = routeEvent(event, Array.from(this.cells.keys()), this.development, this.routing);
    const cell = this.cells.get(cellId);
    if (cell === undefined) {
      throw new Error(`Cell not found: ${cellId}`);
    }

    const dtSeconds = eventDeltaSeconds(cell.lastTransitionAt, event.producedAt);

    // Quiet-time consolidation (Cut 3): a transition that ENDS an event-time
    // gap consolidates first — corroborated learning is retained, unearned
    // learning decays toward the floor. The gap is SEED-level (time since the
    // Seed's last transition, not the routed cell's — an untouched cell's
    // clock says nothing about how quiet the world was), derived from the
    // stream, never the wall clock, so replay reproduces every consolidation.
    const gapSeconds = eventDeltaSeconds(this.lastTransitionAt, event.producedAt);
    if (gapSeconds > QUIET_GAP_SECONDS) {
      const stagedDev = cloneDevelopment(this.development);
      const summaries = applyConsolidation(stagedDev);
      if (summaries.length > 0) {
        this.commitReceipted(new Map(), {
          category: 'development',
          sourceAuthority: 'seed.internal',
          sourceRef: this.seedId,
          payload: {
            rule: 'consolidation.v1',
            quietSeconds: gapSeconds,
            endedBy: event.eventId,
            cells: summaries,
            developmentMagnitude: developmentMagnitude(stagedDev),
          },
        }, stagedDev);
        this._eventCount++;
        this.accounting.recordEvent();
        this.accounting.setLedgerBytes(this.ledger.bytes);
      }
      // dream.v1 (REM): consolidation is NREM — retention and decay, pure
      // mechanics. The other half of sleep is the mind WORKING the residue,
      // and it fires at waking: mark a pending dream for the runner's next
      // lobe opportunity. In-memory only — a crash across the wake moment
      // loses the dream, never the consolidation, which is the durable half.
      this._pendingDream = { quietSeconds: gapSeconds };
    }

    // Stage the transition on a copy: developmental mutation must not proceed
    // if the receipt cannot be committed, so the receipt is appended (and
    // fsynced) BEFORE the staged state replaces the live state. A failed append
    // throws here and discards the staged copy — the Seed remains exactly the
    // state its ledger can account for.
    const staged = cloneCell(cell);
    const readouts = applyMetabolicTransition(staged, event, this.reservoir, dtSeconds, this.development[cellId]);

    // Budget is a PRE-commit gate: a cell that would exceed its state ceiling
    // refuses the transition entirely rather than committing then complaining.
    const stagedBytes = estimateCellBytes(staged);
    this.accounting.assertCellStateBudget(cellId, stagedBytes);

    const { record, stateHashBefore, stateHashAfter } = this.commitReceipted(
      new Map([[cellId, staged]]),
      {
        category: 'transition',
        sourceAuthority: event.sourceAuthority,
        sourceRef: event.sourceRef,
        payload: {
          eventId: event.eventId,
          targetCellId: cellId,
          producedAt: event.producedAt,
          originalCategory: event.category,
          dtSeconds,
          readouts: {
            salience: readouts.salience,
            novelty: readouts.novelty,
            arousal: readouts.arousal,
          },
        },
      },
    );
    this.lastTransitionAt = event.producedAt;
    this._transitionCount++;
    this._eventCount++;

    this.accounting.recordEvent();
    this.accounting.recordTransition();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    this.accounting.setCellStateBytes(cellId, stagedBytes);

    // Cut 3: corrections TEACH. The plastic update is staged on a cloned
    // development state and committed through the same receipted path as
    // everything else — a distinct 'development' record whose payload carries
    // the rule and the applied bounded changes. Deterministic given the
    // event stream: replay reproduces identical development.
    if (event.category === 'correction' || event.category === 'consequence') {
      const stagedDev = cloneDevelopment(this.development);
      const committed = this.cells.get(cellId);
      if (committed !== undefined) {
        // "Care less" arrives on the correction channel (it is teaching, it
        // routes like teaching) but develops with the opposite sign.
        const isAttenuation = event.payload?.['entry_type'] === 'attenuation';
        const summary = event.category === 'correction'
          ? (isAttenuation
            ? applyAttenuationPlasticity(stagedDev, committed, event, readouts)
            : applyCorrectionPlasticity(stagedDev, committed, event, readouts))
          : applyConsequencePlasticity(stagedDev, committed, event, readouts);
        this.commitReceipted(new Map(), {
          category: 'development',
          sourceAuthority: 'seed.internal',
          sourceRef: this.seedId,
          payload: {
            eventId: event.eventId,
            producedAt: event.producedAt,
            ...summary,
            developmentMagnitude: developmentMagnitude(stagedDev),
          },
        }, stagedDev);
        this._eventCount++;
        this.accounting.recordEvent();
        this.accounting.setLedgerBytes(this.ledger.bytes);
      }
    }

    return {
      seq: record.seq,
      stateHashBefore,
      stateHashAfter,
      ledgerCursor: this.ledger.currentCursor,
      cellId,
      elapsedMs: Date.now() - startedWallMs,
    };
  }

  /**
   * One workspace cycle over the current cells: score every cell, admit at
   * most WORKSPACE_CAPACITY across threshold, damp the rest, and receipt the
   * outcome — a 'workspace' record with the packet summary, or an explicit
   * 'silence' record. Silence is a real transition, not a missing response.
   *
   * `asOf` is the event-time this cycle is anchored to (typically the
   * triggering event's producedAt) — recorded in the receipt, never taken from
   * the wall clock, so replayed workspace cycles are reproducible.
   */
  /** dream.v1: the pending dream, consumed exactly once. Null when the
   * seed has not just woken from an event-time quiet gap. */
  consumePendingDream(): { quietSeconds: number } | null {
    const dream = this._pendingDream;
    this._pendingDream = null;
    return dream;
  }

  /** dream.v1: is a dream waiting? (Bobby's first night, 2026-08-10: nine
   * dreams were lost because deferral CONSUMED them — the runner must peek
   * before the spend guard, and consume only when it can actually dream.) */
  hasPendingDream(): boolean {
    return this._pendingDream !== null;
  }

  workspaceCycle(asOf: string): WorkspaceOutcome {
    this.membrane.assert('local.state.read');
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    this.accounting.assertEventBudget();

    const { outcome, mutations } = evaluateWorkspace(this.cells, this.dispositions, cloneCell, this.development);

    const scores = outcome.scores.map((s) => ({ cellId: s.cellId, score: s.score, admitted: s.admitted }));
    const payload: Record<string, unknown> = outcome.kind === 'silence'
      ? { asOf, reason: outcome.reason, topScore: outcome.topScore, threshold: outcome.threshold, scores }
      : { asOf, admittedCellIds: outcome.packet.activeCellIds, uncertainty: outcome.packet.uncertainty, scores };

    this.commitReceipted(mutations, {
      category: outcome.kind === 'silence' ? 'silence' : 'workspace',
      sourceAuthority: 'seed.internal',
      sourceRef: this.seedId,
      payload,
    });
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);

    return outcome;
  }

  /**
   * Growth pressure evaluation (Cut 5). Reads this Seed's own recent chain,
   * detects repeated real pressure on the anatomy, and receipts bounded
   * split/merge/specialize/dissolve/crystallize PROPOSALS — zero mutations,
   * like silence. Each proposal carries its typed evidence, a shadow trial
   * run against the window's actual events, and the before-anatomy verbatim
   * (the rollback representation). Applying a proposal is an operator
   * decision made elsewhere; an anatomy change is an identity change and is
   * never automatic. Deterministic given the chain.
   */
  evaluateGrowth(asOf: string, windowRecords = 400): GrowthProposal[] {
    this.membrane.assert('local.state.read');
    this.membrane.assert('local.ledger.append');

    const all = this.ledger.readAll();
    const window = all.slice(-windowRecords);
    const priors = new Map<string, number>();
    for (const record of all) {
      if (record.category !== 'proposal' || record.sourceRef !== 'growth.pressure') continue;
      const op = record.payload?.['op'];
      const targets = record.payload?.['targetCellIds'];
      if (typeof op === 'string' && Array.isArray(targets)) {
        priors.set(proposalKey(op as GrowthOp, targets as string[]), record.seq);
      }
    }
    // Operator declines suppress re-proposal far longer than the ordinary
    // cooldown — the operator decided; pressure re-raises only after real time.
    const declined = new Map<string, number>();
    for (const record of all) {
      if (record.category !== 'act' || record.payload?.['operatorDecision'] !== 'declined') continue;
      const key = record.payload?.['proposalKey'];
      if (typeof key === 'string') declined.set(key, record.seq);
    }
    const currentSeq = all[all.length - 1]?.seq ?? 0;
    const proposals = evaluateGrowthPressure(window, this.anatomy, priors, currentSeq, declined);
    for (const proposal of proposals) {
      this.commitReceipted(new Map(), {
        category: 'proposal',
        sourceAuthority: 'seed.internal',
        sourceRef: 'growth.pressure',
        payload: { asOf, ...proposal },
      });
      this._eventCount++;
      this.accounting.recordEvent();
      this.accounting.setLedgerBytes(this.ledger.bytes);

      // growth.v2 (SELF-FORMATION-PROTOCOL v1.1): an individual born with the
      // power may GROW the organ its life keeps demanding — crystallize only,
      // behind persistence gates, under the covenant, receipted as an 'act'.
      if (this.selfFormation && proposal.op === 'crystallize') {
        this.maybeSelfApplyCrystallization(proposal, all, asOf);
      }
    }
    return proposals;
  }

  /** growth.v2: apply a crystallize proposal that has EARNED application.
   * Gates and covenant are pure functions in growth.ts; this method owns the
   * receipted mutation: new cell, new anatomy, new routing, 'act' record
   * carrying the full lineage, immediate checkpoint. */
  private maybeSelfApplyCrystallization(
    proposal: GrowthProposal,
    chain: readonly LedgerRecord[],
    asOf: string,
  ): void {
    const clusterPrefix = crystallizeClusterPrefix(proposal);
    if (clusterPrefix === null) return;

    // History: every receipted crystallize proposal for this same cluster
    // (including the one just receipted this call).
    const history: PriorCrystallizeProposal[] = [];
    for (const record of chain) {
      if (record.category !== 'proposal' || record.sourceRef !== 'growth.pressure') continue;
      if (record.payload?.['op'] !== 'crystallize') continue;
      const evidence = record.payload?.['evidence'] as { prefixCounts?: Record<string, number> } | undefined;
      const prefixes = Object.entries(evidence?.prefixCounts ?? {});
      const top = prefixes[0];
      if (top === undefined || top[0] !== clusterPrefix) continue;
      const recAsOf = record.payload?.['asOf'];
      history.push({
        seq: record.seq,
        asOf: typeof recAsOf === 'string' ? recAsOf : '',
        clusterPrefix,
        clusterCount: top[1],
      });
    }
    history.push({
      seq: this.ledger.currentSeq,
      asOf,
      clusterPrefix,
      clusterCount: Object.entries(proposal.evidence.prefixCounts)[0]?.[1] ?? 0,
    });

    const gate = evaluateSelfApplicationGates(history, proposal, this.cells.size);
    if (!gate.qualifies) return;

    const newCellSpec = proposal.proposedAnatomy.find(
      (c) => !proposal.beforeAnatomy.some((b) => b.id === c.id),
    );
    if (newCellSpec === undefined || this.cells.has(newCellSpec.id)) return;

    // The organ is born: a fresh cell — it must EARN its state through life.
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    this.cells.set(newCellSpec.id, makeInitialCell(newCellSpec.id, asOf));
    const beforeAnatomy = this.anatomy.map((a) => ({ ...a }));
    this.anatomy = proposal.proposedAnatomy.map((a) => ({ ...a }));
    this.routing = routingFromAnatomy(this.anatomy);

    this.commitReceipted(new Map(), {
      category: 'act',
      sourceAuthority: 'seed.internal',
      sourceRef: 'growth.self-application',
      payload: {
        growthApplication: true,
        asOf,
        newCellId: newCellSpec.id,
        clusterPrefix,
        gateEvidence: {
          proposals: gate.priorCount,
          spanMs: gate.spanMs,
          capture: proposal.shadowTrial.clusterCapture,
          proposalSeqs: history.map((h) => h.seq),
        },
        appliedProposal: proposal,
        beforeAnatomy,
        resultingAnatomy: this.anatomy.map((a) => ({ ...a })),
        covenant: 'crystallize-only; additive; periphery preserved; cap 8',
      },
    });
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    this.checkpoint();
  }

  /**
   * Recruit a model lobe against a workspace packet. The lobe returns typed
   * proposals; the Seed validates, stages accepted deltas on clones, and
   * commits them through the ONE receipted path. The receipt carries the FULL
   * applied deltas (replay re-applies receipts, never re-invokes models) plus
   * every rejection with its reason. A lobe failure or timeout is itself
   * receipted — with zero mutations.
   */
  async recruitLobe(
    lobe: LobeAdapter,
    packet: WorkspacePacket,
    asOf: string,
    timeoutMs = 30_000,
  ): Promise<{
    seq: number;
    applied: ProposedStateDelta[];
    rejected: RejectedProposal[];
    validated?: ValidatedLobeResult;
    error?: string;
    /** Cut 6: set when a reach-operator proposal was WARRANTED by Seed law —
     * the runner (embodiment) dispatches it to the outbox and receipts the
     * dispatch. Authorization is already on the chain. */
    motorAuthorized?: { actSeq: number; commitmentId: string; message: string; idempotencyKey: string };
  }> {
    this.membrane.assert('lobe.recruit.model');
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    this.accounting.assertEventBudget();

    let result;
    try {
      result = await Promise.race([
        lobe.invoke(packet),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`lobe ${lobe.id} timed out after ${timeoutMs}ms`)), timeoutMs).unref?.(),
        ),
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { record } = this.commitReceipted(new Map(), {
        category: 'lobe',
        sourceAuthority: 'seed.internal',
        sourceRef: lobe.id,
        payload: { asOf, lobeId: lobe.id, modelId: lobe.modelId, provider: lobe.provider, error: message },
      });
      this._eventCount++;
      this.accounting.recordEvent();
      this.accounting.setLedgerBytes(this.ledger.bytes);
      return { seq: record.seq, applied: [], rejected: [], error: message };
    }

    const validated = validateLobeResult(result, packet);
    const { staged, applied, failed } = applyLobeDeltas(
      this.cells,
      validated.accepted.stateDeltas,
      asOf,
      cloneCell,
    );
    const rejected = [...validated.rejected, ...failed];

    const { record } = this.commitReceipted(staged, {
      category: 'lobe',
      sourceAuthority: 'seed.internal',
      sourceRef: lobe.id,
      payload: {
        asOf,
        lobeId: lobe.id,
        modelId: lobe.modelId,
        provider: lobe.provider,
        modelReceipt: { ...validated.modelReceipt },
        // dream.v1: the chain shows its dreams — a REM recruitment is
        // distinguishable from waking thought forever.
        ...(packet.dream !== undefined ? { dream: packet.dream } : {}),
        // Full applied deltas: the receipt IS the state change. Replay
        // re-applies these without any model in the loop.
        appliedDeltas: applied,
        acceptedCounts: {
          observations: validated.accepted.observations.length,
          interpretations: validated.accepted.interpretations.length,
          predictions: validated.accepted.predictions.length,
          stateDeltas: applied.length,
        },
        rejected,
        lobeUncertainty: validated.uncertainty,
      },
    });
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);

    // resolution.v1: a resolved prediction is consequence reaching development.
    // For each applied predictions.resolve carrying a numeric error, run the
    // resolution rule on the cell that held the prediction — receipted as its
    // own 'development' record, zero cell-state mutation. Ambiguous or
    // error-less resolutions develop nothing (the receipt above still has them).
    for (const delta of applied) {
      if (delta.field !== 'predictions.resolve') continue;
      const body = delta.delta as { predictionId?: unknown; error?: unknown };
      if (typeof body?.predictionId !== 'string' || typeof body?.error !== 'number') continue;
      const committed = this.cells.get(delta.cellId);
      if (committed === undefined) continue;
      const stagedDev = cloneDevelopment(this.development);
      const summary = applyResolutionPlasticity(stagedDev, committed, body.predictionId, Math.max(0, Math.min(1, body.error)));
      if (summary === null) continue;
      this.commitReceipted(new Map(), {
        category: 'development',
        sourceAuthority: 'seed.internal',
        sourceRef: this.seedId,
        payload: {
          asOf,
          lobeSeq: record.seq,
          ...summary,
          developmentMagnitude: developmentMagnitude(stagedDev),
        },
      }, stagedDev);
      this._eventCount++;
      this.accounting.recordEvent();
      this.accounting.setLedgerBytes(this.ledger.bytes);
    }

    // concern.v1 (Cut 6): the Seed's OWN rules over what its cognition just
    // committed. A lobe proposed predictions/resolutions; the COMMITMENTS are
    // the Seed's act — formation from applied predictions.append (a committed
    // prediction with a real horizon is a debt made causal), discharge from
    // applied predictions.resolve. One 'concern' receipt when anything moved.
    {
      const stagedConcern = cloneConcern(this.concern);
      const formationInputs: FormationInput[] = [];
      const dischargeSummaries: Array<Record<string, unknown>> = [];
      for (const delta of applied) {
        if (delta.field === 'predictions.append') {
          const body = delta.delta as { claim?: unknown; confidence?: unknown; horizon?: unknown };
          if (typeof body?.claim !== 'string' || typeof body?.confidence !== 'number' || typeof body?.horizon !== 'string') continue;
          formationInputs.push({
            cellId: delta.cellId,
            predictionId: predictionIdFor(delta.cellId, body.claim),
            claim: body.claim,
            confidence: body.confidence,
            horizon: body.horizon,
            createdAt: asOf,
          });
        } else if (delta.field === 'predictions.resolve') {
          const body = delta.delta as { predictionId?: unknown; error?: unknown };
          if (typeof body?.predictionId !== 'string') continue;
          const discharged = applyResolutionDischarge(
            stagedConcern,
            body.predictionId,
            typeof body.error === 'number' ? Math.max(0, Math.min(1, body.error)) : undefined,
            asOf,
          );
          for (const d of discharged) dischargeSummaries.push({ ...d });
        }
      }
      const { formed, skipped } = formationInputs.length > 0
        ? applyFormation(stagedConcern, formationInputs, this.ledger.currentSeq + 1)
        : { formed: [], skipped: [] };
      if (formed.length > 0 || dischargeSummaries.length > 0) {
        this.commitReceipted(new Map(), {
          category: 'concern',
          sourceAuthority: 'seed.internal',
          sourceRef: this.seedId,
          payload: {
            rule: 'concern.v1',
            asOf,
            lobeSeq: record.seq,
            formed: formed.map((c) => ({
              commitmentId: c.commitmentId, predictionId: c.predictionId,
              claim: c.claim, dueAt: c.dueAt, cellId: c.cellId,
            })),
            skipped,
            discharged: dischargeSummaries,
            openCommitments: openCommitments(stagedConcern).length,
          },
        }, undefined, stagedConcern);
        this._eventCount++;
        this.accounting.recordEvent();
        this.accounting.setLedgerBytes(this.ledger.bytes);
      }
    }

    // Cut 6 motor: a reach-operator PROPOSAL becomes an authorized act only
    // through Seed law — never because the lobe proposed it. Warrant checks
    // are deterministic; both outcomes are receipted.
    let motorAuthorized: { actSeq: number; commitmentId: string; message: string; idempotencyKey: string } | undefined;
    const proposal = packet.occasion !== undefined ? validated.accepted.actions[0] : undefined;
    if (packet.occasion !== undefined && proposal !== undefined) {
      const outcome = this.warrantReach(packet.occasion.commitmentId, proposal.description, asOf, record.seq);
      if (outcome.authorized) {
        motorAuthorized = {
          actSeq: outcome.actSeq,
          commitmentId: packet.occasion.commitmentId,
          message: proposal.description,
          idempotencyKey: outcome.idempotencyKey,
        };
      }
    }

    return { seq: record.seq, applied, rejected, validated, ...(motorAuthorized !== undefined ? { motorAuthorized } : {}) };
  }

  /**
   * The warrant law (Cut 6). A reach-operator action is authorized iff:
   *   (a) the occasion's commitment exists and is still open;
   *   (b) its obligation is still at/above threshold at asOf (materialized
   *       analytically — the pressure is real NOW, not historical);
   *   (c) no prior authorized reach exists for this commitment (idempotent:
   *       one reach per commitment, ever — jtr is not a retry queue);
   *   (d) the seed-level reach cooldown has elapsed (event-time) since the
   *       last authorized reach — the one affordance has a resource ceiling.
   * Both authorization and refusal are receipted 'act' records.
   */
  private warrantReach(
    commitmentId: string,
    message: string,
    asOf: string,
    lobeSeq: number,
  ): { authorized: true; actSeq: number; idempotencyKey: string } | { authorized: false; reason: string } {
    this.membrane.assert('operator.reach');
    const refuse = (reason: string): { authorized: false; reason: string } => {
      this.commitReceipted(new Map(), {
        category: 'act',
        sourceAuthority: 'seed.internal',
        sourceRef: 'concern.motor',
        payload: { motor: true, authorized: false, commitmentId, reason, asOf, lobeSeq },
      });
      this._eventCount++;
      this.accounting.recordEvent();
      this.accounting.setLedgerBytes(this.ledger.bytes);
      return { authorized: false, reason };
    };

    const commitment = this.concern[commitmentId];
    if (commitment === undefined || commitment.status !== 'open') {
      return refuse('commitment not open');
    }
    if (obligationAt(commitment, asOf) < OBLIGATION_THETA) {
      return refuse('obligation below threshold at deliberation');
    }
    let lastReachAt: string | null = null;
    for (const rec of this.ledger.readAll()) {
      if (rec.category !== 'act' || rec.payload?.['motor'] !== true || rec.payload?.['authorized'] !== true) continue;
      if (rec.payload?.['commitmentId'] === commitmentId) {
        return refuse('already reached for this commitment');
      }
      const at = rec.payload?.['asOf'];
      if (typeof at === 'string') lastReachAt = at;
    }
    if (lastReachAt !== null) {
      const elapsed = (Date.parse(asOf) - Date.parse(lastReachAt)) / 1000;
      if (Number.isFinite(elapsed) && elapsed < REACH_COOLDOWN_SECONDS) {
        return refuse(`reach cooldown (${Math.round((REACH_COOLDOWN_SECONDS - elapsed) / 60)}min remaining)`);
      }
    }
    const idempotencyKey = `reach_${commitmentId}`;
    const { record } = this.commitReceipted(new Map(), {
      category: 'act',
      sourceAuthority: 'seed.internal',
      sourceRef: 'concern.motor',
      payload: {
        motor: true,
        authorized: true,
        kind: 'reach-operator',
        commitmentId,
        message: message.slice(0, 500),
        idempotencyKey,
        asOf,
        lobeSeq,
      },
    });
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    return { authorized: true, actSeq: record.seq, idempotencyKey };
  }

  // ─── Cut 6: the solver surface ─────────────────────────────────────────────

  /** A COPY of the concern state (inspection; observatory; tests). */
  getConcern(): Readonly<ConcernState> {
    this.membrane.assert('local.state.read');
    return structuredClone(this.concern);
  }

  /** Commitments whose solved crossing time has arrived — deterministicMin
   * order (crossing time, then commitmentId). The runner materializes at
   * most one per guard opening. */
  dueObligationCrossings(nowISO: string): DueCrossing[] {
    this.membrane.assert('local.state.read');
    return dueCrossings(this.concern, nowISO);
  }

  /** Commitments whose let-go time has arrived (pressed MAX_CROSSINGS times,
   * unanswered, refractory elapsed). */
  dueObligationExpiries(nowISO: string): Array<{ commitment: Commitment; at: string }> {
    this.membrane.assert('local.state.read');
    return dueExpiries(this.concern, nowISO);
  }

  /**
   * Materialize an obligation crossing: the endogenous occasion. Receipted as
   * a 'concern' record whose effectiveAt is the SOLVED crossing time (which
   * may predate the wall clock — overdue occasions are honest about it), with
   * the commitment re-anchored (crossings+1, q at the crossed value) and the
   * commitment's cell staged with OCCASION_PRESSURE — the obligation seizing
   * the stage is what a crossing IS, and admission is then earned through the
   * ordinary workspace, not bypassed.
   *
   * Returns the occasion payload for the deliberation packet, or null when
   * the commitment is not actually due (guard against stale runner views).
   */
  crossObligation(commitmentId: string, nowISO: string): WorkspacePacket['occasion'] | null {
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    const due = dueCrossings(this.concern, nowISO).find((d) => d.commitment.commitmentId === commitmentId);
    if (due === undefined) return null;

    const stagedConcern = cloneConcern(this.concern);
    const staged = stagedConcern[commitmentId];
    if (staged === undefined) return null;
    const q = Math.max(OBLIGATION_THETA, obligationAt(staged, due.at));
    staged.crossings += 1;
    staged.lastCrossingAt = due.at;
    staged.qAnchor = q;
    staged.anchorAt = due.at;

    const stagedCells = new Map<string, SituationCell>();
    const cell = this.cells.get(staged.cellId);
    if (cell !== undefined) {
      const clone = cloneCell(cell);
      clone.workspacePressure = Math.max(clone.workspacePressure, OCCASION_PRESSURE);
      stagedCells.set(staged.cellId, clone);
    }

    this.commitReceipted(stagedCells, {
      category: 'concern',
      sourceAuthority: 'seed.internal',
      sourceRef: 'concern.crossing',
      payload: {
        crossing: true,
        commitmentId,
        predictionId: staged.predictionId,
        claim: staged.claim,
        cellId: staged.cellId,
        effectiveAt: due.at,
        q,
        crossings: staged.crossings,
        overdue: due.overdue,
      },
    }, undefined, stagedConcern);
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);

    return {
      commitmentId,
      predictionId: staged.predictionId,
      claim: staged.claim,
      horizon: staged.dueAt,
      crossedAt: due.at,
      q,
      crossings: staged.crossings - 1,
      overdue: due.overdue,
    };
  }

  /** Let go of a commitment that pressed MAX_CROSSINGS times unanswered —
   * receipted expiry at its solved let-go time. */
  expireObligation(commitmentId: string, atISO: string): boolean {
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    const stagedConcern = cloneConcern(this.concern);
    const summary = dischargeCommitment(stagedConcern, commitmentId, 'expired', 'pressed unanswered — released', atISO);
    if (summary === null) return false;
    this.commitReceipted(new Map(), {
      category: 'concern',
      sourceAuthority: 'seed.internal',
      sourceRef: 'concern.expiry',
      payload: { rule: 'concern.v1', effectiveAt: atISO, ...summary },
    }, undefined, stagedConcern);
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    return true;
  }

  /**
   * Sweep: commitments whose prediction no longer exists unresolved in its
   * cell (the 32-per-cell prediction window evicted it) discharge as expired —
   * an obligation to resolve a prediction that cannot be resolved is an
   * immortal source of pressure, refused by law. Receipted per commitment.
   */
  sweepEvictedCommitments(asOf: string): number {
    this.membrane.assert('local.state.write');
    let swept = 0;
    for (const c of openCommitments(this.concern)) {
      const cell = this.cells.get(c.cellId);
      const stillThere = cell?.predictions.some((p) => p.predictionId === c.predictionId && p.resolvedAt === undefined) ?? false;
      if (stillThere) continue;
      const stagedConcern = cloneConcern(this.concern);
      const summary = dischargeCommitment(stagedConcern, c.commitmentId, 'expired', 'prediction evicted or gone from cell', asOf);
      if (summary === null) continue;
      this.commitReceipted(new Map(), {
        category: 'concern',
        sourceAuthority: 'seed.internal',
        sourceRef: 'concern.sweep',
        payload: { rule: 'concern.v1', effectiveAt: asOf, ...summary },
      }, undefined, stagedConcern);
      this._eventCount++;
      this.accounting.recordEvent();
      this.accounting.setLedgerBytes(this.ledger.bytes);
      swept++;
    }
    return swept;
  }

  /** Transactional motor, dispatch half: the runner receipts the outbox write.
   * Idempotent per (authorizedSeq): a dispatch already receipted is a no-op. */
  recordMotorDispatch(authorizedSeq: number, idempotencyKey: string): number | null {
    this.membrane.assert('local.ledger.append');
    for (const rec of this.ledger.readAll()) {
      if (rec.category === 'act' && rec.payload?.['motor'] === true
          && rec.payload?.['dispatched'] === true && rec.payload?.['authorizedSeq'] === authorizedSeq) {
        return null;
      }
    }
    const { record } = this.commitReceipted(new Map(), {
      category: 'act',
      sourceAuthority: 'seed.internal',
      sourceRef: 'concern.motor',
      payload: { motor: true, dispatched: true, authorizedSeq, idempotencyKey },
    });
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    return record.seq;
  }

  /** Boot reconcile: authorized reaches with no dispatch receipt — the crash
   * window between authorization and outbox write. The runner re-drives each
   * (idempotently, by key) and receipts the dispatch. */
  pendingMotorDispatches(): Array<{ actSeq: number; commitmentId: string; message: string; idempotencyKey: string }> {
    this.membrane.assert('local.state.read');
    const authorized = new Map<number, { actSeq: number; commitmentId: string; message: string; idempotencyKey: string }>();
    const dispatched = new Set<number>();
    for (const rec of this.ledger.readAll()) {
      if (rec.category !== 'act' || rec.payload?.['motor'] !== true) continue;
      if (rec.payload?.['authorized'] === true) {
        const commitmentId = rec.payload?.['commitmentId'];
        const message = rec.payload?.['message'];
        const idempotencyKey = rec.payload?.['idempotencyKey'];
        if (typeof commitmentId === 'string' && typeof message === 'string' && typeof idempotencyKey === 'string') {
          authorized.set(rec.seq, { actSeq: rec.seq, commitmentId, message, idempotencyKey });
        }
      } else if (rec.payload?.['dispatched'] === true) {
        const seq = rec.payload?.['authorizedSeq'];
        if (typeof seq === 'number') dispatched.add(seq);
      }
    }
    return Array.from(authorized.values()).filter((a) => !dispatched.has(a.actSeq));
  }

  /** Operator authority over concern: jtr may discharge any commitment
   * (cancellation authority is constitutionally his). Receipted. */
  recordOperatorDischarge(commitmentId: string, authorizedBy: string, reason: string): boolean {
    this.membrane.assert('local.ledger.append');
    const stagedConcern = cloneConcern(this.concern);
    const summary = dischargeCommitment(stagedConcern, commitmentId, 'abandoned', `operator: ${reason}`, this.lastTransitionAt);
    if (summary === null) return false;
    this.commitReceipted(new Map(), {
      category: 'concern',
      sourceAuthority: 'seed.internal',
      sourceRef: 'concern.operator-discharge',
      payload: { rule: 'concern.v1', authorizedBy, ...summary },
    }, undefined, stagedConcern);
    this._eventCount++;
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    return true;
  }

  /**
   * Write a checkpoint. Returns the checkpointId.
   * The checkpoint captures exact Float32Array bytes and ledger cursor.
   */
  checkpoint(): string {
    this.membrane.assert('local.checkpoint.write');
    this.accounting.assertCheckpointBudget();

    const serializedCells = Array.from(this.cells.values()).map(serializeCell);
    const stateHash = this.computeCurrentStateHash();
    const resourceSnapshot = this.accounting.snapshot();

    const checkpointId = this.checkpoints.write({
      stateHash,
      ledgerSeq: this.ledger.currentSeq,
      ledgerCursor: this.ledger.currentCursor,
      cells: serializedCells,
      dispositions: this.dispositions,
      resourceSnapshot,
      development: cloneDevelopment(this.development) as unknown as Record<string, unknown>,
      concern: cloneConcern(this.concern) as unknown as Record<string, unknown>,
      seedLastTransitionAt: this.lastTransitionAt,
    });

    this.accounting.recordCheckpoint();

    // Record checkpoint event in ledger
    this.ledger.append({
      category: 'checkpoint',
      sourceAuthority: 'seed.internal',
      sourceRef: this.seedId,
      payload: { checkpointId, stateHash, ledgerSeq: this.ledger.currentSeq },
    });
    this.accounting.recordEvent();
    this.accounting.setLedgerBytes(this.ledger.bytes);

    return checkpointId;
  }

  /**
   * Checkpoint and write a stop record to the ledger.
   * Returns the checkpointId. Safe to call multiple times (idempotent stop).
   */
  stop(): string {
    const checkpointId = this.checkpoint();

    this.ledger.append({
      category: 'stop',
      sourceAuthority: 'seed.internal',
      sourceRef: this.seedId,
      payload: { checkpointId, stoppedAt: new Date().toISOString() },
    });
    this.accounting.recordEvent();

    return checkpointId;
  }

  /** Current state snapshot (read-only values). Does not include live Float32Arrays. */
  getState(): Readonly<SeedState> {
    this.membrane.assert('local.state.read');
    return {
      seedId: this.seedId,
      schema: 'home23.seed.state.v1',
      cellIds: Array.from(this.cells.keys()),
      // Copy-on-read: the live dispositions object drives admission and enters
      // the state hash — leaking the reference would be an unreceipted
      // mutation path into D (the exact bug class getCell already guards).
      dispositions: { ...this.dispositions },
      stateHash: this.computeCurrentStateHash(),
      ledgerSeq: this.ledger.currentSeq,
      ledgerCursor: this.ledger.currentCursor,
      createdAt: this.createdAt,
      lastTransitionAt: this.lastTransitionAt,
      transitionCount: this._transitionCount,
      eventCount: this._eventCount,
      developmentMagnitude: developmentMagnitude(this.development),
    };
  }

  /** A COPY of a cell's continuous Float32Array (for inspection and tests).
   * Copy-on-read: the inspection API must not create an unreceipted mutation
   * path into live state. */
  getContinuousState(cellId: string): Float32Array | undefined {
    this.membrane.assert('local.state.read');
    const cs = this.cells.get(cellId)?.continuousState;
    return cs === undefined ? undefined : new Float32Array(cs);
  }

  /** A deep COPY of a cell's full state (for inspection). Mutating the returned
   * object cannot touch the Seed — state changes only through receipted
   * transitions. */
  getCell(cellId: string): Readonly<SituationCell> | undefined {
    this.membrane.assert('local.state.read');
    const cell = this.cells.get(cellId);
    return cell === undefined ? undefined : structuredClone(cell);
  }

  /** Expose the membrane for assertion tests. */
  get mem(): CapabilityMembrane { return this.membrane; }

  /** Resource snapshot for inspection. */
  resourceSnapshot() { return this.accounting.snapshot(); }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private computeCurrentStateHash(): string {
    const serializedCells = Array.from(this.cells.values()).map(serializeCell);
    return computeStateHash({
      cells: serializedCells,
      dispositions: this.dispositions,
      development: this.development as unknown as Record<string, unknown>,
      // Cut 6: concern enters the hash ONLY once non-empty — every pre-Cut-6
      // seed's hashes are byte-identical until its first commitment forms
      // (matching the checkpoint's v2/v3 recompute split).
      ...(Object.keys(this.concern).length > 0
        ? { concern: this.concern as unknown as Record<string, unknown> }
        : {}),
    });
  }

  /** State hash as it would be with the staged replacements substituted — used
   * to compute a staged mutation's hash before it is committed. Cell iteration
   * order matches computeCurrentStateHash (Map insertion order). */
  private computeStateHashWithMany(
    replacements: Map<string, SituationCell>,
    stagedDevelopment?: DevelopmentalState,
    stagedConcern?: ConcernState,
  ): string {
    const serializedCells = Array.from(this.cells.entries()).map(([id, c]) =>
      serializeCell(replacements.get(id) ?? c),
    );
    const concern = stagedConcern ?? this.concern;
    return computeStateHash({
      cells: serializedCells,
      dispositions: this.dispositions,
      development: (stagedDevelopment ?? this.development) as unknown as Record<string, unknown>,
      ...(Object.keys(concern).length > 0
        ? { concern: concern as unknown as Record<string, unknown> }
        : {}),
    });
  }

  /**
   * The ONE mutation path: hash the staged state, append the receipt
   * (fail-closed + fsynced), and only then swap the staged cells in. Every
   * state change in the Seed — transition, workspace, and later lobe deltas
   * and plasticity — commits through here or does not happen.
   */
  private commitReceipted(
    staged: Map<string, SituationCell>,
    record: {
      category: EventCategory;
      sourceAuthority: SourceAuthority;
      sourceRef: string;
      payload: Record<string, unknown>;
    },
    stagedDevelopment?: DevelopmentalState,
    stagedConcern?: ConcernState,
  ): { record: LedgerRecord; stateHashBefore: string; stateHashAfter: string } {
    const stateHashBefore = this.computeCurrentStateHash();
    const stateHashAfter = this.computeStateHashWithMany(staged, stagedDevelopment, stagedConcern);
    const rec = this.ledger.append({
      category: record.category,
      sourceAuthority: record.sourceAuthority,
      sourceRef: record.sourceRef,
      payload: record.payload,
      stateHashBefore,
      stateHashAfter,
    });
    for (const [id, cell] of staged) this.cells.set(id, cell);
    if (stagedDevelopment !== undefined) this.development = stagedDevelopment;
    if (stagedConcern !== undefined) this.concern = stagedConcern;
    return { record: rec, stateHashBefore, stateHashAfter };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractGenesis(ledger: SeedLedger): {
  seedId: string;
  reservoirSeed: number | undefined;
  anatomy: AnatomyCellSpec[] | undefined;
  name: string | undefined;
  selfFormation: boolean;
} {
  const all = ledger.readAll();
  const genesis = all.find((r) => r.category === 'genesis');
  const seedId = genesis?.payload?.['seedId'];
  const reservoirSeed = genesis?.payload?.['reservoirSeed'];
  const rawAnatomy = genesis?.payload?.['anatomy'];
  const name = genesis?.payload?.['name'];
  const selfFormation = genesis?.payload?.['selfFormation'] === true;
  let anatomy: AnatomyCellSpec[] | undefined;
  if (Array.isArray(rawAnatomy)) {
    const parsed = rawAnatomy.filter(
      (a): a is AnatomyCellSpec =>
        typeof a === 'object' && a !== null
        && typeof (a as AnatomyCellSpec).id === 'string'
        && ['correction', 'observation', 'consequence', 'interpretation', 'periphery'].includes((a as AnatomyCellSpec).role),
    );
    if (parsed.length > 0) anatomy = parsed;
  }
  return {
    seedId: typeof seedId === 'string' ? seedId : `seed_restored_${Date.now().toString(36)}`,
    reservoirSeed: typeof reservoirSeed === 'number' ? reservoirSeed : undefined,
    anatomy,
    name: typeof name === 'string' ? name : undefined,
    selfFormation,
  };
}

function estimateCellBytes(cell: SituationCell): number {
  // Continuous state bytes + rough JSON estimate for symbolic state
  const contBytes = cell.continuousState.byteLength;
  const symBytes = JSON.stringify({
    realityRefs: cell.realityRefs,
    estimates: cell.estimates,
    intentions: cell.intentions,
    predictions: cell.predictions,
  }).length;
  return contBytes + symBytes;
}
