'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const {
  normalizeRevision,
  memorySourceError,
} = require('./contracts.cjs');
const {
  openConfinedRegularFile,
  assertStableOpenedFile,
} = require('./confined-file.cjs');

const MANIFEST_FILE = 'memory-manifest.json';
const MAX_MANIFEST_BYTES = 1024 * 1024;

function manifestPath(brainDir) {
  return path.join(brainDir, MANIFEST_FILE);
}

function assertExactKeys(value, keys, label) {
  const actual = Object.keys(value || {}).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length
      || actual.some((key, index) => key !== expected[index])) {
    throw memorySourceError('invalid_memory_source', `invalid ${label} keys`, {
      retryable: false,
    });
  }
}

function assertSafeNonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw memorySourceError('invalid_memory_source', `invalid ${label}`, { retryable: false });
  }
}

function assertBoundedString(value, label) {
  if (typeof value !== 'string' || value.length < 1 || Buffer.byteLength(value, 'utf8') > 256) {
    throw memorySourceError('invalid_memory_source', `invalid ${label}`, { retryable: false });
  }
}

function assertRelativeBasename(value, label) {
  assertBoundedString(value, label);
  if (path.isAbsolute(value) || value !== path.basename(value) || value === '.' || value === '..') {
    throw memorySourceError('invalid_memory_source', `invalid ${label} path`, { retryable: false });
  }
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw memorySourceError('invalid_memory_source', 'manifest object required', { retryable: false });
  }
  assertExactKeys(manifest, [
    'formatVersion',
    'generation',
    'baseRevision',
    'currentRevision',
    'activeDeltaEpoch',
    'activeBase',
    'activeDelta',
    'ann',
    'summary',
  ], 'manifest');
  if (manifest.formatVersion !== 1) {
    throw memorySourceError('invalid_memory_source', 'unsupported memory manifest', {
      retryable: false,
    });
  }
  assertBoundedString(manifest.generation, 'generation');
  const baseRevision = normalizeRevision(manifest.baseRevision);
  const currentRevision = normalizeRevision(manifest.currentRevision);
  if (baseRevision === null || currentRevision === null || currentRevision < baseRevision) {
    throw memorySourceError('invalid_memory_source', 'invalid memory revision', {
      retryable: false,
    });
  }
  assertBoundedString(manifest.activeDeltaEpoch, 'delta epoch');
  assertExactKeys(manifest.activeBase, ['nodes', 'edges'], 'active base');
  for (const [kind, entry] of Object.entries(manifest.activeBase)) {
    assertExactKeys(entry, ['file', 'count', 'bytes'], `${kind} base`);
    assertRelativeBasename(entry.file, `${kind} base`);
    assertSafeNonnegativeInteger(entry.count, `${kind} count`);
    assertSafeNonnegativeInteger(entry.bytes, `${kind} bytes`);
  }
  assertExactKeys(manifest.activeDelta, [
    'epoch',
    'file',
    'fromRevision',
    'toRevision',
    'count',
    'committedBytes',
  ], 'active delta');
  assertBoundedString(manifest.activeDelta.epoch, 'delta epoch');
  if (manifest.activeDelta.epoch !== manifest.activeDeltaEpoch) {
    throw memorySourceError('invalid_memory_source', 'invalid delta epoch', { retryable: false });
  }
  assertRelativeBasename(manifest.activeDelta.file, 'delta');
  assertSafeNonnegativeInteger(manifest.activeDelta.fromRevision, 'delta from revision');
  assertSafeNonnegativeInteger(manifest.activeDelta.toRevision, 'delta to revision');
  assertSafeNonnegativeInteger(manifest.activeDelta.count, 'delta count');
  assertSafeNonnegativeInteger(manifest.activeDelta.committedBytes, 'delta cutoff');
  if (manifest.activeDelta.fromRevision !== baseRevision + 1
      || manifest.activeDelta.toRevision !== currentRevision
      || manifest.activeDelta.count !== currentRevision - baseRevision) {
    throw memorySourceError('invalid_memory_source', 'invalid delta range', { retryable: false });
  }
  assertExactKeys(manifest.ann, ['indexFile', 'metaFile', 'builtFromRevision'], 'ann');
  for (const field of ['indexFile', 'metaFile']) {
    if (manifest.ann[field] !== null) assertRelativeBasename(manifest.ann[field], `ann ${field}`);
  }
  if (manifest.ann.builtFromRevision !== null) {
    assertSafeNonnegativeInteger(manifest.ann.builtFromRevision, 'ann revision');
  }
  assertExactKeys(manifest.summary, ['nodeCount', 'edgeCount', 'clusterCount'], 'summary');
  for (const field of ['nodeCount', 'edgeCount', 'clusterCount']) {
    assertSafeNonnegativeInteger(manifest.summary[field], field);
  }
  return Object.freeze(JSON.parse(JSON.stringify(manifest)));
}

async function readManifest(brainDir) {
  let opened = null;
  try {
    opened = await openConfinedRegularFile(brainDir, manifestPath(brainDir), {
      flags: fs.constants.O_RDONLY,
      maxBytes: MAX_MANIFEST_BYTES,
      optional: true,
    });
    if (opened === null) return null;
    const text = await opened.handle.readFile('utf8');
    await assertStableOpenedFile(opened);
    return validateManifest(JSON.parse(text));
  } catch (error) {
    if (error?.code) throw error;
    throw memorySourceError('source_unavailable', 'memory manifest unavailable', {
      cause: error,
      retryable: true,
    });
  } finally {
    await opened?.handle.close().catch(() => {});
  }
}

async function optionalConfinedFile(root, filePath) {
  const opened = await openConfinedRegularFile(root, filePath, {
    flags: fs.constants.O_RDONLY,
    optional: true,
  });
  if (opened === null) return false;
  await opened.handle.close();
  return true;
}

async function findLegacyResidentSidecars(brainDir) {
  const files = {
    nodes: path.join(brainDir, 'memory-nodes.jsonl.gz'),
    edges: path.join(brainDir, 'memory-edges.jsonl.gz'),
    delta: path.join(brainDir, 'memory-delta.jsonl'),
  };
  if (await optionalConfinedFile(brainDir, files.nodes)
      && await optionalConfinedFile(brainDir, files.edges)) {
    return files;
  }
  return null;
}

async function resolveMemorySourceSelection(brainDir) {
  const canonicalRoot = await fsp.realpath(brainDir);
  const manifest = await readManifest(canonicalRoot);
  const advisorySnapshot = path.join(canonicalRoot, 'brain-snapshot.json');
  if (manifest) {
    const targetFiles = [
      { role: 'manifest', path: manifestPath(canonicalRoot) },
      { role: 'nodes', path: path.join(canonicalRoot, manifest.activeBase.nodes.file) },
      { role: 'edges', path: path.join(canonicalRoot, manifest.activeBase.edges.file) },
      {
        role: 'delta',
        path: path.join(canonicalRoot, manifest.activeDelta.file),
        committedBytes: manifest.activeDelta.committedBytes,
      },
      { role: 'snapshot-advisory', path: advisorySnapshot, optional: true },
    ];
    if (manifest.ann.indexFile) {
      targetFiles.push({ role: 'ann-index', path: path.join(canonicalRoot, manifest.ann.indexFile) });
    }
    if (manifest.ann.metaFile) {
      targetFiles.push({ role: 'ann-meta', path: path.join(canonicalRoot, manifest.ann.metaFile) });
    }
    return Object.freeze({
      authority: 'manifest-v1',
      canonicalRoot,
      manifest,
      targetFiles: Object.freeze(targetFiles),
    });
  }
  const resident = await findLegacyResidentSidecars(canonicalRoot);
  if (resident) {
    return Object.freeze({
      authority: 'legacy-resident-sidecars',
      canonicalRoot,
      manifest: null,
      targetFiles: Object.freeze([
        { role: 'legacy-nodes', path: resident.nodes },
        { role: 'legacy-edges', path: resident.edges },
        { role: 'legacy-delta', path: resident.delta, optional: true },
        { role: 'snapshot-advisory', path: advisorySnapshot, optional: true },
      ]),
    });
  }
  for (const basename of ['state.json.gz', 'state.json']) {
    const stateFile = path.join(canonicalRoot, basename);
    if (await optionalConfinedFile(canonicalRoot, stateFile)) {
      return Object.freeze({
        authority: 'legacy-research-snapshot',
        canonicalRoot,
        manifest: null,
        targetFiles: Object.freeze([
          { role: 'legacy-state', path: stateFile },
          { role: 'snapshot-advisory', path: advisorySnapshot, optional: true },
        ]),
      });
    }
  }
  return Object.freeze({
    authority: 'unavailable',
    canonicalRoot,
    manifest: null,
    targetFiles: Object.freeze([]),
  });
}

module.exports = {
  MANIFEST_FILE,
  MAX_MANIFEST_BYTES,
  manifestPath,
  validateManifest,
  readManifest,
  findLegacyResidentSidecars,
  resolveMemorySourceSelection,
};
