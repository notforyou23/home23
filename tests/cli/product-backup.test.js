import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHomeBackup, inspectHomeBackup } from '../../cli/lib/product-backup.js';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-backup-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function stoppedHome(t, { desiredRunning = false, secrets = false } = {}) {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, 'app/instances/milo/workspace'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(home, 'app/instances/milo/workspace/note.txt'), 'remember this\n', { mode: 0o644 });
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), 'name: milo\n', { mode: 0o600 });
  if (secrets) fs.writeFileSync(path.join(home, 'app/config/secrets.yaml'), 'providers: { openai: test }\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
    schema: 'home23.host.v2',
    homeRoot: home,
    profile: { name: 'milo', provider: 'ollama-local', model: 'fixture' },
    desiredRunning,
    phase: 'prepared',
  }), { mode: 0o600 });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  return {
    root,
    home,
    archivePath: path.join(out, 'home.h23b'),
    keyPath: path.join(out, 'home.backup-key.json'),
    inspectionRoot: path.join(root, 'inspect'),
  };
}

test('round-trips a stopped fixture home with workspace and home.yaml', async t => {
  const fixture = stoppedHome(t, { secrets: true });
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  const created = await createHomeBackup({
    homeRoot: fixture.home,
    archivePath: fixture.archivePath,
    keyPath: fixture.keyPath,
  });
  assert.equal(created.ok, true);
  assert.equal(created.schema, 'home23.backup.v1');
  assert.equal(created.writersStarted, false);
  assert.ok(created.fileCount >= 3);
  assert.equal(fs.existsSync(fixture.archivePath), true);
  assert.equal(fs.existsSync(fixture.keyPath), true);
  const key = JSON.parse(fs.readFileSync(fixture.keyPath, 'utf8'));
  assert.equal(key.schema, 'home23.backup-key.v1');
  assert.equal(key.algorithm, 'aes-256-gcm');
  assert.equal(Buffer.from(key.key, 'base64').length, 32);
  assert.equal((fs.lstatSync(fixture.keyPath).mode & 0o777), 0o600);
  const archive = fs.readFileSync(fixture.archivePath);
  assert.equal(archive.subarray(0, 4).toString('ascii'), 'H23B');
  assert.equal(archive.includes(Buffer.from(key.key, 'base64')), false);

  const inspected = await inspectHomeBackup({
    archivePath: fixture.archivePath,
    keyPath: fixture.keyPath,
    inspectionRoot: fixture.inspectionRoot,
  });
  assert.equal(inspected.ok, true);
  assert.equal(inspected.schema, 'home23.backup.v1');
  assert.equal(inspected.writersStarted, false);
  assert.equal(inspected.fileCount, created.fileCount);
  assert.equal(fs.readFileSync(path.join(fixture.inspectionRoot, 'app/instances/milo/workspace/note.txt'), 'utf8'), 'remember this\n');
  assert.equal(fs.readFileSync(path.join(fixture.inspectionRoot, 'app/config/home.yaml'), 'utf8'), 'name: milo\n');
  assert.equal(fs.readFileSync(path.join(fixture.inspectionRoot, 'app/config/secrets.yaml'), 'utf8'), 'providers: { openai: test }\n');
  assert.deepEqual(inspected.reconnects[0], {
    kind: 'machine-bindings',
    required: true,
    message: 'Ports, supervisor registration, and absolute machine paths have to be rebound before this home runs.',
  });
  assert.equal(inspected.reconnects.some(item => item.kind === 'provider-credentials' && item.transferred === true), true);
});

test('desiredRunning true creates no archive and no key', async t => {
  const fixture = stoppedHome(t, { desiredRunning: true });
  await assert.rejects(
    () => createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }),
    error => error.code === 'backup_requires_quiesce',
  );
  assert.equal(fs.existsSync(fixture.archivePath), false);
  assert.equal(fs.existsSync(fixture.keyPath), false);
});

test('wrong key throws and leaves inspection empty', async t => {
  const fixture = stoppedHome(t);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath });
  const wrongKey = path.join(fixture.root, 'out', 'wrong-key.json');
  fs.writeFileSync(wrongKey, `${JSON.stringify({
    schema: 'home23.backup-key.v1',
    algorithm: 'aes-256-gcm',
    key: Buffer.alloc(32, 7).toString('base64'),
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => inspectHomeBackup({ archivePath: fixture.archivePath, keyPath: wrongKey, inspectionRoot: fixture.inspectionRoot }),
    /decrypt|Backup/i,
  );
  assert.deepEqual(fs.readdirSync(fixture.inspectionRoot), []);
});

test('truncated archive throws', async t => {
  const fixture = stoppedHome(t);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath });
  const bytes = fs.readFileSync(fixture.archivePath);
  fs.writeFileSync(fixture.archivePath, bytes.subarray(0, Math.max(8, Math.floor(bytes.length / 2))));
  await assert.rejects(
    () => inspectHomeBackup({ archivePath: fixture.archivePath, keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot }),
  );
  assert.deepEqual(fs.readdirSync(fixture.inspectionRoot), []);
});

test('writersStarted is false after inspection', async t => {
  const fixture = stoppedHome(t);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath });
  const inspected = await inspectHomeBackup({
    archivePath: fixture.archivePath,
    keyPath: fixture.keyPath,
    inspectionRoot: fixture.inspectionRoot,
  });
  assert.equal(inspected.writersStarted, false);
});
