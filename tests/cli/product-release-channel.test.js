import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProductChannel, signedReleaseBytes, verifyProductChannelManifest,
  downloadChannelArtifact, inspectProductChannel, selectConfiguredRelease } from '../../cli/lib/product-release-channel.js';
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

test('signed channel accepts only reviewed coordination schemas 20 and 21', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const channel = { publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
  const envelopeFor = offered => ({ schema: 'home23.signed-release.v1', release: offered,
    signature: sign(null, signedReleaseBytes(offered), privateKey).toString('base64') });
  const next = release();
  next.compatibility.coordinationSchema = 21;
  assert.deepEqual(verifyProductChannelManifest(channel, envelopeFor(next)), next);
  const changed = structuredClone(envelopeFor(next));
  changed.release.compatibility.coordinationSchema = 20;
  assert.throws(() => verifyProductChannelManifest(channel, changed), { code: 'signature_invalid' });
  for (const schema of [19, 22, '21', null]) {
    const unsupported = release();
    unsupported.compatibility.coordinationSchema = schema;
    assert.throws(() => verifyProductChannelManifest(channel, envelopeFor(unsupported)), { code: 'manifest_invalid' });
  }
});

test('channel signer requires explicit schema and signs schema 21 metadata', t => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-channel-signer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyPath = join(directory, 'key.pem');
  const receiptPath = join(directory, 'receipt.json');
  const runtimeArchive = join(directory, 'runtime.tar');
  const appArchive = join(directory, 'app.zip');
  const output = join(directory, 'signed.json');
  writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }));
  writeFileSync(receiptPath, JSON.stringify({ schema: 'home23.mac-release-set.v1', signing: 'developer-id',
    notarized: true, appLayout: 'Home23.app/Contents/Library/LoginItems/Home23Host.app',
    client: { version: '2.0', build: '183' }, packageId: 'a'.repeat(64),
    backendCommit: 'b'.repeat(40), arch: 'arm64', minimumMacOS: '27.0' }));
  writeFileSync(runtimeArchive, 'runtime');
  writeFileSync(appArchive, 'app');
  const command = join(process.cwd(), 'scripts/product/sign-channel-release.mjs');
  const args = [command, '--receipt', receiptPath, '--runtime-archive', runtimeArchive,
    '--app-archive', appArchive, '--runtime-url', 'https://example.test/runtime.tar',
    '--app-url', 'https://example.test/app.zip', '--private-key', keyPath, '--output', output];
  assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), /Missing --coordination-schema/);
  assert.throws(() => execFileSync(process.execPath, [...args, '--coordination-schema', '22'], { stdio: 'pipe' }),
    /Coordination schema must be an explicitly reviewed 20 or 21/);
  execFileSync(process.execPath, [...args, '--coordination-schema', '21'], { stdio: 'pipe' });
  const envelope = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(envelope.release.compatibility.coordinationSchema, 21);
  const channel = { publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') };
  assert.deepEqual(verifyProductChannelManifest(channel, envelope), envelope.release);
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

test('interrupted staging resumes its claimed signed release after feed rotation', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-release-rotation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const channelConfigPath = join(directory, 'channel.json');
  writeFileSync(channelConfigPath, JSON.stringify({ schema: 'home23.product-channel.v1', channel: 'private',
    manifestURL: 'https://example.test/manifest.json',
    publicKey: Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('base64') }));
  const first = release(), second = { ...release(), packageId: 'e'.repeat(64), appBuild: 141 };
  const signed = offered => ({ schema: 'home23.signed-release.v1', release: offered,
    signature: sign(null, signedReleaseBytes(offered), privateKey).toString('base64') });
  const options = { homeRoot: join(directory, 'home'), installedAppPath: join(directory, 'Home23.app'),
    channelConfigPath, downloadDirectory: join(directory, 'download'), osVersion: '27.0' };
  let lookups = 0;
  assert.deepEqual(await selectConfiguredRelease(options, async () => {
    lookups++; return { status: 'available', release: first, signedEnvelope: signed(first) };
  }), first);
  // The stage may already contain the old release. Its claim, not a refreshed
  // channel response, governs a resumed attempt.
  writeFileSync(join(options.downloadDirectory, 'stage-already-copied'), 'old release');
  assert.deepEqual(await selectConfiguredRelease(options, async () => {
    lookups++; return { status: 'available', release: second, signedEnvelope: signed(second) };
  }), first);
  assert.equal(lookups, 1);
  await assert.rejects(selectConfiguredRelease({ ...options, installedAppPath: join(directory, 'Other.app') }),
    { code: 'claim_invalid' });
  assert.equal(readFileSync(join(options.downloadDirectory, 'stage-already-copied'), 'utf8'), 'old release');
});

test('a corrupt full-length partial restarts instead of requesting an impossible range', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'home23-corrupt-partial-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('verified artifact');
  writeFileSync(join(directory, 'runtime.tar.partial'), Buffer.alloc(bytes.length));
  let requests = 0;
  t.mock.method(https, 'get', (_url, options, callback) => {
    requests++;
    assert.deepEqual(options.headers, {});
    const response = Readable.from([bytes]);
    response.statusCode = 200;
    response.headers = { 'content-length': String(bytes.length) };
    queueMicrotask(() => callback(response));
    return new EventEmitter();
  });
  const artifact = { kind: 'https-tar', url: 'https://example.test/runtime.tar',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const file = await downloadChannelArtifact({ artifact, destinationDirectory: directory, name: 'runtime' });
  assert.deepEqual(readFileSync(file), bytes);
  assert.equal(requests, 1);
});
