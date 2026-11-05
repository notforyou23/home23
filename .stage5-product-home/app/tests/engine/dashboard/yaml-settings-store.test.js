import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const {
  createYamlSettingsStore,
} = require('../../../engine/src/dashboard/yaml-settings-store.js');

async function fixture(t, initial = 'query:\n  defaultModel: old\n') {
  const home23Root = await fs.mkdtemp(path.join(os.tmpdir(), 'home23-settings-store-'));
  const filePath = path.join(home23Root, 'config', 'home.yaml');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  if (initial !== null) await fs.writeFile(filePath, initial);
  t.after(() => fs.rm(home23Root, { recursive: true, force: true }));
  return { home23Root, filePath };
}

function store(paths, overrides = {}) {
  return createYamlSettingsStore({
    ...paths,
    yaml,
    logger: { warn() {} },
    ...overrides,
  });
}

test('serializes concurrent updates without losing unrelated settings', async t => {
  const paths = await fixture(t);
  const settings = store(paths);
  await Promise.all(Array.from({ length: 32 }, (_, index) => settings.update({
    mutate(data) {
      data.concurrent ||= {};
      data.concurrent[`key${index}`] = index;
    },
  })));
  const current = await settings.read();
  assert.equal(Object.keys(current.data.concurrent).length, 32);
  assert.equal(current.data.query.defaultModel, 'old');
  assert.match(current.version, /^sha256:[a-f0-9]{64}$/);
});

test('enforces exact versions and leaves a complete old or new file at crash points', async t => {
  const paths = await fixture(t);
  const initial = await store(paths).read();
  await store(paths).update({
    expectedVersion: initial.version,
    mutate(data) { data.value = 'first'; },
  });
  await assert.rejects(
    store(paths).update({
      expectedVersion: initial.version,
      mutate(data) { data.value = 'stale'; },
    }),
    error => error.code === 'settings_changed',
  );

  const beforeCrash = await fs.readFile(paths.filePath, 'utf8');
  await assert.rejects(store(paths, {
    crashInjector: async point => {
      if (point === 'beforeRename') throw new Error('before rename');
    },
  }).update({ mutate(data) { data.value = 'not-published'; } }), /before rename/);
  assert.equal(await fs.readFile(paths.filePath, 'utf8'), beforeCrash);

  await assert.rejects(store(paths, {
    crashInjector: async point => {
      if (point === 'afterRenameBeforeDirectoryFsync') throw new Error('after rename');
    },
  }).update({ mutate(data) { data.value = 'published'; } }), /after rename/);
  assert.equal(yaml.load(await fs.readFile(paths.filePath, 'utf8')).value, 'published');
});

test('backs up commented YAML while holding the update lock', async t => {
  const paths = await fixture(t, '# operator note\nquery:\n  defaultModel: old\n');
  const result = await store(paths).update({
    mutate(data) { data.query.defaultProvider = 'anthropic'; },
  });
  assert.equal(result.commentsDetected, true);
  assert.equal(result.commentLines, 1);
  assert.ok(result.backupPath);
  assert.match(await fs.readFile(result.backupPath, 'utf8'), /operator note/);
});

test('rejects symlinked settings files and parent directories', async t => {
  const paths = await fixture(t, null);
  const outside = path.join(paths.home23Root, 'outside.yaml');
  await fs.writeFile(outside, 'safe: false\n');
  await fs.symlink(outside, paths.filePath);
  await assert.rejects(
    store(paths).read(),
    error => error.code === 'settings_path_invalid',
  );

  await fs.unlink(paths.filePath);
  const realConfig = path.join(paths.home23Root, 'real-config');
  await fs.mkdir(realConfig);
  await fs.rmdir(path.dirname(paths.filePath));
  await fs.symlink(realConfig, path.dirname(paths.filePath));
  await assert.rejects(
    store(paths).update({ mutate(data) { data.x = 1; } }),
    error => error.code === 'settings_path_invalid',
  );
});
