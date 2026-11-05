import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { writeWorkerReceipt } from '../../src/workers/receipts.js';
import type { WorkerRunReceipt } from '../../src/workers/types.js';
import {
  LEGACY_EMBEDDING_PROFILE,
  LEGACY_EMBEDDING_RECIPE_ID,
} from '../../src/substrate/semantic-writer-stamp.js';

function receipt(runId = 'wr_20260502_143000_systems_ab12'): WorkerRunReceipt {
  return {
    schema: 'home23.worker-run.v1',
    runId,
    worker: 'systems',
    ownerAgent: 'jerry',
    requestedBy: 'live-problems',
    startedAt: '2026-05-02T14:30:00.000Z',
    finishedAt: '2026-05-02T14:42:00.000Z',
    status: 'fixed',
    verifierStatus: 'pass',
    summary: 'Scoped process check passed.',
    rootCause: 'Dashboard process needed scoped restart.',
    actions: [{ type: 'pm2_restart', target: 'home23-jerry-dash' }],
    evidence: [{ type: 'http', detail: 'GET /api/state returned 200', status: 'pass' }],
    artifacts: ['instances/workers/systems/runs/wr_20260502_143000_systems_ab12/transcript.md'],
    memoryCandidates: [{ text: 'Dashboard state checks should use port 5002.', confidence: 0.9, appliesTo: ['dashboard'] }]
  };
}

test('writeWorkerReceipt writes run receipt, owner workspace markdown, and brain jsonl', () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), 'home23-receipts-'));
  const runPath = path.join(projectRoot, 'instances', 'workers', 'systems', 'runs', receipt().runId);
  const written = writeWorkerReceipt(projectRoot, runPath, receipt());

  assert.equal(existsSync(written.receiptPath), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'jerry', 'workspace', 'worker-runs', `${receipt().runId}.md`)), true);
  assert.equal(existsSync(path.join(projectRoot, 'instances', 'jerry', 'brain', 'worker-runs.jsonl')), true);

  const brainPath = path.join(projectRoot, 'instances', 'jerry', 'brain', 'worker-runs.jsonl');
  const oldLine = JSON.stringify({
    schema: 'home23.worker-run-memory.v1',
    runId: 'wr_old_unstamped',
    summary: 'historical receipt without a recipe stamp',
  });
  const writtenBrain = readFileSync(brainPath, 'utf8');
  writeFileSync(brainPath, `${oldLine}\n${writtenBrain}`);
  writeWorkerReceipt(projectRoot, path.join(projectRoot, 'instances', 'workers', 'systems', 'runs', 'wr_second'), {
    ...receipt('wr_20260502_150000_systems_cd34'),
    runId: 'wr_20260502_150000_systems_cd34',
  });

  const lines = readFileSync(brainPath, 'utf8').trim().split('\n');
  assert.equal(lines[0], oldLine, 'old worker-run bytes stay unstamped');
  const parsed = JSON.parse(lines[1]!);
  assert.equal(parsed.runId, receipt().runId);
  assert.equal(parsed.summary, 'Scoped process check passed.');
  assert.equal(parsed.transcriptIncluded, false);
  assert.equal(parsed.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
  assert.equal(parsed.semantic_encoder, LEGACY_EMBEDDING_PROFILE);
  const newest = JSON.parse(lines[lines.length - 1]!);
  assert.equal(newest.runId, 'wr_20260502_150000_systems_cd34');
  assert.equal(newest.semantic_recipe_id, LEGACY_EMBEDDING_RECIPE_ID);
  if (newest.semantic_vector) assert.equal(newest.semantic_absence, undefined);
  else assert.equal(newest.semantic_absence, 'unavailable');
});
