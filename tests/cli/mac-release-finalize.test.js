import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { assertAssemblyDescriptor, assertDeveloperIdProfile, assertProductionEntitlements,
  assertHostBuildSourceHashes, assertProductionNodeEntitlements, nestedSigningOrder,
  assertResumePins, assertResumeStage, assertResumedRuntimeManifest, assertSignedRuntimePartial,
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

test('signed-runtime resume pins exact package ID and partial app tree before writes', () => {
  const packageId = 'a'.repeat(64), tree = 'b'.repeat(64);
  const plan = { expectedSignedPackageId: packageId, partialAppTreeSHA256: tree };
  const options = { expectedSignedPackageId: packageId, expectedPartialAppTreeSHA256: tree };
  assert.doesNotThrow(() => assertResumePins(options, plan));
  assert.throws(() => assertResumePins({ ...options, expectedSignedPackageId: 'c'.repeat(64) }, plan), /pin differs/);
  assert.throws(() => assertResumePins({ ...options, expectedPartialAppTreeSHA256: 'd'.repeat(64) }, plan), /pin differs/);
  assert.throws(() => assertResumePins({ ...options, expectedPartialAppTreeSHA256: 'not-a-hash' }, plan), /pin differs/);
});

test('signed-runtime manifest must retain original source inventory and a new pinned package ID', () => {
  const original = { schema: 'home23.product-payload.v1', packageId: 'a'.repeat(64),
    sourceCommit: 'b'.repeat(40), platform: 'darwin', arch: 'arm64', nodeVersion: 'v22.0.0',
    files: [{ path: 'bin/node', type: 'file' }] };
  const signed = { ...original, packageId: 'c'.repeat(64) };
  assert.doesNotThrow(() => assertResumedRuntimeManifest(original, signed, signed.packageId));
  assert.throws(() => assertResumedRuntimeManifest(original, original, original.packageId), /not bound/);
  assert.throws(() => assertResumedRuntimeManifest(original, signed, 'd'.repeat(64)), /not bound/);
  assert.throws(() => assertResumedRuntimeManifest(original,
    { ...signed, sourceCommit: 'e'.repeat(40) }, signed.packageId), /not bound/);
  assert.throws(() => assertResumedRuntimeManifest(original,
    { ...signed, files: [{ path: 'other', type: 'file' }] }, signed.packageId), /not bound/);
});

test('signed-runtime resume rejects unknown or later output stages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-resume-stage-'));
  try {
    const output = path.join(root, 'output'), assembly = path.join(root, 'assembly');
    const app = path.join(output, 'Home23/Home23.app');
    fs.mkdirSync(app, { recursive: true });
    fs.mkdirSync(path.join(assembly, 'Home23/Home23.app'), { recursive: true });
    for (const name of ['Start Here.txt', 'release.json']) {
      fs.writeFileSync(path.join(assembly, 'Home23', name), `original ${name}`);
      fs.writeFileSync(path.join(output, 'Home23', name), `original ${name}`);
    }
    assert.deepEqual(assertResumeStage(output, assembly), { release: path.join(output, 'Home23'), app });
    fs.writeFileSync(path.join(output, 'notary-submission.zip'), 'later');
    assert.throws(() => assertResumeStage(output, assembly), /later or unknown stage/);
    fs.rmSync(path.join(output, 'notary-submission.zip'));
    fs.writeFileSync(path.join(output, 'production-release-receipt.json'), 'later');
    assert.throws(() => assertResumeStage(output, assembly), /later or unknown stage/);
    fs.rmSync(path.join(output, 'production-release-receipt.json'));
    fs.writeFileSync(path.join(output, '__MACOSX'), 'transient metadata');
    assert.throws(() => assertResumeStage(output, assembly), /later or unknown stage/);
    fs.rmSync(path.join(output, '__MACOSX'));
    fs.writeFileSync(path.join(output, 'Home23/release.json'), 'modified release');
    assert.throws(() => assertResumeStage(output, assembly), /companion differs/);
    fs.writeFileSync(path.join(output, 'Home23/release.json'), 'original release.json');
    fs.chmodSync(path.join(output, 'Home23/Start Here.txt'), 0o600);
    assert.throws(() => assertResumeStage(output, assembly), /companion differs/);
    fs.chmodSync(path.join(output, 'Home23/Start Here.txt'), 0o644);
    fs.writeFileSync(path.join(output, 'Home23/extra.txt'), 'unknown');
    assert.throws(() => assertResumeStage(output, assembly), /later or unknown stage/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('signed-runtime partial tree accepts only signed native bytes, manifest and two exact production files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-resume-tree-'));
  try {
    const originalApp = path.join(root, 'original'), partialApp = path.join(root, 'partial');
    const runtime = 'Contents/Library/LoginItems/Home23Host.app/Contents/Resources/Home23Runtime';
    const put = (base, relative, value, mode = 0o644) => {
      const target = path.join(base, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value, { mode });
    };
    put(originalApp, 'Contents/MacOS/Home23Mac', 'client', 0o755);
    put(originalApp, 'Contents/Resources/Home23.icns', 'icon');
    fs.symlinkSync('Home23.icns', path.join(originalApp, 'Contents/Resources/icon-link'));
    put(originalApp, 'Contents/Library/LoginItems/Home23Host.app/Contents/MacOS/Home23Host', 'host', 0o755);
    put(originalApp, `${runtime}/bin/node`, 'unsigned node', 0o755);
    put(originalApp, `${runtime}/manifest.json`, 'unsigned manifest');
    fs.cpSync(originalApp, partialApp, { recursive: true, verbatimSymlinks: true });
    put(partialApp, `${runtime}/bin/node`, 'signed node', 0o755);
    put(partialApp, `${runtime}/manifest.json`, 'signed manifest');
    const channelConfig = path.join(root, 'channel.json'), macProfile = path.join(root, 'profile');
    fs.writeFileSync(channelConfig, 'pinned channel'); fs.writeFileSync(macProfile, 'pinned profile');
    put(partialApp, 'Contents/Resources/release-channel.json', 'pinned channel');
    put(partialApp, 'Contents/embedded.provisionprofile', 'pinned profile');
    const verify = () => assertSignedRuntimePartial({ originalApp, partialApp,
      runtimeMachO: ['bin/node'], channelConfig, macProfile });
    assert.match(await verify(), /^[a-f0-9]{64}$/);
    put(partialApp, 'Contents/MacOS/Home23Mac', 'changed client', 0o755);
    await assert.rejects(verify(), /bytes differ from assembly/);
    put(partialApp, 'Contents/MacOS/Home23Mac', 'client', 0o755);
    fs.chmodSync(path.join(partialApp, 'Contents/MacOS/Home23Mac'), 0o700);
    await assert.rejects(verify(), /entry differs from assembly/);
    fs.chmodSync(path.join(partialApp, 'Contents/MacOS/Home23Mac'), 0o755);
    fs.rmSync(path.join(partialApp, 'Contents/Resources/icon-link'));
    fs.symlinkSync('wrong-target', path.join(partialApp, 'Contents/Resources/icon-link'));
    await assert.rejects(verify(), /entry differs from assembly/);
    fs.rmSync(path.join(partialApp, 'Contents/Resources/icon-link'));
    fs.symlinkSync('Home23.icns', path.join(partialApp, 'Contents/Resources/icon-link'));
    put(partialApp, 'Contents/Resources/release-channel.json', 'wrong channel');
    await assert.rejects(verify(), /Unexpected partial app addition/);
    put(partialApp, 'Contents/Resources/release-channel.json', 'pinned channel');
    put(partialApp, `${runtime}/unexpected.txt`, 'unexpected');
    await assert.rejects(verify(), /Unexpected partial app addition/);
    fs.rmSync(path.join(partialApp, `${runtime}/unexpected.txt`));
    fs.rmSync(path.join(partialApp, 'Contents/embedded.provisionprofile'));
    await assert.rejects(verify(), /Missing new production app file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
