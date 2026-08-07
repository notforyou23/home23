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
  routeEvent,
  applyMetabolicTransition,
  cloneCell,
  serializeCell,
  deserializeCell,
} from './cells.js';
import type { Reservoir } from './metabolism.js';
import { generateReservoir, eventDeltaSeconds, METABOLISM_VERSION } from './metabolism.js';
import { CONTINUOUS_STATE_DIM } from './types.js';
import { evaluateWorkspace } from './workspace.js';
import type { DevelopmentalState } from './plasticity.js';
import {
  emptyDevelopment,
  cloneDevelopment,
  applyCorrectionPlasticity,
  developmentMagnitude,
} from './plasticity.js';
import type { LobeAdapter, ValidatedLobeResult, RejectedProposal } from './lobe.js';
import { validateLobeResult, applyLobeDeltas } from './lobe.js';
import type { WorkspacePacket, ProposedStateDelta } from './types.js';

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
  private development: DevelopmentalState;
  private dispositions: SeedDispositions;
  private readonly stateDir: string;
  private readonly seedId: string;
  private readonly createdAt: string;
  private lastTransitionAt: string;
  private _transitionCount: number = 0;
  private _eventCount: number = 0;

  private constructor(opts: {
    stateDir: string;
    seedId: string;
    createdAt: string;
    cells: Map<string, SituationCell>;
    reservoir: Reservoir;
    development: DevelopmentalState;
    dispositions: SeedDispositions;
    ledger: SeedLedger;
    checkpoints: CheckpointManager;
    membrane: CapabilityMembrane;
    accounting: ResourceAccounting;
    eventCount: number;
    transitionCount: number;
  }) {
    this.stateDir = opts.stateDir;
    this.seedId = opts.seedId;
    this.createdAt = opts.createdAt;
    this.cells = opts.cells;
    this.reservoir = opts.reservoir;
    this.development = opts.development;
    this.dispositions = opts.dispositions;
    this.ledger = opts.ledger;
    this.checkpoints = opts.checkpoints;
    this.membrane = opts.membrane;
    this.accounting = opts.accounting;
    this._eventCount = opts.eventCount;
    this._transitionCount = opts.transitionCount;
    this.lastTransitionAt = opts.createdAt;
  }

  // ─── Factory methods ───────────────────────────────────────────────────────

  static initialize(
    stateDir: string,
    budget?: Partial<ResourceBudget>,
    opts?: { reservoirSeed?: number },
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

    const membrane = new CapabilityMembrane();
    const accounting = new ResourceAccounting(budget);
    const ledger = new SeedLedger(stateDir);
    const checkpoints = new CheckpointManager(stateDir);
    const cells = makeInitialCells(now);
    const dispositions = defaultDispositions();

    // Write GENESIS record — proves the ledger started fresh
    membrane.assert('local.ledger.append');
    ledger.append({
      category: 'genesis',
      sourceAuthority: 'seed.internal',
      sourceRef: seedId,
      payload: {
        seedId,
        cellIds: Array.from(cells.keys()),
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
      eventCount: 1,
      transitionCount: 0,
      reservoir,
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

    return new SeedProcess({
      stateDir,
      seedId: genesis.seedId,
      createdAt: manifest.createdAt,
      cells,
      reservoir: generateReservoir(genesis.reservoirSeed),
      // v1 manifests predate development — a pre-plasticity seed resumes with
      // an empty developmental state, not a broken restore.
      development: manifest.version >= 2
        ? ((manifest.development ?? {}) as DevelopmentalState)
        : emptyDevelopment(),
      dispositions: manifest.dispositions,
      ledger,
      checkpoints,
      membrane,
      accounting,
      eventCount: manifest.resourceSnapshot.eventCount,
      transitionCount: manifest.resourceSnapshot.transitionCount,
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
    // Route event to target cell (static + earned routing affinities)
    const cellId = routeEvent(event, Array.from(this.cells.keys()), this.development);
    const cell = this.cells.get(cellId);
    if (cell === undefined) {
      throw new Error(`Cell not found: ${cellId}`);
    }

    const dtSeconds = eventDeltaSeconds(cell.lastTransitionAt, event.producedAt);

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
    if (event.category === 'correction') {
      const stagedDev = cloneDevelopment(this.development);
      const committed = this.cells.get(cellId);
      if (committed !== undefined) {
        const summary = applyCorrectionPlasticity(stagedDev, committed, event, readouts);
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

    return { seq: record.seq, applied, rejected, validated };
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
    });
  }

  /** State hash as it would be with the staged replacements substituted — used
   * to compute a staged mutation's hash before it is committed. Cell iteration
   * order matches computeCurrentStateHash (Map insertion order). */
  private computeStateHashWithMany(
    replacements: Map<string, SituationCell>,
    stagedDevelopment?: DevelopmentalState,
  ): string {
    const serializedCells = Array.from(this.cells.entries()).map(([id, c]) =>
      serializeCell(replacements.get(id) ?? c),
    );
    return computeStateHash({
      cells: serializedCells,
      dispositions: this.dispositions,
      development: (stagedDevelopment ?? this.development) as unknown as Record<string, unknown>,
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
  ): { record: LedgerRecord; stateHashBefore: string; stateHashAfter: string } {
    const stateHashBefore = this.computeCurrentStateHash();
    const stateHashAfter = this.computeStateHashWithMany(staged, stagedDevelopment);
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
    return { record: rec, stateHashBefore, stateHashAfter };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractGenesis(ledger: SeedLedger): { seedId: string; reservoirSeed: number | undefined } {
  const all = ledger.readAll();
  const genesis = all.find((r) => r.category === 'genesis');
  const seedId = genesis?.payload?.['seedId'];
  const reservoirSeed = genesis?.payload?.['reservoirSeed'];
  return {
    seedId: typeof seedId === 'string' ? seedId : `seed_restored_${Date.now().toString(36)}`,
    reservoirSeed: typeof reservoirSeed === 'number' ? reservoirSeed : undefined,
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
