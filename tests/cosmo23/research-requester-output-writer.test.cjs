'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  createRequesterOutputWriter,
} = require('../../cosmo23/server/lib/research-requester-output-writer');

const OPERATION_ID = 'brop_0123456789abcdef0123456789abcdef';

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

async function makeFixture(t) {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-research-output-'));
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  const workspace = path.join(home23Root, 'instances', 'jerry', 'workspace');
  await fs.mkdir(workspace, { recursive: true });
  return { home23Root, workspace, outputRoot: path.join(workspace, 'research') };
}

test('derives the requester workspace and exposes only a basename-only atomic writer', async (t) => {
  const fixture = await makeFixture(t);
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  });

  assert.deepEqual(Object.keys(writer), ['writeAtomic']);
  const result = await writer.writeAtomic('cosmo-goal-7.md', Buffer.from('exact output\n'));
  assert.deepEqual(result, {
    relativePath: 'research/cosmo-goal-7.md',
    bytes: 13,
  });
  assert.equal(await fs.readFile(path.join(fixture.outputRoot, 'cosmo-goal-7.md'), 'utf8'), 'exact output\n');
  assert.deepEqual((await fs.readdir(fixture.outputRoot)).sort(), ['cosmo-goal-7.md']);
  const mode = (await fs.stat(path.join(fixture.outputRoot, 'cosmo-goal-7.md'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('atomically replaces an existing regular requester output', async (t) => {
  const fixture = await makeFixture(t);
  await fs.mkdir(fixture.outputRoot);
  const destination = path.join(fixture.outputRoot, 'replace.md');
  await fs.writeFile(destination, 'old bytes');
  const before = await fs.lstat(destination);
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  });

  await writer.writeAtomic('replace.md', Buffer.from('new bytes'));
  const after = await fs.lstat(destination);
  assert.equal(await fs.readFile(destination, 'utf8'), 'new bytes');
  assert.notEqual(after.ino, before.ino);
  assert.deepEqual(await fs.readdir(fixture.outputRoot), ['replace.md']);
});

test('rejects caller path syntax and destination symlinks', async (t) => {
  const fixture = await makeFixture(t);
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  });

  for (const fileName of [
    '../escape.md',
    'nested/escape.md',
    'nested\\escape.md',
    '/tmp/escape.md',
    '.',
    '..',
  ]) {
    await assert.rejects(writer.writeAtomic(fileName, Buffer.from('x')), hasCode('invalid_request'));
  }

  const external = path.join(fixture.home23Root, 'external.txt');
  await fs.writeFile(external, 'do not replace');
  await fs.symlink(external, path.join(fixture.outputRoot, 'linked.md'));
  await assert.rejects(
    writer.writeAtomic('linked.md', Buffer.from('replacement')),
    hasCode('output_boundary_invalid'),
  );
  assert.equal(await fs.readFile(external, 'utf8'), 'do not replace');
});

test('rejects a symlink in every derived requester workspace component', async (t) => {
  const fixture = await makeFixture(t);
  const realWorkspace = path.join(fixture.home23Root, 'real-workspace');
  await fs.mkdir(realWorkspace);
  await fs.rm(fixture.workspace, { recursive: true });
  await fs.symlink(realWorkspace, fixture.workspace, 'dir');

  await assert.rejects(createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  }), hasCode('output_boundary_invalid'));
});

test('rejects a post-validation symlink swap without writing outside the requester root', async (t) => {
  const fixture = await makeFixture(t);
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  });
  const priorRoot = `${fixture.outputRoot}.prior`;
  const externalRoot = path.join(fixture.home23Root, 'external-output');
  await fs.mkdir(externalRoot);
  await fs.rename(fixture.outputRoot, priorRoot);
  await fs.symlink(externalRoot, fixture.outputRoot, 'dir');

  await assert.rejects(
    writer.writeAtomic('must-not-exist.md', Buffer.from('blocked')),
    hasCode('output_boundary_changed'),
  );
  await assert.rejects(fs.lstat(path.join(externalRoot, 'must-not-exist.md')), { code: 'ENOENT' });
  await assert.rejects(fs.lstat(path.join(priorRoot, 'must-not-exist.md')), { code: 'ENOENT' });
});

test('rejects a post-validation device/inode replacement even when it is another directory', async (t) => {
  const fixture = await makeFixture(t);
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  });
  const priorRoot = `${fixture.outputRoot}.prior`;
  await fs.rename(fixture.outputRoot, priorRoot);
  await fs.mkdir(fixture.outputRoot);

  await assert.rejects(
    writer.writeAtomic('must-not-exist.md', Buffer.from('blocked')),
    hasCode('output_boundary_changed'),
  );
  await assert.rejects(fs.lstat(path.join(fixture.outputRoot, 'must-not-exist.md')), { code: 'ENOENT' });
});

test('cancellation before publication leaves no output or temporary file', async (t) => {
  const fixture = await makeFixture(t);
  const controller = new AbortController();
  const reason = Object.assign(new Error('cancel output'), { code: 'cancelled' });
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal: controller.signal,
  });
  controller.abort(reason);

  await assert.rejects(
    writer.writeAtomic('cancelled.md', Buffer.from('blocked')),
    (error) => error === reason,
  );
  assert.deepEqual(await fs.readdir(fixture.outputRoot), []);
});

test('cancellation after staging fsync removes the owned temporary output', async (t) => {
  const fixture = await makeFixture(t);
  const reason = Object.assign(new Error('cancel staged output'), { code: 'cancelled' });
  let abortChecks = 0;
  const signal = {
    get aborted() {
      abortChecks += 1;
      return abortChecks >= 5;
    },
    get reason() { return reason; },
  };
  const writer = await createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: 'jerry',
    operationId: OPERATION_ID,
    signal,
  });

  await assert.rejects(
    writer.writeAtomic('cancelled-after-stage.md', Buffer.from('blocked')),
    (error) => error === reason,
  );
  assert.deepEqual(await fs.readdir(fixture.outputRoot), []);
});

test('invalid requester identity is rejected before a workspace path is derived', async (t) => {
  const fixture = await makeFixture(t);
  await assert.rejects(createRequesterOutputWriter({
    home23Root: fixture.home23Root,
    requesterAgent: '../forrest',
    operationId: OPERATION_ID,
    signal: new AbortController().signal,
  }), hasCode('invalid_request'));
});
