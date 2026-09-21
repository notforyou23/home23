import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeProductManifest } from '../../cli/lib/product-payload.js';
import { inspectReleaseFeed } from '../../cli/lib/product-update-feed.js';

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
      const full = path.join(directory, relative);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) visit(directory, relative);
      else entries.push({ relative, mode: stat.mode & 0o7777, bytes: fs.readFileSync(full) });
    }
  }
  visit(home);
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
