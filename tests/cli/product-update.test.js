import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeProductManifest, installProductPayload } from '../../cli/lib/product-payload.js';
import { inspectProductInstallation, previewProductUpdate } from '../../cli/lib/product-update.js';

function fixture(t, { sourceCommit = 'a'.repeat(40), platform = process.platform } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-preview-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const payload = path.join(root, 'payload'), home = path.join(root, 'home');
  for (const [relative, contents] of Object.entries({ 'bin/node': '#!/bin/sh\n', 'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n', 'app/scripts/product/host.mjs': 'export {};\n', 'tools/node_modules/pm2/bin/pm2': 'pm2\n' })) {
    const file = path.join(payload, relative); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  const manifest = writeProductManifest(payload, { sourceCommit, platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  return { root, payload, home, manifest };
}

function tree(root) {
  const entries = [];
  const visit = relative => {
    const absolute = path.join(root, relative);
    for (const name of fs.readdirSync(absolute)) {
      const child = relative ? `${relative}/${name}` : name;
      const file = path.join(root, child), stat = fs.lstatSync(file);
      const item = { path: child, type: stat.isDirectory() ? 'directory' : stat.isSymbolicLink() ? 'symlink' : 'file', mode: stat.mode & 0o7777 };
      if (item.type === 'symlink') item.target = fs.readlinkSync(file);
      if (item.type === 'file') item.bytes = fs.readFileSync(file).toString('base64');
      entries.push(item); if (item.type === 'directory') visit(child);
    }
  };
  visit(''); return entries.sort((a, b) => a.path.localeCompare(b.path));
}

test('preview distinguishes same and different intact candidates without changing either root', t => {
  const current = fixture(t), candidate = fixture(t, { sourceCommit: 'b'.repeat(40) });
  installProductPayload({ payloadPath: current.payload, homeRoot: current.home });
  fs.mkdirSync(path.join(current.home, 'app/instances/milo'), { recursive: true });
  fs.writeFileSync(path.join(current.home, 'app/instances/milo/lived.json'), 'keep');
  const beforeHome = tree(current.home), beforeCandidate = tree(candidate.payload);
  const same = previewProductUpdate({ homeRoot: current.home, candidatePayload: current.payload });
  assert.equal(same.canInstall, false); assert.ok(same.reasons.some(item => item.code === 'same_package'));
  assert.equal(same.publisherTrust, 'unverified'); assert.equal(same.stateMigrationCompatibility, 'unverified');
  const different = previewProductUpdate({ homeRoot: current.home, candidatePayload: candidate.payload });
  assert.ok(different.reasons.some(item => item.code === 'different_package'));
  assert.deepEqual(tree(current.home), beforeHome);
  assert.deepEqual(tree(candidate.payload), beforeCandidate);
});

test('preview reports corrupt receipts and unsupported layouts without exposing private contents', t => {
  const f = fixture(t);
  installProductPayload({ payloadPath: f.payload, homeRoot: f.home });
  fs.writeFileSync(path.join(f.home, '.home23-install.json'), '{broken');
  const corrupt = previewProductUpdate({ homeRoot: f.home, candidatePayload: f.payload });
  assert.ok(corrupt.reasons.some(item => item.code === 'invalid_private_receipt'));
  assert.doesNotMatch(JSON.stringify(corrupt), /broken/);
  const source = path.join(f.root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'package.json'), '{}');
  assert.equal(inspectProductInstallation(source).layout, 'source');
  assert.equal(inspectProductInstallation(path.join(f.root, 'missing')).layout, 'absent');
  const dangling = path.join(f.root, 'dangling'); fs.mkdirSync(dangling); fs.symlinkSync('missing-receipt', path.join(dangling, '.home23-install.json'));
  assert.equal(inspectProductInstallation(dangling).reasons[0].code, 'invalid_private_receipt');
  const unsafe = path.join(f.root, 'unsafe'); fs.symlinkSync('missing-directory', unsafe);
  assert.throws(() => inspectProductInstallation(path.join(unsafe, 'home')), /real directory ancestors/);
  const managed = path.join(f.root, 'managed'); fs.mkdirSync(path.join(managed, 'instances/.house/coordination'), { recursive: true });
  fs.symlinkSync('missing-pointer', path.join(managed, 'instances/.house/coordination/active-release.json'));
  assert.equal(inspectProductInstallation(managed).layout, 'managed');
  const unknown = path.join(f.root, 'unknown'); fs.mkdirSync(unknown);
  assert.equal(inspectProductInstallation(unknown).layout, 'unknown');
});

test('preview reports candidate byte, mode, and platform failures and protocol stays read-only', t => {
  const f = fixture(t); installProductPayload({ payloadPath: f.payload, homeRoot: f.home });
  const changed = fixture(t); fs.appendFileSync(path.join(changed.payload, 'app/cli/home23.js'), 'changed');
  const integrity = previewProductUpdate({ homeRoot: f.home, candidatePayload: changed.payload });
  assert.ok(integrity.reasons.some(item => item.code === 'candidate_integrity_failed'));
  const modeChanged = fixture(t); fs.chmodSync(path.join(modeChanged.payload, 'app/cli/home23.js'), 0o755);
  assert.ok(previewProductUpdate({ homeRoot: f.home, candidatePayload: modeChanged.payload }).reasons.some(item => item.code === 'candidate_integrity_failed'));
  const foreign = fixture(t, { platform: process.platform === 'darwin' ? 'linux' : 'darwin' });
  const platform = previewProductUpdate({ homeRoot: f.home, candidatePayload: foreign.payload });
  assert.ok(platform.reasons.some(item => item.code === 'candidate_platform_unsupported'));
  const receipt = JSON.parse(fs.readFileSync(path.join(f.home, '.home23-install.json')));
  receipt.sourceCommit = 'c'.repeat(40); fs.writeFileSync(path.join(f.home, '.home23-install.json'), JSON.stringify(receipt), { mode: 0o600 });
  assert.ok(inspectProductInstallation(f.home).reasons.some(item => item.code === 'receipt_mismatch'));
  receipt.sourceCommit = f.manifest.sourceCommit; fs.writeFileSync(path.join(f.home, '.home23-install.json'), JSON.stringify(receipt), { mode: 0o600 });
  fs.mkdirSync(path.join(f.home, 'app/instances/.house/coordination'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'app/instances/.house/coordination/active-release.json'), '{}');
  assert.ok(inspectProductInstallation(f.home).reasons.some(item => item.code === 'mixed_managed_layout'));
  assert.throws(() => inspectProductInstallation('relative-home'), /absolute directory/);
  const beforeHome = tree(f.home), beforeCandidate = tree(f.payload);
  const reply = JSON.parse(execFileSync(process.execPath,
    ['scripts/product/host.mjs', 'preview', '--home', f.home, '--payload', f.payload], { encoding: 'utf8' }));
  assert.equal(reply.canInstall, false); assert.equal(reply.status, 'preview');
  assert.equal(fs.existsSync(path.join(f.home, 'runtime')), false);
  assert.deepEqual(tree(f.home), beforeHome); assert.deepEqual(tree(f.payload), beforeCandidate);
  fs.appendFileSync(path.join(f.home, 'app/cli/home23.js'), 'changed installed code');
  assert.equal(inspectProductInstallation(f.home).reasons[0].code, 'modified_installation');
});
