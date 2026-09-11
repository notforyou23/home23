import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  allowedProductNodeLibrary,
  assertOfficialProductNodeLibraries,
  buildProductPayload,
  parseLinkedLibraries,
} from '../../scripts/product/package.mjs';
import { runUpdate } from '../../cli/lib/update.js';

test('source updater refuses both valid and malformed product ownership receipts before network or mutation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-packaged-update-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'app'));
  const receipt = path.join(root, '.home23-install.json');
  for (const contents of ['{"status":"installed"}', 'interrupted invalid JSON']) {
    fs.writeFileSync(receipt, contents);
    await assert.rejects(runUpdate(path.join(root, 'app')), /Update through Home23 Host/);
    await assert.rejects(runUpdate(path.join(root, 'app'), true), /Update through Home23 Host/);
    assert.equal(fs.readFileSync(receipt, 'utf8'), contents);
    assert.deepEqual(fs.readdirSync(path.join(root, 'app')), []);
  }
});

test('product package requires a committed source boundary before creating output or installing dependencies', t => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'home23-package-source-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const sourceRoot = path.join(base, 'source'); fs.mkdirSync(sourceRoot);
  execFileSync('git', ['init', '-q', sourceRoot]);
  fs.writeFileSync(path.join(sourceRoot, 'source.txt'), 'committed content');
  execFileSync('git', ['add', 'source.txt'], { cwd: sourceRoot });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd: sourceRoot });
  fs.appendFileSync(path.join(sourceRoot, 'source.txt'), ' in flight');
  const outputPath = path.join(base, 'payload');
  assert.throws(() => buildProductPayload({ sourceRoot, outputPath, nodePath: process.execPath, npmPath: process.execPath, cachePath: path.join(base, 'cache') }), /Commit tracked source changes/);
  assert.equal(fs.existsSync(outputPath), false);
});

test('official product Node library checks accept system links and refuse Homebrew or nvm paths', () => {
  assert.deepEqual(parseLinkedLibraries('darwin', '/path/to/node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n\t/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation (compatibility version 150.0.0)\n'), [
    '/usr/lib/libSystem.B.dylib',
    '/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation',
  ]);
  assert.deepEqual(parseLinkedLibraries('linux', [
    '\tlinux-vdso.so.1 (0x00007ffd)',
    '\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x00007f)',
    '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)',
    '\t/lib64/ld-linux-x86-64.so.2 (0x00007f)',
  ].join('\n')), [
    'linux-vdso.so.1',
    '/lib/x86_64-linux-gnu/libdl.so.2',
    '/lib/x86_64-linux-gnu/libc.so.6',
    '/lib64/ld-linux-x86-64.so.2',
  ]);
  assert.deepEqual(parseLinkedLibraries('linux', '\tnot a dynamic executable\n'), []);
  assert.equal(allowedProductNodeLibrary('darwin', '/opt/homebrew/opt/node/lib/libnode.dylib'), false);
  assert.equal(allowedProductNodeLibrary('linux', '/home/box/.nvm/versions/node/v22.19.0/lib/libnode.so.127'), false);
  assert.equal(allowedProductNodeLibrary('linux', 'libfoo.so.1 => not found'), false);
  assert.doesNotThrow(() => assertOfficialProductNodeLibraries('linux', [
    'linux-vdso.so.1',
    '/lib/x86_64-linux-gnu/libdl.so.2',
    '/lib64/ld-linux-x86-64.so.2',
  ]));
  assert.throws(
    () => assertOfficialProductNodeLibraries('linux', ['/home/box/.nvm/versions/node/v22.19.0/bin/../lib/libnode.so.127']),
    /self-contained official Node distribution/,
  );
  assert.throws(
    () => assertOfficialProductNodeLibraries('aix', []),
    /supports macOS and Linux/,
  );
});
