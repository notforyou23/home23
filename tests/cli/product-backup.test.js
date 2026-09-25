import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  createHomeBackup, inspectHomeBackup, moveHome, readAuthenticatedBackupHeader, readMoveFence, recoverInspectedHome, rebindAdoptedHome,
  rewriteAdoptedCronPromptPaths,
} from '../../cli/lib/product-backup.js';
import { writeProductManifest } from '../../cli/lib/product-payload.js';
import { detectForeignBindings } from '../../cli/lib/product-foreign-bindings.js';
import { runHostAction } from '../../cli/lib/product-host.js';
import { SUPPORTED_COORDINATION_SCHEMAS } from '../../cli/lib/product-update-inventory.js';

const quiet = { listProcesses: async () => [] };
const cursorId = sourcePath => `tail_${createHash('sha256').update(sourcePath).digest('hex').slice(0, 8)}`;

function seedCursor(home, sourcePath, offset, id = cursorId(sourcePath), extra = {}, resident = 'milo', state = 'substrate/seed-01') {
  const directory = path.join(home, `app/instances/${resident}/${state}`);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `adapter-cursor.${id}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ schema: 'home23.seed.adapter-cursor.v1', sourcePath, offset, ...extra })}\n`, { mode: 0o600 });
  return file;
}

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

test('backup receipt records the copied database schema for v20 and v21', async t => {
  for (const version of [20, 21]) {
    await t.test(`v${version}`, async subtest => {
      const fixture = stoppedHome(subtest);
      const file = path.join(fixture.home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new DatabaseSync(file);
      db.exec(`PRAGMA user_version = ${version};
        CREATE TABLE schema_migrations (version INTEGER, checksum TEXT);
        INSERT INTO schema_migrations VALUES (${version}, '${SUPPORTED_COORDINATION_SCHEMAS[version].migrationChecksum}');
        CREATE TABLE kernel_meta (key TEXT PRIMARY KEY, value TEXT);
        INSERT INTO kernel_meta VALUES ('schema.checksum', '${SUPPORTED_COORDINATION_SCHEMAS[version].schemaChecksum}');`);
      db.close();
      await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
      assert.equal(readAuthenticatedBackupHeader({ archivePath: fixture.archivePath, keyPath: fixture.keyPath }).coordinationSchema, version);
    });
  }
});

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

test('authenticated backup retains only a reviewed external adoption link', async t => {
  const fixture = stoppedHome(t);
  const external = path.join(fixture.root, 'external-history');
  fs.mkdirSync(external);
  const relative = 'app/instances/milo/workspace/history';
  fs.symlinkSync(external, path.join(fixture.home, relative));
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { mode: 0o700 });
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: fixture.root,
    links: [{ path: relative, target: external, sourcePath: 'instances/milo/workspace/history',
      sourceTarget: external, kind: 'retain-link' }], externalReferences: [],
  }), { mode: 0o600 });
  fs.mkdirSync(fixture.inspectionRoot);
  const created = await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath,
    keyPath: fixture.keyPath }, quiet);
  assert.equal(created.ok, true);
  const inspected = await inspectHomeBackup({ archivePath: fixture.archivePath,
    keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot });
  assert.equal(inspected.ok, true);
  assert.equal(fs.readlinkSync(path.join(fixture.inspectionRoot, relative)), external);
});

test('inspection resolves a reviewed file link after its later receipt record', async t => {
  const fixture = stoppedHome(t);
  const external = path.join(fixture.root, 'external-config.json');
  fs.writeFileSync(external, '{}\n');
  const relative = 'app/evobrew/config.json';
  fs.mkdirSync(path.join(fixture.home, 'app/evobrew'));
  fs.symlinkSync(external, path.join(fixture.home, relative));
  fs.mkdirSync(path.join(fixture.home, 'runtime'));
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: fixture.root,
    links: [{ path: relative, target: external, sourcePath: 'evobrew/config.json', sourceTarget: external,
      kind: 'retain-link' }], externalReferences: [],
  }), { mode: 0o600 });
  fs.mkdirSync(fixture.inspectionRoot);
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  const inspected = await inspectHomeBackup({ archivePath: fixture.archivePath,
    keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot });
  assert.equal(inspected.ok, true);
  assert.equal(fs.readlinkSync(path.join(fixture.inspectionRoot, relative)), external);
});

test('retained external authority is reported as a source-absent recovery dependency', async t => {
  const fixture = stoppedHome(t);
  const authority = path.join(fixture.home, 'retained-authority');
  fs.mkdirSync(authority);
  const relative = 'app/evobrew';
  fs.symlinkSync(authority, path.join(fixture.home, relative));
  fs.mkdirSync(path.join(fixture.home, 'runtime'));
  fs.writeFileSync(path.join(fixture.home, 'runtime/adoption-preservation.json'), JSON.stringify({
    schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: fixture.root,
    links: [{ path: relative, target: authority, sourcePath: 'evobrew', sourceTarget: authority,
      kind: 'retain-authority' }], externalReferences: [],
  }), { mode: 0o600 });
  fs.mkdirSync(fixture.inspectionRoot);
  await createHomeBackup({ homeRoot: fixture.home, archivePath: fixture.archivePath, keyPath: fixture.keyPath }, quiet);
  fs.rmSync(authority, { recursive: true });
  const inspected = await inspectHomeBackup({ archivePath: fixture.archivePath,
    keyPath: fixture.keyPath, inspectionRoot: fixture.inspectionRoot });
  assert.equal(inspected.ok, false);
  assert.equal(inspected.sourceAbsentReady, false);
  assert.deepEqual(inspected.externalDependencies.map(item => ({ path: item.path, present: item.present })),
    [{ path: relative, present: false }]);
  assert.equal(fs.readlinkSync(path.join(fixture.inspectionRoot, relative)), authority);
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

test('move reports foreign supervisors bound to the source or destination as non-fatal warnings', async t => {
  const fixture = stoppedHome(t);
  const birth = path.join(fixture.home, 'app/instances/milo/substrate/seed-01');
  fs.mkdirSync(birth, { recursive: true });
  fs.writeFileSync(path.join(birth, 'birth-receipt.json'), '{"seedId":"milo-seed"}\n');
  fs.writeFileSync(path.join(birth, 'seed-ledger.jsonl'), '{"event":"birth"}\n');
  fs.writeFileSync(path.join(fixture.home, '.home23-install.json'), '{"schema":"home23.product-install.v1","status":"installed","packageId":"abc","sourceCommit":"123"}\n');
  const destination = path.join(fixture.root, 'destination');
  fs.mkdirSync(destination, { mode: 0o755 });
  // The owner's global PM2 daemon and a launchd agent, outside both homes.
  const userHome = path.join(fixture.root, 'user');
  const dump = path.join(userHome, '.pm2/dump.pm2');
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify([
    { name: 'cosmo-engine', pm_cwd: `${fixture.home}/app`, env: { HOME23_ROOT: `${fixture.home}/app` }, pm_out_log_path: `${fixture.home}/app/logs/engine.log` },
    { name: 'other', pm_cwd: '/opt/other', env: { HOME23_ROOT: `${fixture.home}-archive/app` } },
  ]));
  const agents = path.join(userHome, 'Library/LaunchAgents');
  fs.mkdirSync(agents, { recursive: true });
  fs.writeFileSync(path.join(agents, 'com.example.watch.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>Label</key><string>com.example.watch</string>
<key>ProgramArguments</key><array><string>${destination}/app/scripts/watch.mjs</string></array></dict></plist>
`);
  const dumpBefore = fs.readFileSync(dump);
  const scan = options => detectForeignBindings({ ...options, homeDirectory: userHome });
  const moved = await moveHome({
    sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath,
  }, { ...quiet, detectForeignBindings: scan });
  assert.equal(moved.ok, true);
  assert.equal(moved.fenced, true);
  assert.deepEqual(moved.foreignBindings.roots, [destination, fixture.home]);
  assert.deepEqual(moved.foreignBindings.references.map(reference => [reference.source, reference.name, reference.field, reference.root]), [
    ['pm2', 'cosmo-engine', 'pm_cwd', fixture.home],
    ['pm2', 'cosmo-engine', 'env.HOME23_ROOT', fixture.home],
    ['pm2', 'cosmo-engine', 'pm_out_log_path', fixture.home],
    ['launchd', 'com.example.watch', 'ProgramArguments[0]', destination],
  ]);
  assert.equal(moved.warnings.length, 2);
  assert.match(moved.warnings[0], /PM2 app "cosmo-engine"/);
  assert.match(moved.warnings[0], /Home23 did not change it/);
  assert.match(moved.warnings[1], /launchd agent "com\.example\.watch"/);
  assert.deepEqual(fs.readFileSync(dump), dumpBefore);
  assert.equal(readMoveFence(fixture.home).schema, 'home23.move-fence.v1');
  // Finishing the fenced move on a clean machine reports an empty scan, not stale warnings.
  const resumed = await moveHome({
    sourceHome: fixture.home, destinationRoot: destination, archivePath: fixture.archivePath, keyPath: fixture.keyPath,
  }, { ...quiet, detectForeignBindings: options => detectForeignBindings({ ...options, homeDirectory: path.join(fixture.root, 'nobody') }) });
  assert.equal(resumed.resumed, true);
  assert.deepEqual(resumed.warnings, []);
  assert.deepEqual(resumed.foreignBindings.references, []);
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
  const cursorSource = path.join(fixture.home, 'app/instances/milo/workspace/events.jsonl');
  const originalCursor = seedCursor(fixture.home, cursorSource, 12345, undefined, { lastEvent: 'preserved' });
  seedCursor(fixture.home, path.join(fixture.home, 'app/instances/milo/workspace/conversations.jsonl'),
    456, 'conversation-stream', { explicit: true });
  seedCursor(fixture.home, path.join(fixture.root, 'external-events.jsonl'), 87, 'relationship-ledger');
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
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { recursive: true, mode: 0o700 });
  const recipeId = '12e9f736ef4a7462e88cc228236d9e098d9dff7c30d178c7f9a3cb243d65efd9';
  fs.writeFileSync(path.join(fixture.home, 'runtime/semantic-prep.json'), JSON.stringify({
    schema: 'home23.semantic-prep.v1',
    homeRoot: fixture.home,
    phase: 'ready',
    recipeId,
    port: 21096,
    cacheDir: path.join(fixture.home, 'runtime/embedder-cache'),
    workerPid: 0,
    workerArgv: [path.join(fixture.home, 'bin/node'), path.join(fixture.root, 'package-a/app/scripts/product/semantic-prepare-worker.mjs'), '--home', fixture.home],
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(fixture.home, 'app/config/agents.json'), JSON.stringify([{
    name: 'milo',
    configPath: path.join(fixture.home, 'app/instances/milo/config.yaml'),
    instanceRoot: path.join(fixture.home, 'app/instances/milo'),
    brainPath: path.join(fixture.home, 'app/instances/milo/brain'),
  }]), { mode: 0o600 });
  fs.mkdirSync(path.join(fixture.home, 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(fixture.home, 'runtime/ecosystem.config.json'), JSON.stringify({
    apps: [{ cwd: path.join(fixture.home, 'app'), env: { HOME23_EMBEDDER_PORT: '21096' } }],
  }), { mode: 0o600 });
  const sourcePrep = fs.readFileSync(path.join(fixture.home, 'runtime/semantic-prep.json'));
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
  assert.equal(fs.readFileSync(originalCursor, 'utf8').includes(cursorSource), true);
  const reboundSource = path.join(destination, 'app/instances/milo/workspace/events.jsonl');
  const reboundCursor = path.join(destination, `app/instances/milo/substrate/seed-01/adapter-cursor.${cursorId(reboundSource)}.json`);
  assert.equal(fs.existsSync(path.join(destination, `app/instances/milo/substrate/seed-01/adapter-cursor.${cursorId(cursorSource)}.json`)), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(reboundCursor, 'utf8')), {
    schema: 'home23.seed.adapter-cursor.v1', sourcePath: reboundSource, offset: 12345, lastEvent: 'preserved',
  });
  assert.equal(JSON.parse(fs.readFileSync(path.join(destination, 'app/instances/milo/substrate/seed-01/adapter-cursor.relationship-ledger.json'), 'utf8')).offset, 87);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination,
    'app/instances/milo/substrate/seed-01/adapter-cursor.conversation-stream.json'), 'utf8')),
  { schema: 'home23.seed.adapter-cursor.v1',
    sourcePath: path.join(destination, 'app/instances/milo/workspace/conversations.jsonl'), offset: 456, explicit: true });
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
  assert.equal(fs.readFileSync(path.join(fixture.home, 'runtime/semantic-prep.json')).equals(sourcePrep), true);
  const prep = JSON.parse(fs.readFileSync(path.join(destination, 'runtime/semantic-prep.json'), 'utf8'));
  assert.equal(prep.homeRoot, destination);
  assert.equal(prep.phase, 'ready');
  assert.equal(prep.recipeId, recipeId);
  assert.equal(prep.port, destHost.ports.embedder);
  assert.equal(prep.cacheDir, path.join(destination, 'runtime/embedder-cache'));
  assert.equal(prep.workerArgv[0], path.join(destination, 'bin/node'));
  assert.equal(prep.workerArgv[1], path.join(destination, 'app/scripts/product/semantic-prepare-worker.mjs'));
  assert.equal(prep.workerArgv[3], destination);
  assert.equal(JSON.stringify(prep).includes(fixture.home), false);
  const agents = JSON.parse(fs.readFileSync(path.join(destination, 'app/config/agents.json'), 'utf8'));
  assert.equal(agents[0].instanceRoot, path.join(destination, 'app/instances/milo'));
  assert.equal(agents[0].brainPath, path.join(destination, 'app/instances/milo/brain'));
  assert.equal(JSON.stringify(agents).includes(fixture.home), false);
  assert.equal(fs.existsSync(path.join(destination, 'runtime/ecosystem.config.json')), false);
  assert.equal(fs.existsSync(path.join(fixture.home, 'runtime/ecosystem.config.json')), true);
});

test('a resumed move corrects existing directory and file modes from the manifest', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const files = {
    'bin/node': [0o755, '#!/bin/sh\n'],
    'app/marker.txt': [0o644, 'marker\n'],
    'app/cli/home23.js': [0o644, 'export {};\n'],
    'app/cli/lib/product-payload.js': [0o644, 'export {};\n'],
    'app/scripts/product/host.mjs': [0o644, 'export {};\n'],
    'tools/node_modules/pm2/bin/pm2': [0o644, 'pm2\n'],
  };
  for (const [relative, [mode, contents]] of Object.entries(files)) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode });
    fs.chmodSync(file, mode);
  }
  for (const dir of ['bin', 'app', 'app/cli', 'app/cli/lib', 'app/scripts', 'app/scripts/product', 'tools', 'tools/node_modules', 'tools/node_modules/pm2', 'tools/node_modules/pm2/bin']) {
    fs.chmodSync(path.join(home, dir), 0o755);
  }
  writeProductManifest(home, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  fs.mkdirSync(path.join(home, 'app/instances/milo/substrate/seed-01'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/instances/milo/substrate/seed-01/birth-receipt.json'), '{"seedId":"modes"}\n');
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
    schema: 'home23.host.v2', homeRoot: home, profile: { name: 'milo', provider: 'ollama-local', model: 'fixture-local' },
    desiredRunning: false, phase: 'prepared', encoderRequired: false,
  }), { mode: 0o600 });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const destination = path.join(root, 'dest');
  fs.mkdirSync(destination, { mode: 0o755 });
  const moveArgs = { sourceHome: home, destinationRoot: destination, archivePath: path.join(out, 'home.h23b'), keyPath: path.join(out, 'key.json') };
  await assert.rejects(
    () => moveHome(moveArgs, { ...quiet, afterRestore: () => { throw Object.assign(new Error('interrupted'), { code: 'move_interrupted' }); } }),
    error => error.code === 'move_interrupted',
  );
  fs.mkdirSync(path.join(destination, 'app'), { recursive: true });
  fs.writeFileSync(path.join(destination, 'app/marker.txt'), 'marker\n', { mode: 0o600 });
  fs.chmodSync(path.join(destination, 'app'), 0o700);
  const moved = await moveHome(moveArgs, quiet);
  assert.equal(moved.fenced, true);
  assert.equal(fs.statSync(path.join(destination, 'app')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(destination, 'app/marker.txt')).mode & 0o777, 0o644);
  assert.equal(fs.readFileSync(path.join(destination, 'app/instances/milo/substrate/seed-01/birth-receipt.json'), 'utf8'), '{"seedId":"modes"}\n');
});

function fixturePayload(root, { commit = 'b'.repeat(40), nodeMarker = '#!/bin/sh\n# recovered-payload-node\n', withSymlink = false } = {}) {
  const payload = path.join(root, 'payload');
  for (const [relative, contents] of Object.entries({
    'bin/node': nodeMarker,
    'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n',
    'app/scripts/product/host.mjs': 'export {};\n',
    'tools/node_modules/pm2/bin/pm2': 'pm2\n',
  })) {
    const file = path.join(payload, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  let symlinkPath = null;
  let symlinkTarget = null;
  if (withSymlink) {
    symlinkPath = 'app/cli/home23-alias';
    symlinkTarget = 'home23.js';
    fs.symlinkSync(symlinkTarget, path.join(payload, symlinkPath));
  }
  const manifest = writeProductManifest(payload, {
    sourceCommit: commit, platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0',
  });
  return { payload, manifest, nodeMarker, symlinkPath, symlinkTarget };
}

function seedRecoverableHome(home, {
  resident = 'ada',
  note = 'workspace-a\n',
  packageId = null,
  sourceCommit = null,
  profile = { name: resident, provider: 'ollama-local', model: 'fixture-local' },
  residentMap = { [resident]: { role: 'primary' } },
} = {}) {
  fs.mkdirSync(path.join(home, `app/instances/${resident}/workspace`), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(home, `app/instances/${resident}/substrate/seed-01`), { recursive: true });
  const birthBytes = `{"seedId":"${resident}-seed"}\n`;
  fs.writeFileSync(path.join(home, `app/instances/${resident}/substrate/seed-01/birth-receipt.json`), birthBytes);
  fs.writeFileSync(path.join(home, `app/instances/${resident}/substrate/seed-01/seed-ledger.jsonl`), '{"event":"birth"}\n');
  fs.writeFileSync(path.join(home, `app/instances/${resident}/workspace/note.txt`), note, { mode: 0o644 });
  const host = {
    schema: 'home23.host.v2',
    homeRoot: home,
    desiredRunning: false,
    phase: 'prepared',
    encoderRequired: true,
    ports: {
      coordination: 21089, engine: 21090, dashboard: 21091, mcp: 21092, bridge: 21093,
      evobrew: 21094, observatory: 21095, embedder: 21096,
    },
    residentMap,
  };
  if (profile) host.profile = profile;
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify(host), { mode: 0o600 });
  if (packageId && sourceCommit) {
    fs.writeFileSync(path.join(home, '.home23-install.json'), JSON.stringify({
      schema: 'home23.product-install.v1', status: 'installed', homeRoot: home, appRoot: path.join(home, 'app'),
      nodePath: path.join(home, 'bin', 'node'), pm2Path: path.join(home, 'tools', 'node_modules', 'pm2', 'bin', 'pm2'),
      packageId, sourceCommit, replayed: false,
    }) + '\n', { mode: 0o600 });
  }
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), [
    'home:',
    `  primaryAgent: ${resident}`,
    'coordination:',
    '  publicApi:',
    '    port: 21089',
    '  socketDirectory: /tmp/old-ada-socket',
    'shell:',
    '  roots:',
    `    - ${home}/app/instances/${resident}`,
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(home, `app/instances/${resident}/config.yaml`), [
    'agent:',
    `  name: ${resident}`,
    'ports:',
    '  engine: 21090',
    '  dashboard: 21091',
    '  mcp: 21092',
    '  bridge: 21093',
    '',
  ].join('\n'));
  return { birthBytes, resident };
}

function continuingServiceFixture(home, root) {
  const authority = path.join(root, 'external-authority');
  fs.mkdirSync(authority);
  const authorityConfig = path.join(authority, 'config.json');
  const authorityBytes = JSON.stringify({ legacyRoot: home, port: 21089 });
  fs.writeFileSync(authorityConfig, authorityBytes);
  fs.symlinkSync(authority, path.join(home, 'app/evobrew'));
  const service = { name: 'home23-project', executable: path.join(home, 'bin/node'),
    cwd: path.join(home, 'app/instances'), args: [path.join(home, 'app/instances/project.mjs')],
    env: { HOME23_ROOT: path.join(home, 'app'), API_URL: 'http://127.0.0.1:21089', EXTERNAL_ROOT: authority },
    stateRoots: [path.join(home, 'app/instances'), authority], startOnHomeStart: true };
  const hostPath = path.join(home, '.home23-host.json');
  const host = JSON.parse(fs.readFileSync(hostPath));
  host.continuationServices = [service];
  fs.writeFileSync(hostPath, JSON.stringify(host));
  fs.mkdirSync(path.join(home, 'runtime'), { recursive: true });
  const { name, ...run } = service;
  const receipt = { schema: 'home23.adoption-preservation-receipt.v1', sourceRoot: '/historical-source',
    links: [{ path: 'app/evobrew', target: authority, kind: 'retain-authority' }], externalReferences: [],
    continuationServices: [{ name, source: { script: '/historical-source/project.mjs' }, run }] };
  fs.writeFileSync(path.join(home, 'runtime/adoption-preservation.json'), JSON.stringify(receipt), { mode: 0o600 });
  return { authority, authorityConfig, authorityBytes, receipt, service };
}

function assertContinuingServiceDestination(destination, fixture) {
  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json')));
  const receipt = JSON.parse(fs.readFileSync(path.join(destination, 'runtime/adoption-preservation.json')));
  const service = host.continuationServices[0];
  assert.equal(service.executable, path.join(destination, 'bin/node'));
  assert.equal(service.cwd, path.join(destination, 'app/instances'));
  assert.deepEqual(service.args, [path.join(destination, 'app/instances/project.mjs')]);
  assert.equal(service.env.HOME23_ROOT, path.join(destination, 'app'));
  assert.equal(service.env.API_URL, `http://127.0.0.1:${host.ports.coordination}`);
  assert.equal(service.env.EXTERNAL_ROOT, fixture.authority);
  assert.deepEqual(service.stateRoots, [path.join(destination, 'app/instances'), fixture.authority]);
  assert.deepEqual(host.continuationServices, receipt.continuationServices.map(item => ({ name: item.name, ...item.run })));
  assert.deepEqual(receipt.links, fixture.receipt.links);
  assert.deepEqual(receipt.continuationServices[0].source, fixture.receipt.continuationServices[0].source);
  assert.equal(fs.readFileSync(fixture.authorityConfig, 'utf8'), fixture.authorityBytes);
}

test('move rebinds continuing services while retaining external authority unchanged', async t => {
  const root = tempRoot(t), home = path.join(root, 'home'), destination = path.join(root, 'destination');
  seedRecoverableHome(home);
  const fixture = continuingServiceFixture(home, root);
  const sourceHost = fs.readFileSync(path.join(home, '.home23-host.json'));
  fs.mkdirSync(destination);
  const moved = await moveHome({ sourceHome: home, destinationRoot: destination,
    archivePath: path.join(root, 'backup.h23b'), keyPath: path.join(root, 'backup.key') }, quiet);
  assert.equal(moved.fenced, true);
  assertContinuingServiceDestination(destination, fixture);
  assert.deepEqual(fs.readFileSync(path.join(home, '.home23-host.json')), sourceHost);
});

test('source-absent continuing-service recovery resumes across both binding writes and refuses receipt changes', async t => {
  const root = tempRoot(t), home = path.join(root, 'home'), inspectionRoot = path.join(root, 'inspect');
  const { payload, manifest } = fixturePayload(root);
  seedRecoverableHome(home, { packageId: manifest.packageId, sourceCommit: manifest.sourceCommit });
  const fixture = continuingServiceFixture(home, root);
  const archivePath = path.join(root, 'backup.h23b'), keyPath = path.join(root, 'backup.key');
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  fs.mkdirSync(inspectionRoot);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true });
  const input = { inspectionRoot, payloadPath: payload, archivePath, keyPath };
  await assert.rejects(() => recoverInspectedHome(input, { ...quiet,
    afterHostRebindWrite: () => { throw new Error('interrupt after host'); } }), /interrupt after host/);
  await assert.rejects(() => recoverInspectedHome(input, { ...quiet,
    afterRebound: () => { throw new Error('interrupt after receipt'); } }), /interrupt after receipt/);
  assertContinuingServiceDestination(inspectionRoot, fixture);
  const receiptPath = path.join(inspectionRoot, 'runtime/adoption-preservation.json');
  const boundBytes = fs.readFileSync(receiptPath);
  const changed = JSON.parse(boundBytes);
  changed.continuationServices[0].run.args = ['/unreviewed/script.mjs'];
  fs.writeFileSync(receiptPath, JSON.stringify(changed));
  await assert.rejects(() => recoverInspectedHome(input, quiet), error => error.code === 'backup_recover_archive_mismatch');
  fs.writeFileSync(receiptPath, boundBytes);
  const recovered = await recoverInspectedHome(input, quiet);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.writersStarted, false);
  assertContinuingServiceDestination(inspectionRoot, fixture);
});

test('moveHome and recoverInspectedHome leave only the destination root mode 0700', async t => {
  const moveFixture = stoppedHome(t);
  const birth = path.join(moveFixture.home, 'app/instances/milo/substrate/seed-01');
  fs.mkdirSync(birth, { recursive: true });
  fs.writeFileSync(path.join(birth, 'birth-receipt.json'), '{"seedId":"milo-seed"}\n');
  fs.writeFileSync(path.join(birth, 'seed-ledger.jsonl'), '{"event":"birth"}\n');
  fs.writeFileSync(path.join(moveFixture.home, '.home23-install.json'), '{"schema":"home23.product-install.v1","status":"installed","packageId":"abc","sourceCommit":"123"}\n');
  const moveDestination = path.join(moveFixture.root, 'destination');
  fs.mkdirSync(moveDestination, { mode: 0o755 });
  assert.equal(fs.statSync(moveDestination).mode & 0o777, 0o755);
  await moveHome({
    sourceHome: moveFixture.home,
    destinationRoot: moveDestination,
    archivePath: moveFixture.archivePath,
    keyPath: moveFixture.keyPath,
  }, quiet);
  assert.equal(fs.statSync(moveDestination).mode & 0o777, 0o700);

  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest, nodeMarker } = fixturePayload(root);
  seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  assert.equal(fs.statSync(inspectionRoot).mode & 0o777, 0o755);
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });
  fs.chmodSync(inspectionRoot, 0o755);
  assert.equal(fs.statSync(inspectionRoot).mode & 0o777, 0o755);

  const recovered = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(recovered.ok, true);
  assert.equal(fs.statSync(inspectionRoot).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(inspectionRoot, 'bin/node')).mode & 0o777, 0o755);
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'bin/node'), 'utf8'), nodeMarker);
  assert.equal(fs.statSync(path.join(inspectionRoot, 'manifest.json')).mode & 0o777, 0o644);
});

test('recoverInspectedHome installs a matching payload and status works without the original source', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest, nodeMarker } = fixturePayload(root);
  const { birthBytes, resident } = seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });

  const created = await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  assert.equal(created.packageId, manifest.packageId);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  const header = readAuthenticatedBackupHeader({ archivePath, keyPath });
  assert.equal(header.packageId, manifest.packageId);
  fs.rmSync(home, { recursive: true, force: true });
  assert.equal(fs.existsSync(home), false);
  // The owner's global PM2 daemon still names the gone source home.
  const userHome = path.join(root, 'user');
  fs.mkdirSync(path.join(userHome, '.pm2'), { recursive: true });
  fs.writeFileSync(path.join(userHome, '.pm2/dump.pm2'), JSON.stringify([{ name: 'cosmo-engine', pm_cwd: `${home}/app`, env: { COSMO_CONFIG_PATH: `${home}/app/config/cosmo.yaml` } }]));

  const recovered = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, { ...quiet, detectForeignBindings: options => detectForeignBindings({ ...options, homeDirectory: userHome }) });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.homeRoot, inspectionRoot);
  assert.equal(recovered.sourceHome, home);
  assert.deepEqual(recovered.foreignBindings.roots, [inspectionRoot, home]);
  assert.deepEqual(recovered.foreignBindings.references.map(reference => [reference.name, reference.field, reference.root]),
    [['cosmo-engine', 'pm_cwd', home], ['cosmo-engine', 'env.COSMO_CONFIG_PATH', home]]);
  assert.equal(recovered.warnings.length, 1);
  assert.match(recovered.warnings[0], /PM2 app "cosmo-engine"/);
  assert.equal(recovered.packageId, manifest.packageId);
  assert.equal(recovered.archiveBound, true);
  assert.equal(recovered.writersStarted, false);
  assert.equal(recovered.birthInvoked, false);
  assert.equal(recovered.desiredRunning, false);

  const host = JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8'));
  assert.equal(host.homeRoot, inspectionRoot);
  assert.equal(host.desiredRunning, false);
  assert.equal(host.phase, 'stopped');
  assert.equal(host.profile.name, resident);
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'bin/node'), 'utf8'), nodeMarker);
  assert.equal(
    fs.readFileSync(path.join(inspectionRoot, `app/instances/${resident}/substrate/seed-01/birth-receipt.json`), 'utf8'),
    birthBytes,
  );

  const journal = JSON.parse(fs.readFileSync(path.join(root, `.inspect.home23-recover`, 'journal.json'), 'utf8'));
  assert.equal(journal.schema, 'home23.recover-journal.v1');
  assert.equal(journal.phase, 'committed');
  assert.equal(journal.sourceHome, home);
  assert.equal(journal.packageId, manifest.packageId);
  assert.equal(journal.filesDigest, recovered.filesDigest);

  const status = await runHostAction('status', { homeRoot: inspectionRoot });
  assert.equal(status.ok, true);
  assert.equal(status.status, 'stopped');
  assert.equal(status.profile.name, resident);
  assert.equal(status.desiredRunning, false);
});

test('recoverInspectedHome refuses a running installed destination without changing it', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'live-home');
  const { payload, manifest } = fixturePayload(root);
  seedRecoverableHome(home, { packageId: manifest.packageId, sourceCommit: manifest.sourceCommit });
  for (const [relative, contents] of Object.entries({
    'bin/node': '#!/bin/sh\n# live-node\n',
    'tools/node_modules/pm2/bin/pm2': 'pm2\n',
  })) {
    const file = path.join(home, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  const hostPath = path.join(home, '.home23-host.json');
  const markerPath = path.join(home, 'app/instances/ada/workspace/note.txt');
  const beforeHost = fs.readFileSync(hostPath);
  const beforeMarker = fs.readFileSync(markerPath);
  const beforeInstall = fs.readFileSync(path.join(home, '.home23-install.json'));

  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'other.h23b');
  const keyPath = path.join(out, 'other.backup-key.json');
  const other = path.join(root, 'other-home');
  seedRecoverableHome(other, {
    resident: 'ada', note: 'other\n', packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  await createHomeBackup({ homeRoot: other, archivePath, keyPath }, quiet);

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot: home, payloadPath: payload, archivePath, keyPath,
    }, {
      listProcesses: async () => [{ name: 'home23-ada', status: 'online' }],
    }),
    error => error.code === 'writers_active' || error.code === 'backup_recover_destination_refused',
  );
  assert.equal(fs.readFileSync(hostPath).equals(beforeHost), true);
  assert.equal(fs.readFileSync(markerPath).equals(beforeMarker), true);
  assert.equal(fs.readFileSync(path.join(home, '.home23-install.json')).equals(beforeInstall), true);
  assert.equal(fs.existsSync(path.join(root, `.live-home.home23-recover`, 'journal.json')), false);
});

test('recoverInspectedHome refuses archive B for archive A extract when package ids match', async t => {
  const root = tempRoot(t);
  const { payload, manifest } = fixturePayload(root);
  const homeA = path.join(root, 'home-a');
  const homeB = path.join(root, 'home-b');
  seedRecoverableHome(homeA, {
    note: 'archive-a-only\n', packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  seedRecoverableHome(homeB, {
    note: 'archive-b-only\n', packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archiveA = path.join(out, 'a.h23b');
  const keyA = path.join(out, 'a.backup-key.json');
  const archiveB = path.join(out, 'b.h23b');
  const keyB = path.join(out, 'b.backup-key.json');
  await createHomeBackup({ homeRoot: homeA, archivePath: archiveA, keyPath: keyA }, quiet);
  await createHomeBackup({ homeRoot: homeB, archivePath: archiveB, keyPath: keyB }, quiet);
  const headerA = readAuthenticatedBackupHeader({ archivePath: archiveA, keyPath: keyA });
  const headerB = readAuthenticatedBackupHeader({ archivePath: archiveB, keyPath: keyB });
  assert.equal(headerA.packageId, headerB.packageId);
  assert.notEqual(headerA.homeRoot, headerB.homeRoot);
  assert.notEqual(
    createHash('sha256').update(JSON.stringify(headerA.files)).digest('hex'),
    createHash('sha256').update(JSON.stringify(headerB.files)).digest('hex'),
  );

  const inspectionRoot = path.join(root, 'inspect-a');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await inspectHomeBackup({ archivePath: archiveA, keyPath: keyA, inspectionRoot });
  const beforeNote = fs.readFileSync(path.join(inspectionRoot, 'app/instances/ada/workspace/note.txt'));
  const beforeHost = fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'));

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath: archiveB, keyPath: keyB,
    }, quiet),
    error => error.code === 'backup_recover_archive_mismatch',
  );
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'app/instances/ada/workspace/note.txt')).equals(beforeNote), true);
  assert.equal(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json')).equals(beforeHost), true);
  assert.equal(fs.existsSync(path.join(inspectionRoot, 'bin/node')), false);
  assert.equal(fs.existsSync(path.join(root, `.inspect-a.home23-recover`, 'journal.json')), false);
});

test('recoverInspectedHome retry keeps the same archive binding', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest } = fixturePayload(root);
  seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
    residentMap: { ada: { role: 'primary' } },
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });

  const first = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(first.ok, true);
  assert.equal(first.archiveBound, true);
  assert.equal(first.birthInvoked, false);
  const journalPath = path.join(root, `.inspect.home23-recover`, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.phase, 'committed');
  assert.equal(journal.filesDigest, first.filesDigest);
  const hostAfterFirst = JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8'));
  const portsAfterFirst = hostAfterFirst.ports;
  // residentMap remains the durable identity; recovery must not invent birth.
  assert.equal(hostAfterFirst.residentMap.ada.role, 'primary');
  assert.equal(first.birthInvoked, false);

  // Interrupted-style resume: strip profile.name and keep only residentMap before retry.
  delete hostAfterFirst.profile;
  fs.writeFileSync(path.join(inspectionRoot, '.home23-host.json'), JSON.stringify(hostAfterFirst), { mode: 0o600 });

  const second = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(second.ok, true);
  assert.equal(second.filesDigest, first.filesDigest);
  assert.equal(second.birthInvoked, false);
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).filesDigest, first.filesDigest);
  const hostAfterSecond = JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8'));
  assert.equal(hostAfterSecond.profile, undefined);
  assert.deepEqual(hostAfterSecond.ports, portsAfterFirst);

  const homeB = path.join(root, 'home-b');
  seedRecoverableHome(homeB, {
    note: 'other-archive\n', packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const archiveB = path.join(out, 'b.h23b');
  const keyB = path.join(out, 'b.backup-key.json');
  await createHomeBackup({ homeRoot: homeB, archivePath: archiveB, keyPath: keyB }, quiet);
  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath: archiveB, keyPath: keyB,
    }, quiet),
    error => error.code === 'backup_recover_archive_mismatch',
  );
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).filesDigest, first.filesDigest);
});

test('recoverInspectedHome refuses claimed retry after Seed changes', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest } = fixturePayload(root);
  const { resident } = seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });

  const badPayload = path.join(root, 'bad-payload');
  fs.mkdirSync(badPayload, { mode: 0o755 });
  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: badPayload, archivePath, keyPath,
    }, quiet),
    error => error.code === 'backup_recover_payload_invalid',
  );
  assert.equal(fs.existsSync(path.join(root, `.inspect.home23-recover`, 'journal.json')), false);

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, {
      ...quiet,
      afterClaim: destination => {
        fs.writeFileSync(
          path.join(destination, `app/instances/${resident}/substrate/seed-01/birth-receipt.json`),
          '{"seedId":"tampered"}\n',
        );
        throw Object.assign(new Error('interrupted after claim'), { code: 'recover_interrupted' });
      },
    }),
    error => error.code === 'recover_interrupted',
  );
  const journalPath = path.join(root, `.inspect.home23-recover`, 'journal.json');
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase, 'claimed');

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, quiet),
    error => error.code === 'backup_recover_archive_mismatch',
  );
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase, 'claimed');
  assert.equal(fs.existsSync(path.join(inspectionRoot, 'bin/node')), false);
});

test('recoverInspectedHome resumes a legitimate interrupted recovery after rebind', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest, nodeMarker } = fixturePayload(root);
  const { birthBytes, resident } = seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const originalSource = path.join(home, `app/instances/${resident}/workspace/events.jsonl`);
  seedCursor(home, originalSource, 981, undefined, { marker: 'archive-bound' }, resident);
  seedCursor(home, originalSource, 765, undefined, { legacyResident: true }, 'clay', 'seed-01');
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, {
      ...quiet,
      afterRebound: () => {
        throw Object.assign(new Error('interrupted after rebind'), { code: 'recover_interrupted' });
      },
    }),
    error => error.code === 'recover_interrupted',
  );
  const journalPath = path.join(root, `.inspect.home23-recover`, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.phase, 'rebound');
  const hostAfterInterrupt = JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8'));
  assert.equal(hostAfterInterrupt.homeRoot, inspectionRoot);
  assert.equal(hostAfterInterrupt.phase, 'stopped');
  const mappedSource = path.join(inspectionRoot, `app/instances/${resident}/workspace/events.jsonl`);
  const mappedCursor = path.join(inspectionRoot, `app/instances/${resident}/substrate/seed-01/adapter-cursor.${cursorId(mappedSource)}.json`);
  assert.equal(fs.existsSync(mappedCursor), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(mappedCursor, 'utf8')), {
    schema: 'home23.seed.adapter-cursor.v1', sourcePath: mappedSource, offset: 981, marker: 'archive-bound',
  });
  const legacyCursor = path.join(inspectionRoot, `app/instances/clay/seed-01/adapter-cursor.${cursorId(mappedSource)}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(legacyCursor, 'utf8')), {
    schema: 'home23.seed.adapter-cursor.v1', sourcePath: mappedSource, offset: 765, legacyResident: true,
  });
  assert.equal(fs.existsSync(path.join(inspectionRoot, `app/instances/clay/seed-01/adapter-cursor.${cursorId(originalSource)}.json`)), false);
  assert.notEqual(hostAfterInterrupt.ports.coordination, 21089);
  assert.equal(
    fs.readFileSync(path.join(inspectionRoot, `app/instances/${resident}/substrate/seed-01/birth-receipt.json`), 'utf8'),
    birthBytes,
  );

  const resumed = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(resumed.ok, true);
  fs.writeFileSync(mappedCursor, JSON.stringify({ schema: 'home23.seed.adapter-cursor.v1', sourcePath: mappedSource, offset: 0 }));
  await assert.rejects(() => recoverInspectedHome({ inspectionRoot, payloadPath: payload, archivePath, keyPath }, quiet),
    error => error.code === 'backup_recover_archive_mismatch');
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase, 'committed');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8')).ports,
    hostAfterInterrupt.ports,
  );
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'bin/node'), 'utf8'), nodeMarker);
});

test('recoverInspectedHome refuses an unsafe bin symlink and leaves an outside sentinel unchanged', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest } = fixturePayload(root);
  seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { mode: 0o755 });
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched\n');
  fs.symlinkSync(outside, path.join(inspectionRoot, 'bin'));

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, quiet),
    error => error.code === 'backup_recover_unsafe_path',
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched\n');
  assert.equal(fs.readdirSync(outside).join(','), 'sentinel.txt');
  assert.equal(fs.lstatSync(path.join(inspectionRoot, 'bin')).isSymbolicLink(), true);
});

test('recoverInspectedHome accepts an absolute internal symlink rebased by inspect', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest, nodeMarker } = fixturePayload(root);
  const { resident } = seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
    note: 'linked-note\n',
  });
  const note = path.join(home, `app/instances/${resident}/workspace/note.txt`);
  const link = path.join(home, `app/instances/${resident}/workspace/note-link`);
  fs.symlinkSync(note, link);

  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  const restored = fs.readlinkSync(path.join(inspectionRoot, `app/instances/${resident}/workspace/note-link`));
  assert.equal(path.isAbsolute(restored), false);
  assert.equal(
    fs.readFileSync(path.join(inspectionRoot, `app/instances/${resident}/workspace/note-link`), 'utf8'),
    'linked-note\n',
  );
  fs.rmSync(home, { recursive: true, force: true });

  const recovered = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(recovered.ok, true);
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'bin/node'), 'utf8'), nodeMarker);
  assert.equal(
    fs.readFileSync(path.join(inspectionRoot, `app/instances/${resident}/workspace/note-link`), 'utf8'),
    'linked-note\n',
  );
});

test('recoverInspectedHome resumes after interrupt following a real manifest symlink write', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest, nodeMarker, symlinkPath, symlinkTarget } = fixturePayload(root, { withSymlink: true });
  seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });

  let wroteSymlink = false;
  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, {
      ...quiet,
      afterInstalledSymlink: (destination, relative, target) => {
        assert.equal(relative, symlinkPath);
        assert.equal(target, symlinkTarget);
        assert.equal(fs.lstatSync(path.join(destination, relative)).isSymbolicLink(), true);
        wroteSymlink = true;
        throw Object.assign(new Error('interrupted after symlink'), { code: 'recover_interrupted' });
      },
    }),
    error => error.code === 'recover_interrupted',
  );
  assert.equal(wroteSymlink, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, `.inspect.home23-recover`, 'journal.json'), 'utf8')).phase, 'claimed');
  assert.equal(fs.readlinkSync(path.join(inspectionRoot, symlinkPath)), symlinkTarget);

  const outside = path.join(root, 'outside-wrong');
  fs.mkdirSync(outside, { mode: 0o755 });
  const sentinel = path.join(outside, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'keep\n');
  fs.unlinkSync(path.join(inspectionRoot, symlinkPath));
  fs.symlinkSync('not-the-payload-target', path.join(inspectionRoot, symlinkPath));
  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, quiet),
    error => error.code === 'backup_recover_unsafe_path',
  );
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'keep\n');

  fs.unlinkSync(path.join(inspectionRoot, symlinkPath));
  fs.symlinkSync(symlinkTarget, path.join(inspectionRoot, symlinkPath));
  const resumed = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(resumed.ok, true);
  assert.equal(fs.readlinkSync(path.join(inspectionRoot, symlinkPath)), symlinkTarget);
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'bin/node'), 'utf8'), nodeMarker);
});

test('recoverInspectedHome resumes after interrupt on first rebind homeRoot write', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const { payload, manifest, nodeMarker } = fixturePayload(root);
  const { birthBytes, resident } = seedRecoverableHome(home, {
    packageId: manifest.packageId, sourceCommit: manifest.sourceCommit,
  });
  const sourceCursorPath = path.join(home, `app/instances/${resident}/workspace/events.jsonl`);
  seedCursor(home, sourceCursorPath, 4321, undefined, { retry: true }, resident);
  const out = path.join(root, 'out');
  fs.mkdirSync(out, { mode: 0o755 });
  const archivePath = path.join(out, 'home.h23b');
  const keyPath = path.join(out, 'home.backup-key.json');
  const inspectionRoot = path.join(root, 'inspect');
  fs.mkdirSync(inspectionRoot, { mode: 0o755 });
  await createHomeBackup({ homeRoot: home, archivePath, keyPath }, quiet);
  await inspectHomeBackup({ archivePath, keyPath, inspectionRoot });
  fs.rmSync(home, { recursive: true, force: true });

  await assert.rejects(
    () => recoverInspectedHome({
      inspectionRoot, payloadPath: payload, archivePath, keyPath,
    }, {
      ...quiet,
      afterHostRebindWrite: (destination, host) => {
        assert.equal(host.homeRoot, destination);
        const journal = JSON.parse(fs.readFileSync(path.join(root, `.inspect.home23-recover`, 'journal.json'), 'utf8'));
        assert.equal(journal.phase, 'runtime_installed');
        assert.ok(journal.rebindPlan);
        assert.equal(journal.rebindPlan.ports.coordination, host.ports.coordination);
        throw Object.assign(new Error('interrupted after homeRoot write'), { code: 'recover_interrupted' });
      },
    }),
    error => error.code === 'recover_interrupted',
  );
  const journalPath = path.join(root, `.inspect.home23-recover`, 'journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  assert.equal(journal.phase, 'runtime_installed');
  assert.ok(journal.rebindPlan);
  // Emulate interruption after new cursor content is atomically placed but
  // before the old hashed filename is removed.
  const cursorBinding = journal.rebindPlan.cursorBindings[0];
  const mappedCursorSource = path.join(inspectionRoot, `app/instances/${resident}/workspace/events.jsonl`);
  const partialTarget = path.join(inspectionRoot, cursorBinding.nextPath);
  fs.writeFileSync(partialTarget, `${JSON.stringify({ ...JSON.parse(cursorBinding.original), sourcePath: mappedCursorSource })}\n`);
  const staleCursor = path.join(inspectionRoot, cursorBinding.path);
  assert.equal(fs.existsSync(staleCursor), true);
  const hostAfterInterrupt = JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8'));
  assert.equal(hostAfterInterrupt.homeRoot, inspectionRoot);
  assert.equal(hostAfterInterrupt.ports.coordination, journal.rebindPlan.ports.coordination);
  assert.equal(
    fs.readFileSync(path.join(inspectionRoot, `app/instances/${resident}/substrate/seed-01/birth-receipt.json`), 'utf8'),
    birthBytes,
  );

  const resumed = await recoverInspectedHome({
    inspectionRoot, payloadPath: payload, archivePath, keyPath,
  }, quiet);
  assert.equal(resumed.ok, true);
  assert.equal(fs.existsSync(staleCursor), false);
  const mapped = path.join(inspectionRoot, `app/instances/${resident}/workspace/events.jsonl`);
  const cursor = path.join(inspectionRoot, `app/instances/${resident}/substrate/seed-01/adapter-cursor.${cursorId(mapped)}.json`);
  assert.deepEqual(JSON.parse(fs.readFileSync(cursor, 'utf8')),
    { schema: 'home23.seed.adapter-cursor.v1', sourcePath: mapped, offset: 4321, retry: true });
  assert.equal(JSON.parse(fs.readFileSync(journalPath, 'utf8')).phase, 'committed');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(inspectionRoot, '.home23-host.json'), 'utf8')).ports,
    journal.rebindPlan.ports,
  );
  assert.equal(fs.readFileSync(path.join(inspectionRoot, 'bin/node'), 'utf8'), nodeMarker);
});

test('adopted cron prose rewrites only bounded instance paths in agent turns', () => {
  const source = '/old/home';
  const destination = '/new/Continuing Home';
  const jobs = [
    { enabled: false, payload: { kind: 'agentTurn', cwd: `${source}/instances/jerry`,
      message: `Read ${source}/instances/jerry/status.json and write ${source}/instances/workers/run/<ISO-timestamp>.md. Keep /other/home/instances/jerry and X${source}/instances/jerry literal.` } },
    { payload: { kind: 'shell', message: `echo ${source}/instances/jerry` } },
  ];
  rewriteAdoptedCronPromptPaths(jobs, source, destination);
  assert.equal(jobs[0].enabled, false);
  assert.equal(jobs[0].payload.cwd, `${source}/instances/jerry`);
  assert.equal(jobs[0].payload.message,
    `Read ${destination}/app/instances/jerry/status.json and write ${destination}/app/instances/workers/run/<ISO-timestamp>.md. Keep /other/home/instances/jerry and X${source}/instances/jerry literal.`);
  assert.equal(jobs[1].payload.message, `echo ${source}/instances/jerry`);
});

test('rebindAdoptedHome rewrites from destination hostRoot when the source directory is gone', async t => {
  const root = tempRoot(t);
  const gone = path.join(root, 'original-home');
  const destination = path.join(root, 'destination');
  assert.equal(fs.existsSync(gone), false);
  fs.mkdirSync(path.join(destination, 'app/config'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(destination, 'app/instances/ada'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(destination, 'app/instances/zed'), { recursive: true, mode: 0o755 });
  const directInstanceFile = path.join(destination, 'app/instances/observatory-deadman.log');
  fs.writeFileSync(directInstanceFile, 'preserved direct instance file\n');
  fs.writeFileSync(path.join(destination, '.home23-host.json'), JSON.stringify({
    schema: 'home23.host.v2',
    homeRoot: gone,
    profile: { name: 'ada', provider: 'ollama-local', model: 'fixture' },
    desiredRunning: false,
    phase: 'prepared',
    encoderRequired: false,
    ports: {
      coordination: 22000, engine: 22001, dashboard: 22002, mcp: 22003, bridge: 22004, embedder: 22005,
    },
    residentMap: { ada: { role: 'primary' }, zed: { role: 'secondary' } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'app/config/home.yaml'), [
    'home:',
    '  primaryAgent: ada',
    'shell:',
    '  roots:',
    `    - ${gone}/app/instances/ada`,
    '',
  ].join('\n'), { mode: 0o600 });
  fs.writeFileSync(path.join(destination, 'app/config/cron-jobs.json'), JSON.stringify([{
    id: 'future-agent-turn', enabled: false,
    payload: { kind: 'agentTurn', cwd: `${gone}/instances/ada`,
      message: `Read ${gone}/instances/ada/workspace/status.json and stop.` },
  }]), { mode: 0o600 });
  for (const name of ['ada', 'zed']) {
    fs.writeFileSync(path.join(destination, `app/instances/${name}/config.yaml`), [
      'agent:',
      `  name: ${name}`,
      'ports:',
      '  engine: 22001',
      '  dashboard: 22002',
      '  mcp: 22003',
      '  bridge: 22004',
      'paths:',
      `  root: ${gone}/app/instances/${name}`,
      '',
    ].join('\n'), { mode: 0o600 });
  }

  const adoptedSource = path.join(gone, 'instances/ada/harness-events.jsonl');
  const oldCursor = seedCursor(destination, adoptedSource, 645, undefined, { phase: 'durable' }, 'ada');
  const legacyCursor = seedCursor(destination, adoptedSource, 543, undefined, { continued: true }, 'clay', 'seed-01');
  const externalAuthority = path.join(root, 'retained-external.jsonl');
  const externalCursor = seedCursor(destination, externalAuthority, 99, 'relationship-ledger', { retained: true }, 'ada');
  const externalBytes = fs.readFileSync(externalCursor);

  const packageId = await rebindAdoptedHome(gone, destination);
  assert.equal(packageId, null);
  assert.equal(fs.readFileSync(directInstanceFile, 'utf8'), 'preserved direct instance file\n');
  assert.equal(fs.existsSync(gone), false);
  assert.equal(fs.existsSync(path.join(destination, '.home23-install.json')), false);
  assert.equal(fs.existsSync(path.join(gone, '.home23-install.json')), false);
  const adoptedPath = path.join(destination, 'app/instances/ada/harness-events.jsonl');
  assert.equal(fs.existsSync(oldCursor), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination,
    `app/instances/ada/substrate/seed-01/adapter-cursor.${cursorId(adoptedPath)}.json`), 'utf8')),
  { schema: 'home23.seed.adapter-cursor.v1', sourcePath: adoptedPath, offset: 645, phase: 'durable' });
  assert.equal(fs.existsSync(legacyCursor), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(destination,
    `app/instances/clay/seed-01/adapter-cursor.${cursorId(adoptedPath)}.json`), 'utf8')),
  { schema: 'home23.seed.adapter-cursor.v1', sourcePath: adoptedPath, offset: 543, continued: true });
  assert.equal(fs.readFileSync(externalCursor).equals(externalBytes), true);

  const host = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(host.homeRoot, destination);
  assert.equal(host.desiredRunning, false);
  assert.notEqual(host.residentMap.ada.ports.engine, host.residentMap.zed.ports.engine);

  const { default: yaml } = await import('js-yaml');
  const homeYaml = yaml.load(fs.readFileSync(path.join(destination, 'app/config/home.yaml'), 'utf8'));
  assert.equal(homeYaml.shell.roots[0], `${destination}/app/instances/ada`);
  assert.equal(JSON.stringify(homeYaml).includes(gone), false);
  const cronJobs = JSON.parse(fs.readFileSync(path.join(destination, 'app/config/cron-jobs.json'), 'utf8'));
  assert.equal(cronJobs[0].enabled, false);
  assert.equal(cronJobs[0].payload.cwd, `${destination}/app/instances/ada`);
  assert.equal(cronJobs[0].payload.message,
    `Read ${destination}/app/instances/ada/workspace/status.json and stop.`);
  const ada = yaml.load(fs.readFileSync(path.join(destination, 'app/instances/ada/config.yaml'), 'utf8'));
  const zed = yaml.load(fs.readFileSync(path.join(destination, 'app/instances/zed/config.yaml'), 'utf8'));
  assert.equal(ada.ports.engine, host.residentMap.ada.ports.engine);
  assert.equal(zed.ports.engine, host.residentMap.zed.ports.engine);
  assert.equal(ada.paths.root, `${destination}/app/instances/ada`);
  assert.equal(zed.paths.root, `${destination}/app/instances/zed`);
});

test('cursor rebind refuses colliding, malformed, or symlinked state before changing host binding', async t => {
  for (const kind of ['collision', 'malformed', 'symlink']) {
    await t.test(kind, async subtest => {
      const fixture = stoppedHome(subtest);
      const gone = path.join(fixture.root, 'old-home');
      const hostPath = path.join(fixture.home, '.home23-host.json');
      const host = JSON.parse(fs.readFileSync(hostPath, 'utf8'));
      host.homeRoot = gone;
      fs.writeFileSync(hostPath, JSON.stringify(host));
      const before = fs.readFileSync(hostPath);
      const first = seedCursor(fixture.home, path.join(gone, 'app/instances/milo/harness.jsonl'), 80);
      if (kind === 'collision') seedCursor(fixture.home, path.join(gone, 'instances/milo/harness.jsonl'), 90);
      if (kind === 'malformed') fs.writeFileSync(first, '{"sourcePath":"bad","offset":0}');
      if (kind === 'symlink') {
        const outside = path.join(fixture.root, 'outside-cursor');
        fs.writeFileSync(outside, fs.readFileSync(first));
        fs.unlinkSync(first);
        fs.symlinkSync(outside, first);
      }
      await assert.rejects(() => rebindAdoptedHome(gone, fixture.home));
      assert.equal(fs.readFileSync(hostPath).equals(before), true);
    });
  }
});
