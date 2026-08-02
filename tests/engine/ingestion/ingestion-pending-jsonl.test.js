import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  IngestionManifest,
  isIngestionInternalFile,
} = require('../../../engine/src/ingestion/ingestion-manifest.js');

// The pending queue persisted as ONE JSON.stringify(array, null, 2) — at
// 221MB it hit "Invalid string length" (V8 ~536MB string ceiling, inflated
// ~40% by pretty-printing), the disk copy went silently stale, and a restart
// in that window would have lost queued chunks. These tests pin the cure:
// JSONL persistence, streamed reads, atomic writes, legacy migration.

function makeManifest(runPath) {
  return new IngestionManifest({
    runPath,
    memory: {},
    embeddingFn: async () => null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

function item(i) {
  return { filePath: `/docs/file-${i}.md`, chunkIndex: i, totalChunks: 3, content: `chunk content ${i}` };
}

test('pending queue persists in the append-only journal, no legacy json rewrite left behind', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-pending-jsonl-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const m = makeManifest(runPath);
  m._pending = [item(0), item(1), item(2)];
  m._savePending();

  const jsonlPath = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  assert.ok(fs.existsSync(jsonlPath), 'append-only events journal must exist');
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
  assert.equal(lines.filter((line) => JSON.parse(line).type === 'item').length, 3,
    'one compact item record per queued item');
  for (const line of lines) JSON.parse(line); // every line independently parseable
  assert.equal(fs.existsSync(path.join(runPath, 'ingestion-pending.json')), false,
    'legacy single-string file must not be written');
  assert.equal(fs.existsSync(`${jsonlPath}.tmp`), false, 'atomic write leaves no tmp file');
});

test('pending queue round-trips through a fresh instance', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-pending-roundtrip-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const first = makeManifest(runPath);
  first._pending = [item(0), item(1)];
  first._savePending();

  const second = makeManifest(runPath);
  assert.equal(second._pending.length, 2);
  assert.deepEqual(second._pending.map((p) => p.filePath), ['/docs/file-0.md', '/docs/file-1.md']);
});

test('legacy ingestion-pending.json migrates to JSONL on load and is removed', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-pending-migrate-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const legacyPath = path.join(runPath, 'ingestion-pending.json');
  fs.writeFileSync(legacyPath, JSON.stringify([item(0), item(1), item(2)], null, 2));

  const m = makeManifest(runPath);
  assert.equal(m._pending.length, 3, 'legacy items loaded');
  assert.ok(fs.existsSync(path.join(runPath, 'ingestion-pending.jsonl')), 'migrated to jsonl');
  assert.equal(fs.existsSync(legacyPath), false, 'legacy file removed after migration');

  const reread = makeManifest(runPath);
  assert.equal(reread._pending.length, 3, 'post-migration load reads jsonl');
});

test('a corrupt line is skipped loudly, valid lines survive', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-pending-corrupt-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  fs.writeFileSync(jsonlPath, `${JSON.stringify(item(0))}\nNOT JSON AT ALL\n${JSON.stringify(item(2))}\n`);
  const warnings = [];
  const m = new IngestionManifest({
    runPath, memory: {}, embeddingFn: async () => null, config: {},
    logger: { info() {}, warn: (...a) => warnings.push(a), error: (...a) => warnings.push(a), debug() {} },
  });
  assert.equal(m._pending.length, 2, 'valid items survive');
  assert.ok(warnings.length >= 1, 'corruption must be reported, not swallowed');
});

test('the feeder ignore-list covers both queue filenames (old and new)', () => {
  assert.equal(isIngestionInternalFile('ingestion-manifest.json'), true);
  assert.equal(isIngestionInternalFile('ingestion-manifest.json.tmp'), true);
  assert.equal(isIngestionInternalFile('state.json.tmp'), true);
  assert.equal(isIngestionInternalFile('ingestion-pending.json'), true);
  assert.equal(isIngestionInternalFile('ingestion-pending.jsonl'), true,
    'the feeder must never ingest its own queue file');
  assert.equal(isIngestionInternalFile('real-document.md'), false);
});
