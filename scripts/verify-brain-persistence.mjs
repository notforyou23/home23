#!/usr/bin/env node

import { createRequire } from 'node:module';
import { constants as fsConstants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
  resolveMemorySourceSelection,
} = require('../shared/memory-source/index.cjs');
const {
  loadMemoryRevision,
  persistMemoryRevision,
} = require('../engine/src/core/memory-persistence.js');

function safeAgent(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
    throw typedError('agent_invalid');
  }
  return value;
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
  if (!Number.isSafeInteger(nodes) || nodes <= 0 || !Number.isSafeInteger(edges) || edges <= 0) return null;
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

function validateLoaded({ loaded, inventory, snapshot }) {
  const nodes = Array.isArray(loaded?.nodes) ? loaded.nodes.length : Number(loaded?.summary?.nodes);
  const edges = Array.isArray(loaded?.edges) ? loaded.edges.length : Number(loaded?.summary?.edges);
  if (!Number.isSafeInteger(nodes) || nodes <= 0 || !Number.isSafeInteger(edges) || edges <= 0
      || loaded?.summary?.nodes !== nodes || loaded?.summary?.edges !== edges) {
    throw typedError('loaded_counts_invalid');
  }
  const snapshotExpected = snapshotTotals(snapshot);
  if (!snapshotExpected) throw typedError('snapshot_counts_invalid');
  let expected;
  if (inventory.authority === 'manifest-v1') {
    const summary = inventory.manifest?.summary;
    expected = { nodes: summary?.nodeCount, edges: summary?.edgeCount };
    if (!Number.isSafeInteger(expected.nodes) || expected.nodes <= 0
        || !Number.isSafeInteger(expected.edges) || expected.edges <= 0) {
      throw typedError('manifest_counts_invalid');
    }
    if (loaded.revision !== inventory.manifest.currentRevision) throw typedError('revision_mismatch');
    if (snapshotExpected.revision !== null && snapshotExpected.revision !== undefined
        && Number(snapshotExpected.revision) !== inventory.manifest.currentRevision) {
      throw typedError('snapshot_stale');
    }
    if (snapshotExpected.generation && snapshotExpected.generation !== inventory.manifest.generation) {
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
  return {
    loaded: { nodes, edges, revision: loaded.revision ?? null },
    expected,
    snapshot: snapshotExpected,
  };
}

export async function verifyReadOnlyPersistence({
  home23Root,
  agent,
  brainDir,
  loader = loadMemoryRevision,
  afterLoad,
} = {}) {
  const home = await canonicalDirectory(home23Root, 'Home23 root');
  const requesterAgent = safeAgent(agent);
  const expectedBrain = path.join(home.path, 'instances', requesterAgent, 'brain');
  const brain = await canonicalDirectory(brainDir, 'brain');
  if (brain.path !== expectedBrain) throw typedError('brain_target_mismatch');
  const before = await selectionInventory(brain.path);
  const snapshot = (await optionalSnapshot(brain.path)).value;
  const loaded = await loader(brain.path, {
    home23Root: home.path,
    requesterAgent,
    operationId: `acceptance-load-${process.pid}-${Date.now()}`,
  });
  await afterLoad?.({ loaded, before });
  const validated = validateLoaded({ loaded, inventory: before, snapshot });
  const after = await selectionInventory(brain.path);
  if (inventoryComparable(before) !== inventoryComparable(after)) {
    throw typedError('source_changed_concurrently');
  }
  return {
    ok: true,
    mode: 'read-only',
    sourceBrainDir: brain.path,
    writeBrainDir: null,
    selectedAuthority: before.authority,
    sourceRevision: before.manifest?.currentRevision ?? null,
    loaded: validated.loaded,
    expected: validated.expected,
    snapshot: validated.snapshot,
    before: before.records,
    after: after.records,
    unchanged: true,
  };
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

function memoryFacade(loaded) {
  const nodes = new Map(loaded.nodes.map((node) => [String(node.id), node]));
  const edges = new Map(loaded.edges.map((edge, index) => [
    String(edge.key ?? `${edge.source ?? edge.from}->${edge.target ?? edge.to}#${index}`), edge,
  ]));
  const clusterCount = new Set(loaded.nodes.map((node) => node.cluster).filter((value) => value != null)).size;
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

async function copyPinnedSelection(sourceBrainDir, cloneDir, inventory) {
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
      const copyBytes = record.committedBytes === null
        ? Number(before.size) : record.committedBytes;
      if (!Number.isSafeInteger(copyBytes) || copyBytes < 0 || BigInt(copyBytes) > before.size) {
        throw typedError('source_selection_invalid');
      }
      destinationHandle = await fsp.open(destination, 'wx', 0o600);
      const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, copyBytes)));
      let offset = 0;
      while (offset < copyBytes) {
        const { bytesRead } = await sourceHandle.read(
          buffer, 0, Math.min(buffer.length, copyBytes - offset), offset,
        );
        if (bytesRead === 0) throw typedError('source_changed_concurrently');
        await destinationHandle.write(buffer, 0, bytesRead, offset);
        offset += bytesRead;
      }
      await destinationHandle.sync();
      const after = await sourceHandle.stat({ bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
          || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
        throw typedError('source_changed_concurrently');
      }
    } finally {
      await destinationHandle?.close();
      await sourceHandle.close();
    }
  }
}

async function guardedRemoveClone(clone, tempRoot) {
  const current = await fsp.lstat(clone.path, { bigint: true });
  const parent = await fsp.realpath(path.dirname(clone.path));
  if (parent !== tempRoot || !path.basename(clone.path).startsWith('brain-save-clone-')
      || current.dev.toString() !== clone.dev || current.ino.toString() !== clone.ino
      || !current.isDirectory() || current.isSymbolicLink()) {
    throw typedError('clone_cleanup_guard_failed');
  }
  await fsp.rm(clone.path, { recursive: true, force: false });
}

async function pruneGeneratedEmptyRuntime(tempRoot) {
  const candidates = [
    path.join(tempRoot, 'instances', 'persistence-clone', 'runtime', 'brain-operations'),
    path.join(tempRoot, 'instances', 'persistence-clone', 'runtime'),
    path.join(tempRoot, 'instances', 'persistence-clone'),
    path.join(tempRoot, 'instances'),
    path.join(tempRoot, 'runtime', 'brain-source-locks'),
    path.join(tempRoot, 'runtime'),
  ];
  for (const candidate of candidates) {
    if (!isInsideOrEqual(tempRoot, candidate) || candidate === tempRoot) {
      throw typedError('temp_runtime_cleanup_guard_failed');
    }
    try {
      await fsp.rmdir(candidate);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw typedError('temp_runtime_cleanup_guard_failed', candidate, { cause: error });
    }
  }
}

export async function verifyTempSaveClone({
  home23Root,
  agent,
  brainDir,
  tempRoot,
  loader = loadMemoryRevision,
  persister = persistMemoryRevision,
} = {}) {
  const liveProof = await verifyReadOnlyPersistence({ home23Root, agent, brainDir, loader });
  const home = await canonicalDirectory(home23Root, 'Home23 root');
  const temporary = await canonicalDirectory(tempRoot, 'temporary clone root');
  if (isInsideOrEqual(home.path, temporary.path) || isInsideOrEqual(temporary.path, home.path)) {
    throw typedError('temp_root_overlaps_home23');
  }
  if ((await fsp.readdir(temporary.path)).length !== 0) throw typedError('temp_root_not_empty');
  for (const liveBrain of await discoverLiveBrains(home.path)) {
    if (isInsideOrEqual(liveBrain, temporary.path) || isInsideOrEqual(temporary.path, liveBrain)) {
      throw typedError('temp_root_overlaps_live_brain');
    }
  }
  const sourceBefore = await selectionInventory(liveProof.sourceBrainDir);
  const clonePath = await fsp.mkdtemp(path.join(temporary.path, 'brain-save-clone-'));
  const clone = await canonicalDirectory(clonePath, 'generated clone');
  let cloneProof = null;
  let cleanupError = null;
  let operationError = null;
  try {
    await copyPinnedSelection(liveProof.sourceBrainDir, clone.path, sourceBefore);
    const cloneLoaded = await loader(clone.path, {
      home23Root: temporary.path,
      requesterAgent: 'persistence-clone',
      operationId: `clone-load-${process.pid}-${Date.now()}`,
    });
    validateLoaded({
      loaded: cloneLoaded,
      inventory: await selectionInventory(clone.path),
      snapshot: (await optionalSnapshot(clone.path)).value,
    });
    const scheduled = [];
    const persisted = await persister({
      brainDir: clone.path,
      memory: memoryFacade(cloneLoaded),
      forceFull: true,
      home23Root: temporary.path,
      schedule: (callback) => { scheduled.push(callback); },
    });
    const reloaded = await loader(clone.path, {
      home23Root: temporary.path,
      requesterAgent: 'persistence-clone',
      operationId: `clone-reload-${process.pid}-${Date.now()}`,
    });
    if (reloaded.nodes.length !== cloneLoaded.nodes.length || reloaded.edges.length !== cloneLoaded.edges.length) {
      throw typedError('clone_reload_mismatch');
    }
    cloneProof = {
      persistedMode: persisted.mode,
      persistedRevision: persisted.manifest?.currentRevision ?? null,
      loaded: { nodes: reloaded.nodes.length, edges: reloaded.edges.length, revision: reloaded.revision },
      retirementDeferred: scheduled.length,
    };
  } catch (error) {
    operationError = error;
  } finally {
    try {
      await guardedRemoveClone(clone, temporary.path);
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
  return {
    ...liveProof,
    mode: 'temp-save-clone',
    writeBrainDir: clone.path,
    clone: cloneProof,
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
  };
  const result = mode === 'read-only'
    ? await verifyReadOnlyPersistence(options)
    : mode === 'temp-save-clone'
      ? await verifyTempSaveClone({
        ...options,
        tempRoot: path.resolve(one(values, 'temp-root', { required: true })),
      })
      : (() => { throw typedError('mode_invalid'); })();
  return writeJsonReceipt(context, path.resolve(one(values, 'output', { required: true })), {
    helper: 'verify-brain-persistence',
    ...result,
  });
}

if (isMain(import.meta.url)) main().catch(failCli);
