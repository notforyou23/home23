import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  artifactFromPath,
  buildEvidenceReceipt,
  writeEvidenceReceipt,
} = require('../../../engine/src/evidence/evidence-v1.js');

test('artifactFromPath records canonical file bytes with sha256', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-evidence-'));
  const file = join(dir, 'source.json');
  writeFileSync(file, '{"b":2,"a":1}\n', 'utf8');

  const artifact = artifactFromPath(file, { role: 'source_issue' });

  assert.equal(artifact.path, file);
  assert.equal(artifact.role, 'source_issue');
  assert.equal(artifact.sha256, createHash('sha256').update(readFileSync(file)).digest('hex'));
  assert.equal(artifact.bytes, Buffer.byteLength(readFileSync(file)));
});

test('buildEvidenceReceipt marks pass only when every check passes and supports corrections', () => {
  const receipt = buildEvidenceReceipt({
    actor: 'jerry',
    action: 'publish_issue',
    subject: 'from-the-inside/099',
    sourceArtifacts: [],
    derivedArtifacts: [],
    checks: [
      { name: 'source_exists', pass: true },
      { name: 'html_matches_issue', pass: false, detail: 'missing body ending' },
    ],
    correctionOf: 'ev_previous',
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  assert.equal(receipt.receiptVersion, 'evidence.v1');
  assert.equal(receipt.result, 'fail');
  assert.equal(receipt.claimLevel, 'candidate_claim');
  assert.equal(receipt.correctionOf, 'ev_previous');
  assert.match(receipt.receiptId, /^ev_[a-f0-9]{24}$/);
});

test('writeEvidenceReceipt writes pretty JSON and append-only index records the receipt handle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'home23-evidence-write-'));
  const receipt = buildEvidenceReceipt({
    actor: 'jerry',
    action: 'publish_issue',
    subject: 'from-the-inside/099',
    checks: [{ name: 'source_exists', pass: true }],
    createdAt: '2026-05-08T12:00:00.000Z',
  });

  const out = writeEvidenceReceipt({
    receipt,
    receiptPath: join(dir, 'receipts', '099.evidence.json'),
    indexPath: join(dir, 'receipts', 'index.jsonl'),
  });

  const parsed = JSON.parse(readFileSync(out.receiptPath, 'utf8'));
  const indexed = JSON.parse(readFileSync(join(dir, 'receipts', 'index.jsonl'), 'utf8').trim());
  assert.equal(parsed.receiptId, receipt.receiptId);
  assert.equal(indexed.receiptId, receipt.receiptId);
  assert.equal(indexed.path, out.receiptPath);
});
