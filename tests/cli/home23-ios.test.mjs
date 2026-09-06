import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyMetadata, verifySource } from '../../scripts/home23-ios.mjs';

const config = { bundleIdentifier: 'com.example.current', displayName: 'Home23', minimumBuild: 106, port: '18443', contractSHA256: 'current-pack' };
const info = { CFBundleIdentifier: config.bundleIdentifier, CFBundleDisplayName: 'Home23', CFBundleName: 'Home23', CFBundleVersion: '106', Home23ConnectedAgentsPort: '18443' };

test('promotion retains the installed identity and refuses old labels, builds and endpoints', () => {
  verifyMetadata(info, config);
  for (const change of [{ CFBundleIdentifier: 'com.example.legacy' }, { CFBundleDisplayName: 'Home23 Canary' }, { CFBundleVersion: '105' }, { CFBundleVersion: '106x' }, { Home23ConnectedAgentsPort: '8443' }]) {
    assert.throws(() => verifyMetadata({ ...info, ...change }, config));
  }
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
