/**
 * Resource accounting for the Seed process.
 *
 * Tracks: state bytes per cell, ledger bytes, event count, transition count,
 * checkpoint count. Throws ResourceBudgetExceededError when any ceiling is hit.
 * The ceiling check runs before the operation — budget violations are fail-closed.
 */

import type { ResourceBudget, ResourceSnapshot } from './types.js';
import { ResourceBudgetExceededError, DEFAULT_RESOURCE_BUDGET } from './types.js';

export class ResourceAccounting {
  private readonly budget: ResourceBudget;
  private stateBytesPerCell: Record<string, number> = {};
  private _ledgerBytes: number = 0;
  private _eventCount: number = 0;
  private _transitionCount: number = 0;
  private _checkpointCount: number = 0;

  constructor(budget?: Partial<ResourceBudget>) {
    this.budget = { ...DEFAULT_RESOURCE_BUDGET, ...budget };
  }

  // ─── Ceiling checks ────────────────────────────────────────────────────────

  assertEventBudget(): void {
    if (this._eventCount >= this.budget.maxEventCount) {
      throw new ResourceBudgetExceededError('eventCount', this._eventCount, this.budget.maxEventCount);
    }
  }

  assertTransitionBudget(): void {
    if (this._transitionCount >= this.budget.maxTransitionCount) {
      throw new ResourceBudgetExceededError('transitionCount', this._transitionCount, this.budget.maxTransitionCount);
    }
  }

  assertCheckpointBudget(): void {
    if (this._checkpointCount >= this.budget.maxCheckpointCount) {
      throw new ResourceBudgetExceededError('checkpointCount', this._checkpointCount, this.budget.maxCheckpointCount);
    }
  }

  assertLedgerBudget(additionalBytes: number): void {
    const projected = this._ledgerBytes + additionalBytes;
    if (projected > this.budget.maxLedgerBytes) {
      throw new ResourceBudgetExceededError('ledgerBytes', projected, this.budget.maxLedgerBytes);
    }
  }

  assertCellStateBudget(cellId: string, bytes: number): void {
    if (bytes > this.budget.maxStateBytesPerCell) {
      throw new ResourceBudgetExceededError(`stateBytesPerCell[${cellId}]`, bytes, this.budget.maxStateBytesPerCell);
    }
  }

  // ─── Accumulators ─────────────────────────────────────────────────────────

  recordEvent(): void { this._eventCount++; }
  recordTransition(): void { this._transitionCount++; }
  recordCheckpoint(): void { this._checkpointCount++; }
  setLedgerBytes(bytes: number): void { this._ledgerBytes = bytes; }
  setCellStateBytes(cellId: string, bytes: number): void { this.stateBytesPerCell[cellId] = bytes; }

  // ─── Snapshot ─────────────────────────────────────────────────────────────

  snapshot(): ResourceSnapshot {
    return {
      stateBytesPerCell: { ...this.stateBytesPerCell },
      ledgerBytes: this._ledgerBytes,
      eventCount: this._eventCount,
      transitionCount: this._transitionCount,
      checkpointCount: this._checkpointCount,
    };
  }

  restoreFromSnapshot(snap: ResourceSnapshot): void {
    this.stateBytesPerCell = { ...snap.stateBytesPerCell };
    this._ledgerBytes = snap.ledgerBytes;
    this._eventCount = snap.eventCount;
    this._transitionCount = snap.transitionCount;
    this._checkpointCount = snap.checkpointCount;
  }

  get eventCount(): number { return this._eventCount; }
  get transitionCount(): number { return this._transitionCount; }
  get checkpointCount(): number { return this._checkpointCount; }
  get ledgerBytes(): number { return this._ledgerBytes; }
}
