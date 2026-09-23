import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { appTreeDigest, assertMacClientMetadata, sourceFootprint } from '../../scripts/product/prebuilt-mac-client.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
test('source footprint accepts committed documentation changes but detects executable input drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-prebuilt-source-'));
  try {
    git(root, 'init', '-q');
    fs.mkdirSync(path.join(root, 'Home23Desktop'));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'Home23Desktop', 'App.swift'), 'one');
    fs.writeFileSync(path.join(root, 'docs', 'Guide.md'), 'one');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'source');
    const first = sourceFootprint(root);
    fs.writeFileSync(path.join(root, 'docs', 'Guide.md'), 'two');
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'docs');
    const docs = sourceFootprint(root);
    assert.notEqual(first.commit, docs.commit);
    assert.equal(first.sha256, docs.sha256);
    fs.writeFileSync(path.join(root, 'Home23Desktop', 'App.swift'), 'two');
    assert.throws(() => sourceFootprint(root), /clean/);
    git(root, 'add', '.');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'code');
    assert.notEqual(sourceFootprint(root).sha256, first.sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('artifact digest covers file contents, permissions, and symlink targets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-prebuilt-artifact-'));
  try {
    fs.writeFileSync(path.join(root, 'binary'), 'one');
    fs.symlinkSync('binary', path.join(root, 'current'));
    const first = await appTreeDigest(root);
    assert.equal((await appTreeDigest(root)).sha256, first.sha256);
    fs.writeFileSync(path.join(root, 'binary'), 'two');
    assert.notEqual((await appTreeDigest(root)).sha256, first.sha256);
    fs.writeFileSync(path.join(root, 'binary'), 'one');
    fs.unlinkSync(path.join(root, 'current'));
    fs.symlinkSync('other', path.join(root, 'current'));
    assert.notEqual((await appTreeDigest(root)).sha256, first.sha256);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('prebuilt receipt accepts later release numbers while preserving Mac identity', () => {
  const client = { bundleIdentifier: 'com.regina6.home23.mac', version: '2.1', build: '181',
    minimumMacOS: '27.0', architectures: ['arm64'] };
  assert.doesNotThrow(() => assertMacClientMetadata(client));
  assert.throws(() => assertMacClientMetadata({ ...client, build: '0' }));
  assert.throws(() => assertMacClientMetadata({ ...client, bundleIdentifier: 'com.home23.host' }));
  assert.throws(() => assertMacClientMetadata({ ...client, architectures: ['i386'] }));
});
