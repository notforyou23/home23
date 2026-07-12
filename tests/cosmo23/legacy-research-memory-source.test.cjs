const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');

const {
  LEDGER_NAME,
  createOperationScratchQuota,
  openMemorySource,
  projectLegacyResearchSnapshot,
} = require('../../shared/memory-source');
const {
  openCosmoMemorySource,
} = require('../../cosmo23/lib/memory-source-adapter');

async function tempDir(prefix) {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function snapshotText({ conceptBytes = 0 } = {}) {
  return JSON.stringify({
    run: 'legacy',
    decoys: [
      'memory',
      { nodes: [{ id: 'decoy', concept: 'must not cross' }] },
      'braces { quoted } and unicode \\u263a',
    ],
    memory: {
      nodes: [
        {
          id: 'n1',
          concept: `quoted braces { in string } and \\" escapes${'x'.repeat(conceptBytes)}`,
          cluster: 4,
        },
        { id: 'n2', concept: 'nested arrays are fine', metadata: { nested: ['x', { y: 'z' }] } },
      ],
      edges: [
        { source: 'n1', target: 'n2', weight: 1, metadata: { text: 'edge { braces }' } },
      ],
    },
  });
}

async function writeFixture({ gzip = true, conceptBytes = 0, level } = {}) {
  const dir = await tempDir('home23-legacy-snapshot-target-');
  const file = path.join(dir, gzip ? 'state.json.gz' : 'state.json');
  const text = snapshotText({ conceptBytes });
  await fsp.writeFile(file, gzip ? zlib.gzipSync(text, { level }) : text);
  return { dir, file };
}

async function captureOpenError(opening) {
  try {
    const source = await opening;
    await source.close();
    return null;
  } catch (error) {
    return error;
  }
}

async function writeResidentFixture({ conceptBytes = 0, level } = {}) {
  const dir = await tempDir('home23-cosmo-resident-target-');
  const nodes = conceptBytes > 0
    ? `${JSON.stringify({ id: 'resident-canary', concept: 'x'.repeat(conceptBytes) })}\n`
    : '';
  await fsp.writeFile(
    path.join(dir, 'memory-nodes.jsonl.gz'),
    zlib.gzipSync(nodes, { level }),
  );
  await fsp.writeFile(path.join(dir, 'memory-edges.jsonl.gz'), zlib.gzipSync(''));
  await fsp.writeFile(
    path.join(dir, 'memory-delta.jsonl'),
    conceptBytes > 0 ? '' : `${JSON.stringify({
      op: 'upsert_node',
      record: { id: 'resident-canary', concept: 'x'.repeat(1024) },
    })}\n`,
  );
  return dir;
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
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('legacy research decompression cap accepts the exact size and rejects one byte below it', async () => {
  const { dir, file } = await writeFixture({ gzip: true });
  const before = await hashTree(dir);
  const decompressedBytes = Buffer.byteLength(snapshotText(), 'utf8');
  const rejectedRoot = await tempDir('home23-legacy-snapshot-decompressed-reject-');
  const acceptedRoot = await tempDir('home23-legacy-snapshot-decompressed-accept-');
  try {
    await assert.rejects(
      () => projectLegacyResearchSnapshot({
        canonicalRoot: dir,
        stateFile: file,
        operationRoot: rejectedRoot,
        operationId: 'op-legacy',
        requesterAgent: 'jerry',
        maxDecompressedBytes: decompressedBytes - 1,
      }),
      (error) => error.code === 'result_too_large' && error.status === 413
        && error.limitKind === 'decompressed' && error.limit === decompressedBytes - 1,
    );
    const projected = await projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot: acceptedRoot,
      operationId: 'op-legacy-exact-decompressed-cap',
      requesterAgent: 'jerry',
      maxDecompressedBytes: decompressedBytes,
    });
    assert.equal(projected.descriptor.summary.nodeCount, 2);
    assert.equal(await hashTree(dir), before);
  } finally {
    await fsp.rm(rejectedRoot, { recursive: true, force: true });
    await fsp.rm(acceptedRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('legacy research compressed-input cap accepts the exact size and rejects one byte below it', async () => {
  const { dir, file } = await writeFixture({ gzip: true });
  const maxInputBytes = (await fsp.stat(file)).size;
  const rejectedRoot = await tempDir('home23-legacy-snapshot-input-reject-');
  const acceptedRoot = await tempDir('home23-legacy-snapshot-input-accept-');
  try {
    await assert.rejects(() => projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot: rejectedRoot,
      operationId: 'op-legacy-reject-input-cap',
      requesterAgent: 'jerry',
      maxInputBytes: maxInputBytes - 1,
    }), {
      code: 'result_too_large',
      status: 413,
      retryable: false,
      limitKind: 'input',
      limit: maxInputBytes - 1,
    });
    const projected = await projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot: acceptedRoot,
      operationId: 'op-legacy-exact-input-cap',
      requesterAgent: 'jerry',
      maxInputBytes,
    });
    assert.equal(projected.descriptor.summary.nodeCount, 2);
  } finally {
    await fsp.rm(rejectedRoot, { recursive: true, force: true });
    await fsp.rm(acceptedRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('COSMO adapter forwards compressed and decompressed limits to legacy research projection', async (t) => {
  const { dir } = await writeFixture({ gzip: true, conceptBytes: 1024 });
  try {
    for (const scenario of [
      {
        name: 'input',
        options: { maxInputBytes: 64, maxDecompressedBytes: 8 * 1024 },
        limitKind: 'input',
      },
      {
        name: 'decoded',
        options: { maxInputBytes: 8 * 1024, maxDecompressedBytes: 64 },
        limitKind: 'decompressed',
      },
    ]) {
      await t.test(scenario.name, async () => {
        const error = await captureOpenError(openCosmoMemorySource(dir, {
          operationId: `cosmo-adapter-${scenario.name}`,
          requesterAgent: 'jerry',
          ...scenario.options,
        }));
        assert.equal(error?.code, 'result_too_large');
        assert.equal(error?.limitKind, scenario.limitKind);
        assert.equal(error?.limit, 64);
      });
    }
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('COSMO adapter forwards resident overlay spill limits into legacy projection', async () => {
  const dir = await writeResidentFixture();
  try {
    const error = await captureOpenError(openCosmoMemorySource(dir, {
      operationId: 'cosmo-resident-overlay-limit',
      requesterAgent: 'jerry',
      maxInputBytes: 8 * 1024,
      maxDecompressedBytes: 8 * 1024,
      maxOverlayMemoryBytes: 0,
      maxOverlayDiskBytes: 4096,
    }));
    assert.equal(error?.code, 'result_too_large');
    assert.equal(error?.status, 413);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('COSMO adapter reads generated projections with quota bounds, not original source caps', async () => {
  const dir = await writeResidentFixture({
    conceptBytes: 1024 * 1024,
    level: zlib.constants.Z_BEST_COMPRESSION,
  });
  const sourceInputCap = Math.max(
    (await fsp.stat(path.join(dir, 'memory-nodes.jsonl.gz'))).size,
    (await fsp.stat(path.join(dir, 'memory-edges.jsonl.gz'))).size,
  );
  let source = null;
  try {
    source = await openCosmoMemorySource(dir, {
      operationId: 'cosmo-resident-projection-read-cap',
      requesterAgent: 'jerry',
      maxInputBytes: sourceInputCap,
      maxDecompressedBytes: 2 * 1024 * 1024,
    });
    assert.equal(source.manifest.activeBase.nodes.bytes > sourceInputCap, true);
    const nodeIds = [];
    for await (const node of source.iterateNodes()) nodeIds.push(node.id);
    assert.deepEqual(nodeIds, ['resident-canary']);
  } finally {
    await source?.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('COSMO adapter removes an owned temp root when quota construction aborts', async () => {
  const { dir } = await writeFixture({ gzip: true });
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop COSMO quota construction'), {
    name: 'AbortError',
  });
  const originalMkdtemp = fsp.mkdtemp;
  let createdRoot = null;
  fsp.mkdtemp = async (...args) => {
    const root = await originalMkdtemp.apply(fsp, args);
    if (String(args[0]).includes('home23-cosmo-memory-source-')) {
      createdRoot = root;
      controller.abort(reason);
    }
    return root;
  };
  try {
    await assert.rejects(
      () => openCosmoMemorySource(dir, {
        operationId: 'cosmo-owned-quota-abort',
        requesterAgent: 'jerry',
        signal: controller.signal,
      }),
      (error) => error === reason,
    );
    assert.notEqual(createdRoot, null);
    await assert.rejects(() => fsp.lstat(createdRoot), { code: 'ENOENT' });
  } finally {
    fsp.mkdtemp = originalMkdtemp;
    if (createdRoot) await fsp.rm(createdRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('COSMO adapter still removes owned scratch when source close reports failure', async () => {
  const dir = await writeResidentFixture();
  const closeError = Object.assign(new Error('injected source close reporting failure'), {
    code: 'EIO',
  });
  let operationRoot = null;
  let source = null;
  try {
    source = await openCosmoMemorySource(dir, {
      operationId: 'cosmo-close-cleanup',
      requesterAgent: 'jerry',
      _testHooks: {
        async afterSourceClose(input) {
          operationRoot = input.operationRoot;
          throw closeError;
        },
      },
    });
    await assert.rejects(() => source.close(), (error) => error === closeError);
    assert.notEqual(operationRoot, null);
    await assert.rejects(() => fsp.lstat(operationRoot), { code: 'ENOENT' });
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('legacy research defaults compressed and decompressed caps from a lower operation quota', async () => {
  const maxBytes = 16 * 1024;
  for (const [label, level, limitKind] of [
    ['compressed', zlib.constants.Z_NO_COMPRESSION, 'input'],
    ['decompressed', zlib.constants.Z_BEST_SPEED, 'decompressed'],
  ]) {
    const { dir, file } = await writeFixture({
      gzip: true,
      conceptBytes: maxBytes + 1,
      level,
    });
    const operationRoot = await tempDir(`home23-legacy-snapshot-quota-${label}-`);
    const quota = await createOperationScratchQuota({ operationRoot, maxBytes });
    try {
      await assert.rejects(() => projectLegacyResearchSnapshot({
        canonicalRoot: dir,
        stateFile: file,
        operationRoot,
        operationId: `op-legacy-quota-${label}`,
        requesterAgent: 'jerry',
        scratchQuota: quota,
      }), {
        code: 'result_too_large',
        status: 413,
        retryable: false,
        limitKind,
        limit: maxBytes,
      });
    } finally {
      await quota.close();
      await fsp.rm(operationRoot, { recursive: true, force: true });
      await fsp.rm(dir, { recursive: true, force: true });
    }
  }
});

test('legacy research rejects explicit source caps above the central hard maximum', async () => {
  const hardMax = 8 * 1024 * 1024 * 1024;
  const { dir, file } = await writeFixture({ gzip: true });
  for (const limits of [
    { maxInputBytes: hardMax + 1 },
    { maxDecompressedBytes: hardMax + 1 },
  ]) {
    const operationRoot = await tempDir('home23-legacy-snapshot-invalid-limit-');
    await assert.rejects(() => projectLegacyResearchSnapshot({
      canonicalRoot: dir,
      stateFile: file,
      operationRoot,
      operationId: 'op-legacy-invalid-limit',
      requesterAgent: 'jerry',
      ...limits,
    }), { code: 'invalid_request' });
    await fsp.rm(operationRoot, { recursive: true, force: true });
  }
});

test('legacy research rejects a scratch quota bound to a different operation root before writing', async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const quotaRoot = await tempDir('home23-legacy-snapshot-quota-authority-');
  const declaredRoot = await tempDir('home23-legacy-snapshot-declared-authority-');
  const quota = await createOperationScratchQuota({
    operationRoot: quotaRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  t.after(async () => {
    await quota.close();
    await fsp.rm(quotaRoot, { recursive: true, force: true });
    await fsp.rm(declaredRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const quotaBefore = await hashTree(quotaRoot);
  const declaredBefore = await hashTree(declaredRoot);

  await assert.rejects(() => projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot: declaredRoot,
    operationId: 'op-legacy-wrong-quota-root',
    requesterAgent: 'jerry',
    scratchQuota: quota,
  }), { code: 'invalid_request' });

  assert.equal(await hashTree(quotaRoot), quotaBefore);
  assert.equal(await hashTree(declaredRoot), declaredBefore);
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

test('tight research source cap still validates a larger immutable winner output', async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-tight-source-winner-');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  t.after(async () => {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const maxInputBytes = (await fsp.stat(file)).size;
  const maxDecompressedBytes = Buffer.byteLength(snapshotText(), 'utf8');
  const first = await projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-tight-source-winner-first',
    requesterAgent: 'jerry',
    scratchQuota: quota,
    maxInputBytes,
    maxDecompressedBytes,
  });
  const manifestBytes = (await fsp.stat(
    path.join(first.projectionRoot, 'memory-manifest.json'),
  )).size;
  assert.equal(manifestBytes > maxInputBytes, true);

  const second = await projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-tight-source-winner-second',
    requesterAgent: 'jerry',
    scratchQuota: quota,
    maxInputBytes,
    maxDecompressedBytes,
  });
  assert.equal(second.projectionRoot, first.projectionRoot);
});

test('legacy research winner validation rejects an oversized file before hashing it', async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-winner-cap-');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  const originalCreateReadStream = fs.createReadStream;
  t.after(async () => {
    fs.createReadStream = originalCreateReadStream;
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const projected = await projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-winner-cap-first',
    requesterAgent: 'jerry',
    scratchQuota: quota,
  });
  const cappedFile = {
    basename: projected.manifest.activeBase.nodes.file,
    stat: await fsp.stat(
      path.join(projected.projectionRoot, projected.manifest.activeBase.nodes.file),
      { bigint: true },
    ),
  };
  assert.equal(Number(cappedFile.stat.size) > 1, true);
  const validationMaxBytes = Number(cappedFile.stat.size) - 1;
  let cappedFileHashStarted = false;
  fs.createReadStream = function createReadStreamTrap(...args) {
    const fd = args[1]?.fd;
    if (Number.isInteger(fd)) {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev === cappedFile.stat.dev && opened.ino === cappedFile.stat.ino) {
        cappedFileHashStarted = true;
      }
    }
    return originalCreateReadStream.apply(this, args);
  };
  const validationQuota = {
    operationRoot: quota.operationRoot,
    maxBytes: validationMaxBytes,
    assertOperationRoot: (...args) => quota.assertOperationRoot(...args),
    claim: (...args) => quota.claim(...args),
    release: (...args) => quota.release(...args),
    reconcile: (...args) => quota.reconcile(...args),
    withPhysicalGrowth: (...args) => quota.withPhysicalGrowth(...args),
  };

  await assert.rejects(() => projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-winner-cap-second',
    requesterAgent: 'jerry',
    scratchQuota: validationQuota,
    maxInputBytes: 1024 * 1024,
    maxDecompressedBytes: 1024 * 1024,
  }), {
    code: 'result_too_large',
    status: 413,
    retryable: false,
    limitKind: 'input',
    limit: validationMaxBytes,
  });
  assert.equal(cappedFileHashStarted, false);
});

test('abort interrupts in-progress legacy research winner digest validation', {
  timeout: 10_000,
}, async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-winner-abort-');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  const controller = new AbortController();
  const reason = Object.assign(new Error('stop research winner validation'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  const originalCreateReadStream = fs.createReadStream;
  const blockedStreams = [];
  let blockedFd = null;
  let resolveValidationStarted;
  const validationStarted = new Promise((resolve) => { resolveValidationStarted = resolve; });
  let resolveDigestClosed;
  const digestClosed = new Promise((resolve) => { resolveDigestClosed = resolve; });
  let settled;
  t.after(async () => {
    fs.createReadStream = originalCreateReadStream;
    controller.abort(reason);
    for (const stream of blockedStreams) {
      if (!stream.destroyed) stream.push(null);
    }
    if (settled) await settled;
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });

  const projected = await projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-winner-abort-first',
    requesterAgent: 'jerry',
    scratchQuota: quota,
  });
  const digestTarget = path.join(
    projected.projectionRoot,
    projected.manifest.activeBase.nodes.file,
  );
  const digestIdentity = await fsp.stat(digestTarget, { bigint: true });
  fs.createReadStream = function createBlockedDigest(...args) {
    const fd = args[1]?.fd;
    if (Number.isInteger(fd)) {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev === digestIdentity.dev && opened.ino === digestIdentity.ino) {
        blockedFd = fd;
        let sent = false;
        const stream = new Readable({
          read() {
            if (sent) return;
            sent = true;
            this.push(Buffer.from([0]));
            resolveValidationStarted();
            controller.abort(reason);
          },
        });
        stream.once('close', resolveDigestClosed);
        blockedStreams.push(stream);
        return stream;
      }
    }
    return originalCreateReadStream.apply(this, args);
  };

  const operation = projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-winner-abort-second',
    requesterAgent: 'jerry',
    scratchQuota: quota,
    signal: controller.signal,
  });
  settled = operation.then(
    (value) => ({ kind: 'fulfilled', value }),
    (error) => ({ kind: 'rejected', error }),
  );
  const startOutcome = await Promise.race([
    validationStarted.then(() => ({ kind: 'started' })),
    settled,
    new Promise((resolve) => setTimeout(
      () => resolve({ kind: 'start_timeout' }),
      5_000,
    )),
  ]);
  const closeOutcome = startOutcome.kind === 'started'
    ? await Promise.race([
      digestClosed.then(() => ({ kind: 'closed' })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 500)),
    ])
    : startOutcome;

  for (const stream of blockedStreams) {
    if (!stream.destroyed) stream.push(null);
  }
  const finalOutcome = await settled;
  assert.equal(startOutcome.kind, 'started');
  assert.equal(closeOutcome.kind, 'closed', 'winner digest ignored AbortSignal until EOF');
  assert.throws(() => fs.fstatSync(blockedFd), { code: 'EBADF' });
  assert.equal(finalOutcome.kind, 'rejected');
  assert.equal(finalOutcome.error, reason);
});

test('legacy research metadata growth cannot invalidate concurrent zero-growth publication', {
  timeout: 15_000,
}, async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-metadata-race-');
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
  });
  t.after(async () => {
    await quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });
  function gate() {
    let resolve;
    const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
    return { promise, resolve };
  }
  const secondReady = gate();
  const firstPublicationLocked = gate();
  const secondRelevantGrowth = gate();
  let observedSecondGrowth = null;

  function quotaProxy(withPhysicalGrowth) {
    return {
      operationRoot: quota.operationRoot,
      maxBytes: quota.maxBytes,
      assertOperationRoot: (...args) => quota.assertOperationRoot(...args),
      claim: (...args) => quota.claim(...args),
      release: (...args) => quota.release(...args),
      reconcile: (...args) => quota.reconcile(...args),
      withPhysicalGrowth,
    };
  }

  const firstQuota = quotaProxy((maxGrowthBytes, kind, materializer) => {
    if (!kind.startsWith('legacy_research_publication_')) {
      return quota.withPhysicalGrowth(maxGrowthBytes, kind, materializer);
    }
    return quota.withPhysicalGrowth(maxGrowthBytes, kind, async (context) => {
      // The real quota has captured its baseline and owns the operation-root lock.
      firstPublicationLocked.resolve();
      await secondRelevantGrowth.promise;
      return materializer(context);
    });
  });
  const secondQuota = quotaProxy((maxGrowthBytes, kind, materializer) => {
    if (observedSecondGrowth === null
        && (kind.startsWith('legacy_research_metadata_')
          || kind.startsWith('legacy_research_publication_'))) {
      observedSecondGrowth = { maxGrowthBytes, kind };
      // Fixed metadata waits behind A; buggy unprotected metadata has already grown.
      secondRelevantGrowth.resolve();
    }
    return quota.withPhysicalGrowth(maxGrowthBytes, kind, materializer);
  });

  const second = projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-metadata-race-second',
    requesterAgent: 'jerry',
    scratchQuota: secondQuota,
    _testHooks: {
      async beforeSourceRecheck() {
        secondReady.resolve();
        await firstPublicationLocked.promise;
      },
    },
  });
  await secondReady.promise;
  const first = projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-metadata-race-first',
    requesterAgent: 'jerry',
    scratchQuota: firstQuota,
  });

  const outcomes = await Promise.allSettled([first, second]);
  assert.deepEqual(
    outcomes.map(({ status }) => status),
    ['fulfilled', 'fulfilled'],
    outcomes.map((outcome) => outcome.status === 'rejected'
      ? `${outcome.reason?.code}: ${outcome.reason?.message}` : 'fulfilled').join('\n'),
  );
  const [firstResult, secondResult] = outcomes.map(({ value }) => value);
  assert.equal(observedSecondGrowth.kind.startsWith('legacy_research_metadata_'), true);
  assert.equal(
    observedSecondGrowth.maxGrowthBytes,
    Buffer.byteLength(`${JSON.stringify(secondResult.manifest, null, 2)}\n`, 'utf8'),
  );
  assert.equal(firstResult.projectionRoot, secondResult.projectionRoot);
  assert.deepEqual(firstResult.manifest, secondResult.manifest);
  assert.deepEqual(
    await fsp.readdir(path.join(operationRoot, 'source-projections')),
    [path.basename(firstResult.projectionRoot)],
  );
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

test('post-writer abort removes its attempt and reconciles an external scratch quota', async (t) => {
  const { dir, file } = await writeFixture({ gzip: true });
  const operationRoot = await tempDir('home23-legacy-snapshot-quota-cleanup-');
  const controller = new AbortController();
  const quota = await createOperationScratchQuota({
    operationRoot,
    maxBytes: 16 * 1024 * 1024,
    signal: controller.signal,
  });
  await quota.reconcile();
  const baselineUsedBytes = quota.usedBytes;
  const reason = Object.assign(new Error('forced post-writer abort'), {
    name: 'AbortError',
    code: 'cancelled',
  });
  t.after(async () => {
    quota.close();
    await fsp.rm(operationRoot, { recursive: true, force: true });
    await fsp.rm(dir, { recursive: true, force: true });
  });

  await assert.rejects(() => projectLegacyResearchSnapshot({
    canonicalRoot: dir,
    stateFile: file,
    operationRoot,
    operationId: 'op-legacy-quota-cleanup',
    requesterAgent: 'jerry',
    scratchQuota: quota,
    signal: controller.signal,
    _testHooks: {
      async beforeSourceRecheck() { controller.abort(reason); },
    },
  }), (error) => error === reason);

  assert.deepEqual(
    await fsp.readdir(path.join(operationRoot, 'source-projections')),
    [],
  );
  const ledger = JSON.parse(await fsp.readFile(path.join(operationRoot, LEDGER_NAME), 'utf8'));
  assert.equal(ledger.actualPrivateBytes, 0);
  assert.deepEqual(ledger.reservations, {});
  assert.equal(quota.usedBytes, baselineUsedBytes);
});
