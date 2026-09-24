import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeUpdateStatus, requestHomeUpdate, runHomeUpdateOperation, updateDeliveryPaths } from '../../cli/lib/product-home-update.js';

function fixture(t) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'home23-update-contract-'))), home = join(parent, 'home');
  mkdirSync(join(home, 'runtime/home-update'), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, 'app'), { mode: 0o700 });
  mkdirSync(join(home, 'bin'), { mode: 0o700 });
  // A fixture runtime invokes this test's interpreter; a system/Homebrew node
  // executable cannot itself be relocated without its dynamic libraries.
  writeFileSync(join(home, 'bin/node'), `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o700 });
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const write = (file, value) => writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  const receipt = { schema: 'home23.product-install.v1', status: 'installed', homeRoot: home, appRoot: join(home, 'app'), packageId: 'old-package' };
  write(join(home, '.home23-install.json'), receipt);
  write(join(home, 'runtime/home-update/application.json'), { schema: 'home23.product-application.v1', homeRoot: home, applicationPath: join(parent, 'Home23.app'), version: '1.10', build: 165 });
  const operation = id => JSON.parse(readFileSync(join(home, `runtime/home-update/${id}.json`), 'utf8'));
  const setOperation = value => write(join(home, `runtime/home-update/${value.id}.json`), value);
  return { home, parent, receipt, write, operation, setOperation };
}
const release = { version: '2.0', appBuild: 180, packageId: 'next-package', compatibility: { minimumClientBuild: 165 } };
const input = (homeRoot, action, suffix = 'one', clientBuild = 180) => ({ homeRoot, action, idempotencyKey: `home-update-${suffix}`, principalId: 'user_owner', clientBuild });
const noLaunch = { launch: async () => {} };
const checkedChannel = { checkConfiguredRelease: async () => ({ status: 'available', release }) };
const unusedUpdater = {};
const unusedAppUpdater = {};
async function check(f) {
  const accepted = await requestHomeUpdate(input(f.home, 'check'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id },
    { channel: checkedChannel, updater: unusedUpdater, appUpdater: unusedAppUpdater });
}

test('external homes expand runtime in a private local cache and resume the same signed download', t => {
  const f = fixture(t), id = '12345678-1234-1234-1234-123456789abc';
  const cacheRoot = join(f.parent, 'cache');
  const deviceFor = path => path === f.home ? 2 : path === homedir() || path === cacheRoot ? 1 : 2;
  const options = { cacheRoot, deviceFor, release: { runtime: { bytes: 1024 } } };
  const first = updateDeliveryPaths(f.home, id, options);
  assert.equal(first.staging, join(f.parent, '.home.home23-delivery', `stage-${id}`));
  assert.equal(first.downloadDirectory, join(f.parent, '.home.home23-delivery', `download-${id}`));
  assert.equal(first.extractionDirectory, join(cacheRoot, `extraction-${id}`));
  assert.deepEqual(updateDeliveryPaths(f.home, id, options), first);

  const linkedCache = join(f.parent, 'linked-cache');
  symlinkSync(cacheRoot, linkedCache);
  assert.throws(() => updateDeliveryPaths(f.home, id, { ...options, cacheRoot: linkedCache }), /real home directory ancestors|symbolic links/);
});

test('parallel duplicate owner request launches once and preserves operation across status reads', async t => {
  const f = fixture(t); let launches = 0;
  const dependencies = { launch: async () => { launches++; } };
  const [a, b] = await Promise.all([requestHomeUpdate(input(f.home, 'check'), dependencies), requestHomeUpdate(input(f.home, 'check'), dependencies)]);
  assert.equal(a.operation.id, b.operation.id);
  assert.equal(launches, 1);
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).operation.id, a.operation.id);
  await assert.rejects(requestHomeUpdate(input(f.home, 'update'), dependencies), { code: 'idempotency_conflict' });
  await assert.rejects(requestHomeUpdate(input(f.home, 'check', 'another'), dependencies), { code: 'home_update_busy' });
});

test('unreachable signed release never reports up to date', async t => {
  const f = fixture(t), accepted = await requestHomeUpdate(input(f.home, 'check'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: { checkConfiguredRelease: async () => ({ status: 'unavailable' }) }, updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(status.state, 'unavailable'); assert.deepEqual(status.allowedActions, ['check']);
  assert.equal(status.operation.phase, 'completed'); assert.equal(status.availableRelease, null);
});

test('durable executor is detached and can finish after requesting process exits', async t => {
  const { spawnSync } = await import('node:child_process');
  const f = fixture(t);
  // The real retained executor loads the release module; missing channel is a
  // deterministic unavailable check requiring neither network nor a test home.
  const source = new URL('../../cli/lib/product-home-update.js', import.meta.url).href;
  const program = `import {requestHomeUpdate} from ${JSON.stringify(source)}; const state=await requestHomeUpdate(${JSON.stringify(input(f.home, 'check'))}); console.log(state.operation.id);`;
  const parent = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 15000 });
  assert.equal(parent.status, 0, parent.stderr);
  const id = parent.stdout.trim();
  assert.match(id, /^[a-f0-9-]{36}$/);
  let current;
  for (let i = 0; i < 100; i++) {
    current = f.operation(id);
    if (['completed', 'failed'].includes(current.phase)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(current.phase, 'completed'); assert.equal(current.check.status, 'unavailable');
  assert.notEqual(current.pid, process.pid);
  const recovery = spawnSync(join(current.executor, 'node'),
    [join(current.executor, 'product-update-recover.mjs'), '--home', f.home], { encoding: 'utf8', timeout: 15000 });
  assert.equal(recovery.status, 1, recovery.stderr);
  assert.equal(JSON.parse(recovery.stdout).reasons[0].code, 'update_not_found');
});

test('prepared update resumes after component failure without downloading or repeating home update', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  let downloads = 0, installs = 0, appCalls = 0;
  const priority = [];
  const dependencies = {
    workerPriority: background => priority.push(background),
    channel: { ...checkedChannel, prepareConfiguredRelease: async options => {
      downloads++; assert.ok(!options.staging.startsWith(f.home + '/'));
      assert.deepEqual(priority, [true]);
      return { release, packageId: release.packageId, appBuild: 180, candidatePayload: options.staging + '/payload', staging: options.staging,
        installedAppPath: join(f.parent, 'Home23.app'), preparedAppPath: join(f.parent, '.next.app'), lifecyclePath: join(f.parent, 'lifecycle') };
    } },
    updater: { readUpdateJournal: () => null, applyProductUpdate: async options => {
      installs++; assert.equal(options.admit, true); assert.equal(options.reuseVerifiedStage, true);
      assert.deepEqual(priority, [true, false]);
      f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
      return { ok: true, status: 'committed' };
    } },
    appUpdater: { applyPreparedMacApplication: async options => {
      appCalls++; assert.equal(options.lifecyclePath, join(f.parent, 'lifecycle'));
      if (appCalls === 1) throw new Error('Interrupted app replacement');
      return { status: 'reopened' };
    } },
    verifyReady: async () => ({ running: true }),
  };
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, dependencies);
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).operation.phase, 'failed');
  // This in-process injected executor has finished; real workers exit naturally.
  f.setOperation({ ...f.operation(accepted.operation.id), pid: null });
  const resumed = await requestHomeUpdate(input(f.home, 'resume', 'resume'), noLaunch);
  assert.equal(resumed.operation.id, accepted.operation.id);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, dependencies);
  const completed = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(completed.state, 'upToDate'); assert.equal(completed.availableRelease, null);
  assert.equal(completed.installedRelease.version, '2.0');
  assert.equal(downloads, 1); assert.equal(installs, 1); assert.equal(appCalls, 2);
  assert.deepEqual(priority, [true, false]);
});

test('preparation failure restores worker priority before offering resume', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  const priority = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    workerPriority: background => priority.push(background),
    channel: { prepareConfiguredRelease: async () => { throw new Error('Download interrupted'); } },
    updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
  assert.deepEqual(priority, [true, false]);
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).operation.phase, 'failed');
});

test('preparation status remains truthful after signed files are downloaded', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: { prepareConfiguredRelease: async () => {
      const status = homeUpdateStatus({ homeRoot: f.home });
      assert.equal(status.operation.phase, 'downloading');
      assert.match(status.message, /downloading and preparing/i);
      throw new Error('Preparation stopped');
    } }, updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
});

test('a preflight refusal publishes only safe reason codes and a path-free explanation', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => ({ ok: false, status: 'refused', reasons: [
      { code: 'unknown_state', message: 'Private path /secret/Jerry/conversations and credential XYZ', path: '/secret/Jerry/conversations' },
      { code: 'network_binding_receipt_mismatch', message: 'Private port and credential XYZ' },
    ] }) },
    appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.allowedActions, ['resume']);
  assert.equal(status.operation.errorCode, 'unknown_state');
  assert.deepEqual(status.operation.reasonCodes, ['unknown_state', 'network_binding_receipt_mismatch']);
  assert.match(status.message, /files the updater cannot classify/);
  assert.doesNotMatch(JSON.stringify(status), /secret|credential XYZ/);
  assert.doesNotMatch(JSON.stringify(f.operation(accepted.operation.id)), /secret|credential XYZ/);
});

test('a restored data-version refusal requires a fresh release check, not another stop and retry', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  let installs = 0;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => ({ phase: 'aborted' }), applyProductUpdate: async () => {
      installs++;
      return { ok: false, status: 'aborted', runningRestored: true, reasons: [
        { code: 'unsupported_data_version', message: 'Stored schema private-secret changed' },
      ] };
    } },
    appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(installs, 1);
  assert.equal(status.state, 'failed');
  assert.equal(status.operation.canResume, false);
  assert.equal(status.operation.errorCode, 'unsupported_data_version');
  assert.deepEqual(status.allowedActions, ['check']);
  assert.match(status.message, /Check for a newer Home23 release/);
  assert.doesNotMatch(JSON.stringify(status), /private-secret/);
  await assert.rejects(requestHomeUpdate(input(f.home, 'resume', 'same-release'), noLaunch), { code: 'home_update_busy' });
  const fresh = await requestHomeUpdate(input(f.home, 'check', 'fresh-release'), noLaunch);
  assert.notEqual(fresh.operation.id, accepted.operation.id);
});

test('newer phone can resume a compatibility refusal with its new build', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update', 165), noLaunch);
  const next = { ...release, compatibility: { minimumClientBuild: 180 } };
  let downloads = 0, installs = 0;
  const dependencies = {
    channel: { prepareConfiguredRelease: async () => {
      downloads++; return { release: next, packageId: next.packageId, appBuild: 180 };
    } },
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => {
      installs++; return { ok: true, status: 'committed' };
    } },
    appUpdater: { applyPreparedMacApplication: async () => ({ status: 'reopened' }) },
    verifyReady: async () => ({ running: true }),
  };
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, dependencies);
  assert.equal(homeUpdateStatus({ homeRoot: f.home, clientBuild: 165 }).state, 'incompatible');
  assert.equal(installs, 0);
  f.setOperation({ ...f.operation(accepted.operation.id), pid: null });
  await requestHomeUpdate(input(f.home, 'resume', 'resume', 180), noLaunch);
  assert.equal(f.operation(accepted.operation.id).clientBuild, 180);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, dependencies);
  assert.equal(homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 }).state, 'upToDate');
  assert.equal(downloads, 1); assert.equal(installs, 1);
});

test('failed readiness remains incomplete even after software and app replacement', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId }, runtimeCompleted: true, applicationCompleted: true });
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel, updater: unusedUpdater, appUpdater: unusedAppUpdater, verifyReady: async () => { throw new Error('API unreachable'); },
  });
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).operation.phase, 'failed');
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).state, 'failed');
});

test('a refused automatic recovery does not advertise an ineffective retry', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  let journal = null;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: { prepareConfiguredRelease: async () => ({ release, packageId: release.packageId }) },
    updater: { readUpdateJournal: () => journal, applyProductUpdate: async () => {
      journal = { phase: 'recovery_required', writersAdmitted: false };
      return { ok: false, status: 'recovery_required' };
    } },
    appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.equal(status.operation.canResume, false);
  assert.deepEqual(status.allowedActions, []);
  assert.match(status.message, /preserve your home/);
});
