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
import type {
  SituationCell,
  SeedState,
  SeedDispositions,
  SourceEvent,
  LedgerRecord,
  TransitionResult,
  ResourceBudget,
} from './types.js';
import { CapabilityDeniedError } from './types.js';
import { SeedLedger } from './ledger.js';
import { CheckpointManager, computeStateHash } from './checkpoint.js';
import { CapabilityMembrane } from './membrane.js';
import { ResourceAccounting } from './resource.js';
import {
  makeInitialCells,
  routeEvent,
  applyTransition,
  cloneCell,
  serializeCell,
  deserializeCell,
} from './cells.js';

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

  static initialize(stateDir: string, budget?: Partial<ResourceBudget>): SeedProcess {
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
        continuousStateDim: 64,
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

    return new SeedProcess({
      stateDir,
      seedId: extractSeedId(ledger),
      createdAt: manifest.createdAt,
      cells,
      dispositions: manifest.dispositions,
      ledger,
      checkpoints,
      membrane,
      accounting,
      eventCount: manifest.resourceSnapshot.eventCount,
      transitionCount: manifest.resourceSnapshot.transitionCount,
    });
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
   * Ingest + apply one deterministic cell transition.
   * Proof of Cut 1: the state and cursor advance causally from the previous state.
   */
  transition(event: SourceEvent): TransitionResult {
    this.membrane.assert('local.source.ingest');
    this.membrane.assert('local.state.write');
    this.membrane.assert('local.ledger.append');
    this.accounting.assertEventBudget();
    this.accounting.assertTransitionBudget();

    const now = new Date().toISOString();
    const stateHashBefore = this.computeCurrentStateHash();

    // Route event to target cell
    const cellId = routeEvent(event, Array.from(this.cells.keys()));
    const cell = this.cells.get(cellId);
    if (cell === undefined) {
      throw new Error(`Cell not found: ${cellId}`);
    }

    // Stage the transition on a copy: developmental mutation must not proceed
    // if the receipt cannot be committed, so the receipt is appended (and
    // fsynced) BEFORE the staged state replaces the live state. A failed append
    // throws here and discards the staged copy — the Seed remains exactly the
    // state its ledger can account for.
    const staged = cloneCell(cell);
    applyTransition(staged, event, now);
    const stateHashAfter = this.computeStateHashWith(cellId, staged);

    const record = this.ledger.append({
      category: 'transition',
      sourceAuthority: event.sourceAuthority,
      sourceRef: event.sourceRef,
      payload: {
        eventId: event.eventId,
        targetCellId: cellId,
        producedAt: event.producedAt,
        originalCategory: event.category,
      },
      stateHashBefore,
      stateHashAfter,
    });

    // Receipt is durable — commit the staged state.
    this.cells.set(cellId, staged);
    this.lastTransitionAt = now;
    this._transitionCount++;
    this._eventCount++;

    this.accounting.recordEvent();
    this.accounting.recordTransition();
    this.accounting.setLedgerBytes(this.ledger.bytes);
    this.accounting.setCellStateBytes(cellId, estimateCellBytes(staged));

    return {
      seq: record.seq,
      stateHashBefore,
      stateHashAfter,
      ledgerCursor: this.ledger.currentCursor,
      cellId,
      elapsedMs: Date.now() - new Date(now).getTime(),
    };
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
      dispositions: this.dispositions,
      stateHash: this.computeCurrentStateHash(),
      ledgerSeq: this.ledger.currentSeq,
      ledgerCursor: this.ledger.currentCursor,
      createdAt: this.createdAt,
      lastTransitionAt: this.lastTransitionAt,
      transitionCount: this._transitionCount,
      eventCount: this._eventCount,
    };
  }

  /** Access a cell's continuous Float32Array directly (for inspection and tests). */
  getContinuousState(cellId: string): Float32Array | undefined {
    this.membrane.assert('local.state.read');
    return this.cells.get(cellId)?.continuousState;
  }

  /** Access a cell's full state (for inspection). */
  getCell(cellId: string): Readonly<SituationCell> | undefined {
    this.membrane.assert('local.state.read');
    return this.cells.get(cellId);
  }

  /** Expose the membrane for assertion tests. */
  get mem(): CapabilityMembrane { return this.membrane; }

  /** Resource snapshot for inspection. */
  resourceSnapshot() { return this.accounting.snapshot(); }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private computeCurrentStateHash(): string {
    const serializedCells = Array.from(this.cells.values()).map(serializeCell);
    return computeStateHash({ cells: serializedCells, dispositions: this.dispositions });
  }

  /** State hash as it would be with `replacement` substituted for cellId — used
   * to compute a staged transition's hash before the state is committed. Cell
   * iteration order matches computeCurrentStateHash (Map insertion order). */
  private computeStateHashWith(cellId: string, replacement: SituationCell): string {
    const serializedCells = Array.from(this.cells.entries()).map(([id, c]) =>
      serializeCell(id === cellId ? replacement : c),
    );
    return computeStateHash({ cells: serializedCells, dispositions: this.dispositions });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractSeedId(ledger: SeedLedger): string {
  const all = ledger.readAll();
  const genesis = all.find((r) => r.category === 'genesis');
  const seedId = genesis?.payload?.['seedId'];
  return typeof seedId === 'string' ? seedId : `seed_restored_${Date.now().toString(36)}`;
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
