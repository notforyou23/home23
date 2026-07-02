const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const express = require('express');
const { createContractValidator, loadJson } = require('./contract-validator.cjs');

const {
  buildClientCapabilities,
  registerClientCapabilitiesRoute,
} = require('../../engine/src/dashboard/client-capabilities.js');

test('client capabilities payload validates and advertises platform truth', () => {
  const payload = buildClientCapabilities({
    packageVersion: '0.6.0',
    generatedAt: '2026-06-26T14:28:00Z',
  });
  const manifest = loadJson('contracts/manifest.json');
  const entry = manifest.entries.find((item) => item.id === 'client-capabilities');
  assert.ok(entry, 'manifest must include client-capabilities');

  const validator = createContractValidator(process.cwd());
  const result = validator.validateValue(entry, payload);
  assert.equal(result.valid, true, result.errorsText);

  assert.equal(payload.platforms.ios.query, true);
  assert.equal(payload.platforms.mac.query, true);
  assert.equal(payload.platforms.tvos.query, false);
  assert.equal(payload.platforms.tvos.settings, false);
  assert.equal(payload.houseGlobal.sauna, true);
  assert.equal(payload.features.queryStreaming, false);
  assert.equal(payload.query.facade, true);
  assert.equal(payload.query.directCosmo, false);
  assert.equal(payload.query.streaming, false);
  assert.equal(payload.endpoints.queryCatalog, '/home23/api/query/catalog');
  assert.equal(payload.endpoints.workers, '/home23/api/workers');
  assert.equal(payload.endpoints.chatTurnStatus, '/api/chat/turn-status');
});

test('client capabilities route returns the contract payload', async (t) => {
  const app = express();
  registerClientCapabilitiesRoute(app, {
    packageVersion: '0.6.0',
    generatedAt: '2026-06-26T14:28:00Z',
  });
  const server = http.createServer(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/home23/api/client-capabilities`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.contractVersion, '2026.06.26');
  assert.equal(payload.features.chatTurnStatus, true);
  assert.equal(payload.endpoints.deviceRegister, '/api/device/register');
});
