import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHomeBackup, inspectHomeBackup, moveHome, readMoveFence } from '../../cli/lib/product-backup.js';
import { runHostAction } from '../../cli/lib/product-host.js';

const quiet = { listProcesses: async () => [] };

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
  }, quiet);
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

test('a busy writer blocks backup even when desiredRunning is false', async t => {
  const fixture = stoppedHome(t, { desiredRunning: false });
  await assert.rejects(
    () => createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, {
      listProcesses: async () => [{ name: 'home23-milo', status: 'online' }],
    }),
    error => error.code === 'backup_writers_active',
  );
  assert.equal(fs.existsSync(fixture.archivePath), false);
  assert.equal(fs.existsSync(fixture.keyPath), false);
  assert.equal(fs.existsSync(path.join(fixture.home, 'runtime', '.host.lock')), false);
});

test('desiredRunning true still backs up when writers are stopped and Start is locked out', async t => {
  const fixture = stoppedHome(t, { desiredRunning: true });
  let locked = false;
  const created = await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, {
    listProcesses: async () => [{ name: 'home23-milo', status: 'stopped' }],
    afterLock: () => {
      locked = fs.lstatSync(path.join(fixture.home, 'runtime', '.host.lock')).isDirectory();
      assert.throws(() => fs.mkdirSync(path.join(fixture.home, 'runtime', '.host.lock')));
    },
  });
  assert.equal(locked, true);
  assert.equal(created.writersStarted, false);
  assert.equal(fs.existsSync(path.join(fixture.home, 'runtime', '.host.lock')), false);
});

test('a multi-chunk file round-trips without retaining the source', async t => {
  const fixture = stoppedHome(t);
  const payload = Buffer.alloc(256 * 1024, 7);
  fs.writeFileSync(path.join(fixture.home, 'app/instances/milo/workspace/note.txt'), payload);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  await inspectHomeBackup({ archivePath: fixture.archivePath, keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot });
  assert.equal(fs.readFileSync(path.join(fixture.inspectionRoot, 'app/instances/milo/workspace/note.txt')).equals(payload), true);
});

test('wrong key throws and leaves inspection empty', async t => {
  const fixture = stoppedHome(t);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  const wrongKey = path.join(fixture.root, 'out', 'wrong-key.json');
  fs.writeFileSync(wrongKey, `${JSON.stringify({
    schema: 'home23.backup-key.v1',
    algorithm: 'aes-256-gcm',
    key: Buffer.alloc(32, 7).toString('base64'),
  }, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => inspectHomeBackup({ archivePath: fixture.archivePath, keyPath: wrongKey, inspectionRoot: fixture.inspectionRoot }),
    /authenticate|decrypt|Backup|invalid/i,
  );
  assert.deepEqual(fs.readdirSync(fixture.inspectionRoot), []);
});

test('truncated archive throws', async t => {
  const fixture = stoppedHome(t);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
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
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  const inspected = await inspectHomeBackup({
    archivePath: fixture.archivePath,
    keyPath: fixture.keyPath,
    inspectionRoot: fixture.inspectionRoot,
  });
  assert.equal(inspected.writersStarted, false);
});

test('a missing supervisor is not proof that writers are stopped', async t => {
  const fixture = stoppedHome(t);
  fs.writeFileSync(path.join(fixture.home, '.home23-install.json'), '{"schema":"home23.product-install.v1","status":"installed"}\n');
  await assert.rejects(
    () => createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }),
    error => error.code === 'process_inventory_unavailable',
  );
  assert.equal(fs.existsSync(fixture.archivePath), false);
});

test('a blocking copy refreshes the host lock inside the copy loop', async t => {
  const fixture = stoppedHome(t);
  const payload = Buffer.alloc(128 * 1024, 9);
  fs.writeFileSync(path.join(fixture.home, 'app/instances/milo/workspace/note.txt'), payload);
  let refreshedAfterStale = false;
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, {
    ...quiet,
    lockRefreshMs: 0,
    beforeChunk: lockPath => {
      const stale = new Date(Date.now() - 200000);
      fs.utimesSync(lockPath, stale, stale);
    },
    onLockRefresh: lockPath => {
      refreshedAfterStale = Date.now() - fs.lstatSync(lockPath).mtimeMs < 2000;
    },
  });
  assert.equal(refreshedAfterStale, true);
});

test('a tampered archive does not write outside the inspection directory', async t => {
  const fixture = stoppedHome(t);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  const sentinel = path.join(fixture.root, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched\n');
  const bytes = fs.readFileSync(fixture.archivePath);
  bytes[bytes.length - 20] ^= 0xff;
  fs.writeFileSync(fixture.archivePath, bytes);
  await assert.rejects(() => inspectHomeBackup({
    archivePath: fixture.archivePath, keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot,
  }));
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched\n');
  assert.deepEqual(fs.readdirSync(fixture.inspectionRoot), []);
});

test('restoring rebases an in-home symlink onto the new root', async t => {
  const fixture = stoppedHome(t);
  const note = path.join(fixture.home, 'app/instances/milo/workspace/note.txt');
  fs.symlinkSync(note, path.join(fixture.home, 'app/instances/milo/workspace/link.txt'));
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  await inspectHomeBackup({ archivePath: fixture.archivePath, keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot });
  const restored = path.join(fixture.inspectionRoot, 'app/instances/milo/workspace/link.txt');
  assert.equal(fs.lstatSync(restored).isSymbolicLink(), true);
  const target = fs.realpathSync(restored);
  assert.equal(target.startsWith(fixture.inspectionRoot), true);
  assert.equal(target.startsWith(fixture.home), false);
  assert.equal(fs.readFileSync(restored, 'utf8'), 'remember this\n');
});

test('move fences the source and leaves the destination stopped', async t => {
  const fixture = stoppedHome(t);
  const birth = path.join(fixture.home, 'app/instances/milo/substrate/seed-01');
  fs.mkdirSync(birth, { recursive: true });
  fs.writeFileSync(path.join(birth, 'birth-receipt.json'), '{"seedId":"milo-seed"}\n');
  fs.writeFileSync(path.join(birth, 'seed-ledger.jsonl'), '{"event":"birth"}\n');
  fs.writeFileSync(path.join(fixture.home, '.home23-install.json'), '{"schema":"home23.product-install.v1","status":"installed","packageId":"abc","sourceCommit":"123"}\n');
  const destination = path.join(fixture.root, 'destination');
  fs.mkdirSync(destination, { mode: 0o755 });
  const moved = await moveHome({
    sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath,
  }, quiet);
  assert.equal(moved.fenced, true);
  assert.equal(moved.destinationStarted, false);
  assert.equal(moved.writersStarted, false);
  assert.equal(fs.readFileSync(path.join(destination, 'app/instances/milo/substrate/seed-01/birth-receipt.json'), 'utf8'), '{"seedId":"milo-seed"}\n');
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8')).homeRoot, destination);
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8')).desiredRunning, false);
  const fence = readMoveFence(fixture.home);
  assert.equal(fence.schema, 'home23.move-fence.v1');
  const started = await runHostAction('start', { homeRoot: fixture.home });
  assert.equal(started.ok, false);
  assert.equal(started.error.code, 'move_source_fenced');
});

test('move requires the resident Seed even when the resident is not Milo', async t => {
  const fixture = stoppedHome(t);
  const hostPath = path.join(fixture.home, '.home23-host.json');
  const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
  host.profile.name = 'ada';
  fs.writeFileSync(hostPath, JSON.stringify(host));
  const destination = path.join(fixture.root, 'ada-dest');
  fs.mkdirSync(destination, { mode: 0o755 });
  await assert.rejects(
    () => moveHome({ sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet),
    error => error.code === 'backup_identity_missing',
  );
});

test('a live move owner keeps the lock after its mtime goes stale', async t => {
  const fixture = stoppedHome(t);
  const seed = path.join(fixture.home, 'app/instances/milo/substrate/seed-01');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'birth-receipt.json'), '{"seedId":"milo"}\n');
  let blocked = false;
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, {
    ...quiet,
    afterLock: async () => {
      const lockPath = path.join(fixture.home, 'runtime', '.host.lock');
      const stale = new Date(Date.now() - 400000);
      fs.utimesSync(lockPath, stale, stale);
      await assert.rejects(
        () => createHomeBackup({
          homeRoot: fixture.home,
          archivePath: path.join(fixture.root, 'out', 'other.h23b'),
          keyPath: path.join(fixture.root, 'out', 'other-key.json'),
        }, quiet),
        error => error.code === 'backup_lifecycle_busy',
      );
      blocked = true;
    },
  });
  assert.equal(blocked, true);
});

test('an interrupted move resumes the fence without rewriting the source host record', async t => {
  const fixture = stoppedHome(t);
  const seed = path.join(fixture.home, 'app/instances/milo/substrate/seed-01');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'birth-receipt.json'), '{"seedId":"resume"}\n');
  fs.writeFileSync(path.join(fixture.home, '.home23-install.json'), '{"schema":"home23.product-install.v1","status":"installed"}\n');
  const hostPath = path.join(fixture.home, '.home23-host.json');
  const before = fs.readFileSync(hostPath);
  const destination = path.join(fixture.root, 'resume-dest');
  fs.mkdirSync(destination, { mode: 0o755 });
  await assert.rejects(
    () => moveHome({
      sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath,
    }, { ...quiet, afterRestore: () => { throw Object.assign(new Error('interrupted'), { code: 'move_interrupted' }); } }),
    error => error.code === 'move_interrupted',
  );
  assert.equal(readMoveFence(fixture.home), null);
  assert.equal(fs.readFileSync(hostPath).equals(before), true);
  const moved = await moveHome({
    sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath,
  }, quiet);
  assert.equal(moved.fenced, true);
  assert.equal(moved.resumed, true);
  assert.equal(fs.readFileSync(hostPath).equals(before), true);
  assert.equal(fs.readFileSync(path.join(destination, 'app/instances/milo/substrate/seed-01/birth-receipt.json'), 'utf8'), '{"seedId":"resume"}\n');
});

test('move rebinds destination ports and source paths without changing identity or the source', async t => {
  const fixture = stoppedHome(t);
  const seed = path.join(fixture.home, 'app/instances/milo/substrate/seed-01');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'birth-receipt.json'), '{"seedId":"rebinding"}\n');
  const hostPath = path.join(fixture.home, '.home23-host.json');
  const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
  host.encoderRequired = true;
  host.profile.model = 'fixture-local';
  host.ports = {
    coordination: 21089, engine: 21090, dashboard: 21091, mcp: 21092, bridge: 21093,
    evobrew: 21094, observatory: 21095, embedder: 21096,
  };
  fs.writeFileSync(hostPath, JSON.stringify(host));
  const sourceBefore = fs.readFileSync(hostPath);
  const recipe = '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9';
  const homeYaml = [
    'home:',
    '  primaryAgent: milo',
    'coordination:',
    '  publicApi:',
    '    port: 21089',
    '  socketDirectory: /tmp/old-socket',
    'providers:',
    '  ollama-local:',
    '    baseUrl: http://127.0.0.1:45911/v1',
    'embeddings:',
    '  providers:',
    '    - provider: home23-owned',
    `      endpoint: http://127.0.0.1:21096/api/embeddings`,
    `      recipeId: ${recipe}`,
    'substrate:',
    '  observatory:',
    '    port: 21095',
    '  embedding:',
    '    endpoint: http://127.0.0.1:21096/api/embeddings',
    `    recipeId: ${recipe}`,
    'embedder:',
    '  port: 21096',
    'shell:',
    '  roots:',
    `    - ${fixture.home}/app/instances/milo`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(fixture.home, 'app/config/home.yaml'), homeYaml, { mode: 0o600 });
  const sourceYaml = fs.readFileSync(path.join(fixture.home, 'app/config/home.yaml'));
  fs.writeFileSync(path.join(fixture.home, 'app/instances/milo/config.yaml'), [
    'agent:',
    '  name: milo',
    'ports:',
    '  engine: 21090',
    '  dashboard: 21091',
    '  mcp: 21092',
    '  bridge: 21093',
    'chat:',
    '  provider: ollama-local',
    '  model: fixture-local',
    'feeder:',
    '  additionalWatchPaths:',
    `    - path: ${fixture.home}/app/instances/milo/workspace/sessions`,
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(fixture.home, 'app/instances/milo/engine.yaml'), `model: fixture-local\nfeeder:\n  path: ${fixture.home}/app/instances/milo/workspace\n`);
  const destination = path.join(fixture.root, 'rebind-dest');
  fs.mkdirSync(destination, { mode: 0o755 });
  const moved = await moveHome({
    sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath,
  }, quiet);
  assert.equal(moved.fenced, true);
  assert.equal(moved.destinationStarted, false);
  assert.equal(fs.readFileSync(hostPath).equals(sourceBefore), true);
  assert.equal(fs.readFileSync(path.join(fixture.home, 'app/config/home.yaml')).equals(sourceYaml), true);
  assert.equal(fs.readFileSync(path.join(destination, 'app/instances/milo/substrate/seed-01/birth-receipt.json'), 'utf8'), '{"seedId":"rebinding"}\n');
  const destHost = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(destHost.desiredRunning, false);
  assert.equal(destHost.profile.model, 'fixture-local');
  assert.notEqual(destHost.ports.coordination, 21089);
  const { default: yaml } = await import('js-yaml');
  const rebound = yaml.load(fs.readFileSync(path.join(destination, 'app/config/home.yaml'), 'utf8'));
  assert.equal(rebound.home.primaryAgent, 'milo');
  assert.equal(rebound.coordination.publicApi.port, destHost.ports.coordination);
  assert.equal(rebound.coordination.socketDirectory.includes('/tmp/old-socket'), false);
  assert.equal(rebound.embedder.port, destHost.ports.embedder);
  assert.equal(rebound.substrate.observatory.port, destHost.ports.observatory);
  assert.equal(rebound.substrate.embedding.endpoint, `http://127.0.0.1:${destHost.ports.embedder}/api/embeddings`);
  assert.equal(rebound.substrate.embedding.recipeId, recipe);
  assert.equal(rebound.providers['ollama-local'].baseUrl, 'http://127.0.0.1:45911/v1');
  assert.equal(rebound.shell.roots[0], `${destination}/app/instances/milo`);
  assert.equal(JSON.stringify(rebound).includes(fixture.home), false);
  const instance = yaml.load(fs.readFileSync(path.join(destination, 'app/instances/milo/config.yaml'), 'utf8'));
  assert.equal(instance.chat.provider, 'ollama-local');
  assert.equal(instance.chat.model, 'fixture-local');
  assert.equal(instance.ports.engine, destHost.ports.engine);
  assert.equal(instance.ports.dashboard, destHost.ports.dashboard);
  assert.equal(instance.feeder.additionalWatchPaths[0].path, `${destination}/app/instances/milo/workspace/sessions`);
  const engine = yaml.load(fs.readFileSync(path.join(destination, 'app/instances/milo/engine.yaml'), 'utf8'));
  assert.equal(engine.model, 'fixture-local');
  assert.equal(engine.feeder.path, `${destination}/app/instances/milo/workspace`);
});
