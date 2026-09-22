import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import {
  downloadDevelopmentRelease,
  inspectReleaseFeed,
  stageAuthenticatedRelease,
} from '../../cli/lib/product-update-feed.js';

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-feed-')));
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

function writeReceipt(home, packageId) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, '.home23-install.json'), JSON.stringify({
    schema: 'home23.product-install.v1',
    status: 'installed',
    packageId,
  }, null, 2) + '\n', { mode: 0o600 });
}

function releaseFor(artifactPath, manifest, overrides = {}) {
  return {
    version: '1.2.3',
    packageId: manifest.packageId,
    sourceCommit: manifest.sourceCommit,
    platform: process.platform,
    arch: process.arch,
    minimumOs: '14.0',
    notes: 'Fixture release notes',
    compatibility: {
      installationSchema: 'home23.product-install.v1',
      coordinationSchema: 20,
      stateMigration: 'schema_preserving_only',
    },
    artifact: {
      kind: 'local-directory',
      path: artifactPath,
      sha256: manifest.packageId,
    },
    ...overrides,
  };
}

function feedBody(releases, overrides = {}) {
  return {
    schema: 'home23.release-feed.v1',
    channel: 'development',
    publisherTrust: 'unverified',
    releases,
    ...overrides,
  };
}

function snapshotHome(home) {
  if (!fs.existsSync(home)) return null;
  const entries = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(home, relative);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) visit(full, relative);
      else if (stat.isSymbolicLink()) {
        entries.push({ relative, mode: stat.mode & 0o7777, target: fs.readlinkSync(full) });
      } else {
        entries.push({ relative, mode: stat.mode & 0o7777, bytes: fs.readFileSync(full) });
      }
    }
  }
  visit(home);
  return entries;
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

function installedHome(t, commit = 'a'.repeat(40)) {
  const root = tempRoot(t);
  const source = path.join(root, 'installed-source');
  const home = path.join(root, 'home');
  const manifest = payload(source, { sourceCommit: commit });
  installProductPayload({ payloadPath: source, homeRoot: home });
  return { root, home, manifest };
}

function listPayloadFiles(staging) {
  const payloadDir = path.join(staging, 'payload');
  if (!fs.existsSync(staging) && !fs.existsSync(payloadDir)) return [];
  if (!fs.existsSync(payloadDir)) return fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  const entries = [];
  function visit(directory, prefix = '') {
    for (const name of fs.readdirSync(directory).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const full = path.join(directory, relative);
      if (fs.lstatSync(full).isDirectory()) visit(full, relative);
      else entries.push(relative);
    }
  }
  visit(payloadDir);
  return entries;
}

function baseResult(extra = {}) {
  return {
    publisherTrust: 'unverified',
    canInstall: false,
    networkInstall: false,
    distribution: 'local-untrusted',
    ...extra,
  };
}

test('missing or empty feed is unavailable, never current', t => {
  const root = tempRoot(t);
  const missing = inspectReleaseFeed({ homeRoot: path.join(root, 'home'), feedPath: path.join(root, 'missing.json') });
  assert.equal(missing.status, 'unavailable');
  assert.notEqual(missing.status, 'current');
  assert.deepEqual(missing, {
    ...baseResult({
      installedPackageId: null,
      status: 'unavailable',
      reasons: missing.reasons,
    }),
  });
  assert.ok(Array.isArray(missing.reasons) && missing.reasons.length >= 1);
  assert.ok(missing.reasons.every(item => item.code && item.message));
  assert.equal(Object.hasOwn(missing, 'version'), false);

  const emptyPath = path.join(root, 'empty.json');
  writeFeed(emptyPath, feedBody([]));
  const empty = inspectReleaseFeed({ homeRoot: path.join(root, 'home'), feedPath: emptyPath });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.installedPackageId, null);
  assert.equal(Object.hasOwn(empty, 'packageId'), false);
});

test('digest mismatch is damaged without writing the home', t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact);
  writeReceipt(home, 'c'.repeat(64));
  const before = snapshotHome(home);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    artifact: { kind: 'local-directory', path: artifact, sha256: 'd'.repeat(64) },
  })]));
  const result = inspectReleaseFeed({ homeRoot: home, feedPath });
  assert.equal(result.status, 'damaged');
  assert.ok(result.reasons.some(item => item.code === 'digest_mismatch' || item.message.toLowerCase().includes('digest') || item.message.toLowerCase().includes('sha256')));
  assert.equal(result.publisherTrust, 'unverified');
  assert.equal(result.canInstall, false);
  assert.equal(result.networkInstall, false);
  assert.equal(result.distribution, 'local-untrusted');
  assert.equal(result.version, '1.2.3');
  assert.equal(result.packageId, manifest.packageId);
  assert.deepEqual(snapshotHome(home), before);
});

test('wrong platform is incompatible after a valid local artifact', t => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact);
  const otherPlatform = process.platform === 'darwin' ? 'linux' : 'darwin';
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, { platform: otherPlatform })]));
  const result = inspectReleaseFeed({ homeRoot: path.join(root, 'absent-home'), feedPath });
  assert.equal(result.status, 'incompatible');
  assert.equal(result.installedPackageId, null);
  assert.equal(result.platform, otherPlatform);
  assert.equal(result.arch, process.arch);
  assert.equal(result.packageId, manifest.packageId);
  assert.equal(result.canInstall, false);
});

test('matching install receipt is current', t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact);
  writeReceipt(home, manifest.packageId);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest)]));
  const result = inspectReleaseFeed({ homeRoot: home, feedPath });
  assert.equal(result.status, 'current');
  assert.equal(result.installedPackageId, manifest.packageId);
  assert.equal(result.packageId, manifest.packageId);
  assert.equal(result.sourceCommit, manifest.sourceCommit);
  assert.equal(result.notes, 'Fixture release notes');
  assert.equal(result.publisherTrust, 'unverified');
  assert.equal(result.canInstall, false);
});

test('absent home with well-formed release is available', t => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, { version: '9.9.9', notes: 'Newer fixture' })]));
  const result = inspectReleaseFeed({ homeRoot: path.join(root, 'no-home-yet'), feedPath });
  assert.equal(result.status, 'available');
  assert.equal(result.installedPackageId, null);
  assert.equal(result.version, '9.9.9');
  assert.equal(result.packageId, manifest.packageId);
  assert.equal(result.sourceCommit, 'b'.repeat(40));
  assert.equal(result.notes, 'Newer fixture');
  assert.equal(result.platform, process.platform);
  assert.equal(result.arch, process.arch);
  assert.equal(result.networkInstall, false);
  assert.equal(result.distribution, 'local-untrusted');
});

test('inspecting the feed does not change home bytes', t => {
  const root = tempRoot(t);
  const home = path.join(root, 'home');
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact);
  writeReceipt(home, 'e'.repeat(64));
  fs.writeFileSync(path.join(home, 'marker.txt'), 'leave-me', { mode: 0o600 });
  const before = snapshotHome(home);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest)]));
  const result = inspectReleaseFeed({ homeRoot: home, feedPath });
  assert.equal(result.status, 'available');
  assert.equal(result.installedPackageId, 'e'.repeat(64));
  assert.deepEqual(snapshotHome(home), before);
});

test('development signature stages a fixture payload without mutating the home', t => {
  const { root, home } = installedHome(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const { publicKey, privateKey } = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, privateKey) },
  })], { publisherTrust: 'development' }));
  const staging = path.join(root, 'staging');
  const before = snapshotHome(home);
  const result = stageAuthenticatedRelease({ homeRoot: home, feedPath, staging, trustKeyPath });
  assert.deepEqual(result, {
    ok: true,
    status: 'staged',
    packageId: manifest.packageId,
    publisherTrust: 'development',
    canInstall: false,
    networkInstall: false,
    homeMutated: false,
  });
  assert.equal(result.canInstall, false);
  assert.ok(fs.existsSync(path.join(staging, 'payload', 'manifest.json')));
  assert.deepEqual(snapshotHome(home), before);
});

test('bad development signature creates no staged payload files', t => {
  const { root, home } = installedHome(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const { publicKey, privateKey } = developmentKeyPair();
  const other = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, other.privateKey) },
  })], { publisherTrust: 'development' }));
  const staging = path.join(root, 'staging');
  const before = snapshotHome(home);
  assert.throws(
    () => stageAuthenticatedRelease({ homeRoot: home, feedPath, staging, trustKeyPath }),
    error => error.code === 'signature_invalid',
  );
  assert.deepEqual(snapshotHome(home), before);
  assert.deepEqual(listPayloadFiles(staging), []);
  assert.equal(fs.existsSync(path.join(staging, 'payload')), false);
});

test('production publisherTrust refuses staging and writes nothing', t => {
  const { root, home } = installedHome(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const { publicKey, privateKey } = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, privateKey) },
  })], { publisherTrust: 'production' }));
  const staging = path.join(root, 'staging');
  const before = snapshotHome(home);
  assert.throws(
    () => stageAuthenticatedRelease({ homeRoot: home, feedPath, staging, trustKeyPath }),
    error => error.code === 'untrusted_feed_claim',
  );
  assert.deepEqual(snapshotHome(home), before);
  assert.equal(fs.existsSync(staging), false);
  assert.equal(fs.existsSync(`${staging}.home23-stage.json`), false);
  assert.deepEqual(listPayloadFiles(staging), []);
});

function signedDevelopmentFixture(t, { sourceCommit = 'b'.repeat(40) } = {}) {
  const { root, home } = installedHome(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit });
  const { publicKey, privateKey } = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, privateKey) },
  })], { publisherTrust: 'development' }));
  return {
    root,
    home,
    artifact,
    manifest,
    trustKeyPath,
    feedPath,
    staging: path.join(root, 'staging'),
  };
}

test('downloadDevelopmentRelease reports checking then copying then staged without changing home bytes', t => {
  const f = signedDevelopmentFixture(t);
  const before = snapshotHome(f.home);
  const phases = [];
  const result = downloadDevelopmentRelease({
    homeRoot: f.home,
    feedPath: f.feedPath,
    trustKeyPath: f.trustKeyPath,
    staging: f.staging,
    onProgress: progress => phases.push(progress),
  });
  assert.deepEqual(result, {
    ok: true,
    status: 'staged',
    packageId: f.manifest.packageId,
    publisherTrust: 'development',
    canInstall: false,
    networkInstall: false,
    homeMutated: false,
    resumed: false,
  });
  assert.equal(phases.at(-1)?.phase, 'staged');
  assert.deepEqual(phases.map(item => item.phase), ['checking', 'copying', 'staged']);
  assert.ok(phases.every(item => item.packageId === f.manifest.packageId));
  assert.ok(phases.every(item => Number.isInteger(item.bytesCopied) && Number.isInteger(item.bytesTotal)));
  assert.equal(phases.at(-1).bytesCopied, phases.at(-1).bytesTotal);
  assert.ok(fs.existsSync(path.join(f.staging, 'payload', 'manifest.json')));
  assert.deepEqual(snapshotHome(f.home), before);
});

test('downloadDevelopmentRelease resumes a partial stage without writing the home', t => {
  const f = signedDevelopmentFixture(t);
  const before = snapshotHome(f.home);
  const original = fs.copyFileSync;
  let copies = 0;
  fs.copyFileSync = (source, destination, flags) => {
    if (++copies === 2) {
      fs.writeFileSync(destination, 'partial', { flag: 'wx' });
      throw new Error('Simulated copy interruption');
    }
    return original(source, destination, flags);
  };
  const failedPhases = [];
  try {
    assert.throws(
      () => downloadDevelopmentRelease({
        homeRoot: f.home,
        feedPath: f.feedPath,
        trustKeyPath: f.trustKeyPath,
        staging: f.staging,
        onProgress: progress => failedPhases.push(progress.phase),
      }),
      /Simulated copy interruption/,
    );
  } finally {
    fs.copyFileSync = original;
  }
  assert.ok(failedPhases.includes('failed'));
  assert.equal(JSON.parse(fs.readFileSync(`${f.staging}.home23-stage.json`, 'utf8')).status, 'copying');
  assert.deepEqual(snapshotHome(f.home), before);

  const phases = [];
  const result = downloadDevelopmentRelease({
    homeRoot: f.home,
    feedPath: f.feedPath,
    trustKeyPath: f.trustKeyPath,
    staging: f.staging,
    onProgress: progress => phases.push(progress),
  });
  assert.equal(result.status, 'staged');
  assert.equal(result.ok, true);
  assert.equal(result.homeMutated, false);
  assert.ok(result.resumed === true || result.status === 'staged');
  assert.equal(result.resumed, true);
  assert.deepEqual(phases.map(item => item.phase), ['checking', 'resuming', 'staged']);
  assert.ok(fs.existsSync(path.join(f.staging, 'payload', 'manifest.json')));
  assert.deepEqual(snapshotHome(f.home), before);
});

test('downloadDevelopmentRelease rejects a bad signature without leaving a payload', t => {
  const { root, home } = installedHome(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const { publicKey } = developmentKeyPair();
  const other = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, other.privateKey) },
  })], { publisherTrust: 'development' }));
  const staging = path.join(root, 'staging');
  const before = snapshotHome(home);
  const phases = [];
  assert.throws(
    () => downloadDevelopmentRelease({
      homeRoot: home,
      feedPath,
      trustKeyPath,
      staging,
      onProgress: progress => phases.push(progress),
    }),
    error => error.code === 'signature_invalid',
  );
  assert.deepEqual(phases.map(item => item.phase), ['failed']);
  assert.deepEqual(snapshotHome(home), before);
  assert.deepEqual(listPayloadFiles(staging), []);
  assert.equal(fs.existsSync(path.join(staging, 'payload')), false);
});
