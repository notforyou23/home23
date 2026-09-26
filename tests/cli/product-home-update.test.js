import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeUpdateStatus, pruneUpdateDelivery, requestHomeUpdate, runHomeUpdateOperation, updateDeliveryPaths } from '../../cli/lib/product-home-update.js';

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

test('download progress is durably sampled and a failure retains the latest progress', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  const id = accepted.operation.id;
  let clock = 0;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    progressNow: () => clock,
    channel: { prepareConfiguredRelease: async ({ onProgress }) => {
      for (const [elapsed, copied, durable] of [
        [100, 10, null], [1_000, 20, null], [2_000, 40, 0.4], [2_100, 80, 0.4],
      ]) {
        clock = elapsed;
        onProgress({ bytesCopied: copied, bytesTotal: 100 });
        assert.equal(f.operation(id).progress, durable);
      }
      throw new Error('Download interrupted');
    } }, updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
  const saved = f.operation(id);
  assert.equal(saved.phase, 'failed');
  assert.equal(saved.progress, 0.8);
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).operation.progress, 0.8);
  f.setOperation({ ...saved, pid: null });
  await requestHomeUpdate(input(f.home, 'resume', 'resume'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    progressNow: () => 0,
    channel: { prepareConfiguredRelease: async () => {
      assert.equal(f.operation(id).phase, 'downloading');
      assert.equal(f.operation(id).progress, null);
      throw new Error('Download interrupted again');
    } }, updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
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

test('a resumed operation that completes drops the error fields of its earlier refusal', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  f.setOperation({ ...f.operation(id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  let installs = 0;
  const dependencies = {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => {
      installs++;
      if (installs === 1) return { ok: false, status: 'refused', reasons: [
        { code: 'linked_state_path', message: 'A link points outside the home' }, { code: 'external_reference', message: 'An external reference' },
      ] };
      return { ok: true, status: 'committed' };
    } },
    appUpdater: { applyPreparedMacApplication: async () => ({ status: 'reopened' }) },
    verifyReady: async () => ({ running: true }),
  };
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, dependencies);
  const failed = f.operation(id);
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.errorCode, 'linked_state_path');
  assert.deepEqual(failed.reasonCodes, ['linked_state_path', 'external_reference']);
  assert.equal(homeUpdateStatus({ homeRoot: f.home }).operation.errorCode, 'linked_state_path');

  f.setOperation({ ...failed, pid: null });
  await requestHomeUpdate(input(f.home, 'resume', 'resume'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, dependencies);
  const completed = f.operation(id);
  assert.equal(installs, 2);
  assert.equal(completed.phase, 'completed');
  assert.equal('errorCode' in completed, false, JSON.stringify(completed));
  assert.equal('reasonCodes' in completed, false, JSON.stringify(completed));
  const status = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(status.state, 'upToDate');
  assert.equal(status.operation.errorCode, null);
  assert.deepEqual(status.operation.reasonCodes, []);
});

test('a failed operation keeps its error fields in the saved record', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  f.setOperation({ ...f.operation(id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => ({ ok: false, status: 'refused', reasons: [
      { code: 'linked_state_path', message: 'A link points outside the home' }, { code: 'external_reference', message: 'An external reference' },
    ] }) },
    appUpdater: unusedAppUpdater,
  });
  const saved = f.operation(id);
  assert.equal(saved.phase, 'failed');
  assert.equal(saved.errorCode, 'linked_state_path');
  assert.deepEqual(saved.reasonCodes, ['linked_state_path', 'external_reference']);
  const status = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(status.operation.errorCode, 'linked_state_path');
  assert.deepEqual(status.operation.reasonCodes, ['linked_state_path', 'external_reference']);
});

test('a progress persist without a phase changes nothing but progress in the saved record', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  let clock = 0;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    progressNow: () => clock,
    channel: { prepareConfiguredRelease: async ({ onProgress }) => {
      const before = f.operation(id);
      assert.equal(before.phase, 'downloading');
      clock = 5_000; onProgress({ bytesCopied: 50, bytesTotal: 100 });
      const during = f.operation(id);
      assert.equal(during.progress, 0.5);
      assert.deepEqual({ ...during, progress: before.progress, updatedAt: before.updatedAt }, before);
      throw new Error('Download interrupted');
    } }, updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
  assert.equal(f.operation(id).phase, 'failed');
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
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: fresh.operation.id },
    { channel: checkedChannel, updater: unusedUpdater, appUpdater: unusedAppUpdater });
  const sameOffer = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(sameOffer.state, 'incompatible');
  assert.equal(sameOffer.compatibility.isCompatible, false);
  assert.deepEqual(sameOffer.allowedActions, ['check']);
  assert.equal(sameOffer.availableRelease.packageId, release.packageId);
  await assert.rejects(requestHomeUpdate(input(f.home, 'update', 'retry-refused-package'), noLaunch), { code: 'home_update_busy' });
  assert.equal(installs, 1);

  const newer = await requestHomeUpdate(input(f.home, 'check', 'newer-release'), noLaunch);
  const nextRelease = { ...release, packageId: 'different-package' };
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: newer.operation.id }, {
    channel: { checkConfiguredRelease: async () => ({ status: 'available', release: nextRelease }) },
    updater: unusedUpdater, appUpdater: unusedAppUpdater,
  });
  const newOffer = homeUpdateStatus({ homeRoot: f.home });
  assert.equal(newOffer.state, 'available');
  assert.deepEqual(newOffer.allowedActions, ['check', 'update']);
  assert.equal(f.operation(newer.operation.id).blockedPackageId, null);
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

const preparedApp = { installedAppPath: join(tmpdir(), 'unused/Home23.app'), preparedAppPath: join(tmpdir(), 'unused/.next.app'), lifecyclePath: join(tmpdir(), 'unused/lifecycle') };
const stillStarting = { ok: true, status: 'deferred', reasons: [{ code: 'candidate_starting', message: 'This home is still starting.' }] };

test('a still-starting candidate is resumed automatically until it commits', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId, ...preparedApp } });
  let journal = null, resumes = 0;
  const slept = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => journal,
      applyProductUpdate: async () => { journal = { phase: 'writers_admitted', writersAdmitted: true, startStatus: 'starting' }; return stillStarting; },
      resumeProductUpdate: async () => {
        resumes += 1;
        if (resumes < 2) return stillStarting;
        journal = { phase: 'committed', writersAdmitted: true };
        f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
        return { ok: true, status: 'committed' };
      } },
    appUpdater: { applyPreparedMacApplication: async () => ({ status: 'reopened' }) },
    verifyReady: async () => ({ running: true }),
    sleep: async ms => { slept.push(ms); },
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'upToDate');
  assert.equal(status.operation.phase, 'completed');
  assert.equal(resumes, 2);
  assert.deepEqual(slept, [5000, 7500]);
});

test('a candidate still starting at the deadline fails as resumable with a truthful message', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId, ...preparedApp } });
  let journal = null, resumes = 0, clock = 0;
  const slept = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => journal,
      applyProductUpdate: async () => { journal = { phase: 'writers_admitted', writersAdmitted: true, startStatus: 'starting' }; return stillStarting; },
      resumeProductUpdate: async () => { resumes += 1; return stillStarting; } },
    appUpdater: unusedAppUpdater, verifyReady: async () => ({ running: true }),
    clock: () => clock, sleep: async ms => { slept.push(ms); clock += ms; }, startingWaitMs: 30000,
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.equal(status.operation.errorCode, 'candidate_starting');
  assert.equal(status.operation.canResume, true);
  assert.deepEqual(status.allowedActions, ['resume']);
  assert.match(status.message, /still starting/);
  assert.equal(resumes, 4);
  assert.deepEqual(slept, [5000, 7500, 10000, 7500]);
});

test('a transient readiness probe timeout re-probes until the home reads ready', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId }, runtimeCompleted: true, applicationCompleted: true });
  let probes = 0;
  const slept = [];
  const online = [{ name: 'home23-milo', status: 'online', owned: true }];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel, updater: unusedUpdater, appUpdater: unusedAppUpdater,
    probeReadiness: async () => {
      probes += 1;
      return probes < 3
        ? { ok: true, status: 'degraded', desiredRunning: true, processes: online, readiness: { ready: false, issues: ['Resident engine (milo) is not responding from this installation yet.'] } }
        : { ok: true, status: 'ready', desiredRunning: true, processes: online, readiness: { ready: true, issues: [] } };
    },
    sleep: async ms => { slept.push(ms); },
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'upToDate');
  assert.match(status.message, /ready/);
  assert.equal(probes, 3);
  assert.deepEqual(slept, [5000, 7500]);
});

test('a home still reconnecting at the readiness deadline fails as resumable', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId }, runtimeCompleted: true, applicationCompleted: true });
  let probes = 0, clock = 0;
  const slept = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel, updater: unusedUpdater, appUpdater: unusedAppUpdater,
    probeReadiness: async () => { probes += 1; return { ok: true, status: 'starting', desiredRunning: true,
      processes: [{ name: 'home23-milo', status: 'online', owned: true }], readiness: { ready: false, issues: ['Resident engine (milo) is not responding from this installation yet.'] } }; },
    clock: () => clock, sleep: async ms => { slept.push(ms); clock += ms; }, readinessWaitMs: 30000,
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.equal(status.operation.errorCode, 'home_unreachable');
  assert.equal(status.operation.canResume, true);
  assert.equal(probes, 5);
  assert.deepEqual(slept, [5000, 7500, 10000, 7500]);
});

test('a failed home service fails the reconnect on the first probe', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId }, runtimeCompleted: true, applicationCompleted: true });
  let probes = 0;
  const slept = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel, updater: unusedUpdater, appUpdater: unusedAppUpdater,
    probeReadiness: async () => { probes += 1; return { ok: true, status: 'degraded', desiredRunning: true,
      processes: [{ name: 'home23-milo', status: 'errored', owned: true }], readiness: { ready: false, issues: [] } }; },
    sleep: async ms => { slept.push(ms); },
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.equal(status.operation.errorCode, 'home_unreachable');
  assert.equal(probes, 1);
  assert.deepEqual(slept, []);
});

test('a refused automatic recovery does not advertise an ineffective retry', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  let journal = null;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: { prepareConfiguredRelease: async () => ({ release, packageId: release.packageId }) },
    updater: { readUpdateJournal: () => journal, applyProductUpdate: async () => {
      journal = { phase: 'recovery_required', writersAdmitted: false, reasons: [{ code: 'recovery_required', message: 'Private /secret path' }] };
      return { ok: false, status: 'recovery_required' };
    } },
    appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.equal(status.operation.canResume, false);
  assert.deepEqual(status.allowedActions, []);
  assert.match(status.message, /preserve your home/);
  assert.equal(status.operation.errorCode, 'local_recovery_required');
  assert.deepEqual(status.operation.reasonCodes, ['recovery_required']);
  assert.doesNotMatch(JSON.stringify(status), /secret/);
  await assert.rejects(requestHomeUpdate(input(f.home, 'recover', 'recover-refused'), noLaunch), { code: 'home_update_busy' });
});

/** An update whose journal fenced before switching, with the updater's classification. */
async function fencedUpdate(t, recovery) {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  f.setOperation({ ...f.operation(id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  const journal = { phase: 'recovery_required', writersAdmitted: false,
    reasons: [{ code: 'writer_stop_incomplete', message: 'x' }, { code: 'running_restore_failed', message: 'y' }] };
  let fenced = false;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => fenced ? journal : null, productRecoveryFor: () => recovery,
      applyProductUpdate: async () => { fenced = true; return { ok: false, status: 'recovery_required', reasons: journal.reasons }; } },
    appUpdater: unusedAppUpdater,
  });
  f.setOperation({ ...f.operation(id), pid: null });
  return { f, id, journal };
}

test('a nothing-switched recovery offers recover and resume and publishes its reason codes', async t => {
  const { f, id } = await fencedUpdate(t, { available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete', 'running_restore_failed'] });
  const saved = f.operation(id);
  assert.equal(saved.requiresLocalRecovery, true);
  assert.equal(saved.recoverable, true);
  assert.equal(saved.retryable, true);
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.allowedActions, ['recover', 'resume']);
  assert.equal(status.operation.canResume, true);
  assert.equal(status.operation.errorCode, 'local_recovery_required');
  assert.deepEqual(status.operation.reasonCodes, ['writer_stop_incomplete', 'running_restore_failed']);
  assert.match(status.message, /Recover returns it to service; Resume tries the update again/);
});

test('a recoverable but unretryable recovery offers recover only', async t => {
  const { f } = await fencedUpdate(t, { available: true, restore: true, retry: false, reasonCodes: ['unsupported_data_version'] });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.deepEqual(status.allowedActions, ['recover']);
  assert.equal(status.operation.canResume, false);
  await assert.rejects(requestHomeUpdate(input(f.home, 'resume', 'resume-refused'), noLaunch), { code: 'home_update_busy' });
});

test('recover returns the home to service and then offers resume', async t => {
  const { f, id } = await fencedUpdate(t, { available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete'] });
  const queued = await requestHomeUpdate(input(f.home, 'recover', 'recover'), noLaunch);
  assert.equal(queued.operation.id, id);
  let recovers = 0;
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: { prepareConfiguredRelease: async () => { throw new Error('recover must not download'); } },
    updater: { recoverProductUpdate: async ({ homeRoot }) => {
      recovers++; assert.equal(homeRoot, f.home);
      return { ok: false, status: 'aborted', runningRestored: true, toPackageId: release.packageId,
        reasons: [{ code: 'writer_stop_incomplete', message: 'x' }, { code: 'recovered_by_owner', message: 'z' }] };
    } },
    appUpdater: unusedAppUpdater,
  });
  assert.equal(recovers, 1);
  const saved = f.operation(id);
  assert.equal(saved.requiresLocalRecovery, false);
  assert.equal(saved.errorCode, 'update_recovered');
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.allowedActions, ['resume']);
  assert.equal(status.operation.canResume, true);
  assert.match(status.message, /running again on its current Home23 version\. Resume to try the update again/);
});

test('recovering a release that cannot run this home asks for a newer release', async t => {
  const { f, id } = await fencedUpdate(t, { available: true, restore: true, retry: false, reasonCodes: ['unsupported_data_version'] });
  await requestHomeUpdate(input(f.home, 'recover', 'recover'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel,
    updater: { recoverProductUpdate: async () => ({ ok: false, status: 'aborted', runningRestored: true, toPackageId: release.packageId,
      reasons: [{ code: 'unsupported_data_version', message: 'x' }, { code: 'recovered_by_owner', message: 'z' }] }) },
    appUpdater: unusedAppUpdater,
  });
  const saved = f.operation(id);
  assert.equal(saved.requiresNewRelease, true);
  assert.equal(saved.blockedPackageId, release.packageId);
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.deepEqual(status.allowedActions, ['check']);
  assert.match(status.message, /Check for a newer Home23 release/);
});

test('a recover that throws publishes only the fixed local recovery copy', async t => {
  const { f, id } = await fencedUpdate(t, { available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete'] });
  await requestHomeUpdate(input(f.home, 'recover', 'recover'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel,
    updater: {
      recoverProductUpdate: async () => { throw new Error('EACCES: permission denied, open /secret/home/journal.json'); },
      productRecoveryFor: () => ({ available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete'] }),
    },
    appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.deepEqual(status.allowedActions, ['recover', 'resume']);
  assert.equal(status.operation.errorCode, 'local_recovery_required');
  assert.doesNotMatch(JSON.stringify(status), /secret|EACCES/);
  assert.doesNotMatch(JSON.stringify(f.operation(id)), /secret|EACCES/);
});

test('a failed recover keeps local recovery and stays recoverable', async t => {
  const { f, id } = await fencedUpdate(t, { available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete'] });
  await requestHomeUpdate(input(f.home, 'recover', 'recover'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel,
    updater: {
      recoverProductUpdate: async () => ({ ok: false, status: 'recovery_required', reasons: [{ code: 'writer_stop_incomplete', message: 'x' }, { code: 'running_restore_failed', message: 'y' }] }),
      productRecoveryFor: () => ({ available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete', 'running_restore_failed'] }),
    },
    appUpdater: unusedAppUpdater,
  });
  const saved = f.operation(id);
  assert.equal(saved.phase, 'failed');
  assert.equal(saved.requiresLocalRecovery, true);
  assert.equal(saved.errorCode, 'local_recovery_required');
  assert.deepEqual(homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 }).allowedActions, ['recover', 'resume']);
});

test('a resumed local recovery clears its flags while it runs', async t => {
  const { f, id, journal } = await fencedUpdate(t, { available: true, restore: true, retry: true, reasonCodes: ['writer_stop_incomplete'] });
  await requestHomeUpdate(input(f.home, 'resume', 'resume'), noLaunch);
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => journal, resumeProductUpdate: async () => {
      const running = f.operation(id);
      assert.equal(running.requiresLocalRecovery, undefined);
      assert.equal(running.recoverable, undefined);
      f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
      return { ok: true, status: 'committed' };
    } },
    appUpdater: { applyPreparedMacApplication: async () => ({ status: 'reopened' }) },
    verifyReady: async () => ({ running: true }),
  });
  assert.equal(f.operation(id).phase, 'completed');
  assert.equal(homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 }).state, 'upToDate');
});

test('a writer_stop_incomplete abort is resumable with a path-free message', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch);
  f.setOperation({ ...f.operation(accepted.operation.id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: accepted.operation.id }, {
    channel: checkedChannel,
    updater: { readUpdateJournal: () => ({ phase: 'aborted', runningRestored: true }), applyProductUpdate: async () => ({ ok: false, status: 'aborted', runningRestored: true,
      reasons: [{ code: 'writer_stop_incomplete', message: 'Services at /secret/home did not stop', writers: ['home23-milo'] }] }) },
    appUpdater: unusedAppUpdater,
  });
  const status = homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 });
  assert.equal(status.state, 'failed');
  assert.deepEqual(status.allowedActions, ['resume']);
  assert.equal(status.operation.errorCode, 'writer_stop_incomplete');
  assert.deepEqual(status.operation.reasonCodes, ['writer_stop_incomplete']);
  assert.match(status.message, /restarted and nothing changed/);
  assert.doesNotMatch(JSON.stringify(status), /secret/);
});

test('a resume whose launch fails reports only its own error', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  f.setOperation({ ...f.operation(id), phase: 'failed', pid: null, errorCode: 'linked_state_path',
    reasonCodes: ['linked_state_path', 'external_reference'], message: 'A home state link points outside its approved location.' });
  let queued = null;
  const status = await requestHomeUpdate(input(f.home, 'resume', 'resume'), { launch: async operation => {
    queued = f.operation(operation.id);
    throw Object.assign(new Error('x'), { code: 'spawn_failed' });
  } });
  assert.equal(queued.phase, 'queued');
  assert.equal('errorCode' in queued, false);
  assert.equal('reasonCodes' in queued, false);
  const saved = f.operation(id);
  assert.equal(saved.errorCode, 'spawn_failed');
  assert.deepEqual(saved.reasonCodes, []);
  assert.equal(status.operation.errorCode, 'spawn_failed');
  assert.deepEqual(status.operation.reasonCodes, []);
  assert.deepEqual(status.allowedActions, ['resume']);
});

test('completing an operation removes executors of finished operations and earlier attempts', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  f.setOperation({ ...f.operation(id), prepared: { release, packageId: release.packageId,
    candidatePayload: join(f.parent, 'candidate'), staging: join(f.parent, 'stage') } });
  let installs = 0;
  const removed = [];
  const dependencies = {
    channel: checkedChannel, removePaths: paths => removed.push(...paths),
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => {
      if (++installs === 1) return { ok: false, status: 'refused', reasons: [{ code: 'database_busy', message: 'busy' }] };
      f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
      return { ok: true, status: 'committed' };
    } },
    appUpdater: { applyPreparedMacApplication: async () => ({ status: 'reopened' }) },
    verifyReady: async () => ({ running: true }),
  };
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, dependencies);
  f.setOperation({ ...f.operation(id), pid: null });
  await requestHomeUpdate(input(f.home, 'resume', 'resume'), noLaunch);
  assert.equal(f.operation(id).attempt, 2);
  const directory = join(f.home, 'runtime/home-update');
  const finished = '11111111-1111-1111-1111-111111111111', live = '22222222-2222-2222-2222-222222222222';
  f.setOperation({ schema: 'home23.home-update.v1', id: finished, homeRoot: f.home, phase: 'completed', pid: null });
  f.setOperation({ schema: 'home23.home-update.v1', id: live, homeRoot: f.home, phase: 'downloading', pid: process.ppid });
  for (const name of [`executor-${id}-1`, `executor-${id}-2`, `executor-${finished}-1`, `executor-${live}-1`, 'executor-not-an-operation']) {
    mkdirSync(join(directory, name), { mode: 0o700 });
  }
  symlinkSync(join(directory, `executor-${finished}-1`), join(directory, `executor-${'3'.repeat(8)}-3333-3333-3333-${'3'.repeat(12)}-1`));
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, dependencies);
  assert.equal(f.operation(id).phase, 'completed');
  assert.deepEqual(removed.sort(), [join(directory, `executor-${finished}-1`), join(directory, `executor-${id}-1`)].sort());
});

test('a completed update prunes its delivery download and stage and older deliveries', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  const delivery = join(f.parent, '.home.home23-delivery');
  const older = '44444444-4444-4444-4444-444444444444', held = '55555555-5555-5555-5555-555555555555';
  mkdirSync(delivery, { mode: 0o700 });
  for (const name of [`download-${id}`, `stage-${id}`, `download-${older}`, `stage-${older}`, `stage-${held}`, `download-${held}`]) mkdirSync(join(delivery, name));
  writeFileSync(join(delivery, `stage-${id}.home23-stage.json`), '{}');
  writeFileSync(join(delivery, `stage-${older}.home23-stage.lock`), JSON.stringify({ pid: 999999, id: 'gone' }));
  // An apply still holds this stage.
  writeFileSync(join(delivery, `stage-${held}.home23-stage.lock`), JSON.stringify({ pid: process.pid, id: 'live' }));
  writeFileSync(join(delivery, 'notes.txt'), 'kept');
  f.setOperation({ ...f.operation(id), prepared: { release, packageId: release.packageId, candidatePayload: join(delivery, `stage-${id}/payload`),
    staging: join(delivery, `stage-${id}`), installedAppPath: join(f.parent, 'Home23.app'), preparedAppPath: join(f.parent, '.next.app'), lifecyclePath: join(f.parent, 'lifecycle') } });
  const removed = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: checkedChannel, removePaths: paths => removed.push(...paths),
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => {
      f.write(join(f.home, '.home23-install.json'), { ...f.receipt, packageId: release.packageId });
      return { ok: true, status: 'committed' };
    } },
    appUpdater: { applyPreparedMacApplication: async () => ({ status: 'reopened' }) },
    verifyReady: async () => ({ running: true }),
  });
  assert.equal(f.operation(id).phase, 'completed');
  assert.deepEqual(removed.map(path => path.slice(delivery.length + 1)).sort(), [
    `download-${id}`, `download-${older}`, `stage-${id}`, `stage-${id}.home23-stage.json`, `stage-${older}`, `stage-${older}.home23-stage.lock`,
  ].sort());
});

test('a new download prunes older deliveries and a failed resumable update keeps its own', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  const delivery = join(f.parent, '.home.home23-delivery');
  const older = '66666666-6666-6666-6666-666666666666';
  mkdirSync(join(delivery, `download-${older}`), { recursive: true, mode: 0o700 });
  const removed = [];
  const dependencies = {
    channel: { ...checkedChannel, prepareConfiguredRelease: async options => {
      mkdirSync(options.downloadDirectory, { recursive: true }); mkdirSync(options.staging, { recursive: true });
      return { release, packageId: release.packageId, appBuild: 180, candidatePayload: join(options.staging, 'payload'), staging: options.staging };
    } },
    removePaths: paths => removed.push(...paths),
    updater: { readUpdateJournal: () => null, applyProductUpdate: async () => ({ ok: false, status: 'refused', reasons: [{ code: 'database_busy', message: 'busy' }] }) },
    appUpdater: unusedAppUpdater,
  };
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, dependencies);
  assert.equal(f.operation(id).phase, 'failed');
  assert.deepEqual(homeUpdateStatus({ homeRoot: f.home, clientBuild: 180 }).allowedActions, ['resume']);
  assert.deepEqual(removed, [join(delivery, `download-${older}`)]);
});

test('an unfinished journal keeps every delivery when a new download starts', async t => {
  const f = fixture(t); await check(f);
  const accepted = await requestHomeUpdate(input(f.home, 'update', 'update'), noLaunch), id = accepted.operation.id;
  mkdirSync(join(f.parent, '.home.home23-delivery', 'stage-77777777-7777-7777-7777-777777777777'), { recursive: true, mode: 0o700 });
  const removed = [];
  await runHomeUpdateOperation({ homeRoot: f.home, operationId: id }, {
    channel: { ...checkedChannel, prepareConfiguredRelease: async () => { throw Object.assign(new Error('offline'), { code: 'download_failed' }); } },
    removePaths: paths => removed.push(...paths),
    updater: { readUpdateJournal: () => ({ phase: 'recovery_required', writersAdmitted: false }) },
    appUpdater: unusedAppUpdater,
  });
  assert.deepEqual(removed, []);
});

test('pruning ignores links, other names and a local cache of a same-volume home', t => {
  const f = fixture(t);
  const delivery = join(f.parent, '.home.home23-delivery'), cache = join(f.parent, 'cache');
  const gone = '88888888-8888-8888-8888-888888888888', linked = '99999999-9999-9999-9999-999999999999';
  mkdirSync(join(delivery, `download-${gone}`), { recursive: true, mode: 0o700 });
  mkdirSync(join(delivery, 'download-not-an-operation'));
  mkdirSync(join(f.parent, 'elsewhere'));
  symlinkSync(join(f.parent, 'elsewhere'), join(delivery, `stage-${linked}`));
  mkdirSync(join(cache, `extraction-${gone}`), { recursive: true, mode: 0o700 });
  symlinkSync(join(f.parent, 'elsewhere'), join(cache, `extraction-${linked}`));
  const removed = [];
  const removePaths = paths => removed.push(...paths);
  pruneUpdateDelivery(f.home, { cacheRoot: cache, deviceFor: () => 1 }, { removePaths });
  assert.deepEqual(removed, [join(delivery, `download-${gone}`)]);
  removed.length = 0;
  // An external home expanded its runtime in the Mac's local cache.
  pruneUpdateDelivery(f.home, { cacheRoot: cache, deviceFor: path => path === f.home ? 2 : 1 }, { removePaths });
  assert.deepEqual(removed.sort(), [join(delivery, `download-${gone}`), join(cache, `extraction-${gone}`)].sort());
});
