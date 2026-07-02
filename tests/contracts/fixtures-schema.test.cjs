const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REQUIRED_ENTRY_IDS = [
  'agent-roster',
  'client-capabilities',
  'chat-turn-start',
  'chat-turn-event',
  'chat-turn-envelope-pending',
  'chat-turn-envelope-complete',
  'chat-turn-envelope-error',
  'chat-turn-status',
  'chat-stop-turn-request',
  'chat-stop-turn-response',
  'chat-stop-turn-error-response',
  'chat-models',
  'chat-pending',
  'chat-conversations',
  'chat-history',
  'settings-status',
  'settings-scope',
  'settings-models',
  'settings-query',
  'query-catalog',
  'query-result',
  'query-export',
  'query-stream-event',
  'home-surfaces',
  'home-tile-action',
  'home-tile-action-dry-run-response',
  'home-tile-action-response',
  'sauna-tile',
  'device-register-request',
  'device-register-response',
  'device-unregister-request',
  'device-unregister-response',
  'device-registry',
  'worker-agents',
];

function repoPath(...parts) {
  return path.join(process.cwd(), ...parts);
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadManifest() {
  return loadJson(repoPath('contracts', 'manifest.json'));
}

test('contracts manifest exists and covers Apple-consumed routes', () => {
  const manifest = loadManifest();
  assert.equal(typeof manifest.contractVersion, 'string');
  assert.ok(Array.isArray(manifest.entries), 'manifest.entries must be an array');

  const ids = manifest.entries.map((entry) => entry.id);
  assert.deepEqual(new Set(ids).size, ids.length, 'manifest entry ids must be unique');

  for (const requiredId of REQUIRED_ENTRY_IDS) {
    assert.ok(ids.includes(requiredId), `manifest missing ${requiredId}`);
  }

  for (const entry of manifest.entries) {
    assert.equal(typeof entry.id, 'string', 'entry.id is required');
    assert.equal(typeof entry.method, 'string', `${entry.id}.method is required`);
    assert.equal(typeof entry.route, 'string', `${entry.id}.route is required`);
    assert.equal(typeof entry.schema, 'string', `${entry.id}.schema is required`);
    assert.equal(typeof entry.definition, 'string', `${entry.id}.definition is required`);
    assert.equal(typeof entry.fixture, 'string', `${entry.id}.fixture is required`);
    assert.equal(typeof entry.liveValidation, 'string', `${entry.id}.liveValidation is required`);
    assert.ok(['none', 'optional', 'required'].includes(entry.auth), `${entry.id}.auth must be declared`);
    assert.ok(Array.isArray(entry.consumers) && entry.consumers.length > 0, `${entry.id}.consumers is required`);
    assert.ok(fs.existsSync(repoPath('contracts', entry.schema)), `${entry.id} schema missing: ${entry.schema}`);
    assert.ok(fs.existsSync(repoPath('contracts', entry.fixture)), `${entry.id} fixture missing: ${entry.fixture}`);
  }
});

test('contract fixtures validate against their manifest schemas', () => {
  const manifest = loadManifest();
  const { createContractValidator } = require('./contract-validator.cjs');
  const validator = createContractValidator(process.cwd());

  for (const entry of manifest.entries) {
    const result = validator.validateFixture(entry);
    assert.equal(result.valid, true, `${entry.id} fixture failed schema validation:\n${result.errorsText}`);
  }
});
