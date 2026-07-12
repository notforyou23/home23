import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  canonicalIdentity,
  createSourceOperationExecutors,
} = require('../../../engine/src/dashboard/brain-operations/source-executors');
const { createGraphExportExecutor } = require('../../../engine/src/dashboard/brain-operations/graph-export-executor');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function evidence(input = {}) {
  return {
    route: 'shared-memory-source',
    implementation: 'manifest-v1',
    identity: {
      requesterAgent: null,
      targetAgent: null,
      brainId: null,
      canonicalRoot: input.canonicalRoot || null,
      catalogRevision: null,
      kind: null,
      sourceType: null,
      accessMode: null,
      operationId: input.operationId || null,
    },
    sourceHealth: input.sourceHealth || 'healthy',
    matchOutcome: input.matchOutcome || 'matches',
    authoritativeTotals: input.authoritativeTotals || { nodes: 2, edges: 1 },
    returnedTotals: input.returnedTotals || { nodes: 0, edges: 0 },
  };
}

function sourcePin(canonicalRoot = '/tmp/brain') {
  return {
    descriptor: { version: 1, canonicalRoot, cutoffRevision: 3 },
    revision: 3,
    manifest: { sourceMode: 'manifest' },
    getEvidence(input = {}) { return evidence({ ...input, canonicalRoot }); },
    async summarize() { return { nodes: 2, edges: 1, clusters: 1 }; },
    async searchKeyword() { return { results: [] }; },
    async *iterateNodes() {
      yield { id: 'a', concept: 'alpha' };
      yield { id: 'b', concept: 'beta' };
    },
    async *iterateEdges() {
      yield { source: 'a', target: 'b', weight: 1 };
    },
  };
}

async function baseContext() {
  const canonicalRoot = await tempDir('home23-source-executor-brain-');
  const scratchDir = await tempDir('home23-source-executor-scratch-');
  let claimed = 0;
  return {
    operationId: 'op-1',
    operationType: 'graph',
    requesterAgent: 'ada',
    target: {
      domain: 'brain',
      brainId: 'ada',
      canonicalRoot,
      accessMode: 'own',
      ownerAgent: 'ada',
      kind: 'resident',
      catalogRevision: 'catalog-1',
    },
    parameters: {},
    scratchDir,
    scratchQuota: {
      get claimed() { return claimed; },
      async claim(bytes) { claimed += bytes; return claimed; },
      async release(bytes) { claimed -= bytes; return claimed; },
    },
    sourcePin: sourcePin(canonicalRoot),
  };
}

async function operationScratchContext() {
  const home23Root = await tempDir('home23-export-root-');
  const canonicalRoot = path.join(home23Root, 'instances', 'ada', 'brain');
  await fsp.mkdir(canonicalRoot, { recursive: true });
  const scratchDir = path.join(
    home23Root, 'instances', 'ada', 'runtime', 'brain-operations', 'operations', 'op-1', 'scratch',
  );
  await fsp.mkdir(scratchDir, { recursive: true });
  const context = await baseContext();
  context.target.canonicalRoot = canonicalRoot;
  context.scratchDir = scratchDir;
  context.sourcePin = sourcePin(canonicalRoot);
  return { home23Root, context };
}

test('canonical identity is derived only from operation context and source pin', async () => {
  const context = await baseContext();
  assert.deepEqual(canonicalIdentity(context), {
    requesterAgent: 'ada',
    targetAgent: 'ada',
    brainId: 'ada',
    canonicalRoot: context.target.canonicalRoot,
    catalogRevision: 'catalog-1',
    kind: 'resident',
    sourceType: 'memory-manifest',
    accessMode: 'own',
    operationId: 'op-1',
  });
  assert.throws(
    () => canonicalIdentity({ ...context, sourcePin: sourcePin('/tmp/other') }),
    { code: 'source_changed' },
  );
});

test('registerable source executors return standard envelopes', async () => {
  const context = await baseContext();
  const events = [];
  context.reportEvent = event => events.push(event);
  const executors = createSourceOperationExecutors({
    searchService: {
      async search(request) {
        assert.equal(request.identity.requesterAgent, 'ada');
        assert.equal(request.sourcePin, context.sourcePin);
        return { results: [{ id: 'a' }], evidence: evidence({ canonicalRoot: context.target.canonicalRoot }) };
      },
    },
    brainSourceService: {
      async status(request) {
        assert.equal(request.identity.operationId, 'op-1');
        return { ok: true, bounded: true, evidence: evidence({ canonicalRoot: context.target.canonicalRoot }) };
      },
      async graph(request) {
        assert.equal(request.identity.operationId, 'op-1');
        return { bounded: true, evidence: evidence({ canonicalRoot: context.target.canonicalRoot }) };
      },
    },
    graphExportExecutor: async () => ({
      evidence: evidence({ canonicalRoot: context.target.canonicalRoot }),
      resultArtifact: {
        scratchPath: path.join(context.scratchDir, 'x.jsonl'),
        mediaType: 'application/x-ndjson',
        contentEncoding: 'identity',
        bytes: 0,
        sha256: '0'.repeat(64),
      },
    }),
  });

  assert.deepEqual([...executors.keys()].sort(), ['graph', 'graph_export', 'search', 'status'].sort());
  assert.equal((await executors.get('search')({ ...context, operationType: 'search', parameters: { query: 'alpha' } })).state, 'complete');
  assert.equal((await executors.get('status')({ ...context, operationType: 'status' })).state, 'complete');
  assert.equal((await executors.get('graph')({ ...context, operationType: 'graph' })).state, 'complete');
  const exported = await executors.get('graph_export')({ ...context, operationType: 'graph_export' });
  assert.equal(exported.state, 'complete');
  assert.equal(exported.result, null);
  assert.deepEqual(Object.keys(exported.resultArtifact).sort(), [
    'bytes', 'contentEncoding', 'mediaType', 'scratchPath', 'sha256',
  ].sort());
  for (const operationType of ['search', 'status', 'graph', 'graph_export']) {
    assert.equal(events.some(event => event.type === 'progress'
      && event.phase === operationType
      && event.stage === 'source_pin_verified'), true);
    assert.equal(events.some(event => event.type === 'progress'
      && event.phase === operationType
      && event.stage === 'source_operation_finished'), true);
  }
});

test('graph operation routes PGS partition preflight through the canonical pinned source', async () => {
  const context = await baseContext();
  let partitionCalls = 0;
  const executors = createSourceOperationExecutors({
    searchService: { async search() { throw new Error('unexpected search'); } },
    brainSourceService: {
      async status() { throw new Error('unexpected status'); },
      async graph() { throw new Error('bounded graph sample must not stand in for PGS preflight'); },
      async pgsPartitions(request) {
        partitionCalls += 1;
        assert.equal(request.sourcePin, context.sourcePin);
        assert.equal(request.identity.operationId, 'op-1');
        return {
          partitions: [{ partitionId: 'c-alpha', nodeCount: 2, estimatedWorkUnits: 1 }],
          complete: true,
          evidence: evidence({ canonicalRoot: context.target.canonicalRoot }),
        };
      },
    },
    graphExportExecutor: async () => { throw new Error('unexpected export'); },
  });
  const result = await executors.get('graph')({
    ...context,
    operationType: 'graph',
    parameters: { view: 'pgs_partitions' },
  });
  assert.equal(result.state, 'complete');
  assert.equal(result.result.complete, true);
  assert.equal(partitionCalls, 1);
});

test('graph export streams NDJSON artifact and rejects caller-controlled destinations', async () => {
  const context = await baseContext();
  const executor = createGraphExportExecutor();
  const exported = await executor({ ...context, parameters: { format: 'jsonl' }, identity: canonicalIdentity(context) });
  assert.equal(exported.result, null);
  assert.equal(exported.resultArtifact.mediaType, 'application/x-ndjson');
  assert.equal(exported.resultArtifact.contentEncoding, 'identity');
  assert.equal(exported.resultArtifact.scratchPath.startsWith(await fsp.realpath(context.scratchDir)), true);
  assert.match(exported.resultArtifact.sha256, /^[a-f0-9]{64}$/);
  const text = await fsp.readFile(exported.resultArtifact.scratchPath, 'utf8');
  assert.match(text, /"type":"node"/);
  assert.match(text, /"type":"edge"/);
  assert.equal(exported.evidence.graphExport.nodeCount, 2);
  assert.equal(exported.evidence.graphExport.edgeCount, 1);

  await assert.rejects(
    () => executor({ ...context, parameters: { outputPath: '/tmp/x' }, identity: canonicalIdentity(context) }),
    { code: 'invalid_request' },
  );
});

test('graph export reports bounded progress while a large source is still streaming', async t => {
  const context = await baseContext();
  t.after(() => Promise.all([
    fsp.rm(context.target.canonicalRoot, { recursive: true, force: true }),
    fsp.rm(context.scratchDir, { recursive: true, force: true }),
  ]));
  const pin = sourcePin(context.target.canonicalRoot);
  pin.iterateNodes = async function* iterateNodes() {
    for (let index = 0; index < 10_001; index += 1) {
      yield { id: `node-${index}`, concept: `concept ${index}` };
    }
  };
  pin.iterateEdges = async function* iterateEdges() {};
  const events = [];

  await createGraphExportExecutor()({
    ...context,
    sourcePin: pin,
    reportEvent: event => events.push(event),
    parameters: { format: 'jsonl' },
    identity: canonicalIdentity({ ...context, sourcePin: pin }),
  });

  assert.equal(events.some(event => event.type === 'progress'
    && event.phase === 'graph_export'
    && event.stage === 'graph_streaming'
    && event.completedRecords >= 10_000), true);
  assert.equal(events.length <= 2, true);
});

test('graph export enforces requester operation scratch when home root is configured', async () => {
  const { home23Root, context } = await operationScratchContext();
  const executor = createGraphExportExecutor({ home23Root });
  const exported = await executor({ ...context, parameters: { format: 'jsonl' }, identity: canonicalIdentity(context) });
  assert.equal(exported.resultArtifact.scratchPath.startsWith(await fsp.realpath(context.scratchDir)), true);

  const outside = await tempDir('home23-forged-scratch-');
  await assert.rejects(
    () => executor({
      ...context,
      scratchDir: outside,
      parameters: { format: 'jsonl' },
      identity: canonicalIdentity(context),
    }),
    { code: 'invalid_request' },
  );
});

test('graph export rejects a symlinked results directory without writing outside scratch', async t => {
  const { home23Root, context } = await operationScratchContext();
  const outside = await tempDir('home23-forged-results-');
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  await fsp.symlink(outside, path.join(context.scratchDir, 'results'));

  await assert.rejects(
    () => createGraphExportExecutor({ home23Root })({
      ...context,
      parameters: { format: 'jsonl' },
      identity: canonicalIdentity(context),
    }),
    { code: 'invalid_request' },
  );
  assert.deepEqual(await fsp.readdir(outside), []);
});

test('graph export refuses to replace a pre-existing operation artifact', async t => {
  const { home23Root, context } = await operationScratchContext();
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const resultsDir = path.join(context.scratchDir, 'results');
  const destination = path.join(resultsDir, `graph-${context.operationId}.jsonl`);
  await fsp.mkdir(resultsDir, { recursive: false });
  await fsp.writeFile(destination, 'pre-existing artifact\n');

  await assert.rejects(
    () => createGraphExportExecutor({ home23Root })({
      ...context,
      parameters: { format: 'jsonl' },
      identity: canonicalIdentity(context),
    }),
    { code: 'invalid_request' },
  );
  assert.equal(await fsp.readFile(destination, 'utf8'), 'pre-existing artifact\n');
});

test('graph export rejects a temporary artifact with an outside hard link', async t => {
  const { home23Root, context } = await operationScratchContext();
  const outside = await tempDir('home23-export-hardlink-');
  t.after(() => Promise.all([
    fsp.rm(home23Root, { recursive: true, force: true }),
    fsp.rm(outside, { recursive: true, force: true }),
  ]));
  const pin = sourcePin(context.target.canonicalRoot);
  pin.iterateNodes = async function* iterateNodes() {
    const resultsDir = path.join(context.scratchDir, 'results');
    const [temporary] = (await fsp.readdir(resultsDir)).filter(name => name.endsWith('.tmp'));
    assert.ok(temporary);
    await fsp.link(path.join(resultsDir, temporary), path.join(outside, 'linked-artifact'));
    yield { id: 'a', concept: 'alpha' };
  };

  await assert.rejects(
    () => createGraphExportExecutor({ home23Root })({
      ...context,
      sourcePin: pin,
      parameters: { format: 'jsonl' },
      identity: canonicalIdentity({ ...context, sourcePin: pin }),
    }),
    { code: 'invalid_request' },
  );
  assert.deepEqual(await fsp.readdir(path.join(context.scratchDir, 'results')), []);
  assert.equal((await fsp.lstat(path.join(outside, 'linked-artifact'))).isFile(), true);
});

test('graph export retains its quota claim when cleanup cannot prove artifact removal', async t => {
  const { home23Root, context } = await operationScratchContext();
  t.after(() => fsp.rm(home23Root, { recursive: true, force: true }));
  const originalUnlink = fsp.unlink;
  let injectedReplacement = false;
  fsp.unlink = async target => {
    await originalUnlink(target);
    if (!injectedReplacement && target.endsWith('.tmp')) {
      injectedReplacement = true;
      const destination = target.slice(0, -4);
      await originalUnlink(destination);
      await fsp.writeFile(destination, 'replacement artifact\n');
    }
  };

  try {
    await assert.rejects(
      () => createGraphExportExecutor({ home23Root })({
        ...context,
        parameters: { format: 'jsonl' },
        identity: canonicalIdentity(context),
      }),
      { code: 'invalid_request' },
    );
  } finally {
    fsp.unlink = originalUnlink;
  }

  assert.equal(injectedReplacement, true);
  assert.equal(context.scratchQuota.claimed > 0, true);
  const destination = path.join(
    context.scratchDir, 'results', `graph-${context.operationId}.jsonl`,
  );
  assert.equal(await fsp.readFile(destination, 'utf8'), 'replacement artifact\n');
});

test('graph export removes partial output and releases quota on abort', async () => {
  const context = await baseContext();
  const controller = new AbortController();
  const pin = sourcePin(context.target.canonicalRoot);
  let yielded = 0;
  pin.iterateNodes = async function* iterateNodes() {
    yield { id: 'a', concept: 'alpha' };
    yielded += 1;
    controller.abort(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    yield { id: 'b', concept: 'beta' };
  };
  const executor = createGraphExportExecutor();
  await assert.rejects(
    () => executor({
      ...context,
      sourcePin: pin,
      signal: controller.signal,
      parameters: { format: 'jsonl' },
      identity: canonicalIdentity({ ...context, sourcePin: pin }),
    }),
    error => error.name === 'AbortError',
  );
  assert.equal(yielded, 1);
  assert.equal(context.scratchQuota.claimed, 0);
  const resultsDir = path.join(context.scratchDir, 'results');
  const entries = await fsp.readdir(resultsDir).catch(() => []);
  assert.deepEqual(entries, []);
});

test('graph export fails typed and cleans up when scratch quota is exceeded', async () => {
  const context = await baseContext();
  let claimed = 0;
  context.scratchQuota = {
    get claimed() { return claimed; },
    async claim(bytes) {
      if (claimed + bytes > 20) {
        const error = new Error('quota exceeded');
        error.code = 'result_too_large';
        error.status = 413;
        throw error;
      }
      claimed += bytes;
      return claimed;
    },
    async release(bytes) { claimed -= bytes; return claimed; },
  };
  const executor = createGraphExportExecutor();
  await assert.rejects(
    () => executor({ ...context, parameters: { format: 'jsonl' }, identity: canonicalIdentity(context) }),
    { code: 'result_too_large' },
  );
  assert.equal(context.scratchQuota.claimed, 0);
  const resultsDir = path.join(context.scratchDir, 'results');
  const entries = await fsp.readdir(resultsDir).catch(() => []);
  assert.deepEqual(entries, []);
});
