import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TargetsRegistry } = require('../../../engine/src/live-problems/registry.js');

function testRegistry(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-targets-registry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const filePath = path.join(root, 'targets.yaml');
  fs.writeFileSync(filePath, JSON.stringify({
    files: [
      { path: '/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/actions.jsonl' },
      { path: '/Users/jtr/_JTR23_/release/home23/instances/forrest/brain/actions.jsonl' },
      { path: '/Users/jtr/_JTR23_/release/home23/instances/forrest/brain/signals.jsonl' },
      { path: '/Users/jtr/_JTR23_/release/home23/instances/forrest/conversations/cron-jobs.json' },
    ],
    urls: [],
    pm2: [{ name: 'home23-forrest' }],
    mounts: [],
    sensors: [],
  }));
  return new TargetsRegistry({ filePath });
}

test('targets registry allows sibling-agent notification signal files', (t) => {
  const registry = testRegistry(t);

  assert.deepEqual(
    registry.validateVerifier({
      type: 'jsonl_recent_match',
      args: {
        path: '/Users/jtr/_JTR23_/release/home23/instances/forrest/brain/signals.jsonl',
        tsField: 'ts',
        matchField: 'type',
        matchValue: 'notification',
        minCount: 1,
      },
    }),
    { ok: true },
  );

  assert.deepEqual(
    registry.validateVerifier({
      type: 'jsonl_recent_match',
      args: {
        path: '/Users/jtr/_JTR23_/release/home23/instances/forrest/brain/actions.jsonl',
        tsField: 'timestamp',
        matchField: 'type',
        matchValue: 'notification',
        minCount: 1,
      },
    }),
    { ok: true },
  );
});

test('targets registry rejects action-ledger freshness checks but allows specific receipt lookups', (t) => {
  const registry = testRegistry(t);

  assert.deepEqual(
    registry.validateVerifier({
      type: 'file_mtime',
      args: { path: '/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/actions.jsonl', maxAgeMin: 337 },
    }),
    {
      ok: false,
      reason: 'actions.jsonl is event-driven; use file_exists plus thoughts freshness, not file_mtime: /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/actions.jsonl',
    },
  );

  assert.deepEqual(
    registry.validateVerifier({
      type: 'jsonl_recent_match',
      args: { path: '/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/actions.jsonl', tsField: 'timestamp', windowMinutes: 337, minCount: 1 },
    }),
    {
      ok: false,
      reason: 'actions.jsonl is event-driven; jsonl_recent_match needs matchField for a specific action receipt: /Users/jtr/_JTR23_/release/home23/instances/jerry/brain/actions.jsonl',
    },
  );

  assert.deepEqual(
    registry.validateVerifier({
      type: 'jsonl_recent_match',
      args: {
        path: '/Users/jtr/_JTR23_/release/home23/instances/jerry/brain/actions.jsonl',
        tsField: 'timestamp',
        matchField: 'action',
        matchValue: 'write_note',
        minCount: 1,
      },
    }),
    { ok: true },
  );
});

test('targets registry allows Forrest PM2 and dashboard targets', (t) => {
  const registry = testRegistry(t);

  assert.deepEqual(
    registry.validateVerifier({
      type: 'pm2_status',
      args: { name: 'home23-forrest' },
    }),
    { ok: true },
  );

  assert.deepEqual(
    registry.validateVerifier({
      type: 'http_ping',
      args: { url: 'http://localhost:5012/api/live-problems' },
    }),
    { ok: true },
  );
});

test('targets registry allows cron job error verifiers for known agent cron state', (t) => {
  const registry = testRegistry(t);

  assert.deepEqual(
    registry.validateVerifier({
      type: 'cron_job_errors',
      args: {
        path: '/Users/jtr/_JTR23_/release/home23/instances/forrest/conversations/cron-jobs.json',
        maxConsecutiveErrors: 1,
      },
    }),
    { ok: true },
  );
});
