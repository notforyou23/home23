import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PursuitStore } from '../../../engine/src/agency/pursuit-store.js';

test('PursuitStore lists recent inbox rows without loading the whole ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-store-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  for (let i = 0; i < 40; i += 1) {
    store.appendInbox({ id: `inbox-${i}`, summary: `entry ${i}` });
  }

  const rows = store.listInbox({ limit: 5 });

  assert.deepEqual(rows.map((row) => row.id), ['inbox-39', 'inbox-38', 'inbox-37', 'inbox-36', 'inbox-35']);
});

// ── pursuits ledger disease (2026-07-17): diet + door ─────────────────
// jerry's pursuits.jsonl hit 661MB (> V8 string limit — killed bus init at
// boot). Causes: unbounded evidence arrays, linkedEvidence serialized as a
// full duplicate of evidence in every record, and no-change merges appending
// a full re-serialization. These tests pin the cure.

function lastDiskRow(store) {
  const { readFileSync } = require('node:fs');
  const lines = readFileSync(store.pursuitsPath, 'utf8').trim().split('\n');
  return { count: lines.length, row: JSON.parse(lines[lines.length - 1]) };
}
const require = (await import('node:module')).createRequire(import.meta.url);

test('diet: persisted records cap evidence and never duplicate it as linkedEvidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-diet-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  const created = store.createPursuit({ summary: 'diet pursuit', evidence: [] }, { route: 'active', reason: 'test' });
  const evidence = Array.from({ length: 60 }, (_, i) => ({ at: `t${i}`, note: `obs ${i}` }));
  store.updatePursuit(created.id, { evidence, linkedEvidence: evidence }, { type: 'merged', reason: 'test' });

  const { row } = lastDiskRow(store);
  assert.ok(row.pursuit.evidence.length <= 40, `evidence must be capped, got ${row.pursuit.evidence.length}`);
  assert.equal(row.pursuit.evidence[row.pursuit.evidence.length - 1].note, 'obs 59', 'cap keeps the NEWEST evidence');
  assert.equal('linkedEvidence' in row.pursuit, false, 'linkedEvidence must never be serialized to disk');

  // a fresh store (cold load) must still expose linkedEvidence to the kernel
  const reloaded = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  const pursuit = reloaded.getPursuit(created.id);
  assert.ok(Array.isArray(pursuit.linkedEvidence), 'linkedEvidence rehydrated on load');
  assert.deepEqual(pursuit.linkedEvidence, pursuit.evidence, 'rehydrated as alias of evidence');
});

test('door: a merge that changes nothing material appends no ledger line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-door-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  const created = store.createPursuit(
    { summary: 'door pursuit', evidence: [{ note: 'first' }] },
    { route: 'active', reason: 'test' },
  );
  const existing = store.getPursuit(created.id);
  store.mergeSeen(existing, { evidence: [{ note: 'first' }] }, { reason: 'same thing again' });
  const before = lastDiskRow(store).count;

  // identical evidence again — a tick, not an event
  store.mergeSeen(store.getPursuit(created.id), { evidence: [{ note: 'first' }] }, { reason: 'still the same' });
  assert.equal(lastDiskRow(store).count, before, 'no-change merge must not append');

  // genuinely new evidence IS an event
  store.mergeSeen(store.getPursuit(created.id), { evidence: [{ note: 'second' }] }, { reason: 'new observation' });
  assert.equal(lastDiskRow(store).count, before + 1, 'new evidence must append');
  const pursuit = store.getPursuit(created.id);
  assert.equal(pursuit.evidence.length, 2);
});

test('door: status transitions still append (material change)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-transition-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  const created = store.createPursuit({ summary: 'transition pursuit' }, { route: 'active', reason: 'test' });
  const before = lastDiskRow(store).count;
  store.transition(created.id, { status: 'closed', reason: 'done' });
  assert.equal(lastDiskRow(store).count, before + 1);
  assert.equal(store.getPursuit(created.id).status, 'closed');
});

// ── boot compaction (2026-07-18): the ledger regrows ~4-5MB/day ───────
// Only the latest row per pursuit id is live state; history is dead weight.
// The external drain script needs the engine stopped, so the store compacts
// itself at boot (before any appends — no writer race in-process).

test('compaction: below-threshold ledger is untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-compact-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  store.createPursuit({ summary: 'small ledger pursuit' }, { route: 'active', reason: 'test' });
  const { statSync } = require('node:fs');
  const before = statSync(store.pursuitsPath).size;

  const report = store.compactLedgerIfBloated(); // default threshold is MBs

  assert.equal(report.compacted, false);
  assert.equal(statSync(store.pursuitsPath).size, before);
});

test('compaction: bloated ledger keeps only the latest row per pursuit and drops orphans', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-pursuit-compact-'));
  const store = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  const a = store.createPursuit({ summary: 'pursuit a' }, { route: 'active', reason: 'test' });
  store.updatePursuit(a.id, { currentTheory: 'first revision' }, { type: 'merged', reason: 'test' });
  store.updatePursuit(a.id, { currentTheory: 'final revision' }, { type: 'status_changed', reason: 'test' });
  const b = store.createPursuit({ summary: 'pursuit b' }, { route: 'watch', reason: 'test' });
  const { appendFileSync, readFileSync, existsSync } = require('node:fs');
  appendFileSync(store.pursuitsPath, `${JSON.stringify({ type: 'noise', note: 'row without pursuit id' })}\n`);

  const report = store.compactLedgerIfBloated({ minBytes: 1 });

  assert.equal(report.compacted, true);
  assert.equal(report.pursuits, 2);
  assert.equal(report.orphanRowsDropped, 1);
  assert.ok(report.afterBytes < report.beforeBytes);
  const rows = readFileSync(store.pursuitsPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  const rowA = rows.find((row) => row.pursuit.id === a.id);
  const rowB = rows.find((row) => row.pursuit.id === b.id);
  assert.ok(rowA && rowB);
  assert.equal(rowA.pursuit.currentTheory, 'final revision');
  assert.equal(rowA.type, 'status_changed');
  assert.ok(!('linkedEvidence' in rowA.pursuit));
  assert.ok(!existsSync(`${store.pursuitsPath}.compact-tmp`));

  // disk truth: a fresh store sees the compacted state
  const reloaded = new PursuitStore({ brainDir: dir, agentName: 'jerry' });
  assert.equal(reloaded.getPursuit(a.id).currentTheory, 'final revision');
  assert.equal(reloaded.getPursuit(b.id).summary, 'pursuit b');
});
