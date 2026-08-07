import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager, computeStateHash } from '../src/checkpoint.js';
import { makeInitialCells, serializeCell } from '../src/cells.js';
import type { SeedDispositions } from '../src/types.js';

function makeDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'substrate-checkpoint-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDispositions(): SeedDispositions {
  return {
    globalWakeThreshold: 0.3,
    silencePolicy: 'default',
    modelRecruitmentPolicy: 'none',
    quietTimeEnabled: false,
  };
}

function makeSnapshot() {
  return {
    stateBytesPerCell: {},
    ledgerBytes: 256,
    eventCount: 1,
    transitionCount: 0,
    checkpointCount: 0,
  };
}

test('write and restore: exact state hash, ledgerSeq, ledgerCursor match', (t) => {
  const dir = makeDir(t);
  const mgr = new CheckpointManager(dir);

  const now = new Date().toISOString();
  const cells = makeInitialCells(now);
  const serializedCells = Array.from(cells.values()).map(serializeCell);
  const dispositions = makeDispositions();
  const ledgerSeq = 3;
  const ledgerCursor = 'abc123def456abc123def456abc123def456abc123def456abc123def456abc1';
  const stateHash = computeStateHash({ cells: serializedCells, dispositions });

  const id = mgr.write({
    stateHash,
    ledgerSeq,
    ledgerCursor,
    cells: serializedCells,
    dispositions,
    resourceSnapshot: makeSnapshot(),
  });

  const restored = mgr.restore(id);
  assert.equal(restored.stateHash, stateHash);
  assert.equal(restored.ledgerSeq, ledgerSeq);
  assert.equal(restored.ledgerCursor, ledgerCursor);
  assert.equal(restored.checkpointId, id);
  assert.equal(restored.schema, 'home23.seed.checkpoint.v1');
});

test('exact Float32Array bytes survive checkpoint round-trip', (t) => {
  const dir = makeDir(t);
  const mgr = new CheckpointManager(dir);

  const now = new Date().toISOString();
  const cells = makeInitialCells(now);

  // Write known values into one cell's Float32Array
  const cell = cells.get('contact.jtr-jerry')!;
  cell.continuousState[0] = 0.123456;
  cell.continuousState[7] = -0.987654;
  cell.continuousState[63] = 0.5;

  const serializedCells = Array.from(cells.values()).map(serializeCell);
  const dispositions = makeDispositions();
  const stateHash = computeStateHash({ cells: serializedCells, dispositions });

  const id = mgr.write({
    stateHash,
    ledgerSeq: 1,
    ledgerCursor: 'cursor001',
    cells: serializedCells,
    dispositions,
    resourceSnapshot: makeSnapshot(),
  });

  const restored = mgr.restore(id);
  const restoredCell = restored.cells.find((c) => c.id === 'contact.jtr-jerry');
  assert.ok(restoredCell !== undefined);

  // Deserialize and check exact Float32 bytes
  const buf = Buffer.from(restoredCell.continuousState, 'base64');
  const arr = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

  // Float32 representation: Math.fround gives the float32-precision value
  assert.ok(Math.abs((arr[0] ?? 0) - Math.fround(0.123456)) < 1e-7, 'slot 0 mismatch');
  assert.ok(Math.abs((arr[7] ?? 0) - Math.fround(-0.987654)) < 1e-7, 'slot 7 mismatch');
  assert.ok(Math.abs((arr[63] ?? 0) - Math.fround(0.5)) < 1e-7, 'slot 63 mismatch');
});

test('corrupt checkpoint is quarantined; fallback to previous valid one', (t) => {
  const dir = makeDir(t);
  const mgr = new CheckpointManager(dir);

  const now = new Date().toISOString();
  const cells = makeInitialCells(now);
  const serializedCells = Array.from(cells.values()).map(serializeCell);
  const dispositions = makeDispositions();

  // Write two checkpoints
  const id1 = mgr.write({
    stateHash: computeStateHash({ cells: serializedCells, dispositions }),
    ledgerSeq: 1,
    ledgerCursor: 'cursor1',
    cells: serializedCells,
    dispositions,
    resourceSnapshot: makeSnapshot(),
  });
  const id2 = mgr.write({
    stateHash: computeStateHash({ cells: serializedCells, dispositions }),
    ledgerSeq: 2,
    ledgerCursor: 'cursor2',
    cells: serializedCells,
    dispositions,
    resourceSnapshot: { ...makeSnapshot(), eventCount: 2 },
  });

  // Corrupt the newest checkpoint file
  const id2Path = join(dir, 'checkpoints', `${id2}.json`);
  writeFileSync(id2Path, '{"corrupted": true, "schema": "wrong"}', 'utf-8');

  // restore() should quarantine id2 and fall back to id1
  const restored = mgr.restore();
  assert.equal(restored.checkpointId, id1);
  assert.equal(restored.ledgerSeq, 1);
});

test('restore by specific checkpointId', (t) => {
  const dir = makeDir(t);
  const mgr = new CheckpointManager(dir);

  const now = new Date().toISOString();
  const cells = makeInitialCells(now);
  const sc = Array.from(cells.values()).map(serializeCell);
  const dispositions = makeDispositions();
  const stateHash = computeStateHash({ cells: sc, dispositions });

  const id1 = mgr.write({ stateHash, ledgerSeq: 1, ledgerCursor: 'c1', cells: sc, dispositions, resourceSnapshot: makeSnapshot() });
  mgr.write({ stateHash, ledgerSeq: 2, ledgerCursor: 'c2', cells: sc, dispositions, resourceSnapshot: makeSnapshot() });

  // Explicitly restore id1 even though id2 exists
  const restored = mgr.restore(id1);
  assert.equal(restored.checkpointId, id1);
  assert.equal(restored.ledgerSeq, 1);
});

test('no valid checkpoint throws', (t) => {
  const dir = makeDir(t);
  const mgr = new CheckpointManager(dir);
  assert.throws(
    () => mgr.restore(),
    (err) => err instanceof Error && err.message.includes('No valid checkpoint'),
  );
});

test('count tracks number of written checkpoints', (t) => {
  const dir = makeDir(t);
  const mgr = new CheckpointManager(dir);
  assert.equal(mgr.count, 0);

  const now = new Date().toISOString();
  const cells = makeInitialCells(now);
  const sc = Array.from(cells.values()).map(serializeCell);
  const dispositions = makeDispositions();
  const stateHash = computeStateHash({ cells: sc, dispositions });

  mgr.write({ stateHash, ledgerSeq: 1, ledgerCursor: 'c1', cells: sc, dispositions, resourceSnapshot: makeSnapshot() });
  assert.equal(mgr.count, 1);

  mgr.write({ stateHash, ledgerSeq: 2, ledgerCursor: 'c2', cells: sc, dispositions, resourceSnapshot: makeSnapshot() });
  assert.equal(mgr.count, 2);
});
