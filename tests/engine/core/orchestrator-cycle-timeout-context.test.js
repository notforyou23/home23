import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'engine/src/core/orchestrator.js'), 'utf8');

test('cycle heartbeat timer is declared outside try so finally can clear it', () => {
  const declaration = source.indexOf('let cycleHeartbeatTimer = null;');
  const tryStart = source.indexOf('\n    try {\n      // Generate run_id');
  const clearCall = source.indexOf('if (cycleHeartbeatTimer) clearInterval(cycleHeartbeatTimer)');

  assert.ok(declaration > 0, 'cycleHeartbeatTimer declaration missing');
  assert.ok(tryStart > declaration, 'cycleHeartbeatTimer must be declared before the cycle try block');
  assert.ok(clearCall > tryStart, 'cycleHeartbeatTimer clear call missing from finally path');
  assert.equal(source.indexOf('let cycleHeartbeatTimer = null;', declaration + 1), -1);
});

test('cycle timeout callback logs phase context for slow-cycle diagnosis', () => {
  assert.match(source, /startCycleTimer\(this\.cycleCount, cycleTimeout, \(cycle, elapsedMs\) => \{/);
  assert.match(source, /\[cycle-phase\] timeout context/);
  assert.match(source, /phaseElapsedMs/);
  assert.match(source, /completedPhases/);
});

test('saveState serializes overlapping saves and fails closed on large sidecar errors', () => {
  assert.match(source, /if \(this\._saveStatePromise\) \{/);
  assert.match(source, /return this\._saveStatePromise;/);
  assert.match(source, /async _saveStateUnlocked\(\) \{/);
  assert.match(source, /REFUSING STATE SAVE — sidecar write failed for large brain/);
  assert.match(source, /reason: 'memory_sidecar_write_failed'/);
});
