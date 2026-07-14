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
  'query-notebook-page',
  'query-notebook-status',
  'query-notebook-progress-event',
  'query-notebook-gap-event',
  'query-notebook-terminal-event',
  'query-notebook-result',
  'query-notebook-export',
  'query-notebook-cancel',
  'query-notebook-history-visibility',
  'query-notebook-action',
  'query-notebook-notification',
  'query-notebook-device-credential',
  'query-notebook-web-session',
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

const QUERY_NOTEBOOK_ENTRY_TRUTH = {
  'query-notebook-page': ['GET', '/home23/api/query/notebook', 'queryNotebookPage'],
  'query-notebook-status': ['GET', '/home23/api/query/operations/:operationId', 'queryNotebookStatus'],
  'query-notebook-progress-event': ['GET', '/home23/api/query/operations/:operationId/events', 'queryProgressEvent'],
  'query-notebook-gap-event': ['GET', '/home23/api/query/operations/:operationId/events', 'queryGapEvent'],
  'query-notebook-terminal-event': ['GET', '/home23/api/query/operations/:operationId/events', 'queryTerminalEvent'],
  'query-notebook-result': ['GET', '/home23/api/query/operations/:operationId/result', 'queryNotebookResult'],
  'query-notebook-export': ['POST', '/home23/api/query/operations/:operationId/export', 'queryNotebookExport'],
  'query-notebook-cancel': ['POST', '/home23/api/query/operations/:operationId/cancel', 'queryNotebookStatus'],
  'query-notebook-history-visibility': ['DELETE', '/home23/api/query/operations/:operationId/history', 'queryNotebookHistoryVisibilityResponse'],
  'query-notebook-action': ['POST', '/home23/api/query/operations/:operationId/actions', 'queryNotebookActionResponse'],
  'query-notebook-notification': ['POST', '/home23/api/query/operations/:operationId/notifications', 'queryNotebookNotificationResponse'],
  'query-notebook-device-credential': ['POST', '/api/device/query-credential', 'queryNotebookDeviceCredential'],
  'query-notebook-web-session': ['POST', '/home23/api/query/session', 'queryNotebookWebSession'],
};

const FORBIDDEN_QUERY_NOTEBOOK_FIELDS = new Set([
  'resultHandle', 'resultArtifact', 'sourcePinDescriptor', 'sourcePinDigest',
  'canonicalRoot', 'mutationBoundaries', 'capability', 'capabilities', 'secret',
  'providerPayload', 'rawProviderPayload', 'sweepOutputs', 'scratchPath', 'path',
  'parameters', 'requestParameters', 'metadata', 'eventJournal', 'events',
  'pgsSession', 'sessionId', 'sourceEvidence', 'sourcePin',
]);

function collectKeys(value, into = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.push(key);
      collectKeys(child, into);
    }
  }
  return into;
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

test('Query notebook manifest entries publish exact protected route truth', () => {
  const manifest = loadManifest();
  assert.equal(manifest.contractVersion, '2026.07.14');
  for (const [id, [method, route, definition]] of Object.entries(QUERY_NOTEBOOK_ENTRY_TRUTH)) {
    const entry = manifest.entries.find((candidate) => candidate.id === id);
    assert.ok(entry, `manifest missing ${id}`);
    assert.equal(entry.method, method, `${id}.method`);
    assert.equal(entry.route, route, `${id}.route`);
    assert.equal(entry.definition, definition, `${id}.definition`);
    assert.equal(entry.schema, 'schemas/query-notebook.schema.json', `${id}.schema`);
    assert.equal(entry.fixture, `fixtures/${id}.json`, `${id}.fixture`);
    assert.equal(entry.auth, 'required', `${id}.auth`);
  }
});

test('Query notebook fixtures are bounded, redacted, strict, and version-consistent', () => {
  const manifest = loadManifest();
  const { createContractValidator } = require('./contract-validator.cjs');
  const validator = createContractValidator(process.cwd());
  const entries = Object.keys(QUERY_NOTEBOOK_ENTRY_TRUTH).map((id) => (
    manifest.entries.find((entry) => entry.id === id)
  ));
  for (const entry of entries) {
    const fixture = loadJson(repoPath('contracts', entry.fixture));
    const forbidden = collectKeys(fixture).filter((key) => FORBIDDEN_QUERY_NOTEBOOK_FIELDS.has(key));
    assert.deepEqual(forbidden, [], `${entry.id} leaks forbidden fields`);
    const topLevelInjection = validator.validateValue(entry, {
      ...fixture,
      resultHandle: `brres_${'x'.repeat(32)}`,
    });
    assert.equal(topLevelInjection.valid, false,
      `${entry.id} schema must reject unknown diagnostic fields`);
  }

  const pageEntry = entries.find((entry) => entry.id === 'query-notebook-page');
  const page = loadJson(repoPath('contracts', pageEntry.fixture));
  const nestedInjection = validator.validateValue(pageEntry, {
    ...page,
    items: [{ ...page.items[0], resultHandle: `brres_${'x'.repeat(32)}` }],
  });
  assert.equal(nestedInjection.valid, false,
    'notebook summary schema must reject resultHandle');
  for (const field of FORBIDDEN_QUERY_NOTEBOOK_FIELDS) {
    assert.equal(validator.validateValue(pageEntry, {
      ...page,
      items: [{ ...page.items[0], [field]: 'forbidden' }],
    }).valid, false, `notebook summary schema must reject ${field}`);
  }

  const statusEntry = entries.find((entry) => entry.id === 'query-notebook-status');
  const status = loadJson(repoPath('contracts', statusEntry.fixture));
  assert.equal(validator.validateValue(statusEntry, {
    ...status,
    operationId: `brop_${'x'.repeat(33)}`,
  }).valid, false, 'operation IDs must have exactly 32 suffix characters');
  assert.equal(validator.validateValue(statusEntry, {
    ...status,
    acceptedAt: '2026-07-13T16:00:00-04:00',
  }).valid, false, 'timestamps must use the runtime canonical UTC-millisecond form');

  const credentialEntry = entries.find((entry) => entry.id === 'query-notebook-device-credential');
  const credential = loadJson(repoPath('contracts', credentialEntry.fixture));
  assert.equal(validator.validateValue(credentialEntry, {
    ...credential,
    credentialId: `qncred_${'x'.repeat(33)}`,
  }).valid, false, 'credential IDs must have exactly 32 suffix characters');

  const notificationEntry = entries.find((entry) => entry.id === 'query-notebook-notification');
  const notification = loadJson(repoPath('contracts', notificationEntry.fixture));
  assert.equal(validator.validateValue(notificationEntry, {
    ...notification,
    routeId: `qroute_${'x'.repeat(33)}`,
  }).valid, false, 'notification route IDs must have exactly 32 suffix characters');

  const result = loadJson(repoPath('contracts/fixtures/query-notebook-result.json'));
  assert.equal(page.omittedIncompatibleCount, 1);
  const legacy = page.items.find(item => item.configuration?.legacy === true);
  assert.ok(legacy, 'page fixture must publish one display-only legacy PGS row');
  assert.equal(legacy.configuration.pgsLevel, 'legacy');
  assert.equal(result.projection.nodesRetained, 80);
  assert.equal(result.answerQuality.state, 'substantial');
  assert.equal(result.answerQuality.requestedMode, 'dive');
  const visibility = loadJson(
    repoPath('contracts/fixtures/query-notebook-history-visibility.json'),
  );
  assert.equal(visibility.hidden, true);
  assert.match(visibility.operationId, /^brop_[A-Za-z0-9_-]{32}$/);
  const resultSummary = page.items.find(item => item.operationId === result.operationId);
  assert.ok(resultSummary, 'page fixture must include the protected Direct result summary');
  assert.match(resultSummary.resultVersion, /^qrv1_[A-Za-z0-9_-]{43}$/);
  assert.equal(resultSummary.resultVersion, result.resultVersion,
    'summary and protected result must identify the same bounded resultVersion');
  const resultEntry = entries.find((entry) => entry.id === 'query-notebook-result');
  assert.equal(validator.validateValue(resultEntry, {
    ...result,
    resultVersion: `qrv1_${'x'.repeat(44)}`,
  }).valid, false, 'result versions must have exactly 43 suffix characters');
});

test('Query notebook schemas reuse one strict progress snapshot v1 definition', () => {
  const schema = loadJson(repoPath('contracts/schemas/query-notebook.schema.json'));
  const progress = schema.$defs.queryProgressSnapshotV1;
  assert.equal(progress.additionalProperties, false);
  assert.deepEqual(progress.required, ['version', 'stage', 'eventSequence']);
  assert.equal(progress.properties.version.const, 1);
  assert.equal(schema.$defs.queryProgressEvent.properties.progress.$ref,
    '#/$defs/queryProgressSnapshotV1');
  assert.equal(schema.$defs.queryNotebookSummary.properties.progress.oneOf[0].$ref,
    '#/$defs/queryProgressSnapshotV1');
  assert.equal(schema.$defs.querySnapshotEvent.properties.progress.oneOf[0].$ref,
    '#/$defs/queryProgressSnapshotV1');
});
