const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  createOperationScratchQuota,
  openMemorySource,
  projectLegacyResearchSnapshot,
} = require('../../shared/memory-source');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function snapshotText() {
  return JSON.stringify({
    run: 'legacy',
    decoys: [
      'memory',
      { nodes: [{ id: 'decoy', concept: 'must not cross' }] },
      'braces { quoted } and unicode \\u263a',
    ],
    memory: {
      nodes: [
        { id: 'n1', concept: 'quoted braces { in string } and \\" escapes', cluster: 4 },
        { id: 'n2', concept: 'nested arrays are fine', metadata: { nested: ['x', { y: 'z' }] } },
      ],
      edges: [
        { source: 'n1', target: 'n2', weight: 1, metadata: { text: 'edge { braces }' } },
      ],
    },
  });
}

async function writeFixture({ gzip = true } = {}) {
  const dir = await tempDir('home23-legacy-snapshot-target-');
  const file = path.join(dir, gzip ? 'state.json.gz' : 'state.json');
  const text = snapshotText();
  await fsp.writeFile(file, gzip ? zlib.gzipSync(text) : text);
  return { dir, file };
}

async function hashTree(root) {
  const entries = [];
  async function walk(dir) {
    for (const name of (await fsp.readdir(dir)).sort()) {
      const full = path.join(dir, name);
      const stat = await fsp.lstat(full);
      const rel = path.relative(root, full);
      if (stat.isDirectory()) {
        entries.push(`dir:${rel}:${stat.mode}`);
        await walk(full);
      } else {
        entries.push(`file:${rel}:${stat.mode}:${stat.size}:${fs.readFileSync(full).toString('base64')}`);
      }
    }
  }
  await walk(root);
  return entries.join('\n');
}

test('projects legacy research snapshot without readFile, gunzip buffer, or full JSON parse', async () => {
  const { dir, file } = await writeFixture({ gzip: true });
  const before = await hashTree(dir);
  const operationRoot = await tempDir('home23-legacy-snapshot-operation-');
  const originalReadFile = fs.promises.readFile;
  const originalGunzip = zlib.gunzip;
  const originalParse = JSON.parse;
  fs.promises.readFile = async (...args) => {
    if (args[0] === file) throw new Error('readFile state trap');
    return originalReadFile.apply(fs.promises, args);
  };
  zlib.gunzip = (...args) => {
    throw new Error('buffer gunzip trap');
  };
  JSON.parse = (text, ...args) => {
    assert.equal(
      typeof text === 'string' && text.includes('"memory"') && text.length > snapshotText().length / 2,
      false,
    );
    return originalParse(text, ...args);
  };
  try {
    const projected = await projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot,
      operationId: 'op-legacy',
      requesterAgent: 'jerry',
    });
    assert.equal(projected.descriptor.version, 1);
    assert.equal(projected.descriptor.canonicalRoot, await fsp.realpath(dir));
    assert.equal(Number.isSafeInteger(projected.descriptor.cutoffRevision), true);
    assert.equal(projected.projectionRoot.startsWith(await fsp.realpath(operationRoot)), true);
    const source = await openMemorySource(projected.projectionRoot);
    const nodes = [];
    const edges = [];
    for await (const node of source.iterateNodes()) nodes.push(node);
    for await (const edge of source.iterateEdges()) edges.push(edge);
    await source.close();
    assert.deepEqual(nodes.map((node) => node.id), ['n1', 'n2']);
    assert.deepEqual(edges.map((edge) => `${edge.source}->${edge.target}`), ['n1->n2']);
    assert.equal(await hashTree(dir), before);
  } finally {
    fs.promises.readFile = originalReadFile;
    zlib.gunzip = originalGunzip;
    JSON.parse = originalParse;
  }
});

test('decompressed byte cap is typed result_too_large and leaves target untouched', async () => {
  const { dir, file } = await writeFixture({ gzip: true });
  const before = await hashTree(dir);
  const operationRoot = await tempDir('home23-legacy-snapshot-operation-');
  await assert.rejects(
    () => projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot,
      operationId: 'op-legacy',
      requesterAgent: 'jerry',
      maxDecompressedBytes: 32,
    }),
    (error) => error.code === 'result_too_large' && error.status === 413,
  );
  assert.equal(await hashTree(dir), before);
});

test('aborting legacy projection preserves AbortError and stops before manifest publication', async () => {
  const { dir, file } = await writeFixture({ gzip: false });
  const operationRoot = await tempDir('home23-legacy-snapshot-operation-');
  const controller = new AbortController();
  controller.abort(Object.assign(new Error('stop'), { name: 'AbortError', code: 'cancelled' }));
  await assert.rejects(
    () => projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot,
      operationId: 'op-legacy',
      requesterAgent: 'jerry',
      signal: controller.signal,
    }),
    (error) => error.name === 'AbortError',
  );
  assert.equal(await fsp.access(path.join(operationRoot, 'source-projections')).then(() => true).catch(() => false), false);
});

test('legacy research projection retries a replaced state pathname from a new no-follow handle', async () => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-inode-operation-');
  let rechecks = 0;
  const projected = await projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-inode-race',
    requesterAgent: 'jerry',
    maxAttempts: 3,
    _testHooks: {
      async beforeSourceRecheck() {
        rechecks += 1;
        if (rechecks === 1) {
          const displaced = `${file}.displaced`;
          await fsp.rename(file, displaced);
          await fsp.copyFile(displaced, file);
        }
      },
    },
  });
  assert.equal(rechecks, 2);
  const current = await fsp.stat(file, { bigint: true });
  assert.equal(projected.sourceFingerprint.ino, String(current.ino));
  assert.deepEqual(projected.descriptor.summary, {
    nodeCount: 2,
    edgeCount: 1,
    clusterCount: 1,
  });
});

test('32 concurrent legacy research projections reuse one immutable no-overwrite winner', async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-race-operation-');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 256 * 1024 * 1024,
  });
  t.after(async () => {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const projected = await Promise.all(Array.from({ length: 32 }, (_, index) =>
    projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot,
      operationId: `op-legacy-race-${index}`,
      requesterAgent: 'jerry',
      scratchQuota: quota,
    })));

  assert.equal(new Set(projected.map((entry) => entry.projectionRoot)).size, 1);
  assert.equal(new Set(projected.map((entry) => JSON.stringify(entry.manifest))).size, 1);
  const projectionsRoot = path.join(operationRoot, 'source-projections');
  assert.deepEqual(await fsp.readdir(projectionsRoot), [
    path.basename(projected[0].projectionRoot),
  ]);
  const source = await openMemorySource(projected[0].projectionRoot);
  try {
    const nodes = [];
    for await (const node of source.iterateNodes()) nodes.push(node.id);
    assert.deepEqual(nodes, ['n1', 'n2']);
  } finally {
    await source.close();
  }
});

test('abort from the final research source-recheck hook publishes no projection', async (t) => {
  const { dir, file } = await writeFixture({ gzip: false });
  const operationRoot = await tempDir('home23-legacy-snapshot-final-abort-');
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop before research publication'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  t.after(() => Promise.all([
    fsp.rm(operationRoot, { recursive: true, force: true }),
    fsp.rm(dir, { recursive: true, force: true }),
  ]));

  await assert.rejects(() => projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-final-abort',
    requesterAgent: 'jerry',
    signal: controller.signal,
    _testHooks: {
      async beforeSourceRecheck() { controller.abort(reason); },
    },
  }), (error) => error === reason);

  assert.deepEqual(
    await fsp.readdir(path.join(operationRoot, 'source-projections')).catch(() => []),
    [],
  );
});
