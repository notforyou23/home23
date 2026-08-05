import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodingJobStore } from '../../src/acp/job-store.js';
import type { CodingJobRecord, CodingJobReceipt } from '../../src/acp/types.js';

function record(id: string, overrides: Partial<CodingJobRecord> = {}): CodingJobRecord {
  return {
    schema: 'home23.coding-job.v1',
    id,
    backend: 'claude-code',
    status: 'running',
    prompt: 'do the thing',
    cwd: '/tmp/x',
    requestedCwd: '/tmp/x',
    startedAt: new Date().toISOString(),
    isolation: 'none',
    ...overrides,
  };
}

test('createJob/updateJob round-trip atomically without leaving tmp files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-acp-store-'));
  try {
    const store = new CodingJobStore(dir);
    const id = store.newJobId();
    assert.match(id, /^cj_\d{8}T\d{6}Z_[0-9a-f]{4}$/);

    store.createJob(record(id));
    assert.equal(store.getJob(id)?.status, 'running');

    const updated = store.updateJob(id, { status: 'completed', sessionId: 'sess-1' });
    assert.equal(updated.status, 'completed');
    assert.equal(store.getJob(id)?.sessionId, 'sess-1');
    // Patch cannot clobber the id.
    store.updateJob(id, { id: 'cj_evil' } as Partial<CodingJobRecord>);
    assert.equal(store.getJob(id)?.id, id);

    const leftovers = readdirSync(store.jobDir(id)).filter(f => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('listJobs sorts newest first, filters by status, tolerates corrupt records', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-acp-store-'));
  try {
    const store = new CodingJobStore(dir);
    store.createJob(record('cj_20260101T000000Z_aaaa', { startedAt: '2026-01-01T00:00:00.000Z' }));
    store.createJob(record('cj_20260301T000000Z_bbbb', { startedAt: '2026-03-01T00:00:00.000Z', status: 'completed' }));
    store.createJob(record('cj_20260201T000000Z_cccc', { startedAt: '2026-02-01T00:00:00.000Z' }));

    // Corrupt job dir: garbage json must be skipped, not fatal.
    mkdirSync(path.join(dir, 'cj_20260401T000000Z_dddd'), { recursive: true });
    writeFileSync(path.join(dir, 'cj_20260401T000000Z_dddd', 'job.json'), '{nope');
    // Unrelated dir entries are ignored entirely.
    mkdirSync(path.join(dir, 'not-a-job'), { recursive: true });

    const all = store.listJobs();
    assert.deepEqual(all.map(j => j.id), [
      'cj_20260301T000000Z_bbbb',
      'cj_20260201T000000Z_cccc',
      'cj_20260101T000000Z_aaaa',
    ]);
    assert.deepEqual(store.listJobs({ status: 'running' }).map(j => j.id), [
      'cj_20260201T000000Z_cccc',
      'cj_20260101T000000Z_aaaa',
    ]);
    assert.equal(store.listJobs({ limit: 1 }).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readRawEventsTail reads the last N lines of a >256KB file without loading it', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-acp-store-'));
  try {
    const store = new CodingJobStore(dir);
    const id = store.newJobId();
    store.createJob(record(id));
    const lines: string[] = [];
    for (let i = 0; i < 6000; i++) {
      lines.push(JSON.stringify({ type: 'other', seq: i, pad: 'x'.repeat(60) }));
    }
    writeFileSync(store.eventsPath(id), lines.join('\n') + '\n');
    assert.ok(lines.join('\n').length > 256 * 1024, 'fixture must exceed the 256KB tail window');

    const tail = store.readRawEventsTail(id, 10);
    assert.equal(tail.length, 10);
    assert.deepEqual(tail, lines.slice(-10));
    // Every returned line is complete JSON (no partial first line leaks through).
    for (const line of tail) JSON.parse(line);

    assert.deepEqual(store.readRawEventsTail('cj_missing', 10), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('receipt round-trip', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'home23-acp-store-'));
  try {
    const store = new CodingJobStore(dir);
    const id = store.newJobId();
    store.createJob(record(id));
    const receipt: CodingJobReceipt = {
      schema: 'home23.coding-receipt.v1',
      jobId: id,
      backend: 'claude-code',
      status: 'completed',
      startedAt: '2026-08-05T00:00:00.000Z',
      finishedAt: '2026-08-05T00:01:00.000Z',
      durationMs: 60_000,
      resultTail: 'shipped',
      costUsd: 0.03,
      eventsCount: 5,
      toolUseCount: 2,
    };
    store.writeReceipt(receipt);
    assert.deepEqual(store.getReceipt(id), receipt);
    assert.equal(store.getReceipt('cj_missing'), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
