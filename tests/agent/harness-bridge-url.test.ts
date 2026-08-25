import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHarnessBridgePort, resolveHarnessBridgeUrl } from '../../src/agent/harness-bridge-url.js';

test('resolveHarnessBridgePort prefers HOME23_BRIDGE_PORT then BRIDGE_PORT', () => {
  assert.equal(resolveHarnessBridgePort({}), '5004');
  assert.equal(resolveHarnessBridgePort({ BRIDGE_PORT: '5034' }), '5034');
  assert.equal(resolveHarnessBridgePort({ HOME23_BRIDGE_PORT: '5034', BRIDGE_PORT: '5004' }), '5034');
});

test('resolveHarnessBridgeUrl uses ctx first so a non-primary agent cannot hit Jerry\'s 5004', () => {
  assert.equal(
    resolveHarnessBridgeUrl({ workerConnectorBaseUrl: 'http://127.0.0.1:5034' }, { BRIDGE_PORT: '5004' }),
    'http://127.0.0.1:5034',
  );
  assert.equal(
    resolveHarnessBridgeUrl({}, { BRIDGE_PORT: '5034' }),
    'http://127.0.0.1:5034',
  );
  assert.equal(
    resolveHarnessBridgeUrl({}, {}),
    'http://127.0.0.1:5004',
  );
});
