import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyPreparedMacApplication, prepareMacApplication, retainedPreviousPath } from '../../cli/lib/product-app-update.js';

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

test('an interrupted launch keeps the replacement stable for Gatekeeper and permits safe resume', t => {
  const f = fixture(t), calls = [];
  const pending = { ...f.dependencies, run: (tool, args) => {
    calls.push({ tool, args });
    if (args[0] === 'launch') throw Object.assign(new Error('replacement exited before starting'), { status: 75 });
    return '';
  } };
  assert.throws(() => applyPreparedMacApplication(f.input, pending), { code: 'application_launch_pending' });
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'new');
  assert.equal(readFileSync(join(f.previous, 'marker'), 'utf8'), 'old');
  assert.equal(existsSync(f.prepared), false);
  assert.equal(JSON.parse(readFileSync(f.claim, 'utf8')).phase, 'installedReplaced');
  assert.equal(calls.filter(call => call.args[0] === 'terminate').length, 1);
  assert.equal(calls.filter(call => call.args[0] === 'launch').length, 1);
  assert.equal(calls.find(call => call.tool === '/usr/bin/gktool').args[1], f.installed);
  const result = applyPreparedMacApplication(f.input, f.dependencies);
  assert.equal(result.status, 'reopened');
});

test('a pending or rejected installed Gatekeeper scan does not launch or restore another bundle at its path', t => {
  const f = fixture(t), calls = [];
  const blocked = { ...f.dependencies, run: (tool, args) => {
    calls.push({ tool, args });
    if (tool === '/usr/bin/gktool') throw Object.assign(new Error('Software has been altered'), { status: 70 });
    return '';
  } };
  assert.throws(() => applyPreparedMacApplication(f.input, blocked), { code: 'application_assessment_failed' });
  assert.equal(readFileSync(join(f.installed, 'marker'), 'utf8'), 'new');
  assert.equal(readFileSync(join(f.previous, 'marker'), 'utf8'), 'old');
  assert.equal(JSON.parse(readFileSync(f.claim, 'utf8')).phase, 'installedReplaced');
  assert.equal(calls.filter(call => call.args[0] === 'launch').length, 0);
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

function bundle(path, build, marker) {
  mkdirSync(join(path, 'Contents/Resources'), { recursive: true });
  writeFileSync(join(path, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleVersion</key><string>${build}</string></dict></plist>\n`);
  writeFileSync(join(path, 'marker'), marker);
}
test('a copy named by older code does not block the next swap', { skip: process.platform !== 'darwin' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'home23-app-prepare-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'Home23.app'), occupied = join(root, '.home23-previous-179.app');
  // Build 179 is installed; older code retained 178 under the name of the build replacing it.
  bundle(installed, 179, 'old'); bundle(occupied, 178, 'older');
  const run = (_tool, args) => {
    if (args[0] === '-x') {
      bundle(join(args[3], 'Home23/Home23.app'), 180, 'new');
      writeFileSync(join(args[3], 'Home23/Home23.app/Contents/Resources/home23-app-lifecycle'), 'tool');
    } else cpSync(args[0], args[1], { recursive: true });
    return '';
  };
  const prepare = () => prepareMacApplication({ archivePath: join(root, 'app.zip'), installedAppPath: installed, release },
    { run, verifyPreparedMacApplication: () => {} });
  const prepared = prepare();
  assert.equal(prepared.previousAppPath, occupied);
  const setAside = () => readdirSync(root).filter(name => /^\.home23-previous-179-[0-9a-f]{8}\.app$/.test(name));
  assert.equal(setAside().length, 1);
  assert.equal(readFileSync(join(root, setAside()[0], 'marker'), 'utf8'), 'older');
  assert.equal(existsSync(occupied), false);
  // A prepare resumed against its own claim sets nothing further aside.
  assert.equal(prepare().resumed, true);
  assert.equal(setAside().length, 1);
  const removed = [];
  const result = applyPreparedMacApplication({ ...prepared, release }, { removePaths: paths => removed.push(...paths),
    verifyPreparedMacApplication: ({ appPath }) => assert.equal(readFileSync(join(appPath, 'marker'), 'utf8'), 'new'),
    run: (_tool, args) => args[0] === 'launch' ? 'pid=123 build=180 path=Home23.app' : 'terminated' });
  assert.equal(result.status, 'reopened');
  assert.equal(readFileSync(join(installed, 'marker'), 'utf8'), 'new');
  assert.equal(readFileSync(join(occupied, 'marker'), 'utf8'), 'old');
  assert.deepEqual(removed, [join(root, setAside()[0])]);
});
