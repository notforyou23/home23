#!/usr/bin/env node

import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import v8 from 'node:v8';
import {
  canonicalDirectory,
  failCli,
  hashFile,
  isInsideOrEqual,
  isMain,
  one,
  parseCli,
  readJson,
  receiptContext,
  typedError,
  writeJsonReceipt,
} from './lib/brain-acceptance-common.mjs';

const require = createRequire(import.meta.url);
const {
  createOperationScratchQuota,
  openMemorySource,
  resolveMemorySourceSelection,
} = require('../shared/memory-source/index.cjs');
const {
  loadMemoryRevision,
  persistMemoryRevision,
} = require('../engine/src/core/memory-persistence.js');

const DEFAULT_MAX_HEAP_USED_MIB = 768;
const DEFAULT_MAX_RSS_MIB = 2_048;
const MIB = 1024 * 1024;

function safeAgent(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw typedError('agent_invalid');
  }
  return value;
}

function positiveLimit(value, fallback, label) {
  const parsed = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw typedError('resource_limit_invalid', label);
  return parsed;
}

function createResourceTracker({
  maxHeapUsedMiB = DEFAULT_MAX_HEAP_USED_MIB,
  maxRssMiB = DEFAULT_MAX_RSS_MIB,
} = {}) {
  const heapLimit = positiveLimit(maxHeapUsedMiB, DEFAULT_MAX_HEAP_USED_MIB, 'maxHeapUsedMiB');
  const rssLimit = positiveLimit(maxRssMiB, DEFAULT_MAX_RSS_MIB, 'maxRssMiB');
  let peakHeapUsedBytes = 0;
  let peakRssBytes = 0;
  let samples = 0;
  function sample() {
    const usage = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, usage.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, usage.rss);
    samples += 1;
    if (usage.heapUsed > heapLimit * MIB) {
      throw typedError('heap_budget_exceeded', `${Math.ceil(usage.heapUsed / MIB)} MiB`);
    }
    if (usage.rss > rssLimit * MIB) {
      throw typedError('rss_budget_exceeded', `${Math.ceil(usage.rss / MIB)} MiB`);
    }
  }
  sample();
  return {
    sample,
    summary() {
      sample();
      return {
        samples,
        peakHeapUsedMiB: Number((peakHeapUsedBytes / MIB).toFixed(3)),
        peakRssMiB: Number((peakRssBytes / MIB).toFixed(3)),
        maxHeapUsedMiB: heapLimit,
        maxRssMiB: rssLimit,
        v8HeapLimitMiB: Number((v8.getHeapStatistics().heap_size_limit / MIB).toFixed(3)),
      };
    },
  };
}

async function optionalSnapshot(brainDir) {
  const file = path.join(brainDir, 'brain-snapshot.json');
  try {
    return { file, value: await readJson(file, { maxBytes: 32 * 1024 * 1024 }) };
  } catch (error) {
    if (error.code === 'ENOENT' || error?.cause?.code === 'ENOENT') return { file, value: null };
    throw typedError('snapshot_invalid', error.message, { cause: error });
  }
}

function snapshotTotals(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const nodes = Number(snapshot.nodeCount ?? snapshot.memory?.nodeCount ?? snapshot.memory?.nodes);
  const edges = Number(snapshot.edgeCount ?? snapshot.memory?.edgeCount ?? snapshot.memory?.edges);
  if (!Number.isSafeInteger(nodes) || nodes <= 0 || !Number.isSafeInteger(edges) || edges < 0) {
    return null;
  }
  return {
    nodes,
    edges,
    revision: snapshot.currentRevision ?? snapshot.revision ?? snapshot.memoryRevision ?? null,
    generation: snapshot.generation ?? snapshot.memoryGeneration ?? null,
    savedAt: snapshot.savedAt ?? null,
  };
}

async function selectionInventory(brainDir) {
  const selection = await resolveMemorySourceSelection(brainDir);
  if (!selection || selection.authority === 'unavailable') throw typedError('source_unavailable');
  const records = [];
  for (const entry of selection.targetFiles || []) {
    if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)
        || !isInsideOrEqual(brainDir, entry.path)) {
      throw typedError('source_selection_invalid');
    }
    let stat;
    try {
      stat = await fsp.lstat(entry.path, { bigint: true });
    } catch (error) {
      if (entry.optional === true && error.code === 'ENOENT') {
        records.push({ role: entry.role, path: path.relative(brainDir, entry.path), absent: true });
        continue;
      }
      throw typedError('source_file_unavailable', entry.role, { cause: error });
    }
    if (!stat.isFile() || stat.isSymbolicLink() || await fsp.realpath(entry.path) !== entry.path) {
      throw typedError('source_file_invalid', entry.role);
    }
    const prefixBytes = entry.committedBytes === undefined ? undefined : Number(entry.committedBytes);
    const hashed = await hashFile(entry.path, { prefixBytes });
    records.push({
      role: entry.role,
      path: path.relative(brainDir, entry.path),
      committedBytes: prefixBytes ?? null,
      ...hashed,
    });
  }
  records.sort((left, right) => left.role.localeCompare(right.role) || left.path.localeCompare(right.path));
  return {
    authority: selection.authority,
    manifest: selection.manifest || null,
    records,
  };
}

function inventoryComparable(value) {
  return JSON.stringify({ authority: value.authority, manifest: value.manifest, records: value.records });
}

async function guardedRemoveOwnedDirectory(directory, parentRoot, prefix) {
  const current = await fsp.lstat(directory.path, { bigint: true });
  const parent = await fsp.realpath(path.dirname(directory.path));
  if (parent !== parentRoot || !path.basename(directory.path).startsWith(prefix)
      || current.dev.toString() !== directory.dev || current.ino.toString() !== directory.ino
      || !current.isDirectory() || current.isSymbolicLink()) {
    throw typedError('temporary_cleanup_guard_failed');
  }
  await fsp.rm(directory.path, { recursive: true, force: false });
}

function encodedRecord(record) {
  let text;
  try {
    text = JSON.stringify(record);
  } catch (error) {
    throw typedError('source_record_invalid', error.message, { cause: error });
  }
  if (typeof text !== 'string') throw typedError('source_record_invalid');
  return text;
}

async function streamLogicalSource({
  brainDir,
  scratchRoot,
  requesterAgent,
  operationLabel,
  canaryId = null,
  maxHeapUsedMiB,
  maxRssMiB,
} = {}) {
  const tracker = createResourceTracker({ maxHeapUsedMiB, maxRssMiB });
  const operationPath = await fsp.mkdtemp(path.join(scratchRoot, `brain-stream-${operationLabel}-`));
  const operation = await canonicalDirectory(operationPath, 'stream operation root');
  const quota = await createOperationScratchQuota({ operationRoot: operation.path });
  const nodeHash = crypto.createHash('sha256');
  const edgeHash = crypto.createHash('sha256');
  let nodeCount = 0;
  let edgeCount = 0;
  let largestNode = null;
  let largestNodeBytes = -1;
  let largestEdge = null;
  let largestEdgeBytes = -1;
  let canaryMatches = 0;
  let source = null;
  try {
    source = await openMemorySource(brainDir, {
      requesterAgent,
      operationId: path.basename(operation.path),
      operationRoot: operation.path,
      scratchQuota: quota,
      lockRoot: path.join(scratchRoot, 'brain-source-locks'),
    });
    const initialEvidence = source.getEvidence();
    if (initialEvidence?.sourceHealth === 'unavailable') throw typedError('source_unavailable');
    for await (const node of source.iterateNodes()) {
      const encoded = encodedRecord(node);
      const bytes = Buffer.byteLength(encoded);
      nodeHash.update(encoded).update('\n');
      nodeCount += 1;
      if (bytes > largestNodeBytes) {
        largestNode = JSON.parse(encoded);
        largestNodeBytes = bytes;
      }
      if (canaryId !== null && String(node.id) === canaryId) canaryMatches += 1;
      if ((nodeCount & 255) === 0) tracker.sample();
    }
    for await (const edge of source.iterateEdges()) {
      const encoded = encodedRecord(edge);
      const bytes = Buffer.byteLength(encoded);
      edgeHash.update(encoded).update('\n');
      edgeCount += 1;
      if (bytes > largestEdgeBytes) {
        largestEdge = JSON.parse(encoded);
        largestEdgeBytes = bytes;
      }
      if ((edgeCount & 255) === 0) tracker.sample();
    }
    const summary = await source.summarize();
    if (summary.nodes !== nodeCount || summary.edges !== edgeCount) {
      throw typedError('streamed_count_mismatch');
    }
    if (await Promise.resolve(source.isCurrent()) !== true) {
      throw typedError('source_changed_concurrently');
    }
    const evidence = source.getEvidence({
      completeCoverage: true,
      authoritativeTotals: { nodes: nodeCount, edges: edgeCount },
      returnedTotals: { nodes: nodeCount, edges: edgeCount },
    });
    return {
      proof: {
        nodes: nodeCount,
        edges: edgeCount,
        clusters: summary.clusters,
        revision: source.revision ?? null,
        nodeLogicalSha256: nodeHash.digest('hex'),
        edgeLogicalSha256: edgeHash.digest('hex'),
        largestNodeBytes,
        largestEdgeBytes,
        canaryMatches,
        sourceHealth: evidence.sourceHealth,
        implementation: evidence.implementation,
        resources: tracker.summary(),
      },
      representative: { node: largestNode, edge: largestEdge },
    };
  } finally {
    await source?.close?.().catch(() => {});
    await quota.close();
    await guardedRemoveOwnedDirectory(operation, scratchRoot, `brain-stream-${operationLabel}-`);
  }
}

function validateStreamed({ streamed, inventory, snapshot }) {
  const nodes = streamed?.nodes;
  const edges = streamed?.edges;
  if (!Number.isSafeInteger(nodes) || nodes <= 0 || !Number.isSafeInteger(edges) || edges < 0) {
    throw typedError('streamed_counts_invalid');
  }
  const snapshotExpected = snapshotTotals(snapshot);
  if (!snapshotExpected) throw typedError('snapshot_counts_invalid');
  let expected;
  if (inventory.authority === 'manifest-v1') {
    const summary = inventory.manifest?.summary;
    expected = { nodes: summary?.nodeCount, edges: summary?.edgeCount };
    if (!Number.isSafeInteger(expected.nodes) || expected.nodes <= 0
        || !Number.isSafeInteger(expected.edges) || expected.edges < 0) {
      throw typedError('manifest_counts_invalid');
    }
    if (streamed.revision !== inventory.manifest.currentRevision) throw typedError('revision_mismatch');
    if (!Number.isSafeInteger(snapshotExpected.revision)
        || snapshotExpected.revision !== inventory.manifest.currentRevision) {
      throw typedError('snapshot_stale');
    }
    if (snapshotExpected.generation === null || snapshotExpected.generation === undefined
        || snapshotExpected.generation !== inventory.manifest.generation) {
      throw typedError('snapshot_stale');
    }
  } else if (inventory.authority === 'legacy-resident-sidecars') {
    expected = { nodes: snapshotExpected.nodes, edges: snapshotExpected.edges };
  } else {
    throw typedError('source_authority_unsupported', inventory.authority);
  }
  if (nodes !== expected.nodes || edges !== expected.edges
      || nodes !== snapshotExpected.nodes || edges !== snapshotExpected.edges) {
    throw typedError('persistence_count_mismatch');
  }
  return { expected, snapshot: snapshotExpected };
}

async function assertExternalTempRoot(home23Root, tempRoot) {
  const home = await canonicalDirectory(home23Root, 'Home23 root');
  const temporary = await canonicalDirectory(tempRoot, 'temporary proof root');
  if (isInsideOrEqual(home.path, temporary.path) || isInsideOrEqual(temporary.path, home.path)) {
    throw typedError('temp_root_overlaps_home23');
  }
  for (const liveBrain of await discoverLiveBrains(home.path)) {
    if (isInsideOrEqual(liveBrain, temporary.path) || isInsideOrEqual(temporary.path, liveBrain)) {
      throw typedError('temp_root_overlaps_live_brain');
    }
  }
  return { home, temporary };
}

async function captureReadOnlyPersistence({
  home23Root,
  agent,
  brainDir,
  tempRoot,
  maxHeapUsedMiB,
  maxRssMiB,
  afterStream,
} = {}) {
  const { home, temporary } = await assertExternalTempRoot(home23Root, tempRoot);
  const requesterAgent = safeAgent(agent);
  const expectedBrain = path.join(home.path, 'instances', requesterAgent, 'brain');
  const brain = await canonicalDirectory(brainDir, 'brain');
  if (brain.path !== expectedBrain) throw typedError('brain_target_mismatch');
  const before = await selectionInventory(brain.path);
  const snapshot = (await optionalSnapshot(brain.path)).value;
  const streamed = await streamLogicalSource({
    brainDir: brain.path,
    scratchRoot: temporary.path,
    requesterAgent,
    operationLabel: `live-${requesterAgent}`,
    maxHeapUsedMiB,
    maxRssMiB,
  });
  await afterStream?.({ streamed: streamed.proof, before });
  const validated = validateStreamed({ streamed: streamed.proof, inventory: before, snapshot });
  const after = await selectionInventory(brain.path);
  if (inventoryComparable(before) !== inventoryComparable(after)) {
    throw typedError('source_changed_concurrently');
  }
  const proof = {
    ok: true,
    mode: 'read-only-stream',
    sourceBrainDir: brain.path,
    writeBrainDir: null,
    selectedAuthority: before.authority,
    sourceRevision: before.manifest?.currentRevision ?? null,
    streamed: streamed.proof,
    expected: validated.expected,
    snapshot: validated.snapshot,
    before: before.records,
    after: after.records,
    unchanged: true,
    fullMaterializerUsed: false,
  };
  return {
    proof,
    inventory: before,
    representative: streamed.representative,
    temporary,
  };
}

export async function verifyReadOnlyPersistence(options = {}) {
  return (await captureReadOnlyPersistence(options)).proof;
}

async function discoverLiveBrains(home23Root) {
  const instancesRoot = path.join(home23Root, 'instances');
  const entries = await fsp.readdir(instancesRoot, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const candidate = path.join(instancesRoot, entry.name, 'brain');
    const canonical = await fsp.realpath(candidate).catch(() => null);
    if (canonical) roots.push(canonical);
  }
  return roots;
}

function fullMemoryFacade(nodesInput, edgesInput) {
  const nodes = new Map(nodesInput.map((node) => [String(node.id), node]));
  const edges = new Map(edgesInput.map((edge, index) => [
    String(edge.key ?? `${edge.source ?? edge.from}->${edge.target ?? edge.to}#${index}`), edge,
  ]));
  const clusterCount = new Set(nodesInput
    .map((node) => node.cluster)
    .filter((value) => value != null)).size;
  const generation = 1;
  return {
    nodes,
    edges,
    capturePersistenceSnapshot() {
      return {
        generation,
        fullView: { nodes: [...nodes.values()], edges: [...edges.values()] },
        changes: { nodes: [], edges: [], removedNodeIds: [], removedEdgeKeys: [] },
        summary: { nodeCount: nodes.size, edgeCount: edges.size, clusterCount },
      };
    },
    markPersistenceCleanIfGeneration(value) { return value === generation; },
  };
}

function deltaCanaryFacade({ canary, baseline }) {
  const generation = 1;
  return {
    capturePersistenceChangesSnapshot() {
      return {
        generation,
        changes: { nodes: [canary], edges: [], removedNodeIds: [], removedEdgeKeys: [] },
        summary: {
          nodeCount: baseline.nodes + 1,
          edgeCount: baseline.edges,
          clusterCount: Number.isSafeInteger(baseline.clusters) ? baseline.clusters + 1 : 1,
        },
      };
    },
    capturePersistenceSnapshot() {
      throw typedError('full_materializer_forbidden');
    },
    markPersistenceCleanIfGeneration(value) { return value === generation; },
  };
}

async function copyPinnedSelection(sourceBrainDir, cloneDir, inventory) {
  const copies = [];
  for (const record of inventory.records) {
    if (record.absent) continue;
    const source = path.join(sourceBrainDir, record.path);
    const destination = path.join(cloneDir, record.path);
    if (!isInsideOrEqual(cloneDir, destination)) throw typedError('clone_path_invalid');
    await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const sourceHandle = await fsp.open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    let destinationHandle;
    try {
      const before = await sourceHandle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink()
          || before.dev.toString() !== record.dev || before.ino.toString() !== record.ino
          || before.size.toString() !== String(record.physicalSize)) {
        throw typedError('source_changed_concurrently');
      }
      const copyBytes = Number(before.size);
      if (!Number.isSafeInteger(copyBytes) || copyBytes < 0) throw typedError('source_selection_invalid');
      destinationHandle = await fsp.open(destination, 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, copyBytes)));
      const sourceDigest = crypto.createHash('sha256');
      let offset = 0;
      while (offset < copyBytes) {
        const { bytesRead } = await sourceHandle.read(
          buffer, 0, Math.min(buffer.length, copyBytes - offset), offset,
        );
        if (bytesRead === 0) throw typedError('source_changed_concurrently');
        sourceDigest.update(buffer.subarray(0, bytesRead));
        await destinationHandle.write(buffer, 0, bytesRead, offset);
        offset += bytesRead;
      }
      await destinationHandle.sync();
      const after = await sourceHandle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw typedError('source_changed_concurrently');
      }
      const sourceSha256 = sourceDigest.digest('hex');
      const destinationHash = await hashFile(destination);
      if (destinationHash.sha256 !== sourceSha256 || destinationHash.physicalSize !== copyBytes) {
        throw typedError('clone_copy_mismatch');
      }
      copies.push({
        role: record.role,
        path: record.path,
        bytes: copyBytes,
        sourceSha256,
        destinationSha256: destinationHash.sha256,
      });
    } finally {
      await destinationHandle?.close();
      await sourceHandle.close();
    }
  }
  return copies;
}

async function assertDirectoryIdentity(directory, label) {
  const stat = await fsp.lstat(directory.path, { bigint: true }).catch((error) => {
    throw typedError('clone_identity_changed', `${label} is unavailable`, { cause: error });
  });
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || stat.dev.toString() !== directory.dev || stat.ino.toString() !== directory.ino
      || await fsp.realpath(directory.path) !== directory.path) {
    throw typedError('clone_identity_changed', `${label} identity changed`);
  }
}

async function assertInventoryUnchanged(brainDir, expected) {
  const current = await selectionInventory(brainDir);
  if (inventoryComparable(expected) !== inventoryComparable(current)) {
    throw typedError('source_changed_concurrently');
  }
  return current;
}

async function pruneGeneratedEmptyRuntime(tempRoot) {
  const candidates = [
    path.join(tempRoot, 'instances', 'bounded-forcefull-proof', 'runtime', 'brain-operations'),
    path.join(tempRoot, 'instances', 'bounded-forcefull-proof', 'runtime'),
    path.join(tempRoot, 'instances', 'bounded-forcefull-proof'),
    path.join(tempRoot, 'instances'),
    path.join(tempRoot, 'runtime', 'brain-source-locks'),
    path.join(tempRoot, 'runtime'),
    path.join(tempRoot, 'brain-source-locks'),
  ];
  for (const candidate of candidates) {
    if (!isInsideOrEqual(tempRoot, candidate) || candidate === tempRoot) {
      throw typedError('temp_runtime_cleanup_guard_failed');
    }
    try {
      await fsp.rmdir(candidate);
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTEMPTY') continue;
      throw typedError('temp_runtime_cleanup_guard_failed', candidate, { cause: error });
    }
  }
}

function boundedRepresentative(representative) {
  if (!representative?.node) throw typedError('representative_node_missing');
  const first = { ...representative.node, id: 'bounded-proof-node-1' };
  const second = { ...representative.node, id: 'bounded-proof-node-2' };
  const edge = representative.edge
    ? {
      ...representative.edge,
      key: 'bounded-proof-node-1->bounded-proof-node-2',
      source: 'bounded-proof-node-1',
      target: 'bounded-proof-node-2',
      from: 'bounded-proof-node-1',
      to: 'bounded-proof-node-2',
    }
    : {
      key: 'bounded-proof-node-1->bounded-proof-node-2',
      source: 'bounded-proof-node-1',
      target: 'bounded-proof-node-2',
      weight: 1,
    };
  return { nodes: [first, second], edges: [edge] };
}

async function proveBoundedForceFull({ tempRoot, representative, persister, loader }) {
  const boundedPath = await fsp.mkdtemp(path.join(tempRoot, 'brain-bounded-forcefull-'));
  const bounded = await canonicalDirectory(boundedPath, 'bounded force-full clone');
  const view = boundedRepresentative(representative);
  const scheduled = [];
  let result;
  try {
    const persisted = await persister({
      brainDir: bounded.path,
      memory: fullMemoryFacade(view.nodes, view.edges),
      forceFull: true,
      home23Root: tempRoot,
      schedule: (callback) => { scheduled.push(callback); },
    });
    const reloaded = await loader(bounded.path, {
      home23Root: tempRoot,
      requesterAgent: 'bounded-forcefull-proof',
      operationId: `bounded-forcefull-load-${process.pid}-${Date.now()}`,
    });
    if (reloaded.nodes.length !== view.nodes.length || reloaded.edges.length !== view.edges.length
        || reloaded.revision !== persisted.manifest?.currentRevision) {
      throw typedError('bounded_forcefull_reload_mismatch');
    }
    result = {
      persistedMode: persisted.mode,
      persistedRevision: persisted.manifest.currentRevision,
      reloadedRevision: reloaded.revision,
      loaded: { nodes: reloaded.nodes.length, edges: reloaded.edges.length },
      representativeLargestNodeBytes: Buffer.byteLength(encodedRecord(representative.node)),
      representativeLargestEdgeBytes: representative.edge
        ? Buffer.byteLength(encodedRecord(representative.edge)) : 0,
      retirementDeferred: scheduled.length,
    };
  } finally {
    await assertDirectoryIdentity(bounded, 'bounded force-full clone');
    await guardedRemoveOwnedDirectory(bounded, tempRoot, 'brain-bounded-forcefull-');
  }
  return result;
}

export async function verifyTempSaveClone({
  home23Root,
  agent,
  brainDir,
  tempRoot,
  maxHeapUsedMiB,
  maxRssMiB,
  persister = persistMemoryRevision,
  boundedLoader = loadMemoryRevision,
  afterReadOnlyProof,
  removeClone,
} = {}) {
  const { home, temporary } = await assertExternalTempRoot(home23Root, tempRoot);
  if ((await fsp.readdir(temporary.path)).length !== 0) throw typedError('temp_root_not_empty');
  const captured = await captureReadOnlyPersistence({
    home23Root: home.path,
    agent,
    brainDir,
    tempRoot: temporary.path,
    maxHeapUsedMiB,
    maxRssMiB,
  });
  const liveProof = captured.proof;
  await afterReadOnlyProof?.({ proof: liveProof, inventory: captured.inventory });
  const sourceBefore = captured.inventory;
  await assertInventoryUnchanged(liveProof.sourceBrainDir, sourceBefore);
  const clonePath = await fsp.mkdtemp(path.join(temporary.path, 'brain-save-clone-'));
  const clone = await canonicalDirectory(clonePath, 'generated clone');
  let cloneProof = null;
  let boundedForceFull = null;
  let cleanupError = null;
  let operationError = null;
  try {
    const copiedFiles = await copyPinnedSelection(liveProof.sourceBrainDir, clone.path, sourceBefore);
    await assertDirectoryIdentity(clone, 'generated clone');
    await assertInventoryUnchanged(liveProof.sourceBrainDir, sourceBefore);
    const canaryId = `__home23_persistence_clone_${crypto.randomUUID()}`;
    const canary = {
      id: canaryId,
      concept: 'clone-only persistence acceptance canary',
      cluster: `__home23_acceptance_${crypto.randomUUID()}`,
      metadata: { acceptanceOnly: true },
    };
    const persisted = await persister({
      brainDir: clone.path,
      memory: deltaCanaryFacade({ canary, baseline: liveProof.streamed }),
      forceFull: false,
      fullRewriteIntervalMs: Number.MAX_SAFE_INTEGER,
      home23Root: temporary.path,
      schedule: () => { throw typedError('unexpected_retirement_schedule'); },
    });
    if (!['legacy-delta', 'delta'].includes(persisted.mode)) {
      throw typedError('clone_delta_mode_invalid', persisted.mode);
    }
    const readback = await streamLogicalSource({
      brainDir: clone.path,
      scratchRoot: temporary.path,
      requesterAgent: 'persistence-clone',
      operationLabel: 'clone-readback',
      canaryId,
      maxHeapUsedMiB,
      maxRssMiB,
    });
    if (readback.proof.nodes !== liveProof.streamed.nodes + 1
        || readback.proof.edges !== liveProof.streamed.edges
        || readback.proof.canaryMatches !== 1) {
      throw typedError('clone_delta_readback_mismatch');
    }
    cloneProof = {
      copyPolicy: 'exact-full-physical-files',
      copiedFiles,
      persistedMode: persisted.mode,
      persistedRevision: persisted.manifest?.currentRevision ?? null,
      loaded: {
        nodes: readback.proof.nodes,
        edges: readback.proof.edges,
        revision: readback.proof.revision,
      },
      canaryId,
      canaryMatches: readback.proof.canaryMatches,
      nodeLogicalSha256: readback.proof.nodeLogicalSha256,
      edgeLogicalSha256: readback.proof.edgeLogicalSha256,
      resources: readback.proof.resources,
      fullMaterializerUsed: false,
    };
    boundedForceFull = await proveBoundedForceFull({
      tempRoot: temporary.path,
      representative: captured.representative,
      persister,
      loader: boundedLoader,
    });
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await assertDirectoryIdentity(clone, 'generated clone');
      if (removeClone) await removeClone(clone, temporary.path);
      else await guardedRemoveOwnedDirectory(clone, temporary.path, 'brain-save-clone-');
    } catch (error) {
      cleanupError = error;
    }
  }
  const sourceAfter = await selectionInventory(liveProof.sourceBrainDir);
  let runtimeCleanupError = null;
  try {
    await pruneGeneratedEmptyRuntime(temporary.path);
  } catch (error) {
    runtimeCleanupError = error;
  }
  if (inventoryComparable(sourceBefore) !== inventoryComparable(sourceAfter)) {
    throw typedError('source_changed_concurrently');
  }
  if (cleanupError) throw cleanupError;
  if (runtimeCleanupError) throw runtimeCleanupError;
  if (operationError) throw operationError;
  if ((await fsp.readdir(temporary.path)).length !== 0) throw typedError('temp_root_not_empty_after');
  return {
    ...liveProof,
    mode: 'temp-save-clone-safe',
    writeBrainDir: clone.path,
    clone: cloneProof,
    boundedForceFull,
    liveForceFull: {
      attempted: false,
      reason: 'full-live-forceFull-would-duplicate-the-resident-graph-and-is-prohibited',
    },
    cloneRemoved: true,
    before: sourceBefore.records,
    after: sourceAfter.records,
    unchanged: true,
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const { values } = parseCli(argv);
  const context = await receiptContext(values, env);
  const mode = one(values, 'mode', { required: true });
  const options = {
    home23Root: path.resolve(one(values, 'home23-root', { required: true })),
    agent: one(values, 'agent', { required: true }),
    brainDir: path.resolve(one(values, 'brain', { required: true })),
    tempRoot: path.resolve(one(values, 'temp-root', { required: true })),
    maxHeapUsedMiB: positiveLimit(one(values, 'max-heap-used-mib'), DEFAULT_MAX_HEAP_USED_MIB, 'max-heap-used-mib'),
    maxRssMiB: positiveLimit(one(values, 'max-rss-mib'), DEFAULT_MAX_RSS_MIB, 'max-rss-mib'),
  };
  const result = mode === 'read-only'
    ? await verifyReadOnlyPersistence(options)
    : mode === 'temp-save-clone'
      ? await verifyTempSaveClone(options)
      : (() => { throw typedError('mode_invalid'); })();
  return writeJsonReceipt(context, path.resolve(one(values, 'output', { required: true })), {
    helper: 'verify-brain-persistence',
    ...result,
  });
}

if (isMain(import.meta.url)) main().catch(failCli);
