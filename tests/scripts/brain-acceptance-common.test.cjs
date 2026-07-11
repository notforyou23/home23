const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('receipt authority requires matching explicit identity and a canonical nonsymlink run directory', async (t) => {
  const { receiptContext } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-common-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, 'run');
  const link = path.join(root, 'run-link');
  await fs.mkdir(run);
  await fs.symlink(run, link);
  await assert.rejects(receiptContext({
    'receipt-run-dir': run, 'receipt-run-id': 'run-1', authority: 'live',
  }, { HOME23_RECEIPT_AUTHORITY: 'isolated-controlled' }),
  (error) => error.code === 'receipt_authority_conflict');
  await assert.rejects(receiptContext({
    'receipt-run-dir': link, 'receipt-run-id': 'run-1', authority: 'live',
  }, {}), (error) => error.code === 'path_invalid');
  const context = await receiptContext({
    'receipt-run-dir': run, 'receipt-run-id': 'run-1', authority: 'live',
  }, {}, { implementationCommit: 'b'.repeat(40), startedAt: '2026-07-10T00:00:00.000Z' });
  assert.equal(context.receiptRunDir, run);
  assert.equal(context.authority, 'live');
});

test('JSON and JSONL rows stay beneath the run directory and carry verifiable artifact identity', async (t) => {
  const {
    appendJsonlReceipt,
    canonicalReceiptRow,
    sha256Bytes,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-common-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = {
    receiptRunDir: root,
    receiptRunId: 'run-2',
    authority: 'isolated-controlled',
    implementationCommit: 'c'.repeat(40),
    hostname: 'fixture-host',
    startedAt: '2026-07-10T00:00:00.000Z',
  };
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

test('receipt outputs are create-new and never overwrite or adopt a pre-existing path', async (t) => {
  const {
    appendJsonlReceipt,
    writeJsonReceipt,
  } = await import('../../scripts/lib/brain-acceptance-common.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-receipt-create-new-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const context = {
    receiptRunDir: root,
    receiptRunId: 'run-create-new',
    authority: 'live',
    implementationCommit: 'd'.repeat(40),
    hostname: 'fixture-host',
    startedAt: '2026-07-10T00:00:00.000Z',
  };
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
