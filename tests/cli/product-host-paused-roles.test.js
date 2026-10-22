import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Server } from 'node:net';
import { choosePortPlan, privateJSON, socketRootFor } from '../../cli/lib/product-environment.js';
import { ownedProcessNames, productDefinitions, runHostAction } from '../../cli/lib/product-host.js';
import { installProductPayload, writeProductManifest } from '../../cli/lib/product-payload.js';
import { updateDirectoryFor } from '../../cli/lib/product-update-apply.js';

async function fixture(t) {
  // Port binding is outside these role-intent tests and is unavailable in the sandbox.
  t.mock.method(Server.prototype, 'listen', function (_options, callback) { queueMicrotask(callback); return this; });
  t.mock.method(Server.prototype, 'close', function (callback) { queueMicrotask(callback); return this; });
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-paused-roles-')));
  const payload = path.join(base, 'payload'), homeRoot = path.join(base, 'home');
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(socketRootFor(homeRoot), { recursive: true, force: true });
  });
  for (const file of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2']) {
    fs.mkdirSync(path.dirname(path.join(payload, file)), { recursive: true });
    fs.writeFileSync(path.join(payload, file), file === 'bin/node' ? 'fixture node' : '', { mode: file === 'bin/node' ? 0o755 : 0o644 });
  }
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.23.4' });
  installProductPayload({ payloadPath: payload, homeRoot });
  const state = { schema: 'home23.host.v1', homeRoot, ports: await choosePortPlan(), profile: { name: 'milo', provider: 'ollama-local', model: 'fixture' }, phase: 'starting', desiredRunning: true,
    birth: { home: { id: 'home-fixture' }, coordination: { botId: 'bot-fixture' } } };
  privateJSON(path.join(homeRoot, '.home23-host.json'), state);
  const names = ownedProcessNames('milo', { home23Root: homeRoot });
  const apps = productDefinitions(names.map(name => ({ name, script: 'dist/home.js', cwd: path.join(homeRoot, 'app'), env: {}, args: [] })), homeRoot, 'milo');
  const registration = (app, status = 'online') => ({ name: app.name, pid: status === 'online' ? 123 : 0, pm2_env: { ...app.env, status, pm_cwd: app.cwd, pm_exec_path: path.resolve(app.cwd, app.script), args: [...app.args], min_uptime: app.min_uptime, restart_delay: app.restart_delay || 0, exp_backoff_restart_delay: app.exp_backoff_restart_delay || 0 } });
  const rows = apps.map(app => registration(app)), calls = [];
  const dependencies = {
    // Every process operation is mocked; this suite never executes bundled PM2.
    execute: async (_node, args) => {
      const [command, target] = args.slice(1);
      if (command === 'jlist') return { stdout: JSON.stringify(rows) };
      calls.push(args.slice(1));
      if (command === 'delete') rows.splice(rows.findIndex(row => row.name === target), 1);
      else if (command === 'start') rows.push(registration(apps.find(app => app.name === args[args.indexOf('--only') + 1])));
      else if (command === 'restart' || command === 'stop') {
        const row = rows.find(row => row.name === target);
        row.pm2_env.status = command === 'stop' ? 'stopped' : 'online';
        row.pid = command === 'stop' ? 0 : 123;
      } else throw new Error(`Unexpected mocked process command: ${command}`);
      return { stdout: '' };
    },
    definitions: () => apps, readinessWaitMs: 0,
    detectForeignBindings: () => ({ warnings: [] }),
    probeReadiness: async () => ({ ready: true, issues: [] }),
  };
  const saveUpdate = ({ desiredRunning, registrations = rows, ownership = 'launchd', legacySnapshot = false } = {}) => {
    const id = 'fixture-update', pausedNames = registrations.filter(row => ['stopped', 'errored'].includes(row.pm2_env.status)).map(row => row.name);
    const migration = ownership === 'absent' ? { ownership, running: false, updateId: id, pausedNames: [] }
      : { ownership: 'launchd', updateId: id, pid: 43, generation: '43:birth', pausedNames };
    const admission = ownership === 'absent' ? { ownership, registrations: [] }
      : { ownership, expectedPid: 42, generation: '42:birth', registrations };
    if (legacySnapshot) {
      migration.snapshotPath = path.join(homeRoot, 'runtime/pm2/supervisor-migration.json');
      privateJSON(migration.snapshotPath, { updateId: id, phase: 'registered', registrations });
    }
    const journal = { schema: 'home23.product-update.v1', homeRoot, id, ownerToken: 'fixture-owner', phase: 'committed', desiredRunning,
      candidateStarted: desiredRunning, supervisorMigration: migration, ...(!legacySnapshot ? { supervisorAdmission: admission } : {}) };
    fs.mkdirSync(updateDirectoryFor(homeRoot), { mode: 0o700 });
    privateJSON(path.join(updateDirectoryFor(homeRoot), 'journal.json'), journal);
    return journal;
  };
  return { homeRoot, state, rows, calls, names, dependencies, saveUpdate };
}

test('explicit Start resumes every role after Stop and a committed stopped-home update', async t => {
  const f = await fixture(t);
  assert.equal((await runHostAction('stop', { homeRoot: f.homeRoot }, f.dependencies)).desiredRunning, false);
  const journal = f.saveUpdate({ desiredRunning: false });
  assert.equal(journal.candidateStarted, false);
  f.calls.length = 0;
  assert.deepEqual((await runHostAction('status', { homeRoot: f.homeRoot }, f.dependencies)).pausedProcessNames, []);
  const result = await runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies);
  assert.deepEqual(f.calls.filter(args => args[0] === 'restart').map(args => args[1]), f.names);
  assert.equal(result.desiredRunning, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.pausedProcessNames, []);
});

test('a running-home update preserves its individually stopped and errored roles on Start', async t => {
  const f = await fixture(t), registrations = structuredClone(f.rows);
  registrations[1].pm2_env.status = 'stopped'; registrations[1].pid = 0;
  registrations[2].pm2_env.status = 'errored'; registrations[2].pid = 0;
  f.saveUpdate({ desiredRunning: true, registrations });
  for (const row of f.rows) { row.pm2_env.status = 'stopped'; row.pid = 0; }
  const result = await runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies);
  const paused = registrations.slice(1, 3).map(row => row.name);
  assert.deepEqual(f.calls.filter(args => args[0] === 'restart').map(args => args[1]), f.names.filter(name => !paused.includes(name)));
  assert.deepEqual(result.pausedProcessNames, paused);
  assert.ok(f.rows.filter(row => paused.includes(row.name)).every(row => row.pm2_env.status === 'stopped'));
});

test('a stopped empty admission remains valid when explicit Start changes current running intent', async t => {
  const f = await fixture(t);
  f.rows.length = 0;
  privateJSON(path.join(f.homeRoot, '.home23-host.json'), { ...f.state, desiredRunning: false, phase: 'stopped' });
  f.saveUpdate({ desiredRunning: false, ownership: 'absent' });
  const result = await runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies);
  assert.equal(result.desiredRunning, true);
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.pausedProcessNames, []);
  assert.deepEqual(f.calls.filter(args => args[0] === 'start').map(args => args[args.indexOf('--only') + 1]), f.names);
  assert.deepEqual((await runHostAction('status', { homeRoot: f.homeRoot }, f.dependencies)).pausedProcessNames, []);
});

test('legacy migration snapshots also distinguish a whole-home stop from per-role pauses', async t => {
  const f = await fixture(t);
  await runHostAction('stop', { homeRoot: f.homeRoot }, f.dependencies);
  f.saveUpdate({ desiredRunning: false, legacySnapshot: true });
  f.calls.length = 0;
  const result = await runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies);
  assert.deepEqual(f.calls.filter(args => args[0] === 'restart').map(args => args[1]), f.names);
  assert.deepEqual(result.pausedProcessNames, []);
});

test('a stopped-home update still refuses mismatched pause metadata before starting roles', async t => {
  const f = await fixture(t);
  await runHostAction('stop', { homeRoot: f.homeRoot }, f.dependencies);
  const journal = f.saveUpdate({ desiredRunning: false });
  journal.supervisorMigration.pausedNames.pop();
  privateJSON(path.join(updateDirectoryFor(f.homeRoot), 'journal.json'), journal);
  f.calls.length = 0;
  await assert.rejects(runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies), { code: 'host_supervisor_ambiguous' });
  assert.deepEqual(f.calls, []);
});

test('an update without a boolean running intent cannot discard its captured pauses', async t => {
  const f = await fixture(t);
  await runHostAction('stop', { homeRoot: f.homeRoot }, f.dependencies);
  const journal = f.saveUpdate({ desiredRunning: false });
  f.calls.length = 0;
  for (const desiredRunning of [null, 'false']) {
    privateJSON(path.join(updateDirectoryFor(f.homeRoot), 'journal.json'), { ...journal, desiredRunning });
    await assert.rejects(runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies), { code: 'host_supervisor_ambiguous' });
    assert.deepEqual(f.calls, []);
  }
  privateJSON(path.join(updateDirectoryFor(f.homeRoot), 'journal.json'), { ...journal, desiredRunning: undefined });
  const result = await runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies);
  assert.equal(result.desiredRunning, true);
  assert.deepEqual(result.pausedProcessNames, f.names);
  assert.ok(f.rows.every(row => row.pm2_env.status === 'stopped'));
  assert.deepEqual(f.calls, []);
});

test('a stopped-home update still refuses an incorrect update owner before starting roles', async t => {
  const f = await fixture(t);
  await runHostAction('stop', { homeRoot: f.homeRoot }, f.dependencies);
  f.saveUpdate({ desiredRunning: false });
  f.calls.length = 0;
  await assert.rejects(runHostAction('start', { homeRoot: f.homeRoot, input: { updateOwnerToken: 'different-owner' } }, f.dependencies), { code: 'host_supervisor_ambiguous' });
  assert.deepEqual(f.calls, []);
});

test('a stopped-home update still refuses an unowned captured registration before starting roles', async t => {
  const f = await fixture(t);
  await runHostAction('stop', { homeRoot: f.homeRoot }, f.dependencies);
  const registrations = structuredClone(f.rows);
  registrations[0].pm2_env.pm_exec_path = '/some/other/home/bin/node';
  f.saveUpdate({ desiredRunning: false, registrations });
  f.calls.length = 0;
  await assert.rejects(runHostAction('start', { homeRoot: f.homeRoot }, f.dependencies), { code: 'host_supervisor_ambiguous' });
  assert.deepEqual(f.calls, []);
});
