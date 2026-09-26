import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreparedMacApplication, retainedPreviousPath } from '../../cli/lib/product-app-update.js';

const release = { version: '2.0', appBuild: 180, packageId: 'a'.repeat(64), sourceCommit: 'b'.repeat(40), minimumOs: '27.0', arch: 'arm64' };
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-app-swap-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const suffix = `180-${release.packageId.slice(0, 12)}`;
  const installed = join(root, 'Home23.app'), prepared = join(root, `.home23-next-${suffix}.app`),
    // Build 179 is installed; the retained copy is named after the build it holds.
    previous = join(root, '.home23-previous-179.app'), lifecycle = join(root, `.home23-lifecycle-${suffix}`);
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
  return { root, installed, prepared, previous, claim, input, dependencies, calls };
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

test('a verified swap keeps only the newest retained copy', t => {
  const f = fixture(t);
  const older = join(f.root, '.home23-previous-170.app'), linked = join(f.root, '.home23-previous-160.app'), elsewhere = join(f.root, 'elsewhere');
  mkdirSync(older); mkdirSync(elsewhere); symlinkSync(elsewhere, linked);
  writeFileSync(join(f.root, '.home23-previous-150.app'), 'not a bundle');
  const removed = [];
  const result = applyPreparedMacApplication(f.input, { ...f.dependencies, removePaths: paths => removed.push(...paths) });
  assert.equal(result.status, 'reopened');
  assert.equal(result.previousAppPath, f.previous);
  assert.deepEqual(removed, [older]);
  assert.equal(readFileSync(join(f.previous, 'marker'), 'utf8'), 'old');
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'new');
});

test('a failed swap removes no retained copy', t => {
  const f = fixture(t);
  mkdirSync(join(f.root, '.home23-previous-170.app'));
  const removed = [];
  const failing = { ...f.dependencies, removePaths: paths => removed.push(...paths),
    run: (_tool, args) => { if (args[0] === 'launch' && args[2] === '180') throw new Error('launch failed'); return 'ok'; } };
  assert.throws(() => applyPreparedMacApplication(f.input, failing), /launch failed/);
  assert.deepEqual(removed, []);
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'old');
});

test('the retained copy is named after the installed build unless a claim recorded it', { skip: process.platform !== 'darwin' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-app-previous-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'Home23.app'), claim = join(root, '.home23-next-180-aaaaaaaaaaaa.app.json');
  mkdirSync(join(installed, 'Contents'), { recursive: true });
  writeFileSync(join(installed, 'Contents/Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleVersion</key><string>179</string></dict></plist>\n');
  assert.equal(retainedPreviousPath(installed, claim), join(root, '.home23-previous-179.app'));
  writeFileSync(claim, JSON.stringify({ previousAppPath: join(root, '.home23-previous-180.app') }));
  assert.equal(retainedPreviousPath(installed, claim), join(root, '.home23-previous-180.app'));
  writeFileSync(claim, JSON.stringify({ previousAppPath: '/Applications/Home23.app' }));
  assert.equal(retainedPreviousPath(installed, claim), join(root, '.home23-previous-179.app'));
});
