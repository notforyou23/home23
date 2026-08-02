'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  IngestionManifest,
} = require('../../cosmo23/engine/src/ingestion/ingestion-manifest.js');

// Fix 3.6 (Phase 3), re-pinned 2026-08-02 for the durable-journal queue.
//
// These originally pinned the Patch 67 JSONL queue. The durable append-only
// journal replaced that storage layer, so the assertions that named the old
// on-disk artifact (`ingestion-pending.jsonl`, its 8MB chunked-reader buffer)
// no longer describe anything real. The GUARANTEES they existed to protect are
// unchanged and are re-pinned here against the journal:
//
//   1. an oversized queue item round-trips intact across save + reload — the
//      original mechanism was the chunked reader's carry across an 8MB buffer,
//      which removed V8's ~536MB single-string ceiling. The journal must not
//      reintroduce a whole-file-string load path.
//   2. an unreadable legacy queue is preserved, never silently dropped, and
//      never fatal — a corrupt file must not stop the engine from starting.
//   3. enqueue() upserts per filePath and the debounced save persists without
//      an explicit flush.
//   4. shutdown() persists items that could not embed — the exact restart
//      window where Home23 lost queued chunks on 2026-07-16.
//
// Storage format is deliberately NOT asserted: pinning the artifact name is
// what made these tests block a better storage layer instead of protecting
// behaviour.

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

test('Fix 3.6: an oversized queue item round-trips intact (no whole-file string load)', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-bigitem-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  // 9MB in one item: comfortably past any single read buffer, so a regression
  // to a whole-file read would surface here rather than in the small-item tests.
  const bigContent = 'x'.repeat(9 * 1024 * 1024);
  const first = makeManifest(runPath);
  await first.enqueue('/docs/big.md', 'docs', 'h-big', [chunk(0, 1, bigContent)], []);
  await first.shutdown();

  const second = makeManifest(runPath);
  assert.equal(second._pending.length, 1, 'the oversized item survives a fresh load');
  assert.equal(second._pending[0].filePath, '/docs/big.md');
  assert.equal(second._pending[0].content.length, bigContent.length, 'content length intact');
  assert.equal(second._pending[0].content, bigContent, 'content bytes intact across the read boundary');
});

test('Fix 3.6: an unreadable legacy queue is preserved as .unreadable, and is never fatal', (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-unreadable-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  const legacyPath = path.join(runPath, 'ingestion-pending.json');
  const garbage = '{"this is": not valid json [';
  fs.writeFileSync(legacyPath, garbage);

  const errors = [];
  // Construction must NOT throw: a corrupt legacy queue that kills the engine
  // at startup is a worse failure than an empty queue plus a preserved file.
  let m;
  assert.doesNotThrow(() => {
    m = makeManifest(runPath, {
      logger: { info() {}, warn() {}, error: (...args) => errors.push(args), debug() {} },
    });
  }, 'an unreadable legacy queue must not be fatal');

  assert.equal(m._pending.length, 0, 'no items invented from garbage');
  assert.equal(fs.existsSync(legacyPath), false, 'unreadable legacy file is moved, not left in place');
  const preservedPath = `${legacyPath}.unreadable`;
  assert.ok(fs.existsSync(preservedPath), 'unreadable legacy queue preserved for inspection');
  assert.equal(fs.readFileSync(preservedPath, 'utf8'), garbage, 'preserved bytes are the original bytes');
  assert.ok(errors.length >= 1, 'the failure is reported loudly');
});

test('Fix 3.6: enqueue() upserts per file and the debounced save persists without an explicit flush', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-upsert-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  const m = makeManifest(runPath);
  await m.enqueue('/docs/report.md', 'docs', 'hash-v1',
    [chunk(0, 2, 'first version chunk 0'), chunk(1, 2, 'first version chunk 1')], []);
  await m.enqueue('/docs/report.md', 'docs', 'hash-v2',
    [chunk(0, 1, 'second version sole chunk')], []);

  assert.equal(m.getStats().pendingCount, 1, 're-enqueue replaces prior chunks for the same file');

  // The debounced save fires shortly after the last enqueue — no explicit flush.
  await sleep(400);

  const reloaded = makeManifest(runPath);
  assert.equal(reloaded._pending.length, 1, 'exactly the upserted item persisted');
  assert.equal(reloaded._pending[0].content, 'second version sole chunk');
  assert.equal(reloaded._pending[0].hash, 'hash-v2', 'the second enqueue won the upsert');
});

test('Fix 3.6: shutdown() persists queued items that could not embed — a restart cannot lose them', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmo23-pending-shutdown-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));

  // embeddingFn yields null (provider down): flush('shutdown') must keep the
  // items queued and persist them instead of dropping them. memory is an empty
  // object on purpose — with zero embeddable items the flush must never touch
  // NetworkMemory at all.
  const m = makeManifest(runPath);
  await m.enqueue('/docs/a.md', 'docs', 'hash-a', [chunk(0, 1, 'alpha content')], []);
  await m.enqueue('/docs/b.md', 'docs', 'hash-b', [chunk(0, 1, 'beta content')], []);
  await m.shutdown();

  const rebooted = makeManifest(runPath);
  assert.equal(rebooted._pending.length, 2, 'both unembeddable items survive the restart');
  assert.deepEqual(
    rebooted._pending.map((p) => p.filePath).sort(),
    ['/docs/a.md', '/docs/b.md'],
  );
});
