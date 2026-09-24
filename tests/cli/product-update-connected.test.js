import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { installProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import {
  downloadDevelopmentRelease,
  downloadReleaseArchive,
  extractProductArchive,
  selectStagedInstall,
} from '../../cli/lib/product-update-feed.js';
import { applyProductUpdate, retainedUpdateController } from '../../cli/lib/product-update-apply.js';
import { privateJSON } from '../../cli/lib/product-environment.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostEntry = path.join(rootDir, 'scripts/product/host.mjs');
const nodeBin = process.execPath;

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-connected-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function payload(dir, { sourceCommit = 'a'.repeat(40) } = {}) {
  const files = {
    'bin/node': '#!/bin/sh\n',
    'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n',
    'app/scripts/product/host.mjs': 'export {};\n',
    'tools/node_modules/pm2/bin/pm2': 'pm2\n',
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(dir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  return writeProductManifest(dir, {
    sourceCommit,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: 'v22.19.0',
  });
}

function writeFeed(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
}

function developmentKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

function rawPublicKeyBase64(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return Buffer.from(jwk.x, 'base64url').toString('base64');
}

function writeTrustKey(file, publicKey) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    schema: 'home23.release-trust.v1',
    algorithm: 'ed25519',
    trust: 'development',
    publicKey: rawPublicKeyBase64(publicKey),
  }, null, 2) + '\n', { mode: 0o600 });
}

function signPackageId(packageId, privateKey) {
  return crypto.sign(null, Buffer.from(packageId), privateKey).toString('base64');
}

function runHost(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeBin, [hostEntry, ...args], { cwd: rootDir });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

function listenLoopbackArchive(t, handler) {
  const server = http.createServer(handler);
  t.after(() => new Promise(resolve => server.close(() => resolve())));
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, origin: `http://127.0.0.1:${port}` });
    });
    server.on('error', reject);
  });
}

function packPayloadArchive(artifactDir, archivePath) {
  execFileSync('tar', ['--format=ustar', '-cf', archivePath, '-C', artifactDir, '.'], {
    stdio: 'pipe',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return crypto.createHash('sha256').update(fs.readFileSync(archivePath)).digest('hex');
}

test('install-staged accepts --admit argv and rejects admit on other actions', async t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  privateJSON(`${staging}.home23-stage.json`, {
    schema: 'home23.product-stage.v1',
    homeRoot: home,
    staging,
    currentPackageId: 'a'.repeat(64),
    candidatePackageId: 'b'.repeat(64),
    candidateSourceCommit: 'c'.repeat(40),
    id: crypto.randomUUID(),
    status: 'copying',
  });

  const admitted = await runHost(['install-staged', '--home', home, '--staging', staging, '--admit']);
  const body = JSON.parse(admitted.stdout);
  assert.equal(admitted.code, 1);
  assert.equal(body.status, 'copying');
  assert.equal(body.selected, false);

  const feed = path.join(root, 'feed.json');
  writeFeed(feed, { schema: 'home23.release-feed.v1', channel: 'development', publisherTrust: 'unverified', releases: [] });
  const refused = await runHost(['check-update', '--home', home, '--feed', feed, '--admit']);
  const refusedBody = JSON.parse(refused.stdout);
  assert.equal(refused.code, 1);
  assert.equal(refusedBody.ok, false);
  assert.match(refusedBody.error?.message || '', /Usage:/);
});

test('busy inventory without admit does not apply', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { SUPPORTED_COORDINATION_SCHEMAS } = await import('../../cli/lib/product-update-inventory.js');
  const supported = SUPPORTED_COORDINATION_SCHEMAS[20];
  const root = tempRoot(t);
  const current = path.join(root, 'current');
  const candidate = path.join(root, 'candidate');
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  function richPayload(dir, sourceCommit, extra = {}) {
    const files = {
      'bin/node': '#!/bin/sh\n',
      'app/cli/home23.js': 'export {};\n',
      'app/cli/lib/product-payload.js': 'export {};\n',
      'app/scripts/product/host.mjs': 'export {};\n',
      'tools/node_modules/pm2/bin/pm2': 'pm2\n',
      'app/dist/coordination/migrations/index.js': 'migration-index\n',
      'app/dist/coordination/migrations/0001-coordination-spine.js': 'migration-one\n',
      'app/dist/coordination/contracts/v1/pack-manifest.json': '{}\n',
      'app/dist/coordination/contracts/v1/schema.json': '{}\n',
      'app/engine/data/images/.gitkeep': '',
      ...extra,
    };
    for (const [relative, contents] of Object.entries(files)) {
      const file = path.join(dir, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
      fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
    }
    fs.mkdirSync(path.join(dir, 'app/config'), { recursive: true, mode: 0o755 });
    return writeProductManifest(dir, {
      sourceCommit,
      platform: process.platform,
      arch: process.arch,
      nodeVersion: 'v22.19.0',
    });
  }
  richPayload(current, 'a'.repeat(40));
  richPayload(candidate, 'b'.repeat(40), { 'app/cli/lib/update-marker.txt': 'schema-preserving-apply\n' });
  installProductPayload({ payloadPath: current, homeRoot: home });
  fs.mkdirSync(path.join(home, 'app/config'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/config/home.yaml'), 'name: milo\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'app/config/secrets.yaml'), 'providers: {}\n', { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'app/instances/milo/conversations'), { recursive: true });
  fs.mkdirSync(path.join(home, 'app/instances/milo/brain'), { recursive: true });
  fs.writeFileSync(path.join(home, 'app/instances/milo/conversations/session.txt'), 'hello-milo');
  fs.writeFileSync(path.join(home, 'app/instances/milo/brain/event-ledger.jsonl'), '{"id":"seed-1"}\n');
  const dbFile = path.join(home, 'app/instances/.house/coordination/home23-coordination.sqlite3');
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  db.exec(`PRAGMA user_version = 20;
    CREATE TABLE schema_migrations (version INTEGER, name TEXT, checksum TEXT, applied_at TEXT, application_version TEXT);
    INSERT INTO schema_migrations VALUES (20, 'chess-engines', '${supported.migrationChecksum}', 't', 'test');
    CREATE TABLE kernel_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
    INSERT INTO kernel_meta VALUES ('schema.checksum', '${supported.schemaChecksum}', 't');
    INSERT INTO kernel_meta VALUES ('schema.version', '20', 't');
    CREATE TABLE kept (value TEXT);
    INSERT INTO kept VALUES ('same-home');`);
  db.close();
  fs.writeFileSync(path.join(home, '.home23-host.json'), JSON.stringify({
    schema: 'home23.host.v2',
    homeRoot: home,
    profile: { name: 'milo', provider: 'ollama-local', model: 'fixture' },
    desiredRunning: true,
    encoderRequired: true,
    phase: 'prepared',
  }), { mode: 0o600 });

  const deferred = await applyProductUpdate({
    homeRoot: home,
    candidatePayload: candidate,
    staging,
  }, {
    listProcesses: async () => [{ name: 'home23-milo', status: 'online' }],
    quiesce: async () => { throw new Error('quiesce must not run without admit'); },
  });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.admission, 'wait');
  assert.equal(fs.existsSync(retainedUpdateController(home).updateDirectory), false);
});

test('connected loopback archive download extracts, stages, and retains development trust', async t => {
  const root = tempRoot(t);
  const source = path.join(root, 'installed-source');
  const artifact = path.join(root, 'artifact');
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  payload(source, { sourceCommit: 'a'.repeat(40) });
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  installProductPayload({ payloadPath: source, homeRoot: home });

  const archivePath = path.join(root, 'release.bin');
  const sha256 = packPayloadArchive(artifact, archivePath);
  const body = fs.readFileSync(archivePath);
  const { origin } = await listenLoopbackArchive(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });

  const { publicKey, privateKey } = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, {
    schema: 'home23.release-feed.v1',
    channel: 'development',
    publisherTrust: 'development',
    releases: [{
      version: '1.2.3',
      packageId: manifest.packageId,
      sourceCommit: manifest.sourceCommit,
      platform: process.platform,
      arch: process.arch,
      minimumOs: '14.0',
      notes: 'Connected archive fixture',
      compatibility: {
        installationSchema: 'home23.product-install.v1',
        coordinationSchema: 20,
        stateMigration: 'schema_preserving_only',
      },
      artifact: {
        kind: 'local-archive',
        url: `${origin}/payload.bin`,
        sha256,
      },
      trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, privateKey) },
    }],
  });

  const result = await downloadDevelopmentRelease({
    homeRoot: home,
    feedPath,
    trustKeyPath,
    staging,
  });
  assert.equal(result.status, 'staged');
  assert.equal(result.publisherTrust, 'development');
  assert.equal(result.developmentSignatureVerified, true);
  assert.equal(result.canInstall, false);
  assert.equal(result.homeMutated, false);
  assert.ok(fs.existsSync(path.join(staging, 'payload', 'manifest.json')));

  const claimOnly = selectStagedInstall({ staging });
  assert.equal(claimOnly.selected, true);
  assert.equal(claimOnly.publisherTrust, 'unverified');
  assert.equal(claimOnly.developmentSignatureVerified, false);
  const selected = selectStagedInstall({ staging, trustKeyPath });
  assert.equal(selected.selected, true);
  assert.equal(selected.publisherTrust, 'development');
  assert.equal(selected.developmentSignatureVerified, true);
  assert.equal(selected.canInstall, false);
  const claimPath = `${staging}.home23-stage.json`;
  const forged = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  forged.developmentSignature = Buffer.from('forged').toString('base64');
  forged.publisherTrust = 'development';
  forged.developmentSignatureVerified = true;
  fs.writeFileSync(claimPath, `${JSON.stringify(forged)}\n`, { mode: 0o600 });
  const forgedSelection = selectStagedInstall({ staging, trustKeyPath });
  assert.equal(forgedSelection.publisherTrust, 'unverified');
  assert.equal(forgedSelection.developmentSignatureVerified, false);
});

test('digest match without development signature does not stage', async t => {
  const root = tempRoot(t);
  const source = path.join(root, 'installed-source');
  const artifact = path.join(root, 'artifact');
  const home = path.join(root, 'home');
  const staging = path.join(root, 'staging');
  payload(source, { sourceCommit: 'a'.repeat(40) });
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  installProductPayload({ payloadPath: source, homeRoot: home });
  const archivePath = path.join(root, 'release.bin');
  const sha256 = packPayloadArchive(artifact, archivePath);
  const body = fs.readFileSync(archivePath);
  const { origin } = await listenLoopbackArchive(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  const { publicKey } = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, {
    schema: 'home23.release-feed.v1',
    channel: 'development',
    publisherTrust: 'development',
    releases: [{
      version: '1.2.3',
      packageId: manifest.packageId,
      sourceCommit: manifest.sourceCommit,
      platform: process.platform,
      arch: process.arch,
      minimumOs: '14.0',
      notes: 'Unsigned archive',
      compatibility: {
        installationSchema: 'home23.product-install.v1',
        coordinationSchema: 20,
        stateMigration: 'schema_preserving_only',
      },
      artifact: {
        kind: 'local-archive',
        url: `${origin}/payload.bin`,
        sha256,
      },
    }],
  });
  await assert.rejects(
    () => downloadDevelopmentRelease({ homeRoot: home, feedPath, trustKeyPath, staging }),
    error => error.code === 'signature_invalid',
  );
  assert.equal(fs.existsSync(path.join(staging, 'payload')), false);
});

test('extractProductArchive rejects path escape and accepts relative payload files', t => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const goodArchive = path.join(root, 'good.bin');
  packPayloadArchive(artifact, goodArchive);
  const dest = path.join(root, 'out');
  const extracted = extractProductArchive({ archivePath: goodArchive, destinationDirectory: dest });
  assert.equal(extracted.ok, true);
  assert.ok(fs.existsSync(path.join(dest, 'manifest.json')));

  const escapeArchive = path.join(root, 'escape.bin');
  const name = Buffer.alloc(100, 0);
  Buffer.from('../escape.txt').copy(name);
  const header = Buffer.alloc(512, 0);
  name.copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('00000000004\0').copy(header, 124);
  header[156] = 48;
  Buffer.from('ustar\0').copy(header, 257);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  for (let i = 148; i < 156; i += 1) {
    sum -= header[i];
    sum += 32;
  }
  Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);
  const body = Buffer.concat([header, Buffer.from('evil'), Buffer.alloc(512 - 4, 0), Buffer.alloc(1024, 0)]);
  fs.writeFileSync(escapeArchive, body);
  assert.throws(
    () => extractProductArchive({ archivePath: escapeArchive, destinationDirectory: path.join(root, 'escape-out') }),
    error => error.code === 'archive_unsafe',
  );
});

test('extractProductArchive accepts contained parent-relative npm links and rejects escapes', t => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  fs.mkdirSync(path.join(artifact, 'node_modules', '.bin'), { recursive: true });
  fs.mkdirSync(path.join(artifact, 'node_modules', 'tool'));
  fs.writeFileSync(path.join(artifact, 'node_modules', 'tool', 'cli.js'), 'ok\n');
  fs.symlinkSync('../tool/cli.js', path.join(artifact, 'node_modules', '.bin', 'tool'));
  const archive = path.join(root, 'contained.tar');
  packPayloadArchive(artifact, archive);
  const destination = path.join(root, 'contained');
  extractProductArchive({ archivePath: archive, destinationDirectory: destination });
  assert.equal(fs.readlinkSync(path.join(destination, 'node_modules', '.bin', 'tool')), '../tool/cli.js');
  assert.equal(fs.readFileSync(path.join(destination, 'node_modules', '.bin', 'tool'), 'utf8'), 'ok\n');

  fs.unlinkSync(path.join(artifact, 'node_modules', '.bin', 'tool'));
  fs.symlinkSync('../../../escape', path.join(artifact, 'node_modules', '.bin', 'tool'));
  const unsafeArchive = path.join(root, 'escape.tar');
  packPayloadArchive(artifact, unsafeArchive);
  const unsafeDestination = path.join(root, 'unsafe');
  assert.throws(
    () => extractProductArchive({ archivePath: unsafeArchive, destinationDirectory: unsafeDestination }),
    error => error.code === 'archive_unsafe',
  );
  assert.equal(fs.existsSync(path.join(unsafeDestination, 'node_modules', '.bin', 'tool')), false);
});

test('retainedUpdateController exposes journal and recover entry beside the home', t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const controller = retainedUpdateController(home);
  assert.equal(controller.journalPath, path.join(root, '.home.home23-update', 'journal.json'));
  assert.equal(controller.nodePath, path.join(root, '.home.home23-update', 'controller', 'node'));
  assert.equal(
    controller.recoverEntryPath,
    path.join(root, '.home.home23-update', 'controller', 'lib', 'product-update-recover.mjs'),
  );
  assert.ok(!controller.journalPath.startsWith(home + path.sep));
});

test('downloadReleaseArchive still verifies digest before writing payload.bin', async t => {
  const root = tempRoot(t);
  const body = Buffer.from('tiny-connected-fixture\n');
  const expectedSha256 = crypto.createHash('sha256').update(body).digest('hex');
  const { origin } = await listenLoopbackArchive(t, (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length });
    res.end(body);
  });
  const destinationDirectory = path.join(root, 'download');
  const result = await downloadReleaseArchive({
    url: `${origin}/payload.bin`,
    destinationDirectory,
    expectedSha256,
  });
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(result.path).equals(body), true);
});
