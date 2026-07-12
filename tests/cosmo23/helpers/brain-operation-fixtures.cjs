'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { createGzip } = require('node:zlib');

const {
  createMemorySourcePinProvider,
  createOperationScratchQuota,
  durableBrainOperationRoot,
  sourceDescriptorDigest,
} = require('../../../shared/memory-source/index.cjs');
const {
  issueCapability,
} = require('../../../shared/brain-operations/capability.cjs');
const {
  BrainOperationWorker,
} = require('../../../cosmo23/server/lib/brain-operation-worker.js');

const MiB = 1024 * 1024;

// This is the reviewed test authority for the otherwise-ambiguous "small V8
// heap" requirement. The public probe commands intentionally remain
// `node --expose-gc ...`; each parent probe starts fresh children with the
// exact old-space cap below and rejects a child that was not capped.
const HEAP_PROBE_LIMITS = Object.freeze({
  query: Object.freeze({
    maxOldSpaceMiB: 256,
    maxHeapDeltaBytes: 192 * MiB,
    maxRssDeltaBytes: 256 * MiB,
  }),
  pgs: Object.freeze({
    maxOldSpaceMiB: 384,
    maxHeapDeltaBytes: 256 * MiB,
    maxRssDeltaBytes: 384 * MiB,
  }),
});

const BOUNDARY_KINDS = Object.freeze([
  'brain', 'run', 'pgs', 'session', 'cache', 'export', 'agency',
]);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function writeNdjsonGzip(file, records) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const gzip = createGzip();
  gzip.pipe(output);
  try {
    for await (const record of records) {
      if (!gzip.write(`${JSON.stringify(record)}\n`)) await once(gzip, 'drain');
    }
    gzip.end();
    await once(output, 'close');
  } catch (error) {
    gzip.destroy(error);
    output.destroy(error);
    throw error;
  }
}

async function writeJsonGzip(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const output = fs.createWriteStream(file, { flags: 'wx', mode: 0o600 });
  const gzip = createGzip();
  gzip.pipe(output);
  gzip.end(JSON.stringify(value));
  await once(output, 'close');
}

function safeOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value)) {
    throw new TypeError('fixture operationId must be a safe identifier');
  }
  return value;
}

async function createCommittedMemoryFixture(t, options = {}) {
  const home23Root = await fsp.mkdtemp(path.join(os.tmpdir(), 'home23-brain-fixture-'));
  await fsp.chmod(home23Root, 0o700);
  const targetKind = options.targetKind || 'resident';
  const targetAgent = options.targetAgent || 'forrest';
  const targetRoot = targetKind === 'completed-research'
    ? path.join(home23Root, 'research', 'runs', options.runId || 'run-forrest-completed')
    : path.join(home23Root, 'instances', targetAgent, 'brain');
  const workspaceRoot = path.join(home23Root, 'instances', targetAgent, 'workspace');
  const requester = options.requesterAgent || 'jerry';
  const operationId = safeOperationId(options.operationId || 'op-fixture');
  const operationRoot = durableBrainOperationRoot(home23Root, requester, operationId);
  const scratchDir = path.join(operationRoot, 'scratch');
  const lockRoot = path.join(home23Root, 'runtime', 'brain-source-locks');
  await fsp.mkdir(scratchDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await Promise.all([
    fsp.writeFile(path.join(workspaceRoot, 'SOUL.md'), '# Soul\nFixture identity.\n', {
      flag: 'wx', mode: 0o600,
    }),
    fsp.writeFile(path.join(workspaceRoot, 'MISSION.md'), '# Mission\nFixture mission.\n', {
      flag: 'wx', mode: 0o600,
    }),
    fsp.writeFile(path.join(workspaceRoot, 'BRAIN_INDEX.md'),
      '# Brain Index\n## Alpha canary\n', { flag: 'wx', mode: 0o600 }),
  ]);

  const nodes = options.nodes || [
    { id: 'n1', type: 'fact', content: 'alpha canary', salience: 0.8 },
    { id: 'n2', type: 'fact', content: 'beta', salience: 0.4 },
  ];
  const edges = options.edges || [{ source: 'n1', target: 'n2', type: 'supports' }];
  if (targetKind === 'completed-research') {
    await writeJsonGzip(path.join(targetRoot, 'state.json.gz'), {
      memory: { nodes, edges },
      metadata: { ownerAgent: targetAgent, status: 'COMPLETED', completedAt: 1 },
    });
  } else if (options.legacy === true) {
    await writeNdjsonGzip(path.join(targetRoot, 'memory-nodes.jsonl.gz'), nodes);
    await writeNdjsonGzip(path.join(targetRoot, 'memory-edges.jsonl.gz'), edges);
    await fsp.writeFile(path.join(targetRoot, 'memory-delta.jsonl'), '', {
      flag: 'wx', mode: 0o600,
    });
  } else {
    const nodeBase = path.join(targetRoot, 'memory-nodes.base-1.jsonl.gz');
    const edgeBase = path.join(targetRoot, 'memory-edges.base-1.jsonl.gz');
    await writeNdjsonGzip(nodeBase, nodes);
    await writeNdjsonGzip(edgeBase, edges);
    await fsp.writeFile(path.join(targetRoot, 'memory-delta.e1.jsonl'), '', {
      flag: 'wx', mode: 0o600,
    });
    const manifest = {
      formatVersion: 1,
      generation: 'fixture-1',
      baseRevision: 1,
      currentRevision: 1,
      activeDeltaEpoch: 'e1',
      activeBase: {
        nodes: {
          file: 'memory-nodes.base-1.jsonl.gz',
          count: nodes.length,
          bytes: (await fsp.stat(nodeBase)).size,
        },
        edges: {
          file: 'memory-edges.base-1.jsonl.gz',
          count: edges.length,
          bytes: (await fsp.stat(edgeBase)).size,
        },
      },
      activeDelta: {
        epoch: 'e1', file: 'memory-delta.e1.jsonl', fromRevision: 2,
        toRevision: 1, count: 0, committedBytes: 0,
      },
      ann: { indexFile: null, metaFile: null, builtFromRevision: null },
      summary: { nodeCount: nodes.length, edgeCount: edges.length, clusterCount: 0 },
    };
    await fsp.writeFile(path.join(targetRoot, 'memory-manifest.json'),
      `${JSON.stringify(manifest)}\n`, { flag: 'wx', mode: 0o600 });
  }

  const sourcePins = createMemorySourcePinProvider({ home23Root, requesterAgent: requester });
  const coordinatorPin = await sourcePins.pin(targetRoot, operationId);
  const scratchQuota = await createOperationScratchQuota({
    operationRoot,
    ...(options.scratchMaxBytes === undefined ? {} : { maxBytes: options.scratchMaxBytes }),
  });
  const openExpectations = {
    processIdentity: 'cosmo-999-0123456789abcdef0123',
    operationId,
    requesterAgent: requester,
    operationRoot,
    scratchQuota,
    expectedCanonicalRoot: await fsp.realpath(targetRoot),
    expectedRevision: coordinatorPin.descriptor.cutoffRevision,
    expectedDigest: coordinatorPin.digest,
  };
  const sourcePin = await sourcePins.openPinnedSource(
    coordinatorPin.descriptor,
    openExpectations,
  );
  let sourcePinReleased = false;
  let scratchQuotaClosed = false;
  let coordinatorPinsReleased = false;
  let cleaned = false;

  async function releaseOpenedSourcePin() {
    if (sourcePinReleased) return;
    sourcePinReleased = true;
    await sourcePin.release();
  }

  async function closeScratchQuota() {
    if (scratchQuotaClosed) return;
    scratchQuotaClosed = true;
    await scratchQuota.close();
  }

  async function releaseCoordinatorPins() {
    if (coordinatorPinsReleased) return;
    coordinatorPinsReleased = true;
    await sourcePins.releaseOperationPins(operationId);
  }

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await releaseOpenedSourcePin().catch(() => {});
    await closeScratchQuota().catch(() => {});
    await releaseCoordinatorPins().catch(() => {});
    await fsp.rm(home23Root, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);
  return {
    home23Root,
    targetRoot,
    workspaceRoot,
    targetKind,
    targetAgent,
    requester,
    operationId,
    operationRoot,
    scratchDir,
    lockRoot,
    sourcePins,
    coordinatorPin,
    sourcePin,
    scratchQuota,
    openExpectations,
    releaseOpenedSourcePin,
    closeScratchQuota,
    releaseCoordinatorPins,
    cleanup,
  };
}

function createSyntheticPinnedSource({
  nodeCount,
  edgeCount,
  revision = 7,
  nodeFactory = null,
  edgeFactory = null,
  onRecord = null,
} = {}) {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 0
      || !Number.isSafeInteger(edgeCount) || edgeCount < 0
      || !Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError('synthetic source counts and revision must be safe nonnegative integers');
  }
  let recordsConsumed = 0;
  let nodeRecordsConsumed = 0;
  let edgeRecordsConsumed = 0;
  let outstandingRecords = 0;
  let maxOutstandingRecords = 0;
  let releaseCount = 0;
  let materializerCalls = 0;
  const materializerError = new Error('full materializer forbidden');

  async function* iterateNodes({ signal } = {}) {
    for (let index = 0; index < nodeCount; index += 1) {
      if (signal?.aborted) throw signal.reason;
      const record = nodeFactory ? nodeFactory(index) : {
        id: `n${index}`,
        type: 'fact',
        content: index % 997 === 0 ? `bounded canary ${index}` : `ordinary ${index}`,
        salience: (index % 100) / 100,
        clusterId: `c${index % 256}`,
      };
      recordsConsumed += 1;
      nodeRecordsConsumed += 1;
      outstandingRecords += 1;
      maxOutstandingRecords = Math.max(maxOutstandingRecords, outstandingRecords);
      onRecord?.(recordsConsumed, 'node', index);
      try {
        yield record;
      } finally {
        outstandingRecords -= 1;
      }
    }
  }

  async function* iterateEdges({ signal } = {}) {
    for (let index = 0; index < edgeCount; index += 1) {
      if (signal?.aborted) throw signal.reason;
      const record = edgeFactory ? edgeFactory(index) : {
        source: `n${nodeCount === 0 ? 0 : index % nodeCount}`,
        target: `n${nodeCount === 0 ? 0 : (index + 1) % nodeCount}`,
        type: 'relates',
      };
      recordsConsumed += 1;
      edgeRecordsConsumed += 1;
      outstandingRecords += 1;
      maxOutstandingRecords = Math.max(maxOutstandingRecords, outstandingRecords);
      onRecord?.(recordsConsumed, 'edge', index);
      try {
        yield record;
      } finally {
        outstandingRecords -= 1;
      }
    }
  }

  const descriptor = Object.freeze({
    version: 1,
    canonicalRoot: '/synthetic',
    generation: 'synthetic',
    baseRevision: revision,
    cutoffRevision: revision,
    summary: {
      nodeCount,
      edgeCount,
      clusterCount: Math.min(nodeCount, 256),
    },
    activeBase: {
      nodes: { file: 'nodes', count: nodeCount, bytes: 1 },
      edges: { file: 'edges', count: edgeCount, bytes: 1 },
    },
    activeDelta: {
      epoch: '0', file: 'delta', fromRevision: revision + 1,
      toRevision: revision, count: 0, committedBytes: 0,
    },
  });
  const evidence = Object.freeze({
    sourceHealth: 'healthy',
    freshness: 'known',
    baseWatermark: { revision },
    deltaWatermark: { revision },
    indexWatermark: { builtFromRevision: null },
    authoritativeTotals: { nodes: nodeCount, edges: edgeCount },
  });

  function materialize() {
    materializerCalls += 1;
    throw materializerError;
  }

  return {
    revision,
    descriptor,
    descriptorDigest: sourceDescriptorDigest(descriptor),
    evidence,
    iterateNodes,
    iterateEdges,
    async summarize({ signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      return { nodeCount, edgeCount, clusterCount: Math.min(nodeCount, 256) };
    },
    async searchKeyword(query, { topK = 10, signal } = {}) {
      if (signal?.aborted) throw signal.reason;
      const results = [];
      for await (const node of iterateNodes({ signal })) {
        if (String(node.content).includes(String(query))) results.push(node);
        if (results.length >= topK) break;
      }
      return { results };
    },
    async isCurrent() { return true; },
    async compareAndSwap(commit) { return { committed: true, value: await commit() }; },
    loadAll: materialize,
    loadState: materialize,
    readGraph: materialize,
    createPinnedQueryState: materialize,
    getEvidence(extra = {}) {
      const returnedTotals = extra.returnedTotals || { nodes: 0, edges: 0 };
      const completeCoverage = extra.completeCoverage === true;
      const filteredTotal = extra.filteredTotal || 0;
      const matchOutcome = returnedTotals.nodes > 0
        ? 'matches'
        : !completeCoverage ? 'unknown'
          : nodeCount === 0 ? 'corpus_empty'
            : filteredTotal > 0 ? 'filtered' : 'no_match';
      return {
        ...evidence,
        returnedTotals,
        completeCoverage,
        filteredTotal,
        matchOutcome,
        ...extra,
      };
    },
    stats() {
      return {
        recordsConsumed,
        nodeRecordsConsumed,
        edgeRecordsConsumed,
        outstandingRecords,
        maxOutstandingRecords,
        releaseCount,
        materializerCalls,
      };
    },
    async release() { releaseCount += 1; },
  };
}

async function snapshotTreeNoFollow(root) {
  const rows = [];
  async function visit(relative) {
    const absolute = path.join(root, relative);
    const stat = await fsp.lstat(absolute);
    if (stat.isSymbolicLink()) {
      rows.push(['symlink', relative, await fsp.readlink(absolute)]);
      return;
    }
    if (stat.isDirectory()) {
      rows.push(['directory', relative, stat.mode]);
      for (const name of (await fsp.readdir(absolute)).sort()) {
        await visit(path.join(relative, name));
      }
      return;
    }
    if (stat.isFile()) {
      const bytes = await fsp.readFile(absolute);
      rows.push([
        'file', relative, stat.mode, stat.size,
        crypto.createHash('sha256').update(bytes).digest('hex'),
      ]);
      return;
    }
    rows.push(['other', relative, stat.mode, stat.size]);
  }
  await visit('.');
  return rows;
}

async function createProtectedReadOnlyFixture(t, {
  operationType,
  targetKind = 'resident',
} = {}) {
  const memory = await createCommittedMemoryFixture(null, {
    operationId: `op-${operationType || 'query'}`,
    targetKind,
  });
  const before = await snapshotTreeNoFollow(memory.targetRoot);
  const cleanup = async () => memory.cleanup();
  if (t) t.after(cleanup);
  return {
    ...memory,
    before,
    requesterAgent: memory.requester,
    targetAgent: memory.targetAgent,
    capabilityClaims: {
      operationId: memory.operationId,
      operationType,
      requesterAgent: memory.requester,
      targetDomain: 'brain',
      targetBrainId: memory.targetKind === 'completed-research'
        ? 'research-run-forrest-completed'
        : 'brain-forrest',
      targetRunId: null,
      targetRequesterAgent: null,
      canonicalRoot: await fsp.realpath(memory.targetRoot),
      sourcePinDigest: memory.coordinatorPin.digest,
      accessMode: 'read-only',
    },
    async assertTargetUnchanged() {
      assert.deepEqual(await snapshotTreeNoFollow(memory.targetRoot), before);
    },
  };
}

function mutationBoundaries(canonicalRoot) {
  return BOUNDARY_KINDS.map((kind) => ({
    kind,
    path: kind === 'brain' || kind === 'run'
      ? canonicalRoot
      : path.join(canonicalRoot, kind),
  }));
}

function waitForAbort(signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function createProtectedWorkerHarness(t, options = {}) {
  const operationType = options.operationType || 'query';
  const operationId = options.operationId || `brop_${'f'.repeat(32)}`;
  const memory = await createCommittedMemoryFixture(null, {
    operationId,
    requesterAgent: options.requesterAgent || 'jerry',
    targetAgent: options.targetAgent || 'forrest',
  });
  await memory.releaseOpenedSourcePin();
  await memory.closeScratchQuota();

  const canonicalRoot = await fsp.realpath(memory.targetRoot);
  const target = Object.freeze({
    domain: 'brain',
    brainId: `brain-${memory.targetAgent}`,
    canonicalRoot,
    accessMode: memory.requester === memory.targetAgent ? 'own' : 'read-only',
    ownerAgent: memory.targetAgent,
    displayName: `${memory.targetAgent} Brain`,
    kind: 'resident',
    lifecycle: 'resident',
    catalogRevision: 'catalog-fixture-1',
    route: `/api/brain/brain-${memory.targetAgent}`,
    mutationBoundaries: mutationBoundaries(canonicalRoot),
  });
  const capabilityKey = options.capabilityKey || 'brain-operation-fixture-capability-key';
  const processIdentity = options.processIdentity
    || `cosmo-${process.pid}-${crypto.createHash('sha256')
      .update(`${process.pid}:brain-operation-fixture`).digest('hex').slice(0, 20)}`;
  const executorGate = deferred();
  const releaseGate = deferred();
  let executorFinished = false;
  let releaseFinished = options.deferRelease !== true;
  let processPinReleaseCalls = 0;
  let coordinatorPinReleaseCalls = 0;
  let executorPinReleaseCalls = 0;
  let openPinnedSourceCalls = 0;
  let queryEngineCalls = 0;
  let providerCalls = 0;
  let nonce = 0;
  let coordinatorReleased = false;
  let cleaned = false;

  const sourcePins = {
    async openPinnedSource(descriptor, expectations) {
      openPinnedSourceCalls += 1;
      const sourcePin = await memory.sourcePins.openPinnedSource(descriptor, expectations);
      let released = false;
      return {
        ...sourcePin,
        async release() {
          if (released) return;
          released = true;
          processPinReleaseCalls += 1;
          if (!releaseFinished) await releaseGate.promise;
          await sourcePin.release();
        },
      };
    },
    async releaseOperationPins(id) {
      if (coordinatorReleased) return;
      coordinatorReleased = true;
      coordinatorPinReleaseCalls += 1;
      await memory.sourcePins.releaseOperationPins(id);
    },
  };

  const defaultEnvelope = Object.freeze({
    state: 'complete',
    result: Object.freeze({ answer: 'protected worker fixture result' }),
    resultArtifact: null,
    error: null,
    sourceEvidence: Object.freeze({
      sourceHealth: 'healthy',
      deltaWatermark: Object.freeze({
        revision: memory.coordinatorPin.descriptor.cutoffRevision,
      }),
    }),
  });
  const executor = async ({ signal, sourcePin }) => {
    queryEngineCalls += 1;
    if (options.executorReleasesPin === true) {
      executorPinReleaseCalls += 1;
      await sourcePin.release();
    }
    if (options.providerCall === true) providerCalls += 1;
    if (options.deferExecutor === false) return options.executorResult || defaultEnvelope;
    return Promise.race([executorGate.promise, waitForAbort(signal)]);
  };
  const worker = new BrainOperationWorker({
    home23Root: memory.home23Root,
    capabilityKey,
    resolveTarget: async ({ target: requestedTarget }) => {
      assert.deepEqual(requestedTarget, target);
      return structuredClone(target);
    },
    sourcePins,
    executors: new Map([[operationType, executor]]),
    processIdentity,
    processStartIdentity: 'brain-operation-fixture-process-start',
  });

  function validStartRequest(overrides = {}) {
    return {
      operationId,
      operationType,
      requesterAgent: memory.requester,
      target: structuredClone(target),
      parameters: operationType === 'pgs'
        ? {
          query: 'fixture question',
          pgsSweep: { provider: 'sweep', model: 'controlled' },
          pgsSynth: { provider: 'synth', model: 'controlled' },
        }
        : { query: 'fixture question' },
      operationControl: {
        hardDeadlineAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
      sourcePinDescriptor: structuredClone(memory.coordinatorPin.descriptor),
      sourcePinDigest: memory.coordinatorPin.digest,
      ...structuredClone(overrides),
    };
  }
  const startRequest = validStartRequest();

  function capability(request = startRequest) {
    const now = Date.now();
    return issueCapability(capabilityKey, {
      requesterAgent: request.requesterAgent,
      targetDomain: request.target.domain,
      targetBrainId: request.target.brainId,
      targetRunId: null,
      targetRequesterAgent: null,
      canonicalRoot: request.target.canonicalRoot,
      accessMode: request.target.accessMode,
      operationType: request.operationType,
      operationId: request.operationId,
      sourcePinDigest: request.sourcePinDigest,
      issuedAt: now,
      expiresAt: now + 60_000,
      nonce: `fixture-nonce-${++nonce}`,
    });
  }

  function finishExecutor(value = options.executorResult || defaultEnvelope) {
    if (executorFinished) return;
    executorFinished = true;
    executorGate.resolve(value);
  }

  function finishRelease() {
    if (releaseFinished) return;
    releaseFinished = true;
    releaseGate.resolve();
  }

  async function waitForTerminal(timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const status = await worker.status(operationId, capability());
      if (['complete', 'partial', 'failed', 'cancelled', 'interrupted'].includes(status.state)) {
        return status;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('protected worker fixture did not reach terminal state');
  }

  async function startAndWait({ finish = true, timeoutMs = 10_000 } = {}) {
    const started = await worker.start(operationId, capability(startRequest), startRequest);
    if (finish) finishExecutor();
    const status = await waitForTerminal(timeoutMs);
    return { started, status, terminal: await readTerminal() };
  }

  async function cancel() {
    return worker.cancel(operationId, capability());
  }

  async function stopWorkerOrderly() {
    finishRelease();
    await worker.stop();
  }

  async function detachAttachment(reason = 'fixture detach') {
    const controller = new AbortController();
    controller.abort(Object.assign(new Error(reason), { code: 'detached' }));
    return worker.status(operationId, capability());
  }

  function triggerTerminalCleanup() {
    const record = worker.records.get(operationId);
    if (!record) throw new Error('protected worker fixture has not started');
    return worker._releaseOnce(record);
  }

  async function readTerminal() {
    return worker.result(operationId, capability());
  }

  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    finishExecutor();
    finishRelease();
    await worker.stop().catch(() => {});
    await sourcePins.releaseOperationPins(operationId).catch(() => {});
    await fsp.rm(memory.home23Root, { recursive: true, force: true });
  };
  if (t) t.after(cleanup);

  const harness = {
    home23Root: memory.home23Root,
    operationRoot: memory.operationRoot,
    processIdentity,
    sourcePinDescriptor: memory.coordinatorPin.descriptor,
    sourcePinDigest: memory.coordinatorPin.digest,
    validStartRequest,
    startRequest,
    startAndWait,
    cancel,
    stopWorkerOrderly,
    detachAttachment,
    finishExecutor,
    triggerTerminalCleanup,
    finishRelease,
    readTerminal,
    processPinDirectory: () => path.join(memory.operationRoot, 'pins', processIdentity),
    cleanup,
  };
  Object.defineProperties(harness, {
    processPinReleaseCalls: { enumerable: true, get: () => processPinReleaseCalls },
    coordinatorPinReleaseCalls: { enumerable: true, get: () => coordinatorPinReleaseCalls },
    executorPinReleaseCalls: { enumerable: true, get: () => executorPinReleaseCalls },
    openPinnedSourceCalls: { enumerable: true, get: () => openPinnedSourceCalls },
    queryEngineCalls: { enumerable: true, get: () => queryEngineCalls },
    providerCalls: { enumerable: true, get: () => providerCalls },
  });
  return harness;
}

module.exports = {
  HEAP_PROBE_LIMITS,
  createCommittedMemoryFixture,
  createProtectedReadOnlyFixture,
  createProtectedWorkerHarness,
  createSyntheticPinnedSource,
  deferred,
  snapshotTreeNoFollow,
  writeJsonGzip,
  writeNdjsonGzip,
};
