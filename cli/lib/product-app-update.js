/** Mac application preparation and swap. Invoke apply from a detached survivor. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyProductPayload } from './product-payload.js';

function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function run(file, args) { return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }); }
function appInfo(app) {
  const plist = join(app, 'Contents/Info.plist');
  if (!existsSync(plist)) throw fail('app_invalid', 'Application metadata is missing');
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
}
const CLAIM_SCHEMA = 'home23.prepared-app.v1';
function saveClaim(path, claim) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeSync(fd, JSON.stringify(claim) + '\n'); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), 'r');
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function readClaim(path, expected) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw fail('app_invalid', 'Prepared application claim is missing');
  }
  let claim;
  try { claim = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw fail('app_invalid', 'Prepared application claim is unreadable'); }
  if (claim.schema !== CLAIM_SCHEMA || !Object.entries(expected).every(([key, value]) => claim[key] === value)) {
    throw fail('app_busy', 'Prepared application claim belongs to another release or location');
  }
  return claim;
}
export function verifyPreparedMacApplication({ appPath, release, full = true }) {
  const app = resolve(appPath);
  const helper = join(app, 'Contents/Library/LoginItems/Home23Host.app');
  if (!lstatSync(app).isDirectory() || !lstatSync(helper).isDirectory()) {
    throw fail('app_invalid', 'Home23 app or embedded Host is missing');
  }
  const visible = appInfo(app), host = appInfo(helper);
  if (visible.CFBundleIdentifier !== 'com.regina6.home23.mac' || host.CFBundleIdentifier !== 'com.home23.host'
      || visible.CFBundleShortVersionString !== release.version || host.CFBundleShortVersionString !== release.version
      || Number(visible.CFBundleVersion) !== release.appBuild || Number(host.CFBundleVersion) !== release.appBuild
      || visible.LSMinimumSystemVersion !== release.minimumOs || host.LSMinimumSystemVersion !== release.minimumOs) {
    throw fail('app_invalid', 'Application identities or versions do not match the signed release');
  }
  const runtimePath = join(helper, 'Contents/Resources/Home23Runtime');
  const runtime = full ? verifyProductPayload(runtimePath) : JSON.parse(readFileSync(join(runtimePath, 'manifest.json'), 'utf8'));
  if (runtime.packageId !== release.packageId || runtime.sourceCommit !== release.sourceCommit) {
    throw fail('app_invalid', 'Embedded runtime does not match the signed release');
  }
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  run('/usr/sbin/spctl', ['--assess', '--type', 'execute', app]);
  const executable = join(app, 'Contents/MacOS', visible.CFBundleExecutable);
  const architectures = run('/usr/bin/lipo', ['-archs', executable]).trim().split(/\s+/);
  if (!architectures.includes(release.arch === 'x64' ? 'x86_64' : release.arch)) {
    throw fail('app_invalid', 'Application architecture does not match the signed release');
  }
  const entitlements = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', app]);
  const parsed = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: entitlements, encoding: 'utf8' }));
  if (parsed['com.apple.security.app-sandbox'] !== true) throw fail('app_invalid', 'Home23 sandbox entitlement is missing');
  return { appPath: app, helperPath: helper, packageId: runtime.packageId, appBuild: release.appBuild };
}

/** Extract verified channel ZIP and copy to a sibling of the installation before downtime. */
export function prepareMacApplication({ archivePath, installedAppPath, release }) {
  const installed = resolve(installedAppPath);
  if (basename(installed) !== 'Home23.app' || !existsSync(installed)) {
    throw fail('app_invalid', 'Installed Home23.app path is invalid');
  }
  const parent = dirname(installed);
  const suffix = `${release.appBuild}-${release.packageId.slice(0, 12)}`;
  const scratch = join(parent, `.home23-extract-${suffix}`);
  const prepared = join(parent, `.home23-next-${suffix}.app`);
  const claim = `${prepared}.json`;
  const lifecycle = join(parent, `.home23-lifecycle-${suffix}`);
  const previous = join(parent, `.home23-previous-${release.appBuild}.app`);
  const expected = { packageId: release.packageId, appBuild: release.appBuild, version: release.version,
    installedAppPath: installed, preparedAppPath: prepared, previousAppPath: previous, lifecyclePath: lifecycle };
  if (!existsSync(prepared) && existsSync(claim)) {
    const recorded = readClaim(claim, expected);
    if (existsSync(previous) && existsSync(installed)) {
      verifyPreparedMacApplication({ appPath: installed, release, full: false });
      return { ...expected, resumed: true };
    }
    if (recorded.phase !== 'prepared') throw fail('app_busy', 'An application swap is in progress; resume it before preparing again');
    rmSync(claim, { force: true });
    rmSync(lifecycle, { force: true });
  }
  if (existsSync(prepared)) {
    readClaim(claim, expected);
    try {
      verifyPreparedMacApplication({ appPath: prepared, release });
      if (!existsSync(lifecycle)) throw fail('app_invalid', 'Prepared lifecycle tool is missing');
      return { ...expected, resumed: true };
    } catch {
      rmSync(prepared, { recursive: true, force: true });
      rmSync(claim, { force: true });
      rmSync(lifecycle, { force: true });
    }
  }
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { mode: 0o700 });
  try {
    run('/usr/bin/ditto', ['-x', '-k', resolve(archivePath), scratch]);
    const candidate = join(scratch, 'Home23/Home23.app');
    run('/usr/bin/ditto', [candidate, prepared]);
    verifyPreparedMacApplication({ appPath: prepared, release });
    const sourceTool = join(prepared, 'Contents/Resources/home23-app-lifecycle');
    if (!existsSync(sourceTool)) throw fail('app_invalid', 'Application lifecycle tool is missing');
    copyFileSync(sourceTool, lifecycle);
    chmodSync(lifecycle, 0o700);
    saveClaim(claim, { schema: CLAIM_SCHEMA, ...expected, phase: 'prepared' });
  } catch (error) {
    rmSync(prepared, { recursive: true, force: true });
    rmSync(lifecycle, { force: true });
    rmSync(claim, { force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { ...expected, resumed: false };
}

/** No database rollback: only the Mac bundle is restored if the new one cannot open. */
export function applyPreparedMacApplication({ installedAppPath, preparedAppPath, lifecyclePath, release, relaunch = true }, dependencies = {}) {
  const inspect = dependencies.verifyPreparedMacApplication || verifyPreparedMacApplication;
  const execute = dependencies.run || run;
  const installed = resolve(installedAppPath), prepared = resolve(preparedAppPath);
  if (basename(installed) !== 'Home23.app' || dirname(installed) !== dirname(prepared)) {
    throw fail('app_invalid', 'Application swap must use an adjacent Home23.app');
  }
  const suffix = `${release.appBuild}-${release.packageId.slice(0, 12)}`;
  const expectedLifecycle = join(dirname(installed), `.home23-lifecycle-${suffix}`);
  const claim = `${prepared}.json`;
  const previous = join(dirname(installed), `.home23-previous-${release.appBuild}.app`);
  if (resolve(lifecyclePath) !== expectedLifecycle) throw fail('app_invalid', 'Application lifecycle path changed');
  const expected = { packageId: release.packageId, appBuild: release.appBuild, version: release.version,
    installedAppPath: installed, preparedAppPath: prepared, previousAppPath: previous, lifecyclePath: expectedLifecycle };
  let state = readClaim(claim, expected);
  const worker = existsSync(lifecyclePath) ? lifecyclePath : join(installed, 'Contents/Resources/home23-app-lifecycle');
  if (!existsSync(worker)) throw fail('app_invalid', 'Application lifecycle tool is missing');
  const previousPresent = existsSync(previous), installedPresent = existsSync(installed), preparedPresent = existsSync(prepared);
  if (!previousPresent) {
    if (!installedPresent || !preparedPresent) throw fail('app_invalid', 'Application swap inputs are incomplete');
    inspect({ appPath: prepared, release, full: false });
    state = { ...state, phase: 'terminating' }; saveClaim(claim, state);
    execute(worker, ['terminate', installed, String(release.appBuild)]);
    renameSync(installed, previous);
    state = { ...state, phase: 'previousMoved' }; saveClaim(claim, state);
  } else if (installedPresent && preparedPresent) {
    throw fail('app_busy', 'Application swap has conflicting installed and prepared bundles');
  }
  let launchEvidence = null;
  try {
    if (!existsSync(installed)) {
      if (!existsSync(prepared)) throw fail('app_invalid', 'Both installed and prepared applications are missing');
      inspect({ appPath: prepared, release, full: false });
      renameSync(prepared, installed);
      state = { ...state, phase: 'installedReplaced' }; saveClaim(claim, state);
    } else {
      inspect({ appPath: installed, release, full: false });
    }
    if (relaunch) {
      launchEvidence = execute(worker, ['launch', installed, String(release.appBuild)]).trim();
      state = { ...state, phase: 'reopened', launchEvidence }; saveClaim(claim, state);
    }
  } catch (error) {
    if (existsSync(previous)) {
      try {
        if (existsSync(installed)) {
          execute(worker, ['terminate', installed, String(release.appBuild)]);
          if (!existsSync(prepared)) renameSync(installed, prepared);
        }
        if (!existsSync(installed)) renameSync(previous, installed);
        state = { ...state, phase: 'prepared', launchEvidence: null }; saveClaim(claim, state);
        execute(worker, ['launch', installed, String(appInfo(installed).CFBundleVersion)]);
      } catch { /* Preserve original failure and recovery files. */ }
    }
    throw error;
  }
  return { status: relaunch ? 'reopened' : 'replaced', appPath: installed, previousAppPath: previous,
    appBuild: release.appBuild, launchEvidence };
}
