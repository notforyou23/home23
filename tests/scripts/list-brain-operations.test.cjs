const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-list-operations-')));
  const home23Root = path.join(root, 'home23');
  const receiptRunDir = path.join(root, 'receipts');
  await fs.mkdir(path.join(home23Root, 'instances', 'jerry', 'runtime', 'brain-operations'), {
    recursive: true,
  });
  await fs.mkdir(receiptRunDir);
  return { root, home23Root, receiptRunDir };
}

test('lists exact requester-owned nonterminal stores with production reader', async (t) => {
  const { listBrainOperations } = await import('../../scripts/list-brain-operations.mjs');
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const result = await listBrainOperations({ home23Root: state.home23Root });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'nonterminal');
  assert.deepEqual(result.requesters, ['jerry']);
  assert.equal(result.count, 0);
  assert.deepEqual(result.operations, []);
  await assert.rejects(
    listBrainOperations({ home23Root: state.home23Root, state: 'all' }),
    (error) => error.code === 'state_invalid',
  );
});

test('stdout is a complete canonical receipt even when no output file is requested', async (t) => {
  const state = await fixture();
  t.after(() => fs.rm(state.root, { recursive: true, force: true }));
  const { stdout, stderr } = await run(process.execPath, [
    path.resolve('scripts/list-brain-operations.mjs'),
    '--home23-root', state.home23Root,
    '--receipt-run-dir', state.receiptRunDir,
    '--receipt-run-id', 'list-fixture',
    '--authority', 'isolated-controlled',
  ], { cwd: path.resolve('.'), encoding: 'utf8' });
  assert.equal(stderr, '');
  const row = JSON.parse(stdout);
  assert.equal(row.helper, 'list-brain-operations');
  assert.equal(row.receiptRunId, 'list-fixture');
  assert.equal(row.authority, 'isolated-controlled');
  assert.match(row.implementationCommit, /^(unknown|[a-f0-9]{40,64})$/);
  assert.equal(typeof row.hostname, 'string');
  assert.match(row.startedAt, /^\d{4}-/);
  assert.match(row.completedAt, /^\d{4}-/);
  assert.match(row.artifactSha256, /^[a-f0-9]{64}$/);
});
