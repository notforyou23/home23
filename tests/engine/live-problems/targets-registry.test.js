import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TargetsRegistry } = require('../../../engine/src/live-problems/registry.js');

test('targets registry allows sibling-agent notification signal files', () => {
  const registry = new TargetsRegistry();

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

test('targets registry allows Forrest PM2 and dashboard targets', () => {
  const registry = new TargetsRegistry();

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
