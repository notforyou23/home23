'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { appendSeedProjectionOnce } = require('../../shared/seed-source-projection.cjs');
function fixture(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-source-projection-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'events.jsonl'); }
const event = () => ({ event_id: crypto.randomUUID(), event_type: 'LearningDecisionObserved', ts: '2026-10-29T20:00:00Z', payload: { source: 'fixture', text: 'A continuing decision.' } });
test('fresh UUID projection does constant source reads; retries remain exact and conflicting identities are refused', t => {
  const file = fixture(t);
  fs.writeFileSync(file, Array.from({ length: 5000 }, (_, i) => JSON.stringify({ event_id: `old:${i}`, payload: 'x'.repeat(100) }) + '\n').join(''));
  const next = event(); const read = fs.readSync; let bytes = 0;
  fs.readSync = (...args) => { const result = read(...args); bytes += result; return result; };
  try { appendSeedProjectionOnce(file, next, { newUnique: true }); } finally { fs.readSync = read; }
  assert.equal(bytes, 1, 'normal decisions never scan old event history');
  const after = fs.readFileSync(file, 'utf8');
  appendSeedProjectionOnce(file, next);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.throws(() => appendSeedProjectionOnce(file, { ...next, payload: { changed: true } }), /identity conflicts/);
});
test('append-before-fsync failure is recoverable without duplicate source events', t => {
  const file = fixture(t), next = event();
  const sync = fs.fsyncSync; let fail = true;
  fs.fsyncSync = (...args) => { if (fail) { fail = false; throw new Error('fixture durability unavailable'); } return sync(...args); };
  try { assert.throws(() => appendSeedProjectionOnce(file, next, { newUnique: true }), /durability unavailable/); } finally { fs.fsyncSync = sync; }
  const existing = fs.readFileSync(file, 'utf8');
  let barriers = 0; fs.fsyncSync = (...args) => { barriers++; return sync(...args); };
  try { appendSeedProjectionOnce(file, next); } finally { fs.fsyncSync = sync; }
  assert.equal(fs.readFileSync(file, 'utf8'), existing);
  assert.equal(barriers, 2, 'an existing line is fsynced along with its directory before retry is acknowledged');
});
test('fresh and retried projections both preserve a torn historical tail', t => {
  const file = fixture(t); fs.writeFileSync(file, '{"interrupted":');
  const before = fs.readFileSync(file, 'utf8');
  assert.throws(() => appendSeedProjectionOnce(file, event(), { newUnique: true }), /incomplete tail/);
  assert.throws(() => appendSeedProjectionOnce(file, event()), /incomplete tail/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
