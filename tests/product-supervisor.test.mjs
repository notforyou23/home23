import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { runHostAction, ownedProcessNames, productDefinitions, probeReadiness, safeProcesses } from '../cli/lib/product-host.js';
import { productEnvironment, privateJSON, socketRootFor, choosePortPlan } from '../cli/lib/product-environment.js';
import { writeProductManifest, installProductPayload } from '../cli/lib/product-payload.js';
import { adoptProductSupervisor, ensureProductSupervisor, forbidClientSpawn, inspectProductSupervisor, productHomeWriterPids, productSupervisorCommand, productSupervisorInventory, productSupervisorPlan, recoverProductSupervisor, startResidentDaemon, supervisorPlist } from '../cli/lib/product-supervisor.js';
import { parsePlist } from '../cli/lib/product-foreign-bindings.js';

function fixture(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-unit-')));
  const root = path.join(base, 'Home'), payload = path.join(base, 'payload');
  t.after(() => { fs.rmSync(base, { recursive: true, force: true }); fs.rmSync(socketRootFor(root), { recursive: true, force: true }); });
  for (const file of ['bin/node', 'app/cli/home23.js', 'app/cli/lib/product-payload.js', 'app/cli/lib/product-supervisor.js', 'app/scripts/product/host.mjs', 'tools/node_modules/pm2/bin/pm2', 'tools/node_modules/pm2/lib/Daemon.js']) {
    fs.mkdirSync(path.dirname(path.join(payload, file)), { recursive: true });
    fs.writeFileSync(path.join(payload, file), '', { mode: file === 'bin/node' ? 0o755 : 0o644 });
  }
  writeProductManifest(payload, { sourceCommit: 'a'.repeat(40), platform: process.platform, arch: process.arch, nodeVersion: 'v22.19.0' });
  installProductPayload({ payloadPath: payload, homeRoot: root });
  productEnvironment(root, { prepare: true });
  return root;
}

test('macOS Start admits launchd ownership before any mutating PM2 command', async t => {
  const homeRoot = fixture(t);
  privateJSON(path.join(homeRoot, '.home23-host.json'), { schema: 'home23.host.v1', homeRoot, ports: await choosePortPlan(), profile: { name: 'milo' }, phase: 'prepared', desiredRunning: false, encoderRequired: false });
  const rows = [], calls = [];
  const execute = async (_file, args) => {
    const cmd = args[1];
    calls.push(cmd);
    if (cmd === 'jlist') return { stdout: JSON.stringify(rows) };
    if (cmd === 'start') rows.push({ name: args[args.indexOf('--only') + 1], pid: 10, pm2_env: { status: 'online', pm_exec_path: path.join(homeRoot, 'bin/node'), pm_cwd: path.join(homeRoot, 'app'), args: [] } });
    return { stdout: '' };
  };
  await runHostAction('start', { homeRoot }, {
    execute, platform: 'darwin',
    ensureProductSupervisor: async () => { calls.push('launchd-admitted'); },
    definitions: () => productDefinitions(ownedProcessNames('milo').map(name => ({ name, script: 'dist/home.js', env: {} })), homeRoot, 'milo'),
    readinessWaitMs: 0, probeReadiness: async () => ({ ready: true, issues: [] }),
  });
  assert.ok(calls.indexOf('launchd-admitted') >= 0, 'Start must establish independent supervisor ownership');
  assert.ok(calls.indexOf('launchd-admitted') < calls.indexOf('start'));
});

function machine(root) {
  const plan = productSupervisorPlan(root), calls = [];
  let live = false, loaded = false, pid = 4242, wrongSocket = false, unknown = false, jobPid = 4242, lastExitCode = null;
  const deps = {
    platform: 'darwin', identity: async () => 'fixture-generation', alive: p => live && p === pid,
    listening: async p => unknown ? null : p === path.join(plan.env.PM2_HOME, 'rpc.sock') ? wrongSocket : live && [plan.env.PM2_DAEMON_RPC_PORT, plan.env.PM2_DAEMON_PUB_PORT].includes(p),
    execute: async (file, args) => {
      calls.push([file, ...args]);
      assert.equal(file, '/bin/launchctl');
      if (args[0] === 'list') { if (!loaded) throw Object.assign(new Error('absent'), { code: 113 }); return { stdout: `{\n\t"Label" = "${plan.label}";\n${live && jobPid ? `\t"PID" = ${jobPid};\n` : ''}${lastExitCode === null ? '' : `\t"LastExitStatus" = ${lastExitCode};\n`}};\n` }; }
      assert.ok(['bootstrap', 'kickstart'].includes(args[0]));
      loaded = true; live = true;
      fs.writeFileSync(path.join(plan.env.PM2_HOME, 'pm2.pid'), String(pid));
      const claim = JSON.parse(fs.readFileSync(plan.claim));
      privateJSON(plan.owner, { schema: 'home23.supervisor.owner.v1', homeRoot: root, token: claim.token, pid, parentPid: 1 });
      return { stdout: '' };
    },
  };
  return { plan, calls, deps, get live() { return live; }, set live(v) { live = v; }, get loaded() { return loaded; }, set loaded(v) { loaded = v; }, set pid(v) { pid = v; }, set jobPid(v) { jobPid = v; }, set wrongSocket(v) { wrongSocket = v; }, set unknown(v) { unknown = v; }, set lastExitCode(v) { lastExitCode = v; } };
}

test('launchd config is home-specific, foreground, private, and excludes ambient credentials', t => {
  const root = fixture(t), plan = productSupervisorPlan(root), other = productSupervisorPlan(path.join(path.dirname(root), 'other'));
  const previous = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'do-not-copy';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const job = parsePlist(supervisorPlist(plan, 'a'.repeat(36)));
  assert.notEqual(plan.label, other.label); assert.notEqual(plan.env.PM2_DAEMON_RPC_PORT, other.env.PM2_DAEMON_RPC_PORT);
  assert.deepEqual(job.ProgramArguments, [plan.node, plan.module, '--resident-daemon', root, 'a'.repeat(36)]);
  assert.equal(job.KeepAlive, false); assert.equal(job.Umask, 63); assert.equal(job.ExitTimeOut, 240);
  assert.equal(job.EnvironmentVariables.PM2_HOME, path.join(root, 'runtime/pm2'));
  assert.equal(job.EnvironmentVariables.OPENAI_API_KEY, undefined); assert.equal(job.EnvironmentVariables.NODE_OPTIONS, undefined);
});

test('read-only absent inspection leaves private runtime unchanged and never loads a job', async t => {
  const root = fixture(t), m = machine(root), before = fs.readdirSync(m.plan.env.PM2_HOME);
  assert.equal((await inspectProductSupervisor(root, m.deps)).ownership, 'absent');
  assert.deepEqual(fs.readdirSync(m.plan.env.PM2_HOME), before);
  assert.ok(m.calls.every(c => c[1] === 'list'));
});

test('cold Start is launchd-owned and repeated Start joins the same PID without replacing the job', async t => {
  const root = fixture(t), m = machine(root);
  assert.equal((await ensureProductSupervisor(root, m.deps)).ownership, 'launchd');
  const claim = fs.readFileSync(m.plan.claim);
  assert.equal((await ensureProductSupervisor(root, m.deps)).pid, 4242);
  assert.equal(m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  assert.deepEqual(fs.readFileSync(m.plan.claim), claim);
  assert.equal(fs.statSync(m.plan.plist).mode & 0o777, 0o600);
});

test('legacy daemon requires explicit update admission; no daemon or role is changed', async t => {
  const root = fixture(t), m = machine(root); m.live = true;
  fs.writeFileSync(path.join(m.plan.env.PM2_HOME, 'pm2.pid'), '4242');
  assert.equal((await inspectProductSupervisor(root, m.deps)).ownership, 'legacy');
  await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_adoption_required' });
  assert.ok(m.calls.every(c => c[1] === 'list')); assert.equal(fs.existsSync(m.plan.claim), false);
});

test('ambiguous or noncanonical sockets and alive stale PIDs block creation', async t => {
  for (const kind of ['wrongSocket', 'unknown', 'stale']) {
    const root = fixture(t), m = machine(root);
    if (kind === 'stale') { m.live = true; fs.writeFileSync(path.join(m.plan.env.PM2_HOME, 'pm2.pid'), '4242'); m.deps.listening = async () => false; }
    else m[kind] = true;
    await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
    assert.ok(m.calls.every(c => c[1] === 'list'));
  }
});

test('foreign loaded label and altered private config fail closed without bootout', async t => {
  const root = fixture(t), m = machine(root); m.loaded = true;
  await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
  m.loaded = false; await ensureProductSupervisor(root, m.deps);
  fs.appendFileSync(m.plan.plist, '<!-- altered -->');
  await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
  assert.ok(m.calls.every(c => !['bootout', 'kill'].includes(c[1])));
});

test('Linux ensure and inspect do not load jobs or change any home state', async t => {
  const root = fixture(t), m = machine(root), before = fs.readdirSync(m.plan.env.PM2_HOME);
  for (const fn of [inspectProductSupervisor, ensureProductSupervisor]) assert.equal((await fn(root, { platform: 'linux', execute() { throw new Error('unexpected'); } })).ownership, 'not_required');
  assert.deepEqual(fs.readdirSync(m.plan.env.PM2_HOME), before);
});

test('loaded inactive label or a different launchd PID cannot admit a reparented socket owner', async t => {
  for (const pid of [null, 8181]) {
    const root = fixture(t), m = machine(root);
    await ensureProductSupervisor(root, m.deps);
    m.jobPid = pid;
    await assert.rejects(inspectProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
    await assert.rejects(ensureProductSupervisor(root, m.deps), { code: 'host_supervisor_ambiguous' });
    assert.equal(m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  }
});

async function migrationFixture(t, runtimeEnv = {}) {
  const root = fixture(t), m = machine(root); m.live = true;
  fs.writeFileSync(path.join(m.plan.env.PM2_HOME, 'pm2.pid'), '4242');
  const state = { schema: 'home23.host.v1', homeRoot: root, profile: { name: 'milo' }, desiredRunning: true, phase: 'starting', encoderRequired: false };
  privateJSON(path.join(root, '.home23-host.json'), state);
  const journalPath = path.join(path.dirname(root), '.Home.home23-update/journal.json');
  fs.mkdirSync(path.dirname(journalPath), { mode: 0o700 });
  privateJSON(journalPath, { id: 'update-fixture', homeRoot: root, ownerToken: 'fixture-token', phase: 'verifying', candidateStarted: false });
  const env = { pm_cwd: path.join(root, 'app'), pm_exec_path: path.join(root, 'bin/node'), args: [path.join(root, 'app/fixture-role.cjs')], exec_interpreter: 'none', kill_timeout: 230000, listen_timeout: 34000, env: { PRIVATE_VALUE: 'preserve-without-printing', ...runtimeEnv } };
  const registrations = [{ name: 'home23-milo', pm2_env: { ...env, status: 'online' } }, { name: 'home23-milo-dash', pm2_env: { ...env, status: 'stopped' } }];
  let rows = structuredClone(registrations);
  const commands = [], signals = [];
  m.deps.command = async args => { commands.push(args); if (args[0] === 'stop') rows.find(r => r.name === args[1]).pm2_env.status = 'stopped'; return { stdout: JSON.stringify(rows) }; };
  m.deps.signal = (pid, signal) => { signals.push([pid, signal]); m.live = false; };
  m.deps.restore = async (_root, saved) => { rows = structuredClone(saved).map(r => ({ ...r, pm2_env: { ...r.pm2_env, status: 'stopped' } })); };
  return { root, m, state, commands, signals, registrations, journalPath, clearRows() { rows = []; }, admission: { expectedPid: 4242, generation: 'fixture-generation', registrations, updateId: 'update-fixture', updateOwnerToken: 'fixture-token' } };
}

test('admitted migration preserves all definitions and paused roles, signals only the exact old PID, and is resumable', async t => {
  const f = await migrationFixture(t), before = fs.readFileSync(path.join(f.root, '.home23-host.json'));
  const result = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.deepEqual(f.signals, [[4242, 'SIGINT']]);
  assert.equal(result.ownership, 'launchd'); assert.deepEqual(result.pausedNames, ['home23-milo-dash']);
  assert.deepEqual(JSON.parse(fs.readFileSync(result.snapshotPath)).registrations, f.registrations);
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.home23-host.json')), before);
  assert.ok(f.commands.every(c => !c.includes('all')));
  assert.equal(f.m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(f.signals.length, 1);
});

test('missing/stale admission, foreign roles and changed definitions cannot stop the daemon', async t => {
  for (const kind of ['token', 'phase', 'foreign', 'changed']) {
    const f = await migrationFixture(t);
    if (kind === 'token') f.admission.updateOwnerToken = 'wrong';
    if (kind === 'phase') privateJSON(f.journalPath, { id: 'update-fixture', homeRoot: f.root, ownerToken: 'fixture-token', phase: 'writers_admitted' });
    if (kind === 'foreign') f.admission.registrations.push({ name: 'other', pm2_env: f.registrations[0].pm2_env });
    if (kind === 'changed') f.admission.registrations[0].pm2_env.kill_timeout = 3;
    await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps));
    assert.deepEqual(f.signals, []); assert.equal(f.commands.filter(c => c[0] === 'stop').length, 0);
  }
});

test('a daemon that ignores bounded SIGINT retains the snapshot and never gets SIGKILL or a replacement', async t => {
  const f = await migrationFixture(t);
  f.m.deps.signal = (pid, signal) => f.signals.push([pid, signal]);
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, { ...f.m.deps, shutdownTimeoutMs: 1, pollMs: 1 }), { code: 'host_supervisor_shutdown_pending' });
  assert.deepEqual(f.signals, [[4242, 'SIGINT']]); assert.equal(fs.existsSync(f.m.plan.migration), true);
  assert.equal(f.m.calls.filter(c => c[1] === 'bootstrap').length, 0);
});

test('writer admission or accepted Work prevents migration even when all rows are stopped', async t => {
  const f = await migrationFixture(t);
  privateJSON(f.journalPath, { id: 'update-fixture', homeRoot: f.root, ownerToken: 'fixture-token', phase: 'writers_admitted', writersAdmitted: true, acceptedWork: true, candidateStarted: false });
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps), { code: 'host_supervisor_admission_required' });
  assert.deepEqual(f.signals, []);
  await f.m.deps.command(['stop', 'home23-milo']);
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps), { code: 'host_supervisor_admission_required' });
  const g = await migrationFixture(t);
  privateJSON(g.journalPath, { id: 'update-fixture', homeRoot: g.root, ownerToken: 'fixture-token', phase: 'writers_admitted', candidateStarted: true });
  await assert.rejects(adoptProductSupervisor(g.root, g.admission, g.m.deps), { code: 'host_supervisor_admission_required' });
  assert.deepEqual(g.signals, []);
});

test('registration snapshots must belong to this exact update; names-only fallback is refused', async t => {
  const f = await migrationFixture(t);
  await assert.rejects(adoptProductSupervisor(f.root, { ...f.admission, updateId: 'different' }, f.m.deps), { code: 'host_supervisor_admission_required' });
  await assert.rejects(adoptProductSupervisor(f.root, { expectedPid: 4242, updateId: 'update-fixture', updateOwnerToken: 'fixture-token' }, f.m.deps), { code: 'host_supervisor_ambiguous' });
  assert.deepEqual(f.signals, []);
});

test('read-only client refuses unprepared runtime and maps lost connections to a truthful error', async t => {
  const root = fixture(t), env = productEnvironment(root);
  fs.rmSync(env.HOME, { recursive: true });
  await assert.rejects(productSupervisorCommand(root, ['jlist'], { execute() { throw new Error('client must not run'); } }), /not prepared/);
  assert.equal(fs.existsSync(env.HOME), false);
  productEnvironment(root, { prepare: true });
  await assert.rejects(productSupervisorCommand(root, ['jlist'], { execute: async () => { throw Object.assign(new Error('lost'), { code: 75 }); } }), { code: 'host_supervisor_ambiguous' });
});

function bindPausedJournal(root, registrations) {
  const snapshotPath = path.join(root, 'runtime/pm2/supervisor-migration.json');
  const pausedNames = registrations.filter(row => ['stopped', 'errored'].includes(row.pm2_env.status)).map(row => row.name);
  privateJSON(snapshotPath, { schema: 'home23.supervisor.migration.v1', updateId: 'paused-update', phase: 'registered', registrations });
  const journalPath = path.join(path.dirname(root), '.Home.home23-update/journal.json');
  fs.mkdirSync(path.dirname(journalPath), { mode: 0o700 });
  privateJSON(journalPath, { schema: 'home23.product-update.v1', id: 'paused-update', homeRoot: root, ownerToken: 'paused-token', phase: 'writers_admitted', candidateStarted: false, supervisorMigration: { updateId: 'paused-update', snapshotPath, pausedNames } });
  return journalPath;
}

test('owner-bound update Start retains the paused registration and starts only active roles', async t => {
  const root = fixture(t), ports = await choosePortPlan();
  privateJSON(path.join(root, '.home23-host.json'), { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, phase: 'starting', desiredRunning: true, encoderRequired: false });
  const apps = productDefinitions(ownedProcessNames('milo').map(name => ({ name, script: 'dist/home.js', env: {} })), root, 'milo');
  const rows = apps.map(app => ({ name: app.name, pid: 0, pm2_env: { ...app.env, status: 'stopped', pm_exec_path: path.join(root, 'bin/node'), pm_cwd: app.cwd, args: app.args, min_uptime: app.min_uptime, exp_backoff_restart_delay: app.exp_backoff_restart_delay } }));
  const saved = structuredClone(rows); saved.forEach(r => { if (r.name !== 'home23-milo-dash') r.pm2_env.status = 'online'; });
  bindPausedJournal(root, saved);
  const commands = [];
  const result = await runHostAction('start', { homeRoot: root, input: { updateOwnerToken: 'paused-token', pausedProcessNames: ['home23-coordination'] } }, {
    execute: async (_node, args) => { commands.push(args.slice(1)); if (args[1] === 'restart') { const row = rows.find(r => r.name === args[2]); row.pm2_env.status = 'online'; row.pid = 123; } return { stdout: JSON.stringify(rows) }; },
    definitions: () => apps, readinessWaitMs: 0, probeReadiness: async () => ({ ready: true, issues: [] }),
  });
  assert.deepEqual(result.pausedProcessNames, ['home23-milo-dash']);
  assert.equal(rows.length, apps.length); assert.equal(rows.find(r => r.name === 'home23-milo-dash').pm2_env.status, 'stopped');
  assert.ok(commands.some(c => c[0] === 'restart' && c[1] === 'home23-coordination'));
  assert.ok(!commands.some(c => ['start', 'restart', 'delete'].includes(c[0]) && c.includes('home23-milo-dash')));
  const file = path.join(path.dirname(root), '.Home.home23-update/journal.json');
  const journal = JSON.parse(fs.readFileSync(file)); journal.phase = 'committed'; privateJSON(file, journal);
  rows.forEach(r => { r.pm2_env.status = 'stopped'; r.pid = 0; }); commands.length = 0;
  await runHostAction('start', { homeRoot: root }, {
    execute: async (_node, args) => { commands.push(args.slice(1)); if (args[1] === 'restart') { const row = rows.find(r => r.name === args[2]); row.pm2_env.status = 'online'; row.pid = 123; } return { stdout: JSON.stringify(rows) }; },
    definitions: () => apps, readinessWaitMs: 0, probeReadiness: async () => ({ ready: true, issues: [] }),
  });
  assert.equal(rows.find(r => r.name === 'home23-milo-dash').pm2_env.status, 'stopped');
  assert.ok(!commands.some(c => ['start', 'restart', 'delete'].includes(c[0]) && c.includes('home23-milo-dash')));
});

test('already-independent update pause authority comes from full journal admission, including errored roles', async t => {
  const root = fixture(t), ports = await choosePortPlan();
  const state = { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, desiredRunning: true, encoderRequired: false };
  privateJSON(path.join(root, '.home23-host.json'), state);
  const names = ownedProcessNames('milo');
  const rows = names.map(name => ({ name, pid: 0, pm2_env: { status: name === 'home23-milo-dash' ? 'errored' : 'online', pm_exec_path: path.join(root, 'bin/node'), pm_cwd: path.join(root, 'app'), args: [path.join(root, 'app/fixture-role.cjs')] } }));
  const journalPath = bindPausedJournal(root, rows);
  const journal = JSON.parse(fs.readFileSync(journalPath));
  journal.supervisorAdmission = { expectedPid: 4242, generation: 'fixture-generation', ownership: 'launchd', registrations: rows };
  journal.supervisorMigration = { ownership: 'launchd', pid: 4242, pausedNames: ['home23-milo-dash'] };
  privateJSON(journalPath, journal);
  fs.rmSync(path.join(root, 'runtime/pm2/supervisor-migration.json'));
  const currentRows = rows.map(r => ({ ...r, pm2_env: { ...r.pm2_env, status: r.name === 'home23-milo-dash' ? 'stopped' : 'online' } }));
  const result = await runHostAction('status', { homeRoot: root }, { execute: async () => ({ stdout: JSON.stringify(currentRows) }), probeReadiness: async () => ({ ready: true, issues: [] }) });
  assert.deepEqual(result.pausedProcessNames, ['home23-milo-dash']);
  assert.equal(result.processes.length, rows.length);
  journal.supervisorMigration.pausedNames = ['home23-coordination']; privateJSON(journalPath, journal);
  await assert.rejects(probeReadiness(root, state, safeProcesses(rows, root, names)), { code: 'host_supervisor_ambiguous' });
});

test('second independent update archives the completed migration and preserves paused intent without another shutdown', async t => {
  const f = await migrationFixture(t);
  await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  privateJSON(f.journalPath, { id: 'second-update', homeRoot: f.root, ownerToken: 'second-token', phase: 'verifying', candidateStarted: false });
  const second = await adoptProductSupervisor(f.root, { ...f.admission, updateId: 'second-update', updateOwnerToken: 'second-token' }, f.m.deps);
  assert.deepEqual(second.pausedNames, ['home23-milo-dash']);
  assert.equal(f.signals.length, 1);
  assert.equal(f.m.calls.filter(c => c[1] === 'bootstrap').length, 1);
  assert.equal(fs.existsSync(f.m.plan.migration), false);
  assert.equal(fs.readdirSync(f.m.plan.env.PM2_HOME).filter(f => /^supervisor-migration\.[a-f0-9]+\.json$/.test(f)).length, 1);
});

test('same admitted update can restore missing stopped registrations after an independent daemon loss', async t => {
  const f = await migrationFixture(t);
  await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  f.clearRows(); f.m.live = false; f.m.pid = 8181; f.m.jobPid = 8181;
  const resumed = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(resumed.pid, 8181); assert.deepEqual(resumed.pausedNames, ['home23-milo-dash']);
  assert.equal(f.signals.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(resumed.snapshotPath)).registrations, f.registrations);
});

test('empty absent admission preserves stopped intent or accepts a bounded cold launchd result without a fabricated old PID', async t => {
  for (const desiredRunning of [false, true]) {
    const root = fixture(t), ports = await choosePortPlan();
    const state = { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, phase: 'prepared', desiredRunning, encoderRequired: false };
    privateJSON(path.join(root, '.home23-host.json'), state);
    const file = bindPausedJournal(root, []), journal = JSON.parse(fs.readFileSync(file));
    journal.supervisorAdmission = { ownership: 'absent', registrations: [] };
    journal.supervisorMigration = desiredRunning ? { ownership: 'launchd', updateId: journal.id, pid: 4242, generation: 'fixture-generation', pausedNames: [] } : { ownership: 'absent', running: false };
    privateJSON(file, journal);
    const result = await runHostAction('status', { homeRoot: root }, { execute: async () => ({ stdout: '[]' }) });
    assert.deepEqual(result.pausedProcessNames, []); assert.equal(result.desiredRunning, desiredRunning);
    journal.supervisorMigration = desiredRunning ? { ownership: 'absent', running: false } : { ownership: 'launchd', pid: 4242, generation: 'fixture-generation', pausedNames: [] };
    privateJSON(file, journal);
    await assert.rejects(probeReadiness(root, state, []), { code: 'host_supervisor_ambiguous' });
  }
});

test('retained executable is admitted only by the exact selected journal, package bytes and daemon generation', async t => {
  const root = fixture(t), m = machine(root);
  await ensureProductSupervisor(root, m.deps);
  const previous = path.join(path.dirname(root), '.Home.home23-update/previous');
  fs.mkdirSync(previous, { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(root, 'manifest.json'), path.join(previous, 'manifest.json'));
  fs.copyFileSync(path.join(root, '.home23-install.json'), path.join(previous, '.home23-install.json'));
  fs.renameSync(path.join(root, 'bin'), path.join(previous, 'bin'));
  fs.mkdirSync(path.join(root, 'bin')); fs.writeFileSync(path.join(root, 'bin/node'), '', { mode: 0o755 });
  const journal = { schema: 'home23.product-update.v1', id: 'swap-update', homeRoot: root, ownerToken: 'swap-owner', phase: 'selected', candidateStarted: false, acceptedWork: false,
    fromPackageId: JSON.parse(fs.readFileSync(path.join(previous, 'manifest.json'))).packageId, supervisorAdmission: { expectedPid: 4242, generation: `${process.getuid()} fixture-generation` } };
  const file = path.join(path.dirname(previous), 'journal.json'); privateJSON(file, journal);
  const deps = { ...m.deps, identity: undefined, execute: async (file, args) => {
    if (file === '/bin/ps') return { stdout: `${process.getuid()} fixture-generation\n` };
    if (file === '/usr/sbin/lsof') return { stdout: args.includes('-d') ? `p4242\nn${previous}/bin/node\n` : `p4242\nn${m.plan.env.PM2_DAEMON_RPC_PORT}\nn${m.plan.env.PM2_DAEMON_PUB_PORT}\n` };
    return m.deps.execute(file, args);
  } };
  assert.equal((await inspectProductSupervisor(root, deps)).executable, path.join(previous, 'bin/node'));
  await assert.rejects(ensureProductSupervisor(root, deps), { code: 'host_supervisor_adoption_required' });
  journal.acceptedWork = true; privateJSON(file, journal);
  await assert.rejects(inspectProductSupervisor(root, deps), { code: 'host_supervisor_ambiguous' });
  journal.acceptedWork = false; journal.supervisorAdmission.generation = 'different'; privateJSON(file, journal);
  await assert.rejects(inspectProductSupervisor(root, deps), { code: 'host_supervisor_ambiguous' });
  journal.supervisorAdmission.generation = `${process.getuid()} fixture-generation`; privateJSON(file, journal);
  fs.appendFileSync(path.join(previous, 'bin/node'), 'changed');
  await assert.rejects(inspectProductSupervisor(root, deps), { code: 'host_supervisor_ambiguous' });
});

test('readiness excludes bound paused role probes but still verifies every active role', async t => {
  const root = fixture(t), ports = await choosePortPlan();
  const state = { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, desiredRunning: true, encoderRequired: false, birth: { home: { id: 'home-fixture' }, coordination: { botId: 'bot-fixture' } } };
  privateJSON(path.join(root, '.home23-host.json'), state);
  const rows = ownedProcessNames('milo').map(name => ({ name, pid: 123, pm2_env: { status: name === 'home23-milo-dash' ? 'stopped' : 'online', pm_exec_path: path.join(root, 'bin/node'), pm_cwd: path.join(root, 'app'), args: [path.join(root, 'app/fixture-role.cjs')] } }));
  bindPausedJournal(root, rows);
  privateJSON(path.join(root, 'runtime/host-session.json'), { accessToken: 'fixture', refreshToken: 'fixture', accessExpiresAt: new Date(Date.now() + 3600000).toISOString() });
  const seen = [], request = async url => {
    seen.push(url); if (url.endsWith('/process.json')) throw new Error('paused dashboard must not be probed');
    if (url.endsWith('/capabilities')) return { pairingAvailable: true, capabilities: { bootstrap: true, messageSubmission: true } };
    if (url.endsWith('/bootstrap')) return { home: { id: 'home-fixture' }, snapshot: { bots: [{ id: 'bot-fixture', availability: 'available', conversationId: 'conversation-fixture' }] } };
    return { ok: true };
  };
  assert.equal((await probeReadiness(root, state, safeProcesses(rows, root, ownedProcessNames('milo')), { request })).ready, true);
  assert.ok(seen.some(url => url.endsWith('/health'))); assert.ok(!seen.some(url => url.endsWith('/process.json')));
});

function coerceRestoredVizionMarker(f, changeDesired = false) {
  const restore = f.m.deps.restore, command = f.m.deps.command, signal = f.m.deps.signal;
  f.m.deps.signal = (...args) => { signal(...args); f.clearRows(); };
  let restored = false;
  f.m.deps.restore = async (...args) => { await restore(...args); restored = true; };
  f.m.deps.command = async args => {
    const result = await command(args);
    if (!restored || args[0] !== 'jlist') return result;
    const rows = JSON.parse(result.stdout);
    for (const row of rows) {
      row.pm2_env.env.vizion_running = false;
      if (changeDesired) row.pm2_env.env.PRIVATE_VALUE = 'unexpected-desired-edit';
    }
    return { stdout: JSON.stringify(rows) };
  };
}

test('PM2 restored computed vizion marker coercion preserves admission and same-operation resume', async t => {
  const f = await migrationFixture(t, { vizion_running: 'false' });
  coerceRestoredVizionMarker(f);
  const first = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(first.ownership, 'launchd');
  assert.equal(JSON.parse(fs.readFileSync(first.snapshotPath)).registrations[0].pm2_env.env.vizion_running, 'false');
  const resumed = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(resumed.pid, first.pid);
  assert.equal(f.signals.length, 1);
  assert.deepEqual(resumed.pausedNames, ['home23-milo-dash']);
});

test('computed marker coercion never permits a changed desired environment', async t => {
  const f = await migrationFixture(t, { vizion_running: 'false' });
  coerceRestoredVizionMarker(f, true);
  await assert.rejects(adoptProductSupervisor(f.root, f.admission, f.m.deps), { code: 'host_supervisor_ambiguous' });
  assert.equal(JSON.parse(fs.readFileSync(f.m.plan.migration)).phase, 'old_exited');
});

test('resident startup bypasses PM2 self-resurrection, rejects daemon shutdown and strips child control variables', t => {
  const root = fixture(t), runtime = new EventEmitter(), records = [], exits = [];
  Object.assign(runtime, { pid: 4242, ppid: 1, exit: code => { exits.push(code); runtime.emit('exit', code); } });
  let ordinaryStart = false, innerStart = false, forked;
  class Daemon {
    start() { ordinaryStart = true; throw new Error('PM2 must not own resident resurrection'); }
    innerStart() { innerStart = true; }
  }
  const God = { notifyKillPM2() { throw new Error('must not disable restarts'); }, forkMode: env => { forked = env; } };
  const require = name => name === './lib/Daemon.js' ? Daemon : God;
  const daemon = startResidentDaemon(productSupervisorPlan(root), require, { runtime, log: entry => records.push(entry) });
  assert.equal(ordinaryStart, false); assert.equal(innerStart, true);
  daemon.close({}, error => assert.equal(error.code, 'host_supervisor_owner_stop_required'));
  God.notifyKillPM2({}, error => assert.equal(error.code, 'host_supervisor_owner_stop_required'));
  assert.deepEqual(exits, []);
  God.forkMode({ PM2_HOME: '/private/control', PM2_DAEMON_RPC_PORT: '/private/socket', HOME23_AGENT: 'milo', env: { PM2_HOME: '/private/control', KEEP: 'value' } });
  assert.equal(forked.PM2_HOME, undefined); assert.equal(forked.PM2_DAEMON_RPC_PORT, undefined);
  assert.deepEqual(forked.env, { KEEP: 'value' }); assert.equal(forked.HOME23_AGENT, 'milo');
  runtime.emit('SIGTERM');
  runtime.emit('unhandledRejection', Object.assign(new Error('sensitive-message-not-logged'), { code: 'EPIPE' }));
  assert.ok(records.some(record => record.event === 'signal' && record.signal === 'SIGTERM'));
  assert.ok(records.some(record => record.event === 'fatal' && record.reason === 'unhandledRejection' && record.errorCode === 'EPIPE'));
  assert.ok(records.some(record => record.event === 'exit' && record.code === 1));
  assert.equal(JSON.stringify(records).includes('sensitive-message-not-logged'), false);
});

test('resident fatal domain errors persist their reason and exit code to pm2.log', t => {
  const root = fixture(t), source = new URL('../cli/lib/product-supervisor.js', import.meta.url).href;
  const script = `import {startResidentDaemon} from ${JSON.stringify(source)};
    class Daemon { innerStart() { setImmediate(() => { throw Object.assign(new Error('private-argument'), {code:'EPIPE'}); }); } }
    startResidentDaemon({env:{PM2_HOME:${JSON.stringify(path.join(root, 'runtime/pm2'))}}}, name => name === './lib/Daemon.js' ? Daemon : {});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 1);
  const raw = fs.readFileSync(path.join(root, 'runtime/pm2/pm2.log'), 'utf8');
  const records = raw.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(records.some(record => record.event === 'fatal' && record.reason === 'daemon-domain-error' && record.errorCode === 'EPIPE'));
  assert.ok(records.some(record => record.event === 'exit' && record.code === 1));
  assert.equal(raw.includes('private-argument'), false);
});

test('client guard blocks both detached and no-daemon PM2 creation', () => {
  const exits = [], runtime = { stderr: { write() {} }, exit: code => exits.push(code) };
  class Client { start(cb) { assert.equal(this.daemon_mode, true); this.launchDaemon(cb); } }
  forbidClientSpawn(() => Client, runtime);
  const client = new Client(); client.daemon_mode = false; client.start(() => {});
  assert.deepEqual(exits, [75]);
});

test('house definitions exclude supervisor environment even when an app requests it', t => {
  const root = fixture(t);
  const apps = productDefinitions(ownedProcessNames('milo').map(name => ({ name, script: 'dist/home.js', filter_env: ['OLD_'],
    env: { PM2_HOME: '/foreign/control', PM2_DAEMON_RPC_PORT: '/foreign/socket', KEEP: 'value' } })), root, 'milo');
  assert.ok(apps.every(app => Object.keys(app.env).every(key => !key.startsWith('PM2_'))));
  assert.ok(apps.every(app => app.filter_env.includes('PM2_') && app.filter_env.includes('OLD_')));
  assert.ok(apps.every(app => app.env.KEEP === 'value' && app.env.HOME23_PRODUCT_HOST === 'true'));
});

test('Host status reports exited launchd ownership separately from an empty stopped home', async t => {
  const root = fixture(t);
  const ports = { coordination: 44000, engine: 44001, dashboard: 44002, mcp: 44003, bridge: 44004, evobrew: 44005, observatory: 44006 };
  privateJSON(path.join(root, '.home23-host.json'), { schema: 'home23.host.v1', homeRoot: root, ports, profile: { name: 'milo' }, desiredRunning: true, encoderRequired: false });
  const result = await runHostAction('status', { homeRoot: root }, { platform: 'darwin', supervisorListening: async () => false,
    inspectProductSupervisor: async () => ({ ownership: 'exited', pid: 4242, lastExitCode: 1 }),
    execute: async () => { throw new Error('An exited resident must not trigger any PM2 client'); } });
  assert.equal(result.ok, false); assert.equal(result.status, 'unavailable');
  assert.equal(result.error.code, 'host_supervisor_exited'); assert.equal(result.error.supervisorPid, 4242); assert.equal(result.error.lastExitCode, 1);
});

test('exited launchd resident inspection reports the dead owner and last exit without spawning', async t => {
  const root = fixture(t), m = machine(root);
  await ensureProductSupervisor(root, m.deps);
  m.live = false; m.lastExitCode = 1;
  const before = m.calls.length, status = await inspectProductSupervisor(root, m.deps);
  assert.equal(status.ownership, 'exited'); assert.equal(status.pid, 4242); assert.equal(status.lastExitCode, 1);
  assert.ok(m.calls.slice(before).every(call => call[1] === 'list'));
  await assert.rejects(productSupervisorCommand(root, ['jlist'], { ...m.deps, execute: async (file, args) => {
    if (file === m.plan.node) throw Object.assign(new Error('lost'), { code: 75 });
    return m.deps.execute(file, args);
  } }), error => error.code === 'host_supervisor_exited' && error.lastExitCode === 1);
});

async function recoveryFixture(t) {
  const f = await migrationFixture(t);
  const migration = await adoptProductSupervisor(f.root, f.admission, f.m.deps);
  const journal = JSON.parse(fs.readFileSync(f.journalPath));
  journal.supervisorAdmission = { ownership: 'legacy', ...f.admission };
  journal.supervisorMigration = migration; journal.phase = 'writers_admitted'; journal.candidateStarted = true; journal.acceptedWork = true;
  privateJSON(f.journalPath, journal);
  f.m.live = false; f.m.pid = 8181; f.m.jobPid = 8181; f.m.lastExitCode = 1; f.clearRows();
  f.m.deps.runningHomePids = async () => [];
  return f;
}

test('admitted readiness recovers a dead launchd resident and only restores stopped registrations', async t => {
  const f = await recoveryFixture(t), before = f.m.calls.length;
  const result = await recoverProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(result.ownership, 'launchd'); assert.equal(result.pid, 8181);
  assert.equal(result.previousPid, 4242); assert.equal(result.previousExitCode, 1);
  assert.deepEqual(result.pausedNames, ['home23-milo-dash']);
  assert.deepEqual(f.m.calls.slice(before).filter(call => call[1] === 'kickstart'), [['/bin/launchctl', 'kickstart', f.m.plan.service]]);
  assert.equal(f.commands.some(command => ['start', 'restart', 'delete'].includes(command[0])), false);
  assert.deepEqual(f.signals, [[4242, 'SIGINT']]);
});

test('resident readiness recovery refuses orphan writers, stale admission and an answering daemon', async t => {
  for (const reason of ['orphans', 'owner', 'live']) {
    const f = await recoveryFixture(t), before = f.m.calls.length;
    if (reason === 'orphans') f.m.deps.runningHomePids = async () => [123];
    if (reason === 'owner') f.admission.updateOwnerToken = 'another-owner';
    if (reason === 'live') { f.m.pid = 4242; f.m.jobPid = 4242; f.m.live = true; }
    await assert.rejects(recoverProductSupervisor(f.root, f.admission, f.m.deps), { code: reason === 'orphans' ? 'host_supervisor_writers_active'
      : reason === 'owner' ? 'host_supervisor_admission_required' : 'host_supervisor_ambiguous' });
    assert.ok(f.m.calls.slice(before).every(call => call[1] === 'list'));
    assert.deepEqual(f.signals, [[4242, 'SIGINT']]);
  }
});

test('read-only inventory accepts a proven absent empty home and refuses detached writers without a client or launchd change', async t => {
  const root = fixture(t), m = machine(root);
  let pids = [], clientCalls = 0;
  const deps = { ...m.deps, runningHomePids: async () => pids, command: async () => { clientCalls++; throw new Error('Absent inventory must not run a client'); } };
  assert.equal((await productSupervisorInventory(root, deps)).stdout, '[]');
  assert.equal(clientCalls, 0); assert.ok(m.calls.every(call => call[1] === 'list'));
  pids = [4242];
  await assert.rejects(productSupervisorInventory(root, deps), { code: 'host_supervisor_writers_active' });
  assert.equal(clientCalls, 0); assert.ok(m.calls.every(call => call[1] === 'list'));
});

test('read-only inventory uses only the guarded client for an answering supervisor and preserves exited errors', async t => {
  const root = fixture(t), m = machine(root);
  await ensureProductSupervisor(root, m.deps);
  const args = [];
  const deps = { ...m.deps, command: async command => { args.push(command); return { stdout: '[{"name":"fixture"}]' }; } };
  assert.equal((await productSupervisorInventory(root, deps)).stdout, '[{"name":"fixture"}]');
  assert.deepEqual(args, [['jlist', '--silent']]);
  m.live = false; m.lastExitCode = 1;
  await assert.rejects(productSupervisorInventory(root, deps), error => error.code === 'host_supervisor_exited' && error.lastExitCode === 1);
  assert.equal(args.length, 1);
});

test('detached writer proof detects a renamed process through its bundled executable or home cwd', async t => {
  const root = fixture(t), plan = productSupervisorPlan(root), calls = [];
  const execute = async (file, args) => {
    calls.push([file, ...args]);
    if (file === '/bin/ps') return { stdout: `${process.pid} node controller\n4242 renamed-worker\n8181 renamed-helper\n` };
    return { stdout: `p${process.pid}\nn/usr/bin/node\np4242\nn${plan.node}\np8181\nn${path.join(root, 'app')}\n` };
  };
  assert.deepEqual(await productHomeWriterPids(root, { execute }), [4242, 8181]);
  assert.equal(calls.length, 2);
  await assert.rejects(productHomeWriterPids(root, { execute: async () => ({ stdout: '' }) }), { code: 'host_supervisor_ambiguous' });
});

test('isolated inventory exempts only its verified direct controller parent and still detects other home writers', async t => {
  const root = fixture(t), plan = productSupervisorPlan(root), orphanPid = Math.max(process.pid, process.ppid) + 100;
  const execute = async file => file === '/bin/ps'
    ? { stdout: `${process.pid} ${plan.node} isolated-inventory\n${process.ppid} ${plan.node} controller\n${orphanPid} renamed-worker\n` }
    : { stdout: `p${process.pid}\nn${plan.node}\np${process.ppid}\nn${plan.node}\np${orphanPid}\nn${path.join(root, 'app')}\n` };
  assert.deepEqual(await productHomeWriterPids(root, { execute, controllerPid: process.ppid }), [orphanPid]);
  assert.deepEqual(await productHomeWriterPids(root, { execute }), [process.ppid, orphanPid]);
  await assert.rejects(productHomeWriterPids(root, { execute, controllerPid: orphanPid }), { code: 'host_supervisor_ambiguous' });
});

test('pre-writer selected admission safely restarts its exact exited launchd owner without a migration receipt', async t => {
  const f = await recoveryFixture(t), journal = JSON.parse(fs.readFileSync(f.journalPath)), signalsBefore = f.signals.length;
  delete journal.supervisorMigration;
  journal.phase = 'selected'; journal.candidateStarted = false; journal.acceptedWork = false; journal.writersAdmitted = false;
  journal.supervisorAdmission = { ownership: 'launchd', ...f.admission };
  privateJSON(f.journalPath, journal);
  const result = await recoverProductSupervisor(f.root, f.admission, f.m.deps);
  assert.equal(result.ownership, 'launchd'); assert.equal(result.pid, 8181); assert.equal(result.previousPid, 4242);
  assert.deepEqual(result.pausedNames, ['home23-milo-dash']);
  assert.equal(f.signals.length, signalsBefore);
  assert.equal(f.m.calls.filter(call => call[1] === 'kickstart').length, 1);
});

test('pre-writer recovery rejects mismatched dead PIDs, legacy snapshots and admitted writers without a restart', async t => {
  for (const reason of ['pid', 'legacy', 'started', 'writers']) {
    const f = await recoveryFixture(t), journal = JSON.parse(fs.readFileSync(f.journalPath)), before = f.m.calls.length;
    delete journal.supervisorMigration;
    journal.phase = 'verifying'; journal.candidateStarted = false; journal.acceptedWork = false; journal.writersAdmitted = false;
    journal.supervisorAdmission = { ownership: 'launchd', ...f.admission };
    if (reason === 'pid') { journal.supervisorAdmission.expectedPid = 9999; f.admission.expectedPid = 9999; }
    if (reason === 'legacy') journal.supervisorAdmission.ownership = 'legacy';
    if (reason === 'started') journal.candidateStarted = true;
    if (reason === 'writers') journal.writersAdmitted = true;
    privateJSON(f.journalPath, journal);
    await assert.rejects(recoverProductSupervisor(f.root, f.admission, f.m.deps), {
      code: reason === 'pid' ? 'host_supervisor_ambiguous' : 'host_supervisor_admission_required',
    });
    assert.ok(f.m.calls.slice(before).every(call => call[1] === 'list'));
    assert.deepEqual(f.signals, [[4242, 'SIGINT']]);
  }
});
