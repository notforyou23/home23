/**
 * Dream provenance receipts (2026-08-11): saveDream writes the artifact AND
 * a receipt line into the substrate's dream-events stream — dreamId, bounded
 * head, content sha256 — so the Seed's chain anchors the prose at birth.
 * Pins: correct hash; head bounded + whitespace-normalized; no substrate
 * dir → artifact still saved, no receipt, no error (degraded-honest).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const crypto = require('node:crypto');

const { Orchestrator } = require('../../../engine/src/core/orchestrator');

function makeHost(withSubstrate) {
  const root = mkdtempSync(join(tmpdir(), 'dream-receipt-'));
  const logsDir = join(root, 'brain');
  mkdirSync(logsDir, { recursive: true });
  if (withSubstrate) mkdirSync(join(root, 'substrate'), { recursive: true });
  const logger = { debug: () => {}, error: (msg) => { throw new Error(`logger.error: ${msg}`); } };
  return { root, logsDir, logger };
}

test('saveDream receipts the content hash + head into the seed diet at birth', async (t) => {
  const host = makeHost(true);
  t.after(() => rmSync(host.root, { recursive: true, force: true }));
  const content = 'The kitchen hummed with a song   that was not\na song — the ghost of 90.5 The Night.';
  const dream = { id: 'dream_test_1', cycle: 42, dreamNumber: 1, model: 'test-model', timestamp: '2026-08-11T11:38:28.279Z', content };

  await Orchestrator.prototype.saveDream.call(host, dream);

  const artifact = readFileSync(join(host.logsDir, 'dreams.jsonl'), 'utf-8').trim();
  assert.ok(artifact.includes('dream_test_1'), 'artifact written');

  const receiptLine = readFileSync(join(host.root, 'substrate', 'dream-events.jsonl'), 'utf-8').trim();
  const receipt = JSON.parse(receiptLine);
  assert.equal(receipt.dreamId, 'dream_test_1');
  assert.equal(receipt.ts, '2026-08-11T11:38:28.279Z', 'event-time is the dream\'s own stamp');
  assert.equal(receipt.contentSha256, crypto.createHash('sha256').update(content, 'utf8').digest('hex'), 'the hash is of the exact prose — T1 anchor');
  assert.equal(receipt.contentLength, content.length);
  assert.equal(receipt.head, 'The kitchen hummed with a song that was not a song — the ghost of 90.5 The Night.', 'head whitespace-normalized and bounded');
  assert.ok(receipt.head.length <= 160);
});

test('no substrate dir → artifact saved, no receipt, no error (degraded-honest)', async (t) => {
  const host = makeHost(false);
  t.after(() => rmSync(host.root, { recursive: true, force: true }));
  await Orchestrator.prototype.saveDream.call(host, {
    id: 'dream_test_2', cycle: 1, dreamNumber: 1, model: 'm', timestamp: '2026-08-11T00:00:00.000Z', content: 'x',
  });
  assert.ok(existsSync(join(host.logsDir, 'dreams.jsonl')), 'artifact still saved');
  assert.ok(!existsSync(join(host.root, 'substrate', 'dream-events.jsonl')), 'no receipt fabricated');
});
