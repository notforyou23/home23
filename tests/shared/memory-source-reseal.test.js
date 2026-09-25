import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import fs, { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  appendMemoryRevision,
  inspectMemorySeal,
  openMemorySource,
  readManifest,
  resealMemoryManifest,
  rewriteMemoryBase,
} = require('../../shared/memory-source');
const {
  createMemoryDeltaOverlayCache,
} = require('../../engine/src/dashboard/memory-delta-overlay-cache');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** A brain whose manifest seals a chain-backed committed delta, as the writer leaves it. */
async function sealedBrain() {
  const brain = await tempDir('home23-memory-seal-brain-');
  const runtime = await tempDir('home23-memory-seal-runtime-');
  const lockRoot = path.join(runtime, 'brain-source-locks');
  await rewriteMemoryBase(brain, {
    nodes: [{ id: 'base', concept: 'base canary' }],
    edges: [],
    summary: { nodeCount: 1, edgeCount: 0, clusterCount: 1 },
  }, { lockRoot });
  await appendMemoryRevision(brain, {
    nodes: [{ id: 'delta', concept: 'committed delta canary' }],
  }, { lockRoot, summary: { nodeCount: 2, edgeCount: 0, clusterCount: 1 } });
  const manifest = await readManifest(brain);
  assert.equal(typeof manifest.activeDelta.fileIdentity?.ino, 'string');
  assert.equal(typeof manifest.activeDelta.chainDigest, 'string');
  return { brain, runtime, lockRoot, manifest };
}

/** cp -p keeps nanosecond mtime: only dev/ino/ctime differ, like a volume copy. */
async function copyPreservingTimestamps(brain) {
  const copy = path.join(await tempDir('home23-memory-seal-copy-'), 'brain');
  execFileSync('cp', ['-Rp', brain, copy]);
  return copy;
}

/** Node's cpSync truncates mtime to milliseconds, like the product extractor's fresh writes. */
async function copyWithNewTimestamps(brain) {
  const copy = path.join(await tempDir('home23-memory-seal-copy-'), 'brain');
  fs.cpSync(brain, copy, { recursive: true });
  return copy;
}

async function overlayRead(brain) {
  const requester = await tempDir('home23-memory-seal-requester-');
  const manifest = await readManifest(brain);
  return createMemoryDeltaOverlayCache({ cacheRoot: path.join(requester, 'cache') })
    .refresh({ canonicalRoot: brain, manifest });
}

async function concepts(brain) {
  const source = await openMemorySource(brain);
  try {
    const result = [];
    for await (const node of source.iterateNodes()) result.push(node.concept);
    return result.sort();
  } finally {
    await source.close();
  }
}

test('a copied brain fails identity-checked reads until it is resealed', async () => {
  const { brain, manifest } = await sealedBrain();
  const copy = await copyPreservingTimestamps(brain);
  const sealedIdentity = manifest.activeDelta.fileIdentity;
  const copied = fs.statSync(path.join(copy, manifest.activeDelta.file), { bigint: true });
  assert.notEqual(String(copied.ino), sealedIdentity.ino);
  assert.equal(String(copied.mtimeNs), sealedIdentity.mtimeNs, 'cp -p preserves the mtime');

  const before = await inspectMemorySeal(copy);
  assert.equal(before.status, 'stale');
  await assert.rejects(overlayRead(copy), {
    code: 'source_changed',
    message: 'committed delta identity differs from manifest',
  });

  const result = await resealMemoryManifest(copy);
  assert.equal(result.status, 'resealed');
  assert.equal(result.verifiedBy, 'mtime');
  assert.deepEqual(result.manifest.activeDelta.fileIdentity, {
    dev: String(copied.dev),
    ino: String(copied.ino),
    size: String(copied.size),
    mtimeNs: String(copied.mtimeNs),
    ctimeNs: String(copied.ctimeNs),
  });

  const after = await inspectMemorySeal(copy);
  assert.equal(after.status, 'sealed');
  const reread = await readManifest(copy);
  assert.deepEqual({ ...reread, activeDelta: { ...reread.activeDelta, fileIdentity: null } },
    { ...manifest, activeDelta: { ...manifest.activeDelta, fileIdentity: null } },
    'only the identity changes');
  const overlay = await overlayRead(copy);
  assert.equal(overlay.node('delta').concept, 'committed delta canary');
  assert.deepEqual(await concepts(copy), ['base canary', 'committed delta canary']);

  const again = await resealMemoryManifest(copy);
  assert.equal(again.status, 'sealed');
  assert.equal(again.resealed, false);
  assert.equal((await inspectMemorySeal(brain)).status, 'sealed', 'the source brain is untouched');
});

test('a copy with a new mtime is resealed only after the delta chain verifies its content', async () => {
  const { brain, manifest } = await sealedBrain();
  const copy = await copyWithNewTimestamps(brain);
  const copied = fs.statSync(path.join(copy, manifest.activeDelta.file), { bigint: true });
  assert.notEqual(String(copied.mtimeNs), manifest.activeDelta.fileIdentity.mtimeNs);
  assert.equal((await inspectMemorySeal(copy)).status, 'stale');

  const result = await resealMemoryManifest(copy);
  assert.equal(result.status, 'resealed');
  assert.equal(result.verifiedBy, 'chain');
  assert.equal((await inspectMemorySeal(copy)).status, 'sealed');
  assert.equal((await overlayRead(copy)).node('delta').concept, 'committed delta canary');
});

test('a delta whose content changed is not resealed', async () => {
  const { brain, manifest } = await sealedBrain();
  const copy = await copyWithNewTimestamps(brain);
  const deltaPath = path.join(copy, manifest.activeDelta.file);
  const original = await fsp.readFile(deltaPath, 'utf8');
  const tampered = original.replace('committed delta canary', 'committed DELTA canary');
  assert.equal(tampered.length, original.length);
  await fsp.writeFile(deltaPath, tampered);
  const manifestBytes = await fsp.readFile(path.join(copy, 'memory-manifest.json'));

  await assert.rejects(resealMemoryManifest(copy), (error) => {
    assert.equal(error.code, 'memory_seal_content_changed');
    assert.equal(error.retryable, false);
    assert.match(error.message, /content differs/);
    return true;
  });
  assert.equal((await fsp.readFile(path.join(copy, 'memory-manifest.json'))).equals(manifestBytes), true);
  assert.equal((await inspectMemorySeal(copy)).status, 'stale');
});

test('a delta whose size changed is not resealed', async () => {
  const { brain, manifest } = await sealedBrain();
  const copy = await copyPreservingTimestamps(brain);
  await fsp.appendFile(path.join(copy, manifest.activeDelta.file), '{"uncommitted":true}\n');
  assert.equal((await inspectMemorySeal(copy)).status, 'changed');
  await assert.rejects(resealMemoryManifest(copy), {
    code: 'memory_seal_content_changed',
    message: /bytes; the manifest sealed/,
  });
});

test('a dev-only difference is a remount, not a stale seal', async () => {
  const { brain, manifest } = await sealedBrain();
  const remounted = {
    ...manifest,
    activeDelta: {
      ...manifest.activeDelta,
      fileIdentity: {
        ...manifest.activeDelta.fileIdentity,
        dev: String(BigInt(manifest.activeDelta.fileIdentity.dev) + 1n),
      },
    },
  };
  await fsp.writeFile(path.join(brain, 'memory-manifest.json'), `${JSON.stringify(remounted, null, 2)}\n`);
  assert.equal((await inspectMemorySeal(brain)).status, 'sealed');
  assert.equal((await resealMemoryManifest(brain)).resealed, false);
});

test('brains without a manifest or without a sealed identity have nothing to reseal', async () => {
  const empty = await tempDir('home23-memory-seal-empty-');
  assert.equal((await inspectMemorySeal(empty)).status, 'absent');
  assert.equal((await resealMemoryManifest(empty)).resealed, false);

  const { brain, manifest } = await sealedBrain();
  const { fileIdentity, ...activeDelta } = manifest.activeDelta;
  await fsp.writeFile(path.join(brain, 'memory-manifest.json'),
    `${JSON.stringify({ ...manifest, activeDelta }, null, 2)}\n`);
  assert.equal((await inspectMemorySeal(brain)).status, 'unsealed');
  assert.equal((await resealMemoryManifest(brain)).resealed, false);
});
