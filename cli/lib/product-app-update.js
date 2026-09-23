/** Mac application preparation and swap. Invoke apply from a detached survivor. */
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { verifyProductPayload } from './product-payload.js';

function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function run(file, args) { return execFileSync(file, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 }); }
function appInfo(app) {
  const plist = join(app, 'Contents/Info.plist');
  if (!existsSync(plist)) throw fail('app_invalid', 'Application metadata is missing');
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]));
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
  if (!existsSync(prepared) && existsSync(claim)) {
    const recorded = JSON.parse(readFileSync(claim, 'utf8'));
    if (recorded.packageId !== release.packageId || recorded.appBuild !== release.appBuild) {
      throw fail('app_busy', 'A different prepared application claim occupies this update path');
    }
    rmSync(claim, { force: true });
    rmSync(lifecycle, { force: true });
  }
  if (existsSync(prepared)) {
    const recorded = existsSync(claim) ? JSON.parse(readFileSync(claim, 'utf8')) : null;
    if (recorded?.packageId !== release.packageId || recorded?.appBuild !== release.appBuild) {
      throw fail('app_busy', 'A different prepared application occupies this update path');
    }
    try {
      verifyPreparedMacApplication({ appPath: prepared, release });
      if (!existsSync(lifecycle)) throw fail('app_invalid', 'Prepared lifecycle tool is missing');
      return { installedAppPath: installed, preparedAppPath: prepared, lifecyclePath: lifecycle,
        appBuild: release.appBuild, packageId: release.packageId, resumed: true };
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
    writeFileSync(claim, JSON.stringify({ schema: 'home23.prepared-app.v1', packageId: release.packageId,
      appBuild: release.appBuild }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    rmSync(prepared, { recursive: true, force: true });
    rmSync(lifecycle, { force: true });
    rmSync(claim, { force: true });
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return { installedAppPath: installed, preparedAppPath: prepared, lifecyclePath: lifecycle,
    appBuild: release.appBuild, packageId: release.packageId, resumed: false };
}

/** No database rollback: only the Mac bundle is restored if the new one cannot open. */
export function applyPreparedMacApplication({ installedAppPath, preparedAppPath, lifecyclePath, release, relaunch = true }) {
  const installed = resolve(installedAppPath), prepared = resolve(preparedAppPath);
  if (basename(installed) !== 'Home23.app' || dirname(installed) !== dirname(prepared)) {
    throw fail('app_invalid', 'Application swap must use an adjacent Home23.app');
  }
  const suffix = `${release.appBuild}-${release.packageId.slice(0, 12)}`;
  const expectedLifecycle = join(dirname(installed), `.home23-lifecycle-${suffix}`);
  const claim = `${prepared}.json`;
  if (resolve(lifecyclePath) !== expectedLifecycle || !existsSync(lifecyclePath)
      || !existsSync(claim) || JSON.parse(readFileSync(claim, 'utf8')).packageId !== release.packageId) {
    throw fail('app_invalid', 'Prepared application claim is missing or changed');
  }
  verifyPreparedMacApplication({ appPath: prepared, release, full: false });
  const previous = join(dirname(installed), `.home23-previous-${release.appBuild}.app`);
  if (existsSync(previous)) throw fail('app_busy', 'Previous application recovery copy already exists');
  run(lifecyclePath, ['terminate', installed, String(release.appBuild)]);
  renameSync(installed, previous);
  let launchEvidence = null;
  try {
    renameSync(prepared, installed);
    if (relaunch) launchEvidence = run(lifecyclePath, ['launch', installed, String(release.appBuild)]).trim();
  } catch (error) {
    if (existsSync(installed)) renameSync(installed, prepared);
    renameSync(previous, installed);
    try { run(lifecyclePath, ['launch', installed, String(appInfo(installed).CFBundleVersion)]); } catch { /* Preserve original failure. */ }
    throw error;
  }
  rmSync(claim, { force: true });
  rmSync(lifecyclePath, { force: true });
  return { status: relaunch ? 'reopened' : 'replaced', appPath: installed, previousAppPath: previous,
    appBuild: release.appBuild, launchEvidence };
}
