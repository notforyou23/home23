/**
 * CheckpointManager — atomic checkpoint writes with quarantine on corruption.
 *
 * Each checkpoint is a standalone JSON file. An index tracks all checkpoints.
 * Corrupt candidates are quarantined, not repaired in place. Restore tries
 * newest-first and moves bad files to quarantine/.
 *
 * Invariant: after restore(), the SeedProcess state is exactly the state that
 * was captured at checkpoint() time — including Float32Array bytes and ledger
 * cursor. No prose reconstruction.
 */

import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  renameSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CheckpointManifest,
  CheckpointIndex,
  SerializedCell,
  SeedDispositions,
  ResourceSnapshot,
} from './types.js';

const CHECKPOINTS_DIR = 'checkpoints';
const QUARANTINE_DIR = 'quarantine';
const INDEX_FILE = 'CHECKPOINT_INDEX.json';

/** Atomic write: write to .tmp then rename. Throws on any failure. */
function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp-${randomUUID().slice(0, 8)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

export class CheckpointManager {
  private readonly checkpointsDir: string;
  private readonly quarantineDir: string;
  private readonly indexPath: string;

  constructor(stateDir: string) {
    this.checkpointsDir = join(stateDir, CHECKPOINTS_DIR);
    this.quarantineDir = join(stateDir, CHECKPOINTS_DIR, QUARANTINE_DIR);
    this.indexPath = join(this.checkpointsDir, INDEX_FILE);
    mkdirSync(this.checkpointsDir, { recursive: true });
    mkdirSync(this.quarantineDir, { recursive: true });
  }

  /**
   * Write a checkpoint. Returns the checkpointId.
   * Throws on write failure — never writes a partial checkpoint.
   */
  write(opts: {
    stateHash: string;
    ledgerSeq: number;
    ledgerCursor: string;
    cells: SerializedCell[];
    dispositions: SeedDispositions;
    resourceSnapshot: ResourceSnapshot;
  }): string {
    const checkpointId = `ckpt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const manifest: CheckpointManifest = {
      schema: 'home23.seed.checkpoint.v1',
      version: 1,
      checkpointId,
      stateHash: opts.stateHash,
      ledgerSeq: opts.ledgerSeq,
      ledgerCursor: opts.ledgerCursor,
      createdAt: new Date().toISOString(),
      resourceSnapshot: opts.resourceSnapshot,
      cells: opts.cells,
      dispositions: opts.dispositions,
    };

    const filePath = join(this.checkpointsDir, `${checkpointId}.json`);
    atomicWriteJson(filePath, manifest);

    // Update index atomically
    const index = this.readIndex();
    index.checkpoints.push({
      checkpointId,
      stateHash: opts.stateHash,
      ledgerSeq: opts.ledgerSeq,
      createdAt: manifest.createdAt,
      path: filePath,
    });
    atomicWriteJson(this.indexPath, index);

    return checkpointId;
  }

  /**
   * Restore the checkpoint with the given id, or the most recent valid one
   * if no id is specified. Quarantines corrupt candidates, tries newest-first.
   * Returns the CheckpointManifest or throws if no valid checkpoint exists.
   */
  restore(checkpointId?: string): CheckpointManifest {
    const index = this.readIndex();
    const candidates = checkpointId
      ? index.checkpoints.filter((c) => c.checkpointId === checkpointId)
      : [...index.checkpoints].reverse(); // newest-first

    for (const entry of candidates) {
      const result = this.tryReadManifest(entry.path, entry.checkpointId);
      if (result.ok && result.manifest !== undefined) {
        return result.manifest;
      }
      // Quarantine corrupt candidate
      this.quarantine(entry.path, entry.checkpointId, result.reason ?? 'unknown');
      // Remove from index
      const idx = index.checkpoints.findIndex((c) => c.checkpointId === entry.checkpointId);
      if (idx >= 0) index.checkpoints.splice(idx, 1);
      atomicWriteJson(this.indexPath, index);
    }

    throw new Error(
      checkpointId
        ? `Checkpoint ${checkpointId} not found or corrupt (quarantined)`
        : 'No valid checkpoint found — all candidates exhausted or quarantined',
    );
  }

  /** List all checkpoint entries in the index, newest-first. */
  list(): CheckpointIndex['checkpoints'] {
    return [...this.readIndex().checkpoints].reverse();
  }

  /** Number of checkpoints in the index. */
  get count(): number {
    return this.readIndex().checkpoints.length;
  }

  // ─── Internal ─────────────────────────────────────────────────────────────

  private readIndex(): CheckpointIndex {
    if (!existsSync(this.indexPath)) {
      return { schema: 'home23.seed.checkpoint-index.v1', checkpoints: [] };
    }
    try {
      return JSON.parse(readFileSync(this.indexPath, 'utf-8')) as CheckpointIndex;
    } catch {
      return { schema: 'home23.seed.checkpoint-index.v1', checkpoints: [] };
    }
  }

  private tryReadManifest(
    filePath: string,
    checkpointId: string,
  ): { ok: true; manifest: CheckpointManifest } | { ok: false; manifest?: undefined; reason: string } {
    if (!existsSync(filePath)) {
      return { ok: false, reason: 'file missing' };
    }
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      return { ok: false, reason: `read error: ${String(err)}` };
    }
    let manifest: CheckpointManifest;
    try {
      manifest = JSON.parse(raw) as CheckpointManifest;
    } catch {
      return { ok: false, reason: 'invalid JSON' };
    }
    if (manifest.schema !== 'home23.seed.checkpoint.v1') {
      return { ok: false, reason: `wrong schema: ${manifest.schema}` };
    }
    if (manifest.checkpointId !== checkpointId) {
      return { ok: false, reason: `checkpointId mismatch: ${manifest.checkpointId}` };
    }
    // Validate stateHash consistency: recompute from cells + dispositions (no ledgerSeq in hash)
    const computedHash = computeStateHash({
      cells: manifest.cells,
      dispositions: manifest.dispositions,
    });
    if (computedHash !== manifest.stateHash) {
      return { ok: false, reason: `stateHash mismatch: stored=${manifest.stateHash.slice(0, 16)}, computed=${computedHash.slice(0, 16)}` };
    }
    return { ok: true, manifest };
  }

  private quarantine(filePath: string, checkpointId: string, reason: string): void {
    const destName = `${checkpointId}_${Date.now()}.json`;
    const destPath = join(this.quarantineDir, destName);
    const reasonPath = join(this.quarantineDir, `${checkpointId}_${Date.now()}.reason`);
    try {
      if (existsSync(filePath)) renameSync(filePath, destPath);
      writeFileSync(reasonPath, reason, 'utf-8');
    } catch {
      // Best-effort quarantine; the important thing is it's not used for restore
    }
  }
}

/**
 * Compute the canonical state hash from cells and dispositions.
 *
 * Intentionally excludes ledgerSeq: the state hash tracks CELL STATE only.
 * Ledger position is captured separately in the checkpoint (ledgerSeq + ledgerCursor).
 * This ensures the same cell state produces the same hash regardless of how many
 * bookkeeping records (checkpoint, stop) were written to the ledger.
 */
export function computeStateHash(opts: {
  cells: SerializedCell[];
  dispositions: SeedDispositions;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cells: opts.cells.map((c) => ({
          id: c.id,
          generation: c.generation,
          continuousState: c.continuousState,
        })),
        dispositions: opts.dispositions,
      }),
      'utf-8',
    )
    .digest('hex');
}
