// Regression: the resident supervisor runs with launchd Umask 077 and the home
// update worker inherited it. Extraction and staging then produced 0700
// directories that failed the manifest's exact 0755 check on every resume.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeProductManifest, installProductPayload, verifyProductPayload } from '../../cli/lib/product-payload.js';
import { extractProductArchive } from '../../cli/lib/product-update-feed.js';
import { stageProductPayload } from '../../cli/lib/product-update-stage.js';

const library = path.resolve(import.meta.dirname, '../../cli/lib');

function withUmask(t, mask) {
  const previous = process.umask(mask);
  t.after(() => process.umask(previous));
}
function payloadFixture(t, root, name, commit) {
  const payload = path.join(root, name);
  for (const [relative, contents] of Object.entries({ 'bin/node': '#!/bin/sh\n', 'app/cli/home23.js': 'export {};\n',
    'app/cli/lib/product-payload.js': 'export {};\n', 'app/scripts/product/host.mjs': 'export {};\n', 'tools/node_modules/pm2/bin/pm2': 'pm2\n' })) {
    const file = path.join(payload, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, contents, { mode: relative === 'bin/node' ? 0o755 : 0o644 });
  }
  for (const directory of execFileSync('/usr/bin/find', [payload, '-type', 'd'], { encoding: 'utf8' }).trim().split('\n')) fs.chmodSync(directory, 0o755);
  const manifest = writeProductManifest(payload, { sourceCommit: commit, platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.4' });
  return { payload, manifest };
}
function tempRoot(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'home23-umask-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const modeOf = file => fs.lstatSync(file).mode & 0o7777;

test('a 0700 directory fails verification with a coded payload_mode_mismatch cause', t => {
  const root = tempRoot(t), { payload } = payloadFixture(t, root, 'payload', 'a'.repeat(40));
  fs.chmodSync(path.join(payload, 'app'), 0o700);
  assert.throws(() => verifyProductPayload(payload), error => error.code === 'payload_mode_mismatch'
    && error.reasonCodes.includes('payload_mode_mismatch') && /app is 700, expected 755/.test(error.message));
});

test('extraction under umask 077 keeps the archive modes and the payload verifies', t => {
  const root = tempRoot(t), { payload, manifest } = payloadFixture(t, root, 'payload', 'a'.repeat(40));
  const archive = path.join(root, 'runtime.tar');
  execFileSync('tar', ['-cf', archive, '-C', payload, '.'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  withUmask(t, 0o077);
  const destination = path.join(root, 'extracted');
  extractProductArchive({ archivePath: archive, destinationDirectory: destination });
  for (const entry of manifest.files.filter(item => item.type !== 'symlink')) {
    assert.equal(modeOf(path.join(destination, entry.path)), entry.mode, entry.path);
  }
  assert.equal(verifyProductPayload(destination).packageId, manifest.packageId);
});

test('staging under umask 077 verifies, and a stage left with masked modes heals on resume', t => {
  const root = tempRoot(t);
  const current = payloadFixture(t, root, 'current', 'a'.repeat(40)), candidate = payloadFixture(t, root, 'candidate', 'b'.repeat(40));
  const home = path.join(root, 'home');
  installProductPayload({ payloadPath: current.payload, homeRoot: home });
  withUmask(t, 0o077);
  const staging = path.join(root, 'stage');
  // A stage interrupted under the old code: claim says copying, directories are 0700.
  stageProductPayload({ homeRoot: home, candidatePayload: candidate.payload, staging });
  const claimPath = `${staging}.home23-stage.json`, claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  fs.writeFileSync(claimPath, JSON.stringify({ ...claim, status: 'copying' }), { mode: 0o600 });
  for (const directory of execFileSync('/usr/bin/find', [path.join(staging, 'payload'), '-mindepth', '1', '-type', 'd'], { encoding: 'utf8' }).trim().split('\n')) fs.chmodSync(directory, 0o700);
  assert.throws(() => verifyProductPayload(path.join(staging, 'payload')), { code: 'payload_mode_mismatch' });
  const resumed = stageProductPayload({ homeRoot: home, candidatePayload: candidate.payload, staging });
  assert.equal(resumed.status, 'staged');
  assert.equal(verifyProductPayload(path.join(staging, 'payload')).packageId, candidate.manifest.packageId);
});

test('the update launcher and worker reset an inherited umask to 022 before running', () => {
  for (const name of ['product-home-update-worker.mjs', 'product-home-update-launcher.mjs']) {
    const source = fs.readFileSync(path.join(library, name), 'utf8');
    const umask = source.indexOf('process.umask(0o022)');
    assert.ok(umask > 0, `${name} sets umask 022`);
    const start = name.includes('worker') ? source.indexOf('await runHomeUpdateOperation(') : source.indexOf('spawn(process.execPath');
    assert.ok(start > umask, `${name} sets umask before starting work`);
  }
  // A child of a 077 parent observes 022 once the worker's first statement runs.
  const observed = execFileSync('/bin/sh', ['-c', `umask 077; "${process.execPath}" --input-type=module -e "process.umask(0o022); console.log(process.umask().toString(8))"`], { encoding: 'utf8' }).trim();
  assert.equal(observed, '22');
});

test('the home update maps payload_mode_mismatch to an owner message that names the cause', () => {
  const source = fs.readFileSync(path.join(library, 'product-home-update.js'), 'utf8');
  assert.match(source, /payload_mode_mismatch: 'The downloaded Home23 package was unpacked with the wrong file permissions \(umask\)/);
  assert.match(source, /PREFLIGHT_MESSAGES\[error\.code\] \?\?/);
});
