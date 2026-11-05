import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldAddWorkspaceFeederFallback } = require('../../../engine/src/core/orchestrator');

test('workspace feeder fallback is disabled when explicit watch paths exist', () => {
  assert.equal(
    shouldAddWorkspaceFeederFallback({
      additionalWatchPaths: [
        { path: '/home23/instances/jerry/workspace/sessions', label: 'conversation_sessions' },
      ],
    }),
    false
  );
});

test('workspace feeder fallback remains enabled for legacy configs without explicit paths', () => {
  assert.equal(shouldAddWorkspaceFeederFallback({}), true);
  assert.equal(shouldAddWorkspaceFeederFallback({ additionalWatchPaths: [] }), true);
});
