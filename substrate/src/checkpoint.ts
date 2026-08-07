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
  statSync,
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
    development?: Record<string, unknown>;
  }): string {
    const checkpointId = `ckpt_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const manifest: CheckpointManifest = {
      schema: 'home23.seed.checkpoint.v1',
      version: opts.development !== undefined ? 2 : 1,
      checkpointId,
      stateHash: opts.stateHash,
      ledgerSeq: opts.ledgerSeq,
      ledgerCursor: opts.ledgerCursor,
      createdAt: new Date().toISOString(),
      resourceSnapshot: opts.resourceSnapshot,
      cells: opts.cells,
      dispositions: opts.dispositions,
      ...(opts.development !== undefined ? { development: opts.development } : {}),
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
    const indexEntries = checkpointId
      ? index.checkpoints.filter((c) => c.checkpointId === checkpointId)
      : [...index.checkpoints].reverse(); // newest-first
    const candidates: Array<{ checkpointId: string; path: string }> = indexEntries.map(
      (c) => ({ checkpointId: c.checkpointId, path: c.path }),
    );

    // Fallback: a lost or corrupt index must not orphan valid checkpoints on
    // disk. Manifests the index does not know about are tried after the index
    // entries, newest-first; tryReadManifest still validates id + stateHash.
    const known = new Set(candidates.map((c) => c.path));
    for (const stray of this.scanCheckpointFiles()) {
      if (known.has(stray.path)) continue;
      if (checkpointId !== undefined && stray.checkpointId !== checkpointId) continue;
      candidates.push(stray);
    }

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

  /** Checkpoint manifests present on disk, newest-first by mtime. Quarantine
   * and the index file never match the ckpt_*.json filter. */
  private scanCheckpointFiles(): Array<{ checkpointId: string; path: string }> {
    let names: string[];
    try {
      names = readdirSync(this.checkpointsDir);
    } catch {
      return [];
    }
    return names
      .filter((n) => n.startsWith('ckpt_') && n.endsWith('.json'))
      .map((n) => {
        const path = join(this.checkpointsDir, n);
        let mtimeMs = 0;
        try { mtimeMs = statSync(path).mtimeMs; } catch { /* vanished mid-scan */ }
        return { checkpointId: n.slice(0, -'.json'.length), path, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ checkpointId, path }) => ({ checkpointId, path }));
  }

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
      // v1 manifests predate development; their hashes must recompute the
      // v1 way or every pre-plasticity seed becomes unrestorable.
      ...(manifest.version >= 2 ? { development: manifest.development ?? {} } : {}),
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
 * Covers the ENTIRE causal cell state — symbolic and continuous. A checkpoint
 * whose intentions, estimates, associations, or lineage were altered must fail
 * validation, and later, sanctioned ablation must be distinguishable from
 * corruption by exactly this hash. Field order is explicit-by-construction
 * (the ledger's canonicalization convention); nested payloads must likewise be
 * built with deterministic key order.
 *
 * Intentionally excluded:
 *   - ledgerSeq/cursor — ledger position is bound separately in the manifest,
 *     so bookkeeping records (checkpoint, stop) don't move the state hash.
 *
 * Since Cut 2, transitions run on EVENT-time (`producedAt` deltas), so
 * `lastTransitionAt` and `energy.lastSpikeAt` are causal, replay-reproducible
 * state and are INSIDE the hash. The one wall-clock stamp a cell carries is
 * its birth time (initialize), which is part of the seed's identity.
 */
export function computeStateHash(opts: {
  cells: SerializedCell[];
  dispositions: SeedDispositions;
  /** Cut 3: developmental state enters the hash (v2). Omit entirely for v1
   * compatibility recomputes — an empty object is NOT the same as absent. */
  development?: Record<string, unknown>;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        cells: opts.cells.map((c) => ({
          id: c.id,
          generation: c.generation,
          status: c.status,
          realityRefs: c.realityRefs,
          estimates: c.estimates,
          intentions: c.intentions,
          predictions: c.predictions,
          continuousState: c.continuousState,
          continuousStateDimension: c.continuousStateDimension,
          dispositions: c.dispositions,
          associations: c.associations,
          lobeAffinities: c.lobeAffinities,
          workspacePressure: c.workspacePressure,
          interruptionPressure: c.interruptionPressure,
          uncertainty: c.uncertainty,
          energy: { current: c.energy.current, peak: c.energy.peak, lastSpikeAt: c.energy.lastSpikeAt ?? null },
          developmentalLineage: c.developmentalLineage,
          lastTransitionAt: c.lastTransitionAt,
        })),
        dispositions: opts.dispositions,
        ...(opts.development !== undefined ? { development: opts.development } : {}),
      }),
      'utf-8',
    )
    .digest('hex');
}
