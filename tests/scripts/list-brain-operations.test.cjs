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
  await fs.mkdir(receiptRunDir, { mode: 0o700 });
  await fs.writeFile(path.join(receiptRunDir, 'run-authority.json'), `${JSON.stringify({
    schemaVersion: 1,
    receiptRunId: 'list-fixture',
    authority: 'live',
    implementationCommit: 'a'.repeat(40),
    expectedLiveTree: 'b'.repeat(40),
    actualLiveTree: 'b'.repeat(40),
    hostname: 'fixture-host',
    startedAt: '2026-07-10T00:00:00.000Z',
  }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
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
  assert.equal(row.implementationCommit, 'a'.repeat(40));
  assert.equal(row.hostname, 'fixture-host');
  assert.equal(row.startedAt, '2026-07-10T00:00:00.000Z');
  assert.match(row.completedAt, /^\d{4}-/);
  assert.match(row.artifactSha256, /^[a-f0-9]{64}$/);
});

test('lists every requester through the exact nonterminal operator command', async (t) => {
  const { listBrainOperations } = await import('../../scripts/list-brain-operations.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-list-operations-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const operations = [
    { requesterAgent: 'jerry', operationId: 'op-a', state: 'queued' },
    { requesterAgent: 'forrest', operationId: 'op-b', state: 'running' },
  ];
  const result = await listBrainOperations({
    home23Root: root,
    commandRunner: async (...args) => {
      calls.push(args);
      return {
        checkedAt: '2026-07-10T00:00:00.000Z',
        requesters: ['forrest', 'jerry'],
        count: operations.length,
        operations,
      };
    },
  });
  assert.deepEqual(calls, [[root, ['list', '--state', 'nonterminal', '--all-requesters']]]);
  assert.equal(result.count, 2);
  assert.deepEqual(result.operations, operations);
});

test('rejects broad states, terminal rows, and inconsistent store counts', async (t) => {
  const { listBrainOperations } = await import('../../scripts/list-brain-operations.mjs');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'home23-list-operations-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(listBrainOperations({
    home23Root: root, state: 'all', commandRunner: async () => { throw new Error('must not run'); },
  }), (error) => error.code === 'state_invalid');
  for (const result of [
    { checkedAt: 'now', requesters: ['jerry'], count: 1, operations: [{ state: 'complete' }] },
    { checkedAt: 'now', requesters: ['jerry'], count: 2, operations: [{ state: 'running' }] },
  ]) {
    await assert.rejects(listBrainOperations({
      home23Root: root, commandRunner: async () => result,
    }), (error) => error.code === 'brain_operations_store_invalid');
  }
});
