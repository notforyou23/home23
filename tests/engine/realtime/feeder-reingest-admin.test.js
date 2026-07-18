import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RealtimeServer } = require('../../../engine/src/realtime/websocket-server.js');
const { IngestionManifest } = require('../../../engine/src/ingestion/ingestion-manifest.js');
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder.js');

// A failed conversion is recorded in the manifest with the file's content
// hash, so isStale() reports the file fresh forever — a FIXED converter can
// never get a second look on its own (the MRI Report.pdf sat pinned as
// conversion_failed while the OCR fallback shipped). /admin/feeder/reingest
// is the operator door: drop the entry, run the file through again.

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeRequest({ url, method = 'POST', body = {} }) {
  const req = method === 'GET'
    ? Readable.from([])
    : Readable.from([Buffer.from(JSON.stringify(body), 'utf8')]);
  req.method = method;
  req.url = url;
  return req;
}

function makeResponse() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(payload) {
      this.body = payload || '';
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

test('POST /admin/feeder/reingest drops the entry and reprocesses with the watcher label', async () => {
  const calls = [];
  const server = new RealtimeServer(0, silentLogger);
  server.setOrchestrator({
    feeder: {
      labelForPath: (p) => { calls.push(['labelForPath', p]); return 'vault_health'; },
      removeFile: async (p) => { calls.push(['removeFile', p]); },
      ingestFile: async (p, label) => { calls.push(['ingestFile', p, label]); },
      manifest: { getEntry: () => ({ parseStatus: 'ok', nodeIds: ['n1', 'n2'] }) },
    },
  });

  const res = makeResponse();
  await server._handleFeederAdmin(
    makeRequest({ url: '/admin/feeder/reingest', body: { path: '/vault/health/MRI Report.pdf' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.label, 'vault_health');
  assert.equal(body.parseStatus, 'ok');
  assert.equal(body.nodeCount, 2);
  assert.deepEqual(calls, [
    ['labelForPath', '/vault/health/MRI Report.pdf'],
    ['removeFile', '/vault/health/MRI Report.pdf'],
    ['ingestFile', '/vault/health/MRI Report.pdf', 'vault_health'],
  ]);
});

test('reingest without a path is a 400 and touches nothing', async () => {
  const calls = [];
  const server = new RealtimeServer(0, silentLogger);
  server.setOrchestrator({
    feeder: {
      labelForPath: () => { calls.push('labelForPath'); return 'x'; },
      removeFile: async () => { calls.push('removeFile'); },
      ingestFile: async () => { calls.push('ingestFile'); },
    },
  });

  const res = makeResponse();
  await server._handleFeederAdmin(makeRequest({ url: '/admin/feeder/reingest', body: {} }), res);

  assert.equal(res.statusCode, 400);
  assert.deepEqual(calls, []);
});

test('an explicit label overrides watcher resolution', async () => {
  const calls = [];
  const server = new RealtimeServer(0, silentLogger);
  server.setOrchestrator({
    feeder: {
      labelForPath: () => { calls.push('labelForPath'); return 'wrong'; },
      removeFile: async () => {},
      ingestFile: async (p, label) => { calls.push(['ingestFile', label]); },
      manifest: { getEntry: () => null },
    },
  });

  const res = makeResponse();
  await server._handleFeederAdmin(
    makeRequest({ url: '/admin/feeder/reingest', body: { path: '/docs/a.pdf', label: 'health_documents' } }),
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls, [['ingestFile', 'health_documents']]);
});

test('removeFile clears a quarantined entry so isStale allows the retry', async (t) => {
  const runPath = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-reingest-manifest-'));
  t.after(() => fs.rmSync(runPath, { recursive: true, force: true }));
  const manifest = new IngestionManifest({
    runPath,
    memory: { removeNode() {} },
    embeddingFn: async () => null,
    config: {},
    logger: silentLogger,
  });
  const filePath = '/vault/health/MRI Report.pdf';
  const hash = 'a'.repeat(64);
  await manifest.trackQuarantined(filePath, 'vault_health', hash, {
    status: 'conversion_failed',
    issues: ['conversion produced empty text'],
    structuralSignature: null,
  });
  assert.equal(await manifest.isStale(filePath, hash), false, 'pinned by the recorded hash');

  await manifest.removeFile(filePath);

  assert.equal(manifest.getEntry(filePath), null);
  assert.equal(await manifest.isStale(filePath, hash), true, 'retry allowed after forget');
});

test('labelForPath resolves the covering watcher, deepest root wins, fallback is parent dir', () => {
  const feeder = new DocumentFeeder({
    memory: { embed: async () => null },
    config: {},
    logger: silentLogger,
  });
  feeder._watchers.push({ path: '/Users/x/vault', label: 'vault', watcher: null });
  feeder._watchers.push({ path: '/Users/x/vault/health', label: 'vault_health', watcher: null });

  assert.equal(feeder.labelForPath('/Users/x/vault/health/MRI.pdf'), 'vault_health');
  assert.equal(feeder.labelForPath('/Users/x/vault/notes/a.md'), 'vault');
  assert.equal(feeder.labelForPath('/elsewhere/health_jtr/doc.pdf'), 'health_jtr');
});
