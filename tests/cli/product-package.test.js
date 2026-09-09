import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { buildProductPayload } from '../../scripts/product/package.mjs';
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
