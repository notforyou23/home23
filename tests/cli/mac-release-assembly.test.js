import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { assertReleasePair, newestMacOS, localClientEntitlements } from '../../scripts/product/assemble-mac-release.mjs';
const pair = () => ({
  manifest: { platform: 'darwin', arch: 'arm64', packageId: 'runtime-a', sourceCommit: 'backend-a' },
  appleCommit: 'apple-a',
  hostReceipt: { status: 'built', runtimeIncluded: true, sourceCommit: 'apple-a', runtime: { packageId: 'runtime-a', sourceCommit: 'backend-a' } },
  host: { bundleIdentifier: 'com.home23.host', architectures: ['arm64'], minimumMacOS: '27.0', version: '2.0', build: '140' },
  client: { bundleIdentifier: 'com.regina6.home23.mac', architectures: ['arm64'], minimumMacOS: '27.0', version: '2.0', build: '140' },
});
test('combined download advertises the stricter client OS, not just Host requirements', () => {
  assert.doesNotThrow(() => assertReleasePair(pair()));
  assert.equal(newestMacOS(['14.0', '27.0']), '27.0');
  assert.equal(newestMacOS(['14.9', '14.10', '14.10.1']), '14.10.1');
});
test('refuses incomplete Host and independently mismatched runtime or Apple revision', () => {
  for (const mutate of [
    p => { p.hostReceipt.runtimeIncluded = false; },
    p => { p.hostReceipt.runtime.packageId = 'other-runtime'; },
    p => { p.hostReceipt.runtime.sourceCommit = 'other-backend'; },
    p => { p.hostReceipt.sourceCommit = 'other-apple'; },
  ]) { const p = pair(); mutate(p); assert.throws(() => assertReleasePair(p)); }
});
test('refuses wrong app identities and unsupported architecture', () => {
  for (const mutate of [
    p => { p.client.bundleIdentifier = 'com.regina6.home23.tv'; },
    p => { p.host.bundleIdentifier = 'com.regina6.home23.mac'; },
    p => { p.client.architectures = ['x86_64']; },
    p => { p.manifest.platform = 'linux'; },
    p => { delete p.client.minimumMacOS; },
    p => { p.host.build = '1'; },
  ]) { const p = pair(); mutate(p); assert.throws(() => assertReleasePair(p)); }
});

test('assembly-style payload verify accepts packaged yarn.lock and flake.lock', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-assembly-payload-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [relative, contents] of Object.entries({
    'bin/node': 'test executable\n',
    'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n',
    'app/scripts/product/host.mjs': 'export {};\n',
    'tools/node_modules/pm2/bin/pm2': 'test process manager\n',
    'app/node_modules/x/yarn.lock': '# yarn\n',
    'app/node_modules/lodash/flake.lock': '{}\n',
  })) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  writeProductManifest(root, {
    sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.4',
  });
  // assemble-mac-release, finalize-mac-release and archive-runtime call this
  // without allowRuntimeState. Packaged lockfiles must remain software.
  assert.equal(typeof verifyProductPayload(root).packageId, 'string');
});

test('local signing retains sandbox and permissions without claiming profile-backed APNs', () => {
  const actual = localClientEntitlements({ 'com.apple.security.app-sandbox': true,
    'com.apple.security.network.client': true, 'com.apple.developer.aps-environment': 'development' });
  assert.deepEqual(actual, { 'com.apple.security.app-sandbox': true, 'com.apple.security.network.client': true });
  assert.throws(() => localClientEntitlements({}));
});
