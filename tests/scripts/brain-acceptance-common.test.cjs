const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const AUTHORITY_COMMIT = 'b'.repeat(40);
const AUTHORITY_TREE = 'c'.repeat(40);

async function writeRunAuthority(run, overrides = {}) {
  const authority = {
    schemaVersion: 1,
    receiptRunId: 'run-1',
    authority: 'live',
    implementationCommit: AUTHORITY_COMMIT,
    expectedLiveTree: AUTHORITY_TREE,
    actualLiveTree: AUTHORITY_TREE,
    hostname: 'fixture-host',
    startedAt: '2026-07-10T00:00:00.000Z',
    ...overrides,
  };
  await fs.writeFile(
    path.join(run, 'run-authority.json'),
    `${JSON.stringify(authority, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return authority;
}

test('receipt authority requires matching explicit identity and a canonical nonsymlink run directory', async (t) => {
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-common-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const link = path.join(root, 'run-link');
  await fs.mkdir(run, { mode: 0o700 });
  await fs.symlink(run, link);
  await assert.rejects(receiptContext({
    'receipt-run-dir': run, 'receipt-run-id': 'run-1', authority: 'live',
  }, { HOME23_RECEIPT_AUTHORITY: 'isolated-controlled' }),
  (error) => error.code === 'receipt_authority_conflict');
  await assert.rejects(receiptContext({
    'receipt-run-dir': link, 'receipt-run-id': 'run-1', authority: 'live',
  }, {}), (error) => error.code === 'path_invalid');
  await writeRunAuthority(run);
  const context = await receiptContext({
    'receipt-run-dir': run, 'receipt-run-id': 'run-1', authority: 'live',
  }, {}, { cwd: root, startedAt: '2026-07-10T00:00:00.000Z' });
  assert.equal(context.receiptRunDir, run);
  assert.equal(context.authority, 'live');
  assert.equal(context.implementationCommit, AUTHORITY_COMMIT);
});

test('run-authority.json is the sole bounded implementation authority for live and isolated receipts', async (t) => {
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-authority-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  async function contextFor(run, authority = 'live', env = {}) {
    return receiptContext({
      'receipt-run-dir': run,
      'receipt-run-id': 'run-1',
      authority,
    }, env, { cwd: root });
  }

  const missing = path.join(root, 'missing');
  await fs.mkdir(missing, { mode: 0o700 });
  await assert.rejects(contextFor(missing),
    (error) => error.code === 'receipt_run_authority_invalid');

  const valid = path.join(root, 'valid');
  await fs.mkdir(valid, { mode: 0o700 });
  await writeRunAuthority(valid);
  assert.equal((await contextFor(valid)).implementationCommit, AUTHORITY_COMMIT);
  assert.equal((await contextFor(valid, 'isolated-controlled')).implementationCommit, AUTHORITY_COMMIT);
  assert.equal((await contextFor(valid, 'live', {
    IMPLEMENTATION_PUSH_COMMIT: AUTHORITY_COMMIT,
  })).implementationCommit, AUTHORITY_COMMIT);
  await assert.rejects(
    contextFor(valid, 'live', { IMPLEMENTATION_PUSH_COMMIT: 'd'.repeat(40) }),
    (error) => error.code === 'receipt_implementation_commit_mismatch',
  );
  await assert.rejects(receiptContext({
    'receipt-run-dir': valid,
    'receipt-run-id': 'run-1',
    authority: 'live',
    'implementation-commit': 'd'.repeat(40),
  }, { IMPLEMENTATION_PUSH_COMMIT: AUTHORITY_COMMIT }),
  (error) => error.code === 'receipt_implementation_commit_mismatch');
  await assert.rejects(contextFor(valid, 'live', {
    HOME23_RECEIPT_IMPLEMENTATION_COMMIT: AUTHORITY_COMMIT,
    IMPLEMENTATION_PUSH_COMMIT: 'd'.repeat(40),
  }), (error) => error.code === 'receipt_implementation_commit_mismatch');

  for (const [name, overrides] of [
    ['run-id-mismatch', { receiptRunId: 'another-run' }],
    ['authority-mismatch', { authority: 'isolated-controlled' }],
    ['tree-mismatch', { actualLiveTree: 'd'.repeat(40) }],
    ['commit-invalid', { implementationCommit: 'not-a-commit' }],
  ]) {
    const run = path.join(root, name);
    await fs.mkdir(run, { mode: 0o700 });
    await writeRunAuthority(run, overrides);
    await assert.rejects(contextFor(run),
      (error) => error.code === 'receipt_run_authority_invalid', name);
  }

  const linked = path.join(root, 'linked');
  await fs.mkdir(linked, { mode: 0o700 });
  const outside = path.join(root, 'outside-authority.json');
  await fs.writeFile(outside, '{}\n');
  await fs.symlink(outside, path.join(linked, 'run-authority.json'));
  await assert.rejects(contextFor(linked),
    (error) => error.code === 'receipt_run_authority_invalid');

  const hardlinked = path.join(root, 'hardlinked');
  const hardlinkSource = path.join(root, 'hardlink-source');
  await fs.mkdir(hardlinked, { mode: 0o700 });
  await fs.mkdir(hardlinkSource, { mode: 0o700 });
  await writeRunAuthority(hardlinkSource);
  await fs.link(
    path.join(hardlinkSource, 'run-authority.json'),
    path.join(hardlinked, 'run-authority.json'),
  );
  await assert.rejects(contextFor(hardlinked),
    (error) => error.code === 'receipt_run_authority_invalid');

  const writable = path.join(root, 'writable');
  await fs.mkdir(writable, { mode: 0o700 });
  await writeRunAuthority(writable);
  await fs.chmod(path.join(writable, 'run-authority.json'), 0o644);
  await assert.rejects(contextFor(writable),
    (error) => error.code === 'receipt_run_authority_invalid');

  const oversized = path.join(root, 'oversized');
  await fs.mkdir(oversized, { mode: 0o700 });
  await fs.writeFile(path.join(oversized, 'run-authority.json'), 'x'.repeat(65 * 1024));
  await assert.rejects(contextFor(oversized),
    (error) => error.code === 'receipt_run_authority_invalid');
});

test('JSON and JSONL rows stay beneath the run directory and carry verifiable artifact identity', async (t) => {
  const {
    appendJsonlReceipt,
    canonicalReceiptRow,
    receiptContext,
    sha256Bytes,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-common-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeRunAuthority(root, {
    receiptRunId: 'run-2',
    implementationCommit: 'c'.repeat(40),
  });
  const context = await receiptContext({
    'receipt-run-dir': root,
    'receipt-run-id': 'run-2',
    authority: 'isolated-controlled',
  }, {}, { startedAt: '2026-07-10T00:00:00.000Z' });
  const row = canonicalReceiptRow(context, { helper: 'fixture', artifactSha256: 'untrusted' }, '2026-07-10T00:01:00.000Z');
  const { artifactSha256, ...core } = row;
  assert.equal(artifactSha256, sha256Bytes(Buffer.from(JSON.stringify(core))));
  assert.equal(core.artifactSha256, undefined);
  const json = path.join(root, 'nested', 'one.json');
  const jsonl = path.join(root, 'nested', 'many.jsonl');
  await writeJsonReceipt(context, json, { helper: 'json' });
  await appendJsonlReceipt(context, jsonl, { helper: 'jsonl', sequence: 1 });
  await appendJsonlReceipt(context, jsonl, { helper: 'jsonl', sequence: 2 });
  assert.equal((await fs.stat(json)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(jsonl)).mode & 0o777, 0o600);
  await assert.rejects(writeJsonReceipt(context, path.join(root, '..', 'escape.json'), {
    helper: 'escape',
  }), (error) => error.code === 'output_path_invalid');
});

test('canonical receipt sealing preserves ordered operation timing separately from run timing', async (t) => {
  const {
    canonicalReceiptRow,
    receiptContext,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-timing-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeRunAuthority(root, { startedAt: '2026-07-10T00:00:00.000Z' });
  const context = await receiptContext({
    'receipt-run-dir': root,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});
  const operationStartedAt = '2026-07-10T00:05:00.000Z';
  const operationCompletedAt = '2026-07-10T00:06:00.000Z';
  const row = canonicalReceiptRow(context, {
    helper: 'operation-terminal',
    startedAt: operationStartedAt,
    completedAt: operationCompletedAt,
    receiptRunStartedAt: 'forged',
  });
  assert.equal(row.receiptRunStartedAt, context.startedAt);
  assert.equal(row.startedAt, operationStartedAt);
  assert.equal(row.completedAt, operationCompletedAt);
  assert.throws(
    () => canonicalReceiptRow(context, {
      helper: 'operation-terminal',
      startedAt: operationCompletedAt,
      completedAt: operationStartedAt,
    }),
    (error) => error.code === 'receipt_timestamp_invalid',
  );
});

test('JSONL ownership rejects modified prior bytes and unowned extra appends', async (t) => {
  const {
    appendJsonlReceipt,
    receiptContext,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-jsonl-authority-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeRunAuthority(root);
  const context = await receiptContext({
    'receipt-run-dir': root,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});

  const modified = path.join(root, 'modified.jsonl');
  await appendJsonlReceipt(context, modified, { helper: 'fixture', sequence: 1 });
  const modifiedBytes = await fs.readFile(modified);
  const marker = Buffer.from('"sequence":1');
  const markerOffset = modifiedBytes.indexOf(marker);
  assert.ok(markerOffset >= 0);
  const handle = await fs.open(modified, 'r+');
  try {
    await handle.write(Buffer.from('"sequence":9'), 0, marker.length, markerOffset);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await assert.rejects(
    appendJsonlReceipt(context, modified, { helper: 'fixture', sequence: 2 }),
    (error) => error.code === 'receipt_output_changed',
  );

  const extended = path.join(root, 'extended.jsonl');
  await appendJsonlReceipt(context, extended, { helper: 'fixture', sequence: 1 });
  await fs.appendFile(extended, '{"external":true}\n');
  await assert.rejects(
    appendJsonlReceipt(context, extended, { helper: 'fixture', sequence: 2 }),
    (error) => error.code === 'receipt_output_changed',
  );
});

test('receipt outputs are create-new and never overwrite or adopt a pre-existing path', async (t) => {
  const {
    appendJsonlReceipt,
    receiptContext,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-create-new-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeRunAuthority(root, {
    receiptRunId: 'run-create-new',
    implementationCommit: 'd'.repeat(40),
  });
  const context = await receiptContext({
    'receipt-run-dir': root,
    'receipt-run-id': 'run-create-new',
    authority: 'live',
  }, {}, { startedAt: '2026-07-10T00:00:00.000Z' });
  const json = path.join(root, 'already.json');
  const jsonl = path.join(root, 'already.jsonl');
  await fs.writeFile(json, 'operator bytes\n');
  await fs.writeFile(jsonl, 'operator rows\n');
  await assert.rejects(
    writeJsonReceipt(context, json, { helper: 'must-not-overwrite' }),
    (error) => error.code === 'receipt_output_exists',
  );
  await assert.rejects(
    appendJsonlReceipt(context, jsonl, { helper: 'must-not-adopt' }),
    (error) => error.code === 'receipt_output_exists',
  );
  assert.equal(await fs.readFile(json, 'utf8'), 'operator bytes\n');
  assert.equal(await fs.readFile(jsonl, 'utf8'), 'operator rows\n');
});

test('npm pretest cannot silently omit the isolated authority and lifecycle regressions', () => {
  const scripts = require('../../package.json').scripts;
  const aggregateName = 'test:brain-acceptance-runtime';
  assert.equal(scripts.pretest.split(`npm run ${aggregateName}`).length - 1, 1);
  const aggregate = scripts[aggregateName];
  assert.equal(typeof aggregate, 'string');
  for (const file of [
    'tests/scripts/live-brain-tools-authority.test.cjs',
    'tests/scripts/isolated-brain-fixture.test.cjs',
    'tests/scripts/isolated-brain-cli.test.cjs',
  ]) {
    assert.equal(aggregate.split(file).length - 1, 1, `${file} registration count`);
  }
});

test('bounded readers reject oversized and symlinked JSON before parsing', async (t) => {
  const {
    readBoundedFile,
    readJson,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-bounded-read-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const document = path.join(root, 'document.json');
  const link = path.join(root, 'document-link.json');
  await fs.writeFile(document, JSON.stringify({ value: 'bounded' }));
  await fs.symlink(document, link);

  assert.deepEqual(await readJson(document, { maxBytes: 1024 }), { value: 'bounded' });
  assert.equal((await readBoundedFile(document, { maxBytes: 1024, encoding: 'utf8' })),
    JSON.stringify({ value: 'bounded' }));
  await assert.rejects(
    readJson(document, { maxBytes: 4 }),
    (error) => error.code === 'json_file_invalid',
  );
  await assert.rejects(
    readJson(link, { maxBytes: 1024 }),
    (error) => error.code === 'json_file_invalid',
  );
  await fs.chmod(document, 0o600);
  assert.equal(await readBoundedFile(document, {
    maxBytes: 1024,
    encoding: 'utf8',
    requiredMode: 0o600,
    requiredUid: typeof process.getuid === 'function' ? process.getuid() : null,
  }), JSON.stringify({ value: 'bounded' }));
  await fs.chmod(document, 0o644);
  await assert.rejects(readBoundedFile(document, {
    maxBytes: 1024,
    requiredMode: 0o600,
    errorCode: 'bounded_security_test',
  }), (error) => error.code === 'bounded_security_test');
  if (typeof process.getuid === 'function') {
    await assert.rejects(readBoundedFile(document, {
      maxBytes: 1024,
      requiredUid: process.getuid() + 1,
      errorCode: 'bounded_owner_test',
    }), (error) => error.code === 'bounded_owner_test');
  }

  const raceTarget = path.join(root, 'race-target.json');
  const raceReplacement = path.join(root, 'race-replacement.json');
  const raceDisplaced = path.join(root, 'race-displaced.json');
  await fs.writeFile(raceTarget, '{"authority":"original"}', { mode: 0o600 });
  await fs.writeFile(raceReplacement, '{"authority":"replacement"}', { mode: 0o600 });
  await assert.rejects(readBoundedFile(raceTarget, {
    maxBytes: 1024,
    encoding: 'utf8',
    errorCode: 'bounded_named_identity_test',
    requireSingleLink: true,
    requiredMode: 0o600,
    requiredUid: typeof process.getuid === 'function' ? process.getuid() : null,
    beforeFinalIdentityCheck: async () => {
      await fs.rename(raceTarget, raceDisplaced);
      await fs.rename(raceReplacement, raceTarget);
    },
  }), (error) => error.code === 'bounded_named_identity_test');
  assert.equal(await fs.readFile(raceTarget, 'utf8'), '{"authority":"replacement"}');
});

test('captured canonical directory identity rejects a same-path replacement', async (t) => {
  const {
    assertCanonicalDirectoryIdentity,
    canonicalDirectory,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  assert.equal(typeof assertCanonicalDirectoryIdentity, 'function');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-directory-identity-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'run');
  const displaced = path.join(root, 'run-displaced');
  await fs.mkdir(directory, { mode: 0o700 });
  const captured = await canonicalDirectory(directory, 'fixture run directory');
  await fs.rename(directory, displaced);
  await fs.mkdir(directory, { mode: 0o700 });
  await assert.rejects(
    assertCanonicalDirectoryIdentity(captured, 'fixture run directory'),
    (error) => error.code === 'path_changed',
  );
});

test('receipt writes reject a same-path replacement of their validated run directory', async (t) => {
  const {
    receiptContext,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-context-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const displaced = path.join(root, 'run-displaced');
  await fs.mkdir(run, { mode: 0o700 });
  await writeRunAuthority(run);
  const context = await receiptContext({
    'receipt-run-dir': run,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});

  await fs.rename(run, displaced);
  await fs.mkdir(run, { mode: 0o700 });
  await writeRunAuthority(run);
  await assert.rejects(
    writeJsonReceipt(context, path.join(run, 'must-not-cross-directory-identity.json'), {
      helper: 'directory-identity-regression',
    }),
    (error) => error.code === 'path_changed',
  );
  await assert.rejects(
    fs.access(path.join(run, 'must-not-cross-directory-identity.json')),
    (error) => error.code === 'ENOENT',
  );
});

test('receipt writers reject handcrafted contexts that were never bound to run authority', async (t) => {
  const { writeJsonReceipt } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-unbound-context-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(
    writeJsonReceipt({
      receiptRunDir: root,
      receiptRunId: 'unbound-run',
      authority: 'live',
      implementationCommit: 'a'.repeat(40),
      hostname: 'fixture-host',
      startedAt: '2026-07-10T00:00:00.000Z',
    }, path.join(root, 'must-not-use-unbound-context.json'), {
      helper: 'unbound-context-regression',
    }),
    (error) => error.code === 'receipt_context_invalid',
  );
});

test('receipt authority binds hostname and startedAt exactly and rejects forged spread contexts', async (t) => {
  const {
    receiptContext,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-bound-authority-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeRunAuthority(root, {
    hostname: 'authority-host.example',
    startedAt: '2026-07-10T12:34:56.000Z',
  });
  const context = await receiptContext({
    'receipt-run-dir': root,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});
  assert.equal(context.hostname, 'authority-host.example');
  assert.equal(context.startedAt, '2026-07-10T12:34:56.000Z');

  const forged = {
    ...context,
    receiptRunId: 'forged-run',
    authority: 'isolated-controlled',
    implementationCommit: 'd'.repeat(40),
    hostname: 'forged-host.example',
    startedAt: '2026-07-11T00:00:00.000Z',
  };
  await assert.rejects(
    writeJsonReceipt(forged, path.join(root, 'forged.json'), { helper: 'forged' }),
    (error) => error.code === 'receipt_context_invalid',
  );
  await assert.rejects(fs.access(path.join(root, 'forged.json')), (error) => error.code === 'ENOENT');
});

test('receipt authority requires exact Git OID lengths and canonical ISO timestamps', async (t) => {
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-authority-shape-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, overrides] of [
    ['oid-41', { implementationCommit: 'a'.repeat(41) }],
    ['noncanonical-time', { startedAt: '2026-07-10T12:34:56Z' }],
  ]) {
    const run = path.join(root, name);
    await fs.mkdir(run, { mode: 0o700 });
    await writeRunAuthority(run, overrides);
    await assert.rejects(receiptContext({
      'receipt-run-dir': run,
      'receipt-run-id': 'run-1',
      authority: 'live',
    }, {}), (error) => error.code === 'receipt_run_authority_invalid');
  }
});

test('receipt writes revalidate the exact named run-authority inode and bytes', async (t) => {
  const {
    receiptContext,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-authority-turnover-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writeRunAuthority(root);
  const context = await receiptContext({
    'receipt-run-dir': root,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});
  const authorityPath = path.join(root, 'run-authority.json');
  const displaced = path.join(root, 'run-authority.displaced.json');
  const bytes = await fs.readFile(authorityPath);
  await fs.rename(authorityPath, displaced);
  await fs.writeFile(authorityPath, bytes, { mode: 0o600, flag: 'wx' });
  await assert.rejects(
    writeJsonReceipt(context, path.join(root, 'must-not-write.json'), { helper: 'turnover' }),
    (error) => error.code === 'receipt_run_authority_changed',
  );
  await assert.rejects(fs.access(path.join(root, 'must-not-write.json')), (error) => error.code === 'ENOENT');
});

test('receipt output ancestry refuses symlinks without creating anything outside the run root', async (t) => {
  const {
    receiptContext,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const top = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-output-ancestry-')));
  t.after(() => fs.rm(top, { recursive: true, force: true }));
  const run = path.join(top, 'run');
  const outside = path.join(top, 'outside');
  await fs.mkdir(run, { mode: 0o700 });
  await fs.mkdir(outside, { mode: 0o700 });
  await writeRunAuthority(run);
  const context = await receiptContext({
    'receipt-run-dir': run,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});

  await fs.symlink(outside, path.join(run, 'outside-link'));
  await assert.rejects(
    writeJsonReceipt(context, path.join(run, 'outside-link', 'created', 'receipt.json'), {
      helper: 'outside-link',
    }),
    (error) => error.code === 'output_path_invalid',
  );
  await assert.rejects(fs.access(path.join(outside, 'created')), (error) => error.code === 'ENOENT');

  const inside = path.join(run, 'inside');
  await fs.mkdir(inside, { mode: 0o700 });
  await fs.symlink(inside, path.join(run, 'inside-link'));
  await assert.rejects(
    writeJsonReceipt(context, path.join(run, 'inside-link', 'receipt.json'), {
      helper: 'inside-link',
    }),
    (error) => error.code === 'output_path_invalid',
  );
  await assert.rejects(fs.access(path.join(inside, 'receipt.json')), (error) => error.code === 'ENOENT');
});

test('receipt run and pre-existing output ancestry require exact operator-owned mode 0700', async (t) => {
  const {
    receiptContext,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const top = await fs.realpath(await fs.mkdtemp(path.join(
    os.tmpdir(),
    'home23-secure-output-ancestry-',
  )));
  t.after(() => fs.rm(top, { recursive: true, force: true }));

  const insecureRun = path.join(top, 'insecure-run');
  await fs.mkdir(insecureRun, { mode: 0o755 });
  await fs.chmod(insecureRun, 0o755);
  await writeRunAuthority(insecureRun);
  await assert.rejects(receiptContext({
    'receipt-run-dir': insecureRun,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {}), (error) => error.code === 'path_permissions_invalid');

  const secureRun = path.join(top, 'secure-run');
  await fs.mkdir(secureRun, { mode: 0o700 });
  await writeRunAuthority(secureRun);
  const context = await receiptContext({
    'receipt-run-dir': secureRun,
    'receipt-run-id': 'run-1',
    authority: 'live',
  }, {});
  const insecureParent = path.join(secureRun, 'pre-existing');
  const output = path.join(insecureParent, 'receipt.json');
  await fs.mkdir(insecureParent, { mode: 0o755 });
  await fs.chmod(insecureParent, 0o755);
  await assert.rejects(
    writeJsonReceipt(context, output, { helper: 'secure-ancestry-regression' }),
    (error) => error.code === 'output_path_invalid',
  );
  await assert.rejects(fs.access(output), (error) => error.code === 'ENOENT');

  await fs.chmod(insecureParent, 0o700);
  const row = await writeJsonReceipt(context, output, { helper: 'secure-ancestry-regression' });
  assert.equal(row.helper, 'secure-ancestry-regression');
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
});
