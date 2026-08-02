import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DurableIngestionQueue,
  readDurableIngestionQueueStats,
} = require('../../../shared/ingestion-durable-queue.cjs');
const { IngestionManifest } = require('../../../engine/src/ingestion/ingestion-manifest.js');
const { IngestionManifest: CosmoIngestionManifest } = require('../../../cosmo23/engine/src/ingestion/ingestion-manifest.js');

function tempRun(t) {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-durable-ingestion-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  return runPath;
}

function item(filePath, chunkIndex = 0, extra = {}) {
  return { filePath, chunkIndex, content: `content-${filePath}-${chunkIndex}`, ...extra };
}

function f76ReplaceTransaction(filePath, generation = 'f76-generation') {
  const begin = {
    v: 1, type: 'replace_begin', filePath, generation, count: 1,
    metadata: { relationships: [] }, integrity: 'begin_and_items_sha256_v1',
  };
  const itemRecord = { v: 1, type: 'item', filePath, generation, item: item(filePath) };
  const checksum = crypto.createHash('sha256')
    .update(Buffer.from(`${JSON.stringify(begin)}\n`))
    .update(Buffer.from(`${JSON.stringify(itemRecord)}\n`))
    .digest('hex');
  return [
    begin,
    itemRecord,
    { v: 1, type: 'replace_commit', filePath, generation, count: 1, checksum },
  ];
}

test('adopts a large legacy JSONL queue in place and commits a batch without rewriting it', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  fs.writeFileSync(source, [item('/a', 0), item('/a', 1), item('/b', 0)]
    .map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const before = fs.statSync(source);

  const queue = new DurableIngestionQueue({ runPath });
  const batch = queue.peekBatch(2);
  assert.deepEqual(batch.items.map((entry) => entry.filePath), ['/a', '/a']);
  queue.commit(batch.token);

  const after = fs.statSync(source);
  assert.equal(after.ino, before.ino, 'legacy source remains the same file');
  assert.equal(after.size, before.size, 'ack never rewrites or truncates the legacy source');
  assert.equal(queue.pendingCount, 1);
  assert.ok(fs.statSync(path.join(runPath, 'ingestion-queue', 'state.json')).size < 64 * 1024);
});

test('restart resumes from the durable acknowledgement without loss or duplicate delivery', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), [item('/a'), item('/b'), item('/c')]
    .map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const first = new DurableIngestionQueue({ runPath });
  const batch = first.peekBatch(2);
  first.commit(batch.token);

  const restarted = new DurableIngestionQueue({ runPath });
  const remaining = restarted.peekBatch(10);
  assert.deepEqual(remaining.items.map((entry) => entry.filePath), ['/c']);
  restarted.commit(remaining.token);
  assert.equal(new DurableIngestionQueue({ runPath }).pendingCount, 0);
});

test('upsert and tombstone supersede unconsumed legacy and journal records by filePath', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), [item('/a', 0), item('/b', 0)]
    .map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/a', [item('/a', 9, { content: 'new' })]);
  queue.removeFile('/b');

  const batch = queue.peekBatch(10);
  assert.deepEqual(batch.items.map((entry) => [entry.filePath, entry.chunkIndex, entry.content]), [
    ['/a', 9, 'new'],
  ]);
  queue.commit(batch.token);
  assert.equal(queue.pendingCount, 0);
});

test('an incomplete journal tail is quarantined and truncated to the last durable record', (t) => {
  const runPath = tempRun(t);
  const first = new DurableIngestionQueue({ runPath });
  first.upsert('/a', [item('/a')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  fs.appendFileSync(journal, '{"v":1,"type":"item"');

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(restarted.pendingCount, 1);
  assert.ok(fs.existsSync(path.join(runPath, 'ingestion-queue', 'corrupt-tail.bin')));
  assert.ok(fs.readFileSync(journal, 'utf8').endsWith('\n'));
});

test('a complete-line append transaction without its commit marker is rolled back on restart', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/good', [item('/good')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durableBytes = fs.statSync(journal).size;
  fs.appendFileSync(journal, `${JSON.stringify({
    v: 1, type: 'replace_begin', filePath: '/partial', generation: 'partial', count: 1,
  })}\n${JSON.stringify({
    v: 1, type: 'item', filePath: '/partial', generation: 'partial', item: item('/partial'),
  })}\n`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durableBytes);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/good']);
});

test('an append error rolls back immediately so a later successful transaction cannot be lost', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  const originalWrite = fs.writeSync;
  let writes = 0;
  fs.writeSync = (...args) => {
    writes += 1;
    if (writes === 2) throw Object.assign(new Error('simulated_enospc'), { code: 'ENOSPC' });
    return originalWrite(...args);
  };
  try {
    assert.throws(() => queue.upsert('/partial', [item('/partial')]), /simulated_enospc/);
  } finally {
    fs.writeSync = originalWrite;
  }
  queue.upsert('/good', [item('/good')]);
  const restarted = new DurableIngestionQueue({ runPath });
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/good']);
});

test('a short journal write is completed before the transaction is acknowledged', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  const originalWrite = fs.writeSync;
  let shortened = false;
  fs.writeSync = (fd, buffer, ...args) => {
    if (!shortened && Buffer.isBuffer(buffer) && buffer.length > 8) {
      shortened = true;
      const length = Math.floor(buffer.length / 2);
      originalWrite(fd, buffer.subarray(0, length));
      return length;
    }
    return originalWrite(fd, buffer, ...args);
  };
  try {
    queue.upsert('/short.md', [item('/short.md')]);
  } finally {
    fs.writeSync = originalWrite;
  }
  assert.equal(new DurableIngestionQueue({ runPath }).pendingCount, 1);
});

test('transaction item count and hash mismatch quarantines the complete-line transaction', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/a', [item('/a')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const changed = fs.readFileSync(journal, 'utf8').replace('content-/a-0', 'content-/z-0');
  fs.writeFileSync(journal, changed);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(restarted.pendingCount, 0);
  assert.equal(fs.statSync(journal).size, 0);
  assert.match(fs.readFileSync(path.join(runPath, 'ingestion-queue', 'corrupt-tail.bin'), 'utf8'), /content-\/z-0/);
});

test('replace transaction rejects same-length valid JSON corruption in begin metadata', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/graph', [item('/graph')], {
    relationships: [{ from: 0, to: 0, type: 'FOLLOWS' }],
  });
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  fs.writeFileSync(journal, fs.readFileSync(journal, 'utf8').replace('FOLLOWS', 'XOLLOWS'));

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(restarted.pendingCount, 0);
  assert.equal(fs.statSync(journal).size, 0);
  assert.match(fs.readFileSync(path.join(runPath, 'ingestion-queue', 'corrupt-tail.bin'), 'utf8'), /XOLLOWS/);
});

test('legacy transaction rejects same-length valid JSON corruption in begin metadata', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  fs.writeFileSync(source, `${JSON.stringify(item('/legacy', 0, {
    relationships: [{ from: 0, to: 0, type: 'FOLLOWS' }],
  }))}\n`);
  const queue = new DurableIngestionQueue({ runPath });
  queue.migrateLegacy({ maxRecords: 10 });
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  fs.writeFileSync(journal, fs.readFileSync(journal, 'utf8').replace('FOLLOWS', 'XOLLOWS'));

  const restarted = new DurableIngestionQueue({ runPath });
  const batch = restarted.peekBatch(1);
  assert.equal(batch.items[0].relationships[0].type, 'FOLLOWS', 'falls back to immutable source metadata');
  assert.match(fs.readFileSync(path.join(runPath, 'ingestion-queue', 'corrupt-tail.bin'), 'utf8'), /XOLLOWS/);
});

test('checksummed remove record rejects same-length valid JSON corruption', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/a', [item('/a')]);
  queue.upsert('/b', [item('/b')]);
  queue.removeFile('/a');
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const before = fs.readFileSync(journal, 'utf8');
  const removeStart = before.lastIndexOf('{"v":1,"type":"remove"');
  assert.notEqual(removeStart, -1);
  fs.writeFileSync(journal, `${before.slice(0, removeStart)}${before.slice(removeStart).replace('/a', '/b')}`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/a', '/b']);
  assert.match(fs.readFileSync(path.join(runPath, 'ingestion-queue', 'corrupt-tail.bin'), 'utf8'), /"type":"remove"/);
});

test('transaction rejects same-length commit filePath corruption', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/good', [item('/good')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durablePrefix = fs.statSync(journal).size;
  queue.upsert('/graph', [item('/graph')]);
  const before = fs.readFileSync(journal, 'utf8');
  const commitStart = before.lastIndexOf('{"v":1,"type":"replace_commit"');
  fs.writeFileSync(journal, `${before.slice(0, commitStart)}${before.slice(commitStart).replace('/graph', '/wrong')}`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durablePrefix);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/good']);
});

test('transaction rejects same-length commit version corruption', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/good', [item('/good')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durablePrefix = fs.statSync(journal).size;
  queue.upsert('/graph', [item('/graph')]);
  const before = fs.readFileSync(journal, 'utf8');
  const commitStart = before.lastIndexOf('{"v":1,"type":"replace_commit"');
  const commit = before.slice(commitStart).replace('{"v":1', '{"v":2');
  fs.writeFileSync(journal, `${before.slice(0, commitStart)}${commit}`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durablePrefix);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/good']);
});

test('unsigned remove after the protected journal boundary is quarantined', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/a', [item('/a')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durablePrefix = fs.statSync(journal).size;
  fs.appendFileSync(journal, `${JSON.stringify({
    v: 1, type: 'remove', filePath: '/a', generation: 'unsigned-remove',
  })}\n`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durablePrefix);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/a']);
});

test('unsigned transaction after the protected journal boundary is quarantined', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/good', [item('/good')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durablePrefix = fs.statSync(journal).size;
  const generation = 'unsigned-generation';
  const unsignedItem = {
    v: 1, type: 'item', filePath: '/late', generation, item: item('/late'),
  };
  const checksum = crypto.createHash('sha256')
    .update(Buffer.from(`${JSON.stringify(unsignedItem)}\n`))
    .digest('hex');
  fs.appendFileSync(journal, [
    { v: 1, type: 'replace_begin', filePath: '/late', generation, count: 1 },
    unsignedItem,
    { v: 1, type: 'replace_commit', filePath: '/late', generation, count: 1, checksum },
  ].map((record) => `${JSON.stringify(record)}\n`).join(''));

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durablePrefix);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/good']);
});

test('legacy unsigned journal prefix remains readable before the protected boundary', (t) => {
  const runPath = tempRun(t);
  const journalDir = path.join(runPath, 'ingestion-queue');
  const journal = path.join(journalDir, 'events.jsonl');
  fs.mkdirSync(journalDir);
  const generation = 'legacy-generation';
  const legacyItem = {
    v: 1, type: 'item', filePath: '/legacy', generation, item: item('/legacy'),
  };
  const checksum = crypto.createHash('sha256')
    .update(Buffer.from(`${JSON.stringify(legacyItem)}\n`))
    .digest('hex');
  fs.writeFileSync(journal, [
    { v: 1, type: 'replace_begin', filePath: '/legacy', generation, count: 1 },
    legacyItem,
    { v: 1, type: 'replace_commit', filePath: '/legacy', generation, count: 1, checksum },
  ].map((record) => `${JSON.stringify(record)}\n`).join(''));

  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/protected', [item('/protected')]);
  const restarted = new DurableIngestionQueue({ runPath });
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/legacy', '/protected']);
});

test('f76 authenticated v1 transaction remains active and deliverable through the v2 upgrade', (t) => {
  const runPath = tempRun(t);
  const journalDir = path.join(runPath, 'ingestion-queue');
  const journal = path.join(journalDir, 'events.jsonl');
  fs.mkdirSync(journalDir);
  fs.writeFileSync(journal, f76ReplaceTransaction('/f76')
    .map((record) => `${JSON.stringify(record)}\n`).join(''));

  const queue = new DurableIngestionQueue({ runPath });
  assert.deepEqual(queue.peekBatch(10).items.map((entry) => entry.filePath), ['/f76']);
  queue.upsert('/v2', [item('/v2')]);
  const restarted = new DurableIngestionQueue({ runPath });
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/f76', '/v2']);
});

test('f76 authenticated v1 transaction after the v2 boundary is quarantined', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/v2', [item('/v2')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durablePrefix = fs.statSync(journal).size;
  fs.appendFileSync(journal, f76ReplaceTransaction('/downgrade')
    .map((record) => `${JSON.stringify(record)}\n`).join(''));

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durablePrefix);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/v2']);
});

test('f76 checksummed remove after the v2 boundary is quarantined', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/v2', [item('/v2')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durablePrefix = fs.statSync(journal).size;
  const oldRemove = {
    v: 1, type: 'remove', filePath: '/v2', generation: 'f76-remove', integrity: 'record_sha256_v1',
  };
  const checksum = crypto.createHash('sha256')
    .update(Buffer.from(`${JSON.stringify(oldRemove)}\n`))
    .digest('hex');
  fs.appendFileSync(journal, `${JSON.stringify({ ...oldRemove, checksum })}\n`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durablePrefix);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/v2']);
});

test('a malformed complete journal line is quarantined from its transaction boundary', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/good', [item('/good')]);
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  const durableBytes = fs.statSync(journal).size;
  fs.appendFileSync(journal, `${JSON.stringify({
    v: 1, type: 'replace_begin', filePath: '/bad', generation: 'bad', count: 1,
  })}\nnot-json\n${JSON.stringify({
    v: 1, type: 'replace_commit', filePath: '/bad', generation: 'bad', count: 1, checksum: 'bad',
  })}\n`);

  const restarted = new DurableIngestionQueue({ runPath });
  assert.equal(fs.statSync(journal).size, durableBytes);
  assert.deepEqual(restarted.peekBatch(10).items.map((entry) => entry.filePath), ['/good']);
  assert.match(fs.readFileSync(path.join(runPath, 'ingestion-queue', 'corrupt-tail.bin'), 'utf8'), /not-json/);
});

test('a crash before state rename preserves the prior acknowledgement', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), [item('/a'), item('/b')]
    .map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const queue = new DurableIngestionQueue({ runPath });
  const first = queue.peekBatch(1);
  queue.commit(first.token);
  fs.writeFileSync(path.join(runPath, 'ingestion-queue', 'state.json.tmp'), '{"baseOffset":999999');

  const restarted = new DurableIngestionQueue({ runPath });
  assert.deepEqual(restarted.peekBatch(2).items.map((entry) => entry.filePath), ['/b']);
});

test('an acknowledgement write failure leaves the in-process token retryable and count unchanged', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify(item('/a'))}\n`);
  const queue = new DurableIngestionQueue({ runPath });
  const batch = queue.peekBatch(1);
  const originalRename = fs.renameSync;
  fs.renameSync = (...args) => {
    if (String(args[0]).endsWith('state.json.tmp')) throw Object.assign(new Error('simulated_ack_enospc'), { code: 'ENOSPC' });
    return originalRename(...args);
  };
  try {
    assert.throws(() => queue.commit(batch.token), /simulated_ack_enospc/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(queue.pendingCount, 1);
  queue.commit(batch.token);
  assert.equal(queue.pendingCount, 0);
});

test('acknowledgement token rejects altered offsets and cannot skip an undelivered item', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  fs.writeFileSync(source, [item('/a'), item('/b')].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const queue = new DurableIngestionQueue({ runPath });
  const batch = queue.peekBatch(1);
  assert.throws(() => queue.commit({ ...batch.token, baseOffset: fs.statSync(source).size }), /invalid_ack/);
  queue.commit(batch.token);
  assert.deepEqual(new DurableIngestionQueue({ runPath }).peekBatch(10).items.map((entry) => entry.filePath), ['/b']);
});

test('retry append is idempotent across a crash before source acknowledgement', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify(item('/a'))}\n`);
  const queue = new DurableIngestionQueue({ runPath });
  const batch = queue.peekBatch(1);
  queue.requeue(batch.items, batch.token.deliveries);
  queue.requeue(batch.items, batch.token.deliveries);
  assert.equal(queue.pendingCount, 2, 'one source record plus exactly one retry record');
  queue.commit(batch.token);
  assert.equal(queue.pendingCount, 1);
  assert.deepEqual(queue.peekBatch(1).items.map((entry) => entry.filePath), ['/a']);
});

test('queue state and journal growth are bounded by changed records, not total legacy bytes', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  const payload = 'x'.repeat(1024 * 1024);
  fs.writeFileSync(source, `${JSON.stringify(item('/large', 0, { content: payload }))}\n${JSON.stringify(item('/small'))}\n`);
  const sourceBytes = fs.statSync(source).size;
  const queue = new DurableIngestionQueue({ runPath });
  const batch = queue.peekBatch(1);
  queue.commit(batch.token);
  const queueDir = path.join(runPath, 'ingestion-queue');
  const amplification = fs.readdirSync(queueDir).reduce((sum, name) => sum + fs.statSync(path.join(queueDir, name)).size, 0);
  assert.ok(amplification < sourceBytes / 20, `metadata amplification ${amplification} must stay bounded vs ${sourceBytes}`);
});

test('queue internal files and directories are recognizable by the feeder exclusion helper', () => {
  const { isIngestionQueueInternalFile } = require('../../../shared/ingestion-durable-queue.cjs');
  for (const name of ['ingestion-queue', 'events.jsonl', 'state.json', 'state.json.tmp', 'corrupt-tail.bin']) {
    assert.equal(isIngestionQueueInternalFile(name), true, name);
  }
  assert.equal(isIngestionQueueInternalFile('notes.md'), false);
});

test('queue refuses symlinked source, state directory, and journal targets', (t) => {
  const root = tempRun(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-ingestion-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  const linkedDirRun = path.join(root, 'linked-dir');
  fs.mkdirSync(linkedDirRun);
  fs.symlinkSync(outside, path.join(linkedDirRun, 'ingestion-queue'));
  assert.throws(() => new DurableIngestionQueue({ runPath: linkedDirRun }), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'events.jsonl')), false);

  const linkedJournalRun = path.join(root, 'linked-journal');
  fs.mkdirSync(path.join(linkedJournalRun, 'ingestion-queue'), { recursive: true });
  const outsideJournal = path.join(outside, 'outside-events.jsonl');
  fs.writeFileSync(outsideJournal, 'outside');
  fs.symlinkSync(outsideJournal, path.join(linkedJournalRun, 'ingestion-queue', 'events.jsonl'));
  assert.throws(() => new DurableIngestionQueue({ runPath: linkedJournalRun }), /symlink/);
  assert.equal(fs.readFileSync(outsideJournal, 'utf8'), 'outside');

  const linkedSourceRun = path.join(root, 'linked-source');
  fs.mkdirSync(linkedSourceRun);
  fs.symlinkSync(outsideJournal, path.join(linkedSourceRun, 'ingestion-pending.jsonl'));
  assert.throws(() => new DurableIngestionQueue({ runPath: linkedSourceRun }), /symlink/);
});

test('eight-thousand-chunk file persists relationships once with O(chunks plus relationships) bytes', (t) => {
  const runPath = tempRun(t);
  const relationships = Array.from({ length: 8_000 }, (_, i) => ({
    from: i, to: (i + 1) % 8_000, type: 'FOLLOWS',
  }));
  const items = Array.from({ length: 8_000 }, (_, i) => item('/huge.md', i, {
    content: `compact-${i}`,
  }));
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/huge.md', items, { relationships });

  const journalBytes = fs.statSync(path.join(runPath, 'ingestion-queue', 'events.jsonl')).size;
  assert.ok(journalBytes < 3 * 1024 * 1024, `journal must be linear, received ${journalBytes} bytes`);
  const delivered = queue.peekBatch(2).items;
  assert.equal(delivered[0].relationships.length, 8_000);
  assert.strictEqual(delivered[0].relationships, delivered[1].relationships,
    'one reconstructed relationship object is shared across a delivered generation');
});

test('legacy JSONL compaction is resumable, leaves source immutable, and preserves one relationship graph', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  const relationships = [{ from: 0, to: 1, type: 'FOLLOWS' }];
  fs.writeFileSync(source, [
    item('/a', 0, { relationships }), item('/a', 1, { relationships }),
    item('/b', 0, { relationships }), item('/b', 1, { relationships }),
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const sourceBefore = fs.readFileSync(source);

  const first = new DurableIngestionQueue({ runPath });
  const partial = first.migrateLegacy({ maxRecords: 2 });
  assert.equal(partial.complete, false);
  assert.equal(partial.migratedRecords, 2);

  const restarted = new DurableIngestionQueue({ runPath });
  const finished = restarted.migrateLegacy({ maxRecords: 100 });
  assert.equal(finished.complete, true);
  assert.equal(finished.migratedRecords, 2);
  assert.deepEqual(fs.readFileSync(source), sourceBefore, 'migration never rewrites the recovery source');
  const batch = restarted.peekBatch(10);
  assert.deepEqual(batch.items.map((entry) => entry.filePath), ['/a', '/a', '/b', '/b']);
  assert.deepEqual(batch.items[3].relationships, relationships);
});

test('legacy migration stores metadata only and never creates a second content-sized copy', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  const payload = 'x'.repeat(1024 * 1024);
  fs.writeFileSync(source, [item('/large', 0, { content: payload, relationships: [] }), item('/large', 1, { content: payload, relationships: [] })]
    .map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const queue = new DurableIngestionQueue({ runPath });
  queue.migrateLegacy({ maxRecords: 10 });
  assert.ok(fs.statSync(path.join(runPath, 'ingestion-queue', 'events.jsonl')).size < 64 * 1024);
  assert.equal(queue.pendingCount, 2);
});

test('legacy migration rejects same-inode same-size source byte changes using SHA-256', (t) => {
  const runPath = tempRun(t);
  const source = path.join(runPath, 'ingestion-pending.jsonl');
  fs.writeFileSync(source, [item('/a'), item('/b')].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const fixedTime = new Date(Math.floor(Date.now() / 1000) * 1000 - 10_000);
  fs.utimesSync(source, fixedTime, fixedTime);
  const queue = new DurableIngestionQueue({ runPath });
  assert.equal(queue.migrateLegacy({ maxRecords: 1 }).complete, false);
  const before = fs.statSync(source);
  const changed = fs.readFileSync(source, 'utf8').replace('content-/b-0', 'content-/c-0');
  fs.writeFileSync(source, changed);
  fs.utimesSync(source, before.atime, before.mtime);
  const after = fs.statSync(source);
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.throws(() => new DurableIngestionQueue({ runPath }).migrateLegacy({ maxRecords: 10 }), /source_changed/);
});

test('legacy migration refuses to start without projected journal headroom', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify(item('/a', 0, {
    relationships: Array.from({ length: 100 }, (_, index) => ({ from: index, to: index + 1 })),
  }))}\n`);
  const queue = new DurableIngestionQueue({ runPath });
  const originalStatfs = fs.statfsSync;
  fs.statfsSync = () => ({ bavail: 0, bsize: 4096 });
  try {
    assert.throws(() => queue.migrateLegacy({ maxRecords: 10 }), /insufficient_headroom/);
  } finally {
    fs.statfsSync = originalStatfs;
  }
});

test('legacy compaction rejects noncontiguous file generations before writing any migration event', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), [
    item('/a', 0), item('/b', 0), item('/a', 1),
  ].map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  const queue = new DurableIngestionQueue({ runPath });
  const journal = path.join(runPath, 'ingestion-queue', 'events.jsonl');
  assert.throws(() => queue.migrateLegacy({ maxRecords: 10 }), /noncontiguous_file_generation/);
  assert.equal(fs.statSync(journal).size, 0);
});

test('embedding failure attempts survive restart and dead-letter on the third failure', async (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify({
    ...item('/fails.md'),
    sourcePath: '/fails.md#chunk-0',
    tag: 'test',
    totalChunks: 1,
    hash: 'hash',
    relationships: [],
  })}\n`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const manifest = new IngestionManifest({
      runPath,
      memory: {},
      embeddingFn: async () => null,
      config: { batchSize: 1 },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    await manifest.flush(`attempt-${attempt + 1}`);
  }
  const queue = new DurableIngestionQueue({ runPath });
  assert.equal(queue.pendingCount, 0);
  const dead = fs.readFileSync(path.join(runPath, 'ingestion-queue', 'dead-letter.jsonl'), 'utf8');
  assert.match(dead, /embedding_failed_three_times/);
});

test('dead-letter writes are idempotent for the same delivery across an ack crash', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify(item('/a'))}\n`);
  const queue = new DurableIngestionQueue({ runPath });
  const batch = queue.peekBatch(1);
  queue.deadLetter(batch.items, 'failed', batch.token.deliveries);
  queue.deadLetter(batch.items, 'failed', batch.token.deliveries);
  const records = fs.readFileSync(path.join(runPath, 'ingestion-queue', 'dead-letter.jsonl'), 'utf8').trim().split('\n');
  assert.equal(records.length, 1);
});

test('a partial dead-letter write is quarantined before the idempotent retry', (t) => {
  const runPath = tempRun(t);
  const queue = new DurableIngestionQueue({ runPath });
  const delivery = [{ filePath: '/a', source: 'base', start: 0, end: 10 }];
  const originalWrite = fs.writeSync;
  let calls = 0;
  fs.writeSync = (fd, buffer, ...args) => {
    calls += 1;
    if (calls === 1 && Buffer.isBuffer(buffer)) {
      const length = Math.floor(buffer.length / 2);
      originalWrite(fd, buffer.subarray(0, length));
      return length;
    }
    if (calls === 2) throw Object.assign(new Error('dead_letter_enospc'), { code: 'ENOSPC' });
    return originalWrite(fd, buffer, ...args);
  };
  try {
    assert.throws(() => queue.deadLetter([item('/a')], 'failed', delivery), /dead_letter_enospc/);
  } finally {
    fs.writeSync = originalWrite;
  }
  const restarted = new DurableIngestionQueue({ runPath });
  restarted.deadLetter([item('/a')], 'failed', delivery);
  const records = fs.readFileSync(path.join(runPath, 'ingestion-queue', 'dead-letter.jsonl'), 'utf8').trim().split('\n');
  assert.equal(records.length, 1);
  assert.equal(JSON.parse(records[0]).type, 'dead_letter');
});

for (const [name, Manifest] of [
  ['Root', IngestionManifest],
  ['COSMO', CosmoIngestionManifest],
]) {
  test(`${name} retains an entire generation across batches and applies relationships once`, async (t) => {
    const runPath = tempRun(t);
    let sequence = 0;
    let edgeCalls = 0;
    const memory = {
      nodes: new Map(),
      async addNode(value) {
        const node = { id: `node-${++sequence}`, concept: value.concept, metadata: value.metadata };
        this.nodes.set(node.id, node);
        return node;
      },
      patchNode(id, patch) { Object.assign(this.nodes.get(id), patch); return this.nodes.get(id); },
      removeNode(id) { return this.nodes.delete(id); },
      addEdge() { edgeCalls += 1; },
    };
    const manifest = new Manifest({
      runPath, memory, embeddingFn: async () => [0.1], config: { batchSize: 20 },
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const chunks = Array.from({ length: 25 }, (_, index) => ({
      index, text: `chunk-${index}`, totalChunks: 25, heading: null, depth: 0,
    }));
    const relationships = Array.from({ length: 24 }, (_, index) => ({ from: index, to: index + 1, type: 'FOLLOWS' }));
    await manifest.enqueue('/large.md', 'large', 'full-hash-0123456789', chunks, relationships);
    await manifest.flush('first');
    await manifest.flush('second');
    const entry = manifest.getEntry ? manifest.getEntry('/large.md') : manifest._manifest['/large.md'];
    assert.equal(memory.nodes.size, 25);
    assert.equal(entry.nodeIds.length, 25);
    assert.equal(edgeCalls, 24);
  });
}

test('read-only durable queue stats reflect acks, journal upserts, and tombstones', (t) => {
  const runPath = tempRun(t);
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify(item('/base'))}\n`);
  const queue = new DurableIngestionQueue({ runPath });
  queue.upsert('/new', [item('/new')]);
  queue.removeFile('/base');
  assert.deepEqual(readDurableIngestionQueueStats(runPath), { pendingCount: 1, v: 1 });
  const batch = queue.peekBatch(10);
  queue.commit(batch.token);
  assert.deepEqual(readDurableIngestionQueueStats(runPath), { pendingCount: 0, v: 1 });
});

test('restart reuses an orphaned committed chunk after manifest persistence crashes before queue ack', async (t) => {
  const runPath = tempRun(t);
  const queueItem = {
    ...item('/crash.md'),
    sourcePath: '/crash.md#chunk-0',
    tag: 'test',
    label: 'test',
    totalChunks: 1,
    hash: 'full-hash',
    contentHash: 'short-hash',
    embedding: [0.1],
    relationships: [],
  };
  fs.writeFileSync(path.join(runPath, 'ingestion-pending.jsonl'), `${JSON.stringify(queueItem)}\n`);
  let adds = 0;
  const memory = {
    nodes: new Map(),
    removeNode(id) { return this.nodes.delete(id); },
    async addNode(value) {
      adds += 1;
      const node = {
        id: `node-${adds}`,
        concept: typeof value === 'object' ? value.concept : value,
        metadata: typeof value === 'object' ? value.metadata : {},
      };
      this.nodes.set(node.id, node);
      return node;
    },
    patchNode(id, patch) { Object.assign(this.nodes.get(id), patch); return this.nodes.get(id); },
    addEdge() {},
  };
  const first = new IngestionManifest({
    runPath, memory, embeddingFn: async () => [0.1], config: { batchSize: 1 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  first._saveManifest = () => { throw new Error('simulated_manifest_enospc'); };
  await assert.rejects(first.flush('crash'), /simulated_manifest_enospc/);
  assert.equal(adds, 1);

  const restarted = new IngestionManifest({
    runPath, memory, embeddingFn: async () => [0.1], config: { batchSize: 1 },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
  await restarted.flush('restart');
  assert.equal(adds, 1, 'same durable chunk identity is reused rather than duplicated');
  assert.equal(restarted.getStats().pendingCount, 0);
});
