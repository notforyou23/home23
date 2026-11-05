import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const { BrainOperationStore } = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const {
  createBrainOperationStoreReader,
} = require('../../../engine/src/dashboard/brain-operations/store-reader.js');
const {
  authorizeStoredResultExport,
  createBrainOperationExporter,
} = require('../../../engine/src/dashboard/brain-operations/exporter.js');
const { canonicalJson } = require('../../../shared/brain-operations/canonical-json.cjs');

const NOW = Date.parse('2026-07-10T16:00:00.000Z');
const RESULT_HANDLE = `brres_${'A'.repeat(32)}`;

function hasCode(code) {
  return (error) => error?.code === code;
}

function boundaries(homeRoot, agent = 'jerry') {
  const brain = path.join(homeRoot, 'instances', agent, 'brain');
  return [
    { kind: 'brain', path: brain },
    { kind: 'run', path: brain },
    { kind: 'pgs', path: path.join(brain, 'pgs-sessions') },
    { kind: 'session', path: path.join(brain, 'sessions') },
    { kind: 'cache', path: path.join(brain, 'cache') },
    { kind: 'export', path: path.join(brain, 'exports') },
    { kind: 'agency', path: path.join(brain, 'agency') },
  ];
}

function validTarget(homeRoot, overrides = {}) {
  const brain = path.join(homeRoot, 'instances', 'jerry', 'brain');
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot: brain,
    accessMode: 'own',
    ownerAgent: 'jerry',
    displayName: 'Jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: boundaries(homeRoot),
    ...overrides,
  };
}

function fakeRecord(overrides = {}) {
  return {
    operationId: `brop_${'B'.repeat(32)}`,
    operationType: 'query',
    requesterAgent: 'jerry',
    state: 'complete',
    canonicalEvidence: true,
    result: { answer: 'stored' },
    resultHandle: null,
    resultArtifact: null,
    resultExpiredAt: null,
    target: { domain: 'requester', requesterAgent: 'jerry' },
    ...overrides,
  };
}

function makeHomeFixture(t) {
  const home23Root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'home23-brain-export-')));
  for (const relative of [
    'instances/jerry/brain',
    'instances/jerry/runtime',
    'instances/jerry/workspace',
  ]) fs.mkdirSync(path.join(home23Root, relative), { recursive: true });
  const operationsRoot = path.join(home23Root, 'instances/jerry/runtime/brain-operations');
  const store = new BrainOperationStore({
    root: operationsRoot,
    requesterAgent: 'jerry',
    now: () => NOW,
  });
  const reader = createBrainOperationStoreReader({
    operationsRoot,
    expectedRequester: 'jerry',
    liveStore: store,
  });
  let randomCounter = 1;
  const exporter = createBrainOperationExporter({
    home23Root,
    requesterAgent: 'jerry',
    reader,
    now: () => NOW,
    randomBytes(size) {
      const output = Buffer.alloc(size, randomCounter);
      randomCounter += 1;
      return output;
    },
  });
  t.after(() => fs.rmSync(home23Root, { recursive: true, force: true }));
  return { home23Root, operationsRoot, store, reader, exporter };
}

async function createOperation(fixture, overrides = {}) {
  return fixture.store.create({
    requestId: overrides.requestId || `request-${crypto.randomBytes(6).toString('hex')}`,
    requesterAgent: 'jerry',
    target: validTarget(fixture.home23Root),
    operationType: overrides.operationType || 'query',
    requestParameters: overrides.requestParameters || { query: 'canary' },
    parameters: overrides.parameters || { query: 'canary' },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: overrides.canonicalEvidence ?? true,
  });
}

async function createJsonResult(fixture, result, overrides = {}) {
  const created = await createOperation(fixture, overrides);
  const stored = await fixture.store.setResult(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    result,
  });
  const terminal = await fixture.store.transition(created.record.operationId, {
    expectedVersion: stored.recordVersion,
    state: overrides.state || 'complete',
  });
  return terminal;
}

async function createGraphResult(fixture, source) {
  const created = await createOperation(fixture, {
    operationType: 'graph_export',
    requestParameters: { format: 'jsonl' },
    parameters: { format: 'jsonl' },
  });
  const scratch = await fixture.store.ensureScratchDirectory(created.record.operationId);
  const scratchPath = path.join(scratch, 'graph.jsonl');
  fs.writeFileSync(scratchPath, source);
  const adopted = await fixture.store.adoptResultArtifact(created.record.operationId, {
    expectedVersion: created.record.recordVersion,
    scratchPath,
    mediaType: 'application/x-ndjson',
    contentEncoding: 'identity',
    bytes: Buffer.byteLength(source),
    sha256: crypto.createHash('sha256').update(source).digest('hex'),
  });
  return fixture.store.transition(created.record.operationId, {
    expectedVersion: adopted.recordVersion,
    state: 'complete',
  });
}

function treeSnapshot(root) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  function walk(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full, { bigint: true });
      const row = {
        path: path.relative(root, full),
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        mode: Number(stat.mode),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
      };
      if (entry.isFile()) row.sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      if (entry.isSymbolicLink()) row.target = fs.readlinkSync(full);
      rows.push(row);
      if (entry.isDirectory()) walk(full);
    }
  }
  walk(root);
  return rows;
}

function receiptPath(fixture, exportHandle) {
  return path.join(
    fixture.home23Root,
    'instances/jerry/runtime/brain-export-receipts',
    `${exportHandle}.json`,
  );
}

function exportPath(fixture, receipt) {
  return path.join(fixture.home23Root, 'instances/jerry', receipt.relativePath);
}

test('stored result export authorization is requester, terminal, and canonical-evidence bound', () => {
  const record = fakeRecord();
  assert.equal(authorizeStoredResultExport(record, 'jerry').domain, 'brain');
  assert.throws(
    () => authorizeStoredResultExport({ ...record, requesterAgent: 'forrest' }, 'jerry'),
    hasCode('access_denied'),
  );
  for (const state of ['queued', 'running']) {
    assert.throws(
      () => authorizeStoredResultExport({ ...record, state }, 'jerry'),
      hasCode('operation_not_terminal'),
    );
  }
  assert.throws(
    () => authorizeStoredResultExport({ ...record, canonicalEvidence: false }, 'jerry'),
    hasCode('canonical_export_required'),
  );
  assert.throws(
    () => authorizeStoredResultExport({ ...record, operationType: 'ad_hoc_export' }, 'jerry'),
    hasCode('canonical_export_required'),
  );
});

test('authenticated live reader binds requester and fails closed on a foreign injected row', async () => {
  const own = fakeRecord({ state: 'running' });
  const foreign = { ...own, operationId: `brop_${'C'.repeat(32)}`, requesterAgent: 'forrest' };
  const store = {
    async get() { return own; },
    async listNonterminal() { return [own, foreign]; },
    async getResult() { return { answer: 'stored' }; },
    async openResultArtifact() { throw new Error('not used'); },
  };
  const reader = createBrainOperationStoreReader({
    operationsRoot: '/runtime/brain-operations',
    expectedRequester: 'jerry',
    liveStore: store,
  });
  assert.equal((await reader.getAuthorized(own.operationId)).requesterAgent, 'jerry');
  await assert.rejects(() => reader.listNonterminalAuthorized(), hasCode('access_denied'));
  store.get = async () => foreign;
  await assert.rejects(() => reader.getAuthorized(foreign.operationId), hasCode('access_denied'));
});

test('authenticated reader rejects malformed injected operation identities', async () => {
  const malformed = fakeRecord({ operationId: 'not-an-operation-id', state: 'running' });
  const store = {
    async get() { return malformed; },
    async listNonterminal() { return [malformed]; },
    async getResult() { throw new Error('not used'); },
    async openResultArtifact() { throw new Error('not used'); },
  };
  const reader = createBrainOperationStoreReader({
    operationsRoot: '/runtime/brain-operations', expectedRequester: 'jerry', liveStore: store,
  });
  await assert.rejects(
    () => reader.getAuthorized(`brop_${'B'.repeat(32)}`),
    hasCode('operation_corrupt'),
  );
  await assert.rejects(() => reader.listNonterminalAuthorized(), hasCode('operation_corrupt'));
});

test('reader checks every supplied handle, including inline results, before loading bytes', async () => {
  const inline = fakeRecord();
  const fileBacked = fakeRecord({
    result: null,
    resultHandle: RESULT_HANDLE,
    resultArtifact: {
      mediaType: 'application/json', contentEncoding: 'identity', bytes: 10, sha256: '0'.repeat(64),
    },
  });
  let record = inline;
  const calls = [];
  const store = {
    async get() { return record; },
    async listNonterminal() { return []; },
    async getResult(_operationId, input) { calls.push(input); return { answer: 'stored' }; },
    async openResultArtifact() { throw new Error('not used'); },
  };
  const reader = createBrainOperationStoreReader({
    operationsRoot: '/runtime/brain-operations', expectedRequester: 'jerry', liveStore: store,
  });
  assert.deepEqual(await reader.getResultAuthorized(inline.operationId), { answer: 'stored' });
  await assert.rejects(
    () => reader.getResultAuthorized(inline.operationId, RESULT_HANDLE),
    hasCode('result_handle_invalid'),
  );
  record = fileBacked;
  assert.deepEqual(await reader.getResultAuthorized(fileBacked.operationId), { answer: 'stored' });
  assert.equal(calls.at(-1).resultHandle, RESULT_HANDLE);
  await assert.rejects(
    () => reader.getResultAuthorized(fileBacked.operationId, `brres_${'Z'.repeat(32)}`),
    hasCode('result_handle_invalid'),
  );
});

test('disk-only reader performs status, list, JSON result, and artifact reads with zero filesystem writes', async (t) => {
  const fixture = makeHomeFixture(t);
  const inline = await createJsonResult(fixture, { answer: 'inline' });
  const graph = await createGraphResult(fixture, '{"id":1}\n');
  await createOperation(fixture, { requestId: 'still-running' });
  const diskReader = createBrainOperationStoreReader({
    operationsRoot: fixture.operationsRoot,
    expectedRequester: 'jerry',
  });
  const before = treeSnapshot(fixture.operationsRoot);
  assert.equal((await diskReader.getAuthorized(inline.operationId)).operationId, inline.operationId);
  assert.equal((await diskReader.listNonterminalAuthorized()).length, 1);
  assert.deepEqual(await diskReader.getResultAuthorized(inline.operationId), { answer: 'inline' });
  const opened = await diskReader.openResultArtifactAuthorized(graph.operationId);
  let graphBytes = '';
  for await (const chunk of opened.stream) graphBytes += chunk.toString('utf8');
  assert.equal(graphBytes, '{"id":1}\n');
  assert.deepEqual(treeSnapshot(fixture.operationsRoot), before);
  assert.equal(fs.existsSync(path.join(fixture.operationsRoot, '.operation.lock')), false);
});

test('disk-only reader rejects a symlinked store root without touching its target', async (t) => {
  const fixture = makeHomeFixture(t);
  await createOperation(fixture, { requestId: 'symlink-root' });
  const alias = path.join(fixture.home23Root, 'alias-brain-operations');
  fs.symlinkSync(fixture.operationsRoot, alias, 'dir');
  const before = treeSnapshot(fixture.operationsRoot);
  assert.throws(
    () => createBrainOperationStoreReader({ operationsRoot: alias, expectedRequester: 'jerry' }),
    hasCode('reader_configuration_invalid'),
  );
  assert.deepEqual(treeSnapshot(fixture.operationsRoot), before);
});

test('canonical JSON and markdown exports reload stored results and write exact provenance', async (t) => {
  const fixture = makeHomeFixture(t);
  const result = { z: 2, answer: 'stored', nested: { b: true, a: 1 } };
  const record = await createJsonResult(fixture, result);
  const targetBefore = treeSnapshot(path.join(fixture.home23Root, 'instances/jerry/brain'));

  const jsonReceipt = await fixture.exporter.exportResult({
    requesterAgent: 'jerry', operationId: record.operationId, format: 'json', fileName: 'canary.json',
  });
  assert.match(jsonReceipt.exportHandle, /^brexp_[A-Za-z0-9_-]{32}$/);
  assert.equal(jsonReceipt.sourceOperationId, record.operationId);
  assert.equal(jsonReceipt.sourceResultHandleHash, null);
  assert.equal(jsonReceipt.canonicalEvidence, true);
  const jsonBytes = Buffer.from(`${canonicalJson(result)}\n`, 'utf8');
  assert.deepEqual(fs.readFileSync(exportPath(fixture, jsonReceipt)), jsonBytes);
  assert.equal(jsonReceipt.bytes, jsonBytes.length);
  assert.equal(jsonReceipt.sha256, crypto.createHash('sha256').update(jsonBytes).digest('hex'));
  const storedJsonReceipt = JSON.parse(fs.readFileSync(receiptPath(fixture, jsonReceipt.exportHandle), 'utf8'));
  assert.deepEqual(
    Object.fromEntries(Object.keys(jsonReceipt).map((key) => [key, storedJsonReceipt[key]])),
    jsonReceipt,
  );
  assert.equal(Object.hasOwn(storedJsonReceipt, 'resultHandle'), false);

  const markdownReceipt = await fixture.exporter.exportResult({
    requesterAgent: 'jerry', operationId: record.operationId, format: 'markdown', fileName: 'canary.md',
  });
  const markdown = `# Brain Operation Result\n\n\`\`\`json\n${canonicalJson(result)}\n\`\`\`\n`;
  assert.equal(fs.readFileSync(exportPath(fixture, markdownReceipt), 'utf8'), markdown);
  assert.deepEqual(treeSnapshot(path.join(fixture.home23Root, 'instances/jerry/brain')), targetBefore);
});

test('canonical export rejects caller bytes, paths, unsupported formats, and unsafe basenames', async (t) => {
  const fixture = makeHomeFixture(t);
  const record = await createJsonResult(fixture, { answer: 'stored' });
  for (const extra of [
    { answer: 'forged' }, { content: 'forged' }, { sourcePath: '/tmp/a' },
    { destinationPath: '/tmp/b' }, { path: '/tmp/c' }, { raw: Buffer.from('x') },
  ]) {
    await assert.rejects(
      () => fixture.exporter.exportResult({
        requesterAgent: 'jerry', operationId: record.operationId, format: 'json', ...extra,
      }),
      hasCode('export_invalid'),
    );
  }
  for (const format of [undefined, 'jsonl', 'gzip', 'html']) {
    await assert.rejects(
      () => fixture.exporter.exportResult({
        requesterAgent: 'jerry', operationId: record.operationId, ...(format ? { format } : {}),
      }),
      hasCode('export_format_invalid'),
    );
  }
  for (const fileName of ['../x', '/tmp/x', 'a/b', 'a\\b', '.', '..', '.hidden', 'x\0y']) {
    await assert.rejects(
      () => fixture.exporter.exportResult({
        requesterAgent: 'jerry', operationId: record.operationId, format: 'json', fileName,
      }),
      hasCode('export_filename_invalid'),
    );
  }
});

test('canonical export rejects requester, state, evidence, and result-handle mismatches before writes', async (t) => {
  const fixture = makeHomeFixture(t);
  const inline = await createJsonResult(fixture, { answer: 'stored' });
  const before = treeSnapshot(path.join(fixture.home23Root, 'instances/jerry'));
  await assert.rejects(
    () => fixture.exporter.exportResult({
      requesterAgent: 'forrest', operationId: inline.operationId, format: 'json',
    }),
    hasCode('access_denied'),
  );
  await assert.rejects(
    () => fixture.exporter.exportResult({
      requesterAgent: 'jerry', operationId: inline.operationId, resultHandle: RESULT_HANDLE, format: 'json',
    }),
    hasCode('result_handle_invalid'),
  );
  assert.deepEqual(treeSnapshot(path.join(fixture.home23Root, 'instances/jerry')), before);

  const queued = await createOperation(fixture, { requestId: 'queued-export' });
  await assert.rejects(
    () => fixture.exporter.exportResult({
      requesterAgent: 'jerry', operationId: queued.record.operationId, format: 'json',
    }),
    hasCode('operation_not_terminal'),
  );
  const noncanonical = await createJsonResult(fixture, { answer: 'legacy' }, {
    operationType: 'ad_hoc_export', canonicalEvidence: false,
  });
  await assert.rejects(
    () => fixture.exporter.exportResult({
      requesterAgent: 'jerry', operationId: noncanonical.operationId, format: 'json',
    }),
    hasCode('canonical_export_required'),
  );
});

test('non-graph operations cannot relabel an artifact descriptor as an ordinary JSON export', async (t) => {
  const fixture = makeHomeFixture(t);
  const record = fakeRecord({
    operationType: 'query',
    result: null,
    resultHandle: RESULT_HANDLE,
    resultArtifact: {
      mediaType: 'application/x-ndjson', contentEncoding: 'identity',
      bytes: 9, sha256: '0'.repeat(64),
    },
  });
  let resultReads = 0;
  const reader = {
    async getAuthorized() { return record; },
    async getResultAuthorized() { resultReads += 1; return { resultArtifact: record.resultArtifact }; },
    async openResultArtifactAuthorized() { throw new Error('not used'); },
  };
  const exporter = createBrainOperationExporter({
    home23Root: fixture.home23Root, requesterAgent: 'jerry', reader,
  });
  await assert.rejects(
    () => exporter.exportResult({
      requesterAgent: 'jerry', operationId: record.operationId, format: 'json',
    }),
    hasCode('export_source_invalid'),
  );
  assert.equal(resultReads, 0);
});

test('large JSON export hashes the protected stored result handle without exposing it in receipt', async (t) => {
  const fixture = makeHomeFixture(t);
  const record = await createJsonResult(fixture, { answer: 'x'.repeat(70 * 1024) });
  assert.match(record.resultHandle, /^brres_/);
  const receipt = await fixture.exporter.exportResult({
    requesterAgent: 'jerry', operationId: record.operationId,
    resultHandle: record.resultHandle, format: 'json',
  });
  assert.equal(
    receipt.sourceResultHandleHash,
    crypto.createHash('sha256').update(record.resultHandle).digest('hex'),
  );
  const stored = JSON.parse(fs.readFileSync(receiptPath(fixture, receipt.exportHandle), 'utf8'));
  assert.equal(stored.sourceResultHandleHash, receipt.sourceResultHandleHash);
  assert.equal(JSON.stringify(stored).includes(record.resultHandle), false);
});

test('concurrent exporters atomically reject the same random handle instead of overwriting evidence', async (t) => {
  const fixture = makeHomeFixture(t);
  const record = await createJsonResult(fixture, { answer: 'stored' });
  function collidingRandom(uniqueByte) {
    let call = 0;
    return (size) => Buffer.alloc(size, call++ === 0 ? 55 : uniqueByte);
  }
  const first = createBrainOperationExporter({
    home23Root: fixture.home23Root, requesterAgent: 'jerry', reader: fixture.reader,
    randomBytes: collidingRandom(56), now: () => NOW,
  });
  const second = createBrainOperationExporter({
    home23Root: fixture.home23Root, requesterAgent: 'jerry', reader: fixture.reader,
    randomBytes: collidingRandom(57), now: () => NOW,
  });
  const receipts = await Promise.all([first, second].map((exporter) => exporter.exportResult({
    requesterAgent: 'jerry', operationId: record.operationId, format: 'json',
  })));
  assert.equal(new Set(receipts.map((receipt) => receipt.exportHandle)).size, 2);
  assert.equal(new Set(receipts.map((receipt) => receipt.relativePath)).size, 2);
  for (const receipt of receipts) {
    assert.equal(fs.existsSync(exportPath(fixture, receipt)), true);
    assert.equal(fs.existsSync(receiptPath(fixture, receipt.exportHandle)), true);
  }
});

test('graph export streams exact identity JSONL bytes and validates actual hash and byte count', async (t) => {
  const fixture = makeHomeFixture(t);
  const source = Array.from({ length: 20 }, (_, index) => canonicalJson({ id: index })).join('\n') + '\n';
  const record = await createGraphResult(fixture, source);
  const receipt = await fixture.exporter.exportResult({
    requesterAgent: 'jerry', operationId: record.operationId, format: 'jsonl',
  });
  assert.equal(path.extname(receipt.relativePath), '.jsonl');
  assert.equal(fs.readFileSync(exportPath(fixture, receipt), 'utf8'), source);
  assert.equal(receipt.bytes, Buffer.byteLength(source));
  assert.equal(receipt.sha256, crypto.createHash('sha256').update(source).digest('hex'));

  for (const format of [undefined, 'json', 'markdown', 'gzip', 'jsonl.gz']) {
    await assert.rejects(
      () => fixture.exporter.exportResult({
        requesterAgent: 'jerry', operationId: record.operationId, ...(format ? { format } : {}),
      }),
      hasCode('export_format_invalid'),
    );
  }
});

test('graph export publishes nothing when stream bytes, hash, metadata, or delivery fail', async (t) => {
  const fixture = makeHomeFixture(t);
  fs.mkdirSync(path.join(fixture.home23Root, 'instances/jerry/workspace/brain-exports'));
  fs.mkdirSync(path.join(fixture.home23Root, 'instances/jerry/runtime/brain-export-receipts'));
  const source = '{"id":1}\n';
  const expectedHash = crypto.createHash('sha256').update(source).digest('hex');
  const baseRecord = fakeRecord({
    operationType: 'graph_export',
    result: null,
    resultHandle: RESULT_HANDLE,
    resultArtifact: {
      mediaType: 'application/x-ndjson', contentEncoding: 'identity',
      bytes: Buffer.byteLength(source), sha256: expectedHash,
    },
  });
  let streamFactory = () => Readable.from(['forged\n']);
  const reader = {
    async getAuthorized() { return baseRecord; },
    async openResultArtifactAuthorized() {
      return { metadata: baseRecord.resultArtifact, stream: streamFactory() };
    },
    async getResultAuthorized() { throw new Error('must not materialize graph'); },
  };
  let counter = 10;
  const exporter = createBrainOperationExporter({
    home23Root: fixture.home23Root, requesterAgent: 'jerry', reader,
    randomBytes: (size) => Buffer.alloc(size, counter++), now: () => NOW,
  });
  const exportRoot = path.join(fixture.home23Root, 'instances/jerry/workspace/brain-exports');
  const receiptRoot = path.join(fixture.home23Root, 'instances/jerry/runtime/brain-export-receipts');
  const assertEmpty = () => {
    assert.deepEqual(fs.readdirSync(exportRoot), []);
    assert.deepEqual(fs.readdirSync(receiptRoot), []);
  };
  await assert.rejects(
    () => exporter.exportResult({ requesterAgent: 'jerry', operationId: baseRecord.operationId, format: 'jsonl' }),
    hasCode('export_source_mismatch'),
  );
  assertEmpty();
  streamFactory = () => new Readable({
    read() {
      this.push(Buffer.from(source));
      this.destroy(Object.assign(new Error('stream failed'), { code: 'source_failed' }));
    },
  });
  await assert.rejects(
    () => exporter.exportResult({ requesterAgent: 'jerry', operationId: baseRecord.operationId, format: 'jsonl' }),
    hasCode('export_source_failed'),
  );
  assertEmpty();
  reader.openResultArtifactAuthorized = async () => ({
    metadata: { ...baseRecord.resultArtifact, contentEncoding: 'gzip' },
    stream: Readable.from([source]),
  });
  await assert.rejects(
    () => exporter.exportResult({ requesterAgent: 'jerry', operationId: baseRecord.operationId, format: 'jsonl' }),
    hasCode('export_source_invalid'),
  );
  assertEmpty();
});

test('export refuses symlinked requester workspace and never writes outside the instance', async (t) => {
  const fixture = makeHomeFixture(t);
  const record = await createJsonResult(fixture, { answer: 'stored' });
  const outside = fs.mkdtempSync(path.join(tmpdir(), 'home23-export-outside-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const exportRoot = path.join(fixture.home23Root, 'instances/jerry/workspace/brain-exports');
  fs.symlinkSync(outside, exportRoot, 'dir');
  await assert.rejects(
    () => fixture.exporter.exportResult({
      requesterAgent: 'jerry', operationId: record.operationId, format: 'json',
    }),
    hasCode('export_path_invalid'),
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('pre-publication crash removes temporary exports while post-rename crash preserves evidence as uncertain', async (t) => {
  const fixture = makeHomeFixture(t);
  const record = await createJsonResult(fixture, { answer: 'stored' });
  const make = (stage) => createBrainOperationExporter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    reader: fixture.reader,
    randomBytes: (size) => Buffer.alloc(size, stage === 'before_export_rename' ? 31 : 32),
    now: () => NOW,
    crashInjector: async (actual) => {
      if (actual === stage) throw Object.assign(new Error('injected crash'), { code: 'injected_crash' });
    },
  });
  const exportRoot = path.join(fixture.home23Root, 'instances/jerry/workspace/brain-exports');
  const before = fs.existsSync(exportRoot) ? fs.readdirSync(exportRoot) : [];
  await assert.rejects(
    () => make('before_export_rename').exportResult({
      requesterAgent: 'jerry', operationId: record.operationId, format: 'json',
    }),
    hasCode('injected_crash'),
  );
  assert.deepEqual(fs.readdirSync(exportRoot), before);
  await assert.rejects(
    () => make('after_export_rename').exportResult({
      requesterAgent: 'jerry', operationId: record.operationId, format: 'json',
    }),
    hasCode('durability_uncertain'),
  );
  assert.equal(fs.readdirSync(exportRoot).filter((name) => !before.includes(name)).length, 1);
});

test('ad-hoc export is bounded, requester-only, noncanonical, and never invokes canonical reader', async (t) => {
  const fixture = makeHomeFixture(t);
  const throwingReader = {
    async getAuthorized() { throw new Error('canonical reader called'); },
    async getResultAuthorized() { throw new Error('canonical reader called'); },
    async openResultArtifactAuthorized() { throw new Error('canonical reader called'); },
  };
  const exporter = createBrainOperationExporter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    reader: throwingReader,
    randomBytes: (size) => Buffer.alloc(size, 41),
    now: () => NOW,
  });
  const operationId = `brop_${'D'.repeat(32)}`;
  const receipt = await exporter.exportAdHoc({
    requesterAgent: 'jerry',
    operationId,
    query: 'What did we learn?',
    answer: 'Only requester-owned text.',
    format: 'markdown',
    metadata: { legacyTool: 'brain_query_export' },
  });
  assert.equal(receipt.canonicalEvidence, false);
  assert.equal(receipt.sourceOperationId, operationId);
  assert.equal(receipt.sourceResultHandleHash, null);
  assert.match(fs.readFileSync(exportPath(fixture, receipt), 'utf8'), /Only requester-owned text/);
  const stored = JSON.parse(fs.readFileSync(receiptPath(fixture, receipt.exportHandle), 'utf8'));
  assert.equal(stored.canonicalEvidence, false);

  for (const invalid of [
    { requesterAgent: 'forrest' },
    { target: { agent: 'forrest' } },
    { destinationPath: '/tmp/out' },
    { query: 'q'.repeat(70 * 1024) },
    { answer: 'a'.repeat(1024 * 1024 + 1) },
    { metadata: { value: 'm'.repeat(70 * 1024) } },
  ]) {
    await assert.rejects(
      () => exporter.exportAdHoc({
        requesterAgent: 'jerry', operationId, query: 'q', answer: 'a', format: 'json',
        metadata: {}, ...invalid,
      }),
      (error) => ['access_denied', 'export_invalid'].includes(error?.code),
    );
  }
});
