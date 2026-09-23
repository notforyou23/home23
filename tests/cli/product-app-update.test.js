import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreparedMacApplication } from '../../cli/lib/product-app-update.js';

const release = { version: '2.0', appBuild: 180, packageId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), minimumOs: '27.0', arch: 'arm64' };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'home23-app-swap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suffix = `180-${release.packageId.slice(0, 12)}`;
  const installed = join(root, 'Home23.app'), prepared = join(root, `.home23-next-${suffix}.app`),
    previous = join(root, '.home23-previous-180.app'), lifecycle = join(root, `.home23-lifecycle-${suffix}`);
  mkdirSync(installed); mkdirSync(prepared);
  writeFileSync(join(installed, 'marker'), 'old'); writeFileSync(join(prepared, 'marker'), 'new');
  writeFileSync(lifecycle, 'tool');
  const claim = `${prepared}.json`;
  writeFileSync(claim, JSON.stringify({ schema: 'home23.prepared-app.v1', packageId: release.packageId,
    appBuild: release.appBuild, version: release.version, installedAppPath: installed,
    preparedAppPath: prepared, previousAppPath: previous, lifecyclePath: lifecycle, phase: 'prepared' }));
  const calls = [];
  const dependencies = {
    verifyPreparedMacApplication: ({ appPath }) => {
      assert.equal(readFileSync(join(appPath, 'marker'), 'utf8'), 'new');
    },
    run: (_tool, args) => { calls.push(args); return args[0] === 'launch' ? 'pid=123 build=180 path=Home23.app' : 'terminated'; },
  };
  const input = { installedAppPath: installed, preparedAppPath: prepared, lifecyclePath: lifecycle, release };
  return { installed, prepared, previous, claim, input, dependencies, calls };
}

test('swap preserves the previous app and replay recognizes already launched new app', t => {
  const f = fixture(t);
  const first = applyPreparedMacApplication(f.input, f.dependencies);
  assert.equal(first.status, 'reopened');
  assert.equal(readFileSync(join(f.previous, 'marker'), 'utf8'), 'old');
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'new');
  assert.equal(JSON.parse(readFileSync(f.claim, 'utf8')).phase, 'reopened');
  const second = applyPreparedMacApplication(f.input, f.dependencies);
  assert.equal(second.status, 'reopened');
  assert.equal(f.calls.filter(call => call[0] === 'terminate').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'launch').length, 2);
});

test('resume finishes after old bundle moved and installed path is absent', t => {
  const f = fixture(t);
  renameSync(f.installed, f.previous);
  const result = applyPreparedMacApplication(f.input, f.dependencies);
  assert.equal(result.status, 'reopened');
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'new');
  assert.equal(readFileSync(join(f.previous, 'marker'), 'utf8'), 'old');
  assert.equal(f.calls.filter(call => call[0] === 'terminate').length, 0);
});

test('resume recognizes new installed bundle when prepared path disappeared before journal persisted', t => {
  const f = fixture(t);
  renameSync(f.installed, f.previous);
  renameSync(f.prepared, f.installed);
  assert.equal(existsSync(f.prepared), false);
  const result = applyPreparedMacApplication(f.input, f.dependencies);
  assert.equal(result.status, 'reopened');
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'new');
  assert.equal(f.calls.filter(call => call[0] === 'terminate').length, 0);
});
