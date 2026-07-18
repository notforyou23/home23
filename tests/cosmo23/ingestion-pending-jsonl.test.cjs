'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  IngestionManifest,
  isIngestionInternalFile,
} = require('../../cosmo23/engine/src/ingestion/ingestion-manifest.js');

// Patch 67: the vendored twin of Home23's ingestion pending queue carried the
// same landmine Home23 cured on 2026-07-17 — the queue persisted as ONE
// JSON.stringify(array, null, 2), which hits V8's ~536MB string ceiling
// ("Invalid string length") and then silently stops saving. These tests pin
// the ported cure: JSONL persistence, streamed reads, atomic writes, legacy
// migration, and the feeder ignore-list.

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

test('Patch 67: pending queue persists as JSONL, one line per item, no legacy json left behind', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-jsonl-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const m = makeManifest(runPath);
  m._pending = [item(0), item(1), item(2)];
  m._savePending();

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  assert.ok(fs.existsSync(jsonlPath), 'ingestion-pending.jsonl must exist');
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3, 'one line per queued item');
  for (const line of lines) JSON.parse(line);
  assert.equal(fs.existsSync(path.join(runPath, 'ingestion-pending.json')), false,
    'legacy single-string file must not be written');
  assert.equal(fs.existsSync(`${jsonlPath}.tmp`), false, 'atomic write leaves no tmp file');
});

test('Patch 67: pending queue round-trips through a fresh instance', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-roundtrip-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const first = makeManifest(runPath);
  first._pending = [item(0), item(1)];
  first._savePending();

  const second = makeManifest(runPath);
  assert.equal(second._pending.length, 2);
  assert.deepEqual(second._pending.map((p) => p.filePath), ['/docs/file-0.md', '/docs/file-1.md']);
});

test('Patch 67: legacy ingestion-pending.json migrates to JSONL on load and is removed', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-migrate-'));
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

test('Patch 67: a corrupt line is skipped loudly, valid lines survive', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-corrupt-'));
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

test('Patch 67: the feeder ignore-list covers both queue filenames (old and new)', () => {
  assert.equal(isIngestionInternalFile('ingestion-manifest.json'), true);
  assert.equal(isIngestionInternalFile('ingestion-pending.json'), true);
  assert.equal(isIngestionInternalFile('ingestion-pending.jsonl'), true,
    'the feeder must never ingest its own queue file');
  assert.equal(isIngestionInternalFile('real-document.md'), false);
});
