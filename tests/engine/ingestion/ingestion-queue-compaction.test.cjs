'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { DurableIngestionQueue, isIngestionQueueInternalFile } = require('../../../shared/ingestion-durable-queue.cjs');

function tempRun(t) {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-queue-compaction-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  return runPath;
}

function item(filePath, content = 'content') {
  return { filePath, chunkIndex: 0, content };
}

function queueFor(t, compaction = {}) {
  const runPath = tempRun(t);
  return new DurableIngestionQueue({ runPath, compaction: { minBytes: 1, ...compaction } });
}

function archives(queue) {
  return fs.readdirSync(queue.queuePath).filter((name) => /^events\.jsonl\.\d+\.gz$/.test(name));
}

function assertStateChecksum(queue) {
  const state = JSON.parse(fs.readFileSync(queue.statePath, 'utf8'));
  const checksum = crypto.createHash('sha256').update(`1:${state.baseOffset}:${state.eventOffset}`).digest('hex');
  assert.equal(state.checksum, checksum);
  return state;
}

test('fully acknowledged journal compacts, archives exact bytes, and writes the reset checksum', (t) => {
  const queue = queueFor(t);
  queue.upsert('/large', [item('/large', 'x'.repeat(2 * 1024 * 1024))]);
  const original = fs.readFileSync(queue.eventsPath);
  queue.commit(queue.peekBatch(10).token);

  assert.equal(queue.pendingCount, 0);
  assert.equal(fs.statSync(queue.eventsPath).size, 0);
  assert.equal(assertStateChecksum(queue).eventOffset, 0);
  assert.equal(fs.existsSync(queue.compactionPath), false);
  assert.equal(archives(queue).length, 1);
  assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(queue.queuePath, archives(queue)[0]))), original);
  const reopened = new DurableIngestionQueue({ runPath: queue.runPath });
  assert.equal(reopened.pendingCount, 0);
  assert.deepEqual(reopened.peekBatch(10).items, []);
  reopened.upsert('/next', [item('/next')]);
  assert.deepEqual(reopened.peekBatch(10).items.map((entry) => entry.filePath), ['/next']);
});

test('compaction preserves a consumed legacy source and its base acknowledgement', (t) => {
  const runPath = tempRun(t);
  const sourcePath = path.join(runPath, 'ingestion-pending.jsonl');
  const source = `${JSON.stringify(item('/legacy'))}\n`;
  fs.writeFileSync(sourcePath, source);
  const queue = new DurableIngestionQueue({ runPath, compaction: { minBytes: 1 } });
  queue.migrateLegacy();
  queue.upsert('/new', [item('/new')]);
  queue.commit(queue.peekBatch(10).token);

  const state = assertStateChecksum(queue);
  assert.equal(state.baseOffset, Buffer.byteLength(source));
  assert.equal(state.eventOffset, 0);
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), source);
  assert.deepEqual(new DurableIngestionQueue({ runPath }).peekBatch(10).items, []);
});

test('pending items and unread source bytes prevent compaction; the final control suffix drains safely', (t) => {
  const queue = queueFor(t);
  queue.upsert('/a', [item('/a')]);
  queue.upsert('/b', [item('/b')]);
  const bytes = fs.statSync(queue.eventsPath).size;
  queue.commit(queue.peekBatch(1).token);
  assert.equal(queue.pendingCount, 1);
  assert.equal(fs.statSync(queue.eventsPath).size, bytes);
  assert.equal(archives(queue).length, 0);
  queue.commit(queue.peekBatch(1).token);
  assert.equal(queue.pendingCount, 0);
  assert.equal(fs.statSync(queue.eventsPath).size, 0, 'exact-sized final batch also acknowledges inactive control records');

  fs.writeFileSync(queue.sourcePath, `${JSON.stringify(item('/source'))}\n`);
  queue.removeFile('/removed');
  assert.equal(queue._compactConsumedJournal(), false);
  assert.ok(fs.statSync(queue.eventsPath).size > 0);
});

test('default threshold, configured threshold, disabled compaction, and disabled archives are honored', (t) => {
  const defaultQueue = new DurableIngestionQueue({ runPath: tempRun(t) });
  assert.deepEqual(defaultQueue.compaction, { enabled: true, minBytes: 64 * 1024 * 1024, archive: true });
  defaultQueue.upsert('/small', [item('/small')]);
  defaultQueue.commit(defaultQueue.peekBatch(10).token);
  assert.ok(fs.statSync(defaultQueue.eventsPath).size > 0);

  for (const options of [{ enabled: false }, { minBytes: 1024 * 1024 }]) {
    const queue = queueFor(t, options);
    queue.upsert('/small', [item('/small')]);
    queue.commit(queue.peekBatch(10).token);
    assert.ok(fs.statSync(queue.eventsPath).size > 0);
    assert.equal(archives(queue).length, 0);
  }
  const queue = queueFor(t, { archive: false });
  queue.upsert('/small', [item('/small')]);
  queue.commit(queue.peekBatch(10).token);
  assert.equal(fs.statSync(queue.eventsPath).size, 0);
  assert.equal(archives(queue).length, 0);
  assert.equal(assertStateChecksum(queue).eventOffset, 0);
});

test('construction preserves an already consumed journal until the next owning acknowledgement', (t) => {
  const queue = queueFor(t, { enabled: false });
  queue.upsert('/old', [item('/old')]);
  queue.commit(queue.peekBatch(10).token);
  const before = fs.readFileSync(queue.eventsPath);
  const stateBefore = fs.readFileSync(queue.statePath);
  const reopened = new DurableIngestionQueue({ runPath: queue.runPath, compaction: { minBytes: 1 } });
  assert.deepEqual(fs.readFileSync(queue.eventsPath), before);
  assert.deepEqual(fs.readFileSync(queue.statePath), stateBefore);
  assert.equal(archives(queue).length, 0);
  reopened.commit(reopened.peekBatch(10).token);
  assert.equal(fs.statSync(queue.eventsPath).size, 0);
});

test('a token from the compacted journal cannot acknowledge a later same-sized generation', (t) => {
  const queue = queueFor(t);
  queue.upsert('/a', [item('/a', 'first')]);
  const oldToken = queue.peekBatch(10).token;
  queue.commit(oldToken);
  queue.upsert('/a', [item('/a', 'other')]);
  assert.equal(queue.peekBatch(10).token.eventOffset, oldToken.eventOffset);
  assert.throws(() => queue.commit(oldToken), /stale_or_invalid_ack/);
  assert.equal(queue.pendingCount, 1);
  assert.deepEqual(queue.peekBatch(10).items.map((entry) => entry.content), ['other']);
});

for (const stage of ['archive', 'marker', 'journal', 'state', 'cleanup']) {
  test(`crash at ${stage} leaves consumed legacy and journal records acknowledged on reopen`, (t) => {
    const runPath = tempRun(t);
    const sourcePath = path.join(runPath, 'ingestion-pending.jsonl');
    fs.writeFileSync(sourcePath, `${JSON.stringify(item('/base'))}\n`);
    const queue = new DurableIngestionQueue({ runPath, compaction: { minBytes: 1 } });
    queue.upsert('/event', [item('/event')]);
    const originalRename = fs.renameSync;
    const originalUnlink = fs.unlinkSync;
    const originalSaveState = queue._saveState;
    let crashed = false;
    const crash = () => { crashed = true; throw new Error(`simulated_crash_${stage}`); };
    fs.renameSync = (from, to) => {
      if (stage === 'archive' && String(from).match(/\.gz\.tmp$/)) crash();
      if (stage === 'marker' && from === queue.compactionTmpPath) crash();
      if (stage === 'journal' && from === queue.compactedEventsPath) crash();
      return originalRename(from, to);
    };
    queue._saveState = function (state = this.state) {
      if (stage === 'state' && state.eventOffset === 0) crash();
      return originalSaveState.call(this, state);
    };
    fs.unlinkSync = (target) => {
      if (stage === 'cleanup' && target === queue.compactionPath) crash();
      return originalUnlink(target);
    };
    try {
      queue.commit(queue.peekBatch(10).token);
    } finally {
      fs.renameSync = originalRename;
      fs.unlinkSync = originalUnlink;
      queue._saveState = originalSaveState;
    }
    assert.equal(crashed, true);
    const journalBefore = fs.readFileSync(queue.eventsPath);
    const stateBefore = fs.readFileSync(queue.statePath);
    const reopened = new DurableIngestionQueue({ runPath });
    assert.equal(reopened.state.baseOffset, fs.statSync(sourcePath).size);
    assert.equal(reopened.pendingCount, 0);
    assert.deepEqual(reopened.peekBatch(10).items, []);
    assert.deepEqual(fs.readFileSync(reopened.eventsPath), journalBefore, 'startup does not finish journal rewrites');
    assert.deepEqual(fs.readFileSync(reopened.statePath), stateBefore, 'startup does not rewrite acknowledgement state');
    const recoveredToken = reopened.peekBatch(10).token;
    reopened.commit(recoveredToken);
    reopened.upsert('/fresh', [item('/fresh')]);
    assert.deepEqual(reopened.peekBatch(10).items.map((entry) => entry.filePath), ['/fresh']);
    assertStateChecksum(reopened);
    assert.equal(fs.existsSync(reopened.compactionPath), false);
  });
}

test('uncommitted transactions retain journal history even when the scan sees no active items', (t) => {
  const queue = queueFor(t);
  queue.upsert('/a', [item('/a')]);
  fs.appendFileSync(queue.eventsPath, `${JSON.stringify({
    v: 1, type: 'retry_begin', retryId: 'uncommitted', count: 0,
    files: {}, integrity: 'transaction_sha256_v2',
  })}\n`);
  const bytes = fs.statSync(queue.eventsPath).size;
  queue.commit(queue.peekBatch(10).token);
  assert.equal(queue.pendingCount, 0);
  assert.equal(queue.state.eventOffset, bytes);
  assert.equal(fs.statSync(queue.eventsPath).size, bytes);
  assert.equal(archives(queue).length, 0);
});

test('retry history remains while a retry is pending and is cleared after its acknowledgement', (t) => {
  const queue = queueFor(t);
  queue.upsert('/a', [item('/a')]);
  const first = queue.peekBatch(10);
  queue.requeue(first.items, first.token.deliveries);
  queue.commit(first.token);
  assert.equal(queue.pendingCount, 1);
  assert.equal(archives(queue).length, 0);
  assert.equal(queue._retryMetadata.size, 1);
  queue.commit(queue.peekBatch(10).token);
  assert.equal(fs.statSync(queue.eventsPath).size, 0);
  assert.equal(queue._retryMetadata.size, 0);
  assert.equal(queue._committedRetryIds.size, 0);
  assert.equal(queue._committedGenerations.size, 0);

  queue.upsert('/a', [item('/a', 'new')]);
  const next = queue.peekBatch(10);
  queue.requeue(next.items, next.token.deliveries);
  queue.commit(next.token);
  assert.deepEqual(queue.peekBatch(10).items.map((entry) => entry.content), ['new']);
});

test('unconsumed legacy metadata and retry authority that lacks a committed generation block compaction', (t) => {
  const queue = queueFor(t, { enabled: false });
  queue.upsert('/a', [item('/a')]);
  queue.commit(queue.peekBatch(10).token);
  queue.compaction.enabled = true;
  queue._legacyMetadata.set('/legacy', { sourceStart: 0, sourceEnd: 1 });
  assert.equal(queue._compactConsumedJournal(), false);
  queue._legacyMetadata.clear();
  queue._committedRetryIds.add('retry-authority');
  queue._retryMetadata.set('retry-authority', { '/a': { authorityGeneration: 'missing' } });
  assert.equal(queue._compactConsumedJournal(), false);
  assert.ok(fs.statSync(queue.eventsPath).size > 0);
});

test('dead-letter identities survive compaction and remain idempotent after reopen', (t) => {
  const queue = queueFor(t);
  queue.upsert('/a', [item('/a')]);
  const batch = queue.peekBatch(10);
  queue.deadLetter(batch.items, 'failed', batch.token.deliveries);
  const before = fs.readFileSync(queue.deadLetterPath);
  queue.commit(batch.token);
  assert.equal(fs.statSync(queue.eventsPath).size, 0);
  const reopened = new DurableIngestionQueue({ runPath: queue.runPath });
  reopened.deadLetter(batch.items, 'failed', batch.token.deliveries);
  assert.deepEqual(fs.readFileSync(queue.deadLetterPath), before);

  reopened.compaction.minBytes = 1;
  reopened.compaction.enabled = false;
  reopened.upsert('/b', [item('/b')]);
  reopened.commit(reopened.peekBatch(10).token);
  reopened.compaction.enabled = true;
  reopened._deadLetterIds.add('not-durable');
  assert.equal(reopened._compactConsumedJournal(), false);
});

test('archives and compaction staging files stay excluded from ingestion', () => {
  for (const name of ['compaction.json', 'compaction.json.tmp', 'events.jsonl.compact.tmp',
    'events.jsonl.123.gz', 'events.jsonl.123.gz.tmp']) {
    assert.equal(isIngestionQueueInternalFile(name), true, name);
  }
  assert.equal(isIngestionQueueInternalFile('notes.jsonl'), false);
});
