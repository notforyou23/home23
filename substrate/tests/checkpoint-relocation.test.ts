import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CheckpointManager, computeStateHash } from '../src/checkpoint.js';
import { makeInitialCells, serializeCell } from '../src/cells.js';
import type { CheckpointManifest, SeedDispositions } from '../src/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'checkpoint-relocation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const destination = join(root, 'destination');
  return { root, source, destination, manager: new CheckpointManager(source) };
}

const dispositions: SeedDispositions = {
  globalWakeThreshold: 0.3,
  silencePolicy: 'default',
  modelRecruitmentPolicy: 'none',
  quietTimeEnabled: false,
};

function checkpoint(manager: CheckpointManager, generation: number): string {
  const cells = Array.from(makeInitialCells('2026-09-23T12:00:00.000Z').values()).map(serializeCell);
  const world = cells.find((cell) => cell.id === 'world.home23');
  assert.ok(world);
  world.generation = generation;
  return manager.write({
    stateHash: computeStateHash({ cells, dispositions }),
    ledgerSeq: generation + 1,
    ledgerCursor: `cursor-${generation}`,
    cells,
    dispositions,
    resourceSnapshot: { stateBytesPerCell: {}, ledgerBytes: 0, eventCount: 0, transitionCount: 0, checkpointCount: 0 },
  });
}

function relocate(source: string, destination: string): void {
  cpSync(source, destination, { recursive: true });
  const indexPath = join(destination, 'checkpoints', 'CHECKPOINT_INDEX.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  for (const entry of index.checkpoints) {
    entry.path = join(source, 'checkpoints', `${entry.checkpointId}.json`);
  }
  writeFileSync(indexPath, JSON.stringify(index));
}

function manifestPath(stateDir: string, id: string): string {
  return join(stateDir, 'checkpoints', `${id}.json`);
}

test('source-present relocation restores destination checkpoint rather than old source', (t) => {
  const { source, destination, manager } = fixture(t);
  const id = checkpoint(manager, 1);
  relocate(source, destination);
  const localPath = manifestPath(destination, id);
  const local = JSON.parse(readFileSync(localPath, 'utf8')) as CheckpointManifest;
  const world = local.cells.find((cell) => cell.id === 'world.home23');
  assert.ok(world);
  world.generation = 77;
  local.stateHash = computeStateHash({ cells: local.cells, dispositions: local.dispositions });
  writeFileSync(localPath, JSON.stringify(local));
  const sourceBytes = readFileSync(manifestPath(source, id));

  const restored = new CheckpointManager(destination).restore(id);
  assert.equal(restored.cells.find((cell) => cell.id === 'world.home23')?.generation, 77);
  assert.deepEqual(readFileSync(manifestPath(source, id)), sourceBytes);
});

test('source-absent relocation still restores copied local checkpoint', (t) => {
  const { source, destination, manager } = fixture(t);
  const id = checkpoint(manager, 4);
  relocate(source, destination);
  rmSync(source, { recursive: true });
  assert.equal(new CheckpointManager(destination).restore().checkpointId, id);
});

test('missing destination manifest cannot fall back to a surviving source', (t) => {
  const { source, destination, manager } = fixture(t);
  const id = checkpoint(manager, 5);
  relocate(source, destination);
  const sourceBytes = readFileSync(manifestPath(source, id));
  rmSync(manifestPath(destination, id));

  assert.throws(() => new CheckpointManager(destination).restore(id), /not found or corrupt/);
  assert.deepEqual(readFileSync(manifestPath(source, id)), sourceBytes);
  assert.ok(existsSync(manifestPath(source, id)));
});

test('tampered destination quarantines locally and falls back to older local checkpoint', (t) => {
  const { source, destination, manager } = fixture(t);
  const older = checkpoint(manager, 10);
  const newer = checkpoint(manager, 20);
  relocate(source, destination);
  const sourceBytes = readFileSync(manifestPath(source, newer));
  writeFileSync(manifestPath(destination, newer), '{invalid JSON');

  const restored = new CheckpointManager(destination).restore();
  assert.equal(restored.checkpointId, older);
  assert.deepEqual(readFileSync(manifestPath(source, newer)), sourceBytes);
  assert.ok(existsSync(manifestPath(source, newer)));
  assert.ok(readdirSync(join(destination, 'checkpoints', 'quarantine')).some((name) => name.startsWith(`${newer}_`) && name.endsWith('.json')));
});

test('destination symlink to source manifest is rejected without touching source', (t) => {
  const { source, destination, manager } = fixture(t);
  const id = checkpoint(manager, 30);
  relocate(source, destination);
  const sourceBytes = readFileSync(manifestPath(source, id));
  rmSync(manifestPath(destination, id));
  symlinkSync(manifestPath(source, id), manifestPath(destination, id));

  assert.throws(() => new CheckpointManager(destination).restore(id), /not found or corrupt/);
  assert.deepEqual(readFileSync(manifestPath(source, id)), sourceBytes);
  assert.ok(existsSync(manifestPath(source, id)));
});

test('malformed index path and traversal ID cannot escape destination; local stray remains usable', (t) => {
  const { source, destination, manager } = fixture(t);
  const id = checkpoint(manager, 40);
  relocate(source, destination);
  const indexPath = join(destination, 'checkpoints', 'CHECKPOINT_INDEX.json');
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  index.checkpoints[0].path = '../../source/checkpoints/other.json';
  index.checkpoints.push({ ...index.checkpoints[0], checkpointId: 'ckpt_../../source', path: manifestPath(source, id) });
  writeFileSync(indexPath, JSON.stringify(index));

  assert.equal(new CheckpointManager(destination).restore().checkpointId, id);
  assert.throws(() => new CheckpointManager(destination).restore('ckpt_../../source'), /Invalid checkpoint ID/);
});
