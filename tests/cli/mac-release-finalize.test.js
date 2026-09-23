import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertAssemblyDescriptor, assertDeveloperIdProfile, assertProductionEntitlements,
  assertHostBuildSourceHashes, assertProductionNodeEntitlements, nestedSigningOrder,
  planMacFinalization } from '../../scripts/product/finalize-mac-release.mjs';

test('signs all framework-contained native leaves before containing bundles', () => {
  const order = nestedSigningOrder([
    'Contents/Frameworks/Foo.framework/Versions/A/Foo',
    'Contents/Frameworks/Foo.framework/Versions/A/Helpers/libextra.dylib',
    'Contents/Resources/home23-app-lifecycle',
  ], ['Contents/Frameworks/Foo.framework']);
  assert.equal(order.at(-1), 'Contents/Frameworks/Foo.framework');
  assert.ok(order.indexOf('Contents/Frameworks/Foo.framework/Versions/A/Helpers/libextra.dylib') <
    order.indexOf('Contents/Frameworks/Foo.framework'));
  assert.equal(new Set(order).size, 4);
});

test('Host receipt hashes resolve against the exact frozen Apple checkout', () => {
  const apple = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-host-source-'));
  try {
    const relative = 'Home23Host/HostCommand.swift';
    const pinned = path.join(apple, relative);
    fs.mkdirSync(path.dirname(pinned), { recursive: true });
    fs.writeFileSync(pinned, 'frozen source\n');
    const source = { path: `/different/build-checkout/${relative}`,
      sha256: createHash('sha256').update('frozen source\n').digest('hex') };
    assert.doesNotThrow(() => assertHostBuildSourceHashes([source], apple));
    assert.throws(() => assertHostBuildSourceHashes([{ ...source, sha256: '0'.repeat(64) }], apple), /hash differs/);
    assert.throws(() => assertHostBuildSourceHashes([source,
      { ...source, path: '/different/build-checkout/other/file.swift' }], apple), /escaped/);
  } finally { fs.rmSync(apple, { recursive: true, force: true }); }
});

test('Developer ID profile must cover all Macs and the exact app identity', () => {
  const profile = { platform: ['OSX'], allDevices: true, teamIdentifiers: ['H7RZ65BN25'],
    entitlements: { 'com.apple.application-identifier': 'H7RZ65BN25.com.regina6.home23.mac' },
    expiration: '2040-01-01T00:00:00Z' };
  assert.doesNotThrow(() => assertDeveloperIdProfile(profile));
  assert.throws(() => assertDeveloperIdProfile({ ...profile, allDevices: false }), /scope/);
  assert.throws(() => assertDeveloperIdProfile({ ...profile, expiration: 'not-a-date' }), /expiration/);
  assert.throws(() => assertDeveloperIdProfile({ ...profile,
    entitlements: { 'com.apple.application-identifier': 'H7RZ65BN25.other' } }), /identity/);
});

test('production signing refuses loss of app and Node capabilities or debugger entitlement', () => {
  const source = { 'com.apple.security.app-sandbox': true, 'com.apple.security.network.client': true,
    'com.apple.developer.aps-environment': 'development',
    'com.apple.developer.usernotifications.time-sensitive': true };
  const production = { ...source, 'com.apple.developer.aps-environment': 'production',
    'com.apple.application-identifier': 'H7RZ65BN25.com.regina6.home23.mac',
    'com.apple.developer.team-identifier': 'H7RZ65BN25' };
  const profile = { 'com.apple.developer.aps-environment': 'production',
    'com.apple.developer.usernotifications.time-sensitive': true,
    'com.apple.application-identifier': 'H7RZ65BN25.com.regina6.home23.mac',
    'com.apple.developer.team-identifier': 'H7RZ65BN25' };
  assert.doesNotThrow(() => assertProductionEntitlements(source, production, profile));
  assert.throws(() => assertProductionEntitlements(source,
    { ...production, 'com.apple.application-identifier': 'H7RZ65BN25.other' }, profile), /Team entitlements/);
  assert.throws(() => assertProductionEntitlements(source,
    { ...production, 'com.apple.security.network.client': false }, profile), /entitlement lost/);
  assert.throws(() => assertProductionEntitlements(source, production,
    { ...profile, 'com.apple.developer.aps-environment': 'development' }), /Production APNs/);
  assert.throws(() => assertProductionEntitlements(source,
    { ...production, 'com.apple.security.get-task-allow': true }, profile), /debugger/);

  const node = { 'com.apple.security.cs.allow-jit': true,
    'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true,
    'com.apple.security.cs.allow-dyld-environment-variables': true,
    'com.apple.security.cs.disable-executable-page-protection': true,
    'com.apple.security.get-task-allow': true };
  const { 'com.apple.security.get-task-allow': _debug, ...signed } = node;
  assert.doesNotThrow(() => assertProductionNodeEntitlements(node, signed));
  assert.throws(() => assertProductionNodeEntitlements(node,
    { ...signed, 'com.apple.security.cs.allow-jit': false }), /JIT/);
  assert.throws(() => assertProductionNodeEntitlements(node,
    { ...signed, 'com.apple.security.get-task-allow': true }), /debugger/);
  assert.throws(() => assertProductionNodeEntitlements(node,
    { ...signed, 'com.apple.security.cs.disable-library-validation': false }), /runtime exceptions/);
});

test('local assembly receipt cannot claim a different runtime or helper identity', () => {
  const app = { bundleIdentifier: 'com.regina6.home23.mac', version: '2.0', build: '180',
    minimumMacOS: '27.0', architectures: ['arm64'] };
  const host = { ...app, bundleIdentifier: 'com.home23.host' };
  const manifest = { packageId: 'package-a', sourceCommit: 'a'.repeat(40), arch: 'arm64', platform: 'darwin' };
  const receipt = { schema: 'home23.mac-release-set.v1', status: 'local-engineering-candidate',
    signing: 'ad-hoc', notarized: false, published: false, installed: false, channelConfigured: false,
    appLayout: 'Home23.app/Contents/Library/LoginItems/Home23Host.app',
    packageId: manifest.packageId, backendCommit: manifest.sourceCommit, arch: 'arm64', platform: 'darwin',
    host, client: app };
  assert.doesNotThrow(() => assertAssemblyDescriptor(receipt, host, app, manifest));
  assert.throws(() => assertAssemblyDescriptor({ ...receipt, packageId: 'package-b' }, host, app, manifest), /differ/);
  assert.throws(() => assertAssemblyDescriptor({ ...receipt, signing: 'developer-id' }, host, app, manifest), /not an unmodified/);
  assert.throws(() => assertAssemblyDescriptor(receipt, { ...host, bundleIdentifier: 'other' }, app, manifest), /differ/);
});

test('finalization plan refuses output inside any input before copying or signing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-finalization-paths-'));
  try {
    const dirs = ['assembly', 'payload', 'backend', 'apple', 'client'];
    for (const name of dirs) fs.mkdirSync(path.join(root, name));
    const receipt = path.join(root, 'client-receipt.json'); fs.writeFileSync(receipt, '{}');
    const options = { assembly: path.join(root, 'assembly'), payload: path.join(root, 'payload'),
      backendSource: path.join(root, 'backend'), appleSource: path.join(root, 'apple'),
      prebuiltClient: path.join(root, 'client'), prebuiltClientReceipt: receipt,
      output: path.join(root, 'assembly', 'final') };
    await assert.rejects(planMacFinalization(options), /separate from every input/);
    assert.equal(fs.existsSync(options.output), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
