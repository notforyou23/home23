import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProductChannel, signedReleaseBytes, verifyProductChannelManifest,
  inspectProductChannel } from '../../cli/lib/product-release-channel.js';
import { extractProductArchive } from '../../cli/lib/product-update-feed.js';

const release = () => ({
  version: '2.0', appBuild: 140, packageId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40),
  platform: 'darwin', arch: 'arm64', minimumOs: '27.0',
  appBundleIdentifier: 'com.regina6.home23.mac', hostBundleIdentifier: 'com.home23.host',
  compatibility: { installationSchema: 'home23.product-install.v1', coordinationSchema: 20,
    stateMigration: 'schema_preserving_only', minimumClientBuild: 146 },
  appDeliveryURL: 'https://example.test/ios',
  runtime: { kind: 'https-tar', url: 'https://example.test/runtime.tar', sha256: 'c'.repeat(64), bytes: 300_000_000 },
  app: { kind: 'https-zip', url: 'https://example.test/app.zip', sha256: 'd'.repeat(64), bytes: 400_000_000 },
});

test('streamed extraction follows PAX long paths without loading a whole assembly', t => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-pax-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, 'source'), extracted = join(directory, 'extracted');
  const longName = 'long-component-'.repeat(12);
  mkdirSync(join(source, longName), { recursive: true });
  writeFileSync(join(source, longName, 'file.txt'), 'payload');
  const archive = join(directory, 'runtime.tar');
  execFileSync('/usr/bin/tar', ['--format', 'pax', '-cf', archive, '-C', source, '.']);
  extractProductArchive({ archivePath: archive, destinationDirectory: extracted });
  assert.equal(readFileSync(join(extracted, longName, 'file.txt'), 'utf8'), 'payload');
});

test('signature covers every app, runtime, compatibility, and delivery field', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const channel = { publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
  const offered = release();
  const envelope = { schema: 'home23.signed-release.v1', release: offered,
    signature: sign(null, signedReleaseBytes(offered), privateKey).toString('base64') };
  assert.deepEqual(verifyProductChannelManifest(channel, envelope), offered);
  for (const mutate of [r => { r.packageId = 'e'.repeat(64); }, r => { r.appBuild += 1; },
    r => { r.runtime.url = 'https://example.test/other.tar'; }, r => { r.compatibility.minimumClientBuild += 1; },
    r => { r.appDeliveryURL = 'https://example.test/other'; }]) {
    const forged = structuredClone(envelope);
    mutate(forged.release);
    assert.throws(() => verifyProductChannelManifest(channel, forged), { code: 'signature_invalid' });
  }
});

test('missing bundled channel is unavailable rather than current', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-channel-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = await inspectProductChannel({ channelConfigPath: join(directory, 'missing.json'),
    installedPackageId: 'a'.repeat(64), installedAppBuild: 140, platform: 'darwin', arch: 'arm64', osVersion: '27.0' });
  assert.equal(result.status, 'unavailable');
  const config = join(directory, 'config.json');
  writeFileSync(config, JSON.stringify({ schema: 'home23.product-channel.v1', channel: 'private',
    manifestURL: 'http://example.test/manifest.json', publicKey: 'a'.repeat(44) }));
  assert.throws(() => readProductChannel(config));
});
