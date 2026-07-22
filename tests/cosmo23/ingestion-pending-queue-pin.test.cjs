'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  IngestionManifest,
} = require('../../cosmo23/engine/src/ingestion/ingestion-manifest.js');

// Fix 3.6 (Phase 3): confirmation pins for the Patch 67 pending-queue JSONL
// port, complementing tests/cosmo23/ingestion-pending-jsonl.test.cjs. These
// cover the paths that file does not: the chunked reader's carry across the
// 8MB read-buffer boundary (the actual mechanism that removes V8's ~536MB
// single-string ceiling), preservation of an unreadable legacy queue, the
// real enqueue() upsert + debounced JSONL persistence, and shutdown()
// persisting a queue whose items could not embed — the exact restart window
// where Home23 lost queued chunks on 2026-07-16.

function makeManifest(runPath, overrides = {}) {
  return new IngestionManifest({
    runPath,
    memory: {},
    embeddingFn: async () => null,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    ...overrides,
  });
}

function chunk(index, totalChunks, text) {
  return { index, totalChunks, text, heading: null, depth: 0 };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Fix 3.6: a queue item larger than the 8MB read buffer round-trips intact (chunked-reader carry)', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-bigitem-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  // One item whose single JSONL line exceeds _readJsonlSync's 8MB buffer, so
  // loading it MUST exercise the carry-across-reads path. A regression to
  // whole-file readFileSync would still pass small-item tests; this one pins
  // the streaming semantics themselves.
  const bigContent = 'x'.repeat(9 * 1024 * 1024);
  const first = makeManifest(runPath);
  first._pending = [{
    filePath: '/docs/big.md',
    chunkIndex: 0,
    totalChunks: 1,
    content: bigContent,
    hash: 'h-big',
  }];
  first._savePending();

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  const size = fs.statSync(jsonlPath).size;
  assert.ok(size > 8 * 1024 * 1024,
    `fixture must exceed the 8MB read buffer to prove the carry path (size=${size})`);

  const second = makeManifest(runPath);
  assert.equal(second._pending.length, 1, 'the oversized item survives a fresh load');
  assert.equal(second._pending[0].filePath, '/docs/big.md');
  assert.equal(second._pending[0].content.length, bigContent.length, 'content length intact');
  assert.equal(second._pending[0].content, bigContent, 'content bytes intact across the buffer boundary');
});

test('Fix 3.6: an unreadable legacy queue is preserved as .unreadable, never silently dropped', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-unreadable-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  const legacyPath = path.join(runPath, 'ingestion-pending.json');
  const garbage = '{"this is": not valid json [';
  fs.writeFileSync(legacyPath, garbage);

  const errors = [];
  const m = makeManifest(runPath, {
    logger: { info() {}, warn() {}, error: (...args) => errors.push(args), debug() {} },
  });

  assert.equal(m._pending.length, 0, 'no items invented from garbage');
  assert.equal(fs.existsSync(legacyPath), false, 'unreadable legacy file is moved, not left in place');
  const preservedPath = `${legacyPath}.unreadable`;
  assert.ok(fs.existsSync(preservedPath), 'unreadable legacy queue preserved for inspection');
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), garbage, 'preserved bytes are the original bytes');
  assert.ok(errors.length >= 1, 'the failure is reported loudly');
});

test('Fix 3.6: enqueue() upserts per file and the debounced save lands as JSONL on disk', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-upsert-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  const m = makeManifest(runPath);
  await m.enqueue('/docs/report.md', 'docs', 'hash-v1',
    [chunk(0, 2, 'first version chunk 0'), chunk(1, 2, 'first version chunk 1')], []);
  await m.enqueue('/docs/report.md', 'docs', 'hash-v2',
    [chunk(0, 1, 'second version sole chunk')], []);

  assert.equal(m.getStats().pendingCount, 1, 're-enqueue replaces prior chunks for the same file');

  // _debouncedSavePending fires 100ms after the last enqueue.
  await sleep(300);

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  assert.ok(fs.existsSync(jsonlPath), 'debounced save persisted the queue without an explicit flush');
  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, 'exactly the upserted item on disk');
  const persisted = JSON.parse(lines[0]);
  assert.equal(persisted.content, 'second version sole chunk');
  assert.equal(persisted.hash, 'hash-v2', 'the second enqueue won the upsert');
});

test('Fix 3.6: shutdown() persists queued items that could not embed — a restart cannot lose them', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-shutdown-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  // embeddingFn yields null (provider down): flush('shutdown') must keep the
  // items queued and write them to disk instead of dropping them. memory is
  // an empty object on purpose — with zero embeddable items the flush must
  // never touch NetworkMemory at all.
  const m = makeManifest(runPath);
  await m.enqueue('/docs/a.md', 'docs', 'hash-a', [chunk(0, 1, 'alpha content')], []);
  await m.enqueue('/docs/b.md', 'docs', 'hash-b', [chunk(0, 1, 'beta content')], []);
  await m.shutdown();

  const jsonlPath = path.join(runPath, 'ingestion-pending.jsonl');
  assert.equal(fs.existsSync(`${jsonlPath}.tmp`), false, 'atomic rewrite leaves no tmp file behind');

  const rebooted = makeManifest(runPath);
  assert.equal(rebooted._pending.length, 2, 'both unembeddable items survive the restart');
  assert.deepEqual(
    rebooted._pending.map((p) => p.filePath).sort(),
    ['/docs/a.md', '/docs/b.md'],
  );
});
