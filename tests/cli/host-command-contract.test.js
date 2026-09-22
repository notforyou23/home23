import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeProductManifest } from '../../cli/lib/product-payload.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostEntry = path.join(rootDir, 'scripts/product/host.mjs');
const contractPath = path.join(rootDir, 'scripts/product/host-command-contract.json');
const nodeBin = process.execPath;

function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-host-contract-')));
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

function releaseFor(artifactPath, manifest, overrides = {}) {
  return {
    version: '1.2.3',
    packageId: manifest.packageId,
    sourceCommit: manifest.sourceCommit,
    platform: process.platform,
    arch: process.arch,
    minimumOs: '14.0',
    notes: 'Host command contract fixture',
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

test('host command contract lists check-update for --trust-key', () => {
  const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));
  assert.equal(contract.schema, 'home23.host-command.v1');
  assert.ok(Array.isArray(contract.trustKeyActions));
  assert.ok(contract.trustKeyActions.includes('check-update'));
});

test('check-update with --trust-key verifies development signatures and rejects production or bad signatures', async (t) => {
  const root = tempRoot(t);
  const artifact = path.join(root, 'artifact');
  const manifest = payload(artifact, { sourceCommit: 'b'.repeat(40) });
  const { publicKey, privateKey } = developmentKeyPair();
  const trustKeyPath = path.join(root, 'trust.json');
  writeTrustKey(trustKeyPath, publicKey);
  const feedPath = path.join(root, 'feed.json');
  const home = path.join(root, 'absent-home');

  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, privateKey) },
  })], { publisherTrust: 'development' }));
  const ok = await runHost(['check-update', '--home', home, '--feed', feedPath, '--trust-key', trustKeyPath]);
  const okBody = JSON.parse(ok.stdout);
  assert.equal(ok.code, 0);
  assert.equal(okBody.status, 'available');
  assert.equal(okBody.publisherTrust, 'development');
  assert.equal(okBody.developmentSignatureVerified, true);

  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, privateKey) },
  })], { publisherTrust: 'production' }));
  const production = await runHost(['check-update', '--home', home, '--feed', feedPath, '--trust-key', trustKeyPath]);
  const productionBody = JSON.parse(production.stdout);
  assert.notEqual(production.code, 0);
  assert.equal(productionBody.status, 'damaged');
  assert.notEqual(productionBody.developmentSignatureVerified, true);
  assert.ok(productionBody.reasons.some(item => item.code === 'untrusted_feed_claim'));

  writeFeed(feedPath, feedBody([releaseFor(artifact, manifest, {
    trust: { algorithm: 'ed25519', signature: signPackageId(manifest.packageId, developmentKeyPair().privateKey) },
  })], { publisherTrust: 'development' }));
  const forged = await runHost(['check-update', '--home', home, '--feed', feedPath, '--trust-key', trustKeyPath]);
  const forgedBody = JSON.parse(forged.stdout);
  assert.notEqual(forged.code, 0);
  assert.equal(forgedBody.status, 'damaged');
  assert.notEqual(forgedBody.developmentSignatureVerified, true);
  assert.ok(forgedBody.reasons.some(item => item.code === 'signature_invalid'));
});
