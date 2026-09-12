import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildArguments, parseInvocation, verifyMetadata, verifySource } from '../../scripts/home23-ios.mjs';

const config = { bundleIdentifier: 'com.example.current', displayName: 'Home23', minimumBuild: 106, port: '18443', contractSHA256: 'current-pack' };
const info = { CFBundleIdentifier: config.bundleIdentifier, CFBundleDisplayName: 'Home23', CFBundleName: 'Home23', CFBundleVersion: '106', Home23ConnectedAgentsPort: '18443' };

test('promotion retains the installed identity and refuses old labels, builds and endpoints', () => {
  verifyMetadata(info, config);
  for (const change of [{ CFBundleIdentifier: 'com.example.legacy' }, { CFBundleDisplayName: 'Home23 Canary' }, { CFBundleName: 'Home23 Canary' }, { CFBundleVersion: '105' }, { CFBundleVersion: '106x' }, { Home23ConnectedAgentsPort: '8443' }]) {
    assert.throws(() => verifyMetadata({ ...info, ...change }, config));
  }
});

test('the build preserves target identities while sharing version, port and executable layout', () => {
  const args = buildArguments({ source: '/source with spaces', output: '/build output', buildNumber: '153', port: '18443' });
  assert.equal(args[args.indexOf('-project') + 1], '/source with spaces/Home23.xcodeproj');
  assert.equal(args[args.indexOf('-derivedDataPath') + 1], '/build output/DerivedData');
  const settings = Object.fromEntries(args.filter(value => /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)).map(value => {
    const index = value.indexOf('=');
    return [value.slice(0, index), value.slice(index + 1)];
  }));
  for (const key of ['PRODUCT_BUNDLE_IDENTIFIER', 'PRODUCT_NAME', 'INFOPLIST_KEY_CFBundleDisplayName', 'INFOPLIST_KEY_CFBundleName']) {
    assert.equal(Object.hasOwn(settings, key), false, `${key} must remain target-specific`);
  }
  assert.equal(settings.CURRENT_PROJECT_VERSION, '153');
  assert.equal(settings.HOME23_CONNECTED_AGENTS_PORT, '18443');
  assert.equal(settings.ENABLE_DEBUG_DYLIB, 'NO');
  assert.equal(settings.CODE_SIGNING_ALLOWED, 'NO');
});

test('maintained tooling can select installation config without changing legacy default invocation', () => {
  const positional = ['build', '153', '/build output'];
  assert.deepEqual(parseInvocation(positional, '/default installation'), {
    installation: '/default installation', command: 'build', arg: '153', output: '/build output',
  });
  for (const argv of [
    ['--installation', '/selected installation', ...positional],
    [...positional, '--installation', '/selected installation'],
  ]) {
    assert.deepEqual(parseInvocation(argv, '/default installation'), {
      installation: '/selected installation', command: 'build', arg: '153', output: '/build output',
    });
  }
  assert.throws(() => parseInvocation(['status', '--installation']), /Provide a path/);
  assert.throws(() => parseInvocation(['status', '--installation', '/one', '--installation', '/two']), /only once/);
  assert.throws(() => parseInvocation(['status', '--instalation', '/typo']), /Unknown option/);
});

test('a numerically newer build cannot bypass missing current source or an incompatible persisted contract', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-source-'));
  try {
    const files = ['Home23Shared/Sources/Home23Shared/ProductContracts/ConnectedAgentsContract.swift', 'Home23/Sources/Product/Next/Home23NextPhoneShell.swift', 'Home23/Sources/Product/Work/ProductWorkThreadViewModel.swift'];
    for (const file of files) {
      const p = path.join(sourceRoot, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, file.endsWith('Contract.swift') ? 'packSHA256 = "old-pack"' : 'fixture');
    }
    assert.throws(() => verifySource({ ...config, sourceRoot }), /wrong persistence contract/);
    fs.writeFileSync(path.join(sourceRoot, files[0]), 'packSHA256 = "current-pack"');
    assert.equal(verifySource({ ...config, sourceRoot }), fs.realpathSync(sourceRoot));
    fs.unlinkSync(path.join(sourceRoot, files[2]));
    assert.throws(() => verifySource({ ...config, sourceRoot }), /missing current product/);
  } finally { fs.rmSync(sourceRoot, { recursive: true, force: true }); }
});

// A newly generated profile must not hide an almost-expired signing certificate.
test('signing admission uses the earlier certificate or profile expiry', async () => {
  const {verifySigningLifetime} = await import('../../scripts/home23-ios.mjs');
  const now = Date.parse('2026-09-05T00:00:00Z');
  assert.throws(() => verifySigningLifetime('2027-09-05', '2026-09-26', now), /only 21 days/);
  assert.throws(() => verifySigningLifetime('2026-09-26', '2027-09-05', now), /only 21 days/);
  assert.equal(verifySigningLifetime('2027-09-05', '2027-09-05', now).remainingDays, 365);
  assert.throws(() => verifySigningLifetime('invalid', '2027-09-05', now), /invalid/);
});
