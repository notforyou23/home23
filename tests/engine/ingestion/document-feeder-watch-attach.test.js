import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DocumentFeeder } = require('../../../engine/src/ingestion/document-feeder');

// A configured watch folder that did not exist at engine start (a fresh
// resident's workspace/projects, created later by the harness) was skipped
// for the life of the engine with one warn line. It must stay registered as
// missing, show up in status, and attach when it appears.

const silentLogger = { info() {}, warn() {}, debug() {}, error() {} };

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

async function startedFeeder(t, { watchPaths = [], extraConfig = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-attach-'));
  const runPath = path.join(root, 'brain');
  fs.mkdirSync(runPath, { recursive: true });
  const feeder = new DocumentFeeder({
    memory: { embed: async () => null },
    config: {
      compiler: { enabled: false },
      // Tests drive the retry directly; the interval must never fire here.
      missingPathRetrySeconds: 3600,
      additionalWatchPaths: watchPaths.map(entry => ({ path: path.join(root, entry.dir), label: entry.label })),
      ...extraConfig,
    },
    logger: silentLogger,
  });
  const processed = [];
  feeder._processFile = async (filePath, label) => { processed.push({ filePath, label }); };
  await feeder.start(runPath);
  t.after(async () => {
    await feeder.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { feeder, root, processed };
}

test('a configured absent path is registered as missing and excluded from watching', async (t) => {
  const { feeder, root } = await startedFeeder(t, { watchPaths: [{ dir: 'workspace/projects', label: 'projects' }] });
  const status = await feeder.getStatus();
  const projects = status.watchPaths.find(entry => entry.label === 'projects');

  assert.equal(projects.state, 'missing');
  assert.equal(projects.source, 'configured');
  assert.ok(projects.missingSince);
  assert.equal(status.watching.includes(path.join(root, 'workspace/projects')), false);
  assert.deepEqual(status.watchSummary, { configured: 2, attached: 1, missing: 1, error: 0 });
  assert.notEqual(feeder._retryTimer, null, 'the retry tick runs while the feeder is started');
});

test('a missing path attaches once it appears and its existing files are scanned', async (t) => {
  const { feeder, root, processed } = await startedFeeder(t, { watchPaths: [{ dir: 'workspace/projects', label: 'projects' }] });
  const projectsDir = path.join(root, 'workspace/projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const canary = path.join(projectsDir, 'canary.md');
  fs.writeFileSync(canary, '# canary\n');

  assert.equal(feeder._retryMissingWatchPaths(), 1);

  const status = await feeder.getStatus();
  assert.equal(status.watchPaths.find(entry => entry.label === 'projects').state, 'attached');
  assert.equal(status.watching.includes(projectsDir), true);
  assert.equal(await waitFor(() => processed.some(entry => entry.filePath === canary)), true);
  assert.equal(processed.find(entry => entry.filePath === canary).label, 'projects');
});

test('a file created after a late attach reaches the pipeline through chokidar', async (t) => {
  const { feeder, root, processed } = await startedFeeder(t, { watchPaths: [{ dir: 'late', label: 'late' }] });
  const lateDir = path.join(root, 'late');
  fs.mkdirSync(lateDir);
  feeder._retryMissingWatchPaths();
  const watcher = feeder._watchers.find(entry => entry.path === lateDir).watcher;
  await new Promise(resolve => watcher.once('ready', resolve));
  // macOS starts the underlying fs event stream a moment after 'ready'; a
  // file written inside that gap is covered in production by the attach
  // scan, not by an event, so give the stream time to start.
  await new Promise(resolve => setTimeout(resolve, 500));

  const fresh = path.join(lateDir, 'fresh.md');
  fs.writeFileSync(fresh, '# fresh\n');

  assert.equal(await waitFor(() => processed.some(entry => entry.filePath === fresh), 8000), true);
});

test('addWatchPath reports a missing folder, attaches it later, and never doubles a watcher', async (t) => {
  const { feeder, root } = await startedFeeder(t);
  const target = path.join(root, 'later');

  const added = await feeder.addWatchPath(target, 'later');
  assert.deepEqual(added, { path: target, label: 'later', state: 'missing' });

  fs.mkdirSync(target);
  const again = await feeder.addWatchPath(target, 'later');
  assert.equal(again.state, 'attached');
  const duplicate = await feeder.addWatchPath(target, 'later');
  assert.equal(duplicate.duplicate, true);
  assert.equal(feeder._watchers.filter(entry => entry.path === target).length, 1);
  assert.equal((await feeder.getStatus()).watchPaths.find(entry => entry.path === target).source, 'runtime');
});

test('removeWatchPath drops a missing target and its retries', async (t) => {
  const { feeder, root } = await startedFeeder(t, { watchPaths: [{ dir: 'gone', label: 'gone' }] });

  assert.equal(await feeder.removeWatchPath(path.join(root, 'gone')), true);
  assert.equal((await feeder.getStatus()).watchPaths.some(entry => entry.label === 'gone'), false);
  assert.equal(feeder._retryMissingWatchPaths(), 0);
  assert.equal(await feeder.removeWatchPath(path.join(root, 'never-configured')), false);
});

test('deleting an attached root returns it to missing so it can reattach', async (t) => {
  const { feeder, root } = await startedFeeder(t, { watchPaths: [{ dir: 'volatile', label: 'volatile' }] });
  const volatileDir = path.join(root, 'volatile');
  fs.mkdirSync(volatileDir);
  feeder._retryMissingWatchPaths();
  const watcher = feeder._watchers.find(entry => entry.path === volatileDir).watcher;
  await new Promise(resolve => watcher.once('ready', resolve));

  fs.rmSync(volatileDir, { recursive: true, force: true });

  // chokidar reports no unlinkDir for an empty root; the retry tick checks.
  const target = () => feeder._watchTargets.get(path.resolve(volatileDir));
  assert.equal(feeder._retryMissingWatchPaths(), 0);
  assert.equal(target().state, 'missing');
  assert.ok(target().missingSince);
  assert.equal(feeder._watchers.some(entry => entry.path === volatileDir), false);

  fs.mkdirSync(volatileDir);
  feeder._retryMissingWatchPaths();
  assert.equal(target().state, 'attached');
});

test('shutdown clears the retry timer', async (t) => {
  const { feeder } = await startedFeeder(t, { watchPaths: [{ dir: 'absent', label: 'absent' }] });
  assert.notEqual(feeder._retryTimer, null);

  await feeder.shutdown();

  assert.equal(feeder._retryTimer, null);
});

test("a configured or added '~' folder is watched in the owner home, not the runtime HOME", async (t) => {
  const keys = ['HOME', 'HOME23_OWNER_HOME', 'HOME23_PRODUCT_HOST'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const homes = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feeder-owner-'));
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(homes, { recursive: true, force: true });
  });
  const owner = path.join(homes, 'owner');
  fs.mkdirSync(path.join(owner, 'Projects'), { recursive: true });
  fs.mkdirSync(path.join(owner, 'Notes'), { recursive: true });
  // A Host engine: HOME is Home23's private runtime home. Settings -> Feeder
  // saves folders as typed, so '~' reaches the feeder unexpanded.
  Object.assign(process.env, { HOME: path.join(homes, 'runtime-user'), HOME23_OWNER_HOME: owner, HOME23_PRODUCT_HOST: 'true' });
  const { feeder } = await startedFeeder(t, { extraConfig: { additionalWatchPaths: [{ path: '~/Projects', label: 'projects' }] } });

  const projects = (await feeder.getStatus()).watchPaths.find(entry => entry.label === 'projects');
  assert.equal(projects.path, path.join(owner, 'Projects'));
  assert.equal(projects.state, 'attached');
  const added = await feeder.addWatchPath('~/Notes', 'notes');
  assert.equal(added.path, path.join(owner, 'Notes'));
  assert.equal(added.state, 'attached');
});
