import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostEntry = path.join(rootDir, 'scripts/product/host.mjs');
const nodeBin = process.execPath;

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-backup-host-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function quietPm2(home) {
  const pm2 = path.join(home, 'tools/node_modules/pm2/bin/pm2');
  fs.mkdirSync(path.dirname(pm2), { recursive: true, mode: 0o755 });
  fs.writeFileSync(pm2, 'console.log("[]");\n', { mode: 0o644 });
  fs.symlinkSync(nodeBin, path.join(home, 'bin/node'));
}

/** Tiny fixture resident — not Milo. */
function fixtureHome(t, { withSeed = false } = {}) {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const resident = 'ada';
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(home, `app/instances/${resident}/workspace`), { recursive: true, mode: 0o755 });
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(home, `app/instances/${resident}/workspace/note.txt`), 'ada note\n', { mode: 0o644 });
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), 'name: ada\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
    schema: 'home23.host.v2',
    homeRoot: home,
    profile: { name: resident, provider: 'ollama-local', model: 'fixture' },
    desiredRunning: false,
    phase: 'prepared',
  }), { mode: 0o600 });
  quietPm2(home);
  if (withSeed) {
    const seed = path.join(home, `app/instances/${resident}/substrate/seed-01`);
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, 'birth-receipt.json'), '{"seedId":"ada-seed"}\n');
    fs.writeFileSync(path.join(seed, 'seed-ledger.jsonl'), '{"event":"birth"}\n');
    fs.writeFileSync(path.join(home, '.home23-install.json'), JSON.stringify({
      schema: 'home23.product-install.v1',
      status: 'installed',
      packageId: 'abc',
      sourceCommit: 'a'.repeat(40),
    }), { mode: 0o600 });
  }
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

function runHost(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [hostEntry, ...args], { cwd: rootDir, env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

test('host backup writes archive and separate recovery key without starting writers', async t => {
  const fixture = fixtureHome(t);
  const result = await runHost([
    'backup', '--home', fixture.home, '--archive', fixture.archivePath, '--key', fixture.keyPath,
  ]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 0);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'backed-up');
  assert.equal(body.resultKind, 'command');
  assert.equal(body.installedUiProof, false);
  assert.equal(body.publisherTrust, 'local');
  assert.equal(body.publicTrust, false);
  assert.equal(body.writersStarted, false);
  assert.equal(body.keyIsRecoveryMaterial, true);
  assert.equal(body.keyOutsideArchive, true);
  assert.match(body.ownerMessage, /recovery material kept outside the archive/i);
  assert.match(body.ownerMessage, /command result, not an installed-UI proof/i);
  assert.match(body.ownerMessage, /Local trust is not public trust/i);
  assert.equal(fs.existsSync(fixture.archivePath), true);
  assert.equal(fs.existsSync(fixture.keyPath), true);
  const key = JSON.parse(fs.readFileSync(fixture.keyPath, 'utf8'));
  assert.equal(key.schema, 'home23.backup-key.v1');
  assert.equal(fs.readFileSync(fixture.archivePath).includes(Buffer.from(key.key, 'base64')), false);
});

test('host backup-inspect restores into inspection root and requires reconnect', async t => {
  const fixture = fixtureHome(t);
  await runHost(['backup', '--home', fixture.home, '--archive', fixture.archivePath, '--key', fixture.keyPath]);
  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  const result = await runHost([
    'backup-inspect',
    '--archive', fixture.archivePath,
    '--key', fixture.keyPath,
    '--inspection', fixture.inspectionRoot,
  ]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 0);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'inspected');
  assert.equal(body.resultKind, 'command');
  assert.equal(body.installedUiProof, false);
  assert.equal(body.restoredRunning, false);
  assert.equal(body.writersStarted, false);
  assert.equal(body.publisherTrust, 'local');
  assert.match(body.ownerMessage, /Reconnect is required for ports and machine paths/i);
  assert.match(body.ownerMessage, /not already running/i);
  assert.match(body.ownerMessage, /command result, not an installed-UI proof/i);
  assert.deepEqual(body.reconnects[0], {
    kind: 'machine-bindings',
    required: true,
    message: 'Ports, supervisor registration, and absolute machine paths have to be rebound before this home runs.',
  });
  assert.equal(
    fs.readFileSync(path.join(fixture.inspectionRoot, 'app/instances/ada/workspace/note.txt'), 'utf8'),
    'ada note\n',
  );
});

test('host move fences source and leaves destination stopped via command path', async t => {
  const fixture = fixtureHome(t, { withSeed: true });
  const destination = path.join(fixture.root, 'destination');
  fs.mkdirSync(destination, { mode: 0o755 });
  // A synthetic user home whose global PM2 daemon still names the source; the command runs with HOME pointed there.
  const userHome = path.join(fixture.root, 'user');
  const dump = path.join(userHome, '.pm2/dump.pm2');
  fs.mkdirSync(path.dirname(dump), { recursive: true });
  fs.writeFileSync(dump, JSON.stringify([{ name: 'cosmo-engine', pm_cwd: `${fixture.home}/app`, env: { HOME23_ROOT: `${fixture.home}/app` } }]));
  const dumpBefore = fs.readFileSync(dump);
  const result = await runHost([
    'move',
    '--home', fixture.home,
    '--destination', destination,
    '--archive', fixture.archivePath,
    '--key', fixture.keyPath,
  ], { HOME: userHome, PM2_HOME: undefined });
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(body.ok, true);
  assert.equal(body.status, 'moved');
  assert.deepEqual(body.foreignBindings.roots, [destination, fixture.home]);
  assert.deepEqual(body.foreignBindings.references.map(reference => [reference.name, reference.field]), [['cosmo-engine', 'pm_cwd'], ['cosmo-engine', 'env.HOME23_ROOT']]);
  assert.equal(body.warnings.length, 1);
  assert.match(body.warnings[0], /PM2 app "cosmo-engine"/);
  assert.match(body.ownerMessage, /1 other supervisor registration on this Mac still name the home; Home23 did not change them/);
  assert.deepEqual(fs.readFileSync(dump), dumpBefore);
  assert.equal(body.resultKind, 'command');
  assert.equal(body.installedUiProof, false);
  assert.equal(body.fenced, true);
  assert.equal(body.destinationStarted, false);
  assert.equal(body.writersStarted, false);
  assert.equal(body.publisherTrust, 'local');
  assert.match(body.ownerMessage, /desired-running remains false/i);
  assert.match(body.ownerMessage, /source stays fenced/i);
  assert.match(body.ownerMessage, /command result, not an installed-UI proof/i);
  const destHost = JSON.parse(fs.readFileSync(path.join(destination, '.home23-host.json'), 'utf8'));
  assert.equal(destHost.desiredRunning, false);
  assert.equal(destHost.homeRoot, destination);
  assert.equal(
    fs.readFileSync(path.join(destination, 'app/instances/ada/substrate/seed-01/birth-receipt.json'), 'utf8'),
    '{"seedId":"ada-seed"}\n',
  );
  assert.equal(fs.existsSync(path.join(fixture.home, 'runtime/home23-move-fence.json')), true);
});

test('host backup-inspect recovers after the source home is gone', async t => {
  const fixture = fixtureHome(t, { withSeed: true });
  const backed = await runHost([
    'backup', '--home', fixture.home, '--archive', fixture.archivePath, '--key', fixture.keyPath,
  ]);
  assert.equal(JSON.parse(backed.stdout).ok, true);
  fs.rmSync(fixture.home, { recursive: true, force: true });
  assert.equal(fs.existsSync(fixture.home), false);

  fs.mkdirSync(fixture.inspectionRoot, { mode: 0o755 });
  const result = await runHost([
    'backup-inspect',
    '--archive', fixture.archivePath,
    '--key', fixture.keyPath,
    '--inspection', fixture.inspectionRoot,
  ]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.equal(fs.existsSync(fixture.home), false);
  assert.equal(body.ok, true);
  assert.equal(body.restoredRunning, false);
  assert.equal(body.writersStarted, false);
  assert.deepEqual(body.reconnects[0], {
    kind: 'machine-bindings',
    required: true,
    message: 'Ports, supervisor registration, and absolute machine paths have to be rebound before this home runs.',
  });
  const restoredHost = JSON.parse(fs.readFileSync(path.join(fixture.inspectionRoot, '.home23-host.json'), 'utf8'));
  assert.equal(restoredHost.profile.name, 'ada');
  assert.equal(restoredHost.desiredRunning, false);
  assert.equal(
    fs.readFileSync(path.join(fixture.inspectionRoot, 'app/instances/ada/substrate/seed-01/birth-receipt.json'), 'utf8'),
    '{"seedId":"ada-seed"}\n',
  );
});

test('host backup refuses missing archive and key flags', async t => {
  const fixture = fixtureHome(t);
  const result = await runHost(['backup', '--home', fixture.home]);
  const body = JSON.parse(result.stdout);
  assert.equal(result.code, 1);
  assert.equal(body.ok, false);
  assert.match(body.error.message, /backup requires --archive and --key/);
});
