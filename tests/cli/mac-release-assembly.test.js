import test from 'node:test';
import assert from 'node:assert/strict';
import { assertReleasePair, newestMacOS, localClientEntitlements } from '../../scripts/product/assemble-mac-release.mjs';
const pair = () => ({
  manifest: { platform: 'darwin', arch: 'arm64', packageId: 'runtime-a', sourceCommit: 'backend-a' },
  appleCommit: 'apple-a',
  hostReceipt: { status: 'built', runtimeIncluded: true, sourceCommit: 'apple-a', runtime: { packageId: 'runtime-a', sourceCommit: 'backend-a' } },
  host: { bundleIdentifier: 'com.home23.host', architectures: ['arm64'], minimumMacOS: '14.0' },
  client: { bundleIdentifier: 'com.regina6.home23.mac', architectures: ['arm64'], minimumMacOS: '27.0' },
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
  ]) { const p = pair(); mutate(p); assert.throws(() => assertReleasePair(p)); }
});

test('local signing retains sandbox and permissions without claiming profile-backed APNs', () => {
  const actual = localClientEntitlements({ 'com.apple.security.app-sandbox': true,
    'com.apple.security.network.client': true, 'com.apple.developer.aps-environment': 'development' });
  assert.deepEqual(actual, { 'com.apple.security.app-sandbox': true, 'com.apple.security.network.client': true });
  assert.throws(() => localClientEntitlements({}));
});
