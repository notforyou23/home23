import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BrainOperationStore } = require('../../../engine/src/dashboard/brain-operations/operation-store.js');
const { createBrainOperationStoreReader } = require('../../../engine/src/dashboard/brain-operations/store-reader.js');
const { createBrainOperationExporter } = require('../../../engine/src/dashboard/brain-operations/exporter.js');
const { createGraphExportExecutor } = require('../../../engine/src/dashboard/brain-operations/graph-export-executor.js');
const {
  canonicalIdentity,
  createSourceOperationExecutors,
} = require('../../../engine/src/dashboard/brain-operations/source-executors.js');
const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  enumerateMemoryMutationBoundaries,
  rewriteMemoryBase,
} = require('../../../shared/memory-source');

const NOW = Date.parse('2026-07-11T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function hasCode(code) {
  return (error) => error?.code === code;
}

function graphRecords(prefix = 'graph') {
  const nodes = [
    { id: `${prefix}-1`, concept: 'first complete node', tag: 'research', embedding: [0.1, 0.2] },
    { id: `${prefix}-2`, concept: 'second complete node', tag: 'finding', embedding: [0.3, 0.4] },
    { id: `${prefix}-3`, concept: 'third complete node', tag: 'finding', embedding: [0.5, 0.6] },
  ];
  const edges = [
    { source: nodes[0].id, target: nodes[1].id, weight: 0.9, type: 'related' },
    { source: nodes[1].id, target: nodes[2].id, weight: 0.8, type: 'supports' },
  ];
  return { nodes, edges };
}

function expectedNdjson(graph) {
  return [
    ...graph.nodes.map((record) => JSON.stringify({ type: 'node', record })),
    ...graph.edges.map((record) => JSON.stringify({ type: 'edge', record })),
  ].join('\n') + '\n';
}

function treeSnapshot(root) {
  if (!fs.existsSync(root)) return [];
  const rows = [];
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(current, entry.name);
      const stat = fs.lstatSync(full, { bigint: true });
      const row = {
        path: path.relative(root, full),
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : 'file',
        mode: stat.mode.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(),
      };
      if (entry.isFile()) {
        row.sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
      if (entry.isSymbolicLink()) row.target = fs.readlinkSync(full);
      rows.push(row);
      if (entry.isDirectory()) walk(full);
    }
  }
  walk(root);
  return rows;
}

async function makeFixture(t) {
  const home23Root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-graph-export-')));
  const requesterAgent = 'jerry';
  const brainDir = path.join(home23Root, 'instances', requesterAgent, 'brain');
  const operationsRoot = path.join(
    home23Root, 'instances', requesterAgent, 'runtime', 'brain-operations',
  );
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  for (const directory of [
    brainDir,
    operationsRoot,
    lockRoot,
    path.join(home23Root, 'instances', requesterAgent, 'workspace'),
  ]) await fsp.mkdir(directory, { recursive: true });
  for (const boundary of enumerateMemoryMutationBoundaries(brainDir)) {
    await fsp.mkdir(boundary.path, { recursive: true });
    await fsp.writeFile(path.join(boundary.path, `${boundary.kind}-canary.txt`), `${boundary.kind}\n`);
  }
  const graph = graphRecords();
  await rewriteMemoryBase(brainDir, {
    ...graph,
    summary: { nodeCount: graph.nodes.length, edgeCount: graph.edges.length, clusterCount: 1 },
  }, { lockRoot });
  const canonicalRoot = await fsp.realpath(brainDir);
  const store = new BrainOperationStore({
    root: operationsRoot,
    requesterAgent,
    now: () => NOW,
  });
  const provider = createMemorySourcePinProvider({ home23Root, requesterAgent });
  const reader = createBrainOperationStoreReader({
    operationsRoot,
    expectedRequester: requesterAgent,
    liveStore: store,
  });
  let exportByte = 1;
  const exporter = createBrainOperationExporter({
    home23Root,
    requesterAgent,
    reader,
    now: () => NOW,
    randomBytes(size) { return Buffer.alloc(size, exportByte++); },
  });
  const resources = [];
  t.after(async () => {
    for (const resource of resources.reverse()) {
      await resource.source?.release?.().catch(() => {});
      await Promise.resolve(resource.quota?.close?.()).catch(() => {});
      await provider.releaseOperationPins(resource.operationId).catch(() => {});
    }
    await fsp.rm(home23Root, { recursive: true, force: true });
  });
  return {
    home23Root,
    requesterAgent,
    brainDir,
    canonicalRoot,
    operationsRoot,
    lockRoot,
    graph,
    store,
    provider,
    reader,
    exporter,
    resources,
  };
}

function targetFor(fixture) {
  return {
    domain: 'brain',
    brainId: 'brain-jerry',
    canonicalRoot: fixture.canonicalRoot,
    accessMode: 'own',
    ownerAgent: fixture.requesterAgent,
    displayName: 'Jerry',
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-graph-export-1',
    route: '/api/brain/brain-jerry',
    mutationBoundaries: enumerateMemoryMutationBoundaries(fixture.canonicalRoot),
  };
}

async function prepareOperation(fixture, requestId) {
  const created = await fixture.store.create({
    requestId,
    requesterAgent: fixture.requesterAgent,
    target: targetFor(fixture),
    operationType: 'graph_export',
    requestParameters: { format: 'jsonl' },
    parameters: { format: 'jsonl' },
    sourcePinDescriptor: null,
    sourcePinDigest: null,
    canonicalEvidence: true,
  });
  const operationId = created.record.operationId;
  const pinned = await fixture.provider.pin(fixture.canonicalRoot, operationId);
  const attached = await fixture.store.attachSourcePin(operationId, {
    expectedVersion: created.record.recordVersion,
    descriptor: pinned.descriptor,
    digest: pinned.digest,
  });
  const running = await fixture.store.transition(operationId, {
    expectedVersion: attached.recordVersion,
    state: 'running',
    phase: 'graph_export',
  });
  const scratchDir = await fixture.store.ensureScratchDirectory(operationId);
  const operationRoot = path.dirname(scratchDir);
  const quota = await createOperationScratchQuota({ operationRoot });
  const source = await fixture.provider.openPinnedSource(pinned.descriptor, {
    operationId,
    operationType: 'graph_export',
    expectedCanonicalRoot: fixture.canonicalRoot,
    expectedRevision: pinned.descriptor.cutoffRevision,
    expectedDigest: pinned.digest,
    scratchQuota: quota,
  });
  const resource = { operationId, source, quota };
  fixture.resources.push(resource);
  return {
    operationId,
    pinned,
    running,
    scratchDir,
    operationRoot,
    quota,
    source,
    context: {
      operationId,
      operationType: 'graph_export',
      requesterAgent: fixture.requesterAgent,
      target: targetFor(fixture),
      parameters: { format: 'jsonl' },
      scratchDir,
      scratchQuota: quota,
      sourcePin: source,
    },
    resource,
  };
}

async function executeGraphExport(fixture, requestId, { terminal = true } = {}) {
  const prepared = await prepareOperation(fixture, requestId);
  const sourceRevision = prepared.source.revision;
  const graphExecutor = createGraphExportExecutor({ home23Root: fixture.home23Root });
  const executors = createSourceOperationExecutors({
    searchService: null,
    brainSourceService: null,
    graphExportExecutor: graphExecutor,
  });
  const envelope = await executors.get('graph_export')(prepared.context);
  assert.equal(envelope.state, 'complete');
  const adopted = await fixture.store.adoptResultArtifact(prepared.operationId, {
    expectedVersion: prepared.running.recordVersion,
    ...envelope.resultArtifact,
  });
  let record = adopted;
  if (terminal) {
    record = await fixture.store.transition(prepared.operationId, {
      expectedVersion: adopted.recordVersion,
      state: 'complete',
      sourceEvidence: envelope.sourceEvidence,
    });
    await prepared.source.release();
    prepared.source = null;
    prepared.resource.source = null;
    await Promise.resolve(prepared.quota.close());
    prepared.quota = null;
    prepared.resource.quota = null;
    record = await fixture.store.releaseSourcePinOnce(
      prepared.operationId,
      new Date(NOW + 1).toISOString(),
      (operationId) => fixture.provider.releaseOperationPins(operationId),
    );
  }
  return { ...prepared, sourceRevision, envelope, record };
}

test('real pinned executor and store publish complete NDJSON with an opaque path-free client record', async (t) => {
  const fixture = await makeFixture(t);
  const targetBefore = treeSnapshot(fixture.brainDir);
  const operation = await executeGraphExport(fixture, 'complete-stream');
  const expected = expectedNdjson(fixture.graph);

  assert.equal(operation.envelope.result, null);
  assert.deepEqual(Object.keys(operation.envelope.resultArtifact).sort(), [
    'bytes', 'contentEncoding', 'mediaType', 'scratchPath', 'sha256',
  ].sort());
  assert.equal(operation.envelope.resultArtifact.mediaType, 'application/x-ndjson');
  assert.equal(operation.envelope.resultArtifact.contentEncoding, 'identity');
  assert.equal(operation.envelope.resultArtifact.bytes, Buffer.byteLength(expected));
  assert.equal(operation.envelope.resultArtifact.sha256,
    crypto.createHash('sha256').update(expected).digest('hex'));
  for (const forbidden of [
    'storage', 'relativePath', 'format', 'retentionClass', 'nodeCount', 'edgeCount', 'sourceRevision',
  ]) assert.equal(Object.hasOwn(operation.envelope.resultArtifact, forbidden), false);
  assert.deepEqual(operation.envelope.sourceEvidence.graphExport, {
    nodeCount: fixture.graph.nodes.length,
    edgeCount: fixture.graph.edges.length,
    sourceRevision: operation.sourceRevision,
  });

  const publicRecord = await fixture.store.get(operation.operationId);
  assert.match(publicRecord.resultHandle, /^brres_[A-Za-z0-9_-]{32}$/);
  assert.equal(publicRecord.result, null);
  assert.deepEqual(Object.keys(publicRecord.resultArtifact).sort(), [
    'bytes', 'contentEncoding', 'mediaType', 'sha256',
  ].sort());
  assert.equal(JSON.stringify({
    resultHandle: publicRecord.resultHandle,
    resultArtifact: publicRecord.resultArtifact,
    sourceEvidence: publicRecord.sourceEvidence,
  }).includes('scratchPath'), false);
  const opened = await fixture.reader.openResultArtifactAuthorized(
    operation.operationId,
    publicRecord.resultHandle,
  );
  let protectedBytes = '';
  for await (const chunk of opened.stream) protectedBytes += chunk.toString('utf8');
  assert.equal(protectedBytes, expected);
  assert.deepEqual(treeSnapshot(fixture.brainDir), targetBefore);

  await assert.rejects(
    () => fixture.store.setResult(operation.operationId, {
      expectedVersion: publicRecord.recordVersion,
      result: { resultArtifact: publicRecord.resultArtifact },
    }),
    (error) => ['operation_terminal', 'result_conflict'].includes(error?.code),
  );
});

test('root, revision, pin, path, format, and caller artifact mismatches fail before output open', async (t) => {
  const fixture = await makeFixture(t);
  const prepared = await prepareOperation(fixture, 'reject-before-open');
  const executor = createGraphExportExecutor({ home23Root: fixture.home23Root });
  const valid = prepared.context;
  const facade = (overrides = {}) => ({
    descriptor: overrides.descriptor || prepared.source.descriptor,
    revision: overrides.revision ?? prepared.source.revision,
    manifest: prepared.source.manifest,
    getEvidence: prepared.source.getEvidence.bind(prepared.source),
    iterateNodes: prepared.source.iterateNodes.bind(prepared.source),
    iterateEdges: prepared.source.iterateEdges.bind(prepared.source),
  });
  const wrongRoot = path.join(fixture.home23Root, 'instances', 'forrest', 'brain');
  await fsp.mkdir(wrongRoot, { recursive: true });
  const invalidContexts = [
    { ...valid, target: { ...valid.target, canonicalRoot: wrongRoot } },
    {
      ...valid,
      sourcePin: facade({
        descriptor: { ...prepared.source.descriptor, canonicalRoot: wrongRoot },
      }),
    },
    {
      ...valid,
      sourcePin: facade({ revision: prepared.source.revision + 1 }),
    },
    { ...valid, sourcePin: null },
    { ...valid, parameters: { format: 'jsonl', outputPath: '/tmp/forged.jsonl' } },
    { ...valid, parameters: { format: 'json' } },
    { ...valid, parameters: { format: 'jsonl', resultArtifact: { scratchPath: '/tmp/x' } } },
  ];
  const trustedIdentity = canonicalIdentity(valid);

  for (const context of invalidContexts) {
    await assert.rejects(
      () => executor({
        ...context,
        identity: trustedIdentity,
      }),
      (error) => ['invalid_request', 'source_changed'].includes(error?.code),
    );
    assert.equal(fs.existsSync(path.join(prepared.scratchDir, 'results')), false,
      'invalid request must fail before opening requester output');
  }
});

test('executor waits for real stream drain before requesting the next pinned record', async (t) => {
  const fixture = await makeFixture(t);
  const prepared = await prepareOperation(fixture, 'backpressure');
  const originalCreateWriteStream = fs.createWriteStream;
  let drainCount = 0;
  fs.createWriteStream = function createTinyWriteStream(file, options = {}) {
    const stream = originalCreateWriteStream(file, { ...options, highWaterMark: 1 });
    stream.on('drain', () => { drainCount += 1; });
    return stream;
  };
  t.after(() => { fs.createWriteStream = originalCreateWriteStream; });
  let requested = 0;
  const pin = {
    descriptor: prepared.source.descriptor,
    revision: prepared.source.revision,
    manifest: prepared.source.manifest,
    getEvidence: prepared.source.getEvidence.bind(prepared.source),
    async *iterateNodes() {
      for (let index = 0; index < 4; index += 1) {
        if (index > 0) assert.equal(drainCount >= index, true,
          'the prior false write must drain before the source advances');
        requested += 1;
        yield { id: `backpressure-${index}`, concept: 'x'.repeat(128) };
      }
    },
    async *iterateEdges() {},
  };
  try {
    await createGraphExportExecutor({ home23Root: fixture.home23Root })({
      ...prepared.context,
      sourcePin: pin,
      identity: canonicalIdentity({ ...prepared.context, sourcePin: pin }),
    });
  } finally {
    fs.createWriteStream = originalCreateWriteStream;
  }
  assert.equal(requested, 4);
  assert.equal(drainCount >= 4, true);
});

test('abort removes the temporary result and returns its claimed scratch quota', async (t) => {
  const fixture = await makeFixture(t);
  const prepared = await prepareOperation(fixture, 'abort-cleanup');
  const controller = new AbortController();
  const pin = {
    descriptor: prepared.source.descriptor,
    revision: prepared.source.revision,
    manifest: prepared.source.manifest,
    getEvidence: prepared.source.getEvidence.bind(prepared.source),
    async *iterateNodes() {
      yield { id: 'first', concept: 'written before cancellation' };
      controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      yield { id: 'second', concept: 'must never be written' };
    },
    async *iterateEdges() {},
  };
  await assert.rejects(
    () => createGraphExportExecutor({ home23Root: fixture.home23Root })({
      ...prepared.context,
      sourcePin: pin,
      signal: controller.signal,
      identity: canonicalIdentity({ ...prepared.context, sourcePin: pin }),
    }),
    (error) => error?.name === 'AbortError',
  );
  assert.deepEqual(await fsp.readdir(path.join(prepared.scratchDir, 'results')), []);
  assert.equal(prepared.quota.claimedBytes ?? prepared.quota.claimed ?? 0, 0);
});

test('seven-day result GC, thirty-day metadata GC, and explicit durable JSONL export are distinct', async (t) => {
  const fixture = await makeFixture(t);
  const terminal = await executeGraphExport(fixture, 'retained-terminal');
  const nonterminal = await executeGraphExport(fixture, 'retained-running', { terminal: false });
  const terminalRecord = await fixture.store.get(terminal.operationId);
  const receipt = await fixture.exporter.exportResult({
    requesterAgent: fixture.requesterAgent,
    operationId: terminal.operationId,
    resultHandle: terminalRecord.resultHandle,
    format: 'jsonl',
  });
  for (const format of [undefined, 'json', 'markdown', 'gzip', 'jsonl.gz']) {
    await assert.rejects(
      () => fixture.exporter.exportResult({
        requesterAgent: fixture.requesterAgent,
        operationId: terminal.operationId,
        resultHandle: terminalRecord.resultHandle,
        ...(format ? { format } : {}),
      }),
      hasCode('export_format_invalid'),
    );
  }
  const durableCopy = path.join(
    fixture.home23Root, 'instances', fixture.requesterAgent, receipt.relativePath,
  );
  assert.equal(await fsp.readFile(durableCopy, 'utf8'), expectedNdjson(fixture.graph));

  assert.deepEqual(await fixture.store.collectGarbage(NOW + (7 * DAY_MS) - 1), {
    resultsExpired: 0,
    metadataDeleted: 0,
  });
  assert.equal(fs.existsSync(path.join(terminal.operationRoot, 'result.artifact')), true);

  const daySeven = await fixture.store.collectGarbage(NOW + (7 * DAY_MS));
  assert.equal(daySeven.resultsExpired, 1);
  assert.equal(fs.existsSync(path.join(terminal.operationRoot, 'result.artifact')), false);
  assert.equal(fs.existsSync(path.join(terminal.operationRoot, 'scratch')), false);
  const expired = await fixture.store.get(terminal.operationId);
  assert.equal(expired.resultHandle, null);
  assert.notEqual(expired.resultExpiredAt, null);
  assert.deepEqual(Object.keys(expired.resultArtifact).sort(), [
    'bytes', 'contentEncoding', 'mediaType', 'sha256',
  ].sort());
  assert.equal(fs.existsSync(path.join(nonterminal.operationRoot, 'result.artifact')), true,
    'nonterminal result is never collected');
  assert.equal(fs.existsSync(path.join(nonterminal.operationRoot, 'scratch')), true,
    'nonterminal scratch is never collected');

  const dayThirty = await fixture.store.collectGarbage(NOW + (30 * DAY_MS));
  assert.equal(dayThirty.metadataDeleted, 1);
  await assert.rejects(() => fixture.store.get(terminal.operationId), hasCode('operation_not_found'));
  assert.equal((await fixture.store.get(nonterminal.operationId)).state, 'running');
  assert.equal(fs.existsSync(durableCopy), true, 'explicit requester export outlives operation retention');
  assert.equal(fs.existsSync(path.join(
    fixture.home23Root,
    'instances',
    fixture.requesterAgent,
    'runtime',
    'brain-export-receipts',
    `${receipt.exportHandle}.json`,
  )), true);
});
